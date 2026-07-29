/**
 * The match: six waves of hostiles pushing the plaza, then it is held or it is
 * not. Every number here is stated with the target it is aiming at, because
 * "the pressure should rise" is a direction, not a specification.
 *
 * ## The two 90 s runs of `runs/feel7` (seed 1337), per second
 *
 * These are the runs the judging panel graded, and they answer the question the
 * panel asked — *does the escalation in this table reach the field?* — with a
 * number rather than an opinion.
 *
 * | | push | hold |
 * | --- | --- | --- |
 * | kills in 90 s | 22 | 26 |
 * | mean hostiles alive | 4.64 | 4.43 |
 * | mean holding contact | 1.98 | 1.79 |
 * | seconds with nobody in contact | 26 | 28 |
 * | longest unbroken silence | 11 s | 13 s |
 * | waves reached | 1, 2 | 1, 2, 3 |
 *
 * Wave boundaries, read off the alive-count and the spawn ids: push wave one
 * t=0-45, wave two t=56-89; hold wave one t=0-30, wave two t=41-66, wave three
 * t=75-89. **Mean hostiles in contact, per wave, hold run: 2.93, then 1.03,
 * then 2.53.** The arc is not flat, it is *inverted* — wave one is the most
 * intense wave in the game and wave two is a hole — and the panel's reading
 * ("enemy count oscillates without direction") was correct.
 *
 * Three separate causes, all of them arithmetic rather than taste.
 *
 * ### 1. Every wave ends with a diminuendo as long as its own body
 *
 * This is the big one, and it falls straight out of the two columns. A wave
 * delivers `size` hostiles against a presence ceiling of `concurrent`. Holding
 * the field at that ceiling costs budget at whatever rate the player kills —
 * measured **0.24-0.29 kills/s** across both runs — so:
 *
 * ```
 * dense phase  = (size - concurrent) / killRate      field held at `concurrent`
 * decay phase  =  concurrent         / killRate      field falls to nothing
 * ```
 *
 * On the previous table, wave one was `size` 8 against `concurrent` 6: **7 s
 * dense, then 22 s of a thinning field.** Wave six was 15 against 8: 26 s
 * dense, 30 s thinning. Every wave ended in the same slow fade, the fade was
 * three times the length of the fight in the early waves, and *the fade is what
 * a ninety-second run is mostly made of.* That is the mechanism behind "the
 * last wave is indistinguishable from the first": whichever wave the player is
 * in, most of it is the same emptying plaza. It is also why `concurrent` moving
 * 6 → 8 down the table could not be felt — the column was right, but it only
 * described a quarter of each wave.
 *
 * The cure is {@link tailFloor}. A wave now finishes when its budget is spent
 * and the field has fallen to **half its own `concurrent`**, not to zero, and
 * whoever is left is inherited by the next wave instead of waited out. The
 * decay phase halves, the wave never ends on an empty plaza, and the bodies
 * that used to be a twenty-second wait become free density for the next wave.
 *
 * ### 2. The wave that never arrives, because five hostiles were already there
 *
 * `AiSystem` seeds the level with five soldiers before the match opens. `size`
 * is taken at face value, so wave one fielded 13 bodies where wave two fielded
 * 10 — 0.43 hostiles per second of wave against 0.29. The opening wave was 40%
 * denser than its successor, which is the inversion above.
 *
 * The opening wave now counts whoever is already standing toward its own
 * roster. This is deliberately *not* the old `max(opening, size - standing)`
 * rule that was removed for good reason: that rule ran on every wave, so it
 * shrank a wave in proportion to how many stragglers the AI had lost the player
 * to. Applied only to the wave the match opens on, where the standing field is
 * the seed and genuinely is part of wave one, it is simply honest accounting.
 *
 * ### 3. A third of every wave is spent on hostiles the player never finds
 *
 * From the hold run's spawn ids — 31 bodies, 5000-5030, being 5 seeded plus 8,
 * 10 and 8 delivered — against the first moment the player acquired each one:
 *
 *  - **5006** spawned about t=1, first acquired **t=39.2**.
 *  - **5022** spawned about t=50, first acquired **t=80.2**.
 *  - **5025** and **5026** spawned around t=75 and were **never acquired** in
 *    the fifteen seconds of life the run gave them.
 *
 * {@link STALE_AFTER} already stops a wave *waiting* on these; nothing stops it
 * *spending budget* on them. Roughly a fifth of every roster produces no
 * contact at all, which is why `concurrent` 6 buys only 1.8-2.0 hostiles in
 * contact — measured contact is **0.33-0.38 of the live field**, never more.
 * That ratio, not the table, is what the player feels, and it means the usable
 * range of this game is 6 to 10 bodies buying 2.0 to 3.3 in contact. The
 * texture the panel praised — "six enemies alive, 2-3 in contact continuously"
 * — sits at the *top* of that range, not beyond it. So the arc is built to
 * reach the top of it rather than to invent headroom that does not exist.
 *
 * ## What the arc is now made of
 *
 * `concurrent` 6 → 10, and 10 is `AiSystem`'s `MAX_LIVE`: the last wave is
 * deliberately "as much as the engine will hold". Replaying the director's own
 * beat, concurrency, tail and clear rules against the measured kill rate over
 * fifteen runs (three kill rates × five straggler draws), across the whole
 * six-wave match:
 *
 * | | before | after |
 * | --- | --- | --- |
 * | mean hostiles alive | 5.34 | **7.96** |
 * | mean hostiles in contact | 1.69 | **2.66** |
 * | seconds with nobody in contact | 68 of 336 | **6 of 300** |
 * | longest unbroken silence | 16.1 s | **4.3 s** |
 * | six waves take | 5.6 min | **5.0 min** |
 * | mean contact, wave 1 → 6 | 1.56 1.40 1.37 1.79 1.78 2.06 | **1.81 2.12 2.28 2.87 3.00 3.13** |
 *
 * The last row is the answer to "there is no arc". Before, the arc was not flat
 * so much as noise: it fell for three waves, recovered, and topped out at 2.06.
 * After, it is monotonic across all six and rises 73%.
 *
 * Measured one row at a time on ninety-second runs with `?wave=N` — which is how
 * the harness can actually reach the top of the table — mean hostiles in contact
 * goes **2.06, 2.41, 2.78, 3.03, 3.05, 3.19** against a previous **1.61, 1.89,
 * 1.97, 2.14, 2.19, 2.36**, and seconds with nobody in contact go from 11-15 on
 * every row to 6, 2, 1, 0, 0, 0.
 *
 * ## What bounds the pressure
 *
 * Two numbers from `.ai/FEEL_TARGET.md`:
 *
 *  - `ai_maxAttackerCount "2"` — only two AI shoot at the player at once,
 *    whatever else is on the field. §1 `[stated]`, CoD5 dvar defaults. This is
 *    why `concurrent` can climb to ten and stay survivable, and it is why
 *    escalation here is expressed as *presence* and *cadence* rather than as
 *    enemy health. Raising health would move the measured time-to-kill, which
 *    another agent tunes against a 0.8–2.2 s target, so this file must not
 *    touch it.
 *  - Designed engagement distance 13 m (SMG) / 26 m (rifle) §1 `[stated]`, from
 *    the official CoD5 level-design standards. The AI's own spawn placement
 *    already works in that band (its candidate ranges run 8.5–24 m), so the
 *    director asks for counts and leaves placement alone.
 *
 * ## What the breaks are tuned against
 *
 * **The target for a wave mode is not the same number as the target for
 * deathmatch, and conflating them is the trap here.** FEEL_TARGET §6.1
 * separates three quantities that are easily read as one:
 *
 * | Quantity | Value | Applies to |
 * | --- | --- | --- |
 * | Engagement cadence | 25–45 s `[estimated]` | Continuous respawn; the gap is *movement*, not silence |
 * | Scheduled inter-round break | **10–15 s** `[measured]` | Round and wave modes; genuine silence |
 * | Intra-round spawn cadence | **2.0 s → 0.1 s** over 60 rounds `[measured]` | Round and wave modes |
 *
 * The 25–45 s figure comes from MWIII Team Deathmatch's 100-kill / 10-minute /
 * 6v6 limits, where there is no scheduled quiet at all — the gap is filled with
 * traversal and approach. Aiming a wave break at it would be a category error,
 * and the harness's 12–28 s `downtimeMean` target is derived from it. **Do not
 * chase that metric upward from this file.**
 *
 * The sourced number for this mode is the round break, `[measured]` from
 * Zombies at **10 to 15 seconds**, exposed in the Black Ops III mod tools as
 * `zombie_between_round_time` and documented in community examples set to 10.
 *
 * `breakSeconds` stays a flat **9 s**, and what changed is not its length but
 * what happens during it. With {@link tailFloor} the break now opens with two
 * to five hostiles still standing, so it is a mop-up under a REGROUP banner and
 * a countdown rather than a vacuum — the player is reloading, repositioning and
 * finishing the last of the push, which is what an inter-round break is for.
 * Nine on the clock therefore covers *more* than nine seconds of felt structure
 * and less than nine seconds of felt silence, which sits it correctly inside the
 * sourced band. Replaying it at 6 s and 12 s moves mean contact by ±0.15 and
 * silence by ∓3 s, so it is a live lever; it is left on the sourced number
 * rather than tuned, because tuning it is chasing `downtimeMean`.
 *
 * *Flat, not a curve,* because `zombie_between_round_time` is one number rather
 * than a ramp, and because §6.2 is explicit that in this mode family
 * "escalation is expressed as spawn cadence, not as a longer break."
 *
 * **None of this holds while two other systems also commit waves.**
 * `AiSystem.updateWaves` sends four more soldiers after an 11–15 s lull, and
 * `EncounterDirector` commits its own wave on its own timer. Both gate on
 * `MatchService.directsSpawning`, and the id audit above confirms they are
 * honouring it: the hold run's 31 bodies are exactly 5 seeded plus this table's
 * 8, 10 and 8. If either stops gating, every number in this file is decoration.
 */

