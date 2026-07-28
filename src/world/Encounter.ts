import * as THREE from 'three'
import type { AiService, GameContext, LevelService } from '../core/Types'
import { Rand } from '../core/Rand'
import { getMatchService } from '../game/Match'
import { footprintBase, insideAnyBuilding } from './Buildings'
import { groundHeight } from './Terrain'

/**
 * Encounter pacing: where enemies come from, and when.
 *
 * The measured baseline was a single unbroken firefight. Downtime between
 * engagements ran at **2.39 s against a 10-40 s target**, 34 engagements landed
 * in 60 seconds, only 4 of those 60 seconds were quiet, and the longest lull in
 * a full minute was 2 seconds. The player died every 8 seconds and sprinted for
 * 2.6% of the run, both of which are consequences rather than separate faults:
 * there was never a moment with nothing shooting at them, so there was never a
 * moment to move, reload or heal in.
 *
 * The cause is placement, not volume. `LevelSystem` published 33 spawn points
 * spread evenly over the district, and the `push` scenario parks the synthetic
 * player at (-10, -12) — with seven of those points inside 15 m of it. Waves
 * were arriving on top of the player already in contact, so "spawn to first
 * contact" was effectively zero and the approach beat never existed.
 *
 * This replaces the flat list with a director that restages the published spawn
 * points against the player's current position and facing, so that every wave:
 *
 * - arrives from a single coherent direction plus one secondary one, rather
 *   than from everywhere at once;
 * - starts **behind cover**, out of the player's line of sight, so contact is
 *   something the player walks into rather than something that appears;
 * - starts far enough out that the approach itself is the lull — §6.2 of
 *   `.ai/FEEL_TARGET.md` puts spawn to first contact at 5-10 s `[estimated]`;
 * - opens at a deliberately varied distance, cycling through the §6.3 `[stated]`
 *   CoD5 level-design sightlines (13 m SMG, 26 m rifle) and this map's long
 *   case at ~34 m, so the fight is not the same fight every time.
 *
 * Nothing here decides *how* enemies fight — that is `src/ai`. This only
 * decides where they exist and when they arrive.
 */

// ---------------------------------------------------------------------------
// The post graph
// ---------------------------------------------------------------------------

/**
 * The approach a post belongs to. A wave is drawn from one lane plus, when the
 * bearings are far enough apart to read as a second direction, a few posts from
 * one other — which is the shape of a Call of Duty encounter: a front and a
 * flank, both of them directions the player can name.
 */
export type Lane = 'north' | 'west' | 'east' | 'street' | 'alley' | 'lot' | 'highway' | 'roof'

export interface Post {
  x: number
  z: number
  lane: Lane
  /**
   * Metres the fight fed by this post is expected to open at, given the space
   * it sits in. This is a property of the geometry around the post, not of the
   * distance to the player: a soldier put in the alley fights at about 10 m
   * however far away he started, because the alley is 4 m wide.
   */
  sight: number
  /** Explicit height for posts that are not on the terrain, i.e. roof decks. */
  y?: number
  /** Inside a building footprint — a room or a roof. Skips the solidity check. */
  enclosed?: boolean
}

/**
 * Every place a soldier may be put, tagged with the approach it belongs to and
 * the distance the space around it fights at.
 *
 * The 33 ground positions carried over from the original authored list are kept
 * verbatim, because they were placed against the built geometry and are known
 * to be standable. The additions are all clear of every footprint in
 * `BUILDINGS` and `EXTRA_FOOTPRINTS` by at least 0.9 m, and are re-checked
 * against `insideAnyBuilding` at init so a later change to the architecture
 * drops them rather than burying a soldier in a wall.
 *
 * Sightlines, against §6.3 `[stated]` (SMG 512 u = 13.0 m, rifle 1024 u =
 * 26.0 m) and §4.6 `[stated]` for the spaces themselves (alleyway 192 u =
 * 4.88 m, large street 512 u = 13.0 m):
 *
 * | lane    | sight   | why                                                |
 * |---------|---------|----------------------------------------------------|
 * | alley   | 9-12 m  | 4 m wide east route — the SMG lane                 |
 * | west    | 8-9 m   | bakery interior rooms; room-to-room                |
 * | street  | 18-24 m | 10 m wide, 30 m long market street                 |
 * | lot     | 16-22 m | the junction and the demolished block              |
 * | east    | 16-24 m | plaza east row and the road behind it              |
 * | north   | 26-32 m | the open market square, the rifle distance         |
 * | roof    | 28-30 m | market hall deck, shooting down into the junction  |
 * | highway | 26-34 m | the road out of town — this map's long case        |
 */
