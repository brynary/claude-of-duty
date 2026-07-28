import * as THREE from 'three'
import type { GameContext, HitInfo } from '../core/Types'
import type { Rand } from '../core/Rand'
import type { PhysicsSystem } from '../physics/Physics'
import { difficulty } from '../game/Difficulty'
import type { NavGrid, Steering } from './Navigation'
import type { Soldier } from './Soldier'

export type AiState =
  | 'idle' | 'patrol' | 'investigate' | 'engage' | 'seekCover'
  | 'suppress' | 'flank' | 'reload' | 'retreat' | 'dead'

/** Role handed down by the squad so the whole team does not do one thing. */
export type Role = 'hold' | 'suppress' | 'advance' | 'flank'

const DOWN = new THREE.Vector3(0, -1, 0)

const VIEW_RANGE = 55
/**
 * Cosine of the vision half-angle before and after a soldier is alerted.
 * `sv_botFov "65"` `[stated]` §7.5 is a 32.5° half-angle, which is what an
 * unalerted soldier gets (1.05 rad ≈ 60° is wider than that and stays, because
 * a bot that cannot see the player walk past it at 45° reads as blind rather
 * than as unaware). Once alerted the cone opens to 1.65 rad.
 */
const COS_FOV_CALM = Math.cos(1.05)
const COS_FOV_ALERT = Math.cos(1.65)

/**
 * `ai_threatUpdateInterval "500"` `[stated]` §7.2. The squad re-evaluates who
 * is allowed to shoot at this rate rather than every frame; that latency is
 * what gives the player a window to break contact.
 */
const THREAT_TICK = 0.5

/**
 * How long an attacker token is held.
 *
 * `[estimated]`. Nothing in §7 gives a dwell time — only the clamp itself and
 * the 500 ms re-evaluation tick. The floor stops the pair flickering between
 * soldiers every tick (which would read as six enemies each firing one round);
 * the ceiling is what "hand the token round" means, so the same two soldiers
 * cannot own the fight while four others watch.
 */
const TOKEN_MIN_HOLD = 2.5
const TOKEN_MAX_HOLD = 7

/**
 * Burst length: `sv_botMinFireTime "400"` / `sv_botMaxFireTime "600"` `[stated]`
 * §7.5, at a 0.105 s round spacing (571 RPM — the player's rifle is 780 RPM,
 * and an enemy that out-cycles the player's own weapon sounds wrong). 0.4–0.6 s
 * is therefore a 4–6 round burst.
 */
const BURST_MIN = 0.4
const BURST_MAX = 0.6
const SHOT_INTERVAL = 0.105

/**
 * Gap between bursts. **Not sourced** — §7.5 gives the burst length and no
 * pause, so this is the free variable, and it is the one that sets how much
 * damage two attackers deliver. See {@link PLAYER_DAMAGE} for the budget it is
 * solved against.
 */
const BURST_PAUSE_MIN = 1.6
const BURST_PAUSE_MAX = 2.6

/**
 * Damage one enemy round does to the player before the difficulty multiplier.
 *
 * This is the single lethality knob. Deaths per minute measured **7.77** against
 * a 0.3–1.5 target, and the structural changes do most of the work:
 *
 * | factor | before | after |
 * |---|---|---|
 * | soldiers whose rounds can hit the player | ~6 | **2** (`ai_maxAttackerCount`) |
 * | rounds per second each, sustained | ~3.0 | 5 rounds / 2.63 s = **1.9** |
 * | fraction of the time a token holder is exposed | ~1 | **~0.55** (peek cycle, reloads) |
 * | chance a round is allowed to land at 18 m | ~0.3 geometric | **0.5** (§7.1, explicit roll) |
 *
 * **Do not set this from the average.** Two attackers at 0.96 hits/s and 5 HP a
 * round is 4.8 HP/s, which says 100 HP lasts 21 s — and that number is wrong by
 * a factor of two to fourteen, because the player regenerates **75 HP/s after a
 * 3 s gap** (`PlayerSystem`, MWIII Season 2 patch notes `[stated]` §5.2). The
 * fight is not an averaging process, it is a race between sustained pressure
 * and a very fast reset, and burst pauses of 1.6–2.6 s plus hide phases of
 * 1.2–2.2 s open 3 s gaps often. Simulating the actual cycles — two attackers,
 * their burst and peek timers, 30-round magazines, a 2.5 s reload, the 0.5 roll,
 * against 100 HP with that regen — gives time-to-die at 5 HP a round:
 *
 * | where the two attackers are fighting from | time to die | deaths/min at 40–55% of the run under fire |
 * |---|---|---|
 * | both in cover, peek-cycling | 48.6 s | 0.49 – 0.68 |
 * | one in cover, one in the open | 25.5 s | 0.94 – 1.30 |
 * | both in the open | 13.7 s | 1.75 – 2.40 |
 *
 * 5 HP puts the middle row — the one a real fight spends most of its time in —
 * across the middle of the target band, and keeps the cover row inside it.
 * The bottom row is over, and is meant to be: two enemies standing in the open
 * shooting at you *should* be the thing that kills you, and it is also the case
 * where the player kills them fastest and so spends least time in it.
 *
 * Sensitivity, from the same simulation and worth knowing before touching this:
 * dropping the effective hit chance from 0.5 to 0.4 doubles the time to die,
 * and 0.3 quadruples it. Anything that keeps attackers from having a clear line
 * — losing the token, engagements past 20 m, cover that hides them from
 * themselves — pushes deaths down hard and this number up.
 */
const PLAYER_DAMAGE = 5.0

/**
 * How wide a deliberate miss passes, in metres at the target.
 *
 * `ai_eventDistBullet "96"` = **2.44 m** `[stated]` §7.3 is the distance at
 * which a passing round registers as an event on an AI, so it is the series'
 * own answer to "how close is close enough to notice". Misses are placed inside
 * that band: far enough outside the 0.4 m player capsule that the roll decides
 * the outcome and not the geometry, close enough that the player hears rounds
 * crack past and can tell where they came from.
 */
const MISS_MIN = 0.85
const MISS_MAX = 2.4

/**
 * `sv_botSprintDistance "512"` = **13.0 m** `[stated]` §7.5: a bot sprints only
 * when it is further than this from where it is going. Inside it, it walks.
 *
 * This is the second-largest lever in the file after the attacker clamp, and it
 * is aimed at the 5.4% player accuracy. A soldier crossing the frame at 5.1 m/s
 * at 18 m sweeps 0.28 rad/s, and the synthetic player's aim converges at 9/s,
 * so it sits a steady 0.031 rad — **0.56 m at that range** — behind a target
 * whose torso is 0.35 m wide. It cannot hit that, ever, however good its aim.
 */
const SPRINT_DISTANCE = 13
const WALK_SPEED = 3.2
const SPRINT_SPEED = 5.1

