import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { GROUP, type PhysicsSystem } from '../physics/Physics'
import type { Surface } from '../core/Types'

const DEG = Math.PI / 180
const DOWN = new THREE.Vector3(0, -1, 0)
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Locomotion tuning. All distances in metres, speeds in m/s, angles in radians.
 * These numbers are the feel; treat them as the design document.
 *
 * Every value carries the confidence marker from `.ai/FEEL_TARGET.md`:
 * `[stated]` is a developer figure or a shipped engine dvar, `[measured]` is
 * datamined or frame-counted, `[estimated]` is derived and the derivation is
 * given. Anything unmarked is a judgement call with no source behind it.
 */
export const MOVE = {
  radius: 0.32,
  standHeight: 1.80,
  crouchHeight: 1.20,
  slideHeight: 1.05,
  eyeStand: 1.68,
  eyeCrouch: 1.05,
  eyeSlide: 0.84,

  // --- speeds ---------------------------------------------------------------
  /** Hold-to-walk. No published figure; roughly two thirds of a walk. */
  slowWalk: 3.2,
  /** Base locomotion. `[stated]` BO6 4.7, MWIII 5.1-5.5; classic engine 4.826. */
  walk: 4.8,
  /** `[stated]` BO6 6.0-6.7 by weapon class. */
  sprint: 6.6,
  /** `[stated]` "tactical sprint moves you roughly +1 m/s over regular sprint". */
  tacSprint: 7.6,
  /** `[measured]` classic stance multiplier: crouch is 60% of base. */
  crouchScale: 0.60,
  /** 0.5625 x 4.8 = 2.70 m/s. `[stated]` BO6 2.7, MWIII 2.7-2.9. */
  adsScale: 0.5625,
  /** `[stated]` `player_strafeSpeedScale 0.8`. */
  strafeScale: 0.80,
  /** `[stated]` `player_backSpeedScale 0.7`. */
  backScale: 0.70,

  // --- ground friction and acceleration -------------------------------------
  /** `[stated]` `friction "5.5"`. */
  friction: 5.5,
  /** `[stated]` `stopspeed "100"` u/s. Below this, friction is constant. */
  stopSpeed: 2.54,
  /**
   * `[estimated]` — CoD publishes no acceleration dvar; this is the Quake 3
   * default of 10, which the engine lineage makes the defensible guess. The
   * model accelerates at `accel * wishspeed` = 48 m/s^2 at a walk.
   */
  accel: 10,
  /** Air steering rate for the exponential approach. No published figure. */
  airAccel: 3.2,
  slopeAccel: 9,

  // --- gravity and jump -----------------------------------------------------
  /** `[stated]` `g_gravity "800"` u/s^2 = 20.32 m/s^2, 2.07x real gravity. */
  gravity: 20.32,
  /** `[stated]` `jump_height "39"` u = 0.991 m apex, 0.625 s of air time. */
  jumpApex: 0.991,
  terminalSpeed: 55,
  coyoteTime: 0.12,
  jumpBufferTime: 0.16,
  /** `[stated]` `jump_stepSize "18"` u — walked over with no animation. */
  stepHeight: 0.457,
  maxSlope: 50 * DEG,
  slideSlope: 40 * DEG,

  // --- slide ----------------------------------------------------------------
  /** Must be moving faster than a walk, i.e. actually sprinting. */
  slideEntrySpeed: 5.0,
  /** Capped at tac sprint so sliding is never the fastest way to travel. */
  slideBoost: 7.6,
  /** `[stated]` `player_sliding_friction "1.5"` against a standing 5.5. */
  slideFriction: 1.5,
  slideMinTime: 0.22,
  /** Cancelling between `slideMinTime` and here keeps the momentum. */
  slideCancelEnd: 0.45,
  slideMaxTime: 0.75,
  slideExitSpeed: 3.0,
  /** `[stated]` `dive_recharge "1000"` ms. Long enough that spam is not a move. */
  slideCooldown: 1.0,
  /** Turn rate available while sliding, rad/s (66 deg/s). */
  slideSteer: 1.15,

  // --- sprint-out: how long the weapon stays unusable ------------------------
  /** `[stated]` BO6 160-215 ms, MWIII 206-231 ms. */
  sprintOutTime: 0.19,
  /** `[stated]` BO6 270-330 ms — tac sprint costs 105-160 ms more. */
  tacSprintOutTime: 0.31,
  /** `[stated]` BO6 slide-to-fire 330-410 ms. */
  slideOutTime: 0.37,

  // --- mantle ---------------------------------------------------------------
  /** Just above the auto-step: below this the step handles it silently. */
  mantleMinHeight: 0.47,
  mantleMaxHeight: 1.45,
  /** `[stated]` `mantle_check_range "20"` u = 0.508 m of forward reach. */
  mantleReach: 0.51,
  /** `[stated]` `mantle_check_angle "60"` degrees off the surface normal. */
  mantleMaxAngle: 60 * DEG,
  mantleCooldown: 0.3,

  fallHurtSpeed: 11.5,
  fallDeathSpeed: 25,

  /** Seconds of tactical sprint before it drops back to a normal sprint. */
  tacSprintTime: 2.6,
} as const

/**
 * Launch velocity for the stated 0.991 m apex under the stated gravity.
 * `[estimated]` from two stated constants: v = sqrt(2 g h) = 6.345 m/s.
 */
const JUMP_SPEED = Math.sqrt(2 * MOVE.gravity * MOVE.jumpApex)

/** Cosine of the mantle approach limit, hoisted so the check costs nothing. */
const MANTLE_COS = Math.cos(MOVE.mantleMaxAngle)

/** Seconds a failed mantle probe is remembered for. See `probeRested`. */
const MANTLE_PROBE_REST = 0.12

