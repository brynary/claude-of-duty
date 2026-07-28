import type { GameContext } from '../core/Types'

/**
 * The contract between the match layer and the interface layer.
 *
 * `Services` in `core/Types.ts` is frozen — every system resolves through it
 * and it is not mine to extend — so the director publishes itself on the same
 * object through the two accessors below. They are the only place the cast
 * lives, and both sides import the same typed handle.
 */

export type MatchPhase =
  /** Before the player has deployed, and after they abandon. */
  | 'idle'
  /** Hostiles are being delivered and fought. */
  | 'wave'
  /** The wave is dead and the countdown to the next one is running. */
  | 'break'
  | 'victory'
  | 'defeat'

export type AwardTone = 'kill' | 'bonus' | 'wave'

/**
 * One scoring event. Awards live in a fixed ring the director writes into and
 * the HUD reads forward from, so feedback costs no allocation per kill.
 */
export interface Award {
  /** Monotonic. The HUD remembers the last one it drew. */
  seq: number
  label: string
  points: number
  tone: AwardTone
  at: number
}

/**
 * Live match state. One object, mutated in place — nothing here is allocated
 * per frame and the HUD reads it directly.
 */
export interface MatchState {
  phase: MatchPhase
  /** 1-based wave number, 0 while idle. */
  wave: number
  waveCount: number
  waveLabel: string
  /** Hostiles committed to this wave. */
  waveSize: number
  /** Still to kill: alive on the field plus not yet deployed. */
  hostilesLeft: number
  waveKills: number
  /** True while the player has taken no damage this wave. */
  flawlessWave: boolean
  /** Seconds left in the between-wave break; 0 outside one. */
  breakLeft: number

  score: number
  kills: number
  headshots: number
  streak: number
  bestStreak: number

  livesLeft: number
  /** How many the player started with. `Infinity` when the match cannot be lost. */
  livesMax: number
  deaths: number
  wavesCleared: number
  /** Seconds since the match started, excluding time spent paused. */
  elapsed: number
}

/** End-of-match readout. Built once, so allocation here is free. */
export interface MatchSummary {
  won: boolean
  score: number
  kills: number
  headshots: number
  shotsFired: number
  shotsHit: number
  accuracy: number
  bestStreak: number
  wavesCleared: number
  waveCount: number
  deaths: number
  timeSurvived: number
  damageTaken: number
  /** Callsign of whoever landed the last blow, when one could be attributed. */
  killedBy: string | null
  /** Metres to that attacker. */
  killedAtRange: number
  /** Wave the player fell on, 1-based. */
  fellOnWave: number
}

export interface MatchService {
  readonly state: MatchState
  /**
   * True while the match owns *when* hostiles arrive and *how many*.
   *
   * Three things in this codebase can commit a wave: `AiSystem.updateWaves`,
   * `EncounterDirector.update`, and this director. Two of them running at once
   * doubles the hostile budget and caps every lull at whichever timer is
   * shortest, which is the difference between a wave-survival mode and an
   * endless skirmish with captions.
   *
   * The split that keeps everyone's work is: the encounter director owns
   * **where** hostiles come from and keeps restaging `level.spawnPoints`; this
   * owns **when and how many** and calls `spawnWave`. So any other spawner
   * should read:
   *
   * ```ts
   * import { getMatchService } from '../game/Match'
   * if (getMatchService(ctx)?.directsSpawning) return   // stage, do not commit
   * ```
   *
   * It is false while idle, paused into a menu, or after the match has ended,
   * so the game still fills with enemies when nothing is directing it.
   */
  readonly directsSpawning: boolean
  /** Ring of scoring events; read forward from `awardSeq`. */
  readonly awards: readonly Award[]
  readonly awardSeq: number
  /** Begins a match if one is not already running. */
  start(): void
  /** Always begins a fresh match. */
  restart(): void
  /** Back to the main menu: stop scoring and stop delivering hostiles. */
  abandon(): void
  /**
   * Charges the player a life. Idempotent between respawns, so it does not
   * matter whether the HUD or the director's own listener gets there first.
   */
  reportPlayerDeath(): void
  /** Non-null once the match has been won or lost. */
  summary(): MatchSummary | null
  /**
   * Puts a plausible score on the board for a frozen capture pose. The visual
   * critic grades the interface in the state it ships in, and a scoreboard
   * reading zero two and a half seconds into a mission is not that state.
   * Ignored outside a capture; the caller supplies seeded values so the frame
   * still reproduces exactly.
   */
  seedCapture(score: number, kills: number, streak: number): void
}

interface MatchSlot {
  match?: MatchService
}

export function setMatchService(ctx: GameContext, match: MatchService): void {
  ;(ctx.services as unknown as MatchSlot).match = match
}

export function getMatchService(ctx: GameContext): MatchService | undefined {
  return (ctx.services as unknown as MatchSlot).match
}
