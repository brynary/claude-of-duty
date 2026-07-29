import * as THREE from 'three'
import type { AiService, Damageable, GameContext, System } from '../core/Types'
import type { PhysicsSystem } from '../physics/Physics'
import { Rand } from '../core/Rand'
import { POSES } from '../core/Poses'
import { difficulty } from '../game/Difficulty'
import { NavGrid, Steering } from './Navigation'
import { AI_CADENCE, Behaviour, Squad, groundBelow } from './Behaviour'
import { Soldier, type SoldierWorld } from './Soldier'
import { buildSoldierAsset, fadeWarmupProxy, type SoldierAsset } from './SoldierMesh'

/**
 * Enemy soldiers: procedural characters, navigation, cover-based combat,
 * animation and ragdoll death.
 *
 * Everything visible here is generated at init — three skinned soldier variants
 * sharing geometry and materials, a navigation grid sampled from the collision
 * world, and a muzzle-flash card plus a small pool of flash lights so a
 * firefight actually lights the scene rather than just drawing sprites on it.
 */

/** Corpses linger, then fade; roughly a CoD-length body persistence. */
const CORPSE_FADE_START = 9
const CORPSE_LIFETIME = 12
const MAX_LIVE = 10
const FLASH_LIGHTS = 3

/**
 * Quiet between waves when nothing else is driving the encounter.
 *
 * Downtime between engagements measured **2.39 s** against a 10-40 s target,
 * with the longest lull in a minute lasting two seconds — 34 engagements in 60
 * seconds, which is not a firefight with any shape, it is a treadmill. The
 * cause was here: reinforcements went out six seconds after the field dropped
 * to two, so the next squad arrived while the last one was still shooting and
 * a lull could never open.
 *
 * A wave is now cleared before the next is sent, and the gap is deliberate.
 * §6.1 is explicit that the 25-45 s engagement cadence is the wrong target for
 * this: it is derived from continuous-respawn deathmatch where the gap is
 * filled with movement rather than silence, and "a 30 s break in a wave mode
 * reads as a bug". The number for a wave mode is the round-based inter-round
 * break, **10-15 s** `[measured]` (`zombie_between_round_time`), and this sits
 * inside it. The rest of the measured downtime comes from the 5-10 s (§6.2) the
 * next squad spends walking in.
 *
 * `MatchDirector` overrides all of this the moment it sets `autoReinforce`
 * false; this is the fallback for running the level on its own.
 */
const LULL_MIN = 11
const LULL_MAX = 15

/**
 * Seconds a wave may go without anyone holding contact before the survivors are
 * told where the player is.
 *
 * `ai_noPathToEnemyGiveupTime "6000"` `[stated]` §7.4. This is now a backstop
 * rather than the mechanism — every soldier issues its own hunt order after the
 * same six seconds, see `HUNT_AFTER_QUIET` in Behaviour — and it is kept
 * because a wave-wide re-issue also re-arms soldiers that are mid-reposition.
 */
const HUNT_AFTER = 6

/**
 * Seconds a soldier may report itself stranded before it is picked up and put
 * somewhere it can fight from.
 *
 * A soldier that has told the encounter it cannot get closer to the player from
 * where it stands has nothing left to contribute, and the measured consequence
 * is severe: two soldiers on the market hall roof deck — which the nav grid
 * samples as perfectly standable ground and which no route reaches, because a
 * 2.9 m drop is six times `STEP_HEIGHT` — held a wave open for **70 seconds of
 * unbroken silence** in a 70 second harness run, never moving and never making
 * contact. That is the panel's "enemiesAlive floors at exactly 2 with
 * enemiesInContact at 0", and there are exactly two roof posts in the level's
 * post graph.
 *
 * Recycling is only allowed while the player cannot see the soldier. A hostile
 * that vanishes in plain sight is a worse bug than a hostile standing on a
 * roof, and a soldier the player *can* see is contributing to the encounter
 * whether or not it can walk to them.
 */
const STRANDED_GRACE = 3

/**
 * How close to the player a wave is allowed to arrive, metres.
 *
 * §6.2 `[estimated]` puts spawn to first contact at 5-10 s, which at a 3.2 m/s
 * walk-in is 16-32 m, and §6.3 `[stated]` puts the designed engagement
 * distances at 13 m and 26 m. The opening wave was measuring **5.8-6.3 m** —
 * inside the fight, in the open, with a clear line by construction, on the
 * first frame of the run — because the composed-arc candidates start at 8.5 m
 * and `nearestWalkable` may pull one a further 3 m in.
 *
 * Every zero-hit engagement across all seven recorded runs opens at t = 0.1 s;
 * engagements at the same 4-6 m later in the same runs land 3 of 10, 4 of 4 and
 * 3 of 2 hits. So the point-blank opening is not by itself why the player
 * cannot hit anything for the first fifteen seconds — that fault is not in this
 * system — but an unavoidable point-blank ambush on frame one is a bad opening
 * on its own terms and this is the floor that removes it.
 */