export const POSTS: readonly Post[] = [
  // --- The market square and its north end --------------------------------
  { x: -9.0, z: -22.5, lane: 'north', sight: 26 },
  { x: -3.0, z: -24.5, lane: 'north', sight: 26 },
  { x: -13.0, z: -26.0, lane: 'north', sight: 28 },
  { x: -2.0, z: -27.5, lane: 'north', sight: 30 },
  { x: -10.0, z: -31.0, lane: 'north', sight: 32 },
  { x: -19.0, z: -27.5, lane: 'north', sight: 30 },

  // --- West: the plaza west row, the west road, the bakery ----------------
  { x: -20.5, z: -9.5, lane: 'west', sight: 22 },
  { x: -24.0, z: -14.0, lane: 'west', sight: 24 },
  { x: -17.5, z: -18.0, lane: 'west', sight: 24 },
  { x: -23.0, z: -24.0, lane: 'west', sight: 26 },
  { x: -24.5, z: 11.0, lane: 'west', sight: 20 },
  { x: -26.0, z: 2.0, lane: 'west', sight: 20 },
  { x: -14.0, z: 8.0, lane: 'west', sight: 8, enclosed: true },
  { x: -19.5, z: 4.0, lane: 'west', sight: 9, enclosed: true },

  // --- East: the plaza east row and the road behind it --------------------
  { x: 3.5, z: -6.0, lane: 'east', sight: 16 },
  { x: 2.0, z: -17.0, lane: 'east', sight: 20 },
  { x: 16.0, z: -8.0, lane: 'east', sight: 18 },
  { x: 20.0, z: -6.0, lane: 'east', sight: 22 },
  { x: 17.0, z: -20.0, lane: 'east', sight: 24 },

  // --- The market street, west route --------------------------------------
  { x: -9.5, z: 14.0, lane: 'street', sight: 18 },
  { x: -6.5, z: 19.5, lane: 'street', sight: 20 },
  { x: -4.5, z: 26.5, lane: 'street', sight: 22 },
  { x: -8.5, z: 33.0, lane: 'street', sight: 24 },
  { x: -2.0, z: 34.5, lane: 'street', sight: 22 },
  { x: -15.5, z: 27.5, lane: 'street', sight: 9, enclosed: true },

  // --- The alley, east route ----------------------------------------------
  { x: 7.6, z: 16.0, lane: 'alley', sight: 10 },
  { x: 6.8, z: 20.5, lane: 'alley', sight: 10 },
  { x: 6.6, z: 25.0, lane: 'alley', sight: 11 },
  { x: 7.2, z: 32.0, lane: 'alley', sight: 12 },
  { x: 12.0, z: 12.0, lane: 'alley', sight: 9, enclosed: true },

  // --- The junction and the lot -------------------------------------------
  { x: 11.5, z: 21.5, lane: 'lot', sight: 16 },
  { x: 16.0, z: 26.0, lane: 'lot', sight: 20 },
  { x: 12.5, z: 30.0, lane: 'lot', sight: 18 },
  { x: 21.0, z: 24.5, lane: 'lot', sight: 22 },

  // --- The highway out of town --------------------------------------------
  { x: 23.5, z: 33.5, lane: 'highway', sight: 28 },
  { x: 28.0, z: 26.5, lane: 'highway', sight: 30 },
  { x: 30.0, z: 32.0, lane: 'highway', sight: 34 },
  { x: 19.5, z: 37.0, lane: 'highway', sight: 30 },
  { x: 12.0, z: 40.0, lane: 'highway', sight: 26 },

  // --- Overwatch on the market hall deck ----------------------------------
  { x: 19.0, z: 18.5, lane: 'roof', sight: 30, y: footprintBase(19.75, 16.25, 8.5, 11.5) + 2.86, enclosed: true },
  { x: 20.6, z: 13.5, lane: 'roof', sight: 28, y: footprintBase(19.75, 16.25, 8.5, 11.5) + 2.86, enclosed: true },
]

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Closest a wave may be staged in front of the player, metres.
 *
 * Under the §6.3 `[stated]` SMG sightline of 13.0 m, so a wave staged at the
 * short end still has to cross a room's worth of ground before it can shoot.
 */
