import type { Damageable, GameContext, System } from '../core/Types'
import { callsign } from './Callsigns'
import {
  DEFAULT_LIVES, MULTI_LABEL, SCORE, SPAWN_FAIL_LIMIT, SPAWN_RETRY, WAVES,
} from './MatchDefs'
import { setMatchService, type Award, type MatchService, type MatchState, type MatchSummary } from './Match'

/** How many scoring events the HUD can fall behind by before it drops some. */
const AWARD_RING = 24

/**
 * Seconds of complete quiet — no contact, no damage, no kill — after a wave is
 * fully deployed before it is written off and the match moves on.
 *
 * Longer than the longest `maxHold` (26s) would make the guard fire before the
 * ordinary reinforcement logic has had its chance; much shorter and a player
 * genuinely repositioning between engagements would lose a wave they were still
 * fighting. Fifteen seconds is well beyond the 12-28s downtime the pacing aims
 * at while still being a fraction of the 66s stall this was written for.
 */
const WAVE_STALL = 15

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
 * Everything the interface needs is on `state`, one object mutated in place, and
 * on `awards`, a fixed ring. Nothing in `update` allocates.
 *
 * **Nothing here assumes a match finishes.** A scripted run is a fixed number
 * of simulated seconds and is cut off wherever it happens to be, almost always
 * mid-wave. So: every figure the interface reads lives on `state` and is
 * correct at any instant rather than being computed at the end; `summary()` is
 * null until there is one and every caller handles that; and in a headless run
 * the match wraps at the last wave instead of ending, so `directsSpawning`
 * never flips off underneath the other two spawners partway through a
 * measurement.
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
   * A scripted run is a fixed number of simulated seconds, so a sixty-second
   * run only ever sees wave one — the escalation this file exists to produce is
   * unmeasurable by default. This makes any wave reachable directly, so the
   * late-game pressure can be measured on the same length of run as the early
   * game. Zero-based internally, one-based in the URL.
   */
  private startWave = 0

  // --- wave bookkeeping ---
  private waveIndex = 0
  private remainingToSpawn = 0
  private lastSpawnAt = -99
  /** When the field last fell to the wave's `trickle` count; -1 while busy. */
  private thinnedAt = -1
  private spawnFails = 0
  private lastSpawnTry = -99
  /** The first squad of a wave arrives at once; the rest are paced. */
  private openingSquad = false
  /** Set when a wave's remaining hostiles were written off rather than killed. */
  private forfeited = false
  /**
   * Wall time of the last thing that counted as the fight being alive: a
   * contact, damage in either direction, or a kill. Drives {@link WAVE_STALL}.
   */
  private lastCombatAt = 0

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

    // Anything that means the fight is still happening. A wave with hostiles
    // left alive but none of them able to find the player is otherwise a
    // permanent stall, since the only exit from a fully deployed wave is for
    // every one of them to die.
    const alive = () => { this.lastCombatAt = this.t }
    this.offs.push(e.on('ai:contact', alive))
    this.offs.push(e.on('damage:dealt', alive))
    this.offs.push(e.on('player:damaged', alive))
    this.offs.push(e.on('entity:killed', alive))
    this.offs.push(e.on('weapon:fired', () => {
      this.shotsFired++
      if (this.pendingHit) this.shotsHit++
      this.pendingHit = false
    }))
    this.offs.push(e.on('damage:dealt', (p) => {
      if (p.target.team === 'enemy') this.pendingHit = true
    }))
    this.offs.push(e.on('entity:killed', (p) => this.onKill(p.entity, p.byPlayer, p.headshot)))
    this.offs.push(e.on('player:damaged', (p) => {
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
    // Must be reset with the clock: `t` restarts at zero, so a stale timestamp
    // from the previous match would read as "half a second ago" and award a
    // double kill for the first kill of the new one.
    this.lastKillAt = -99
    this.streakStep = 0
    this.awardSeq = 0
    this.awaitingRespawn = false
    this.lastSummary = null
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

    const alive = this.countAlive()
    s.hostilesLeft = alive + this.remainingToSpawn

    if (s.phase === 'break') {
      s.breakLeft = Math.max(0, s.breakLeft - dt)
      // A live hostile during a break means something else is spawning — the AI
      // system's own reinforcement loop, if it has not stood down. Rather than
      // sit in a "break" the player is being shot during, start the wave.
      if (s.breakLeft <= 0 || alive > 0) this.beginWave(this.waveIndex + 1)
      return
    }

    // --- wave: deliver reinforcements ------------------------------------
    const def = WAVES[this.waveIndex]
    if (alive <= def.trickle) {
      if (this.thinnedAt < 0) this.thinnedAt = this.t
    } else {
      this.thinnedAt = -1
    }

    if (this.remainingToSpawn > 0 && alive < def.concurrent) {
      // Three ways a squad becomes due, in the order they matter: the wave has
      // just opened and needs somebody in it; the field has been thin for
      // `regroup` seconds; or nothing has been sent for `maxHold` and the fight
      // has stalled on a hostile who cannot reach the player.
      const regrouped = this.thinnedAt >= 0 && this.t - this.thinnedAt >= def.regroup
      const overdue = this.t - this.lastSpawnAt >= def.maxHold
      if ((this.openingSquad || regrouped || overdue) && this.t - this.lastSpawnTry >= SPAWN_RETRY) {
        this.openingSquad = false
        const want = Math.min(def.squad, def.concurrent - alive, this.remainingToSpawn)
        this.deploy(want)
      }
    }

    if (this.remainingToSpawn === 0 && alive === 0) this.clearWave()

    // Stall guard. `maxHold` above only rescues a wave that still has hostiles
    // left to send; once everything is deployed, the sole exit is `alive === 0`.
    // A hostile that never reaches the player therefore halts the match
    // outright — measured at 66 seconds of complete silence in a 90 second run,
    // with three of five killed and the survivors never making contact. The
    // forfeit path already exists for exactly this shape of problem, so use it.
    else if (this.remainingToSpawn === 0 && alive > 0) {
      if (this.t - this.lastCombatAt >= WAVE_STALL) {
        this.forfeited = true
        this.clearWave()
      }
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

    // Anything already on the field counts against the wave rather than being
    // added to it: the AI spawns six soldiers during its own init, and wave one
    // is those six, not those six plus five more.
    const standing = this.countAlive()
    this.remainingToSpawn = Math.max(0, def.size - standing)

    s.phase = 'wave'
    s.wave = index + 1
    s.waveLabel = def.label
    s.waveSize = standing + this.remainingToSpawn
    s.hostilesLeft = s.waveSize
    s.waveKills = 0
    s.flawlessWave = true
    s.breakLeft = 0

    this.thinnedAt = standing <= def.trickle ? this.t : -1
    this.lastSpawnAt = this.t
    this.lastSpawnTry = -99
    this.spawnFails = 0
    this.forfeited = false
    // The break is the quiet beat, not the walk-in. Once the wave is announced
    // the first squad goes immediately, so the scheduled 10–14 s of calm is not
    // silently extended by another `regroup` of nothing happening.
    this.openingSquad = this.remainingToSpawn > 0
  }

  private clearWave(): void {
    const s = this.state
    const def = WAVES[this.waveIndex]
    s.wavesCleared = this.waveIndex + 1

    // A forfeited wave still advances the match — the alternative is a deadlock
    // — but it pays nothing and it cannot win the mission. Nobody should be
    // handed the plaza because the level ran out of places to stand.
    if (!this.forfeited) {
      this.award('WAVE CLEARED', SCORE.wavePerWave * s.wave, 'wave')
      if (s.flawlessWave) this.award('FLAWLESS', SCORE.flawless, 'bonus')
    }

    const last = this.waveIndex + 1 >= WAVES.length
    if (last && !this.headless && !this.forfeited) { this.finish(true); return }

    s.phase = 'break'
    s.breakLeft = last ? 6 : def.breakSeconds
    s.hostilesLeft = 0
  }

  /**
   * Asks the AI for `count` more hostiles and believes the field, not the
   * request: `spawnWave` silently delivers fewer when its candidate positions
   * are blocked or the live cap is reached, and a wave that decremented its
   * budget by the request would end with hostiles that never existed.
   */
  private deploy(count: number): void {
    const ai = this.ctx.services.ai
    this.lastSpawnTry = this.t
    if (!ai) return

    const before = ai.enemies.length
    ai.spawnWave(count)
    const got = ai.enemies.length - before

    if (got > 0) {
      this.remainingToSpawn = Math.max(0, this.remainingToSpawn - got)
      this.lastSpawnAt = this.t
      this.thinnedAt = -1
      this.spawnFails = 0
      return
    }

    // Nowhere to put them. Give it a few tries, then write off the rest of the
    // wave so the match cannot deadlock on level geometry.
    this.spawnFails++
    if (this.spawnFails >= SPAWN_FAIL_LIMIT) {
      this.remainingToSpawn = 0
      this.spawnFails = 0
      this.forfeited = true
    }
  }

  private countAlive(): number {
    const ai = this.ctx.services.ai
    if (!ai) return 0
    let n = 0
    const list = ai.enemies
    for (let i = 0; i < list.length; i++) if (list[i].alive) n++
    return n
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
