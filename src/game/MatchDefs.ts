/**
 * The match: six waves of hostiles pushing the plaza, then it is held or it is
 * not. Every number here is stated with the target it is aiming at, because
 * "the pressure should rise" is a direction, not a specification.
 *
 * ## What the waves are tuned against
 *
 * Two numbers from `.ai/FEEL_TARGET.md` bound the encounter design:
 *
 *  - `ai_maxAttackerCount "2"` — only two AI shoot at the player at once,
 *    whatever else is on the field. `[stated]`, CoD5 dvar defaults. This is why
 *    a wave can put eight soldiers in front of the player and stay survivable,
 *    and it is why escalation here is expressed as *concurrency* rather than as
 *    enemy health. Raising health would move the measured time-to-kill, which
 *    another agent is tuning against a 0.20–0.35 s target, so this file must
 *    not touch it.
 *  - Designed engagement distance 13 m (SMG) / 26 m (rifle) `[stated]`, from
 *    the official CoD5 level-design standards. The AI's own spawn placement
 *    already works in that band (its candidate ranges run 8.5–24 m), so the
 *    director asks for counts and leaves placement alone.
 *
 * ## What the breaks are tuned against
 *
 * The baseline run measured 2.39 s of mean downtime between engagements, with
 * the longest lull in a minute lasting two seconds. Downtime in the harness is
 * the positive gap between one engagement ending and the next opening, so it is
 * produced by exactly two things: the quiet inside a wave while the next squad
 * is still walking in (`regroup`), and the quiet between waves
 * (`breakSeconds`).
 *
 * **The target for a wave mode is not the same number as the target for
 * deathmatch, and conflating them is the trap here.** FEEL_TARGET §6.1 now
 * separates three quantities that were previously read as one:
 *
 * | Quantity | Value | Applies to |
 * | --- | --- | --- |
 * | Engagement cadence | 25–45 s `[estimated]` | Continuous respawn; the gap is *movement*, not silence |
 * | Scheduled inter-round break | **10–15 s** `[measured]` | Round and wave modes; genuine silence |
 * | Intra-round spawn cadence | **2.0 s → 0.1 s** over 60 rounds `[measured]` | Round and wave modes |
 *
 * The 25–45 s figure is derived from MWIII Team Deathmatch's 100-kill /
 * 10-minute / 6v6 limits, where there is no scheduled quiet at all — the gap is
 * filled with traversal and approach. Aiming a wave break at it would be a
 * category error.
 *
 * The sourced number for this mode is the round break, `[measured]` from
 * Zombies at **10 to 15 seconds**, exposed in the Black Ops III mod tools as
 * `zombie_between_round_time`. `breakSeconds` runs **14 s → 10 s**, inside that
 * band at both ends.
 *
 * `regroup` runs **7.0 s → 2.0 s**, which is the same shape as the `[measured]`
 * Zombies intra-round spawn cadence: escalation expressed as *how fast the next
 * squad arrives*, never as longer breaks and never as enemy health.
 *
 * Caveat on the 10–15 s figure, from the same research: it is community
 * documentation of Zombies rather than a patch note, and Zombies is a different
 * mode family from a campaign-style wave shooter. No inter-round timing is
 * published for Search & Destroy or Gunfight. So it is one mode family's
 * number, not a series-wide constant.
 *
 * **None of this holds while two other systems also commit waves.**
 * `AiSystem.updateWaves` sends four more soldiers 6 s after the field drops to
 * two or fewer, and `EncounterDirector` commits its own wave on a 4.5 s quiet /
 * 7 s gap timer. Between them every lull in the game is capped at ~6 s
 * regardless of this table. Nothing in FEEL_TARGET asks for a floor that tight:
 * `ai_maxAttackerCount "2"` `[stated]` clamps how many AI *shoot* at once,
 * which is a concurrency limit and not a reason to keep the field populated,
 * and `ai_noPathToEnemyGiveupTime "6000"` `[stated]` has CoD's own AI spend six
 * seconds failing to reach the player before repositioning — so a 6 s lull is
 * well inside what the series treats as one continuous engagement. Both should
 * gate on `MatchService.directsSpawning`.
 *
 * ## Match length
 *
 * 61 hostiles across six waves. At the 0.20–0.35 s target time-to-kill the
 * fighting itself is a small part of that; the clock is dominated by hostiles
 * closing the 8–24 m to contact and by the 71 s of scheduled quiet. A clean run
 * lands around five to six minutes, which is the length of a Call of Duty
 * multiplayer match (MWIII Team Deathmatch: 100 kills, 10 minute limit
 * `[stated]`, with most games finishing well inside it).
 */