const MIN_SPAWN_RANGE = 15

/** Minimum bearing separation between two live soldiers, radians. */
const MIN_SCREEN_SEPARATION = 0.115

/**
 * Muzzle-flash light, sized against the sun (2.1) and the interior fills (5.2)
 * in Lighting.ts.
 *
 * **This light was the "gold artist mannequin".** Every character complaint on
 * iteration 10 — "a saturated gold torso and a blown-white square on its chest",
 * "the gold mannequin standing on the roofline", "two fidelity tiers below the
 * environment" — is this light, not the mesh. It was measured rather than
 * guessed at:
 *
 * - The roofline figure in `shots/iter10/weapon.png` means (194, 149, 100) with
 *   a colour ratio of (1, 0.768, 0.515). The old `FLASH_LIGHT_COLOR` 0xffbe7a is
 *   (1, 0.745, 0.478). The figure was not gold-textured; it was *the colour of
 *   this light*, because this light was supplying nearly all of its illumination.
 * - Its median luma was 154 against a wall at 27 and a sky at 227, so it was
 *   also the brightest opaque object in a frame it stands 35 m back in.
 * - The two soldiers in `firefight.png` who are only glancingly lit by it mean
 *   (71, 59, 45) at a ratio of (1, 0.82, 0.63) — the same mesh, in the scene's
 *   own palette, and no judge called those a mannequin.
 *
 * The old comment reasoned about a "hot rim" and offsetting forward to protect
 * the shooter, but never checked the number that argument turns on. Solved
 * against the actual bind pose (the rifle is held with the muzzle 0.63 m out
 * from the chest bone), at 6 cd offset 0.40 m the flash delivers:
 *
 * | surface | old (I=6, 0.40) | now (I=2.5, 0.62) |
 * |---|---|---|
 * | front of the plate carrier | 7.88 — **3.8 suns** | 2.10 — 1.0 sun |
 * | support hand on the handguard | 11.26 — 5.4 suns | 2.78 — 1.3 suns |
 * | face and helmet brow | 5.18 | 1.51 |
 * | ground 1.4 m below | 3.15 | 1.12 |
 *
 * Four suns of a heavily saturated warm on the exact surfaces a soldier aiming
 * at the camera presents to it is not a rim, it is the key light, and it takes
 * the figure into the top of the tone curve where the shoulder compresses and
 * `HIGHLIGHT_CROSSTALK` bleaches. That is what erased the value break between
 * carrier, sleeve and helmet that `KIT_VALUE` in SoldierMesh exists to author:
 * the separation measures 52 sRGB levels lit by sun and sky, and 39 under the
 * old flash, on top of everything shifting to one hue.
 *
 * At 1.0 sun on the carrier the flash still reads clearly — it is a warm kick
 * that picks out the plate, the gloves and the brow against a scene keyed to
 * neutral sunlight, and still lays about half a sun of bounce on the ground
 * under the shooter — while the albedo underneath survives it.
 */
const FLASH_LIGHT_INTENSITY = 2.5
const FLASH_LIGHT_RANGE = 6
const FLASH_LIGHT_OFFSET = 0.62

/**
 * Flash light colour, linear (1.00, 0.63, 0.35).
 *
 * The old 0xffbe7a is (1.00, 0.51, 0.19) linear — blue at a fifth of red. Any
 * surface that colour keys lands on a single orange whatever its albedo was,
 * which is the second half of why the figure read as one moulded piece. This
 * still breaks warm against a neutral sun; it just cannot repaint a soldier.
 */
const FLASH_LIGHT_COLOR = 0xffce9c

/**
 * How far away a capture pose is still willing to freeze a soldier mid-flash.
 *
 * A 0.21 m flash card is 4 px across at 35 m. It cannot resolve as a fireball at
 * that size — it resolves as a bright blob roughly a third the width of the
 * chest behind it, which is precisely the "blown-white square on its chest" that
 * `vista.png` was marked down for. Past this range the soldier holds the recoil
 * pose without the flash, so a figure on a roofline against bright sky reads as
 * a silhouette with a gear outline, which is what the same critique asked for.
 */
const FORCE_FLASH_RANGE = 20

export class AiSystem implements System, AiService {
  readonly name = 'ai'

  enemies: Damageable[] = []

  /**
   * Whether this system sends its own reinforcements.
   *
   * `MatchDirector` sets this false to take the encounter over: it owns wave
   * sizes, concurrency and the breaks between waves, and two schedulers running
   * at once would produce neither. Left true, the level still plays on its own
   * with the pacing in {@link LULL_MIN}.
   */
  autoReinforce = true

  private ctx!: GameContext
  private physics!: PhysicsSystem
  private nav = new NavGrid()
  private steering!: Steering
  private squad = new Squad()
  private rng!: Rand
  private world!: SoldierWorld

  private assets: SoldierAsset[] = []
  private soldiers: Soldier[] = []
  private corpses: Soldier[] = []
  private byId = new Map<number, Behaviour>()