/** Height above the ledge, and radius, of the mantle headroom probe sphere. */
const MANTLE_PROBE_UP = 0.42
const MANTLE_PROBE_R = 0.28

/**
 * Below this, a shape-cast result is a penetration rather than a contact.
 *
 * Rapier's `castShape` is called with `stopAtPenetration`, so a probe sphere
 * that begins already overlapping something returns a time of impact of exactly
 * zero. Read as a distance that says "solid surface zero metres away", which is
 * never what it means: it means the probe started inside something.
 *
 * This is not hypothetical. The same query, one argument out of position, put
 * its interaction-group mask in rapier's `filterFlags` slot; reinterpreted as
 * flags, `WORLD | DEBRIS` is `EXCLUDE_FIXED | EXCLUDE_SENSORS`, so every sphere
 * cast in the game excluded all static level geometry and filtered by no group
 * at all. The nearest thing left to hit was the player's own kinematic capsule,
 * which `crouchFloor`'s probe starts inside by construction — a zero-distance
 * self-hit every frame, on every surface, so once the player crouched they could
 * never stand again. That accounted for a measured 97.5% of a 90-second run
 * spent crouched and 0.17% spent sprinting.
 *
 * The argument order is fixed in `Physics.ts`. The class of failure is not:
 * debris and ragdoll segments are both inside this cast's mask and both pass
 * straight through the player capsule, whose solver filter is empty, so a corpse
 * or a kicked prop resting inside the player's chest still returns zero and
 * would still latch the crouch. Refusing to read zero as a ceiling closes it
 * from this side for good.
 */
const PENETRATION_EPS = 1e-4

/** Seconds for the tactical-sprint meter to refill from empty. */
const TAC_REFILL = 4.0

export type Stance = 'stand' | 'crouch' | 'slide' | 'mantle'

/** Everything the controller needs from the player this frame. */
export interface MoveIntent {
  /** -1..1, +1 is forward. */
  forward: number
  /** -1..1, +1 is right. */
  strafe: number
  yaw: number
  jumpPressed: boolean
  crouchHeld: boolean
  /** Rising edge only — a held crouch key must not re-trigger a slide. */
  crouchPressed: boolean
  sprintHeld: boolean
  tacSprint: boolean
  walkHeld: boolean
  /** 0..1 aim-down-sights blend; suppresses sprint and slows the player. */
  ads: number
  /**
   * Firing — breaks sprint the way it does in CoD. Deliberately *not* set by a
   * reload: §3.3 `[measured]` has sprint cancelling a reload, not the other way
   * round, so a reload must leave the player free to run.
   */
  busy: boolean
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function easeOutCubic(t: number): number {
  const u = 1 - t
  return 1 - u * u * u
}

/** Framerate-independent exponential approach factor. */
function approach(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt)
}

/**
 * The Quake ground-friction model the Call of Duty engine inherited, integrated
 * exactly rather than stepped with Euler so the curve is identical at 30fps and
 * 240fps.
 *
 * The engine's rule is `drop = max(speed, stopspeed) * friction * dt`. Above
 * `stopspeed` that is exponential decay at rate `friction`; below it, a constant
 * `friction * stopspeed` deceleration. Solving both pieces in closed form and
 * handling the crossing inside one frame gives, at the stated constants
 * (friction 5.5, stopspeed 2.54 m/s), a full walk to a dead stop in 0.30 s with
 * half the speed shed in the first 0.126 s.
 *
 * That front-loaded shape is the whole point: an ordinary exponential can be
 * fast off the mark or slow to settle, never both, and a controller tuned to
 * stop in 0.13 s flat — which this one did — reads as weightless.
 */
function applyFriction(speed: number, friction: number, dt: number): number {
  if (speed <= 0 || friction <= 0) return speed
  const floor = MOVE.stopSpeed * friction
  if (speed > MOVE.stopSpeed) {
    const cross = Math.log(speed / MOVE.stopSpeed) / friction
    if (dt <= cross) return speed * Math.exp(-friction * dt)
    return Math.max(0, MOVE.stopSpeed - floor * (dt - cross))
  }
  return Math.max(0, speed - floor * dt)
}

/**
 * Kinematic character controller: acceleration model, stance machine, slide,
 * mantle/vault, jump with coyote time and buffering, slope handling.
 *
 * Owns a Rapier `KinematicCharacterController` driving a capsule. The capsule's
 * collision filter is deliberately empty so that *nothing else in the world can
 * query or collide with the player capsule* — otherwise every weapon raycast
 * fired from the eye would immediately hit the player's own collider. Obstacle
 * filtering for our own sweeps is supplied explicitly per call instead.
 */
export class Locomotion {
  /** Feet position, i.e. the point the capsule stands on. */
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  readonly groundNormal = new THREE.Vector3(0, 1, 0)

  onGround = true
  groundSurface: Surface = 'concrete'
  /** Distance from the feet to the surface below, metres (99 when airborne). */
  groundGap = 0
  steepGround = false

  stance: Stance = 'stand'
  /** 0 standing, 1 fully crouched — drives the camera height and the collider. */
  crouchAmount = 0
  /**
   * True while something overhead is refusing the stand-up. Held crouch is one
   * of the three ways to end up slow with no obvious cause, so the `?stats=1`
   * readout names it rather than leaving the player to guess.
   */
  standBlocked = false
  /**
   * Metres of headroom the last stand-up probe found, or `Infinity` when it
   * found nothing. Only meaningful on frames where the player was trying to
   * rise; `standBlocked` says whether it mattered.
   */
  clearance = Infinity
  height: number = MOVE.standHeight
  eyeHeight: number = MOVE.eyeStand

