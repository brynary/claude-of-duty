import type { Damageable, GameContext, System } from '../core/Types'
import { callsign } from './Callsigns'
import {
  DEFAULT_LIVES, MULTI_LABEL, SCORE, SPAWN_FAIL_LIMIT, SPAWN_RETRY, STALE_AFTER,
  tailFloor, WAVE_SETTLE, WAVE_STALL, WAVES, type WaveDef,
} from './MatchDefs'
import { setMatchService, type Award, type MatchService, type MatchState, type MatchSummary } from './Match'

/** How many scoring events the HUD can fall behind by before it drops some. */
const AWARD_RING = 24

/**
 * `AiSystem`'s opt-out for its own reinforcement loop.
 *
 * It is a real public field on that class, but `AiService` in `core/Types.ts`
 * is frozen and cannot declare it, so this is the typed shim rather than a
 * guess about what is there. Optional, so the match layer still runs against an
 * `AiSystem` that has not got one.
 */
interface Reinforcer {
  autoReinforce?: boolean
}

/**
 * Match structure: six escalating waves against the plaza, a score, and an end.
 *
 * The director owns *when* hostiles arrive and *how many*. It never owns where
 * they arrive or how they fight: `EncounterDirector` restages the level's spawn
 * points against the player continuously, and `AiSystem` picks from those, so a
 * bare `spawnWave(n)` already lands in the staged approach lanes. Reaching into
 * placement from here would undo that work rather than use it. See
 * `MatchService.directsSpawning` for the contract that keeps the three
 * spawners from fighting.
 *
 * ## Participation, not body count
 *
 * The one idea this file turns on. A hostile that has not seen, shot at, or
 * been shot by the player for {@link STALE_AFTER} seconds is **not in the
 * fight**, and every decision here is made on the count of hostiles that are.
 *
 * Two measured ninety-second runs are the argument. Both floor at two to four
 * live hostiles with zero in contact, zero shots and zero damage in either
 * direction — bodies standing somewhere the player never goes. Counting them
 * as present kept `concurrent` full, so wave two delivered two of its seven and
 * the remaining five never came; counting them as alive kept the wave open, so
 * it never cleared and the break that should have followed it never ran. One
 * run spent its final fifty-seven seconds in exactly that state: four alive,
 * nothing happening, no exit.
 *
 * Making every count a participation count fixes all three at once. The wave
 * keeps reinforcing past a hostile who has lost the player, it finishes when
 * the *fight* finishes rather than when the last body drops, and the twenty
 * second {@link WAVE_STALL} backstop goes back to being a deadlock breaker
 * instead of the routine exit it had become.
 *
 * It does not fix the hostiles being unreachable. That is an AI pathing
 * problem, it is real, and it is not this file's to solve — but a match layer
 * that deadlocks when the AI loses the player is this file's bug and that part
 * is fixed.
 *
 * ## Duration is `size`; pressure is `concurrent`
 *
 * The second thing the participation rule exposed, once the runs were valid.
 * With the deadlock gone the waves still came out thin, and for a different
 * reason: the budget was `max(opening, size - standing)`, so the same stragglers
 * that used to hold a wave open were now *shrinking* the next one. Wave one
 * spent its whole budget on its opening beat and then had nothing to send for
 * half a minute while the player worked the field down to nothing.
 *
 * So the two columns are separated. `size` is taken flat and decides how long a
 * wave runs; `concurrent` is checked on every beat and decides how many are in
 * the fight while it does. Nothing here derives one from the other, and nothing
 * derives either from how badly the AI is pathing.
 *
 * ## A wave ends when the push breaks, not when the plaza empties
 *
 * The third thing, and the one the graded runs are loudest about. Separating the
 * columns fixed the middle of a wave and left its ending alone, and the ending
 * is most of it: a wave that waits for the last participant to fall spends
 * `concurrent / killRate` — twenty-two seconds at the measured 0.27 kills/s —
 * watching the field thin, against seven seconds of holding it. The hold run's
 * three waves measured 2.93, 1.03 and 2.53 hostiles in contact; the 1.03 is a
 * thirteen-second stretch of two hostiles standing somewhere unreachable while
 * the objective line still read WAVE 2 — 02 LEFT.
 *
 * Three rules, and between them they are the change:
 *
 * 1. **{@link tailFloor}.** The wave is over when its budget is spent and the
 *    field has fallen to half its `concurrent`. Whoever is left stays standing.
 * 2. **The break survives them.** A break used to be cancelled the instant
 *    anybody held contact, which under rule 1 would mean no break ever ran. It
 *    now runs its scheduled length with the survivors on the field, so the
 *    REGROUP banner and its countdown sit over a mop-up rather than a vacuum.
 * 3. **The opening wave counts the field it opens onto.** `AiSystem` seeds five
 *    soldiers before the match starts and `size` is flat, so wave one fielded
 *    thirteen bodies against wave two's ten — which is why the arc measured
 *    inverted. Only the wave the match opens on does this; on any later wave the
 *    standing field is stragglers, and discounting those is the mistake that was
 *    removed from every wave.
 *

 * ## Everything is correct mid-wave
 *
 * A scripted run is a fixed number of simulated seconds and is cut off wherever
 * it happens to be, almost always mid-wave. So: every figure the interface
 * reads lives on `state` and is correct at any instant rather than being
 * computed at the end; `summary()` is null until there is one and every caller
 * handles that; and in a headless run the match wraps at the last wave instead
 * of ending, so `directsSpawning` never flips off underneath the other two
 * spawners partway through a measurement.
 *
 * Nothing in `update` allocates.
 */