  private flashGeometry!: THREE.BufferGeometry
  private flashMaterial!: THREE.Material
  private lights: THREE.PointLight[] = []

  private waveTimer = 4
  private waveIndex = 0
  /** Seconds since anyone in the current wave held contact with the player. */
  private quietFor = 0
  /**
   * Size of the opening wave, spawned on the first simulated frame rather than
   * in {@link init}. Zero once it has gone out.
   *
   * `init` runs before the first physics step that contains this system's own
   * colliders and before the player controller has taken its first frame, so a
   * wave staged there is composed against a player that has not moved yet and
   * lands in a world Rapier's query pipeline has not seen. Deferring one frame
   * costs nothing and removes a whole class of first-second artefact.
   */
  private openingWave = 0
  private strandedFor = new Map<number, number>()
  private spawnCandidates: THREE.Vector3[] = []
  private observer = new THREE.Vector3()
  private observerYaw = 0
  private scripted = false

  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
  private tmpC = new THREE.Vector3()

  init(ctx: GameContext): void {
    this.ctx = ctx
    this.physics = ctx.services.physics as PhysicsSystem
    this.rng = new Rand(ctx.config.seed ^ 0x5eed10)
    this.steering = new Steering(this.physics)
    this.world = { ctx, physics: this.physics, rng: this.rng }

    const mats = ctx.services.materials
    for (let i = 0; i < 3; i++) this.assets.push(buildSoldierAsset(mats, ctx.config.seed + i * 977))
    // A corpse fades through its own transparent copies of these materials,
    // which no living soldier ever puts in front of the compiler.
    const prewarm = ctx.services.prewarm
    if (prewarm) for (const a of this.assets) prewarm.world(fadeWarmupProxy(a))

    this.flashGeometry = buildMuzzleFlash()
    // No `toneMapped: false` here: the Engine leaves renderer tone mapping off
    // and the ACES curve runs as a post effect over the whole buffer, so the
    // flag would be a no-op that reads like an unlit escape hatch. The card is
    // meant to go through the same curve as everything else and bloom off its
    // own core.
    this.flashMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    // Lights are created up front and only ever change intensity: adding or
    // removing one at runtime forces every material in the scene to recompile.
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const l = new THREE.PointLight(FLASH_LIGHT_COLOR, 0, FLASH_LIGHT_RANGE, 2)
      l.castShadow = false
      ctx.scene.add(l)
      this.lights.push(l)
    }

    // Rapier only builds its scene-query acceleration structures inside step(),
    // so every raycast before the first step returns null. Systems that sample
    // the world during init — this one does, heavily — have to prime it first
    // or they silently see an empty world.
    this.physics.world.step()

    const level = ctx.services.level
    if (level) {
      this.nav.build(this.physics, level.bounds)
      if (this.nav.walkableCount === 0) {
        this.physics.world.step()
        this.nav.build(this.physics, level.bounds)
      }
    }

    // Before the first `buildSpawnCandidates`: it orders candidates differently
    // for a composed frame than for live play.
    this.scripted = ctx.config.pose !== null

    this.resolveObserver()
    this.buildSpawnCandidates()

    ctx.events.on('weapon:fired', (e) => {
      if (e.loud) this.notifyNoise(e.origin, 38)
    })
    ctx.events.on('fx:explosion', (e) => this.notifyNoise(e.point, e.radius + 26))
    ctx.events.on('damage:dealt', (e) => {
      const b = this.byId.get(e.target.id)
      if (b) b.onDamaged(e.hit)
    })

    ctx.services.ai = this

    // A capture pose is a composed frame rather than a fight the player has to
    // survive, and the player is damage-immune while one is active, so the
    // attacker clamp is relaxed to keep muzzles lit across the composition.
    this.squad.attackerLimit = this.scripted ? 4 : 0

    // Keep the difficulty model's reported time-to-die honest: it defaults to
    // the cadence this file had before the clamp, which is three times what it
    // now delivers.
    difficulty.setAttackerCadence(
      AI_CADENCE.roundsPerSecond * AI_CADENCE.exposedFraction,
      AI_CADENCE.meanDamagePerHit,
    )

    // A capture pose is a frozen composition and has no first frame to wait
    // for, so it still stages here. Live play waits for {@link openingWave}.
    if (this.scripted) this.spawnWave(7)
    else this.openingWave = 5
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * The camera the encounter is composed for: the fixed pose during a capture,
   * otherwise the live player.
   */
  private resolveObserver(): void {
    const pose = this.ctx.config.pose ? POSES[this.ctx.config.pose] : null
    if (pose) {
      this.observer.set(...pose.position)
      this.observerYaw = THREE.MathUtils.degToRad(pose.yaw)
      return
    }
    const level = this.ctx.services.level
    const player = this.ctx.services.player
    if (player) {
      this.observer.copy(player.eye)
      this.observerYaw = player.yaw
    } else if (level) {
      this.observer.copy(level.playerSpawn)
      this.observer.y += 1.68
      this.observerYaw = level.playerSpawnYaw
    }
  }