const MIN_FRONT = 12

/**
 * Closest a wave may be staged *behind* the player, metres.
 *
 * Deaths from unseen attackers measure zero and have to stay there. Anything in
 * the rear arc has to be far enough that the player's own movement or a glance
 * over the shoulder puts it in view before it can engage: 26 m is the §6.3
 * `[stated]` rifle sightline, which is also roughly four seconds of enemy
 * approach at the 6.3 m/s of §4.1.
 */
const MIN_BEHIND = 26

/** cos(100 deg) — the bearing past which a post counts as behind the player. */
const REAR_COS = -0.174

/**
 * Furthest a wave is staged, metres. Enemy `VIEW_RANGE` in `src/ai` is 55 m, so
 * past that a soldier can never acquire the player at all and the encounter
 * simply stops. 46 m leaves headroom under it.
 */
const MAX_STAGE = 46

/**
 * Preferred staging distance, metres.
 *
 * §6.2 `[estimated]` puts spawn to first contact at 5-10 s. At the §4.1
 * `[stated]` band of 4.7-6.3 m/s that is 24-63 m of travel, and a soldier
 * crossing broken ground rather than a straight line covers rather less than
 * its top speed, so 30 m is the middle of that window.
 */
const WANT_DIST = 30

/**
 * The sightline each successive wave aims to open at, metres.
 *
 * Mean engagement distance measured 17.9 m, which sits between the two §6.3
 * `[stated]` standards and is fine as a mean — the fault would be if every
 * fight happened there. This cycle is built so it does not: two waves at the
 * 13 m SMG standard, two at the 26 m rifle standard, and the rest spread
 * between and beyond them out to this map's longest usable line. Mean 21.5 m,
 * range 10-34 m.
 */
const SIGHT_CYCLE = [26, 13, 30, 18, 22, 10, 34, 20]

/**
 * Enemies per wave.
 *
 * §7.2 `[stated]` clamps concurrent attackers to 2 (`ai_maxAttackerCount`),
 * which `src/ai` already enforces, so wave size does not control lethality —
 * it controls how long the fight lasts and how many separate contacts it
 * produces. Three to five gives a fight that resolves in roughly 10-20 s at the
 * 200-350 ms TTK of §1, which is what leaves room for a lull afterwards.
 */
const WAVE_SIZES = [4, 3, 5, 3, 4, 5]

/** Live enemies past which no new wave is committed. */
const LIVE_CAP = 6

/**
 * Seconds with nothing in contact before the next wave is committed.
 *
 * This is the *quiet* part of the lull; the rest of the downtime is the wave's
 * approach. It is deliberately under the 6 s at which `AiSystem`'s own wave
 * timer fires, so the director's shaped wave lands first and that timer resets
 * rather than spawning a second one on top of it.
 */
const QUIET_BEFORE_WAVE = 4.5