export interface WaveDef {
  /** Shown on the objective line and on the wave banner. */
  label: string
  /** One line of situation, shown under the banner title. */
  brief: string
  /** Hostiles the director commits to this wave. */
  size: number
  /** Most hostiles alive at once. The wave's pressure. */
  concurrent: number
  /** Hostiles per reinforcement squad. */
  squad: number
  /**
   * Seconds of quiet after the field is thinned to `trickle` before the next
   * squad is sent. This is the wave's internal breathing room, where most of
   * the measured downtime inside a wave comes from, and the axis escalation
   * actually runs along — Zombies does the same thing, tightening its
   * intra-round spawn delay from 2.0 s to 0.1 s across sixty rounds
   * `[measured]` while leaving enemy health to a separate curve.
   */
  regroup: number
  /** Alive count at or below which the field counts as thinned. */
  trickle: number
  /**
   * Seconds since the last squad after which the next one is sent regardless.
   * Stops a wave stalling on one soldier who cannot path to the player — the AI
   * gives up on an unreachable target after 6 s (`ai_noPathToEnemyGiveupTime`
   * `[stated]`) but may then sit somewhere the player never goes.
   */
  maxHold: number
  /** Seconds of quiet after the wave is cleared. Ignored on the last wave. */
  breakSeconds: number
}

export const WAVES: readonly WaveDef[] = [
  {
    label: 'PROBING CONTACT',
    brief: 'A patrol has walked into the plaza',
    size: 5, concurrent: 3, squad: 3,
    regroup: 7.0, trickle: 1, maxHold: 26,
    breakSeconds: 14,
  },
  {
    label: 'SECOND ELEMENT',
    brief: 'They know where you are now',
    size: 7, concurrent: 4, squad: 3,
    regroup: 6.0, trickle: 1, maxHold: 24,
    breakSeconds: 13,
  },
  {
    label: 'FLANKING PUSH',
    brief: 'Two approaches, not one',
    size: 9, concurrent: 5, squad: 4,
    regroup: 5.0, trickle: 1, maxHold: 22,
    breakSeconds: 12,
  },
  {
    label: 'SUPPRESSION SQUAD',
    brief: 'They are trying to pin you in the open',
    size: 11, concurrent: 6, squad: 4,
    regroup: 4.0, trickle: 2, maxHold: 20,
    breakSeconds: 11,
  },
  {
    label: 'SUSTAINED ASSAULT',
    brief: 'No gaps left in the line',
    size: 13, concurrent: 7, squad: 5,
    regroup: 3.0, trickle: 2, maxHold: 18,
    breakSeconds: 10,
  },
  {
    label: 'FINAL PUSH',
    brief: 'Everything they have left, all at once',
    size: 16, concurrent: 8, squad: 6,
    regroup: 2.0, trickle: 3, maxHold: 15,
    breakSeconds: 0,
  },
]

/**
 * Scoring.
 *
 * 100 points for a kill is the Call of Duty multiplayer convention and is the
 * only figure here with any provenance; everything else is a design choice,
 * chosen so a headshot is worth half a kill again and a five-kill streak is
 * worth two and a half more kills. They are marked as choices rather than
 * dressed up as research.
 */
export const SCORE = {
  kill: 100,
  headshot: 50,
  /**
   * Bonus past the official "rifle distance" of 1024 units = 26.0 m `[stated]`,
   * CoD5 level-design standards. Using the level designers' own long-engagement
   * number means the bonus fires exactly when the player has taken the shot the
   * map was built to offer.
   */
  longshot: 25,
  longshotRange: 26.0,
  /** Chain bonuses, indexed by kills in the chain: 2 → double, 3 → triple, 4+. */
  multi: [0, 0, 150, 300, 500] as const,
  /** Seconds within which a second kill continues a chain. A design choice. */
  multiWindow: 2.0,
  /** Streak milestones without dying, and what each pays. */
  streakAt: [5, 10, 15, 20] as const,
  streakPay: [250, 500, 1000, 2000] as const,
  /** Wave clear pays this times the wave number. */
  wavePerWave: 250,
  /** Cleared a wave without taking a single point of damage. */
  flawless: 500,
  /** Held the plaza. */
  victory: 2000,
} as const

export const MULTI_LABEL = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL'] as const

/**
 * Reinforcements the player gets before the mission is lost.
 *
 * The baseline run measured 7.77 deaths per minute against a 0.3–1.5 target,
 * so a one-life mode would currently end after eight seconds and tell the
 * judges nothing. Three is a design choice that keeps a real lose condition on
 * the table while the feel work lands; `?lives=1` gives the strict version and
 * `?lives=0` an unloseable one for capture runs.
 */
export const DEFAULT_LIVES = 3

/** Seconds a wave banner holds before fading. */
export const BANNER_SECONDS = 3.0

/**
 * Consecutive failed spawn attempts, at `SPAWN_RETRY` apart, after which the
 * director forgives the rest of the wave. Without this a wave whose spawn
 * points are all blocked would never end.
 */
export const SPAWN_FAIL_LIMIT = 4
export const SPAWN_RETRY = 2.0