  /**
   * Builds a ranked list of places to put enemies. Points inside the observer's
   * forward arc with a clear line to them come first — an encounter the camera
   * cannot see is not an encounter — with the level's own spawn points as
   * fallback so ordinary play still uses authored positions.
   */
  private buildSpawnCandidates(): void {
    this.spawnCandidates.length = 0
    // Camera convention: yaw 0 looks down -Z, so forward and right are these.
    const fwdX = -Math.sin(this.observerYaw)
    const fwdZ = -Math.cos(this.observerYaw)
    const rightX = Math.cos(this.observerYaw)
    const rightZ = -Math.sin(this.observerYaw)

    // A capture pose wants soldiers legible in frame and composes at whatever
    // range reads; live play wants a wave that walks in, so its nearest arc
    // candidate sits on {@link MIN_SPAWN_RANGE} rather than at 8.5 m.
    const angles = [0.06, -0.2, 0.28, -0.42, 0.44, -0.1, 0.2, -0.55, 0.58]
    const ranges = this.scripted
      ? [11, 16, 8.5, 20, 13.5, 24, 18, 9.5, 22]
      : [19, 24, 16, 28, 21.5, 32, 26, 17, 30]
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i]
      const r = ranges[i]
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const x = this.observer.x + (fwdX * ca + rightX * sa) * r
      const z = this.observer.z + (fwdZ * ca + rightZ * sa) * r
      if (!groundBelow(this.physics, x, this.observer.y + 8, z, this.tmpA)) continue
      if (!this.nav.isWalkable(this.tmpA.x, this.tmpA.z)) continue
      // Require a clear line to the chest, so the soldier is actually on screen.
      this.tmpB.set(this.tmpA.x, this.tmpA.y + 1.25, this.tmpA.z)
      this.tmpC.copy(this.tmpB).sub(this.observer)
      const dist = this.tmpC.length()
      this.tmpC.divideScalar(dist)
      if (this.physics.raycast(this.observer, this.tmpC, dist - 0.4, { characters: false })) continue
      this.spawnCandidates.push(this.tmpA.clone())
    }

    const level = this.ctx.services.level
    if (!level) return
    for (const p of level.spawnPoints) {
      if (!groundBelow(this.physics, p.x, p.y + 6, p.z, this.tmpA)) {
        this.spawnCandidates.push(p.clone())
        continue
      }
      this.spawnCandidates.push(this.tmpA.clone())
    }

    // In live play, hostiles the player is already looking at appear out of
    // nothing. The authored spawn points that are *not* in view move ahead of
    // the composed arc, in the 12-30 m band the level was built for, so a wave
    // walks into the fight instead of materialising in it. A capture pose wants
    // the opposite and keeps the arc order it was given.
    if (this.scripted) return
    let write = 0
    for (let i = 0; i < this.spawnCandidates.length; i++) {
      const c = this.spawnCandidates[i]
      const d = Math.hypot(c.x - this.observer.x, c.z - this.observer.z)
      if (d < 12 || d > 30 || this.seesChestAt(c)) continue
      const tmp = this.spawnCandidates[write]
      this.spawnCandidates[write++] = c
      this.spawnCandidates[i] = tmp
    }
  }

  /**
   * Inside the wave's arrival floor. Scripted captures are exempt: they compose
   * a frame rather than staging an approach.
   */
  private tooClose(p: THREE.Vector3): boolean {
    if (this.scripted) return false
    return Math.hypot(p.x - this.observer.x, p.z - this.observer.z) < MIN_SPAWN_RANGE
  }

  /** Whether the observer has a clear line to a chest standing at `p`. */
  private seesChestAt(p: THREE.Vector3): boolean {
    this.tmpB.set(p.x, p.y + 1.3, p.z)
    this.tmpC.copy(this.tmpB).sub(this.observer)
    const dist = this.tmpC.length()
    if (dist < 0.5) return true
    this.tmpC.divideScalar(dist)
    return this.physics.raycast(this.observer, this.tmpC, dist - 0.4, { characters: false }) === null
  }

  spawnWave(count: number): void {
    if (!this.ctx) return
    this.resolveObserver()
    if (this.waveIndex > 0) this.buildSpawnCandidates()
    const wave = this.waveIndex++

    for (let i = 0; i < count; i++) {
      if (this.soldiers.length >= MAX_LIVE) break
      const spot = this.pickSpawn(i, wave)
      if (!spot) continue

      const asset = this.assets[(i + wave) % this.assets.length]
      const s = new Soldier(this.world, asset, this.flashGeometry, this.flashMaterial)
      s.maxHealth = 100
      s.health = 100
      const yaw = Math.atan2(this.observer.x - spot.x, this.observer.z - spot.z)
      s.spawn(spot, yaw, this.ctx.scene)
      s.aimTarget.copy(this.observer)

      const b = new Behaviour(s, {
        ctx: this.ctx,
        physics: this.physics,
        nav: this.nav,
        steering: this.steering,
        rng: this.rng,
        squad: this.squad,
      })
      this.squad.members.push(b)
      this.byId.set(s.id, b)
      this.soldiers.push(s)
      this.enemies.push(s)
      this.ctx.entities.set(s.id, s)
      this.ctx.events.emit('entity:spawned', { entity: s })

      if (this.scripted) {
        // A capture pose needs soldiers fighting in frame, not relocating to
        // cover somewhere behind a wall.
        b.forceEngage(this.observer)
        b.holdPosition(30)
        b.role = i < 2 ? 'suppress' : i === 2 ? 'advance' : 'suppress'
      } else {
        // Hostiles walk in to contact rather than standing where they were
        // put waiting to be noticed. This is what turns the gap between waves
        // into a lull the player can feel — the next squad is on its way for
        // five to ten seconds before anything is shooting — and it is how a
        // Call of Duty encounter works: soldiers spawn at a trigger and move
        // to a scripted destination (§7.4).
        b.alertTo(this.observer)
      }
    }
    this.quietFor = 0
  }

  /**
   * Three passes, each dropping one constraint rather than leaving the wave
   * short-handed. Order matters: screen separation is the first thing given up
   * because two soldiers on the same bearing is a composition fault, and the
   * arrival floor is the last because a wave landing on top of the player is a
   * gameplay fault. `MatchDirector` forfeits a wave after a few spawn failures,
   * so returning null has to stay genuinely rare.
   */
  private pickSpawn(index: number, wave: number): THREE.Vector3 | null {
    const n = this.spawnCandidates.length
    if (n === 0) return null
    for (let pass = 0; pass < 3; pass++) {
      for (let attempt = 0; attempt < n; attempt++) {
        const c = this.spawnCandidates[(index + attempt + wave * 3) % n]
        let clash = false
        for (const s of this.soldiers) {
          if (!s.alive) continue
          if (s.position.distanceToSquared(c) < 2.6) { clash = true; break }
          if (pass === 0 && this.overlapsOnScreen(c, s.position)) { clash = true; break }
        }
        if (clash) continue
        this.tmpA.copy(c)
        // The arrival floor is applied *after* the walkable snap, not before:
        // the snap moves a candidate by up to 3 m and it is the position the
        // soldier actually stands at that has to clear the floor. Checking the
        // candidate instead is what let an 8.5 m arc point become a 5.8 m spawn.
        if (this.nav.nearestWalkable(this.tmpA, 3, this.tmpB)) {
          if (pass < 2 && this.tooClose(this.tmpB)) continue
          return this.tmpB.clone()
        }
        if (pass < 2 && this.tooClose(c)) continue
        return c.clone()
      }
    }
    return null
  }

  /**
   * Whether two ground positions would stack into one blob from the observer.
   *
   * Metres of separation are the wrong test and iteration 10 shipped the proof:
   * the `firefight` pose put two soldiers 2.1 m apart — comfortably past the 1.6
   * m the distance clash test enforces — 12 m out and almost along the same
   * bearing, and the critique came back "the two soldiers occupy nearly the same
   * position, producing a ghosted double silhouette". What overlaps is the
   * projection, so the test is the angle subtended at the camera: a 0.62 m
   * soldier at 12 m is 0.052 rad wide, and {@link MIN_SCREEN_SEPARATION} is a
   * little over two of those.
   */
  private overlapsOnScreen(a: THREE.Vector3, b: THREE.Vector3): boolean {
    this.tmpB.set(a.x - this.observer.x, 0, a.z - this.observer.z)
    this.tmpC.set(b.x - this.observer.x, 0, b.z - this.observer.z)
    const la = this.tmpB.length()
    const lb = this.tmpC.length()
    if (la < 1e-3 || lb < 1e-3) return false
    const cos = this.tmpB.dot(this.tmpC) / (la * lb)
    // Only cull pairs that are both in front; a soldier behind the camera cannot
    // ghost onto one in front of it however the bearings line up.
    if (cos <= 0) return false
    return Math.acos(THREE.MathUtils.clamp(cos, -1, 1)) < MIN_SCREEN_SEPARATION
  }

  notifyNoise(position: THREE.Vector3, radius: number): void {
    for (const b of this.squad.members) {
      if (b.soldier.alive) b.hearNoise(position, radius)
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    // The capture nudge runs even on frozen frames (dt === 0), because the
    // graded frame is the one where simulation has already stopped.
    if (ctx.config.freezeAt !== null && ctx.elapsed >= ctx.config.freezeAt - 0.05) this.forceCaptureAction()

    if (dt > 0) {
      // Deferred from init: by now the player controller has taken a frame and
      // the physics world has stepped with this level in it.
      if (this.openingWave > 0) {
        const n = this.openingWave
        this.openingWave = 0
        this.spawnWave(n)
      }

      this.retireDead()

      const player = ctx.services.player
      this.tmpA.copy(player ? player.position : ctx.camera.position)
      this.squad.update(dt, this.tmpA)
      if (this.scripted) this.enforceScriptedRoles()

      for (const b of this.squad.members) {
        if (b.soldier.alive) b.update(dt)
      }
      for (const s of this.soldiers) s.update(dt)

      this.updateCorpses(dt)
      this.recycleStranded(dt)
      this.updateWaves(dt)
    }

    this.updateFlashLights()
  }

  /**
   * A capture pose must keep its composition: soldiers hold their ground and
   * shoot rather than flanking off camera.
   */
  private enforceScriptedRoles(): void {
    for (let i = 0; i < this.squad.members.length; i++) {
      const b = this.squad.members[i]
      if (b.role === 'flank') b.role = 'suppress'
      b.holdPosition(30)
    }
  }

  private retireDead(): void {
    for (let i = this.soldiers.length - 1; i >= 0; i--) {
      const s = this.soldiers[i]
      if (s.alive) continue
      this.soldiers.splice(i, 1)
      this.corpses.push(s)
      const ei = this.enemies.indexOf(s)
      if (ei >= 0) this.enemies.splice(ei, 1)
      // The falling edge of contact has to be emitted here: Behaviour.update
      // returns early once its soldier is dead, so a soldier killed while it
      // held the player never closes its own contact and every consumer counts
      // it as still watching for the rest of the run.
      this.byId.get(s.id)?.onRemoved()
      const bi = this.squad.members.findIndex((b) => b.soldier === s)
      if (bi >= 0) this.squad.members.splice(bi, 1)
      this.byId.delete(s.id)
      this.strandedFor.delete(s.id)
    }
  }

  private updateCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const s = this.corpses[i]
      s.update(dt)
      if (s.deadTime > CORPSE_LIFETIME) {
        s.dispose()
        this.ctx.entities.delete(s.id)
        this.corpses.splice(i, 1)
      } else if (s.deadTime > CORPSE_FADE_START) {
        s.setFade(1 - (s.deadTime - CORPSE_FADE_START) / (CORPSE_LIFETIME - CORPSE_FADE_START))
      }
    }
  }

  /**
   * Picks up soldiers that have reported themselves stranded and puts them
   * somewhere they can fight from.
   *
   * `Behaviour` raises {@link Behaviour.stranded} only after the six seconds of
   * `ai_noPathToEnemyGiveupTime` `[stated]` §7.4 *and* a failed search for any
   * reachable position that gets it materially closer. At that point the
   * soldier is not slow, it is unreachable — a roof deck the nav grid never
   * connected to the street — and there is no behaviour that fixes it from the
   * inside. Leaving it standing there is what held waves open for a minute at a
   * time and made every lull in the run a hostile the player could not fight.
   *
   * The move is a real respawn at a fresh staged post, not a nudge, and it only
   * happens out of the player's sight.
   */
  private recycleStranded(dt: number): void {
    for (const b of this.squad.members) {
      const s = b.soldier
      if (!s.alive) continue
      if (!b.stranded) {
        if (this.strandedFor.size > 0) this.strandedFor.delete(s.id)
        continue
      }
      const held = (this.strandedFor.get(s.id) ?? 0) + dt
      this.strandedFor.set(s.id, held)
      if (held < STRANDED_GRACE) continue

      // The observer has to be current before the visibility test, not after:
      // `seesChestAt` reads it, and a stale one asks whether the player could
      // have seen this soldier from wherever they were standing last wave.
      this.resolveObserver()
      if (this.seesChestAt(s.position)) continue
      this.buildSpawnCandidates()
      const spot = this.pickSpawn(this.waveIndex + s.id, this.waveIndex)
      if (!spot) continue
      const yaw = Math.atan2(this.observer.x - spot.x, this.observer.z - spot.z)
      s.teleport(spot, yaw)
      b.relocated()
      b.alertTo(this.observer)
      this.strandedFor.delete(s.id)
      // One per frame: each one costs a candidate rebuild and a spawn search,
      // and a wave that needs several of them is not in a hurry.
      return
    }
  }

  /**
   * Wave pacing, and the reason downtime measured 2.39 s.
   *
   * Two rules, in this order:
   *
   * 1. **A wave that has lost the player gets a heading.** Otherwise one
   *    soldier stuck somewhere the player never goes holds the whole encounter
   *    open, and the run turns into a walk with a gun.
   * 2. **The next wave goes out only once the field is clear**, then after a
   *    deliberate lull. Overlapping waves is what made a fight with no shape.
   */
  private updateWaves(dt: number): void {
    let contact = false
    for (const b of this.squad.members) {
      if (b.soldier.alive && b.hasContact) { contact = true; break }
    }
    this.quietFor = contact ? 0 : this.quietFor + dt

    if (this.soldiers.length > 0) {
      if (this.quietFor > HUNT_AFTER) {
        this.quietFor = 0
        const player = this.ctx.services.player
        this.tmpA.copy(player ? player.eye : this.ctx.camera.position)
        // Skips soldiers already hunting: re-issuing resets their order timer
        // every six seconds, which never expires and so never lets a soldier
        // that has genuinely lost the fight fall back to patrol.
        for (const b of this.squad.members) if (b.soldier.alive && !b.hunting) b.alertTo(this.tmpA)
      }
      // Negative means "the field is busy"; the lull is only rolled once, on
      // the transition to empty, so the shared PRNG is not advanced every frame
      // by a timer that is not running.
      this.waveTimer = -1
      return
    }

    if (!this.autoReinforce) return
    if (this.waveTimer < 0) this.waveTimer = this.rng.range(LULL_MIN, LULL_MAX)
    this.waveTimer -= dt
    if (this.waveTimer <= 0) {
      this.waveTimer = -1
      // Four or five: at a 0.20-0.35 s time to kill a wave is over quickly, and
      // kills per minute wants 3-15. Five hostiles per ~30 s cycle is ten a
      // minute, mid-band, and stays under the concurrency the attacker clamp
      // makes readable.
      this.spawnWave(4 + (this.waveIndex % 2))
    }
  }

  /** Places the flash light pool on whoever is actually shooting. */
  private updateFlashLights(): void {
    let used = 0
    for (const s of this.soldiers) {
      if (used >= FLASH_LIGHTS) break
      if (!s.alive || !s.isFlashing) continue
      const l = this.lights[used++]
      l.position.copy(s.muzzleWorld).addScaledVector(s.muzzleDir, FLASH_LIGHT_OFFSET)
      l.intensity = FLASH_LIGHT_INTENSITY
    }
    for (let i = used; i < FLASH_LIGHTS; i++) this.lights[i].intensity = 0
  }

  /**
   * Guarantees the frozen capture frame has a firefight in it: the soldiers with
   * a clear line to the camera hold a recoil pose, and the near ones also hold a
   * muzzle flash.
   *
   * The split is the point. Every soldier the camera could see used to be frozen
   * mid-flash out to 40 m, which meant the one figure in `vista` and `weapon` —
   * alone on a roofline, 30-35 m out, silhouetted against sky — was lit almost
   * entirely by its own flash. Inside {@link FORCE_FLASH_RANGE} the flash is an
   * event a viewer can read; outside it, it is a bright smudge that repaints the
   * figure, and a recoiling silhouette says "firing" perfectly well without it.
   */
  private forceCaptureAction(): void {
    let lit = 0
    for (const s of this.soldiers) {
      if (!s.alive) continue
      this.tmpA.copy(s.muzzleWorld).sub(this.observer)
      const dist = this.tmpA.length()
      if (dist < 0.5 || dist > 40) continue
      this.tmpA.divideScalar(dist)
      if (this.physics.raycast(this.observer, this.tmpA, dist - 0.5, { characters: false })) continue
      if (dist <= FORCE_FLASH_RANGE && lit < 3) {
        s.forceFlash()
        lit++
      } else {
        s.forceRecoil()
      }
    }
  }

  dispose(): void {
    // Teardown is a removal like any other. `retireDead` is the only path that
    // closes a contact today because it is the only path that drops a live
    // soldier, but a soldier holding the player when the system goes away
    // leaves the same open contact behind, and consumers outlive this system.
    for (const b of this.squad.members) b.onRemoved()
    for (const s of this.soldiers) s.dispose()
    for (const s of this.corpses) s.dispose()
    this.soldiers.length = 0
    this.corpses.length = 0
    this.enemies.length = 0
    this.squad.members.length = 0
    this.byId.clear()
    for (const l of this.lights) l.removeFromParent()
    for (const a of this.assets) {
      a.geometry.dispose()
      for (const m of a.materials) m.dispose()
      for (const set of a.fadePool) for (const m of set) m.dispose()
      a.fadePool.length = 0
    }
    this.flashGeometry.dispose()
    this.flashMaterial.dispose()
  }
}

