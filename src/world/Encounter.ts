import * as THREE from 'three'
import type { AiService, GameContext, LevelService } from '../core/Types'
import { Rand } from '../core/Rand'
import { getMatchService } from '../game/Match'
import { BUILDINGS, EXTRA_FOOTPRINTS, footprintBase, insideAnyBuilding } from './Buildings'
import { rotRectSdf } from './Kit'
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
 * - starts far enough out that the approach itself is the lull, and close
 *   enough that the approach ends.
 *
 * That last clause is this round's correction. The file was staging waves at a
 * measured mean of **32.9 m** — reasoned from the player movement speeds in
 * §4.1 and the 5-10 s spawn-to-contact of §6.2 `[estimated]` — and three things
 * were wrong with it, all of them measured rather than argued:
 *
 * 1. Soldiers do not move at player speeds. Walking each staged post's A* route
 *    at the AI's own `travelSpeed` (sprint 5.1 m/s down to 13 m out, then walk
 *    3.2 m/s, §7.5 `[stated]` `sv_botSprintDistance`) put the commute to the
 *    distance fights actually happen at at 5.9 s mean, 9.1 s p90, 13.3 s max.
 *    Not catastrophic — the briefed suspicion that the walk blew the budget
 *    outright does not survive the measurement — but the tail is the whole
 *    problem, because a soldier walks to where the player *was* and `AiSystem`
 *    only refreshes that address after `HUNT_AFTER` seconds of quiet. Every
 *    second of commute past that is a soldier walking to a stale address.
 * 2. `AiSystem.buildSpawnCandidates` promotes a published post ahead of its own
 *    composed arc only when the post is 12-30 m out and hidden. At a 32.9 m
 *    mean, most of what this file published was never preferred. The opening
 *    staging put five of its six posts outside that band, so the opening wave —
 *    the one the playtest panel called an unwinnable scripted loss — landed on
 *    the arc: close, and in the player's view.
 * 3. Varying the *sightline* per wave does not vary the range fights open at.
 *    See {@link SIGHT_CYCLE}.
 *
 * Nothing here decides *how* enemies fight — that is `src/ai`. This only
 * decides where they exist and when they arrive.
 *
 * ## This round: the wave was five copies of one post
 *
 * The playtest panel called out half of each run as dead air arriving in blocks,
 * and named two shapes: stretches with **no hostile alive at all**, and stretches
 * where hostiles exist and never arrive. They are different faults with different
 * owners, and the arithmetic separates them cleanly.
 *
 * **The empty stretches are the scheduled wave break and they are not this
 * file's.** `runs/feel7` hold holds zero alive from t = 30 through t = 40 and
 * opens its next wave in the second beginning at t = 41 — an empty field of
 * 10-11 s against the `WAVE_SETTLE` 1.5 s plus `breakSeconds` 9 s that
 * `game/MatchDefs.ts` schedules. `MatchDirector` holds `directsSpawning`
 * through both `wave` and `break`, so this director's own spawn path is gated off
 * for the whole match and cannot fill the hole; it also sets
 * `AiSystem.autoReinforce = !directsSpawning`, so nothing else can either. The
 * break is deliberate and sourced — §6.1 `[measured]` puts a round break at
 * 10-15 s — but it is spent with an empty map rather than with a thinning one,
 * and only `MatchDefs` can change that.
 *
 * **The staging can always produce usable posts, so "asked for a wave and the
 * level had nowhere to put it" is not what is happening.** Censused over 320
 * stagings (the five positions the two scenarios put the player at x 8 facings x
 * the 8 bands of {@link SIGHT_CYCLE}), the shipped file published 4.98 posts per
 * staging and never once published none. Every one of the 35 ground posts routes
 * to every one of those player positions under the same A* cost model
 * `NavGrid` uses, detours 1.00-1.90x. **The briefed suspicion that this file
 * stages posts a soldier cannot path to does not reproduce for any ground post.**
 * The four interior posts cannot be judged from here — the occlusion lattice
 * treats a footprint as solid, so its interior is not a place it can route
 * through — and they are now capped at one per wave for that reason; see
 * {@link ENCLOSED_MAX}.
 *
 * **What was wrong is that a wave was five near-copies of one post.** The score
 * was dominated by `-|post.sight - targetSight|`, `sight` is a property of the
 * lane, and on this map the lane is also the direction and the distance. So one
 * band chose one lane and one lane chose everything: 2.02 directions per staging,
 * three or more only 2% of the time, every post inside a 6 m distance band.
 * Released together, five soldiers from one direction at one range walk one
 * approach in single file and open contact one at a time as each rounds the same
 * corner — `runs/feel7` hold opens its second wave at 42.8, 44.1, 46.7, 48.6 and
 * 50.4 s, every one of them at 10.4-11.0 m. That is the panel's queue, and it is
 * a scoring weight rather than a stall.
 *
 * The fix is to select the wave as a *set*: pick posts one at a time and charge
 * each pick for repeating a direction ({@link GROUP_MAX}) or a range
 * ({@link DIST_ECHO}) already in the wave. Re-censused, that gives 6.28 posts per
 * staging and 2.94 directions, three or more 82% of the time, with both a fast
 * and a slow arrival in 52.5% of waves against 35.9%.
 *
 * ## The round before: the staging is correct and almost none of it is reaching play
 *
 * Read the two shipped 90 s runs rather than the constants and three things
 * come out that no amount of tuning in this file would have found.
 *
 * **1. Spawn to first contact is under a second.** Line the engagement starts
 * in `runs/feel5` up against the seconds in which the live count rises: a
 * hostile appears at t = 12 and is in contact at 12.98; four appear at t = 79
 * and three are in contact by 79.32. Every arrival in both runs contacts the
 * player inside about a second of being placed. The commute this file stages
 * for — measured at 3.9 s mean, 7.2 s p90 over the 12-30 m window — is not
 * being spent, because the hostile is not starting behind anything. Opening
 * distances confirm it: 22.4 m mean in the `push` run, clustered on 16, 17,
 * 19, 21.5, 24, 26, 28 and 30 m, which is `AiSystem`'s own composed arc, every
 * point of which is required to have *a clear line to the player's chest*.
 * The published posts are losing to it. See the note on {@link MAX_STAGE}: the
 * promotion it relies on writes hidden posts to the front of the candidate
 * array, but `AiSystem.pickSpawn` starts its scan at `(i + wave * 3) % n` and
 * `wave` increments once per reinforcement beat, so the start offset walks the
 * whole array and the promoted block is picked roughly `promoted / n` of the
 * time. That is an `src/ai` fault and it is the single largest thing standing
 * between this file and the game.
 *
 * **2. There is already enough quiet; it is in the wrong shape.** The graded
 * downtime figure is a mean over the positive gaps between consecutive
 * engagements, and the runs give 43.3 s of quiet in 17 pieces (`push`) and
 * 55.6 s in 13 (`hold`) — 48% and 62% of a 90 s run. Three or four of those
 * pieces are real lulls of 6-25 s; the other fourteen and nine are slivers
 * averaging 1.1 s and 1.2 s, each one the pause between killing one hostile
 * and the next one acquiring. The same quiet delivered as three or four lulls
 * would read as 10.8-18.5 s and sit inside the 12-28 s band. **Downtime is
 * short because arrivals are staggered, not because the level is busy.** The
 * lever is contacts that overlap: hostiles that arrive and acquire together
 * produce negative gaps, which the metric drops. That is mostly the
 * reinforcement cadence in `game/MatchDefs.ts`, which sends two hostiles every
 * 0.9-3.2 s against a 0.97 s kill.
 *
 * **3. This director was still spawning, and its own wave cycle was dead.**
 * Both faults were in this file, both are fixed, and each has its constant:
 * {@link EncounterDirector.lastSpawnAt} for the backstop wave that fired on
 * frame one under the gate, and {@link WAVE_BOUNDARY} for the wave counter
 * that never advanced because the gate returned before reaching it.
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
  /**
   * Explicit height for posts that are not on the terrain, i.e. roof decks.
   *
   * This also marks the post as elevated, which changes what can hide it: see
   * {@link DECK_SUPPORT}.
   */
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
 * to be standable. Every ground post clears every footprint in `BUILDINGS` and
 * `EXTRA_FOOTPRINTS` by at least {@link POST_CLEARANCE}, and all of them are
 * re-checked against `insideAnyBuilding` at init so a later change to the
 * architecture drops them rather than burying a soldier in a wall.
 *
 * That claim used to be false and the drop used to be silent, which is a bad
 * pair: the highway lane's `(28, 26.5)` post stood 0.80 m from the water tower
 * legs against the 0.90 m filter, so it had never once entered the graph and
 * nothing said so. It has been moved 0.5 m west, off the tower, and the drop
 * now warns. Measured clearances after the move run 1.00-5.30 m.
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
 *
 * The roof lane is two posts on one open deck, and it is the lane most easily
 * over-used: it matches the long end of {@link SIGHT_CYCLE} and it used to read
 * as perfect cover from everywhere on the map. See {@link DECK_SUPPORT} for why
 * it did and what it now costs.
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
  // Moved 0.5 m west off the water tower legs, which it cleared by 0.80 m
  // against a 0.90 m filter. Clearance here is 1.30 m.
  { x: 27.5, z: 26.5, lane: 'highway', sight: 30 },
  { x: 30.0, z: 32.0, lane: 'highway', sight: 34 },
  { x: 19.5, z: 37.0, lane: 'highway', sight: 30 },
  { x: 12.0, z: 40.0, lane: 'highway', sight: 26 },

  // --- Overwatch on the market hall deck ----------------------------------
  //
  // **Not used in live play.** These two are kept for capture poses only; see
  // the elevated-post filter in {@link EncounterDirector.init}.
  //
  // The deck is a navigation island, and the arithmetic says so exactly. The
  // only way up is the exterior stair on the hall's west face, built in
  // `buildMarketHall` as 16 steps of 0.175 m rise over 0.26 m run — a slope of
  // 0.673, collided as one smooth ramp. `NavGrid` samples the level on a
  // 0.75 m lattice (`max(0.7, 96 / 128)` over this level's 94 x 96 m bounds)
  // and refuses any move between adjacent cells whose ground differs by more
  // than its `STEP_HEIGHT` of 0.45 m. One cell along that ramp climbs
  // 0.75 x 0.673 = **0.505 m**, which is over the limit by 12%, so A* cannot
  // take a single step up the stair and the 2.86 m deck is reachable from
  // nowhere. `AiSystem` re-grounds a published post with a downward ray but
  // never asks whether it is connected to anything, so a soldier put here
  // stands on the roof until the AI's stranded-soldier recycle collects him —
  // and for those seconds he is a body the match counts as present and the
  // player can neither reach nor be reached by.
  //
  // Two ways to get the overwatch position back, neither of them this file's:
  // widen the stair's run from 0.26 m to about 0.34 m (slope 0.515, 0.386 m
  // per lattice cell, 14% under the limit) and move the parapet gap and
  // landing in `Buildings.ts` to match the longer flight; or have `AiSystem`
  // reject a published post its own nav cannot path from. Until one of those
  // lands, staging a wave here stages it nowhere.
  { x: 19.0, z: 18.5, lane: 'roof', sight: 30, y: footprintBase(19.75, 16.25, 8.5, 11.5) + 2.86, enclosed: true },
  { x: 20.6, z: 13.5, lane: 'roof', sight: 28, y: footprintBase(19.75, 16.25, 8.5, 11.5) + 2.86, enclosed: true },
]

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Closest a wave may be staged in front of the player, metres.
 *
 * This was 12, chosen to sit under the §6.3 `[stated]` SMG sightline of 13.0 m
 * so a wave staged at the short end still had ground to cross. It is 15 because
 * that is `AiSystem.MIN_SPAWN_RANGE`, and that constant is applied to *this
 * file's output*: `pickSpawn` runs three passes and skips any candidate inside
 * 15 m in the first two, so a post published at 12-15 m is only reachable on the
 * pass that has already given up on everything else. Measured against the two
 * shipped scenarios, one of the five posts published to the `hold` player stood
 * at 14.1 m at four of the eight bands — a slot spent on a post the spawner
 * would not take.
 */