  isSprinting = false
  isTacSprinting = false
  /** 0..1 sprint fatigue, feeds the breathing amplitude. */
  fatigue = 0
  /** 0..1 tactical sprint left before it drops to a normal sprint. */
  tacSprintLeft = 1

  /**
   * Seconds until the weapon is usable again after sprinting, sliding or
   * mantling. This is the movement half of Call of Duty's sprint-out time; the
   * weapon system owns refusing to fire while it is above zero.
   */
  sprintOut = 0

  isSliding = false
  slideTime = 0
  /** True while releasing crouch would end the slide with the speed intact. */
  slideCancelOpen = false
  /** 0..1 how hard the slide is still driving; drives the camera roll. */
  slideIntensity = 0

  mantleProgress = 0
  mantleHeight = 0

  /** Horizontal speed in m/s, cached each frame. */
  speed = 0

  // --- one-frame signals, consumed by PlayerSystem -------------------------
  justLanded = false
  landImpact = 0
  justJumped = false
  justMantled = false
  justSlid = false

  private physics: PhysicsSystem | null = null
  private body: RAPIER.RigidBody | null = null
  private collider: RAPIER.Collider | null = null
  private controller: RAPIER.KinematicCharacterController | null = null
  private filterGroups = 0
  private filterFlags = 0

  private coyote = 0
  private jumpBuffer = 0
  private slideCooldown = 0
  private mantleCooldown = 0
  private tacSprintTimer = 0
  private colliderHalf = 0
  private snapEnabled = true
  private spawnResolved = false

  private mantleT = 0
  private mantleDur = 0.5
  private readonly mantleFrom = new THREE.Vector3()
  private readonly mantleTo = new THREE.Vector3()

  /** Negative-result memo for the mantle probe; see `probeRested`. */
  private mantleProbeRest = 0
  private mantleProbeYaw = 0
  private mantleProbeHigh = false
  private readonly mantleProbePos = new THREE.Vector3()

  private readonly wish = new THREE.Vector3()
  private readonly slideDir = new THREE.Vector3()
  private readonly v1 = new THREE.Vector3()
  private readonly v2 = new THREE.Vector3()
  private readonly prevPos = new THREE.Vector3()
  private readonly desired = { x: 0, y: 0, z: 0 }
  private readonly bodyPos = { x: 0, y: 0, z: 0 }