export class MatchDirector implements System, MatchService {
  readonly name = 'match'

  readonly state: MatchState = {
    phase: 'idle',
    wave: 0,
    waveCount: WAVES.length,
    waveLabel: '',
    waveSize: 0,
    hostilesLeft: 0,
    waveKills: 0,
    flawlessWave: true,
    breakLeft: 0,
    score: 0,
    kills: 0,
    headshots: 0,
    streak: 0,
    bestStreak: 0,
    livesLeft: DEFAULT_LIVES,
    livesMax: DEFAULT_LIVES,
    deaths: 0,
    wavesCleared: 0,
    elapsed: 0,
  }

  readonly awards: Award[] = []
  awardSeq = 0

  private ctx!: GameContext
  private t = 0
  private paused = false
  /**
   * Capture poses and scripted play runs measure the game rather than play it.
   * They keep the wave structure — it is what produces the pacing being
   * measured — but never see an end screen, and the match wraps instead of
   * finishing so a sixty-second run is not half menu.
   */
  private headless = false
  private lives = DEFAULT_LIVES
  /**
   * Wave the match opens on, from `?wave=N`.
   *
   * A ninety-second run reaches waves one and two and the opening of three, so
   * the top of the escalation is unmeasurable by default and always will be —
   * six waves that each hold a field for twenty-five to fifty seconds do not fit
   * in ninety. **This is the only way to measure the arc**, and the rows are now
   * far enough apart to be worth measuring: replayed one at a time, mean hostiles
   * in contact runs 2.06 at wave one to 3.19 at wave six. Zero-based internally,
   * one-based in the URL.
   *
   * The opening-wave roster discount applies to whichever wave this names, which
   * is right: `AiSystem` seeds the plaza before the match starts whatever wave the
   * match starts on.
   */
  private startWave = 0

  // --- wave bookkeeping ---
  private waveIndex = 0
  /** Hostiles this wave committed to deliver, fixed when it opened. */
  private waveBudget = 0
  /** Of that budget, how many are still to be sent. */
  private remainingToSpawn = 0
  /**
   * Set by `beginWave`, cleared by the first beat that runs, and the reason both
   * the announced wave size and the opening wave's budget are trustworthy.
   *
   * `beginWave` is reached from the `game:started` event, which the HUD emits
   * from its own update; the AI seeds the level from *its* update. So on the
   * frame the match opens, the field the director can see may or may not contain
   * the AI's five soldiers, depending on which ran first — and it read empty in
   * both graded runs. `update` returns early on `dt <= 0`, and `AiSystem` is
   * registered ahead of this system, so by the first beat the seed is on the
   * field and readable. Both the roster discount for the opening wave and the
   * announced size are therefore settled there rather than in `beginWave`.
   */
  private budgetPending = false
  /**
   * True until the first wave of the match has taken its opening beat. That beat
   * is the one that counts the standing field against the roster; see rule 3 in
   * the class header.
   */
  private openingWave = true
  /** Match time of the next reinforcement beat. */
  private nextBeatAt = 0
  /** Beats delivered this wave; the first one is the opening squad. */
  private beatsSent = 0
  private spawnFails = 0
  /**
   * Most live bodies this match has ever held at once.
   *
   * `AiSystem` will not exceed its own `MAX_LIVE`, which counts bodies while
   * `concurrent` counts participants, so the two disagree by exactly the stale
   * stragglers — and a wave can be refused a slot it is entitled to. This is how
   * `deploy` tells that refusal apart from a blocked spawn point without
   * duplicating another system's constant: a refusal while the field is as full
   * as it has ever been is the cap. It is self-calibrating and cannot drift out
   * of step with `MAX_LIVE` the way a copy of the number would.
   *
   * Written only from a successful `deploy`, so it is measured in the same
   * quantity the refusal test reads — `ai.enemies.length` — and cannot be pushed
   * a body high by a corpse awaiting retirement.
   */
  private bodyPeak = 0
  /** Live bodies at the last scan, whether they are in the fight or not. */
  private liveCount = 0
  /** When the field last fell to the tail floor; -1 while the push is live. */
  private settleAt = -1
  /** Set when a wave was written off by the stall backstop rather than fought. */
  private stalled = false
  /**
   * Match time of the last thing that counted as the fight being alive: a
   * contact, damage in either direction, or a kill. Drives {@link WAVE_STALL}.
   */
  private lastCombatAt = 0