/**
 * What one attacker actually delivers, published so the difficulty model can
 * report an honest time-to-die instead of quoting the cadence this file had
 * before the clamp. Rounds per second is the burst cycle: five rounds at
 * 0.105 s inside a 0.4-0.6 s burst, then a 1.6-2.6 s pause.
 *
 * `exposedFraction` is the part a reader would otherwise get wrong. A token
 * holder is only shooting while it is stepped out of cover and not reloading,
 * which is a little over half the time, so the sustained figure reaching the
 * player is roughly half of `roundsPerSecond`.
 *
 * Note that a time-to-die computed from these — as `Difficulty.effective` does
 * — is an average and will read about twice as lethal as the simulated figures
 * in {@link PLAYER_DAMAGE}, because it cannot see the player's health regen
 * winning back the gaps between bursts.
 */
export const AI_CADENCE = {
  roundsPerSecond: 5 / (0.5 + (BURST_PAUSE_MIN + BURST_PAUSE_MAX) / 2),
  meanDamagePerHit: PLAYER_DAMAGE,
  exposedFraction: 0.55,
} as const

/** Stance dwell: `sv_botMinCrouchTime "2000"` / `Max "4000"` `[stated]` §7.5. */
const HIDE_MIN = 2.0
const HIDE_MAX = 4.0

interface CoverSpot {
  pos: THREE.Vector3
  score: number
  /** Which way the soldier leans when it steps out: +1 or -1. */
  peek: number
  /**
   * Where the soldier stands to shoot from this cover.
   *
   * Cover used to be a position plus a lean, and the two did not agree. The
   * spot is chosen so that a ray from the player to the soldier's chest is
   * *blocked*, and the peek was `leanTarget = ±0.9`, which the spine solves as
   * 0.35+0.4+0.3 = 1.05 × 0.42 × 0.9 = 0.4 rad spread over three bones. Solved
   * against the bind pose that moves the chest hitbox **5.1 cm** sideways and
   * the head 15.0 cm — against the 0.75 m step-out the cover test assumed. So a
   * soldier in cover was never exposed at the chest at all, while its own
   * firing test used the muzzle, which sits 0.6 m further forward and clears
   * the corner. The AI could shoot out of cover the player could not shoot
   * into, which is most of where 5.4% player accuracy came from.
   *
   * The soldier now walks the 0.75 m out and back, and this is where to.
   */
  peekPos: THREE.Vector3
}

/** Shared scratch — behaviour runs for every soldier every frame. */
const T1 = new THREE.Vector3()
const T2 = new THREE.Vector3()
const T3 = new THREE.Vector3()
const T4 = new THREE.Vector3()
const T5 = new THREE.Vector3()
const G1 = new THREE.Vector3()
const G2 = new THREE.Vector3()

export class Squad {
  members: Behaviour[] = []
  /** Rises while anyone has eyes on the player; drives group aggression. */
  alert = 0
  /** How many attacker tokens are out. Read by the HUD-facing debug only. */
  attackers = 0
  /** Raised for capture poses, where the frame wants more muzzles lit. */
  attackerLimit = 0

  private clock = 0
  private threatTimer = 0
  private roleTimer = 0
  private engagedTime = 0
  private ranked: Behaviour[] = []

  update(dt: number, playerPos: THREE.Vector3): void {
    this.clock += dt
    let seeing = 0
    for (const m of this.members) if (m.soldier.alive && m.hasContact) seeing++

    this.alert = seeing > 0 ? Math.min(1, this.alert + dt * 1.5) : Math.max(0, this.alert - dt * 0.25)
    if (seeing > 0) this.engagedTime += dt

    // §7.2: threat is re-evaluated on a 500 ms tick, not every frame.
    this.threatTimer -= dt
    if (this.threatTimer <= 0) {
      this.threatTimer = THREAT_TICK
      this.assignAttackers(playerPos)
    }

    this.roleTimer -= dt
    if (this.roleTimer > 0) return
    this.roleTimer = 2.6

    // Order by distance so the closest soldiers press and the far ones shoot.
    this.ranked.length = 0
    for (const m of this.members) {
      if (m.soldier.alive && m.alerted) this.ranked.push(m)
      else if (m.soldier.alive) m.role = 'hold'
    }
    this.ranked.sort(
      (a, b) => a.soldier.position.distanceToSquared(playerPos) - b.soldier.position.distanceToSquared(playerPos),
    )

    // A firefight where everyone charges is chaos; one where nobody moves is a
    // diorama. One flanker, one closer, everyone else pinning.
    //
    // Two closers became one when the movement speeds came down: a soldier
    // walking in at 3.2 m/s is on screen and shootable for twice as long as one
    // sprinting at 4.7, so half as many of them produce the same pressure and
    // the player can actually resolve who is where.
    const maxAdvance = 1
    const allowFlank = this.ranked.length >= 4 && this.engagedTime > 5
    let advancing = 0
    let flanked = false
    for (let i = 0; i < this.ranked.length; i++) {
      const m = this.ranked[i]
      const dist = m.soldier.position.distanceTo(playerPos)
      if (allowFlank && !flanked && dist > 12 && i >= 1) {
        m.role = 'flank'
        flanked = true
      } else if (advancing < maxAdvance && dist > 9) {
        m.role = 'advance'
        advancing++
      } else {
        m.role = 'suppress'
      }
    }
  }

  /**
   * `ai_maxAttackerCount "2"` `[stated]` §7.2 — the single most important AI
   * constant in the research, and the reason a Call of Duty firefight can put a
   * dozen enemies on screen and stay survivable.
   *
   * At most two soldiers hold an attacker token. Only a token holder's rounds
   * are allowed to damage the player; everyone else suppresses, repositions or
   * waits its turn. This replaces a "two nearest soldiers aim properly, the
   * other four aim roughly" arrangement, which was not the same thing at all:
   * the other four aimed 1.0–2.5 m off, 45% of that offset went into the
   * *vertical* against a target 1.6 m tall, and the aim cone then put a fair
   * share of it back onto the player. Six soldiers firing produced roughly 2.8
   * soldiers' worth of incoming damage, and the player died every 7.7 s.
   *
   * The token is handed round rather than owned. A holder keeps it for at least
   * {@link TOKEN_MIN_HOLD} — below that the pair flickers every tick and reads
   * as six enemies each firing one round — and gives it up after
   * {@link TOKEN_MAX_HOLD} if anyone else is waiting, so the fight moves around
   * the squad instead of being a duel with two soldiers while four watch.
   */
  private assignAttackers(playerPos: THREE.Vector3): void {
    const limit = Math.max(this.attackerLimit, difficulty.maxAttackers())

    let held = 0
    let waiting = 0
    for (const m of this.members) {
      if (m.attacker) held++
      else if (m.readyToAttack()) waiting++
    }

    // Revoke. Losing sight for a moment must not drop the token — a soldier
    // behind cover loses line of sight the instant it ducks, and revoking on
    // that alone hands the fight back and forth twice a second — so the grip is
    // held for {@link TOKEN_MIN_HOLD} past the last sighting.
    for (const m of this.members) {
      if (!m.attacker) continue
      const heldFor = this.clock - m.tokenSince
      const spent = !m.soldier.alive || !m.alerted || m.sightLostFor > TOKEN_MIN_HOLD
      if (spent || (waiting > 0 && heldFor >= TOKEN_MAX_HOLD)) {
        m.releaseToken(this.clock)
        held--
      }
    }

    // Fill the free slots. Order: whoever has waited longest since last holding
    // a token, then whoever is closest. Distance alone always hands it straight
    // back to the soldier it was just taken from.
    while (held < limit) {
      let best: Behaviour | null = null
      let bestKey = -Infinity
      for (const m of this.members) {
        if (m.attacker || !m.readyToAttack()) continue
        const d = Math.sqrt(m.soldier.position.distanceToSquared(playerPos))
        const key = (this.clock - m.tokenReleasedAt) - d * 0.12
        if (key > bestKey) { bestKey = key; best = m }
      }
      if (!best) break
      best.takeToken(this.clock)
      held++
    }

    this.attackers = held
  }
}