  /** Creates the capsule and controller. Physics must already be initialised. */
  attach(physics: PhysicsSystem | null, spawn: THREE.Vector3): void {
    this.position.copy(spawn)
    if (!physics || !physics.world) return
    this.physics = physics

    const world = physics.world
    this.colliderHalf = (MOVE.standHeight - MOVE.radius * 2) * 0.5

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(spawn.x, spawn.y + MOVE.standHeight * 0.5, spawn.z),
    )
    // Membership without a filter: present for our own sweeps, invisible to
    // every other query in the game.
    const inert = (GROUP.PLAYER << 16) | 0
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(this.colliderHalf, MOVE.radius)
        .setCollisionGroups(inert)
        .setSolverGroups(inert)
        .setFriction(0)
        .setRestitution(0),
      this.body,
    )

    const c = world.createCharacterController(0.02)
    c.setUp({ x: 0, y: 1, z: 0 })
    c.setSlideEnabled(true)
    c.enableAutostep(MOVE.stepHeight, 0.16, true)
    c.enableSnapToGround(0.35)
    c.setMaxSlopeClimbAngle(MOVE.maxSlope)
    c.setMinSlopeSlideAngle(MOVE.slideSlope)
    c.setApplyImpulsesToDynamicBodies(true)
    c.setCharacterMass(82)
    c.setNormalNudgeFactor(0.002)
    this.controller = c

    this.filterGroups = (GROUP.PLAYER << 16) | (GROUP.WORLD | GROUP.DEBRIS | GROUP.CHARACTER)
    this.filterFlags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS
  }

  teleport(feet: THREE.Vector3): void {
    this.position.copy(feet)
    this.velocity.set(0, 0, 0)
    // Let the next frame re-seat the feet on whatever floor is actually there.
    this.spawnResolved = false
    this.isSliding = false
    this.slideCancelOpen = false
    this.sprintOut = 0
    this.mantleProgress = 0
    this.mantleProbeRest = 0
    this.crouchAmount = 0
    this.height = MOVE.standHeight
    this.eyeHeight = MOVE.eyeStand
    this.stance = 'stand'
    this.hardSetBody()
  }

  update(dt: number, m: MoveIntent): void {
    this.justLanded = false
    this.justJumped = false
    this.justMantled = false
    this.justSlid = false
    this.landImpact = 0
    if (dt <= 0) return

    if (!this.spawnResolved) this.resolveSpawn()

    this.slideCooldown = Math.max(0, this.slideCooldown - dt)
    this.mantleCooldown = Math.max(0, this.mantleCooldown - dt)
    this.sprintOut = Math.max(0, this.sprintOut - dt)
    this.jumpBuffer = m.jumpPressed ? MOVE.jumpBufferTime : Math.max(0, this.jumpBuffer - dt)
    this.coyote = this.onGround ? MOVE.coyoteTime : Math.max(0, this.coyote - dt)

    this.prevPos.copy(this.position)

    if (this.mantleProgress > 0) {
      this.stepMantle(dt)
    } else {
      this.stepLocomotion(dt, m)
    }

    this.stepStance(dt, m)
    this.syncBody()

    this.speed = Math.hypot(this.velocity.x, this.velocity.z)
    this.slideIntensity = this.isSliding
      ? THREE.MathUtils.clamp((this.speed - 2.4) / 5.0, 0, 1)
      : Math.max(0, this.slideIntensity - dt * 4)

    // Fatigue rises while sprinting and takes far longer to clear — it is what
    // makes the breathing oscillation swell after a long push.
    const fatigueTarget = this.isSprinting ? (this.isTacSprinting ? 1 : 0.72) : 0
    const fk = fatigueTarget > this.fatigue ? 0.34 : 0.22
    this.fatigue += (fatigueTarget - this.fatigue) * approach(fk * 3, dt)
  }

  // --- ground / air motion -------------------------------------------------

  private stepLocomotion(dt: number, m: MoveIntent): void {
    const wasGround = this.onGround

    // Desired direction in world space from yaw.
    const sin = Math.sin(m.yaw)
    const cos = Math.cos(m.yaw)
    let wx = m.strafe * cos - m.forward * sin
    let wz = -m.strafe * sin - m.forward * cos
    const wlen = Math.hypot(wx, wz)
    if (wlen > 1e-4) {
      const inv = Math.min(1, wlen) / wlen
      wx *= inv
      wz *= inv
    }
    this.wish.set(wx, 0, wz)

    this.updateSprintState(dt, m, wlen)

    if (this.isSliding) {
      this.stepSlide(dt, m)
    } else {
      const target = this.targetSpeed(m, wlen)
      if (this.onGround && !this.steepGround) {
        // Friction first, then acceleration along the wish direction only.
        // Doing it in that order is what makes the top speed exact — friction
        // takes a bite each frame and the clamped acceleration puts back
        // precisely as much as was lost — and what gives a direction change its
        // weight: the old heading is shed by friction, not overwritten.
        const speed = Math.hypot(this.velocity.x, this.velocity.z)
        if (speed > 1e-5) {
          const scale = applyFriction(speed, MOVE.friction, dt) / speed
          this.velocity.x *= scale
          this.velocity.z *= scale
        }
        const along = this.velocity.x * wx + this.velocity.z * wz
        const deficit = target - along
        if (deficit > 0) {
          const add = Math.min(MOVE.accel * target * dt, deficit)
          this.velocity.x += wx * add
          this.velocity.z += wz * add
        }
      } else {
        // Air control: steer without adding speed you did not already have.
        const f = approach(MOVE.airAccel, dt)
        const nx = this.velocity.x + (wx * target - this.velocity.x) * f
        const nz = this.velocity.z + (wz * target - this.velocity.z) * f
        const cur = Math.hypot(this.velocity.x, this.velocity.z)
        const cap = Math.max(cur, target)
        const ns = Math.hypot(nx, nz)
        const scale = ns > cap && ns > 1e-5 ? cap / ns : 1
        this.velocity.x = nx * scale
        this.velocity.z = nz * scale
      }
    }

    // Steep ground pushes you back downhill regardless of input.
    if (this.onGround && this.steepGround) {
      const n = this.groundNormal
      const g = MOVE.gravity * MOVE.slopeAccel * 0.1 * dt
      this.velocity.x += n.x * n.y * g
      this.velocity.z += n.z * n.y * g
    }

    // Slide entry: sprint speed plus crouch, on the ground, not on a ramp.
    if (
      m.crouchPressed && this.onGround && !this.steepGround &&
      this.slideCooldown <= 0 && !this.isSliding &&
      Math.hypot(this.velocity.x, this.velocity.z) >= MOVE.slideEntrySpeed
    ) {
      this.startSlide()
    }

    // Jump, with coyote time and a buffered press.
    if (this.jumpBuffer > 0 && (this.onGround || this.coyote > 0) && this.canStand()) {
      const boost = this.isSliding ? 1.12 : 1
      if (this.isSliding) this.endSlide(true)
      this.velocity.x *= boost
      this.velocity.z *= boost
      // Half a gravity step is added back because the integrator takes one off
      // before the body has moved at all; without it the apex lands 10% short
      // of the stated 0.991 m and drifts with the frame rate.
      this.velocity.y = JUMP_SPEED + MOVE.gravity * dt * 0.5
      this.onGround = false
      this.coyote = 0
      this.jumpBuffer = 0
      this.justJumped = true
      this.snapGround(false)
    }

    // Gravity.
    if (this.onGround && this.velocity.y <= 0) {
      // A small downward bias keeps the controller glued to slopes and stairs.
      this.velocity.y = -2.4
    } else {
      this.velocity.y = Math.max(this.velocity.y - MOVE.gravity * dt, -MOVE.terminalSpeed)
    }
    this.snapGround(this.velocity.y <= 0.05)

    // Vault before moving, so the approach reads as one continuous motion.
    if (!this.isSliding && this.tryMantle(m, dt)) {
      this.stepMantle(dt)
      return
    }

    const fallSpeed = -this.velocity.y
    this.move(dt)

    if (!wasGround && this.onGround) {
      this.justLanded = true
      this.landImpact = Math.max(0, fallSpeed)
      this.slideCooldown = Math.min(this.slideCooldown, 0.08)
    }
  }

  private targetSpeed(m: MoveIntent, wlen: number): number {
    if (wlen < 0.05) return 0
    if (this.isSprinting) {
      const s = this.isTacSprinting ? MOVE.tacSprint : MOVE.sprint
      return s * this.directionScale(m, wlen)
    }
    let s: number = m.walkHeld ? MOVE.slowWalk : MOVE.walk
    // Stance and aim multiply, the way the engine's weapon-class and stance
    // tables do, so crouch-aiming is slower than either alone and the crouch
    // penalty arrives with the crouch instead of snapping on at a threshold.
    s *= lerp(1, MOVE.crouchScale, this.crouchAmount)
    s *= lerp(1, MOVE.adsScale, THREE.MathUtils.clamp(m.ads, 0, 1))
    return s * this.directionScale(m, wlen)
  }

  /**
   * Elliptical speed envelope: full speed forward, 0.8 sideways, 0.7 backwards,
   * blending smoothly through the diagonals rather than stepping between three
   * fixed multipliers.
   */
  private directionScale(m: MoveIntent, wlen: number): number {
    const n = Math.max(1, wlen)
    const f = m.forward / n
    const s = m.strafe / n
    const len = Math.hypot(f, s)
    if (len < 1e-4) return 1
    const fs = f >= 0 ? f : f * MOVE.backScale
    return Math.hypot(fs, s * MOVE.strafeScale) / len
  }

  private updateSprintState(dt: number, m: MoveIntent, wlen: number): void {
    // Sprint survives a jump or a lip in the ground; it does not survive
    // aiming, firing, crouching or a slope you are sliding back down.
    const wantsSprint =
      !this.isSliding && m.sprintHeld && m.forward > 0.4 && wlen > 0.1 && !m.busy &&
      m.ads < 0.2 && this.crouchAmount < 0.4 && !this.steepGround
    if (!wantsSprint) {
      // Dropping out of a sprint is the moment the sprint-out timer starts. It
      // is charged here rather than by the weapon system so that every way of
      // leaving a sprint — releasing the key, aiming, cresting a slope — pays
      // the same price.
      if (this.isSprinting) {
        this.chargeSprintOut(this.isTacSprinting ? MOVE.tacSprintOutTime : MOVE.sprintOutTime)
      }
      this.isSprinting = false
      this.isTacSprinting = false
      this.refillTacSprint(dt)
      return
    }
    this.isSprinting = true
    if (m.tacSprint) {
      this.tacSprintTimer += dt
      this.isTacSprinting = this.tacSprintTimer < MOVE.tacSprintTime
    } else {
      this.isTacSprinting = false
      this.refillTacSprint(dt)
    }
    this.tacSprintLeft = THREE.MathUtils.clamp(1 - this.tacSprintTimer / MOVE.tacSprintTime, 0, 1)
  }

  /** Refills over `TAC_REFILL` seconds rather than snapping back to full,
   * because the HUD arc under the reticle reads this directly. */
  private refillTacSprint(dt: number): void {
    if (this.tacSprintTimer > 0) {
      this.tacSprintTimer = Math.max(0, this.tacSprintTimer - dt * (MOVE.tacSprintTime / TAC_REFILL))
    }
    this.tacSprintLeft = THREE.MathUtils.clamp(1 - this.tacSprintTimer / MOVE.tacSprintTime, 0, 1)
  }

  /** The longest pending lockout wins; a slide never shortens a sprint's. */
  private chargeSprintOut(seconds: number): void {
    if (seconds > this.sprintOut) this.sprintOut = seconds
  }

  // --- slide ---------------------------------------------------------------

  private startSlide(): void {
    const s = Math.hypot(this.velocity.x, this.velocity.z)
    this.slideDir.set(this.velocity.x / s, 0, this.velocity.z / s)
    // Boost to the tac-sprint ceiling and no further. A slide that outruns the
    // fastest sustained movement turns slide-cancelling into the only sensible
    // way to cross a map, which is the exact failure MWIII spent a season
    // patching out.
    const boosted = Math.max(s, MOVE.slideBoost)
    this.velocity.x = this.slideDir.x * boosted
    this.velocity.z = this.slideDir.z * boosted
    this.isSliding = true
    this.slideTime = 0
    this.slideCancelOpen = false
    this.stance = 'slide'
    this.isSprinting = false
    this.isTacSprinting = false
    this.justSlid = true
    // Slide-to-fire is measured from the moment the slide starts, so a slide
    // ridden to the end hands the weapon back before the player is up again.
    this.chargeSprintOut(MOVE.slideOutTime)
  }

  /**
   * The trade the cancel window buys: ride the slide out and it ends at walking
   * pace with the weapon already back up, or cancel inside the window and keep
   * roughly 2.5 m/s more speed at the cost of an ordinary sprint-out on top.
   * Speed or the gun, and the cooldown is flat either way so repetition is
   * still bounded at one slide a second.
   */
  private endSlide(cancelled: boolean): void {
    this.isSliding = false
    this.slideTime = 0
    this.slideCancelOpen = false
    this.slideCooldown = MOVE.slideCooldown
    if (cancelled) this.chargeSprintOut(MOVE.sprintOutTime)
  }

  private stepSlide(dt: number, m: MoveIntent): void {
    this.slideTime += dt
    let speed = Math.hypot(this.velocity.x, this.velocity.z)

    // Steer the slide toward where you are looking, at a limited rate.
    if (this.wish.lengthSq() > 0.01) {
      const cross = this.slideDir.x * this.wish.z - this.slideDir.z * this.wish.x
      const dot = THREE.MathUtils.clamp(this.slideDir.x * this.wish.x + this.slideDir.z * this.wish.z, -1, 1)
      const ang = Math.atan2(cross, dot)
      const turn = THREE.MathUtils.clamp(ang, -MOVE.slideSteer * dt, MOVE.slideSteer * dt)
      const c = Math.cos(turn)
      const s = Math.sin(turn)
      const nx = this.slideDir.x * c - this.slideDir.z * s
      const nz = this.slideDir.x * s + this.slideDir.z * c
      this.slideDir.set(nx, 0, nz)
    }

    // Sliding friction is 1.5 against a standing 5.5, so a slide sheds speed at
    // a bit over a quarter of the rate of a walk stop — that ratio is what makes
    // it carry. It ramps back to standing friction over the back half so the
    // slide ends decisively rather than trailing off into a crouch-walk.
    const t = this.slideTime / MOVE.slideMaxTime
    const bite = smoothstep(THREE.MathUtils.clamp((t - 0.45) / 0.55, 0, 1))
    speed = applyFriction(speed, lerp(MOVE.slideFriction, MOVE.friction, bite), dt)

    // Downhill keeps you going, uphill kills it fast.
    const grade = -(this.groundNormal.x * this.slideDir.x + this.groundNormal.z * this.slideDir.z)
    speed += grade * MOVE.gravity * 0.55 * dt

    this.velocity.x = this.slideDir.x * speed
    this.velocity.z = this.slideDir.z * speed

    this.slideCancelOpen =
      this.slideTime >= MOVE.slideMinTime && this.slideTime <= MOVE.slideCancelEnd
    const released = !m.crouchHeld && this.slideTime >= MOVE.slideMinTime
    if (speed < MOVE.slideExitSpeed || this.slideTime > MOVE.slideMaxTime || released || !this.onGround) {
      this.endSlide(released && this.slideCancelOpen)
    }
  }

  // --- mantle / vault ------------------------------------------------------

  /**
   * A failed probe against a wall that is simply too tall would otherwise cost
   * three shape queries every frame for as long as the player leans on it. Once
   * one fails, do not ask again until they have moved or turned — which at a
   * walk is the very next frame, so an approach never loses a frame of
   * responsiveness while standing still costs almost nothing.
   */
  private probeRested(m: MoveIntent, dt: number): boolean {
    if (this.mantleProbeRest <= 0) return false
    this.mantleProbeRest -= dt
    const moved = this.position.distanceToSquared(this.mantleProbePos) > 0.03 * 0.03
    const turned = Math.abs(this.mantleProbeYaw - m.yaw) > 0.09
    if (moved || turned) {
      this.mantleProbeRest = 0
      return false
    }
    return true
  }

  private failProbe(m: MoveIntent): false {
    this.mantleProbeRest = MANTLE_PROBE_REST
    this.mantleProbeYaw = m.yaw
    this.mantleProbePos.copy(this.position)
    return false
  }

  private tryMantle(m: MoveIntent, dt: number): boolean {
    // Intent, not achieved speed: walking into a wall leaves you at zero speed,
    // and that is exactly the moment the player expects to climb it. The
    // threshold is deliberately low so that a diagonal approach still counts.
    if (this.mantleCooldown > 0 || m.forward < 0.25 || !this.physics) return false
    if (this.probeRested(m, dt)) return false

    const fx = -Math.sin(m.yaw)
    const fz = -Math.cos(m.yaw)
    const feetY = this.position.y
    const reach = MOVE.radius + MOVE.mantleReach

    // 1. Is something solid in front? Shin height catches crates, low walls and
    //    sills, whose face runs down to the floor. Waist height catches railings
    //    and table tops, which have a gap underneath and are invisible to a shin
    //    ray. The two heights alternate frame to frame so the common case — open
    //    ground, nothing in front — still costs exactly one query, at the price
    //    of at most one frame of latency on a class of obstacle that could not
    //    be mantled at all before.
    this.mantleProbeHigh = !this.mantleProbeHigh
    this.v2.set(fx, 0, fz)
    this.v1.set(this.position.x, feetY + (this.mantleProbeHigh ? 0.80 : 0.30), this.position.z)
    const wall = this.physics.raycast(this.v1, this.v2, reach)
    // Nothing in front is the cheap answer and is not worth remembering; only a
    // wall that was found and then rejected earns a rest.
    if (!wall) return false
    if (Math.abs(wall.normal.y) > 0.5) return this.failProbe(m)

    // Approach must be within 60 degrees of the surface normal, or a grazing
    // contact would sling the player sideways along a wall they were running
    // past rather than climbing.
    const facing = -(fx * wall.normal.x + fz * wall.normal.z)
    if (facing < MANTLE_COS) return this.failProbe(m)

    // 2. Find the top edge by dropping a ray just past the face. Just past, not
    //    a third of a metre past: a handrail or a fence is thinner than that,
    //    and probing beyond it finds the floor on the far side and reports no
    //    ledge at all. The ray starts above the obstacle and travels straight
    //    down, so it cannot graze the vertical face however close in it is.
    const px = wall.point.x + fx * 0.06
    const pz = wall.point.z + fz * 0.06
    const drop = MOVE.mantleMaxHeight + 0.5
    this.v1.set(px, feetY + drop, pz)
    const top = this.physics.raycast(this.v1, DOWN, drop + 0.15)
    if (!top || top.normal.y < 0.55) return this.failProbe(m)
    const rise = top.point.y - feetY
    if (rise < MOVE.mantleMinHeight || rise > MOVE.mantleMaxHeight) return this.failProbe(m)

    // 3. Sphere-cast upward from the landing spot for headroom. The landing
    //    clears the player's own radius past the face, so a thin obstacle ends
    //    with the player over the far side and falling — a vault — while a solid
    //    one ends with them standing on it.
    //
    //    The one thing this has to decide is whether the crouched player fits on
    //    the far side, so the threshold is `crouchHeight` rather than a number.
    //    The probe sphere sits `MANTLE_PROBE_UP` above the ledge with radius
    //    `MANTLE_PROBE_R`, so its top starts 0.70 m up and a hit at distance `d`
    //    puts the ceiling at `0.70 + d`. The old form refused below d = 0.22,
    //    i.e. 0.92 m of clearance — 0.28 m less than the crouched capsule — so a
    //    mantle could commit the player to a landing they did not fit inside.
    //    Anything taller than a crouch and shorter than a stand needs no test
    //    here at all: the landing leaves `crouchAmount` at 0.65 and `stepStance`
    //    resolves it against the real clearance on the next frame.
    const ex = wall.point.x + fx * (MOVE.radius + 0.12)
    const ez = wall.point.z + fz * (MOVE.radius + 0.12)
    this.v1.set(ex, top.point.y + MANTLE_PROBE_UP, ez)
    const span = MOVE.crouchHeight - MANTLE_PROBE_UP - MANTLE_PROBE_R + 0.05
    const ceiling = this.physics.sphereCast(this.v1, UP, MANTLE_PROBE_R, span)
    // A zero-distance result is a penetration, not a ceiling: see `crouchFloor`.
    if (ceiling && ceiling.distance > PENETRATION_EPS) {
      const room = MANTLE_PROBE_UP + MANTLE_PROBE_R + ceiling.distance
      if (room < MOVE.crouchHeight) return this.failProbe(m)
    }

    this.mantleFrom.copy(this.position)
    this.mantleTo.set(ex, top.point.y + 0.02, ez)
    this.mantleHeight = rise
    // 0.37 s over a knee-high crate, 0.62 s over a chest-high wall — inside the
    // 500 ms `g_mantleBlockTimeBuffer` for the common case, and faster than it
    // was, following BO6's "increased all mantle speeds".
    this.mantleDur = 0.24 + rise * 0.26
    this.mantleT = 0
    this.mantleProgress = 0.0001
    this.mantleProbeRest = 0
    this.stance = 'mantle'
    this.isSliding = false
    // A mantle takes over the whole update — `stepLocomotion`, and with it
    // `updateSprintState`, is skipped for its entire 0.37-0.62 s — so anything
    // that state machine owns freezes rather than being re-evaluated. Left set,
    // `isSprinting` stayed true across a climb the player was not even holding
    // an input for, which reported as sprint time, drove the sprint viewmodel
    // pose and FOV through the animation, and kept the weapon system re-arming
    // its own sprint-out so the gun came back up after the feet landed instead
    // of with them. `startSlide` already clears both for the same reason.
    this.isSprinting = false
    this.isTacSprinting = false
    this.onGround = false
    this.justMantled = true
    // The weapon comes back up as the feet land, not after.
    this.chargeSprintOut(this.mantleDur * 0.8)
    return true
  }

  private stepMantle(dt: number): void {
    this.mantleT = Math.min(1, this.mantleT + dt / this.mantleDur)
    const t = this.mantleT
    // Up first, then over — the shape of the animation is the whole read.
    const vert = easeOutCubic(THREE.MathUtils.clamp(t / 0.6, 0, 1))
    const horiz = smoothstep(THREE.MathUtils.clamp((t - 0.16) / 0.84, 0, 1))

    this.position.x = lerp(this.mantleFrom.x, this.mantleTo.x, horiz)
    this.position.z = lerp(this.mantleFrom.z, this.mantleTo.z, horiz)
    this.position.y = lerp(this.mantleFrom.y, this.mantleTo.y, vert)

    if (dt > 0) {
      const inv = 1 / dt
      this.velocity.set(
        (this.position.x - this.prevPos.x) * inv,
        (this.position.y - this.prevPos.y) * inv,
        (this.position.z - this.prevPos.z) * inv,
      )
    }
    this.mantleProgress = t

    if (t >= 1) {
      this.mantleProgress = 0
      this.mantleCooldown = MOVE.mantleCooldown
      this.stance = 'stand'
      this.onGround = true
      // Step off the ledge walking, not standing dead still.
      const exit = 2.6
      const dx = this.mantleTo.x - this.mantleFrom.x
      const dz = this.mantleTo.z - this.mantleFrom.z
      const dirLen = Math.hypot(dx, dz)
      if (dirLen > 1e-3) {
        this.velocity.x = (dx / dirLen) * exit
        this.velocity.z = (dz / dirLen) * exit
      }
      this.velocity.y = 0
    }
  }

  // --- stance / capsule ----------------------------------------------------

  private stepStance(dt: number, m: MoveIntent): void {
    let target: number
    if (this.isSliding) target = 1
    else if (this.mantleProgress > 0) target = 0.65
    else if (m.crouchHeld) target = 1
    else target = 0

    // A ceiling refuses only as much of the stand-up as it physically has to.
    // The old form pinned the target to whatever `crouchAmount` happened to be
    // when the probe first failed, which froze the stance at an arbitrary depth
    // — 0.65 straight out of a mantle — and, because the pin fed itself, gave
    // the player no way back up even where the ceiling had room for more of
    // them. Solving for the crouch the clearance actually demands means a 1.5 m
    // ceiling produces a 1.5 m player instead of a 1.41 m one held there
    // forever, and it replaces the mantle's blunt one-second forced crouch:
    // the landing arrives at 0.65 and this resolves it on the next frame.
    this.standBlocked = false
    if (target < this.crouchAmount) {
      const floor = this.crouchFloor()
      if (floor > target) {
        target = floor
        this.standBlocked = true
      }
    }

    const k = this.isSliding ? 20 : (target > this.crouchAmount ? 15 : 11)
    this.crouchAmount += (target - this.crouchAmount) * approach(k, dt)
    if (Math.abs(target - this.crouchAmount) < 0.002) this.crouchAmount = target

    const lowHeight = this.isSliding ? MOVE.slideHeight : MOVE.crouchHeight
    const lowEye = this.isSliding ? MOVE.eyeSlide : MOVE.eyeCrouch
    this.height = lerp(MOVE.standHeight, lowHeight, this.crouchAmount)
    this.eyeHeight = lerp(MOVE.eyeStand, lowEye, this.crouchAmount)

    if (!this.isSliding && this.mantleProgress <= 0) {
      this.stance = this.crouchAmount > 0.5 ? 'crouch' : 'stand'
    }

    const half = Math.max(0.02, (this.height - MOVE.radius * 2) * 0.5)
    if (this.collider && Math.abs(half - this.colliderHalf) > 0.001) {
      this.colliderHalf = half
      this.collider.setHalfHeight(half)
    }
  }

  /**
   * The shallowest crouch that fits under whatever is overhead, 0..1, where 0
   * means the player can stand fully upright.
   *
   * Sphere-casts upward from the top of the crouched capsule. The probe sits
   * `crouchHeight - radius` above the feet with radius `radius * 0.92`, so its
   * top starts 1.174 m up and a hit at distance `d` puts the ceiling at
   * `1.174 + d`. Sweeping the 0.65 m that stand-up needs therefore measures
   * clearance across the whole 1.174-1.824 m range, which brackets the crouched
   * and standing heights and lets the answer be a height rather than a refusal.
   */
  private crouchFloor(): number {
    if (!this.physics || this.crouchAmount < 0.05) return 0
    const probe = MOVE.radius * 0.92
    const base = MOVE.crouchHeight - MOVE.radius
    this.v1.set(this.position.x, this.position.y + base, this.position.z)
    const hit = this.physics.sphereCast(this.v1, UP, probe, MOVE.standHeight - MOVE.crouchHeight + 0.05)
    // The probe sphere begins inside the player's own crouched capsule, so a
    // zero-distance result can only ever mean something is overlapping the
    // player — never a ceiling zero metres above their head. See
    // `PENETRATION_EPS` for what reading it the other way cost.
    if (!hit || hit.distance <= PENETRATION_EPS) {
      this.clearance = Infinity
      return 0
    }
    this.clearance = base + probe + hit.distance
    if (this.clearance >= MOVE.standHeight) return 0
    return THREE.MathUtils.clamp(
      (MOVE.standHeight - this.clearance) / (MOVE.standHeight - MOVE.crouchHeight), 0, 1,
    )
  }

  /** Whether the player has room to come all the way up — jumps need it. */
  private canStand(): boolean {
    return this.crouchFloor() <= 0.02
  }

  // --- integration ---------------------------------------------------------

  private snapGround(enable: boolean): void {
    if (!this.controller || enable === this.snapEnabled) return
    this.snapEnabled = enable
    if (enable) this.controller.enableSnapToGround(0.35)
    else this.controller.disableSnapToGround()
  }

  private move(dt: number): void {
    this.desired.x = this.velocity.x * dt
    this.desired.y = this.velocity.y * dt
    this.desired.z = this.velocity.z * dt

    if (!this.controller || !this.collider) {
      // No physics: integrate against an implied floor so the game still runs.
      this.position.x += this.desired.x
      this.position.y += this.desired.y
      this.position.z += this.desired.z
      if (this.position.y <= 0) {
        this.position.y = 0
        this.onGround = true
        this.velocity.y = 0
      } else {
        this.onGround = false
      }
      this.groundNormal.set(0, 1, 0)
      this.steepGround = false
      return
    }

    this.controller.computeColliderMovement(
      this.collider,
      this.desired,
      this.filterFlags,
      this.filterGroups,
    )
    const moved = this.controller.computedMovement()
    this.position.x += moved.x
    this.position.y += moved.y
    this.position.z += moved.z
    this.onGround = this.controller.computedGrounded()

    if (dt > 0) {
      const inv = 1 / dt
      // Re-derive horizontal velocity from what actually happened so walls kill
      // momentum instead of the player smearing along them at full speed.
      this.velocity.x = moved.x * inv
      this.velocity.z = moved.z * inv
      if (this.onGround) {
        if (this.velocity.y < 0) this.velocity.y = 0
      } else if (this.velocity.y > 0 && moved.y * inv < this.velocity.y * 0.4) {
        this.velocity.y = 0 // clipped a ceiling
      }
    }

    this.probeGround()
  }

  private probeGround(): void {
    if (!this.physics) return
    this.v1.set(this.position.x, this.position.y + 0.5, this.position.z)
    const hit = this.physics.raycast(this.v1, DOWN, 1.6)
    if (hit) {
      this.groundGap = hit.distance - 0.5
      if (this.groundGap < 0.4) {
        this.groundNormal.copy(hit.normal)
        this.groundSurface = hit.surface
        this.steepGround = hit.normal.y < Math.cos(MOVE.maxSlope)
        return
      }
    } else {
      this.groundGap = 99
    }
    this.groundNormal.set(0, 1, 0)
    this.steepGround = false
  }

  /** Resolve the spawn onto the floor so the level's convention cannot matter. */
  private resolveSpawn(): void {
    this.spawnResolved = true
    if (!this.physics) return
    this.v1.set(this.position.x, this.position.y + 2.2, this.position.z)
    const hit = this.physics.raycast(this.v1, DOWN, 14)
    if (hit) this.position.y = hit.point.y + 0.02
    else this.position.y = Math.max(0, this.position.y - MOVE.eyeStand)
    this.hardSetBody()
  }

  private syncBody(): void {
    if (!this.body) return
    this.bodyPos.x = this.position.x
    this.bodyPos.y = this.position.y + this.height * 0.5
    this.bodyPos.z = this.position.z
    this.body.setNextKinematicTranslation(this.bodyPos)
  }

  /** Teleport the capsule immediately rather than waiting for the next step. */
  private hardSetBody(): void {
    if (!this.body) return
    this.syncBody()
    this.body.setTranslation(this.bodyPos, false)
    this.physics?.world?.propagateModifiedBodyPositionsToColliders()
  }

  dispose(): void {
    if (!this.physics?.world) return
    if (this.controller) this.physics.world.removeCharacterController(this.controller)
    if (this.body) this.physics.world.removeRigidBody(this.body)
    this.controller = null
    this.collider = null
    this.body = null
  }
}