  // --- participation ---
  /**
   * Hostiles currently holding contact with the player. A level, not an edge:
   * `ai:contact` opens and `ai:lostContact` closes, and `Behaviour.onRemoved`
   * guarantees the closing edge even for a soldier killed mid-contact.
   */
  private inContact = new Set<number>()
  /**
   * Last match time each hostile did something that proves it is in the fight —
   * spawned, acquired the player, fired at them, or took a round. Ids are
   * dropped on death and pruned at each wave boundary, so this stays at the
   * size of the live field.
   */
  private activeAt = new Map<number, number>()

  // --- scoring bookkeeping ---
  private chain = 0
  private lastKillAt = -99
  private streakStep = 0

  // --- accuracy and fairness ---
  private shotsFired = 0
  private shotsHit = 0
  /**
   * `weapon:fired` is emitted *after* the trace, so a hit is banked here and
   * claimed by the shot that follows it. Counting damage events directly would
   * report over 100% accuracy the moment a round penetrates a wall into two
   * targets, which is a readout nobody believes.
   */
  private pendingHit = false
  private damageTaken = 0

  private awaitingRespawn = false
  private lastSummary: MatchSummary | null = null
  private offs: (() => void)[] = []

  init(ctx: GameContext): void {
    this.ctx = ctx
    this.headless = ctx.config.bot !== null || ctx.config.pose !== null

    for (let i = 0; i < AWARD_RING; i++) {
      this.awards.push({ seq: -1, label: '', points: 0, tone: 'kill', at: 0 })
    }

    this.lives = this.headless ? 0 : readLives()
    this.startWave = readStartWave()
    this.state.livesLeft = this.lives === 0 ? Infinity : this.lives
    this.state.livesMax = this.state.livesLeft

    const e = ctx.events
    this.offs.push(e.on('game:started', () => this.start()))
    this.offs.push(e.on('game:pause', (p) => { this.paused = p.paused }))

    // --- participation tracking ---
    this.offs.push(e.on('entity:spawned', (p) => {
      if (p.entity.team === 'enemy') this.activeAt.set(p.entity.id, this.t)
    }))
    this.offs.push(e.on('ai:contact', (p) => {
      this.inContact.add(p.id)
      this.activeAt.set(p.id, this.t)
      this.lastCombatAt = this.t
    }))
    this.offs.push(e.on('ai:lostContact', (p) => {
      this.inContact.delete(p.id)
      // Not evidence of being in the fight, but evidence of having been in it
      // a moment ago: the staleness clock runs from when contact ended, not
      // from when it began.
      this.activeAt.set(p.id, this.t)
    }))
    this.offs.push(e.on('ai:engaged', (p) => { this.activeAt.set(p.id, this.t) }))
    this.offs.push(e.on('ai:shot', (p) => {
      this.activeAt.set(p.id, this.t)
      this.lastCombatAt = this.t
    }))

    this.offs.push(e.on('weapon:fired', () => {
      this.shotsFired++
      if (this.pendingHit) this.shotsHit++
      this.pendingHit = false
    }))
    this.offs.push(e.on('damage:dealt', (p) => {
      this.lastCombatAt = this.t
      if (p.target.team !== 'enemy') return
      this.pendingHit = true
      // A hostile the player can shoot is one the player has found, whatever
      // its own perception is doing.
      this.activeAt.set(p.target.id, this.t)
    }))
    this.offs.push(e.on('entity:killed', (p) => {
      this.lastCombatAt = this.t
      this.inContact.delete(p.entity.id)
      this.activeAt.delete(p.entity.id)
      this.onKill(p.entity, p.byPlayer, p.headshot)
    }))
    this.offs.push(e.on('player:damaged', (p) => {
      this.lastCombatAt = this.t
      this.damageTaken += p.amount
      this.state.flawlessWave = false
    }))
    this.offs.push(e.on('player:died', () => this.reportPlayerDeath()))
    this.offs.push(e.on('player:respawn', () => { this.awaitingRespawn = false }))

    setMatchService(ctx, this)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.state.phase === 'wave' || this.state.phase === 'break') return
    this.restart()
  }

  restart(): void {
    const s = this.state
    s.phase = 'wave'
    s.score = 0
    s.kills = 0
    s.headshots = 0
    s.streak = 0
    s.bestStreak = 0
    s.deaths = 0
    s.wavesCleared = 0
    s.livesLeft = this.lives === 0 ? Infinity : this.lives
    s.livesMax = s.livesLeft
    this.t = 0
    this.shotsFired = 0
    this.shotsHit = 0
    this.pendingHit = false
    this.damageTaken = 0
    this.chain = 0
    // Anything compared against `t` must be reset with it. `t` restarts at zero,
    // so a stale timestamp from the previous match reads as "recently" for as
    // long as that match ran: `lastKillAt` would award a double kill for the
    // first kill of the new match, and `lastCombatAt` would hold the stall
    // backstop off for a minute.
    this.lastKillAt = -99
    this.lastCombatAt = 0
    this.streakStep = 0
    this.awardSeq = 0
    this.awaitingRespawn = false
    this.lastSummary = null
    this.inContact.clear()
    this.activeAt.clear()
    this.bodyPeak = 0
    this.liveCount = 0
    this.openingWave = true
    this.beginWave(this.startWave)
  }

  /**
   * See the contract on `MatchService.directsSpawning`.
   *
   * Deliberately **not** conditioned on `paused`. Neither `AiSystem` nor
   * `EncounterDirector` pauses, so a director that handed spawning back while
   * the pause menu was open would let a long pause fill the plaza — the one
   * moment the player cannot see it happening. The match still owns the field
   * while paused; it simply stops advancing.
   */
  get directsSpawning(): boolean {
    return this.state.phase === 'wave' || this.state.phase === 'break'
  }

  abandon(): void {
    this.state.phase = 'idle'
    this.state.breakLeft = 0
  }

  reportPlayerDeath(): void {
    if (this.awaitingRespawn) return
    if (this.state.phase !== 'wave' && this.state.phase !== 'break') return
    this.awaitingRespawn = true

    const s = this.state
    s.deaths++
    s.streak = 0
    this.streakStep = 0
    this.chain = 0

    if (this.lives === 0) return
    s.livesLeft = Math.max(0, s.livesLeft - 1)
    if (s.livesLeft <= 0) this.finish(false)
  }

  summary(): MatchSummary | null {
    return this.lastSummary
  }

  seedCapture(score: number, kills: number, streak: number): void {
    if (this.ctx.config.pose === null) return
    const s = this.state
    s.score = score
    s.kills = kills
    s.waveKills = kills
    s.streak = streak
    s.bestStreak = Math.max(s.bestStreak, streak)
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    const s = this.state
    // Publish spawn ownership first, ahead of every early return. `AiSystem`
    // has to get its own reinforcement loop *back* the moment the match stops
    // directing — on abandon, or at the end of a match — or the level goes
    // empty and stays empty. A single boolean store; nothing is allocated.
    const ai = ctx.services.ai as (typeof ctx.services.ai & Reinforcer) | undefined
    if (ai) ai.autoReinforce = !this.directsSpawning

    if (dt <= 0 || this.paused) return
    if (s.phase !== 'wave' && s.phase !== 'break') return

    this.t += dt
    s.elapsed = this.t

    const active = this.countParticipating()
    // Bodies, not participants. This number is read straight onto the objective
    // line, and a participation count there can *rise* — a straggler that
    // reacquires the player rejoins the fight and the counter goes up, which is
    // worse than a counter that stalls. Bodies plus undelivered roster only ever
    // falls within a wave, and every one of them is something the player can
    // shoot.
    s.hostilesLeft = this.liveCount + this.remainingToSpawn

    // Contact is a level, and the events that carry it are edges, so hold the
    // combat clock open for as long as anybody is holding the player. Without
    // this the {@link WAVE_STALL} backstop could fire during a genuine standoff
    // — a soldier pinned behind cover, neither shooting nor being hit — and
    // write off a wave the player was in the middle of.
    if (this.inContact.size > 0) this.lastCombatAt = this.t

    const def = WAVES[this.waveIndex]
    const floor = tailFloor(def)

    if (s.phase === 'break') {
      s.breakLeft = Math.max(0, s.breakLeft - dt)
      // The break runs its scheduled length, with no way to cut it short.
      //
      // It used to be cancelled by `alive > 0`, which skipped the break entirely
      // whenever a wave ended with a straggler standing; that was narrowed to
      // "cancelled while anybody holds contact", which is the same bug for the
      // same reason one step further out. Under the tail floor a break *opens*
      // with survivors on the plaza by design, so any such test fires every time
      // and no break ever runs again.
      //
      // The intent behind it — "being shot at during a break is worse than
      // starting the wave early" — does not survive inspection either: if the
      // plaza is unexpectedly full, opening the next wave adds hostiles to it.
      // The next wave's concurrency gate is the right answer to a crowded field,
      // and it runs on the opening beat whether the break was cut short or not.
      //
      // A fixed break also makes the schedule deterministic, which is what makes
      // `?wave=N` runs comparable with each other and the arc measurable.
      if (s.breakLeft <= 0) this.beginWave(this.waveIndex + 1)
      return
    }

    // --- reinforcement, on a beat ----------------------------------------
    //
    // The beat runs for as long as the wave has anybody left to send, whether
    // or not the field has thinned. That is the whole change: reinforcement
    // used to wait for the field to drop to one or two hostiles, which stopped
    // happening the moment a couple of them lost the player, so every arrival
    // fell through to a twenty-plus second backstop timer. A wave should have a
    // middle, and the middle is made of arrivals.
    if (this.t >= this.nextBeatAt) {
      if (this.budgetPending) {
        this.budgetPending = false
        // `dt > 0` here, so the AI has taken a frame and the field is real.
        //
        // The wave the match opens on counts whoever is already standing against
        // its own roster: those are `AiSystem`'s seeded five and they are part of
        // this wave, not a head start on top of it. Taking `size` flat here is
        // what made wave one field thirteen bodies against wave two's ten and
        // inverted the whole arc. `opening` is the floor, so the wave still has a
        // punch even if the plaza is already busy.
        //
        // Every later wave takes `size` flat, because there the standing field is
        // stragglers and shrinking a wave for those is the mistake this replaced.
        if (this.openingWave) {
          this.remainingToSpawn = Math.max(def.opening, def.size - this.liveCount)
          this.waveBudget = this.remainingToSpawn
        }
        this.openingWave = false
        s.waveSize = this.liveCount + this.remainingToSpawn
      }
      let blocked = false
      if (this.remainingToSpawn > 0) {
        const want = Math.min(this.beatSize(def), def.concurrent - active, this.remainingToSpawn)
        // `want <= 0` means the field is at its concurrency ceiling: skip this
        // beat rather than dropping the wave's budget, and come back on the
        // next one. Presence is capped; the wave is not.
        if (want > 0) blocked = this.deploy(want) === 0
      }
      // After the deploy, so the beat tightens on the budget as it now stands.
      const interval = this.beatInterval(def)
      this.nextBeatAt = this.t + (blocked ? Math.max(interval, SPAWN_RETRY) : interval)
    }

    // --- ending the wave --------------------------------------------------
    //
    // The push is broken when the field has fallen to half the density that
    // defined the wave — not when the plaza is empty. Waiting for empty costs
    // `concurrent / killRate`, which at the measured 0.27 kills/s is twenty-two
    // seconds of diminuendo against seven seconds of holding the line, and the
    // last third of it is hunting hostiles the AI has lost the player to. See
    // {@link tailFloor}.
    if (this.remainingToSpawn === 0 && active <= floor) {
      // Settle briefly rather than clearing on the frame the count crosses, so a
      // hostile mid-reacquire is not written out of its own wave.
      if (this.settleAt < 0) this.settleAt = this.t
      if (this.t - this.settleAt >= WAVE_SETTLE) this.clearWave()
      return
    }
    this.settleAt = -1

    // Backstop. With participation counting, every ordinary shape of stall now
    // resolves above: a wave with budget keeps reinforcing, and a wave without
    // one clears as soon as nobody is fighting. What is left is a wave that can
    // neither deploy — every spawn point blocked, or the AI's live cap reached
    // — nor finish, and that is a deadlock rather than a lull.
    if (this.t - this.lastCombatAt >= WAVE_STALL) {
      this.stalled = true
      this.clearWave()
    }
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  private beginWave(index: number): void {
    const s = this.state
    if (index >= WAVES.length) {
      // Headless runs wrap rather than finish, so measurement keeps going —
      // back to `startWave`, not to wave one, so a run launched to measure late
      // pressure keeps measuring it rather than sliding back to the easy end.
      if (!this.headless) { this.finish(true); return }
      index = this.startWave
      s.wavesCleared = 0
    }
    const def = WAVES[index]
    this.waveIndex = index
    this.pruneParticipation()

    // The budget is `def.size`, flat, on every wave but the one the match opens
    // on — and even there the discount is applied at the first beat rather than
    // here, because the AI's seeded soldiers may not be on the field yet. It used
    // to be `max(opening, size - standing)` on *every* wave, and subtracting the
    // standing field is what hollowed the waves out: a wave shrank in exact
    // proportion to how many hostiles were still on the plaza, which in this
    // build means it shrank as a reward for the AI having lost the player.
    //
    // Presence is `concurrent`'s job and it does it on every beat, so the two
    // are no longer fighting over the same lever. See `WaveDef.size`.
    this.budgetPending = true
    this.waveBudget = def.size
    this.remainingToSpawn = def.size

    s.phase = 'wave'
    s.wave = index + 1
    s.waveLabel = def.label
    // Provisional, and corrected on the first beat once the field is readable.
    s.waveSize = def.size
    s.hostilesLeft = s.waveSize
    s.waveKills = 0
    s.flawlessWave = true
    s.breakLeft = 0

    // The break is the quiet beat, not the walk-in. Once the wave is announced
    // the opening squad goes on the same frame, so the scheduled nine seconds
    // of calm is not silently extended by an interval of nothing happening.
    this.nextBeatAt = this.t
    this.beatsSent = 0
    this.spawnFails = 0
    this.settleAt = -1
    this.stalled = false
    // A wave that opens after a long quiet must not inherit the previous one's
    // silence and trip the backstop on its first frame.
    this.lastCombatAt = this.t
  }

  /**
   * Seconds until the next arrival, tightening as the wave spends its budget.
   *
   * This is the escalation, and it is the shape FEEL_TARGET §6.2 `[measured]`
   * describes for a round-based mode: within a round the spawn delay decays
   * from 2 s toward 0.1 s, so the pressure rises through the round rather than
   * arriving all at once at the start of it.
   */
  private beatInterval(def: WaveDef): number {
    const spent = this.waveBudget > 0 ? 1 - this.remainingToSpawn / this.waveBudget : 1
    return def.openInterval + (def.peakInterval - def.openInterval) * spent
  }

  /** The opening squad arrives together; everything after it trickles. */
  private beatSize(def: WaveDef): number {
    return this.beatsSent === 0 ? def.opening : def.reinforce
  }

  private clearWave(): void {
    const s = this.state
    const def = WAVES[this.waveIndex]
    s.wavesCleared = this.waveIndex + 1

    // A wave pays only if the player actually fought it. Two ways it might not
    // have: the backstop wrote it off after twenty seconds of nothing, or most
    // of its roster never reached the field because the level had nowhere to
    // put them. A shortfall of a hostile or two is the player's win regardless
    // — they killed everyone who showed up — so the bar is half the roster.
    //
    // Clearing at {@link tailFloor} does not count as a shortfall: the roster was
    // delivered, the survivors are still on the plaza, and the next wave will
    // fight them.
    const shortfall = this.remainingToSpawn > this.waveBudget / 2
    const earned = !this.stalled && !shortfall
    if (earned) {
      this.award('WAVE CLEARED', SCORE.wavePerWave * s.wave, 'wave')
      if (s.flawlessWave) this.award('FLAWLESS', SCORE.flawless, 'bonus')
    }

    const last = this.waveIndex + 1 >= WAVES.length
    if (last && !this.headless && earned) { this.finish(true); return }

    s.phase = 'break'
    s.breakLeft = last ? 6 : def.breakSeconds
    this.remainingToSpawn = 0
    // Not zero: the tail floor leaves hostiles standing and the break is spent
    // finishing them. Claiming an empty plaza here would be the same lie the
    // objective line used to tell during the diminuendo, in the other direction.
    s.hostilesLeft = this.liveCount
  }

  /**
   * Asks the AI for `count` more hostiles and believes the field, not the
   * request: `spawnWave` silently delivers fewer when its candidate positions
   * are blocked or its live cap is reached, and a wave that decremented its
   * budget by the request would end waiting on hostiles that never existed.
   *
   * Returns how many actually arrived.
   *
   * ## A full live cap is not a blocked spawn point
   *
   * The two refusals look identical from here and they mean opposite things.
   *
   *  - *Nowhere to put them.* The level's candidate positions are all blocked.
   *    Nothing will change by asking again, so after {@link SPAWN_FAIL_LIMIT}
   *    tries the wave gives up its roster and finishes on whoever arrived.
   *  - *The field is already as full as the engine allows.* `AiSystem`'s
   *    `MAX_LIVE` counts bodies while `concurrent` counts participants, so a wave
   *    entitled to a slot can be refused one by hostiles the player has not
   *    found. Asking again is exactly right: the next kill frees a slot.
   *
   * Treating the second as the first is what pinned the previous table's
   * `concurrent` at eight. Replayed against a straggler model where a hostile the
   * player never finds is never found, a wave at `concurrent` 8 or above forfeits
   * its roster about half delivered: it ends early, having announced a size it
   * then never sent, which is escalation running backwards in exactly the way the
   * panel described. It does not cost contact — the field was already body-capped
   * — so the fix is on the wave's *length* and on the honesty of the number the
   * objective line shows, not on density.
   *
   * {@link bodyPeak} tells them apart without copying another system's constant:
   * a refusal while the field is as full as it has ever been is the cap.
   */
  private deploy(count: number): number {
    const ai = this.ctx.services.ai
    if (!ai) return 0

    const before = ai.enemies.length
    ai.spawnWave(count)
    const got = ai.enemies.length - before

    if (got > 0) {
      this.remainingToSpawn = Math.max(0, this.remainingToSpawn - got)
      this.beatsSent++
      this.spawnFails = 0
      if (ai.enemies.length > this.bodyPeak) this.bodyPeak = ai.enemies.length
      return got
    }

    // The live cap. Keep the roster and come back on the next beat. `bodyPeak`
    // starts at zero, so a level that has never placed anybody still counts its
    // refusals and a wholly blocked match still terminates.
    if (this.bodyPeak > 0 && before >= this.bodyPeak) return 0

    // Nowhere to put them. Give it a few beats, then stop asking and let the wave
    // finish on whoever did arrive — `clearWave` decides whether that still
    // counts as a wave the player cleared.
    this.spawnFails++
    if (this.spawnFails >= SPAWN_FAIL_LIMIT) {
      this.remainingToSpawn = 0
      this.spawnFails = 0
    }
    return 0
  }

  /**
   * Live hostiles that are part of the fight right now.
   *
   * A hostile counts while it holds contact, and for {@link STALE_AFTER}
   * seconds after anything that proved it was engaged — spawning, acquiring the
   * player, firing, or being hit. Past that it is standing somewhere the fight
   * is not, and the wave stops waiting on it.
   *
   * An id with no record is one that predates the match — the soldiers the AI
   * seeds during its own init. It is adopted here rather than being written off
   * for having no history.
   *
   * One pass, and it writes {@link liveCount} on the way through, because the
   * body count and the participation count are wanted on the same frame and the
   * difference between them is the whole subject of this file.
   */
  private countParticipating(): number {
    const ai = this.ctx.services.ai
    if (!ai) { this.liveCount = 0; return 0 }
    let n = 0
    let live = 0
    const list = ai.enemies
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e.alive) continue
      live++
      if (this.inContact.has(e.id)) { n++; continue }
      const at = this.activeAt.get(e.id)
      if (at === undefined) { this.activeAt.set(e.id, this.t); n++; continue }
      if (this.t - at < STALE_AFTER) n++
    }
    this.liveCount = live
    return n
  }

  /**
   * Drops participation records for hostiles that are no longer on the field.
   *
   * `entity:killed` covers the ordinary case; this catches anything removed
   * without one. Runs at wave boundaries only, where iterating a map of at most
   * a dozen entries costs nothing.
   */
  private pruneParticipation(): void {
    const ai = this.ctx.services.ai
    if (!ai) { this.inContact.clear(); this.activeAt.clear(); return }
    for (const id of this.activeAt.keys()) {
      if (!this.isOnField(ai.enemies, id)) this.activeAt.delete(id)
    }
    for (const id of this.inContact) {
      if (!this.isOnField(ai.enemies, id)) this.inContact.delete(id)
    }
  }

  private isOnField(list: readonly Damageable[], id: number): boolean {
    for (let i = 0; i < list.length; i++) if (list[i].id === id && list[i].alive) return true
    return false
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  private onKill(entity: Damageable, byPlayer: boolean, headshot: boolean): void {
    if (!byPlayer || entity.team !== 'enemy') return
    const s = this.state
    if (s.phase !== 'wave' && s.phase !== 'break') return

    s.kills++
    s.waveKills++
    s.streak++
    if (s.streak > s.bestStreak) s.bestStreak = s.streak

    const player = this.ctx.services.player
    const range = player ? entity.position.distanceTo(player.eye) : 0

    this.award('KILL', SCORE.kill, 'kill')
    if (headshot) {
      s.headshots++
      this.award('HEADSHOT', SCORE.headshot, 'bonus')
    }
    if (range > SCORE.longshotRange) this.award('LONGSHOT', SCORE.longshot, 'bonus')

    // Chain: a kill inside the window continues the previous one.
    this.chain = this.t - this.lastKillAt <= SCORE.multiWindow ? this.chain + 1 : 1
    this.lastKillAt = this.t
    if (this.chain >= 2) {
      const i = Math.min(this.chain, SCORE.multi.length - 1)
      this.award(MULTI_LABEL[Math.min(this.chain, MULTI_LABEL.length - 1)], SCORE.multi[i], 'bonus')
    }

    while (
      this.streakStep < SCORE.streakAt.length &&
      s.streak >= SCORE.streakAt[this.streakStep]
    ) {
      this.award(`KILLSTREAK x${SCORE.streakAt[this.streakStep]}`, SCORE.streakPay[this.streakStep], 'bonus')
      this.streakStep++
    }
  }

  private award(label: string, points: number, tone: Award['tone']): void {
    this.state.score += points
    const slot = this.awards[this.awardSeq % AWARD_RING]
    slot.seq = this.awardSeq
    slot.label = label
    slot.points = points
    slot.tone = tone
    slot.at = this.t
    this.awardSeq++
  }

  // -------------------------------------------------------------------------
  // Ending
  // -------------------------------------------------------------------------

  private finish(won: boolean): void {
    const s = this.state
    if (won) this.award('PLAZA SECURED', SCORE.victory, 'wave')
    s.phase = won ? 'victory' : 'defeat'
    s.breakLeft = 0
    if (won) s.hostilesLeft = 0

    const killer = won ? null : this.nearestEnemy()
    const player = this.ctx.services.player
    this.lastSummary = {
      won,
      score: s.score,
      kills: s.kills,
      headshots: s.headshots,
      shotsFired: this.shotsFired,
      shotsHit: this.shotsHit,
      accuracy: this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0,
      bestStreak: s.bestStreak,
      wavesCleared: s.wavesCleared,
      waveCount: WAVES.length,
      deaths: s.deaths,
      timeSurvived: this.t,
      damageTaken: this.damageTaken,
      killedBy: killer ? callsign('enemy', killer.id) : null,
      killedAtRange: killer && player ? killer.position.distanceTo(player.eye) : 0,
      fellOnWave: s.wave,
    }
  }

  /** Best guess at who landed the last round: the nearest hostile still up. */
  private nearestEnemy(): Damageable | null {
    const ai = this.ctx.services.ai
    const player = this.ctx.services.player
    if (!ai || !player) return null
    let best: Damageable | null = null
    let bestD = Infinity
    for (const e of ai.enemies) {
      if (!e.alive) continue
      const d = e.position.distanceToSquared(player.eye)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.offs.length = 0
  }
}

/** `?lives=N`. Zero means the match cannot be lost, which capture runs want. */
function readLives(): number {
  const raw = param('lives')
  if (raw === null) return DEFAULT_LIVES
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LIVES
}

/**
 * `?wave=N`, one-based, clamped to the table.
 *
 * A debug entry point, not a difficulty setting: entering at wave five and
 * clearing five and six still wins the mission, having fought two waves. Do
 * not use it for a scored run — but do use it for a measured one, because it is
 * the only way a ninety-second harness run can see the top of the table.
 */
function readStartWave(): number {
  const raw = param('wave')
  if (raw === null) return 0
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(Math.floor(n) - 1, 0), WAVES.length - 1)
}

function param(key: string): string | null {
  return new URLSearchParams(globalThis.location?.search ?? '').get(key)
}