const MIN_FRONT = 15

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
 * Furthest a wave is staged, metres.
 *
 * This used to be 46, reasoned from enemy `VIEW_RANGE` (55 m in `src/ai`) with
 * headroom. That is the wrong ceiling: it is the distance past which a soldier
 * cannot *see*, and the binding limit is the distance past which the spawner
 * will not *use* the post at all.
 *
 * `AiSystem.buildSpawnCandidates` ranks its own composed arc first — nine
 * points at 8.5-24 m in front of the player, each required to have a clear line
 * to the chest — and then appends this director's published points. It promotes
 * a published point ahead of that arc only when it is **12-30 m out and not
 * visible**; everything else keeps arc order. So a point staged past 30 m is
 * not staged at all in any useful sense. It sits behind nine positions chosen
 * to be close and in view, which is the exact opposite of what this file is
 * for.
 *
 * Measured, driving the shipped director over 1,968 standable spots x 6
 * facings x the 8 bands of {@link SIGHT_CYCLE} — 11,808 stagings, 60,340
 * published posts: mean staged distance **32.9 m**, p90 42.7 m, max 46.0 m.
 * The opening staging against `playerSpawn` publishes six posts at 27.0, 35.0,
 * 37.7, 38.7, 38.8 and 40.7 m, of which **one** is inside the band the spawner
 * promotes. The opening wave therefore lands on the composed arc — close, and
 * in the player's view — however carefully this file staged it.
 *
 * 30 m is that band's upper edge, so every post published now outranks the arc.
 *
 * **"Outranks" was too strong, and the runs say so.** `buildSpawnCandidates`
 * does move the promoted posts to the front of its array, but `pickSpawn` then
 * scans from `(i + wave * 3) % n` rather than from zero, and `wave` there is
 * incremented once per call to `spawnWave` — which under `MatchDirector` is
 * once per reinforcement beat, not once per wave. The start offset therefore
 * walks the whole array, and the promoted block wins only when the offset
 * happens to land inside it: roughly `promoted / n`, which with about six
 * published posts against nine arc points is nearer two spawns in five than
 * all of them. The other three land on the arc, every point of which is
 * *chosen* to have a clear line to the player's chest. Measured consequence:
 * spawn to first contact under a second, and a 22.4 m mean opening distance
 * that sits on the arc's own range table. Staging cannot fix this from here;
 * `pickSpawn` has to stop rotating past the promoted block.
 */