export interface BehaviourDeps {
  ctx: GameContext
  physics: PhysicsSystem
  nav: NavGrid
  steering: Steering
  rng: Rand
  squad: Squad
}

export class Behaviour {
  state: AiState = 'idle'
  role: Role = 'hold'
  alerted = false
  hasContact = false
  /**
   * Holds one of the two attacker tokens: this soldier's rounds are the only
   * ones allowed to damage the player. See {@link Squad.assignAttackers}.
   */
  attacker = false
  /** Squad clock when the token was taken and when it was last given up. */
  tokenSince = 0
  tokenReleasedAt = -99

  /** Last position the player was seen or heard at. */
  lastKnown = new THREE.Vector3()
  private awareness = 0
  private timeInState = 0
  private losTimer = 0
  private losClear = false
  /** Whether the player's eye has a clear line to *this soldier's* chest. */
  private exposed = false
  /**
   * May shoot at the player this frame: contact, exposed and a clear muzzle.
   * Cached once per frame in {@link update} because the muzzle test is a
   * raycast and the engage tick asks twice.
   *
   * The `exposed` term is the one rule that makes a firefight fair — a soldier
   * may only shoot at the player from a position the player could shoot back
   * at. `muzzleClear` alone is not that test: the muzzle sits about 0.6 m
   * forward of the chest and off to the right shoulder, so it clears a corner
   * the body is still behind, which is how the AI came to be firing out of
   * cover that return fire could not reach.
   */
  private engageable = false
  private contactTime = 0
  private lostTime = 99

  private path: THREE.Vector3[] = []
  private pathIndex = 0
  private repathTimer = 0
  private destination = new THREE.Vector3()
  private hasDestination = false
  private stuckTimer = 0
  private lastPos = new THREE.Vector3()

  private cover: CoverSpot | null = null
  private coverTimer = 0
  private inCover = false
  private peekTimer = 0
  private peeking = false

  private magazine = 30
  private burstLeft = 4
  private fireTimer = 0
  private burstPause = 0
  /**
   * Seconds left of the sighting-to-first-shot window. Rolled from the
   * difficulty preset — 500–1000 ms on Regular, `[stated]` §7.5 — on the rising
   * edge of contact, and it gates every trigger pull, so the measured reaction
   * time is the rolled number rather than whatever the burst timers happened to
   * be doing.
   */
  private reactionTimer = 0
  /**
   * The first burst after acquiring the player never lands. `[estimated]`, and
   * it is a deliberate addition to §7.1's per-shot roll: the rounds that warn
   * you are being shot at have to arrive before the rounds that hurt, or there
   * is nothing to react to. It is also what makes breaking contact pay.
   */
  private rangingBurst = true
  /** Cone half-angle in radians; tightens the longer a target is held. */
  private aimError = 0.11
  private suppressAim = new THREE.Vector3()

  private patrolTarget = new THREE.Vector3()
  private hasPatrol = false
  private idleLook = 0
  /** Seconds left of a standing order to close on {@link lastKnown}. */
  private huntFor = 0

  // Player state cached once per frame so tick methods never fight over scratch.
  private pPos = new THREE.Vector3()
  private pEye = new THREE.Vector3()
  private firePoint = new THREE.Vector3()

  constructor(readonly soldier: Soldier, private d: BehaviourDeps) {
    this.lastPos.copy(soldier.position)
    this.losTimer = d.rng.range(0, 0.12)
    this.lastKnown.copy(soldier.position)
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  private cachePlayer(): void {
    const p = this.d.ctx.services.player
    if (p) {
      this.pPos.copy(p.position)
      this.pEye.copy(p.eye)
      // Some player rigs report position at eye height; normalise to the feet.
      if (Math.abs(this.pPos.y - this.pEye.y) < 0.2) this.pPos.y = this.pEye.y - 1.62
    } else {
      this.pEye.copy(this.d.ctx.camera.position)
      this.pPos.set(this.pEye.x, this.pEye.y - 1.62, this.pEye.z)
    }
  }

  private updatePerception(dt: number): void {
    const s = this.soldier
    this.losTimer -= dt
    if (this.losTimer <= 0) {
      // Line of sight is the expensive part, so it runs at ~12 Hz with a
      // per-soldier phase offset rather than every frame for everyone.
      this.losTimer = 0.08
      T2.copy(this.pEye).sub(s.eye)
      const dist = T2.length()
      let visible = false
      if (dist < VIEW_RANGE && dist > 0.01) {
        T2.divideScalar(dist)
        T3.set(Math.sin(s.yaw), 0, Math.cos(s.yaw))
        const facing = T3.x * T2.x + T3.z * T2.z
        if (facing > (this.alerted ? COS_FOV_ALERT : COS_FOV_CALM)) {
          visible = !this.d.physics.raycast(s.eye, T2, dist - 0.25, { characters: false })
        }
      }
      this.losClear = visible

      // Exposure is a second, separate line: from the player's eye to this
      // soldier's chest. The two disagree constantly — a soldier behind a low
      // wall sees over it with its head while its chest stays covered — and the
      // difference is exactly the unfairness this file used to ship. Firing is
      // gated on this one, so an enemy shooting at the player is always an
      // enemy the player can shoot back at.
      this.exposed = false
      if (visible) {
        s.chest(T4)
        T2.copy(T4).sub(this.pEye)
        const cd = T2.length()
        if (cd > 0.01) {
          T2.divideScalar(cd)
          this.exposed = !this.d.physics.raycast(this.pEye, T2, cd - 0.3, { characters: false })
        }
      }
    }

    const lostFor = this.lostTime
    if (this.losClear) {
      this.lastKnown.copy(this.pEye)
      const dist = this.soldier.position.distanceTo(this.pEye)
      this.awareness = Math.min(1, this.awareness + dt * (this.alerted ? 6 : 1.6 + 30 / Math.max(6, dist)))
      this.contactTime += dt
      this.lostTime = 0
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.22)
      this.lostTime += dt
      if (this.lostTime > 1.2) this.contactTime = 0
    }
    const had = this.hasContact
    this.hasContact = this.losClear && this.awareness > 0.55
    if (this.awareness > 0.6) this.alerted = true
    else if (this.awareness <= 0.02 && this.lostTime > 12) this.alerted = false

    // Contact transitions are emitted so the play harness can measure reaction
    // time — the gap between a soldier acquiring the player and firing — rather
    // than estimate it. Both edges must fire exactly once per transition.
    if (this.hasContact !== had) {
      const p = this.d.ctx.services.player
      const dist = p ? this.soldier.position.distanceTo(p.eye) : 0
      if (this.hasContact) {
        this.contactAt = this.d.ctx.elapsed
        this.firedSinceContact = false
        // Sighting → first shot, 500-1000 ms on Regular. Rolled here so the
        // measured number is this one and not an artefact of burst timing, and
        // deliberately slower than the 200-350 ms the player needs to kill:
        // "the player, once they see the bot, kills it faster than the bot's
        // own reaction window" is the asymmetry that makes the player the
        // protagonist. Only a fresh sighting re-arms it — a soldier that ducks
        // and pops back up inside a second does not get to be surprised again.
        if (lostFor > 1.5) {
          this.reactionTimer = difficulty.sampleReactionTime(this.d.rng)
          this.rangingBurst = true
        }
        // A soldier that spots the player from behind cover comes out to fight
        // rather than finishing the hide it was in the middle of; otherwise its
        // first shot lands a hide-length after its reaction window closed.
        if (this.state === 'suppress' && !this.peeking && this.peekTimer > 0.3) this.peekTimer = 0.3
        this.d.ctx.events.emit('ai:contact', {
          id: this.soldier.id,
          position: this.soldier.position.clone(),
          distance: dist,
        })
      } else {
        this.d.ctx.events.emit('ai:lostContact', {
          id: this.soldier.id,
          heldFor: this.contactAt > 0 ? this.d.ctx.elapsed - this.contactAt : 0,
        })
      }
    }
  }

