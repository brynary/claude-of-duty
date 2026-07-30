import type { GameContext, System } from '../core/Types'
import type { Rand } from '../core/Rand'

/**
 * Difficulty: presets, and a bounded dynamic adjustment on top of them.
 *
 * This module owns no entities and mutates nothing outside itself. It is a
 * table of numbers plus a policy for nudging them, and every other system reads
 * from it. That is deliberate: difficulty that lives scattered across the AI,
 * the weapons and the player controller cannot be reasoned about, and cannot be
 * reported at the end of a run.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SOURCED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * `.ai/FEEL_TARGET.md` §7.6 `[measured]` establishes that Call of Duty's
 * presets move exactly three variables: **enemy accuracy, damage dealt to the
 * player, and the player's health pool**. That shape is reproduced here and no
 * fourth variable was invented — notably `maxAttackers` stays at 2 on every
 * preset, because §7.2 `[stated]` gives `ai_maxAttackerCount "2"` as an engine
 * constant and nothing suggests the presets touch it.
 *
 * The *magnitudes* are not sourced. §9 states plainly: "Numeric difficulty
 * multipliers for Recruit / Regular / Hardened / Veteran / Realism — the dvars
 * the presets scale are known; the scaling factors are not." The ladder in
 * §7.6 is labelled by the research itself as constructed, not measured. The
 * ladder below is therefore also `[estimated]`, but it is derived from a stated
 * anchor rather than picked by feel — see PRESETS.
 *
 * The dynamic component is **not a reproduction of anything**. Call of Duty
 * ships no visible dynamic difficulty. This part is original design, and it is
 * built defensively: see the ASSIST section for why the bounds are where they
 * are.
 */

// ---------------------------------------------------------------------------
// Sourced constants — the Regular baseline everything else is relative to
// ---------------------------------------------------------------------------

/**
 * The CoD5 AI accuracy model, complete. `[stated]`, FEEL_TARGET §7.1:
 * `ai_playerNearAccuracy 0.5`, `ai_playerNearRange 800u = 20.32 m`,
 * `ai_playerFarAccuracy 0.1`, `ai_playerFarRange 2000u = 50.8 m`.
 *
 * Hit chance against the player is an explicit dice roll, separate from where
 * the AI is aiming, interpolating 50% at 20 m down to 10% at 51 m. Shots that
 * lose the roll are deliberately deflected.
 */
export const BASE_NEAR_ACCURACY = 0.5
export const BASE_FAR_ACCURACY = 0.1
export const BASE_NEAR_RANGE = 20.32
export const BASE_FAR_RANGE = 50.8

/**
 * `[stated]`, FEEL_TARGET §7.5: Black Ops `sv_botMinReactionTime 500` /
 * `sv_botMaxReactionTime 1000` — sighting to first shot. This is the only
 * published reaction-time figure in the series and it is deliberately slower
 * than the 200-350 ms player TTK, which is what makes the player the
 * protagonist rather than the prey.
 */
export const BASE_REACTION_MIN = 0.5
export const BASE_REACTION_MAX = 1.0

/**
 * `[stated]`, FEEL_TARGET §1 and §5.1: `scr_player_maxhealth "100"`, unchanged
 * from the classic engine through MW2019, MWII and BO6. MWIII's 150 is the
 * outlier and was widely disliked.
 */
export const BASE_PLAYER_HEALTH = 100

/**
 * `[stated]`, FEEL_TARGET §7.2: `ai_maxAttackerCount "2"`. Only two AI shoot at
 * the player at once regardless of how many are present. The research calls
 * this "the single most important AI constant" and the reason a firefight with
 * a dozen enemies on screen stays survivable.
 *
 * It is exported as a constant rather than a per-preset field on purpose:
 * §7.6 does not list attacker count among the things presets change, and
 * varying it would change the *shape* of a firefight rather than its
 * lethality.
 */
export const MAX_ATTACKERS = 2

/**
 * Reference cadence for the incoming-damage estimate reported by `snapshot()`.
 *
 * These are the *defaults*; `AiSystem.init` overwrites them through
 * `setAttackerCadence` with `Behaviour.AI_CADENCE`, and they are kept equal to
 * what it passes so an un-wired instance reports the same figure a wired one
 * does. They used to read 3.3 rounds/s and 6.75 HP a round — the cadence this
 * file was written against, three times what the AI now delivers — which is how
 * the preset table below came to advertise a Regular time-to-die of 4.5 s while
 * the running code reported 18.9 s.
 *
 * `[measured]` from `src/ai/Behaviour.ts`: five rounds at 0.105 s inside a
 * 0.4-0.6 s burst, then a 1.6-2.6 s pause, times an `exposedFraction` of 0.55
 * for the part of the cycle a token holder is out of cover and not reloading.
 * Damage per round is `PLAYER_DAMAGE` 5.0, flat.
 *
 * Nothing in this module *applies* these. They exist only so the reported
 * threat figures are numbers a designer can read rather than a shrug.
 */
const DEFAULT_ROUNDS_PER_SEC = 1.058
const DEFAULT_DAMAGE_PER_HIT = 5.0
/** Distance the threat estimates are quoted at: the measured mean engagement
 * distance of the current build (19-22 m across both scripted runs), which sits
 * inside the 10-30 m target band of FEEL_TARGET §6.3. Just inside
 * {@link BASE_NEAR_RANGE}, so the quoted figures are near-range figures. */
const REFERENCE_DISTANCE = 20

/**
 * The player's health regeneration, `[stated]` FEEL_TARGET §5.2 from the MWIII
 * Season 2 patch notes: regeneration begins **3 s** after the last hit and
 * restores **75 HP/s**.
 *
 * `PlayerSystem` owns these and applies them; they are mirrored here, read-only,
 * because **they, and not any number in this file, decide whether the player can
 * die.** 75 HP/s refills the whole bar in 1.34 s, so incoming fire only counts
 * if it arrives with no 3 s gap in it. A difficulty model that reports lethality
 * as damage-per-second and stops there will describe a game that cannot kill
 * anyone as dangerous — which is exactly what this one did. See
 * {@link DifficultySnapshot.damagePerRegenWindow}.
 *
 * Only the delay is needed here; the 75 HP/s appears nowhere in the arithmetic
 * because at that rate the refill is effectively instant against everything else
 * in this file.
 */