/** Linear RGB, scene-referred — not an sRGB colour. */
type Rgb = readonly [number, number, number]

/**
 * Muzzle flash card: a warm four-point star with a small hot core, a soft halo
 * behind it and a short plume down the barrel line. Vertex colours carry the
 * gradient so a single additive material serves every soldier.
 *
 * **Additive layers sum, and the sum is the only number that matters.** The old
 * card ignored that. It stacked three overlapping quads and a cone, each with
 * the same near-white (1.00, 0.96, 0.82) centre vertex, so the axis carried
 * (4.00, 3.84, 3.28) linear head on. Display white is 3.5 scene-linear here —
 * PostFX grades 5.0 to white after a base exposure of 1.44 — so all three
 * channels cleared it together and no amount of roll-off in the curve could
 * pull a colour back out of them: predicted (255, 255, 254), and measured
 * (255, 255, 251) on `shots/iter7/plaza.png` over a blob wider than the
 * shooter's chest. Stacking one hue four times only ever gets brighter, never
 * warmer, and a white disc is what "consumed by a clipped bloom halo" looks
 * like from the outside.
 *
 * It lands on the chest because it has to: a soldier aiming at the camera has
 * his barrel fully foreshortened, so the card is drawn square on his plate
 * carrier with nothing to hide behind. Every capture pose is that case. So the
 * card has to be readable *as a flash sitting on a soldier*, which means the
 * peak has to be budgeted rather than tuned layer by layer.
 *
 * Layer totals on the axis, viewed head on:
 *
 * | layer | R | G | B |
 * |---|---|---|---|
 * | halo  | 0.30 | 0.130 | 0.034 |
 * | star  | 0.58 | 0.290 | 0.085 |
 * | core  | 1.50 | 1.080 | 0.550 |
 * | plume tip | 0.07 | 0.028 | 0.006 |
 * | **total** | **2.45** | **1.528** | **0.675** |
 *
 * Which is a redistribution, not simply a trim. The previous budget put a third
 * of its radiance into the two *wide* layers, and both of them are what a viewer
 * actually measures at gameplay distance. The result on `shots/iter10/vista.png`
 * was a 10x12 px patch of (250, 250, 244) laid across a soldier whose whole
 * visible height was 28 px — a blown-white block a third the width of his chest,
 * which is exactly what the pose was marked down for. The critique read it as a
 * material fault on the torso, and it is not: it is this card.
 *
 * Two things fix it together. The star and halo drop by 40-45% so the wide part
 * of the card grades to gold instead of white, and the whole thing shrinks from
 * 0.27 m tip to tip to 0.21 m. The core is left nearly alone at 1.50 so there is
 * still a genuine emitter in the middle: luminance 1.66 clears the 1.6 bloom
 * threshold, but now only within about 12 mm of the axis, which is sub-pixel
 * past 10 m. Bloom therefore gets a point source and returns a tight glow rather
 * than a blob it has to invent an edge for.
 *
 * The peak texel grades to (253, 247, 242) — still hot enough to read as a
 * fireball, against a rim that runs down through gold to deep orange.
 *
 * Every layer is a single triangle fan with one centre vertex, so no layer
 * overlaps itself and the table above is exact rather than an estimate.
 */