  /** Wall-clock time of the current contact, for reaction-time measurement. */
  private contactAt = 0
  private firedSinceContact = false

  /** Seconds since this soldier last had eyes on the player. */
  get sightLostFor(): number {
    return this.lostTime
  }

  /** Eligible to be handed an attacker token right now. */
  readyToAttack(): boolean {
    return this.soldier.alive && this.alerted && this.hasContact
  }

  takeToken(clock: number): void {
    this.attacker = true
    this.tokenSince = clock
    // A soldier that has been waiting its turn behind cover leans out when it
    // gets one, rather than finishing whatever hide it was in the middle of.
    if (this.state === 'suppress' && !this.peeking) this.peekTimer = 0
  }

  releaseToken(clock: number): void {
    this.attacker = false
    this.tokenReleasedAt = clock
  }

  /**
   * A soldier killed while holding contact never reaches `updatePerception`
   * again — `update` returns early once it is dead — so the falling edge has to
   * be emitted from the outside or the event stream never closes the contact.
   * Telemetry counts open contacts to decide whether the run is quiet, so a
   * missing edge silently pins `idleFraction` at zero for the rest of the run.
   */
  onKilled(): void {
    this.attacker = false
    if (!this.hasContact) return
    this.hasContact = false
    this.d.ctx.events.emit('ai:lostContact', {
      id: this.soldier.id,
      heldFor: this.contactAt > 0 ? this.d.ctx.elapsed - this.contactAt : 0,
    })
  }

  /**
   * Sends this soldier toward a point as if it had been told the player is
   * there. Used when a wave arrives: hostiles walk in to contact rather than
   * standing where they spawned waiting to be found. §7.4 `[measured]` — Call
   * of Duty enemies spawn from a trigger volume and move to a scripted
   * destination; the tactical appearance is the level script, not the agent.
   *
   * The window matters. Awareness alone does not survive the walk: it decays at
   * 0.22/s and `investigate` gives up below 0.02, so an order worth 0.45 is
   * spent two seconds into a twenty-second approach and the soldier wanders off
   * to patrol somewhere the player will never go.
   */
  alertTo(point: THREE.Vector3): void {
    this.awareness = Math.max(this.awareness, 0.45)
    this.huntFor = 25
    this.lastKnown.copy(point)
    if (this.state === 'idle' || this.state === 'patrol') this.enter('investigate')
  }

  /** Called by the firing path on the first shot of each contact. */
  protected noteShot(distance: number): void {
    if (this.firedSinceContact) return
    this.firedSinceContact = true
    this.d.ctx.events.emit('ai:engaged', {
      id: this.soldier.id,
      distance,
      sinceContact: this.contactAt > 0 ? this.d.ctx.elapsed - this.contactAt : 0,
    })
  }

  /** Gunfire and explosions; effect falls off with distance. */
  hearNoise(position: THREE.Vector3, radius: number): void {
    const d = this.soldier.position.distanceTo(position)
    if (d > radius) return
    const strength = 1 - d / radius
    this.awareness = Math.min(1, this.awareness + strength * 0.75)
    if (!this.losClear) this.lastKnown.copy(position)
    if (this.awareness > 0.5) this.alerted = true
  }