const MAX_STAGE = 30

/**
 * The ceiling the fallback passes may reach out to, metres.
 *
 * Used when the map cannot offer three legal posts inside {@link MAX_STAGE};
 * measured at 29.5% of stagings, which is the price of the tighter ceiling and
 * is paid in commute rather than in cover.
 *
 * This was 60 m, which is past the 55 m `VIEW_RANGE` in `src/ai`. A soldier
 * staged past its own view range cannot see the player from where it is put, so
 * it has nothing to walk towards and nothing to shoot at; it waits for a noise
 * event or for someone else's contact, and if neither comes it patrols. That is
 * the mechanism behind "two live enemies that never make contact", and a
 * distance ceiling should never be able to produce it. 40 m leaves 15 m of
 * headroom under `VIEW_RANGE`.
 */
const LOOSE_STAGE = 40

/**
 * Score charged per metre a post stands beyond {@link MIN_FRONT}.
 *
 * A monotone cost, and that is this round's change. It used to be a two-sided
 * pull toward a preferred distance of 22 m — `-|dist - 22| * 0.25` — which is
 * the wrong shape now that the wave is selected as a *set*: a term that pulls
 * every post toward one distance is a term that makes every soldier in the wave
 * walk the same length of route and arrive at the same moment. Nothing needs to
 * push a post outward, because the near edge of the window is already held by
 * the spawner's own floor at 15 m; the only thing distance should buy is spread,
 * and {@link DIST_ECHO} buys that.
 *
 * With this shape the selector lays a ladder rather than a clump. The first pick
 * takes the near edge; a second post within {@link DIST_ECHO} of it costs 3
 * points against the 1 point of stepping 4 m further out, so each successive
 * pick steps outward: 15, 19, 23, 27 m rather than 26, 27, 29, 30. Measured over
 * 320 stagings, that widens the spread between a wave's earliest and latest
 * arrival from 2.16 s to 2.60 s, and takes the share of stagings holding **both**
 * an arrival inside 2.5 s and one past 3.5 s from 35.9% to 52.5%. Half of every
 * wave's posts now open at a different moment from the other half.
 *
 * **The commute is not the problem, and this round is the first measurement
 * honest enough to say so.** Both this file's earlier figures and the brief's
 * suspicion that "staging at 22-46 m may simply take longer than the budget
 * assumed" rest on walking the soldier all the way to the player. It does not go
 * there: `travelSpeed(remaining)` in `Behaviour.ts` is fed the distance still to
 * run, the soldier stops when it acquires, and the measured opening range is
 * about 10.7 m. So the quantity that matters is the time to *contact*, which is
 * the route travelled until the straight line closes to 10.7 m — sprint at
 * 5.1 m/s while more than 13 m remains, walk at 3.2 m/s below that (§7.5
 * `[stated]` `sv_botSprintDistance`).
 *
 * Run against real A* routes over this district rather than a flat 1.24x detour
 * factor — the true detour runs 1.00-1.90x, worst where the east row and the lot
 * sit behind a block — spawn to contact comes out at:
 *
 * | staging          | mean   | earliest in a wave | latest in a wave |
 * |------------------|--------|--------------------|------------------|
 * | shipped          | 3.56 s | 2.41 s             | 4.56 s           |
 * | this round       | 3.74 s | 2.43 s             | 5.03 s           |
 *
 * Two and a half to five seconds, against a match that opens a wave with five
 * hostiles and reinforces every 1.5-2.2 s. The approach is not what leaves five
 * hostiles standing with nothing in contact for five seconds; it accounts for
 * about half of the first such gap in a wave and none of the later ones.
 */
const FAR_COST = 0.25

/**
 * The sightline each successive wave aims to open at, metres.
 *
 * **This rotates the approach, not the range, and the difference matters.** The
 * cycle was written believing it varied how far away fights start. Measured
 * over 11,808 stagings it does not: every band stages at the same distance to
 * within half a metre — 32.1-33.6 m under the old ceiling, 24.9-25.2 m now —
 * because `sight` is a property of the *post*, and scoring for it picks which
 * lane the wave comes from, not how far out it is put.
 *
 * Nor could staging set the engagement distance even if it did vary the range.
 * A soldier walks to where the player is and stops when it acquires, so the
 * fight opens wherever the district's clutter first gives it a line. That
 * measures **11.63 m** live, against a staged mean of 32.9 m — the two numbers
 * are barely related. Staging far bought commute, not range.
 *
 * The cycle is kept because rotating the approach is worth having on its own:
 * paired with {@link EncounterDirector.recentLanes} it is what stops three
 * waves in a row walking out of the alley. It is no longer described as
 * controlling the distance fights happen at, because it does not.
 *
 * **It is also no longer allowed to choose the whole wave, and that is this
 * round's largest change.** `sight` is a property of the lane, and on this map
 * the lane is also the *direction* — the highway lane is the only one that
 * fights at 26-34 m and every one of its posts stands east of the plaza. So a
 * score whose dominant term was `-|sight - targetSight|` picked one lane, and
 * picking one lane picked one bearing and one distance for every post in the
 * wave. Driven against the five positions the two shipped scenarios put the
 * player at, the eight bands of this cycle collapsed to **two or three distinct
 * stagings** per position, and each of those published three to five posts from
 * one lane group: to the `hold` player, three highway posts and two east ones,
 * all 24-30 m out, bearings within 30 degrees of each other. The 19 posts
 * standing in the usable ring at that moment spanned **15-30 m and the whole
 * front arc**, and the selector reached none of the near or western ones.
 * Censused over 320 stagings the shipped file published 2.02 directions each and
 * reached three only 2% of the time. That is the panel's queue, written as a
 * scoring weight: five soldiers
 * released together from one direction at one distance file down one approach
 * and open contact one at a time as each rounds the same corner. The measured
 * `hold` wave opens at 42.8, 44.1, 46.7, 48.6 and 50.4 s, every one of them at
 * 10.4-11.0 m.
 *
 * The term is therefore scaled by {@link SIGHT_WEIGHT} — kept as a flavour
 * preference, demoted from the thing that decides the wave. What decides the
 * wave is spread; see {@link GROUP_MAX} and {@link DIST_ECHO}.
 *
 * Until this round it did not rotate at all in a played game: the index it is
 * read with was only advanced past the `directsSpawning` gate. Driven over a
 * three-minute match-directed run the shipped file staged every one of nine
 * waves against `SIGHT_CYCLE[0]`; it now steps once per wave. See
 * {@link WAVE_BOUNDARY}.
 */