const REGEN_DELAY = 3.0

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type DifficultyPreset = 'recruit' | 'regular' | 'hardened' | 'veteran'

export const PRESET_ORDER: readonly DifficultyPreset[] = ['recruit', 'regular', 'hardened', 'veteran']

export interface PresetValues {
  readonly id: DifficultyPreset
  readonly label: string
  /** The in-game description from FEEL_TARGET §7.6, kept so the intent of each
   * row is visible next to its numbers. */
  readonly blurb: string

  /**
   * Multiplier on `ai_playerNearAccuracy` / `ai_playerFarAccuracy`.
   * Range across presets: 0.50 - 1.45. Regular is 1.00 by definition.
   */
  readonly accuracyScale: number
  /**
   * Multiplier on damage the AI deals to the player. Range: 0.70 - 1.60.
   * This scales the AI weapon's player-damage value, which FEEL_TARGET §7.6
   * `[measured]` notes is a separate field from the damage AI deal each other.
   */
  readonly damageScale: number
  /**
   * Multiplier on the player's 100 HP pool. Range: 0.80 - 1.20.
   *
   * Kept deliberately narrow. 100 HP is the constant the whole feel target is
   * calibrated against — enemy shots-to-kill, regen rate and the HUD's
   * low-health threshold all assume it. Moving it far would silently
   * invalidate those. Lethality is expressed through accuracy and damage,
   * which are cheap to move; health does the smallest share of the work.
   */
  readonly healthScale: number
  /**
   * Multiplier on the stated 500-1000 ms reaction window. Range: 0.60 - 1.70.
   *
   * Veteran floors at 0.60 (300-600 ms) rather than §7.6's guessed 200-400 ms.
   * FEEL_TARGET §7.5 makes the case explicitly: the published 500-1000 ms is
   * slower than the player's 200-350 ms TTK *by design*, and that asymmetry is
   * "the reason CoD combat feels aggressive rather than defensive". A 200 ms
   * reaction erases it and turns Veteran into a reflex coin-flip rather than a
   * harder version of the same game.
   */
  readonly reactionScale: number
}

/**
 * The ladder.
 *
 * Effective lethality is `accuracyScale x damageScale / healthScale`, so the
 * three columns compound. §7.6's guessed ladder does not appear to have
 * accounted for that: its Veteran row (0.85 near accuracy, 2.5x damage, "very
 * low health") multiplies out to roughly 4-5x Regular's lethality. This ladder
 * targets a 3.0x spread instead.
 *
 * All four rows are `[estimated]`. Only the Regular *baseline* they are built
 * around (0.5/0.1 accuracy, 500-1000 ms reaction, 100 HP) is `[stated]`, and
 * Regular is 1.00 on all three columns by definition rather than by taste.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH ROW ACTUALLY DELIVERS, AND WHY THE SECOND COLUMN IS THE REAL ONE
 * ---------------------------------------------------------------------------
 *
 * Both figures are at {@link REFERENCE_DISTANCE} against the two-attacker clamp
 * with the AI's real cadence, which is what `effective()` reports:
 *
 * | preset   | lethality | unbroken exposure to die | health lost per 3 s |
 * |----------|-----------|--------------------------|---------------------|
 * | Recruit  | 0.29x     | 64.8 s                   | 4.6%                |
 * | Regular  | 1.00x     | 18.9 s                   | 15.9%               |
 * | Hardened | 1.73x     | 10.9 s                   | 27.5%               |
 * | Veteran  | 2.90x     | 6.5 s                    | 46.0%               |
 *
 * The first column is a fiction and the last one is the truth, because of
 * {@link REGEN_DELAY}: a gap of 3 s in the incoming fire hands the whole bar
 * back at 75 HP/s. "18.9 s to die" is only reachable if none of those 18.9
 * seconds contains a 3 s lull.
 *
 * **Measured, none of them do.** Across the two 90 s scripted runs of
 * 2026-07-28, with the camera bug fixed and the player aiming properly:
 *
 *   - the player took damage in **12 of 90 s** (push) and **5 of 90 s** (hold);
 *   - the longest run of consecutive damaging seconds was **2** and **1**;
 *   - the worst 3 s window cost **15.5** and **15.8 HP** of a 100 HP pool;
 *   - total damage taken was 87.5 and 46.7 HP, and **deaths were zero**.
 *
 * Read the third line against the table: Regular's modelled 15.9% per 3 s and
 * the measured 15.5-15.8 HP peak are the *same number*. **The preset values are
 * not wrong. The exposure is not continuous.** Every hit is followed by a gap
 * longer than the regen delay, so nothing accumulates and the player is
 * restored to full after every exchange. Veteran, at 46% of the bar per 3 s,
 * would not kill this player either — three isolated spurts a minute apart are
 * three isolated spurts whatever each one is worth.
 *
 * So do not raise these numbers to chase deaths. Every one of Regular's three
 * is `[stated]`, and inflating them to compensate for a duty cycle set in
 * `src/ai/Behaviour.ts` would have to be unpicked the moment that is fixed.
 * The deficit is there: `AI_CADENCE.exposedFraction` claims a token holder is
 * firing 55% of the time, and the damage that reached the player implies at
 * most 22%. That is the number to move.
 */
export const PRESETS: Readonly<Record<DifficultyPreset, PresetValues>> = {
  // lethality 0.29x Regular -> 64.8 s of unbroken exposure, 4.6% of the bar per 3 s
  recruit: {
    id: 'recruit',
    label: 'Recruit',
    blurb: 'For players new to first person action games.',
    accuracyScale: 0.5,
    damageScale: 0.7,
    healthScale: 1.2,
    reactionScale: 1.7,
  },
  // the baseline: 0.5 near / 0.1 far accuracy, 100 HP, 500-1000 ms reaction
  // lethality 1.00x -> 18.9 s of unbroken exposure, 15.9% of the bar per 3 s
  regular: {
    id: 'regular',
    label: 'Regular',
    blurb: 'Your abilities in combat will be tested.',
    accuracyScale: 1.0,
    damageScale: 1.0,
    healthScale: 1.0,
    reactionScale: 1.0,
  },
  // lethality 1.73x -> 10.9 s of unbroken exposure, 27.5% of the bar per 3 s
  hardened: {
    id: 'hardened',
    label: 'Hardened',
    blurb: 'Your skills will be strained.',
    accuracyScale: 1.2,
    damageScale: 1.3,
    healthScale: 0.9,
    reactionScale: 0.76,
  },
  // lethality 2.90x -> 6.5 s of unbroken exposure, 46.0% of the bar per 3 s
  veteran: {
    id: 'veteran',
    label: 'Veteran',
    blurb: 'You will not survive.',
    accuracyScale: 1.45,
    damageScale: 1.6,
    healthScale: 0.8,
    reactionScale: 0.6,
  },
}