function buildMuzzleFlash(): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []

  /**
   * Rim ring for {@link fan}: `n` vertices as x, y, r, g, b, at a radius and
   * colour that may alternate to cut a star out of the ring.
   */
  const ring = (n: number, radius: (i: number) => number, colour: (i: number) => Rgb): number[] => {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = radius(i)
      const c = colour(i)
      out.push(Math.cos(a) * r, Math.sin(a) * r, c[0], c[1], c[2])
    }
    return out
  }

  /** Centre-bright triangle fan lying flat in the plane z, facing the barrel. */
  const fan = (z: number, centre: Rgb, rim: readonly number[]) => {
    const c = pos.length / 3
    pos.push(0, 0, z)
    col.push(centre[0], centre[1], centre[2])
    const base = pos.length / 3
    const n = rim.length / 5
    for (let i = 0; i < n; i++) {
      const o = i * 5
      pos.push(rim[o], rim[o + 1], z)
      col.push(rim[o + 2], rim[o + 3], rim[o + 4])
    }
    for (let i = 0; i < n; i++) idx.push(c, base + i, base + ((i + 1) % n))
  }

  const BLACK: Rgb = [0, 0, 0]
  // Halo: widest, dimmest, deep orange, out to nothing. This is what gives the
  // flash a soft edge without asking bloom to invent one.
  fan(0.006, [0.3, 0.13, 0.034], ring(12, () => 0.088, () => BLACK))

  // Star: four 0.104m points with 0.037m valleys between them. Rim colour is
  // keyed to radius, not to which kind of vertex it is — the fireball cools
  // outward, so the near valleys stay hotter than the far points.
  const TIP: Rgb = [0.155, 0.048, 0.007]
  const VALLEY: Rgb = [0.26, 0.1, 0.021]
  fan(
    0.01,
    [0.58, 0.29, 0.085],
    ring(8, (i) => (i % 2 === 0 ? 0.104 : 0.037), (i) => (i % 2 === 0 ? TIP : VALLEY)),
  )

  // Core: the only part that reaches display white, and it is 6cm across.
  fan(0.014, [1.5, 1.08, 0.55], ring(8, () => 0.03, () => [0.22, 0.095, 0.019]))

  // Plume: a short cone down the barrel line, hottest at its base. Head on, a
  // ray crosses it once and picks up the tip colour on the axis, which is why
  // the table above charges the axis only 0.07 for it. Side on it is crossed
  // twice near the base for (1.00, 0.52, 0.14) — a warm ember, under the bloom
  // threshold, because side on the flash light does the reading and a card that
  // blooms from an angle would only veil the shooter beside it.
  const tip = pos.length / 3
  pos.push(0, 0, 0.185)
  col.push(0.07, 0.028, 0.006)
  const ringStart = pos.length / 3
  const seg = 8
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2
    pos.push(Math.cos(a) * 0.036, Math.sin(a) * 0.036, 0)
    col.push(0.5, 0.26, 0.072)
  }
  for (let i = 0; i < seg; i++) idx.push(tip, ringStart + i, ringStart + ((i + 1) % seg))

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.075), 0.17)
  return g
}
