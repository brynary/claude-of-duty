import type { Damageable, GameContext, System } from '../core/Types'
import { callsign } from './Callsigns'
import {
  DEFAULT_LIVES, MULTI_LABEL, SCORE, SPAWN_FAIL_LIMIT, SPAWN_RETRY, STALE_AFTER,
  WAVE_SETTLE, WAVE_STALL, WAVES, type WaveDef,
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
   * A ninety-second run reaches the middle of wave three, so the top of the
   * escalation is unmeasurable by default. This makes any wave reachable
   * directly, so late-game pressure can be measured on the same length of run
   * as the early game. Zero-based internally, one-based in the URL.
   */
  private startWave = 0

  // --- wave bookkeeping ---
  private waveIndex = 0
  /** Hostiles this wave committed to deliver, fixed when it opened. */
  private waveBudget = 0
  /** Of that budget, how many are still to be sent. */
  private remainingToSpawn = 0
  /** Match time of the next reinforcement beat. */
  private nextBeatAt = 0
  /** Beats delivered this wave; the first one is the opening squad. */
  private beatsSent = 0
  private spawnFails = 0
  /** When the field last emptied of participants; -1 while the fight is live. */
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
    s.hostilesLeft = active + this.remainingToSpawn

    // Contact is a level, and the events that carry it are edges, so hold the
    // combat clock open for as long as anybody is holding the player. Without
    // this the {@link WAVE_STALL} backstop could fire during a genuine standoff
    // — a soldier pinned behind cover, neither shooting nor being hit — and
    // write off a wave the player was in the middle of.
    if (this.inContact.size > 0) this.lastCombatAt = this.t

    if (s.phase === 'break') {
      s.breakLeft = Math.max(0, s.breakLeft - dt)
      // A hostile *fighting* during a break means something else is spawning,
      // or a straggler has finally found the player. Either way, sitting in a
      // "break" while being shot at is worse than starting the wave early.
      //
      // The test is contact, not `alive > 0`. It used to be the latter, and
      // that is how a wave that ended with two hostiles standing somewhere
      // unreachable skipped its entire scheduled break: `alive` was still two
      // on the first frame of the break, so the next wave opened on the same
      // frame the last one closed and the pacing beat never existed.
      if (s.breakLeft <= 0 || this.inContact.size > 0) this.beginWave(this.waveIndex + 1)
      return
    }

    const def = WAVES[this.waveIndex]

    // --- reinforcement, on a beat ----------------------------------------
    //
    // The beat runs for as long as the wave has anybody left to send, whether
    // or not the field has thinned. That is the whole change: reinforcement
    // used to wait for the field to drop to one or two hostiles, which stopped
    // happening the moment a couple of them lost the player, so every arrival
    // fell through to a twenty-plus second backstop timer. A wave should have a
    // middle, and the middle is made of arrivals.
    if (this.t >= this.nextBeatAt) {
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
    if (this.remainingToSpawn === 0 && active === 0) {
      // Settle briefly rather than clearing on the frame the last participant
      // drops, so a hostile mid-reacquire is not written out of its own wave.
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

    // Hostiles already fighting count against the wave rather than being added
    // to it: the AI seeds the level with five soldiers during its own init, and
    // wave one is those five, not those five plus six more.
    //
    // Never below `opening`, though. A wave that delivers nobody is not a wave,
    // it is the previous one continuing under a new banner — which is exactly
    // what wave one was, since the seeded field covered its whole budget and it
    // spawned nothing at all.
    //
    // `standing` counts participants, so a straggler who lost the player does
    // not shrink the next wave on its way past.
    const standing = this.countParticipating()
    this.waveBudget = Math.max(def.opening, def.size - standing)
    this.remainingToSpawn = this.waveBudget

    s.phase = 'wave'
    s.wave = index + 1
    s.waveLabel = def.label
    s.waveSize = standing + this.remainingToSpawn
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
    s.hostilesLeft = 0
    this.remainingToSpawn = 0
  }

  /**
   * Asks the AI for `count` more hostiles and believes the field, not the
   * request: `spawnWave` silently delivers fewer when its candidate positions
   * are blocked or its live cap is reached, and a wave that decremented its
   * budget by the request would end waiting on hostiles that never existed.
   *
   * Returns how many actually arrived.
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
      return got
    }

    // Nowhere to put them, or the AI's live cap is full of hostiles that will
    // not die. Give it a few beats, then stop asking and let the wave finish on
    // whoever did arrive — `clearWave` decides whether that still counts.
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
   */
  private countParticipating(): number {
    const ai = this.ctx.services.ai
    if (!ai) return 0
    let n = 0
    const list = ai.enemies
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e.alive) continue
      if (this.inContact.has(e.id)) { n++; continue }
      const at = this.activeAt.get(e.id)
      if (at === undefined) { this.activeAt.set(e.id, this.t); n++; continue }
      if (this.t - at < STALE_AFTER) n++
    }
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
 * not use it for a scored run.
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