  /** Being shot is the loudest signal there is. */
  onDamaged(hit: HitInfo): void {
    this.alerted = true
    this.awareness = 1

    // A soldier hit while it is out of cover finishes being out of cover. An
    // enemy that vanishes on the first round to land makes the exchange
    // unreadable and stretches time to kill past the point where the weapon
    // feels responsive: three chest hits kill, they take about 0.23 s of fire
    // at 780 RPM, and a peek that ends after the first of them puts the other
    // two on the far side of a two-second hide. The flinch is already visible;
    // this is what makes it mean something.
    if (this.peeking && this.peekTimer < 1.2) this.peekTimer = 1.2
    if (!this.losClear) {
      this.lastKnown.copy(hit.point).addScaledVector(hit.direction, -14)
      this.lastKnown.y += 1.4
    }
    // Flush a soldier out of cover that is clearly not protecting it. It has to
    // leave the state as well as the spot: `tickSuppress` is the only state
    // that fights from cover and the only one that never looks for new cover,
    // so dropping the spot without dropping the state parks the soldier behind
    // a wall it no longer has a firing line out of.
    if (this.inCover && this.d.rng.bool(0.5)) {
      this.cover = null
      this.coverTimer = 0
      this.inCover = false
      if (this.state === 'suppress') this.enter('engage')
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private setDestination(p: THREE.Vector3, force = false): void {
    if (!force && this.hasDestination && this.destination.distanceToSquared(p) < 1.6) return
    this.destination.copy(p)
    this.hasDestination = true
    this.pathIndex = 0
    if (this.d.nav.findPath(this.soldier.position, p, this.path) === 0) {
      this.path.length = 0
      this.hasDestination = false
    }
  }

  private clearPath(): void {
    this.path.length = 0
    this.pathIndex = 0
    this.hasDestination = false
    this.soldier.moveSpeed = 0
    this.soldier.moveDir.set(0, 0, 0)
  }

  /** @returns true once the soldier has arrived or has nowhere to go. */
  private followPath(dt: number, speed: number): boolean {
    const s = this.soldier
    if (this.pathIndex >= this.path.length) {
      s.moveSpeed = 0
      return true
    }
    const wp = this.path[this.pathIndex]
    T1.set(wp.x - s.position.x, 0, wp.z - s.position.z)
    const dist = T1.length()
    const last = this.pathIndex === this.path.length - 1
    if (dist < (last ? 0.4 : 0.8)) {
      this.pathIndex++
      if (this.pathIndex >= this.path.length) {
        s.moveSpeed = 0
        return true
      }
      return false
    }
    T1.divideScalar(dist)
    // Neighbouring soldiers must not mirror each other into the same corner.
    this.d.steering.setBias(s.id % 2 === 0 ? 1 : -1)
    this.d.steering.avoid(s.eye, T1, T2)
    this.separate(T3)
    T2.add(T3)
    T2.y = 0
    if (T2.lengthSq() < 1e-6) T2.copy(T1)
    s.moveDir.copy(T2).normalize()
    // Ease off near the end so the soldier arrives rather than overshooting.
    s.moveSpeed = speed * (last ? Math.max(0.35, Math.min(1, dist / 1.2)) : 1)

    // A soldier wedged on geometry re-paths instead of grinding forever.
    if (s.position.distanceToSquared(this.lastPos) < 0.0004) {
      this.stuckTimer += dt
      if (this.stuckTimer > 0.7) {
        this.stuckTimer = 0
        this.setDestination(this.destination, true)
      }
    } else {
      this.stuckTimer = 0
      this.lastPos.copy(s.position)
    }
    return false
  }

  private separate(out: THREE.Vector3): void {
    out.set(0, 0, 0)
    for (const other of this.d.squad.members) {
      if (other === this || !other.soldier.alive) continue
      T4.copy(this.soldier.position).sub(other.soldier.position)
      T4.y = 0
      const d2 = T4.lengthSq()
      if (d2 > 1.7 || d2 < 1e-5) continue
      out.addScaledVector(T4.normalize(), (1.3 - Math.sqrt(d2)) * 0.9)
    }
  }

  // -------------------------------------------------------------------------
  // Cover
  // -------------------------------------------------------------------------

  /**
   * Scores nearby standable positions for cover.
   *
   * Three tests, all of which must pass, and the second and third are new:
   *
   * 1. **Hidden.** The line from the player to a crouched chest at the spot is
   *    blocked. This is what makes it cover.
   * 2. **Stays hidden.** The line to a crouched *head* is blocked too. A spot
   *    that covers the chest and leaves the head out is where the old cover
   *    search put half the squad: the synthetic player's target test aims at
   *    1.2 m and its rounds go to the chest, so it spent whole magazines
   *    shooting at a wall with a helmet above it.
   * 3. **Shootable from.** There is a real step-out position, 0.75 m to one
   *    side, from which a standing chest can see the player. Cover with no
   *    firing line is a corner to die in; a spot that cannot be scored is
   *    rejected outright rather than being taken as a last resort, because the
   *    soldier that takes one stops contributing to the fight and the player
   *    never finds out why it is standing there.
   */
  private findCover(): CoverSpot | null {
    const { nav, physics, rng } = this.d
    const s = this.soldier
    let best: CoverSpot | null = null
    const wantRange = this.role === 'advance' ? 10 : 16

    for (let i = 0; i < 14; i++) {
      if (!nav.randomPointNear(s.position, 1.5, 11, rng, G1)) continue
      const distToPlayer = G1.distanceTo(this.pEye)
      if (distToPlayer < 5 || distToPlayer > 34) continue

      // 1 + 2: crouched chest at 0.97 and crouched head at 1.34 both blocked.
      T2.set(G1.x, G1.y + 0.97, G1.z)
      T3.copy(this.pEye).sub(T2)
      const d = T3.length()
      if (d < 0.5) continue
      T3.divideScalar(d)
      if (!physics.raycast(T2, T3, d - 0.3, { characters: false })) continue
      T5.set(G1.x, G1.y + 1.34, G1.z)
      T4.copy(this.pEye).sub(T5).normalize()
      if (!physics.raycast(T5, T4, d - 0.3, { characters: false })) continue

      // 3: step 0.75 m sideways and look for a standing chest line. The step
      // has to land somewhere a soldier can stand, or it walks into the wall it
      // was hiding behind and never gets its shot off.
      let peekDir = 0
      for (const side of [1, -1]) {
        const px = G1.x - T3.z * side * 0.75
        const pz = G1.z + T3.x * side * 0.75
        if (!nav.isWalkable(px, pz)) continue
        T5.set(px, G1.y + 1.32, pz)
        T4.copy(this.pEye).sub(T5)
        const pd = T4.length()
        T4.divideScalar(pd)
        if (!physics.raycast(T5, T4, pd - 0.3, { characters: false })) {
          peekDir = side
          break
        }
      }
      if (peekDir === 0) continue

      const rangeScore = 1 - Math.min(1, Math.abs(distToPlayer - wantRange) / 22)
      const travel = 1 - Math.min(1, s.position.distanceTo(G1) / 12)
      const score = rangeScore * 1.1 + travel * 0.7 - this.crowding(G1) * 1.2
      if (!best || score > best.score) {
        best = {
          pos: G1.clone(),
          score,
          peek: peekDir,
          peekPos: new THREE.Vector3(G1.x - T3.z * peekDir * 0.75, G1.y, G1.z + T3.x * peekDir * 0.75),
        }
      }
    }
    return best
  }

  private crowding(p: THREE.Vector3): number {
    let c = 0
    for (const other of this.d.squad.members) {
      if (other === this || !other.soldier.alive || !other.cover) continue
      const d = other.cover.pos.distanceTo(p)
      if (d < 3) c += 1 - d / 3
    }
    return c
  }

  // -------------------------------------------------------------------------
  // Shooting
  // -------------------------------------------------------------------------

  private muzzleClear(): boolean {
    const s = this.soldier
    T1.copy(this.pEye).sub(s.muzzleWorld)
    const dist = T1.length()
    if (dist < 0.5 || dist > 65) return false
    T1.divideScalar(dist)
    return !this.d.physics.raycast(s.muzzleWorld, T1, dist - 0.4, { characters: false })
  }

  /**
   * Trigger discipline: 0.4–0.6 s of fire then a pause,
   * `sv_botMinFireTime`/`MaxFireTime` `[stated]` §7.5. The reaction window is
   * counted in `update` rather than here, because a soldier that is stepping
   * out of cover is not calling this yet and its reaction still has to be
   * running.
   */
  private fire(dt: number, target: THREE.Vector3, mayHit: boolean): void {
    if (this.reactionTimer > 0) return
    this.fireTimer -= dt
    if (this.burstPause > 0) {
      this.burstPause -= dt
      return
    }
    if (this.fireTimer > 0) return
    if (this.magazine <= 0) {
      this.enter('reload')
      return
    }

    this.fireTimer = SHOT_INTERVAL
    this.magazine--
    this.burstLeft--
    this.shoot(target, mayHit)

    if (this.burstLeft <= 0) {
      this.burstLeft = burstRounds(this.d.rng)
      this.burstPause = this.d.rng.range(BURST_PAUSE_MIN, BURST_PAUSE_MAX)
      // The burst that was learning the range is over; the next one may land.
      this.rangingBurst = false
    }
  }

  /**
   * Places one round. **Roll first, aim second.**
   *
   * §7.1 `[stated]`: hit chance against the player is an explicit dice roll —
   * 50% inside 20.3 m falling to 10% at 50.8 m — and the rounds that lose it
   * are deliberately deflected. That is the opposite of what this used to do,
   * which was to fire into a cone and let the geometry decide, and the two are
   * not interchangeable: a cone tuned to give 50% at 20 m gives far more than
   * 10% at 50 m, and no cone at all can express "two of these six soldiers are
   * allowed to hurt you".
   *
   * So the roll decides, and the tracer is then placed to agree with it. A
   * round that wins goes to the chest; a round that loses is pushed 0.85–2.4 m
   * off — outside the 0.4 m player capsule with room to spare, inside the
   * 2.44 m at which the engine considers a passing round noticeable.
   */
  private shoot(target: THREE.Vector3, mayHit: boolean): void {
    const s = this.soldier
    const { ctx, physics, rng } = this.d
    s.fireVisuals()
    ctx.services.audio?.play('enemyFire', s.muzzleWorld, { volume: 0.85, maxDistance: 110 })

    this.firePoint.copy(target)
    this.firePoint.y += 0.95
    T2.copy(this.firePoint).sub(s.muzzleWorld)
    const dist = T2.length() || 1
    this.noteShot(dist)
    T2.divideScalar(dist)
    // Right and up, in the plane across the line of fire.
    T3.set(-T2.z, 0, T2.x).normalize()
    T4.crossVectors(T2, T3).normalize()

    const willHit = mayHit && !this.rangingBurst && this.attacker && difficulty.rollHit(dist, rng)
    /** Lateral placement at the target, metres: the miss the player can see. */
    let offset = 0

    if (willHit) {
      // Scatter inside the torso rather than on a point, so tracers do not all
      // converge on one pixel of the player's chest.
      offset = rng.spread(0.16)
      T2.addScaledVector(T3, offset / dist)
      T2.addScaledVector(T4, rng.spread(0.22) / dist)
      T2.normalize()
    } else {
      // Mostly lateral: a round placed high or low reads as a wild shot, one
      // that goes past your shoulder reads as a near miss. The aim cone is
      // added to the deflection with the same sign rather than in a random
      // direction, so it can only widen a miss and never walk one back onto
      // the player — the roll is the only thing that decides that.
      const settle = Math.min(1, this.contactTime / 3.2)
      const moving = Math.min(1, s.velocity.length() / 4)
      const spread = this.aimError * (2.0 - settle * 0.9) * (1 + moving * 0.8) * difficulty.aimErrorScale()
      const cone = Math.abs(rng.gaussian()) * spread * 0.8 * dist
      offset = (rng.range(MISS_MIN, MISS_MAX) + cone) * (rng.bool() ? 1 : -1)
      T2.addScaledVector(T3, offset / dist)
      T2.addScaledVector(T4, (rng.spread(0.8) + 0.35) / dist)
      T2.normalize()
    }

    const worldHit = physics.raycast(s.muzzleWorld, T2, 90, { characters: false })
    const wallDist = worldHit ? worldHit.distance : 90
    // A round that won the roll still stops at a wall that got in the way.
    const landed = willHit && wallDist > dist - 0.5

    T5.copy(s.muzzleWorld).addScaledVector(T2, landed ? dist : wallDist)
    ctx.services.fx?.bulletTracer(s.muzzleWorld, T5, 340)

    ctx.events.emit('ai:shot', {
      id: s.id,
      distance: dist,
      aimErrorDeg: THREE.MathUtils.radToDeg(Math.atan2(Math.abs(offset), dist)),
      willHit: landed,
    })

    if (landed) {
      T3.copy(T2).negate()
      const amount = PLAYER_DAMAGE * rng.range(0.9, 1.1) * difficulty.damageToPlayerScale()
      ctx.events.emit('player:damaged', { amount, fromDirection: T3.clone() })
      if (rng.bool(0.3)) ctx.services.fx?.blood(T5, T3, 0.3)
    } else if (worldHit) {
      ctx.services.fx?.impact(worldHit.point, worldHit.normal, worldHit.surface)
    }
  }

  /**
   * Unaimed fire around the last known position, to pin the player down.
   * Cannot hurt the player by construction — it is aimed at the ground near
   * where they were — and it runs at half cadence so a squad that has lost the
   * player is heard rather than felt.
   */
  private suppressFire(dt: number): void {
    if (this.suppressAim.lengthSq() < 1e-6) this.suppressAim.copy(this.lastKnown)
    this.suppressAim.x += this.d.rng.spread(2.4) * dt
    this.suppressAim.z += this.d.rng.spread(2.4) * dt
    this.suppressAim.y = this.lastKnown.y - 1.4
    if (this.suppressAim.distanceToSquared(this.lastKnown) > 12) this.suppressAim.copy(this.lastKnown)
    this.fire(dt, this.suppressAim, false)
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private enter(next: AiState): void {
    if (this.state === next) return
    this.state = next
    this.timeInState = 0
    if (next !== 'engage' && next !== 'suppress') this.soldier.leanTarget = 0
    if (next === 'reload') this.soldier.startReload()
    if (next === 'seekCover' || next === 'flank' || next === 'retreat') this.clearPath()
  }

  update(dt: number): void {
    if (!this.soldier.alive) {
      this.state = 'dead'
      return
    }
    this.timeInState += dt
    this.cachePlayer()
    this.updatePerception(dt)

    // The reaction window runs on the clock, not on the trigger. Ticking it
    // inside `fire` looked equivalent and is not: a soldier that acquires the
    // player from behind cover does not reach `fire` until it has stepped out,
    // so the window would start when the soldier was already in position and
    // the measured sighting-to-first-shot time would be the step-out plus the
    // reaction rather than the reaction. Running it here lets the two overlap,
    // which is also what a soldier does — it moves and readies at the same time.
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt
      if (this.reactionTimer <= 0) {
        // The window has closed: the next opportunity is a shot, not a shot one
        // burst-pause later. Without this the measured sighting-to-first-shot
        // time is the reaction plus whatever the burst timers were mid-way
        // through, which is not the number this file is setting.
        this.burstPause = 0
        this.fireTimer = 0
        this.burstLeft = burstRounds(this.d.rng)
      }
    }

    // One line-of-fire test per frame; see the field for what it means.
    this.engageable = false
    if (this.hasContact && this.exposed) {
      switch (this.state) {
        case 'engage': case 'suppress': case 'flank': case 'seekCover':
          this.engageable = this.muzzleClear()
          break
        default: break
      }
    }

    this.repathTimer -= dt
    this.coverTimer -= dt
    if (this.huntFor > 0) this.huntFor -= dt
    // Every second on target shaves the cone; this is the whole "they are
    // ranging you in" feeling. It bottoms out well short of perfect, because
    // an enemy that never misses is not a difficulty setting, it is a wall.
    this.aimError = THREE.MathUtils.lerp(this.aimError, 0.05, dt * 0.35)

    switch (this.state) {
      case 'idle': this.tickIdle(dt); break
      case 'patrol': this.tickPatrol(dt); break
      case 'investigate': this.tickInvestigate(dt); break
      case 'engage': this.tickEngage(dt); break
      case 'seekCover': this.tickSeekCover(dt); break
      case 'suppress': this.tickSuppress(dt); break
      case 'flank': this.tickFlank(dt); break
      case 'reload': this.tickReload(dt); break
      case 'retreat': this.tickRetreat(dt); break
      case 'dead': break
    }
  }

  private aimAtLastKnown(weight: number): void {
    const s = this.soldier
    s.aimTarget.copy(this.lastKnown)
    s.aimWeight += (weight - s.aimWeight) * 0.12
  }

  private tickIdle(dt: number): void {
    const s = this.soldier
    this.clearPath()
    s.faceTarget = null
    s.stance = 'stand'
    s.aimWeight += (0.18 - s.aimWeight) * 0.05
    // Scan: sweep the head so an idle soldier is not a statue.
    this.idleLook += dt * 0.6
    const look = s.yaw + Math.sin(this.idleLook) * 0.9
    s.aimTarget.set(s.position.x + Math.sin(look) * 12, s.position.y + 1.5, s.position.z + Math.cos(look) * 12)
    if (this.alerted) this.enter('engage')
    else if (this.awareness > 0.15) this.enter('investigate')
    else if (this.timeInState > 3 + this.d.rng.next() * 4) this.enter('patrol')
  }

  private tickPatrol(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.alerted) { this.enter('engage'); return }
    if (this.awareness > 0.15) { this.enter('investigate'); return }
    if (!this.hasPatrol || this.repathTimer <= 0) {
      if (this.d.nav.randomPointNear(s.position, 5, 16, this.d.rng, T1)) {
        this.patrolTarget.copy(T1)
        this.hasPatrol = true
        this.setDestination(this.patrolTarget, true)
      }
      this.repathTimer = 6
    }
    s.faceTarget = null
    s.aimWeight += (0.2 - s.aimWeight) * 0.05
    s.aimTarget.set(s.position.x + Math.sin(s.yaw) * 12, s.position.y + 1.55, s.position.z + Math.cos(s.yaw) * 12)
    if (this.followPath(dt, 2.1)) {
      this.hasPatrol = false
      this.enter('idle')
    }
  }

  private tickInvestigate(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.alerted) { this.enter('engage'); return }
    if (this.awareness <= 0.02 && this.huntFor <= 0) { this.enter('patrol'); return }
    if (this.repathTimer <= 0) {
      this.setDestination(this.lastKnown, true)
      this.repathTimer = 1.5
    }
    this.aimAtLastKnown(0.75)
    s.faceTarget = this.lastKnown
    const left = s.position.distanceTo(this.lastKnown)
    if (this.followPath(dt, travelSpeed(left)) && this.timeInState > 5) this.enter('patrol')
  }