/**
 * Ceiling on the hit-chance roll after every multiplier. Veteran reaches 0.725
 * near accuracy; this only bites if the dynamic assist pushes it further. An
 * enemy that hits nine times out of ten is not a difficulty setting, it is a
 * wall.
 */
const HIT_CHANCE_CEILING = 0.9

// ---------------------------------------------------------------------------
// The dynamic assist
// ---------------------------------------------------------------------------

/**
 * Call of Duty does not ship visible dynamic difficulty. Everything below is
 * design, not reproduction, and it is designed around two failure modes that
 * are both worse than having no system at all:
 *
 *   1. **Silently making the game easy.** A player who cannot tell the game
 *      stopped resisting has had the win taken from them. Hence a hard cap on
 *      how far easing can go, and `snapshot()` so a run can always report what
 *      was actually applied.
 *
 *   2. **Punishing a player for doing well.** Strictly worse than (1), so the
 *      hardening band is deliberately narrower than the easing band and it
 *      moves roughly three times more slowly.
 *
 * There is a third hazard specific to this project. Two of the four input
 * signals — player accuracy and kill duration — are dominated by *weapon*
 * tuning, not by difficulty, so a build with a broken weapon reads as a
 * drowning player and a naive controller would pin itself at maximum assistance
 * and quietly mask the bug. That is not hypothetical: the round measured at
 * 5.4% accuracy and 1.47 s kill duration turned out to be a camera that could
 * not turn, not a difficulty that was too high. Two defences: the outcome
 * signals (deaths, damage taken) carry 70% of the weight and the process signals
 * only 30%; and `pinnedFor` reports how long the assist has sat against a bound,
 * which a harness run should treat as "something upstream is wrong, do not trust
 * this run's difficulty numbers".
 *
 * With the camera fixed the same runs read 33-40% accuracy and 0.97 s, both
 * healthy, and the controller finally has real evidence to work from: **zero
 * deaths across two 90 s runs.** That is what it is for, and what the band
 * sizing below is now calibrated against.
 */

/** Signed assist. Negative eases the game, positive hardens it. */
const ASSIST_MIN = -1
const ASSIST_MAX = 1

/**
 * Per-variable bands at full assist.
 *
 * **Size these against the assist the controller can reach, not against ±1.**
 * That is the mistake the previous version made and it cost the whole system its
 * usefulness. `recomputeTarget` only returns ±1 when all four signals sit at
 * their extremes at once, and the two directions are not equally able to do
 * that: a drowning player trips all four together and reaches about **-0.87**,
 * while a dominating player gets nothing from the accuracy signal — 33-40% is
 * *healthy*, it scores zero — and tops out around **+0.55**. The deadband
 * rescale then takes 20 points off both.
 *
 * Measured against the two 90 s runs of 2026-07-28, the first runs where the
 * player could actually aim: zero deaths, 0.05-0.15 of the health pool lost per
 * engagement — far below the band — and the controller read that correctly and
 * settled at about **+0.35 to +0.45**. With the old 0.06 bands that expressed
 * itself as **1.03x to 1.05x lethality**, which is indistinguishable from
 * nothing. The system detected the problem the brief describes and then had no
 * way to say so.
 *
 * With the bands below, the same evidence produces **1.11x to 1.18x**, and the
 * ±1 bounds — which are what actually caps the system — sit at:
 *
 * | direction | at the bound | reachable in practice |
 * | --- | --- | --- |
 * | harden | 1.32x (half a preset step) | ~+0.5, so ~1.15x |
 * | ease | 0.76x (a third of a step down) | ~-0.87, so ~0.79x |
 *
 * A player on Regular therefore never silently receives Hardened (1.73x) or
 * Recruit (0.29x), which is the property that matters. The residual asymmetry
 * favours the player, which is the correct direction, and the larger asymmetry
 * is still in the *rates* below where it is a stated decision.
 */
const EASE_ACCURACY_BAND = 0.12 // hit chance x0.88 at the -1 bound
const HARDEN_ACCURACY_BAND = 0.15 // x1.10 at the reachable +0.65, x1.15 at +1
const EASE_DAMAGE_BAND = 0.14 // damage x0.86 at the -1 bound
const HARDEN_DAMAGE_BAND = 0.15 // x1.10 at +0.65, x1.15 at +1
const EASE_REACTION_BAND = 0.1 // enemies react 10% slower
/** 8%: 500-1000 ms becomes 474-948 ms at +0.65, 460-920 ms at +1. Both still
 * inside the spirit of the `[stated]` window, which is the constraint — §7.5's
 * whole point is that the AI reacts slower than the player kills. */
const HARDEN_REACTION_BAND = 0.08

/**
 * Health is never touched dynamically. Changing the player's maximum health
 * mid-run is visible in the HUD, changes the meaning of every regen number,
 * and is exactly the kind of invisible-until-it-isn't intervention that makes
 * players distrust a game.
 */

/** Assist units per second while easing. Full swing in 10 s: a player who is
 * dying repeatedly needs help now, not in half a minute. */
const EASE_RATE = 0.1
/** Assist units per second while hardening. Full swing in ~29 s. */
const HARDEN_RATE = 0.035
/** Assist units per second drifting back to the preset when evidence is stale. */
const NEUTRAL_DECAY = 0.02
/** Seconds without a resolved engagement before the assist starts decaying. */
const EVIDENCE_TIMEOUT = 20