const SIGHT_CYCLE = [26, 13, 30, 18, 22, 10, 34, 20]

/**
 * Enemies per wave.
 *
 * §7.2 `[stated]` clamps concurrent attackers to 2 (`ai_maxAttackerCount`),
 * which `src/ai` already enforces, so wave size does not control lethality —
 * it controls how long the fight lasts and how many separate contacts it
 * produces. Two more bodies is two more seconds of fight, not twice the
 * incoming fire.
 *
 * The old cycle was `[4, 3, 5, 3, 4, 5]`, which has no shape: it rises and
 * falls at random and the playtest read it as intensity collapsing rather than
 * building. This one climbs across the cycle and resets, which is the wave
 * shape the series uses — the fifth minute of a level is meant to be harder
 * than the first, and then a new sequence starts.
 *
 * Delivery is `min(size, LIVE_CAP - live)`, so the cap has to leave room for
 * the top of the cycle or the escalation is thrown away at the clamp.
 */
const WAVE_SIZES = [3, 4, 4, 5, 5, 6]

/**
 * Live enemies past which no new wave is committed.
 *
 * 6 with {@link SPENT_LIVE} at 2 means a wave is never larger than four however
 * big {@link WAVE_SIZES} asks for, which flattens the escalation above into
 * nothing. 8 leaves the top of the cycle intact and still sits under the
 * `MAX_LIVE` of 10 in `src/ai`, which is the real ceiling.
 */
const LIVE_CAP = 8

/**
 * Seconds with nothing in contact before the next wave is committed.
 *
 * This is the *quiet* part of the lull; the rest of the downtime is the wave's
 * approach. Downtime is a graded metric with a 12-28 s band and it measures
 * **6.69 s**, which is short of it. The two terms are this constant and the
 * commute, and the commute is now measured at roughly 4 s mean from the tighter
 * staging window, so 4.5 + 4 could never have reached the band whatever else
 * happened. Nine seconds plus the commute lands at about 13 s, inside it.
 *
 * It has to stay under `AiSystem`'s own reinforcement lull so the director's
 * shaped wave lands first and that timer resets rather than putting a second
 * wave on top of it. The comment here used to give that as 6 s; the constants
 * in `src/ai` are `LULL_MIN` 11 / `LULL_MAX` 15, so the real headroom is two
 * seconds, not one and a half.
 *
 * Note what this constant is *not* able to do, which the paragraph above reads
 * as though it could. It runs only when nothing else is directing — a menu,
 * an abandoned match, a finished one. Every measured run is match-directed
 * from the first frame, so no downtime figure yet published has ever been a
 * function of this number. Downtime now measures 3.41 s; the 43.3 s of quiet
 * behind that mean arrives in 17 pieces, and the fix is fewer arrival clusters
 * rather than a longer timer here. See the header.
 */
const QUIET_BEFORE_WAVE = 9

/**
 * Seconds of quiet after which a wave is staged at the near band whatever else
 * is going on.
 *
 * A wave staged deep behind cover can fail to find the player at all if the
 * player also stops moving — the `hold` scenario does exactly that. Longest
 * quiet stretch is a graded metric with a 60 s ceiling, so this fires well
 * inside it and guarantees a contact within a few seconds.
 *
 * This handles a player nobody can find. It is not a backstop on the director
 * itself, because it reads the same accumulator as {@link QUIET_BEFORE_WAVE}:
 * see {@link MAX_SILENCE}, which is.
 *
 * 26 s was set against the 60 s ceiling on the longest-quiet-stretch metric,
 * which is the wrong reference — it asks only that the silence not be
 * catastrophic. The downtime band is 12-28 s, so 18 s puts a forced contact at
 * the top of a lull the player is meant to enjoy rather than several seconds
 * after they have concluded the district is empty.
 */
const MAX_QUIET = 18

/**
 * The backstop that does not read the accumulator: seconds since the last spawn
 * after which a spent wave is replaced regardless of what contact says.
 *
 * {@link MAX_QUIET} cannot do this job, because it gates on the same
 * accumulator as {@link QUIET_BEFORE_WAVE} and that accumulator can be pinned
 * at zero indefinitely by one enemy. `hasContact` in `src/ai` is
 * `losClear && awareness > 0.55`; `losClear` is a throttled raycast and
 * awareness decays at 0.22/s, so it stays over the threshold for about two
 * seconds after the line breaks. A soldier trading sight around a corner
 * re-acquires well inside that window every time, so `quiet` sawtooths between
 * zero and a fraction of a second and never reaches either threshold. Down to
 * that soldier and with him unable to close, nothing committed the next wave
 * and nothing ever would. Driven with one enemy alive on a 0.4 s visible /
 * 1.2 s hidden cycle, `quiet` peaked at **1.20 s** over a full minute — under
 * 4.5 the whole time, never mind 26 — so the director committed nothing at all
 * for the entire run. With this clock the same minute delivers waves at 26.0 s
 * and 52.0 s.
 *
 * This clock is wall time since the last spawn, so no perception result can
 * touch it. It is paired with {@link SPENT_LIVE} so it cannot fire into a
 * healthy fight: a wave still carrying more than one soldier is not stalled,
 * it is being fought. In ordinary pacing a wave is spent and replaced well
 * inside this, so it never fires at all.
 *
 * Held level with {@link MAX_QUIET} at the top of the 12-28 s downtime band for
 * the same reason. Note that it is paired with {@link SPENT_LIVE}, which is now
 * 2 rather than 1, so the pair of stragglers that used to pin both clocks open
 * no longer does.
 */
const MAX_SILENCE = 18

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

/**
 * Seconds of no arrivals after which the next arrival counts as a new wave.
 *
 * This exists because the director's own wave counter was dead in every game
 * anyone has ever played. {@link SIGHT_CYCLE} is indexed by `waveIndex`, and
 * `waveIndex` was advanced on the line after `spawnWave` — which is on the far
 * side of the `directsSpawning` gate. `MatchDirector` holds that flag from the
 * first frame to the last, so this director never reached the increment: it
 * staged every wave of every run for `SIGHT_CYCLE[0]`, and {@link recentLanes}
 * stayed `[null, null]` forever, so the penalty that stops three waves walking
 * out of the same alley never applied once. Both were switched off by the
 * change that stopped this file double-spawning, silently, and both are the
 * whole reason the file exists.
 *
 * The fix is to key the cycle on what actually happens rather than on who
 * caused it: a hostile arriving after a gap this long is a new approach
 * whoever sent it. The threshold has to sit above the match's reinforcement
 * beat and below its break. `MatchDefs` runs beats at 3.2 s down to 0.9 s and
 * schedules `WAVE_SETTLE` 1.5 s + `breakSeconds` 9 s = 10.5 s between waves, so
 * six is clear of both ends. A wave whose beats are blocked at the concurrency
 * ceiling for six seconds also rolls the cycle, which is right: six seconds
 * without an arrival is an approach the player can feel, whatever the director
 * upstream believes it is in the middle of.
 */