  private tickEngage(dt: number): void {
    const s = this.soldier
    const dist = s.position.distanceTo(this.pPos)

    if (!this.alerted && this.lostTime > 6) { this.enter('patrol'); return }
    if (this.magazine <= 0) { this.enter('reload'); return }
    if (this.role === 'flank') { this.enter('flank'); return }

    if (!this.inCover && this.coverTimer <= 0 && this.role !== 'advance') {
      this.coverTimer = 2.4
      this.cover = this.findCover()
      if (this.cover) { this.enter('seekCover'); return }
    }

    this.aimAtLastKnown(1)
    s.faceTarget = this.lastKnown

    // A soldier that is shooting stands still. Plant-and-fire is what Call of
    // Duty AI actually do, it is what makes them readable, and it is the
    // difference between a target the player can hit and one they cannot: at
    // 18 m a soldier crossing at 4.7 m/s stays half a metre ahead of where the
    // player is aiming, so a fight against a moving squad is unwinnable by aim
    // alone however good the aim is.
    const holding = this.burstLeft > 0 && this.burstPause <= 0 && this.engageable
    if (this.role === 'advance' && dist > 9 && this.lostTime < 3 && !holding) {
      if (this.repathTimer <= 0) {
        this.repathTimer = 0.9
        this.setDestination(this.pPos, true)
      }
      this.followPath(dt, travelSpeed(dist - 9))
      s.stance = 'stand'
    } else {
      this.clearPath()
      s.stance = dist > 14 ? 'crouch' : 'stand'
    }

    if (this.engageable) this.fire(dt, this.pPos, true)
    else if (this.lostTime < 3.5 && this.d.squad.alert > 0.5 && this.d.rng.bool(0.02)) this.enter('suppress')
  }