/** No adjustment at all until both are satisfied. One bad ambush is not data. */
const GRACE_SECONDS = 30
const MIN_EPISODES = 3

/**
 * Seconds an episode may stay open with nobody holding contact and nothing
 * happening before it is closed anyway.
 *
 * This is a guard, not a feature. `Behaviour.update` returns early when its
 * soldier is dead, before `updatePerception` runs, so a soldier killed while
 * holding contact never emits its `ai:lostContact`. Contact is therefore
 * tracked by id and cleared on `entity:killed` as well; this timeout covers the
 * remaining case of an episode opened by an ambush (`player:damaged` with no
 * recorded contact at all) that no contact event will ever close.
 */
const EPISODE_QUIET_TIMEOUT = 4

/** Weighted score below this is treated as zero, so ordinary variance in a
 * six-fight window does not make the game wobble. */
const DEADBAND = 0.2

/** Engagements kept in the rolling window. Six is about two minutes of play at
 * the target pacing of one engagement every 25-45 s (§6.1) — long enough to be
 * evidence, short enough to still be "recently". */
const WINDOW = 6

/**
 * Healthy bands for each signal. Inside the band the signal says nothing.
 * `spanLo` / `spanHi` are how far past each edge produces a full-strength
 * contribution.
 *
 * The two spans differ per signal because three of these four quantities are
 * bounded below by zero and unbounded above. A single shared span would have
 * made the "player is dominating" side unreachable — with one span the harden
 * direction saturated at 45% of its nominal range purely as an arithmetic
 * artefact. The asymmetry between easing and hardening belongs in the bands and
 * rates below, where it is a stated decision, not hidden in here.
 *
 * Reaching either bound requires all four signals to agree at their extreme.
 * Any one signal can move the assist by at most its own weight.
 *
 * Bands, and where they come from:
 *
 *   deaths per engagement  [0.083, 0.25]  one death per 4 to 12 engagements.
 *     `[estimated]`. Fewer than one in twelve and nothing is at stake; more
 *     than one in four and the player is losing more fights than FEEL_TARGET
 *     §7.5's protagonist asymmetry implies they should. Deliberately expressed
 *     per engagement rather than per minute: deaths/minute is jointly set by
 *     lethality and by how often fights happen, and pacing is not difficulty's
 *     to fix.
 *   damage per engagement  [0.20, 0.55]  fraction of the health pool.
 *     `[estimated]` from the same anchor as the preset ladder: a 1-1.5 s
 *     exchange against two attackers costs 25-40% of the bar, widened for solo
 *     attackers and longer fights.
 *   accuracy               [0.18, 0.45]  the harness target, from FEEL_TARGET
 *     §3.6 `[stated]`: ADS spread is exactly zero on every weapon inspected.
 *   kill duration          [0.80, 2.20]  the harness target. See below — this
 *     band was wrong, and wrong in the direction that mattered.
 */
const DEATHS_PER_ENGAGEMENT = { lo: 0.083, hi: 0.25, spanLo: 0.083, spanHi: 0.25 }
const DAMAGE_FRACTION = { lo: 0.2, hi: 0.55, spanLo: 0.2, spanHi: 0.35 }
const ACCURACY = { lo: 0.18, hi: 0.45, spanLo: 0.18, spanHi: 0.2 }
/**
 * Kill duration: **first damaging hit to the enemy's death**, which is what
 * `PerformanceWindow.timeToKill` accumulates and is not the same quantity as
 * FEEL_TARGET §2.1's time-to-kill.
 *
 * §2.1's 200-300 ms is the weapon's burst time with every round on target. This
 * is a whole engagement: it contains the misses, so it is dominated by accuracy
 * and it *rises* when the weapon gets better at any fixed hit rate. The harness
 * knows this — `tools/analyze-play.mjs` calls the metric `killDuration`, targets
 * it at **0.8-2.2 s**, and carries a note that labelling it "time to kill" and
 * reading it against 200-300 ms "framed an accuracy problem as a weapon
 * problem". This file then made the identical mistake one layer down.
 *
 * The consequence was not cosmetic. Both 90 s runs of 2026-07-28 measured 0.97
 * and 0.98 s — healthy, mid-band. Against the old `hi` of 0.35 with a 0.3 span
 * that saturates the score at a **full-strength** vote for easing, so every run
 * where the game was working spent a tenth of its weight arguing the player was
 * drowning. With deaths and damage both pointing the other way it did not flip
 * the sign, but it cancelled a quarter of the hardening the evidence supported.
 *
 * Spans: full strength at 0.3 s below and 3.7 s above, the latter chosen against
 * the harness's own 4.0 s ceiling on worst-case kill duration.
 */
const TTK = { lo: 0.8, hi: 2.2, spanLo: 0.5, spanHi: 1.5 }

const W_DEATHS = 0.4
const W_DAMAGE = 0.3
const W_ACCURACY = 0.2
const W_TTK = 0.1

// ---------------------------------------------------------------------------
// Reported state
// ---------------------------------------------------------------------------

/** What the rolling window currently believes about the player. */
export interface PerformanceWindow {
  /** Resolved engagements in the window. An engagement here is one *contact
   * episode* — from the first enemy acquiring the player to the last one
   * losing them — not one per enemy. Telemetry counts per enemy, so its
   * engagement count will be higher; the two are not comparable. */
  episodes: number
  deathsPerEngagement: number | null
  /** Damage taken per engagement as a fraction of maximum health. */
  damageFractionPerEngagement: number | null
  accuracy: number | null
  /** Mean seconds from first damaging hit to the enemy dying. */
  timeToKill: number | null
}

/** Everything the difficulty system is currently applying. */
export interface DifficultySnapshot {
  preset: DifficultyPreset
  label: string

  /** Probability a shot at or inside 20.32 m is allowed to land. */
  hitChanceNear: number
  /** Probability at or beyond 50.8 m. */
  hitChanceFar: number
  /** Multiplier on the AI's aim cone half-angle. */
  aimErrorScale: number
  /** Multiplier on damage the AI deals to the player. */
  damageToPlayerScale: number
  playerMaxHealth: number
  reactionMin: number
  reactionMax: number
  maxAttackers: number