/**
 * Backstop: seconds of quiet after which a wave is staged at the near band
 * whatever else is going on.
 *
 * A wave staged deep behind cover can fail to find the player at all if the
 * player also stops moving — the `hold` scenario does exactly that. Longest
 * quiet stretch is a graded metric with a 60 s ceiling, so this fires well
 * inside it and guarantees a contact within a few seconds.
 */
const MAX_QUIET = 26

/**
 * The band the backstop stages into, metres, and the sightline it aims at.
 *
 * 13 m is the §6.3 `[stated]` SMG standard and the closest anything is ever
 * staged. Note that the upper bound sits below {@link MIN_BEHIND}, so a backstop
 * wave is necessarily in front of the player: the one case where the director
 * is impatient is also the case where it is least willing to surprise anyone.
 */
const BACKSTOP_MIN = 13
const BACKSTOP_MAX = 24
const BACKSTOP_SIGHT = 13

/** Seconds between any two spawns, including ones `AiSystem` initiates. */
const MIN_WAVE_GAP = 7

/** Live enemies at or below which the current wave counts as spent. */
const SPENT_LIVE = 1

/** Seconds between restagings, and metres of player movement that force one. */
const STAGE_INTERVAL = 2.0
const STAGE_MOVE = 5

/** Posts published per wave: one lane's worth plus a secondary direction. */
const PRIMARY_MAX = 5
const SECONDARY_MAX = 2
const MAX_STAGED = PRIMARY_MAX + SECONDARY_MAX

/** Minimum bearing between the primary and secondary lanes, radians (45 deg). */
const MIN_LANE_SPREAD = Math.PI / 4

/**
 * Solidity grid resolution, metres, and the step the occlusion march takes
 * through it.
 *
 * The thinnest footprint in the district is the alley compound wall at 0.7 m, so
 * a 0.5 m lattice cannot miss it whatever offset it falls at. The march steps
 * shorter than a cell diagonal (0.5 / sqrt(2) = 0.354) so a diagonal ray cannot
 * cut a corner between two solid cells either.
 */
const CELL = 0.5
const MARCH_STEP = 0.34

/**
 * Metres of the line ignored at each end.
 *
 * The player may be standing in a doorway and the post may be a room, and
 * neither of those is something standing between them.
 */
const MARCH_SKIP = 1.6

/** Ring radius used to tell deep cover from a corner, metres. */
const EDGE_RADIUS = 4.5

/**
 * Bounds on the fraction of the map that reads as solid to
 * {@link EncounterDirector.occluded}, checked once at init.
 *
 * The whole staging design rests on `insideAnyBuilding` describing the same
 * architecture that gets rendered. If those two ever part company the failure
 * is silent and it is total: with no footprints every post reads as visible, the
 * hidden requirement rejects everything, staging falls through to its loosest
 * pass and every wave lands in the open — which is precisely the behaviour this
 * file was written to remove, arrived at without a single error.
 *
 * The footprints in `BUILDINGS` and `EXTRA_FOOTPRINTS` sum to about 3,370 m²
 * against the 9,020 m² of `LevelSystem.bounds`, so the true figure is near 0.37.
 * The window is set four-fold wider on the low side and twofold on the high
 * side: it is a tripwire for a footprint list that has been emptied, halved or
 * moved into a different coordinate space, not a regression test on the art.
 */
const SOLID_FRACTION_MIN = 0.08
const SOLID_FRACTION_MAX = 0.75

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

interface Candidate {
  index: number
  score: number
  bearing: number
  lane: Lane
}

export class EncounterDirector {
  /** Off during a scripted capture: those poses compose their own firefight. */
  private enabled = false

  private rng = new Rand(1)
  private posts: Post[] = []
  private world: THREE.Vector3[] = []
  /** Output slots, reused so restaging never allocates a vector. */
  private pool: THREE.Vector3[] = []
  private cands: Candidate[] = []
  private usable = 0

  private ai: AiService | null = null
  private level: LevelService | null = null

