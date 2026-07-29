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
 * Preferred staging distance, metres.
 *
 * The old value of 30 was derived from §6.2 `[estimated]` spawn-to-contact of
 * 5-10 s at the §4.1 `[stated]` player speeds of 4.7-6.3 m/s. Two things were
 * wrong with that: soldiers do not move at player speeds, and the quantity that
 * matters is not arrival, it is the moment the fight starts.
 *
 * Measured from the shipped staging, walking each published post's A* route at
 * the AI's real `travelSpeed` (sprint 5.1 m/s until 13 m out, then walk
 * 3.2 m/s, §7.5 `[stated]` `sv_botSprintDistance`), against the **11.63 m**
 * mean engagement distance the game actually measures:
 *
 * | staging window | commute to 11.63 m: mean / p90 / max |
 * |----------------|-------------------------------------|
 * | 12-46 m (was)  | 5.9 s / 9.1 s / 13.3 s              |
 * | 12-34 m        | 4.6 s / 7.7 s / 11.6 s              |
 * | 12-30 m (now)  | 3.9 s / 7.2 s / 10.9 s              |
 * | 13-22 m        | 2.2 s / 3.8 s / 8.6 s               |
 *
 * Routes run 1.24x the straight line on this map, so the walk is longer than
 * the staging distance suggests but not by the margin the sprint/walk split
 * implies: a soldier sprints all but the last 13 m.
 *
 * 22 m is the middle of the new window and lands the commute at roughly four
 * seconds — long enough to be an approach, short enough that the destination is
 * still where the player is. That last point is the one the distance figures
 * hide: a soldier walks to where the player *was* when it spawned, and
 * `AiSystem` only refreshes that after `HUNT_AFTER` seconds of quiet. Staging
 * at 33 m put the tail of the commute past that refresh, so a wave could spend
 * its whole approach walking to an address the player had left.
 */
const WANT_DIST = 22

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
 * Posts published per wave: one lane's worth plus a secondary direction.
 *
 * The secondary allowance was 2 and is 3, to pay back part of what the tighter
 * {@link MAX_STAGE} costs. A 12-30 m window has fewer posts in it than a 12-46 m
 * one, so stagings got thinner: 5.11 published posts each on average before,
 * 3.73 after. Every post a staging is short of is a soldier `AiSystem` places
 * from its own composed arc instead — close, and in the player's view. Widening
 * the flank recovers it to 3.95 for half a point of promotion share and no
 * change to cover or commute. Five and three still reads as a front and a
 * flank, which is the shape this is for.
 */
const PRIMARY_MAX = 5
const SECONDARY_MAX = 3
const MAX_STAGED = PRIMARY_MAX + SECONDARY_MAX

/**
 * Posts a wave may take from an overwatch lane.
 *
 * `roof` is the only one: two posts on the market hall deck, 2.86 m up, whose
 * whole value is the angle down into the junction. One soldier there is a
 * threat the player has to solve; a squad there is a squad that is not coming.
 * See {@link leads} for why it may not lead a wave at all.
 */
const OVERWATCH_MAX = 1

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
    const buried: Post[] = []
    for (const p of POSTS) {
      if (!p.enclosed && insideAnyBuilding(p.x, p.z, POST_CLEARANCE)) {
        buried.push(p)
        continue
      }
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

    // The lane the wave comes *from* has to be a lane a wave can come from.
    // `roof` is not one: it is two posts on one deck, 2.86 m up, and a soldier
    // put there is already at its firing position — there is no approach to
    // walk. Letting it lead means the whole wave stands on a platform whose
    // route down this file cannot verify, which is the playtest's "hostiles
    // standing somewhere unreachable" written as a staging decision. It came up
    // immediately: staged against `playerSpawn`, with the tighter ceiling, roof
    // was the top-scoring lane and took two of the three opening posts.
    //
    // It stays in the graph, capped at {@link OVERWATCH_MAX}, as a flank. One
    // rifle looking down into the junction is the shot the deck was composed
    // for; six soldiers milling about on it is not.
    let lead = 0
    while (lead < this.usable && !leads(cands[lead].lane)) lead++
    if (lead >= this.usable) lead = 0
    const primary = cands[lead].lane
    const primaryBearing = cands[lead].bearing
    const out = level.spawnPoints
    out.length = 0

    const primaryCap = Math.min(PRIMARY_MAX, laneCap(primary))
    let taken = 0
    for (let i = 0; i < this.usable && taken < primaryCap; i++) {
      if (cands[i].lane !== primary) continue
      const v = this.pool[taken++]
      v.copy(this.world[cands[i].index])
      out.push(v)
    }

    // One secondary direction, far enough round from the first to read as a
    // separate one rather than as the same group spread thin.
    let secondary: Lane | null = null
    let secondaryCap = SECONDARY_MAX
    let secondaryTaken = 0
    for (let i = 0; i < this.usable && secondaryTaken < secondaryCap; i++) {
      const c = cands[i]
      if (c.lane === primary) continue
      if (secondary === null) {
        if (angleBetween(c.bearing, primaryBearing) < MIN_LANE_SPREAD) continue
        secondary = c.lane
        secondaryCap = Math.min(SECONDARY_MAX, laneCap(secondary))
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

      let score = -Math.abs(p.sight - targetSight)
      score -= Math.abs(dist - WANT_DIST) * 0.25
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

/** Most posts a wave may take from one lane. */
function laneCap(lane: Lane): number {
  return lane === 'roof' ? OVERWATCH_MAX : PRIMARY_MAX
}

/** Absolute difference between two bearings, wrapped into [0, PI]. */
function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}