  /** -1 (fully eased) to +1 (fully hardened). 0 is the pure preset. */
  assist: number
  /** True while the assist is sitting against either bound. */
  atBound: boolean
  /** Seconds the assist has been continuously against a bound. Sustained
   * non-zero here means a signal outside difficulty's control is broken. */
  pinnedFor: number
  /** False during the grace period, when the preset is applied untouched. */
  active: boolean

  window: PerformanceWindow

  /** Combined accuracy x damage / health, relative to Regular with no assist.
   * The one number to read if you only read one. */
  lethalityVsRegular: number
  /**
   * Seconds of **unbroken** fire from `maxAttackers` at {@link REFERENCE_DISTANCE}
   * needed to kill the player, using the cadence in `setAttackerCadence`.
   *
   * An estimate, not a measurement, and an optimistic one: it is the answer only
   * if no 3 s gap ever opens in those seconds. Read
   * {@link damagePerRegenWindow} alongside it or do not read it at all.
   */
  estimatedTimeToDie: number
  /**
   * Fraction of the health pool that same exposure removes inside one
   * {@link REGEN_DELAY} — the most the player can lose before the regen clock
   * resets and 75 HP/s puts the bar back in 1.34 s.
   *
   * **This is the honest lethality figure.** Under 1.0 means no single burst of
   * exposure can kill, so the player dies only to fire that stays unbroken for
   * `estimatedTimeToDie`. Regular sits at 0.16, and the two scripted runs of
   * 2026-07-28 confirm the arithmetic from the other end: their worst 3 s
   * windows cost 15.5 and 15.8 HP against the 15.9 predicted here, and neither
   * run produced a death, because no two damaging seconds ever landed close
   * enough together to compound.
   */
  damagePerRegenWindow: number
}

// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

interface Band {
  readonly lo: number
  readonly hi: number
  readonly spanLo: number
  readonly spanHi: number
}

/**
 * 0 inside [lo, hi]; grows to +1 as x rises `spanHi` past `hi`; falls to -1 as
 * x drops `spanLo` below `lo`. The caller decides which direction means "the
 * player is struggling".
 */
function bandScore(x: number, b: Band): number {
  if (x > b.hi) return clamp((x - b.hi) / b.spanHi, 0, 1)
  if (x < b.lo) return -clamp((b.lo - x) / b.spanLo, 0, 1)
  return 0
}

/** One contact episode, accumulated live. Reused; never reallocated. */
interface Episode {
  damageTaken: number
  shotsFired: number
  hits: number
  kills: number
  ttkSum: number
  ttkCount: number
  died: boolean
}

/**
 * The difficulty model.
 *
 * Conforms to `System` so it can be registered with the Engine in one line, but
 * does not require it: an instance that is never `init`ed still reports its
 * preset correctly with `assist` pinned at 0. That is intentional — the presets
 * must be readable by every other system without anyone having to edit
 * `main.ts` first.
 */
export class DifficultySystem implements System {
  readonly name = 'difficulty'

  private preset: DifficultyPreset = 'regular'

  private assist = 0
  private assistTarget = 0
  private elapsed = 0
  private pinnedFor = 0
  private lastEpisodeAt = 0
  private attached = false

  // Rolling window, stored as parallel primitive arrays so that closing an
  // engagement never allocates.
  private readonly wDamage = new Float64Array(WINDOW)
  private readonly wShots = new Float64Array(WINDOW)
  private readonly wHits = new Float64Array(WINDOW)
  private readonly wTtkSum = new Float64Array(WINDOW)
  private readonly wTtkCount = new Float64Array(WINDOW)
  private readonly wDied = new Float64Array(WINDOW)
  private wIndex = 0
  private wCount = 0

  private readonly live: Episode = {
    damageTaken: 0, shotsFired: 0, hits: 0, kills: 0, ttkSum: 0, ttkCount: 0, died: false,
  }
  private episodeOpen = false
  private episodeQuietFor = 0
  /** Ids currently holding contact. A set rather than a counter because a
   * soldier killed mid-contact never emits its matching `ai:lostContact`. */
  private readonly contacts = new Set<number>()
  /** Per-enemy time of the player's first damaging hit, for time-to-kill. */
  private readonly firstHitAt = new Map<number, number>()

  // Cadence used only for the reported time-to-die estimate.
  private roundsPerSec = DEFAULT_ROUNDS_PER_SEC
  private damagePerHit = DEFAULT_DAMAGE_PER_HIT

  /** Reused by `effective()`; see the note on that method. */
  private readonly out: DifficultySnapshot = {
    preset: 'regular', label: 'Regular',
    hitChanceNear: 0, hitChanceFar: 0, aimErrorScale: 1, damageToPlayerScale: 1,
    playerMaxHealth: BASE_PLAYER_HEALTH, reactionMin: 0, reactionMax: 0, maxAttackers: MAX_ATTACKERS,
    assist: 0, atBound: false, pinnedFor: 0, active: false,
    window: { episodes: 0, deathsPerEngagement: null, damageFractionPerEngagement: null, accuracy: null, timeToKill: null },
    lethalityVsRegular: 1, estimatedTimeToDie: 0, damagePerRegenWindow: 0,
  }

  constructor(preset: DifficultyPreset = 'regular') {
    this.preset = preset
  }

  // --- configuration -------------------------------------------------------

  setPreset(preset: DifficultyPreset): void {
    if (preset === this.preset) return
    this.preset = preset
    this.reset()
  }

  currentPreset(): DifficultyPreset {
    return this.preset
  }

  /** Keeps `estimatedTimeToDie` honest when the AI's firing cadence changes. */
  setAttackerCadence(roundsPerSecond: number, meanDamagePerHit: number): void {
    this.roundsPerSec = Math.max(0.01, roundsPerSecond)
    this.damagePerHit = Math.max(0.01, meanDamagePerHit)
  }

  /** Clears the rolling window and returns the assist to the pure preset. */
  reset(): void {
    this.assist = 0
    this.assistTarget = 0
    this.pinnedFor = 0
    this.lastEpisodeAt = this.elapsed
    this.wIndex = 0
    this.wCount = 0
    this.wDamage.fill(0)
    this.wShots.fill(0)
    this.wHits.fill(0)
    this.wTtkSum.fill(0)
    this.wTtkCount.fill(0)
    this.wDied.fill(0)
    this.clearLive()
    this.episodeOpen = false
    this.episodeQuietFor = 0
    this.contacts.clear()
    this.firstHitAt.clear()
  }