const WAVE_BOUNDARY = 6

/**
 * Live enemies at or below which the current wave counts as spent.
 *
 * This was 1, and 1 is the number behind the playtest note that "enemiesAlive
 * floors at exactly 2 and sits there, with enemiesInContact at 0". Two soldiers
 * who have lost the player are not a fight, but they are two, so `spent` stayed
 * false and the only way out was {@link MAX_QUIET} or {@link MAX_SILENCE} —
 * both of which were 26 s. Every pair of stragglers bought itself the better
 * part of half a minute of silence.
 *
 * 2 is `ai_maxAttackerCount` `[stated]` §7.2: the engine only ever lets two AI
 * shoot at the player at once, so a field that cannot fill both attacker slots
 * is thin by the series' own definition. And the live count is a second opinion
 * on a question `quiet` has already answered — {@link QUIET_BEFORE_WAVE}
 * requires nine seconds with nobody in contact before this is even consulted.
 */
const SPENT_LIVE = 2

/** Seconds between restagings, and metres of player movement that force one. */
const STAGE_INTERVAL = 2.0
const STAGE_MOVE = 5

/**
 * Posts published per wave.
 *
 * Eight was `PRIMARY_MAX` 5 plus `SECONDARY_MAX` 3 — one lane's worth plus a
 * flank. The total is unchanged and the split is gone: the wave is no longer
 * built as a front plus a flank but as a spread, three posts to a direction at
 * most, no two at the same range. See {@link GROUP_MAX} and {@link DIST_ECHO}.
 *
 * Eight is also more than any single beat asks for — `MatchDefs` opens a wave
 * with five or six — and that is deliberate. Every post a staging is short of is
 * a soldier `AiSystem` places from its own composed arc instead, and every point
 * on that arc is required to have a clear line to the player's chest, which is a
 * hostile appearing in view rather than walking into contact.
 */
const MAX_STAGED = 8

/**
 * Most posts a wave may take from one direction, where "one direction" means
 * within {@link MIN_LANE_SPREAD} of a post already taken.
 *
 * This is the constant that breaks the queue. Three is chosen against the
 * arithmetic of the fight rather than by taste: kill duration measures 2.3 s and
 * the engine clamps concurrent attackers to two (§7.2 `[stated]`
 * `ai_maxAttackerCount`), so three soldiers arriving on one bearing are serviced
 * one after another by a player who never has to turn — the third is still
 * waiting when the first two are dead. A fourth on the same bearing adds
 * nothing the player can feel. Eight posts at three to a direction is therefore
 * at least three directions, which is what "the player turns between threats"
 * requires.
 *
 * Measured over the five positions the shipped scenarios put the player at, the
 * usable ring holds 11-23 posts spanning four to six lanes, so three directions
 * is available everywhere on this map — thinnest at the plaza's west side,
 * (-10, -12), which offers 11 posts across four lanes.
 *
 * The count is of posts *already taken* within {@link MIN_LANE_SPREAD} of the
 * candidate, so it is a pairwise rule rather than a clustering one, and the
 * difference is not academic: nothing stops a chain of posts each 44 degrees from
 * the last. Censused over 55,663 stagings on a 3 m lattice across the district,
 * the widest 45-degree window the shipped file filled held **four to seven posts,
 * a quarter of the time**; under the cap it never holds more than three.
 */
const GROUP_MAX = 3

/**
 * Metres within which two posts count as the same arrival, and what a repeat
 * costs.
 *
 * Two soldiers released together from posts the same distance out walk the same
 * length of route at the same speed and arrive at the same moment from, as far
 * as the fight is concerned, the same place. Four metres is about 0.9 s of
 * commute at the AI's 5.1 m/s sprint (§7.5 `[stated]` `sv_botSprintDistance`),
 * which is under half a kill, so anything inside it is a duplicate arrival.
 *
 * The penalty is set against the far-distance term: at 0.25 points per metre,
 * reaching 12 m further out to break a tie costs 3 points, so an echo penalty of
 * 3 makes the selector rather cross the map than send two soldiers to the same
 * range. It is under {@link CROWD_PENALTY} because a repeated range with a new
 * bearing is still a threat the player has to turn for, and a repeated bearing
 * is not.
 */
const DIST_ECHO = 4
const ECHO_PENALTY = 3

/** What each post already taken within {@link MIN_LANE_SPREAD} costs. */
const CROWD_PENALTY = 4

/**
 * Weight on the {@link SIGHT_CYCLE} match.
 *
 * The raw term is `-|post.sight - targetSight|`, which on this post graph runs
 * to -26 and buried every other term in the score. Scaling it to a quarter caps
 * it at about -6.5, level with the spread penalties, so the cycle still tilts a
 * wave toward the alley or toward the square without deciding all eight posts.
 * See {@link SIGHT_CYCLE}.
 */
const SIGHT_WEIGHT = 0.25

/**
 * Posts a wave may take from inside a building — a room or a roof deck.
 *
 * This was `OVERWATCH_MAX`, a cap on the `roof` lane alone: two posts on the
 * market hall deck, 2.86 m up, whose whole value is the angle down into the
 * junction. One soldier there is a threat the player has to solve; a squad there
 * is a squad that is not coming. See {@link leads} for why it may not lead a
 * wave at all.
 *
 * It now covers every `enclosed` post, which is the roof deck *and* the four
 * interior rooms, for two reasons that turn out to be the same reason.
 *
 * The first is composition. A room post fights at 8-9 m through a doorway, so a
 * soldier in one is a position rather than an approach — three of them at once is
 * three soldiers in three rooms, none of them the room the player is in.
 *
 * The second is that these are the only posts in the graph whose route to the
 * player this file cannot check. The occlusion lattice is built from building
 * footprints, so a footprint's interior is solid to it: an interior post reads as
 * perfectly hidden, skips the ring test that asks whether a firing line is a
 * short walk away, and collects a room's cover bonus on top. That is exactly the
 * scoring shape that made two roof posts the district's most popular approach
 * before {@link DECK_SUPPORT} was added, and the roof deck then turned out to be
 * a nav island. Whether the four rooms are connected depends on doorway widths
 * against `NavGrid`'s 0.75 m lattice and its clearance rule, neither of which is
 * answerable from here. Capping them at one bounds the exposure to a single
 * soldier per wave, whom `AiSystem.recycleStranded` will collect if the room does
 * turn out to be sealed.
 *
 * Demoting the {@link SIGHT_CYCLE} term made this cap necessary rather than
 * merely tidy: rooms are the only posts with a sight under 10 m, so under the old
 * weight they won only at the near bands, and under the new one they win wherever
 * a direction has nothing else in it. With the term demoted and before this cap
 * was added, staging against the `hold` position published two or three rooms in
 * every eight posts, at every band.
 */