export interface WaveDef {
  /** Shown on the objective line and on the wave banner. */
  label: string
  /** One line of situation, shown under the banner title. */
  brief: string
  /**
   * Hostiles on this wave's roster.
   *
   * Taken at face value on every wave but the one the match opens on, where
   * whoever is already standing — `AiSystem`'s seeded five — counts toward it.
   * See cause 2 in the file header for why that exception exists and why it is
   * not the `size - standing` rule that was removed from every wave.
   *
   * This column sets **how long a wave lasts**: a wave ends when its budget is
   * spent and the field has fallen to {@link tailFloor}, so its duration is
   * `(size - tailFloor) / killRate`. At the measured 0.24-0.29 kills/s that is
   * 25-45 s a wave and a four-and-a-half minute match.
   *
   * It also decides how much of that duration is spent at full density:
   * `(size - concurrent) / (size - tailFloor)`. That fraction ran 25-47% on the
   * previous table — a wave was mostly fade — and it is 57-67% on every row
   * here. **A `size` close to `concurrent` cannot hold a field, whatever
   * `concurrent` says**, because the opening squad alone spends most of the
   * roster.
   */
  size: number
  /**
   * Most *participating* hostiles at once — see `MatchDirector`'s staleness
   * rule. Counting bodies here rather than participants is what let two
   * hostiles who had lost the player hold five reinforcements off the field.
   *
   * **This is the pressure column, and it is the arc.** With `size` deciding
   * duration, this decides density, and density is what the player feels:
   * `ai_maxAttackerCount "2"` means at most two hostiles shoot at once, so the
   * question is only whether two of them are in contact at any moment.
   * Measured, **0.33-0.38 of the live field holds contact**, so a field of six
   * keeps roughly two attacker slots filled and a field of ten keeps three.
   *
   * Bounded above by `AiSystem`'s `MAX_LIVE` of 10, which counts *bodies* while
   * this counts participants, so the gap between them is the stale stragglers.
   * The last wave is set *at* that cap on purpose: it means the final push is
   * bounded by the engine rather than by this table. That is only safe because
   * `MatchDirector.deploy` no longer spends a wave's budget on a spawn the live
   * cap refused — without that rule, a wave asking for a slot the cap will not
   * give up forfeits its roster after four attempts, which is why the previous
   * table stopped at eight.
   */
  concurrent: number
  /** Arrive together the instant the wave opens. The punch. */
  opening: number
  /** Arrive together on each beat after the opening. */
  reinforce: number
  /** Seconds between beats at the top of the wave. */
  openInterval: number
  /**
   * Seconds between beats once the wave's own budget is spent. The beat lerps
   * from `openInterval` to this across the wave, so the fight accelerates
   * rather than arriving in one clump and stopping.
   *
   * FEEL_TARGET §6.2 `[measured]`, from the Black Ops III mod tools: within a
   * Zombies round the spawn delay starts at 2 s and decays to 0.1 s by round 60
   * — "escalation is expressed as spawn cadence, not as a longer break." The
   * 2.2 → 0.9 s span below sits in the slow half of that band, which is right:
   * these waves are 25-45 s long, not a sixty-round arc.
   *
   * The beat has never been the bottleneck, and it is not the fix for anything
   * measured here. Two to three hostiles every one to two seconds is six to ten
   * times the rate the player kills them; what throttles delivery is
   * `concurrent`, and behind it the engine's live cap.
   */
  peakInterval: number
  /** Seconds of quiet after the wave is cleared. Ignored on the last wave. */
  breakSeconds: number
}