  /** Enemy ids currently holding contact with the player. */
  private contacts = new Set<number>()
  private quiet = 0
  private waveIndex = 0
  private lastSpawnAt = -99
  private lastStageAt = -99
  /**
   * Lanes the last two *committed* waves came from, most recent first. Both are
   * penalised when staging the next one, the more recent one harder.
   *
   * One deep is not enough. Only two lanes on this map fight at 26-34 m, and
   * {@link SIGHT_CYCLE} asks for that band three times in eight, so a
   * single-step penalty produced highway, alley, highway, lot, highway — never
   * repeating back to back, and still arriving from the same place half the
   * time. Two deep breaks that alternation.
   */
  private recentLanes: (Lane | null)[] = [null, null]
  /**
   * Lane the current staging settled on, folded into {@link recentLanes} only
   * when a wave is actually committed.
   *
   * Staging runs every {@link STAGE_INTERVAL} seconds and whenever the player
   * moves {@link STAGE_MOVE} metres, which is many times per wave. Advancing the
   * history on every restage instead of on every spawn made the penalty chase
   * its own tail: staging picked lane A, the next restage two seconds later
   * penalised A and picked B, the one after penalised B and went back to A. The
   * wave then arrived from whichever of the two the clock happened to leave
   * current on the commit frame, which is not variety — it is a coin flip
   * between two lanes, and it defeats the point of {@link SIGHT_CYCLE}, since a
   * lane chosen to open at 13 m is no use if the wave actually comes from the
   * one staged for 30 m.
   */
  private stagedLane: Lane | null = null

  private stagedFrom = new THREE.Vector3()
  private eye = new THREE.Vector3()
  private offs: (() => void)[] = []

  /** Baked solidity lattice; see {@link buildSolidGrid}. */
  private solid = new Uint8Array(0)
  private gridMinX = 0
  private gridMinZ = 0
  private gridW = 0
  private gridH = 0

  // -------------------------------------------------------------------------

  init(ctx: GameContext, level: LevelService): void {
    this.level = level
    this.rng = new Rand((ctx.config.seed ^ 0xe9c0) >>> 0)
    this.enabled = ctx.config.pose === null

    // A post that has ended up inside a wall would put a soldier inside it, and
    // nothing downstream would notice: `AiSystem` re-grounds spawn points with a
    // downward ray but never tests whether the column is solid. Enclosed posts
    // are interiors and roof decks and are meant to be inside a footprint.
    for (const p of POSTS) {
      if (!p.enclosed && insideAnyBuilding(p.x, p.z, 0.9)) continue
      this.posts.push(p)
      this.world.push(new THREE.Vector3(p.x, p.y ?? groundHeight(p.x, p.z) + 0.05, p.z))
    }
    for (let i = 0; i < MAX_STAGED; i++) this.pool.push(new THREE.Vector3())
    for (let i = 0; i < this.posts.length; i++) {
      this.cands.push({ index: i, score: 0, bearing: 0, lane: this.posts[i].lane })
    }

    this.buildSolidGrid(level.bounds)

    if (!this.enabled) {
      // Capture poses need the whole authored set available and unchanging.
      level.spawnPoints.length = 0
      for (const v of this.world) level.spawnPoints.push(v)
      return
    }

    const e = ctx.events
    this.offs.push(e.on('ai:contact', (p) => { this.contacts.add(p.id) }))
    this.offs.push(e.on('ai:lostContact', (p) => { this.contacts.delete(p.id) }))
    this.offs.push(e.on('entity:killed', (p) => { this.contacts.delete(p.entity.id) }))
    this.offs.push(e.on('entity:spawned', () => { this.lastSpawnAt = ctx.elapsed }))
    this.offs.push(e.on('player:respawn', () => { this.contacts.clear(); this.quiet = 0 }))

    // The opening wave is spawned from `AiSystem.init`, which runs after this,
    // so the published points have to be correct before the first frame.
    this.eye.copy(level.playerSpawn)
    this.stage(level, level.playerSpawnYaw, SIGHT_CYCLE[0], false)
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.enabled || dt <= 0) return
    const level = this.level
    if (!level) return
    if (!this.ai) {
      this.ai = ctx.services.ai ?? null
      if (!this.ai) return
    }
    const ai = this.ai