  private tickSeekCover(dt: number): void {
    const s = this.soldier
    if (!this.cover) { this.enter('engage'); return }
    if (!this.hasDestination) this.setDestination(this.cover.pos, true)
    this.aimAtLastKnown(0.85)
    s.faceTarget = this.lastKnown
    s.stance = 'stand'
    const left = s.position.distanceTo(this.cover.pos)
    if (this.followPath(dt, travelSpeed(left)) || this.timeInState > 6) {
      this.inCover = true
      this.enter('suppress')
    }
  }

  /**
   * Cover fighting: hide, step out, shoot, step back.
   *
   * The step is real now — 0.75 m to the side, walked — rather than a lean the
   * spine solves as 5 cm of chest movement. That single change is what makes
   * the exchange symmetric: while the soldier is out it can shoot and be shot,
   * and while it is behind cover neither is true.
   *
   * The rhythm is set by whether this soldier holds an attacker token. A holder
   * is the one applying pressure, so it is out roughly twice as much as it is
   * in; everyone else spends most of the time down, which is what keeps four
   * suppressing soldiers from reading as four more targets. Hide times come
   * from `sv_botMinCrouchTime`/`Max` 2000/4000 ms `[stated]` §7.5.
   */
  private tickSuppress(dt: number): void {
    const s = this.soldier
    if (this.magazine <= 0) { this.enter('reload'); return }
    if (!this.alerted && this.lostTime > 7) { this.inCover = false; this.enter('patrol'); return }
    if (this.role === 'advance' || this.role === 'flank') { this.inCover = false; this.enter('engage'); return }
    // No spot to work means nothing to peek out of: go and find one rather than
    // standing in the state that never looks.
    if (!this.cover && this.timeInState > 2) { this.inCover = false; this.enter('engage'); return }

    this.clearPath()
    s.faceTarget = this.lastKnown
    this.aimAtLastKnown(1)

    this.peekTimer -= dt
    if (this.peekTimer <= 0) {
      this.peeking = !this.peeking
      const rng = this.d.rng
      // A peek has to be long enough to be a fight. The player needs a 0.34 s
      // reaction, a moment to settle the aim and 0.23 s of fire to land three
      // chest hits, so anything under about 1.2 s exposed is an enemy that
      // cannot be killed on that appearance however well the player shoots.
      this.peekTimer = this.peeking
        ? (this.attacker ? rng.range(2.2, 3.4) : rng.range(1.4, 2.4))
        : (this.attacker ? rng.range(1.2, 2.2) : rng.range(HIDE_MIN, HIDE_MAX))
    }

    const cover = this.cover
    if (cover) {
      // Walking pace over three quarters of a metre: fast enough to read as
      // popping out, slow enough that the player can put rounds on it.
      this.stepTo(this.peeking ? cover.peekPos : cover.pos, 1.7)
      s.leanTarget = this.peeking ? cover.peek * 0.6 : 0
    }
    s.stance = this.peeking ? 'stand' : 'crouch'

    if (!this.peeking) return
    if (this.engageable) this.fire(dt, this.pPos, true)
    else if (this.lostTime > 0.5 && this.lostTime < 6) this.suppressFire(dt)
  }