const ENCLOSED_MAX = 1

/**
 * Smallest bearing, in radians, at which two posts read as separate directions
 * rather than as one group spread thin. 45 degrees.
 */
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
 * Metres a ground post must clear every building footprint by.
 *
 * Enough for a soldier to stand and turn without clipping the wall he spawned
 * against: the §4.6 `[stated]` aim-assist capsule is 0.254 m in radius and a
 * shouldered rifle reaches rather further than that.
 */
const POST_CLEARANCE = 0.9

/**
 * Solidity lattice cell classes, ordered so that a cell hides a post when its
 * class is at least the class the post needs to be hidden.
 *
 * A cell outside every footprint stays zero and hides nothing.
 *
 * A line between two people standing on the ground is broken by any structure
 * at all, so for a ground post the lattice is effectively binary. A line to
 * somebody standing on a roof deck differs in exactly one way: the building he
 * is standing on does not hide him — he is on top of it. Two classes are
 * therefore enough to answer both questions, and neither of them needs a height
 * in metres, which is what lets both be derived from the footprint data alone.
 *
 * Marching one class for everything is what made the roof lane the district's
 * most popular approach. Both roof posts sit 3.5 m and 3.0 m inside the market
 * hall footprint; {@link MARCH_SKIP} drops only 1.6 m at the target end, so
 * every march to them ended on a solid cell. Marched from all 1,252 standable
 * spots inside `bounds`, they read as hidden from **100%** of the ones in
 * staging range — 640 and 716 spots respectively, no exceptions. `enclosed`
 * then added a room's cover bonus on top and skipped the ring test. Two posts
 * on an open deck, with a designed 28-30 m sightline and a breached parapet
 * composed to open the district up, were scoring as the best cover on the map.
 * Staged from every one of those spots against a uniformly random facing, they
 * took the primary slot 36% of the time at the cycle's 26 m band, 48% at 30 m
 * and 40% at 34 m — the top lane at every long sightline the cycle asks for.
 * The same census now gives them 20%, 30% and 25%, and reads them as hidden
 * from 77% and 79% of spots rather than all of them.
 *
 * Re-measured this round by driving the shipped director over 11,808 stagings
 * (1,968 standable spots x 6 facings x the 8 bands) rather than by censusing
 * the grid, the roof lane takes **14% / 20% / 19%** of the primary slot at the
 * 26, 30 and 34 m bands, behind `north` at 20% / 31% / 31%. The fix holds and
 * the live figures are a little kinder than the census suggested. One detail of
 * the claim above did not survive: under the old 46 m ceiling the roof lane led
 * `north` at the 30 m band, 35% to 31%, so "behind north in all three" was
 * true of the census protocol and not of the director. Bringing the ceiling in
 * to 30 m is what put `north` ahead at every long band.
 *
 * The two classes are an approximation with one known error each way. Every
 * building in the district is taller than the 2.8 m deck — the shortest,
 * `cornerShop`, is 4.35 m to its parapet — but the alley compound wall in
 * `EXTRA_FOOTPRINTS` is 2.55 m, so it is treated as hiding a deck it would
 * really be seen over. And a roof post placed on something much taller than the
 * market hall would be under-reported the other way, because everything else
 * would still outrank it. Both are wrong only for a deck; a third class, or
 * real heights, is the fix if a second roof ever goes in.
 *
 * With the deck dropped from live staging there are no elevated posts left in
 * a played game, so {@link EncounterDirector.deckSupports} finds none, every
 * solid cell is baked {@link FULL_HEIGHT}, and the lattice collapses to the
 * binary one a ground-to-ground line needs. That is a graceful degradation
 * rather than dead weight: nothing above changes, the second class simply has
 * nothing to distinguish, and it starts working again the moment a reachable
 * deck post is added back.
 */