    const player = ctx.services.player
    if (player) {
      this.eye.copy(player.eye)
    } else {
      this.eye.copy(level.playerSpawn)
    }
    const yaw = player ? player.yaw : level.playerSpawnYaw

    let live = 0
    for (let i = 0; i < ai.enemies.length; i++) if (ai.enemies[i].alive) live++

    if (this.contacts.size > 0) this.quiet = 0
    else this.quiet += dt

    // Whether a wave is committed this frame is decided before staging, not
    // after. The backstop asks for a near band that the ordinary cycle does not,
    // and staging is only refreshed every {@link STAGE_INTERVAL} — so deciding
    // afterwards would let the backstop fire against staging computed for the
    // far band, spawn a wave the player still cannot find, and reset its own
    // clock for another {@link MAX_QUIET} seconds.
    const forcing = this.quiet >= MAX_QUIET
    const spent = live <= SPENT_LIVE && this.quiet >= QUIET_BEFORE_WAVE
    const wave =
      (spent || forcing) &&
      live < LIVE_CAP &&
      ctx.elapsed - this.lastSpawnAt >= MIN_WAVE_GAP

    // Restage whenever the picture the staging was computed against has moved
    // on, so that a wave `AiSystem`'s own timer initiates still lands somewhere
    // the director chose.
    const stale = ctx.elapsed - this.lastStageAt > STAGE_INTERVAL
    const moved = this.eye.distanceToSquared(this.stagedFrom) > STAGE_MOVE * STAGE_MOVE
    if (wave || stale || moved) {
      const sight = forcing ? BACKSTOP_SIGHT : SIGHT_CYCLE[this.waveIndex % SIGHT_CYCLE.length]
      this.stage(level, yaw, sight, forcing)
      this.lastStageAt = ctx.elapsed
    }
    if (!wave) return

    // The match owns *when* a wave arrives; this director owns *where* it comes
    // from. Both staging and this gate matter: staging above still runs, so a
    // wave the match commits lands on posts chosen behind cover at the current
    // sightline band. Without the gate three authorities commit waves on
    // independent clocks — this one, the match, and the AI backstop — which
    // roughly doubles the hostile budget and caps every lull at the shortest
    // timer, destroying the pacing this round exists to create.
    //
    // `directsSpawning` is false while idle or after the match ends, so this
    // director still paces the level on its own when nothing is directing.
    if (getMatchService(ctx)?.directsSpawning) return