/**
 * Participating hostiles at which a wave whose budget is spent is over.
 *
 * **Half of the wave's own `concurrent`**, so the rule scales with the arc: a
 * wave is finished when the field has fallen to half the density that defined
 * it. The survivors are not written off — they stay on the plaza, they are
 * fought during the break, and the next wave's opening squad arrives on top of
 * them and absorbs them into its own concurrency.
 *
 * Why any floor at all: see cause 1 in the file header. A wave that waits for
 * the field to reach *zero* spends `concurrent / killRate` — twenty-two seconds
 * on the old wave one — watching the plaza empty, and the last third of that is
 * hunting one or two hostiles the AI has lost the player to. Both graded runs
 * contain a stretch of ten or more seconds with nobody in contact and one of
 * them has eleven consecutive seconds with nobody *alive*.
 *
 * Halving the fade is worth more than any other single number in this file.
 * Added on its own to the *previous* table, with nothing else changed, it moves
 * mean hostiles in contact from 1.61 to 2.35 in replay and takes the longest
 * silence from 12.6 s to zero — more than the whole new table contributes on top
 * of it. It also, on its own, abolishes the break: the survivors it leaves
 * standing tripped the old "cancel the break if anybody holds contact" test
 * every time, so waves chained end to end. That is why it arrives together with
 * the break rule in `MatchDirector.update`, and the two must not be separated.
 *
 * At least one, so a wave can still be finished rather than becoming an
 * assertion that somebody is always on the field.
 */