/** A structure that hides a post on the ground, but not one standing on it. */
const DECK_SUPPORT = 1
/** A structure tall enough to hide a post on a roof deck as well. */
const FULL_HEIGHT = 2

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
  /** Metres from the player's eye, on the ground plane. */
  dist: number
  lane: Lane
  /** Mirrors `Post.enclosed`; see {@link ENCLOSED_MAX}. */
  enclosed: boolean
  /** Set while this candidate is in the staging currently being built. */
  taken: boolean
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
  /** Indices into {@link cands} of the posts taken by the staging in progress. */
  private order = new Int32Array(MAX_STAGED)

  private ai: AiService | null = null
  private level: LevelService | null = null

  /** Enemy ids currently holding contact with the player. */
  private contacts = new Set<number>()
  private quiet = 0
  private waveIndex = 0
  /**
   * When a hostile last arrived, from anybody's spawner.
   *
   * **Starts at zero, not at minus infinity, and that one character was three
   * extra hostiles in the opening of every run.** Every clock in this class is
   * `ctx.elapsed - lastSpawnAt`, so a sentinel in the deep past reads as
   * "nothing has spawned for a hundred seconds" on the very first frame:
   * {@link MAX_SILENCE} and {@link MIN_WAVE_GAP} were both satisfied at
   * `elapsed = 0.03`, `live` was zero so the wave counted as spent, and this
   * director committed a backstop wave before the game had drawn a frame.
   *
   * The gate below could not stop it either, because on frame one it is not
   * yet true: `MatchDirector` only leaves `idle` when `HudSystem` emits
   * `game:started`, which happens in *its* update — three systems later in the
   * same frame. So the one frame in the whole run where the match does not own
   * spawning is the frame this director was guaranteed to fire on.
   *
   * Measured, both 90 s runs open with **eight** live hostiles: five from
   * `AiSystem.openingWave` and three from here, against wave one's designed
   * opening of three. That number is not just noisy, it is self-sustaining —
   * `MatchDirector` sizes each reinforcement beat as
   * `min(beat, concurrent - active, remaining)` and wave one's `concurrent` is
   * four, so with eight already standing the term is negative and **the match
   * cannot deliver its own wave at all** until the field thins below four. The
   * measured runs sit at five to six live for the first forty seconds doing
   * exactly that.
   *
   * Zero is the honest value: `AiSystem` spawns its opening wave on the first
   * frame with `dt > 0`, so at `elapsed = 0` a wave has, for this director's
   * purposes, just landed.
   */
  private lastSpawnAt = 0
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
   *
   * "When a wave is actually committed" now means *when hostiles actually
   * arrive*, not when this director commits one itself — see
   * {@link WAVE_BOUNDARY}.
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
    const buried: Post[] = []
    for (const p of POSTS) {
      if (!p.enclosed && insideAnyBuilding(p.x, p.z, POST_CLEARANCE)) {
        buried.push(p)
        continue
      }
      // An elevated post is dropped from live staging outright. See the note on
      // the roof entries in {@link POSTS}: the market hall deck is a nav island
      // and a soldier put on it cannot walk to the player. Captures keep it —
      // a scripted pose holds its soldiers in place and never asks them to
      // path — which is why the test is here rather than in the table.
      if (this.enabled && p.y !== undefined) continue
      this.posts.push(p)
      this.world.push(new THREE.Vector3(p.x, p.y ?? groundHeight(p.x, p.z) + 0.05, p.z))
    }
    // Dropping the post is the right call; doing it silently is not. A lane
    // quietly short of one approach still stages, still scores and still looks
    // healthy — it just pushes the traffic it should have carried onto whatever
    // lane is next best, which is how two roof posts came to absorb half the
    // long-range waves on this map.
    if (buried.length > 0) {
      console.warn(
        `[encounter] ${buried.length} post(s) dropped for standing within ${POST_CLEARANCE} m of a ` +
        `building: ${buried.map((p) => `${p.lane}/${p.sight}m at (${p.x}, ${p.z})`).join(', ')}. ` +
        'Those lanes now have fewer approaches than POSTS claims; move the posts or the footprint.',
      )
    }
    for (let i = 0; i < MAX_STAGED; i++) this.pool.push(new THREE.Vector3())
    for (let i = 0; i < this.posts.length; i++) {
      const p = this.posts[i]
      this.cands.push({ index: i, score: 0, bearing: 0, dist: 0, lane: p.lane, enclosed: !!p.enclosed, taken: false })
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
    // Arrivals drive the cycle, whoever sent them. See {@link WAVE_BOUNDARY}.
    this.offs.push(e.on('entity:spawned', (p) => {
      if (p.entity.team !== 'enemy') return
      if (ctx.elapsed - this.lastSpawnAt >= WAVE_BOUNDARY) {
        this.waveIndex++
        this.recentLanes[1] = this.recentLanes[0]
        this.recentLanes[0] = this.stagedLane
      }
      this.lastSpawnAt = ctx.elapsed
    }))
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

    // Nobody who is not alive is holding contact. `AiSystem` does close the
    // contact of a soldier killed mid-sighting, so this is belt and braces —
    // but one stale id left in this set pins `quiet` at zero for the rest of
    // the run, and that is exactly the failure MAX_SILENCE exists to survive.
    if (live === 0) this.contacts.clear()
    if (this.contacts.size > 0) this.quiet = 0
    else this.quiet += dt

    // Whether a wave is committed this frame is decided before staging, not
    // after. The backstop asks for a near band that the ordinary cycle does not,
    // and staging is only refreshed every {@link STAGE_INTERVAL} — so deciding
    // afterwards would let the backstop fire against staging computed for the
    // far band, spawn a wave the player still cannot find, and reset its own
    // clock for another {@link MAX_QUIET} seconds.
    const stalled = live <= SPENT_LIVE && ctx.elapsed - this.lastSpawnAt >= MAX_SILENCE
    const forcing = this.quiet >= MAX_QUIET || stalled
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

    // The wave counter and the lane history are *not* advanced here. They are
    // advanced by the `entity:spawned` handler, which sees this spawn as well
    // as the match's and the AI's, and which is therefore the only place that
    // stays correct on both sides of the gate above. See {@link WAVE_BOUNDARY}.
    const size = WAVE_SIZES[this.waveIndex % WAVE_SIZES.length]
    this.quiet = 0
    ai.spawnWave(Math.min(size, LIVE_CAP - live))
    // After the spawn, not before, and the order is load-bearing twice over.
    // The handler needs to still see the *previous* arrival when it decides
    // whether this one opens a new wave; and a `spawnWave` that places nobody —
    // every point blocked, or `AiSystem`'s own live cap reached — emits nothing
    // at all, so without this line the request would repeat every frame instead
    // of once per {@link MIN_WAVE_GAP}.
    this.lastSpawnAt = ctx.elapsed
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
    //
    // Distance gives way before cover does, and that order was measured rather
    // than assumed. Tightening {@link MAX_STAGE} to 30 m means the strict pass
    // no longer answers every time — over 11,808 stagings it finds three or
    // more posts 70.5% of the time, against 100% under the old 46 m ceiling.
    // Swapping the order so cover gave way first was tried and is worse: it
    // buys 0.5 s of commute and ten points of promotion share, and it costs
    // 11.6% of published posts their cover, which is 11.6% of waves appearing
    // in front of a player who was watching. Holding cover keeps 99.1% of posts
    // hidden for a mean commute of 4.7 s.
    //
    // What was genuinely wrong was the ceiling the fallback reached to: 60 m,
    // past the 55 m `VIEW_RANGE` in `src/ai`, where a soldier cannot see the
    // player from where it is put and so has nothing to walk towards. See
    // {@link LOOSE_STAGE}.
    for (let relax = 0; relax < 3; relax++) {
      const minDist = near ? BACKSTOP_MIN : MIN_FRONT
      const maxDist = near ? BACKSTOP_MAX : relax === 0 ? MAX_STAGE : LOOSE_STAGE
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

    // Pick the wave one post at a time, each pick charged for how much it
    // repeats what is already in the wave.
    //
    // Selecting the *set* rather than ranking posts independently is this
    // round's change and it is the whole of the fix. Independent ranking cannot
    // produce a spread, because the thing that makes a post score well —
    // matching the band, sitting near the preferred distance, holding cover — is
    // shared by every other post in the same lane, so the top of the list is
    // always five near-clones. Charging for repetition is the smallest rule that
    // makes the second pick depend on the first.
    //
    // Two repetitions are charged, and they are not the same fault. A post on a
    // bearing already taken is a soldier the player does not have to turn for;
    // three of those is the most the fight can use, so the count is a hard cap
    // ({@link GROUP_MAX}) as well as a penalty. A post at a range already taken
    // is a soldier who arrives at the same moment as one already sent, which is
    // a wasted arrival rather than a wasted direction, so it is only a penalty.
    //
    // The first pick must be a lane that can lead. `roof` is not one: it is two
    // posts on one deck, 2.86 m up, and a soldier put there is already at its
    // firing position — there is no approach to walk. Letting it lead means the
    // whole wave stands on a platform whose route down this file cannot verify,
    // which is the playtest's "hostiles standing somewhere unreachable" written
    // as a staging decision. It came up immediately: staged against
    // `playerSpawn`, with the tighter ceiling, roof was the top-scoring lane and
    // took two of the three opening posts. It stays in the graph, capped at
    // {@link ENCLOSED_MAX}, as a flank — one rifle looking down into the
    // junction is the shot the deck was composed for.
    const out = level.spawnPoints
    out.length = 0
    const order = this.order
    let taken = 0
    let enclosedTaken = 0
    for (let i = 0; i < this.usable; i++) cands[i].taken = false

    while (taken < MAX_STAGED) {
      let bestAt = -1
      let bestScore = 0
      for (let i = 0; i < this.usable; i++) {
        const c = cands[i]
        if (c.taken) continue
        if (taken === 0 && !leads(c.lane)) continue
        if (c.enclosed && enclosedTaken >= ENCLOSED_MAX) continue
        let crowd = 0
        let echo = 0
        for (let k = 0; k < taken; k++) {
          const t = cands[order[k]]
          if (angleBetween(c.bearing, t.bearing) < MIN_LANE_SPREAD) crowd++
          if (Math.abs(c.dist - t.dist) < DIST_ECHO) echo++
        }
        if (crowd >= GROUP_MAX) continue
        const s = c.score - crowd * CROWD_PENALTY - echo * ECHO_PENALTY
        if (bestAt < 0 || s > bestScore) { bestAt = i; bestScore = s }
      }
      if (bestAt < 0) break
      const c = cands[bestAt]
      c.taken = true
      order[taken] = bestAt
      if (c.enclosed) enclosedTaken++
      const v = this.pool[taken++]
      v.copy(this.world[c.index])
      out.push(v)
    }

    // The lane the wave is *remembered* by is the one it led with, which is the
    // one {@link recentLanes} penalises next time round.
    this.stagedLane = taken > 0 ? cands[order[0]].lane : null
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

      const deck = p.y !== undefined
      const hidden = this.occluded(w.x, w.z, deck)
      if (requireHidden && !hidden) continue

      // A post is only useful if the soldier on it can find the player within a
      // few seconds. Deep inside a block he never will; standing in the open he
      // already has. What is wanted is the corner: hidden from where the player
      // stands, with a firing line a short walk away. The ring test is how that
      // is told apart — how many points a few metres off this one can see the
      // player. It is a ground-plane test, so it is only asked of ground posts:
      // the ring around a roof post is the hall below it, not the deck.
      let openNeighbours = 0
      if (!p.enclosed) {
        if (!this.occluded(w.x + EDGE_RADIUS, w.z, false)) openNeighbours++
        if (!this.occluded(w.x - EDGE_RADIUS, w.z, false)) openNeighbours++
        if (!this.occluded(w.x, w.z + EDGE_RADIUS, false)) openNeighbours++
        if (!this.occluded(w.x, w.z - EDGE_RADIUS, false)) openNeighbours++
      }

      // Scaled, and monotone in distance. Both terms used to be able to decide
      // the whole wave on their own; see {@link SIGHT_WEIGHT} and
      // {@link FAR_COST}.
      let score = -Math.abs(p.sight - targetSight) * SIGHT_WEIGHT
      score -= Math.max(0, dist - MIN_FRONT) * FAR_COST
      if (p.lane === this.recentLanes[0]) score -= 9
      else if (p.lane === this.recentLanes[1]) score -= 4
      if (!hidden) score -= 8
      if (p.enclosed) {
        // A room is cover in its own right — walls on four sides and a doorway
        // to come out of — and there is no ring to test because every point
        // around it is inside the same building. A roof deck shares neither
        // property: it is an exposed platform whose whole advantage is height,
        // and it now earns its place from an honest occlusion test rather than
        // from a bonus written for rooms.
        if (!deck) score += 2
      } else if (openNeighbours === 0) score -= 3
      else if (openNeighbours <= 3) score += 3
      score += this.rng.range(0, 1.5)

      const c = this.cands[this.usable++]
      c.index = i
      c.score = score
      c.bearing = Math.atan2(dx, dz)
      c.dist = dist
      c.lane = p.lane
      c.enclosed = !!p.enclosed
      c.taken = false
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
   *
   * Cells are classed rather than flagged, so the same lattice answers for a
   * post on the ground and a post on a roof; see {@link DECK_SUPPORT}.
   */
  private buildSolidGrid(bounds: THREE.Box3): void {
    this.gridMinX = bounds.min.x
    this.gridMinZ = bounds.min.z
    this.gridW = Math.ceil((bounds.max.x - bounds.min.x) / CELL)
    this.gridH = Math.ceil((bounds.max.z - bounds.min.z) / CELL)
    this.solid = new Uint8Array(this.gridW * this.gridH)

    const supports = this.deckSupports()
    let filled = 0
    for (let j = 0; j < this.gridH; j++) {
      const z = this.gridMinZ + (j + 0.5) * CELL
      for (let i = 0; i < this.gridW; i++) {
        const x = this.gridMinX + (i + 0.5) * CELL
        if (!insideAnyBuilding(x, z, 0)) continue
        let cls = FULL_HEIGHT
        for (const s of supports) {
          if (rotRectSdf(x, z, s.cx, s.cz, s.hw, s.hd, s.yaw) < 0) { cls = DECK_SUPPORT; break }
        }
        this.solid[j * this.gridW + i] = cls
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

  /**
   * The footprints the roof posts stand on.
   *
   * Looked up from the architecture rather than written down here, so that
   * moving the market hall moves this with it. Two posts on one hall yield the
   * same rectangle twice; that costs one extra distance evaluation per solid
   * cell at init and is not worth de-duplicating.
   */
  private deckSupports(): Footprint[] {
    const out: Footprint[] = []
    for (const p of this.posts) {
      if (p.y === undefined) continue
      const s = footprintUnder(p.x, p.z)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * True when something stands between the player's eye and a post.
   *
   * `onDeck` marks a post that is standing on a roof rather than on the ground.
   * The building under it is then not between the two of them and does not
   * count; everything else does.
   */
  private occluded(tx: number, tz: number, onDeck: boolean): boolean {
    const hides = onDeck ? FULL_HEIGHT : DECK_SUPPORT
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
      if (this.solid[j * this.gridW + i] >= hides) return true
    }
    return false
  }
}

interface Footprint {
  cx: number
  cz: number
  hw: number
  hd: number
  yaw: number
}

/** The building footprint a point stands inside, or null if it stands outside. */
function footprintUnder(x: number, z: number): Footprint | null {
  for (const s of BUILDINGS) {
    const hw = s.w / 2
    const hd = s.d / 2
    const yaw = s.yaw ?? 0
    if (rotRectSdf(x, z, s.cx, s.cz, hw, hd, yaw) < 0) return { cx: s.cx, cz: s.cz, hw, hd, yaw }
  }
  for (const s of EXTRA_FOOTPRINTS) {
    if (rotRectSdf(x, z, s.cx, s.cz, s.hw, s.hd, s.yaw) < 0) return s
  }
  return null
}

/** Whether a lane can be the direction a wave arrives from. */
function leads(lane: Lane): boolean {
  return lane !== 'roof'
}

/** Absolute difference between two bearings, wrapped into [0, PI]. */
function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}