  private tickFlank(dt: number): void {
    const s = this.soldier
    if (this.role !== 'flank' || this.magazine <= 0) { this.enter('engage'); return }
    if (this.repathTimer <= 0) {
      this.repathTimer = 3
      // Head for a position off to one side of the player, not straight at them.
      T1.set(this.pPos.x - s.position.x, 0, this.pPos.z - s.position.z)
      const d = T1.length() || 1
      T1.divideScalar(d)
      const side = this.soldier.id % 2 === 0 ? 1 : -1
      T2.set(
        this.pPos.x - T1.x * 6 - T1.z * 9 * side,
        this.pPos.y,
        this.pPos.z - T1.z * 6 + T1.x * 9 * side,
      )
      this.setDestination(T2, true)
    }
    this.inCover = false
    s.stance = 'stand'
    s.faceTarget = this.hasContact ? this.lastKnown : null
    this.aimAtLastKnown(this.hasContact ? 1 : 0.5)
    const left = this.hasDestination ? s.position.distanceTo(this.destination) : 0
    const done = this.followPath(dt, travelSpeed(left))
    if (this.engageable) this.fire(dt, this.pPos, true)
    if (done || this.timeInState > 9) {
      this.role = 'suppress'
      this.enter('engage')
    }
  }

  private tickReload(_dt: number): void {
    const s = this.soldier
    s.stance = this.inCover || this.d.squad.alert > 0.4 ? 'crouch' : 'stand'
    s.leanTarget = 0
    this.clearPath()
    this.aimAtLastKnown(0.55)
    s.faceTarget = this.lastKnown
    if (!s.isReloading) {
      this.magazine = 30
      this.burstLeft = burstRounds(this.d.rng)
      this.enter(this.inCover ? 'suppress' : 'engage')
    }
  }

  private tickRetreat(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.repathTimer <= 0) {
      this.repathTimer = 2.5
      T1.copy(s.position).sub(this.lastKnown).setY(0).normalize().multiplyScalar(14).add(s.position)
      if (this.d.nav.nearestWalkable(T1, 6, T2)) this.setDestination(T2, true)
    }
    this.aimAtLastKnown(0.6)
    s.faceTarget = null
    const left = this.hasDestination ? s.position.distanceTo(this.destination) : 0
    if (this.followPath(dt, travelSpeed(left)) || this.timeInState > 7) this.enter('engage')
  }

  /**
   * Walks a short distance without pathfinding: cover step-outs are under a
   * metre and a path query for them would be both wasteful and jerky.
   */
  private stepTo(p: THREE.Vector3, speed: number): void {
    const s = this.soldier
    T1.set(p.x - s.position.x, 0, p.z - s.position.z)
    const d = T1.length()
    if (d < 0.12) {
      s.moveSpeed = 0
      return
    }
    s.moveDir.copy(T1).divideScalar(d)
    s.moveSpeed = Math.min(speed, d * 3.5)
  }

  /**
   * Suppresses cover-seeking for a while, so a soldier fights from where it is.
   * Used by scripted capture poses that need a composed frame.
   */
  holdPosition(seconds: number): void {
    this.coverTimer = seconds
    this.cover = null
    this.inCover = false
  }

  /**
   * Drops the soldier straight into a fight; used to script capture poses.
   *
   * A capture pose is a still frame of a firefight, so it skips the reaction
   * window and the ranging burst — the soldier has been in this fight for a
   * while by the time the shutter opens — and asserts exposure, because the
   * pose camera stands where a player would and these soldiers are placed in
   * the open in front of it.
   */
  forceEngage(target: THREE.Vector3): void {
    this.alerted = true
    this.awareness = 1
    this.hasContact = true
    this.losClear = true
    this.exposed = true
    this.lastKnown.copy(target)
    this.aimError = 0.07
    this.contactTime = 1.2
    this.reactionTimer = 0
    this.rangingBurst = false
    this.burstLeft = 5
    this.enter('engage')
  }
}

/**
 * Travel speed for a soldier with `remaining` metres to go.
 *
 * `sv_botSprintDistance "512"` = 13.0 m `[stated]` §7.5. Sprinting the last few
 * metres of a move is where the old speeds hurt: every reposition inside a
 * firefight — cover to cover, closing on the player — is under 13 m, so the
 * whole fight was fought at a sprint by targets nobody could lead.
 */
function travelSpeed(remaining: number): number {
  return remaining > SPRINT_DISTANCE ? SPRINT_SPEED : WALK_SPEED
}

/** Rounds in one burst: 0.4-0.6 s of fire at the enemy rifle's round spacing. */
function burstRounds(rng: Rand): number {
  return Math.max(1, Math.round(rng.range(BURST_MIN, BURST_MAX) / SHOT_INTERVAL))
}

/** Ground height under a point, for placing spawns. */
export function groundBelow(physics: PhysicsSystem, x: number, y: number, z: number, out: THREE.Vector3): boolean {
  G2.set(x, y, z)
  const hit = physics.raycast(G2, DOWN, 45, { characters: false })
  if (!hit) return false
  out.copy(hit.point)
  return true
}