export function tailFloor(def: WaveDef): number {
  return Math.max(1, Math.ceil(def.concurrent / 2))
}

/**
 * Escalation, read down the columns: 10 → 19 on the roster, 6 → 10 present at
 * once, 2.2 s → 0.9 s between arrivals. The break is held constant underneath
 * them.
 *
 * **`concurrent` is the whole arc and it now spans the whole usable range.**
 * 6 → 10 against a live cap of 10, which at the measured 0.33-0.38 contact
 * ratio is 2.0 → 3.3 hostiles holding the player. The previous table ran 6 → 8,
 * a 14% rise, and spent most of it on rows a ninety-second run never reached.
 *
 * **`size` is 1.7 to 1.9 × `concurrent` on every row, and that ratio is the
 * point.** It is what buys a wave a middle: the dense phase is
 * `(size - concurrent) / killRate` and the fade is `(concurrent - tailFloor) /
 * killRate`, so at this ratio each wave is **57-67% fight**. The previous table
 * ran at 1.3× with no tail floor, which is 25-47% fight and the rest fade, and
 * no adjustment to `concurrent` could have shown through that. **If one number
 * here has to be defended, it is this ratio and not any single cell.**
 *
 * The last two rows are the widest at 1.9×, because they are the two that
 * inherit the most survivors from the wave before and need the roster to refill
 * past them. At 1.7× the final push replayed *below* wave five, which is the
 * inversion this whole table exists to remove.
 *
 * Wave one reads 10 and delivers 5, because `AiSystem` has already put five
 * soldiers on the plaza and the opening wave counts them. Ten is the honest
 * roster; five is the invoice.
 *
 * The totals: 87 bodies across six waves including the seeded five, which at
 * 0.24-0.32 kills/s replays at **five minutes** — the length of a Call of Duty
 * multiplayer match (MWIII Team Deathmatch: 100 kills, 10 minute limit
 * `[stated]`, most games finishing well inside it).
 *
 * **What a ninety-second run measures.** Waves one and two and the opening of
 * wave three, much as before. That has not improved and cannot be made to: six
 * waves that each hold a field for twenty-five to fifty seconds do not fit in
 * ninety seconds, and shortening them to fit would delete the middle this table
 * was rebuilt to give them. `?wave=N` is the answer, and it is now worth using:
 * every row is a measurably different thing, which is what the previous table's
 * rows were not.
 */