  // --- the values other systems read ---------------------------------------

  /**
   * Probability that a shot at this distance is allowed to damage the player.
   *
   * This is CoD's model exactly (§7.1): an explicit dice roll, separate from
   * where the AI is aiming. The intended call order is **roll first, aim
   * second** — decide whether the round lands, then place the tracer to match,
   * deflecting the ones that lost the roll. The `ai:shot` event in
   * `core/Events.ts` already carries `willHit`, which is that decision.
   *
   * Rolling after the geometry instead would multiply two probabilities
   * together and land well under the target curve.
   *
   * Pure arithmetic; safe to call per shot.
   */
  hitChance(distance: number): number {
    const p = PRESETS[this.preset]
    const scale = p.accuracyScale * (1 + this.assistBand(EASE_ACCURACY_BAND, HARDEN_ACCURACY_BAND))
    const near = BASE_NEAR_ACCURACY * scale
    const far = BASE_FAR_ACCURACY * scale
    let v: number
    if (distance <= BASE_NEAR_RANGE) v = near
    else if (distance >= BASE_FAR_RANGE) v = far
    else v = near + (far - near) * ((distance - BASE_NEAR_RANGE) / (BASE_FAR_RANGE - BASE_NEAR_RANGE))
    return clamp(v, 0, HIT_CHANCE_CEILING)
  }

  /** Seeded convenience wrapper. Never uses `Math.random`. */
  rollHit(distance: number, rng: Rand): boolean {
    return rng.next() < this.hitChance(distance)
  }

  /**
   * Multiplier on the AI's aim-cone half-angle.
   *
   * Distinct from `hitChance` and doing a different job: the cone decides
   * *where* a round goes — the tracer, the near-miss crack, the impact decal —
   * while `hitChance` decides whether it is allowed to land. Widening it on
   * Recruit makes misses look wild; tightening it on Veteran makes them look
   * ranged-in. Derived from `accuracyScale` so there is one lever, not two.
   */
  aimErrorScale(): number {
    const p = PRESETS[this.preset]
    const scale = p.accuracyScale * (1 + this.assistBand(EASE_ACCURACY_BAND, HARDEN_ACCURACY_BAND))
    return 1 / clamp(scale, 0.3, 3)
  }

  /** Multiplier on damage the AI deals to the player. */
  damageToPlayerScale(): number {
    const p = PRESETS[this.preset]
    return p.damageScale * (1 + this.assistBand(EASE_DAMAGE_BAND, HARDEN_DAMAGE_BAND))
  }

  /** The player's health pool. Never moved by the dynamic assist. */
  playerMaxHealth(): number {
    return BASE_PLAYER_HEALTH * PRESETS[this.preset].healthScale
  }

  /** Lower bound of the sighting-to-first-shot window, in seconds. */
  reactionMin(): number {
    return BASE_REACTION_MIN * this.reactionScale()
  }

  /** Upper bound of the sighting-to-first-shot window, in seconds. */
  reactionMax(): number {
    return BASE_REACTION_MAX * this.reactionScale()
  }

  /** A reaction time drawn from the current window, deterministically. */
  sampleReactionTime(rng: Rand): number {
    return rng.range(this.reactionMin(), this.reactionMax())
  }

  /** `ai_maxAttackerCount`. Constant across presets; see MAX_ATTACKERS. */
  maxAttackers(): number {
    return MAX_ATTACKERS
  }

  private reactionScale(): number {
    const p = PRESETS[this.preset]
    return p.reactionScale * (1 - this.assistBand(EASE_REACTION_BAND, HARDEN_REACTION_BAND))
  }

  /**
   * Maps the signed assist onto a per-variable band. Easing and hardening get
   * different bands, so the bounds are structural rather than checked.
   */
  private assistBand(easeBand: number, hardenBand: number): number {
    return this.assist < 0 ? this.assist * easeBand : this.assist * hardenBand
  }

  // --- reporting -----------------------------------------------------------

  /**
   * The current effective values, in a reused object. Cheap enough for a HUD or
   * a debug overlay to call every frame; the returned reference is overwritten
   * on the next call, so do not retain it. Use `snapshot()` for anything kept.
   */
  effective(): Readonly<DifficultySnapshot> {
    const p = PRESETS[this.preset]
    const o = this.out
    o.preset = this.preset
    o.label = p.label
    o.hitChanceNear = this.hitChance(0)
    o.hitChanceFar = this.hitChance(BASE_FAR_RANGE)
    o.aimErrorScale = this.aimErrorScale()
    o.damageToPlayerScale = this.damageToPlayerScale()
    o.playerMaxHealth = this.playerMaxHealth()
    o.reactionMin = this.reactionMin()
    o.reactionMax = this.reactionMax()
    o.maxAttackers = MAX_ATTACKERS
    o.assist = this.assist
    o.atBound = this.assist <= ASSIST_MIN + 1e-3 || this.assist >= ASSIST_MAX - 1e-3
    o.pinnedFor = this.pinnedFor
    o.active = this.assistActive()

    this.fillWindow(o.window)

    const lethality = (o.hitChanceNear / BASE_NEAR_ACCURACY) * o.damageToPlayerScale
    o.lethalityVsRegular = lethality / p.healthScale
    const dps = MAX_ATTACKERS * this.roundsPerSec * this.hitChance(REFERENCE_DISTANCE)
      * this.damagePerHit * o.damageToPlayerScale
    o.estimatedTimeToDie = dps > 0 ? o.playerMaxHealth / dps : Infinity
    o.damagePerRegenWindow = (dps * REGEN_DELAY) / o.playerMaxHealth
    return o
  }

  /** A detached copy, for logging at the end of a run. Allocates. */
  snapshot(): DifficultySnapshot {
    const e = this.effective()
    return { ...e, window: { ...e.window } }
  }