    const size = WAVE_SIZES[this.waveIndex % WAVE_SIZES.length]
    this.waveIndex++
    this.lastSpawnAt = ctx.elapsed
    this.quiet = 0
    ai.spawnWave(Math.min(size, LIVE_CAP - live))
    this.recentLanes[1] = this.recentLanes[0]
    this.recentLanes[0] = this.stagedLane
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.offs.length = 0
    this.contacts.clear()
    this.posts.length = 0
    this.world.length = 0
    this.pool.length = 0
    this.cands.length = 0
    this.ai = null
    this.level = null
  }

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  /**
   * Rewrites the level's published spawn points to the group the next wave
   * should arrive from.
   *
   * Runs at {@link STAGE_INTERVAL}, not per frame — the marches below are cheap
   * but they are not free, and the answer only changes when the player moves.
   */
  private stage(level: LevelService, yaw: number, targetSight: number, near: boolean): void {
    this.stagedFrom.copy(this.eye)

    // Camera convention: yaw 0 looks down -Z.
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)

    // Three passes, loosening only what can be loosened. The rear-arc rule is
    // never relaxed: a wave the player could not have seen coming is the one
    // failure this system exists to prevent.
    for (let relax = 0; relax < 3; relax++) {
      const maxDist = near ? BACKSTOP_MAX : relax === 0 ? MAX_STAGE : 60
      const minDist = near ? BACKSTOP_MIN : MIN_FRONT
      this.collect(fx, fz, minDist, maxDist, targetSight, relax < 2)
      if (this.usable >= 3 || relax === 2) break
    }
    if (this.usable === 0) return

    // Sort in place by score, best first.
    const cands = this.cands
    for (let i = 1; i < this.usable; i++) {
      const c = cands[i]
      let j = i - 1
      while (j >= 0 && cands[j].score < c.score) { cands[j + 1] = cands[j]; j-- }
      cands[j + 1] = c
    }

    const primary = cands[0].lane
    const primaryBearing = cands[0].bearing
    const out = level.spawnPoints
    out.length = 0

    let taken = 0
    for (let i = 0; i < this.usable && taken < PRIMARY_MAX; i++) {
      if (cands[i].lane !== primary) continue
      const v = this.pool[taken++]
      v.copy(this.world[cands[i].index])
      out.push(v)
    }

    // One secondary direction, far enough round from the first to read as a
    // separate one rather than as the same group spread thin.
    let secondary: Lane | null = null
    let secondaryTaken = 0
    for (let i = 0; i < this.usable && secondaryTaken < SECONDARY_MAX; i++) {
      const c = cands[i]
      if (c.lane === primary) continue
      if (secondary === null) {
        if (angleBetween(c.bearing, primaryBearing) < MIN_LANE_SPREAD) continue
        secondary = c.lane
      } else if (c.lane !== secondary) {
        continue
      }
      const v = this.pool[taken++]
      v.copy(this.world[c.index])
      out.push(v)
      secondaryTaken++
    }

    this.stagedLane = primary
  }

  /**
   * Fills {@link cands} with every post that may legally hold the next wave,
   * scored. Returns nothing; {@link usable} is the count.
   */
  private collect(
    fx: number,
    fz: number,
    minDist: number,
    maxDist: number,
    targetSight: number,
    requireHidden: boolean,
  ): void {
    this.usable = 0
    for (let i = 0; i < this.posts.length; i++) {
      const p = this.posts[i]
      const w = this.world[i]
      const dx = w.x - this.eye.x
      const dz = w.z - this.eye.z
      const dist = Math.hypot(dx, dz)
      if (dist < minDist || dist > maxDist) continue

      const cos = (fx * dx + fz * dz) / dist
      if (cos < REAR_COS && dist < MIN_BEHIND) continue

      const hidden = this.occluded(w.x, w.z)
      if (requireHidden && !hidden) continue

      // A post is only useful if the soldier on it can find the player within a
      // few seconds. Deep inside a block he never will; standing in the open he
      // already has. What is wanted is the corner: hidden from where the player
      // stands, with a firing line a short walk away. The ring test is how that
      // is told apart — how many points a few metres off this one can see the
      // player.
      let openNeighbours = 0
      if (!p.enclosed) {
        if (!this.occluded(w.x + EDGE_RADIUS, w.z)) openNeighbours++
        if (!this.occluded(w.x - EDGE_RADIUS, w.z)) openNeighbours++
        if (!this.occluded(w.x, w.z + EDGE_RADIUS)) openNeighbours++
        if (!this.occluded(w.x, w.z - EDGE_RADIUS)) openNeighbours++
      }

      let score = -Math.abs(p.sight - targetSight)
      score -= Math.abs(dist - WANT_DIST) * 0.25
      if (p.lane === this.recentLanes[0]) score -= 9
      else if (p.lane === this.recentLanes[1]) score -= 4
      if (!hidden) score -= 8
      if (p.enclosed) score += 2
      else if (openNeighbours === 0) score -= 3
      else if (openNeighbours <= 3) score += 3
      score += this.rng.range(0, 1.5)

      const c = this.cands[this.usable++]
      c.index = i
      c.score = score
      c.bearing = Math.atan2(dx, dz)
      c.lane = p.lane
    }
  }

  // -------------------------------------------------------------------------
  // Solidity
  // -------------------------------------------------------------------------

  /**
   * Bakes the district's building footprints into a {@link CELL}-metre lattice,
   * and checks that the result still describes a district.
   *
   * Occlusion is tested against this rather than against a physics ray for one
   * decisive reason: the opening wave is staged during `LevelSystem.init`,
   * before Rapier has stepped, and until it steps every scene query returns
   * null. A ray-based test would therefore report the entire map as visible at
   * exactly the moment it matters most, and would do so silently. The footprint
   * data has no such ordering problem, needs no scene queries at all, and is
   * identical for a given seed.
   *
   * Baking it rather than marching `insideAnyBuilding` directly is a budget
   * decision. Staging runs every {@link STAGE_INTERVAL} seconds and tests five
   * lines per post; against 27 rotated-rectangle distance functions per sample
   * that came to roughly 200,000 evaluations landing in a single frame, which
   * is a visible hitch every two seconds. Baked once, the same work is 19,000
   * array reads.
   *
   * The lattice sees only architecture — not rubble, interior walls or props —
   * so it under-reports cover. That is the safe direction: a post it calls
   * visible may in fact be hidden, and the only cost is that the post goes
   * unused.
   */
  private buildSolidGrid(bounds: THREE.Box3): void {
    this.gridMinX = bounds.min.x
    this.gridMinZ = bounds.min.z
    this.gridW = Math.ceil((bounds.max.x - bounds.min.x) / CELL)
    this.gridH = Math.ceil((bounds.max.z - bounds.min.z) / CELL)
    this.solid = new Uint8Array(this.gridW * this.gridH)

    let filled = 0
    for (let j = 0; j < this.gridH; j++) {
      const z = this.gridMinZ + (j + 0.5) * CELL
      for (let i = 0; i < this.gridW; i++) {
        const x = this.gridMinX + (i + 0.5) * CELL
        if (!insideAnyBuilding(x, z, 0)) continue
        this.solid[j * this.gridW + i] = 1
        filled++
      }
    }

    const fraction = this.solid.length > 0 ? filled / this.solid.length : 0
    if (fraction >= SOLID_FRACTION_MIN && fraction <= SOLID_FRACTION_MAX) return
    // `tools/play.mjs` treats any console error from the page as a failed run
    // and exits non-zero, so a footprint list that has drifted away from the
    // built architecture stops the harness rather than quietly producing
    // telemetry from a map the director believes has no cover in it.
    console.error(
      `[encounter] building footprints cover ${(fraction * 100).toFixed(1)}% of the level bounds, ` +
      `outside the expected ${SOLID_FRACTION_MIN * 100}-${SOLID_FRACTION_MAX * 100}%. ` +
      'Spawn staging tests cover against BUILDINGS and EXTRA_FOOTPRINTS in Buildings.ts; ' +
      'if those no longer match the built architecture, every wave will be staged in the open.',
    )
  }

  /** True when a building stands between the player's eye and a ground point. */
  private occluded(tx: number, tz: number): boolean {
    const dx = tx - this.eye.x
    const dz = tz - this.eye.z
    const d = Math.hypot(dx, dz)
    if (d < MARCH_SKIP * 2) return false
    const ux = dx / d
    const uz = dz / d
    const end = d - MARCH_SKIP
    for (let t = MARCH_SKIP; t < end; t += MARCH_STEP) {
      const i = ((this.eye.x + ux * t - this.gridMinX) / CELL) | 0
      if (i < 0 || i >= this.gridW) continue
      const j = ((this.eye.z + uz * t - this.gridMinZ) / CELL) | 0
      if (j < 0 || j >= this.gridH) continue
      if (this.solid[j * this.gridW + i] !== 0) return true
    }
    return false
  }
}

/** Absolute difference between two bearings, wrapped into [0, PI]. */
function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}