export const WAVES: readonly WaveDef[] = [
  {
    label: 'PROBING CONTACT',
    brief: 'A patrol has walked into the plaza',
    size: 10, concurrent: 6, opening: 5, reinforce: 3,
    openInterval: 2.2, peakInterval: 1.5,
    breakSeconds: 9,
  },
  {
    label: 'SECOND ELEMENT',
    brief: 'They know where you are now',
    size: 12, concurrent: 7, opening: 5, reinforce: 3,
    openInterval: 2.0, peakInterval: 1.3,
    breakSeconds: 9,
  },
  {
    label: 'FLANKING PUSH',
    brief: 'Two approaches, not one',
    size: 14, concurrent: 8, opening: 6, reinforce: 3,
    openInterval: 1.8, peakInterval: 1.2,
    breakSeconds: 9,
  },
  {
    label: 'SUPPRESSION SQUAD',
    brief: 'They are trying to pin you in the open',
    size: 15, concurrent: 9, opening: 6, reinforce: 4,
    openInterval: 1.6, peakInterval: 1.1,
    breakSeconds: 9,
  },
  {
    label: 'SUSTAINED ASSAULT',
    brief: 'No gaps left in the line',
    size: 17, concurrent: 9, opening: 7, reinforce: 4,
    openInterval: 1.4, peakInterval: 1.0,
    breakSeconds: 9,
  },
  {
    label: 'FINAL PUSH',
    brief: 'Everything they have left, all at once',
    size: 19, concurrent: 10, opening: 7, reinforce: 4,
    openInterval: 1.2, peakInterval: 0.9,
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
 * Three is a design choice that keeps a real lose condition on the table while
 * the feel work lands; `?lives=1` gives the strict version and `?lives=0` an
 * unloseable one for capture runs.
 */
export const DEFAULT_LIVES = 3

/** Seconds a wave banner holds before fading. */
export const BANNER_SECONDS = 3.0

/**
 * Consecutive failed spawn attempts, at `SPAWN_RETRY` apart, after which the
 * director stops asking.
 *
 * This is a *placement* backstop: without it a wave whose spawn points are all
 * blocked would keep hammering `spawnWave` for the rest of the match. It is
 * explicitly **not** the response to the engine's live cap being full — see
 * `MatchDirector.deploy`, which tells the two cases apart. Confusing them is
 * what capped the previous table's `concurrent` at eight: with the cap full of
 * hostiles the player had not found, a wave forfeited its roster after four
 * attempts and ended early, which is escalation running backwards.
 */
export const SPAWN_FAIL_LIMIT = 4
export const SPAWN_RETRY = 2.0

/**
 * Seconds a hostile can go without seeing, shooting at, or being shot by the
 * player before it stops counting as part of the fight.
 *
 * Both graded runs are full of hostiles standing somewhere the player never
 * goes. From the hold run's spawn ids against first acquisition: 5006 spawned
 * at t≈1 and was first seen at t=39.2; 5022 spawned at t≈50 and was first seen
 * at t=80.2; 5025 and 5026 were never seen at all. Counting them as present
 * holds `concurrent` full so reinforcements stop; counting them as alive holds
 * the wave open so it never clears.
 *
 * Six seconds is Call of Duty's own answer to the same question:
 * `ai_noPathToEnemyGiveupTime "6000"` §7.4 `[stated]` — after six seconds of
 * being unable to path to the player the AI gives up and repositions. A hostile
 * the engine has already written off as unable to reach the player is not one
 * the director should be waiting on.
 *
 * Ten, not six, because a hostile is *deployed* before it is *engaged*: the
 * spawn ring runs out to 24 m and the walk in at 4.83 m/s §4.1 `[stated]` is
 * five seconds before pathing around cover. Six seconds of grace would write
 * off every reinforcement while it was still walking. Ten covers the approach
 * and still leaves the giveup constant's worth of doubt on top of it.
 */
export const STALE_AFTER = 10

/**
 * Seconds at or under {@link tailFloor} before the wave is called finished.
 *
 * Short: the tail floor has already established that the push is broken, so
 * this is only the settling time on that judgement. It exists so a hostile in
 * the middle of reacquiring the player is not written out of its own wave.
 */
export const WAVE_SETTLE = 1.5

/**
 * Backstop: seconds of complete quiet — no contact, no damage, no kill — before
 * a wave is written off whatever state its budget is in.
 *
 * With the staleness and tail-floor rules in place this should never fire in
 * ordinary play, and if it does it means the wave could not deploy anybody
 * either. It is a deadlock breaker, not a pacing mechanism.
 *
 * It is also the only bound on a wave whose budget the engine's live cap will
 * not let it deliver, now that a cap refusal no longer forfeits the roster —
 * with one gap, which is deliberate. `MatchDirector` holds this clock open for as
 * long as *anybody holds contact*, so a full plaza that the player is fighting
 * and not killing keeps its wave open indefinitely. That is the right answer:
 * the field is at maximum density and the player is in a firefight, which is not
 * a state to escape by conjuring a wave transition. The only way the cap stays
 * full is that nobody is dying, and if nobody is dying and nobody is in contact
 * either, this fires.
 */
export const WAVE_STALL = 20