  /** One line, for a harness log or an on-screen readout. */
  describe(): string {
    const e = this.effective()
    const dir = e.assist === 0 ? 'neutral' : e.assist < 0 ? 'easing' : 'hardening'
    return (
      `${e.label} | hit ${e.hitChanceNear.toFixed(2)}@near ${e.hitChanceFar.toFixed(2)}@far` +
      ` | dmg x${e.damageToPlayerScale.toFixed(2)} | hp ${e.playerMaxHealth.toFixed(0)}` +
      ` | react ${(e.reactionMin * 1000).toFixed(0)}-${(e.reactionMax * 1000).toFixed(0)}ms` +
      ` | assist ${e.assist >= 0 ? '+' : ''}${e.assist.toFixed(2)} (${dir}` +
      `${e.active ? '' : ', grace'}${e.pinnedFor > 0 ? `, pinned ${e.pinnedFor.toFixed(0)}s` : ''})` +
      ` | lethality x${e.lethalityVsRegular.toFixed(2)} | ttd ${e.estimatedTimeToDie.toFixed(1)}s` +
      ` unbroken, ${(e.damagePerRegenWindow * 100).toFixed(0)}%/3s` +
      ` | n=${e.window.episodes}`
    )
  }

  private fillWindow(w: PerformanceWindow): void {
    const n = this.wCount
    w.episodes = n
    if (n === 0) {
      w.deathsPerEngagement = null
      w.damageFractionPerEngagement = null
      w.accuracy = null
      w.timeToKill = null
      return
    }
    let damage = 0
    let shots = 0
    let hits = 0
    let ttkSum = 0
    let ttkCount = 0
    let died = 0
    for (let i = 0; i < n; i++) {
      damage += this.wDamage[i]
      shots += this.wShots[i]
      hits += this.wHits[i]
      ttkSum += this.wTtkSum[i]
      ttkCount += this.wTtkCount[i]
      died += this.wDied[i]
    }
    const maxHealth = this.playerMaxHealth()
    w.deathsPerEngagement = died / n
    w.damageFractionPerEngagement = damage / n / maxHealth
    w.accuracy = shots > 0 ? hits / shots : null
    w.timeToKill = ttkCount > 0 ? ttkSum / ttkCount : null
  }

  // --- System --------------------------------------------------------------

  /**
   * Subscribing here is the only thing `init` does. It reads no services and
   * writes to no other system, so it is order-independent with respect to every
   * other `init` in the engine.
   */
  init(ctx: GameContext): void {
    if (this.attached) return
    this.attached = true
    const e = ctx.events

    e.on('ai:contact', (p) => {
      this.contacts.add(p.id)
      this.openEpisode()
    })

    e.on('ai:lostContact', (p) => {
      this.contacts.delete(p.id)
      if (this.contacts.size === 0 && this.episodeOpen) this.closeEpisode()
    })

    e.on('weapon:fired', () => {
      if (this.episodeOpen) {
        this.live.shotsFired++
        this.episodeQuietFor = 0
      }
    })

    e.on('damage:dealt', (p) => {
      if (p.target.team !== 'enemy') return
      if (this.episodeOpen) {
        this.live.hits++
        this.episodeQuietFor = 0
      }
      if (!this.firstHitAt.has(p.target.id)) this.firstHitAt.set(p.target.id, ctx.elapsed)
    })

    e.on('entity:killed', (p) => {
      if (p.entity.team !== 'enemy') return
      const first = this.firstHitAt.get(p.entity.id)
      this.firstHitAt.delete(p.entity.id)
      if (this.episodeOpen) {
        this.live.kills++
        this.episodeQuietFor = 0
        if (first !== undefined) {
          this.live.ttkSum += Math.max(0, ctx.elapsed - first)
          this.live.ttkCount++
        }
      }
      // A soldier killed while holding contact never emits `ai:lostContact`,
      // so its id has to be released here or the episode never closes.
      if (this.contacts.delete(p.entity.id) && this.contacts.size === 0 && this.episodeOpen) {
        this.closeEpisode()
      }
    })

    e.on('player:damaged', (p) => {
      // Taking fire with no recorded contact is itself an engagement, and it is
      // the one the player most needs counted: it is an ambush.
      this.openEpisode()
      this.live.damageTaken += p.amount
      this.episodeQuietFor = 0
    })

    e.on('player:died', () => {
      this.openEpisode()
      this.live.died = true
      this.closeEpisode()
      this.contacts.clear()
      this.firstHitAt.clear()
    })

    e.on('player:respawn', () => {
      this.contacts.clear()
      this.firstHitAt.clear()
    })
  }

  /** No allocation. Runs the assist controller and the episode guard. */
  update(dt: number): void {
    if (dt <= 0) return
    this.elapsed += dt

    if (this.episodeOpen && this.contacts.size === 0) {
      this.episodeQuietFor += dt
      if (this.episodeQuietFor >= EPISODE_QUIET_TIMEOUT) this.closeEpisode()
    }

    if (!this.assistActive()) {
      this.assistTarget = 0
    } else if (this.elapsed - this.lastEpisodeAt > EVIDENCE_TIMEOUT) {
      this.assistTarget = 0
    }

    const target = this.assistTarget
    let rate: number
    if (target === 0) rate = NEUTRAL_DECAY
    else if (target < this.assist) rate = EASE_RATE
    else rate = HARDEN_RATE

    const step = rate * dt
    if (this.assist < target) this.assist = Math.min(target, this.assist + step)
    else if (this.assist > target) this.assist = Math.max(target, this.assist - step)
    this.assist = clamp(this.assist, ASSIST_MIN, ASSIST_MAX)

    if (this.assist <= ASSIST_MIN + 1e-3 || this.assist >= ASSIST_MAX - 1e-3) this.pinnedFor += dt
    else this.pinnedFor = 0
  }

  // --- window bookkeeping --------------------------------------------------

  private assistActive(): boolean {
    return this.elapsed >= GRACE_SECONDS && this.wCount >= MIN_EPISODES
  }

  private openEpisode(): void {
    if (this.episodeOpen) return
    this.episodeOpen = true
    this.episodeQuietFor = 0
    this.clearLive()
  }

  private clearLive(): void {
    const l = this.live
    l.damageTaken = 0
    l.shotsFired = 0
    l.hits = 0
    l.kills = 0
    l.ttkSum = 0
    l.ttkCount = 0
    l.died = false
  }

  private closeEpisode(): void {
    const l = this.live
    const i = this.wIndex
    this.wDamage[i] = l.damageTaken
    this.wShots[i] = l.shotsFired
    this.wHits[i] = l.hits
    this.wTtkSum[i] = l.ttkSum
    this.wTtkCount[i] = l.ttkCount
    this.wDied[i] = l.died ? 1 : 0
    this.wIndex = (i + 1) % WINDOW
    if (this.wCount < WINDOW) this.wCount++
    this.episodeOpen = false
    this.episodeQuietFor = 0
    this.lastEpisodeAt = this.elapsed
    this.clearLive()
    this.recomputeTarget()
  }

  /**
   * Weighted, dead-banded score over the rolling window.
   *
   * Negative means "ease". Outcome signals (deaths, damage taken) carry 70% of
   * the weight; process signals (accuracy, time-to-kill) carry 30%, because
   * those two are dominated by weapon tuning rather than by difficulty and
   * would otherwise let a mis-tuned weapon pin this controller.
   */
  private recomputeTarget(): void {
    if (!this.assistActive()) {
      this.assistTarget = 0
      return
    }
    this.fillWindow(this.out.window)
    const w = this.out.window

    let score = 0
    let weight = 0

    if (w.deathsPerEngagement !== null) {
      score += -bandScore(w.deathsPerEngagement, DEATHS_PER_ENGAGEMENT) * W_DEATHS
      weight += W_DEATHS
    }
    if (w.damageFractionPerEngagement !== null) {
      score += -bandScore(w.damageFractionPerEngagement, DAMAGE_FRACTION) * W_DAMAGE
      weight += W_DAMAGE
    }
    if (w.accuracy !== null) {
      score += bandScore(w.accuracy, ACCURACY) * W_ACCURACY
      weight += W_ACCURACY
    }
    if (w.timeToKill !== null) {
      score += -bandScore(w.timeToKill, TTK) * W_TTK
      weight += W_TTK
    }

    if (weight <= 0) {
      this.assistTarget = 0
      return
    }
    const normalised = clamp(score / weight, ASSIST_MIN, ASSIST_MAX)
    const magnitude = Math.abs(normalised)
    if (magnitude <= DEADBAND) {
      this.assistTarget = 0
      return
    }
    // Rescale so the assist ramps from 0 at the deadband edge to 1 at full.
    const scaled = (magnitude - DEADBAND) / (1 - DEADBAND)
    this.assistTarget = normalised < 0 ? -scaled : scaled
  }
}

// ---------------------------------------------------------------------------
// Preset facts, for a menu that has to describe a preset it has not applied
// ---------------------------------------------------------------------------

/**
 * One preset's numbers, read straight from the table.
 *
 * `effective()` reports what the *running* game is doing, which is the right
 * answer everywhere except a difficulty menu. That has to describe four presets
 * at once — including the three it has not selected — and it must not disturb
 * the shared instance to do it, because `setPreset` clears the rolling window.
 *
 * The four figures below are the three variables §7.6 establishes that the
 * presets move, plus the reaction window. Deliberately nothing derived from the
 * AI's firing cadence: `damagePerRegenWindow` is the honest lethality figure and
 * the one a designer should read, but it depends on a duty cycle the notes on
 * PRESETS show is currently under-delivering, so it is not a number to put in
 * front of a player choosing a preset.
 */
export interface PresetFacts {
  readonly id: DifficultyPreset
  readonly label: string
  readonly blurb: string
  /** 1-based rung on the ladder, for a threat meter. */
  readonly tier: number
  /** How many rungs there are, so a meter does not hard-code four. */
  readonly rungs: number
  /** accuracy x damage / health versus Regular. The one number to read. */
  readonly lethality: number
  readonly playerMaxHealth: number
  /** Chance a shot at or inside {@link BASE_NEAR_RANGE} is allowed to land. */
  readonly hitChanceNear: number
  readonly reactionMinMs: number
  readonly reactionMaxMs: number
}

/** Pure. Allocates one object, so call it on a menu event, not per frame. */
export function presetFacts(id: DifficultyPreset): PresetFacts {
  const p = PRESETS[id]
  return {
    id,
    label: p.label,
    blurb: p.blurb,
    tier: PRESET_ORDER.indexOf(id) + 1,
    rungs: PRESET_ORDER.length,
    lethality: (p.accuracyScale * p.damageScale) / p.healthScale,
    playerMaxHealth: BASE_PLAYER_HEALTH * p.healthScale,
    hitChanceNear: clamp(BASE_NEAR_ACCURACY * p.accuracyScale, 0, HIT_CHANCE_CEILING),
    reactionMinMs: BASE_REACTION_MIN * p.reactionScale * 1000,
    reactionMaxMs: BASE_REACTION_MAX * p.reactionScale * 1000,
  }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function parsePreset(value: string | null | undefined): DifficultyPreset | null {
  if (!value) return null
  const v = value.toLowerCase()
  return (PRESET_ORDER as readonly string[]).includes(v) ? (v as DifficultyPreset) : null
}

/**
 * Reads `?difficulty=veteran` (or `?diff=`) from a query string, defaulting to
 * Regular. Lives here rather than in `core/Config.ts` so that difficulty needs
 * no change to a file this module does not own.
 */
export function resolveDifficulty(search = globalThis.location?.search ?? ''): DifficultyPreset {
  return parsePreset(new URLSearchParams(search).get('difficulty'))
    ?? parsePreset(new URLSearchParams(search).get('diff'))
    ?? 'regular'
}

/**
 * The shared instance. `Services` in `core/Types.ts` has no slot for difficulty
 * and that file is frozen, so this is the access path: import it directly.
 *
 *     import { difficulty } from '../game/Difficulty'
 *     if (!difficulty.rollHit(dist, rng)) deflect(shot)
 *
 * It works with no wiring at all — an instance that is never registered still
 * reports its preset, with the dynamic assist inert at 0. Registering it with
 * the Engine (`init` + `update`) is what turns the dynamic component on.
 */
export const difficulty = new DifficultySystem(resolveDifficulty())
