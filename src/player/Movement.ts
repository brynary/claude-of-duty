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
 */
export const MOVE = {
  radius: 0.32,
  standHeight: 1.80,
  crouchHeight: 1.20,
  slideHeight: 1.05,
  eyeStand: 1.68,
  eyeCrouch: 1.05,
  eyeSlide: 0.84,

  walk: 3.2,
  run: 4.8,
  sprint: 6.6,
  tacSprint: 8.2,
  crouch: 2.1,
  ads: 2.4,

  /** Exponential rate constants — 1 - e^(-k dt). ~0.1s to full speed. */
  groundAccel: 23,
  groundDecel: 30,
  airAccel: 3.2,
  slopeAccel: 9,

  gravity: 21.0,
  /** 6.3 m/s against 21 m/s^2 is a 0.95m apex in 0.3s — CoD's jump, not Quake's. */
  jumpSpeed: 6.3,
  terminalSpeed: 55,
  coyoteTime: 0.12,
  jumpBufferTime: 0.16,
  stepHeight: 0.36,
  maxSlope: 50 * DEG,
  slideSlope: 40 * DEG,

  slideEntrySpeed: 5.2,
  slideBoost: 8.7,
  slideMinTime: 0.26,
  slideMaxTime: 1.35,
  slideExitSpeed: 2.9,
  slideCooldown: 0.5,
  /** Turn rate available while sliding, rad/s. */
  slideSteer: 1.15,

  /** Below this the autostep handles it; above it we play the climb. */
  mantleMinHeight: 0.42,
  mantleMaxHeight: 1.45,
  mantleCooldown: 0.3,

  fallHurtSpeed: 11.5,
  fallDeathSpeed: 25,

  /** Seconds of tactical sprint before it drops back to a normal sprint. */
  tacSprintTime: 2.6,
} as const

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
  crouchPressed: boolean
  sprintHeld: boolean
  tacSprint: boolean
  walkHeld: boolean
  /** 0..1 aim-down-sights blend; suppresses sprint and slows the player. */
  ads: number
  /** Firing or reloading — breaks sprint the way it does in CoD. */
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
  height: number = MOVE.standHeight
  eyeHeight: number = MOVE.eyeStand

  isSprinting = false
  isTacSprinting = false
  /** 0..1 sprint fatigue, feeds the breathing amplitude. */
  fatigue = 0

  isSliding = false
  slideTime = 0
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
  private forceCrouch = 0
  private tacSprintTimer = 0
  private colliderHalf = 0
  private snapEnabled = true
  private spawnResolved = false

  private mantleT = 0
  private mantleDur = 0.5
  private readonly mantleFrom = new THREE.Vector3()
  private readonly mantleTo = new THREE.Vector3()

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
    this.mantleProgress = 0
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
    this.forceCrouch = Math.max(0, this.forceCrouch - dt)
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
        const k = wlen > 0.05 ? MOVE.groundAccel : MOVE.groundDecel
        const f = approach(k, dt)
        this.velocity.x += (wx * target - this.velocity.x) * f
        this.velocity.z += (wz * target - this.velocity.z) * f
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
    if (this.jumpBuffer > 0 && (this.onGround || this.coyote > 0) && this.canStand(true)) {
      const boost = this.isSliding ? 1.12 : 1
      if (this.isSliding) this.endSlide(0.18)
      this.velocity.x *= boost
      this.velocity.z *= boost
      this.velocity.y = MOVE.jumpSpeed
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
    if (!this.isSliding && this.tryMantle(m)) {
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
    let s: number = MOVE.run
    if (m.walkHeld) s = MOVE.walk
    if (this.crouchAmount > 0.55) s = MOVE.crouch
    if (m.ads > 0.05) s = Math.min(s, lerp(MOVE.run, MOVE.ads, m.ads))
    if (this.isSprinting) s = this.isTacSprinting ? MOVE.tacSprint : MOVE.sprint
    // Strafing and backing up are slower, as they should be.
    const dirScale = m.forward < -0.1 ? 0.78 : (Math.abs(m.strafe) > 0.5 && Math.abs(m.forward) < 0.5 ? 0.88 : 1)
    return s * dirScale
  }

  private updateSprintState(dt: number, m: MoveIntent, wlen: number): void {
    // Sprint survives a jump or a lip in the ground; it does not survive
    // aiming, firing, crouching or a slope you are sliding back down.
    const wantsSprint =
      !this.isSliding && m.sprintHeld && m.forward > 0.4 && wlen > 0.1 && !m.busy &&
      m.ads < 0.2 && this.crouchAmount < 0.4 && !this.steepGround
    if (!wantsSprint) {
      this.isSprinting = false
      this.isTacSprinting = false
      this.tacSprintTimer = 0
      return
    }
    this.isSprinting = true
    if (m.tacSprint) {
      this.tacSprintTimer += dt
      this.isTacSprinting = this.tacSprintTimer < MOVE.tacSprintTime
    } else {
      this.tacSprintTimer = 0
      this.isTacSprinting = false
    }
  }

  // --- slide ---------------------------------------------------------------

  private startSlide(): void {
    const s = Math.hypot(this.velocity.x, this.velocity.z)
    this.slideDir.set(this.velocity.x / s, 0, this.velocity.z / s)
    const boosted = Math.max(s, MOVE.slideBoost)
    this.velocity.x = this.slideDir.x * boosted
    this.velocity.z = this.slideDir.z * boosted
    this.isSliding = true
    this.slideTime = 0
    this.stance = 'slide'
    this.isSprinting = false
    this.isTacSprinting = false
    this.justSlid = true
  }

  private endSlide(cooldownScale = 1): void {
    this.isSliding = false
    this.slideTime = 0
    this.slideCooldown = MOVE.slideCooldown * cooldownScale
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

    // Friction curve: almost frictionless for the first third, then it bites.
    const t = this.slideTime / MOVE.slideMaxTime
    const friction = lerp(1.1, 7.5, smoothstep(THREE.MathUtils.clamp(t * 1.25, 0, 1)))
    speed = Math.max(0, speed - friction * dt)

    // Downhill keeps you going, uphill kills it fast.
    const grade = -(this.groundNormal.x * this.slideDir.x + this.groundNormal.z * this.slideDir.z)
    speed += grade * MOVE.gravity * 0.55 * dt

    this.velocity.x = this.slideDir.x * speed
    this.velocity.z = this.slideDir.z * speed

    const released = !m.crouchHeld && this.slideTime > MOVE.slideMinTime
    if (speed < MOVE.slideExitSpeed || this.slideTime > MOVE.slideMaxTime || released || !this.onGround) {
      this.endSlide(released ? 0.6 : 1)
    }
  }

  // --- mantle / vault ------------------------------------------------------

  private tryMantle(m: MoveIntent): boolean {
    // Intent, not achieved speed: walking into a wall leaves you at zero speed,
    // and that is exactly the moment the player expects to climb it.
    if (this.mantleCooldown > 0 || m.forward < 0.4 || !this.physics) return false

    const fx = -Math.sin(m.yaw)
    const fz = -Math.cos(m.yaw)
    const feetY = this.position.y

    // 1. Is something solid in front, at shin height? (Catches low crates too.)
    this.v1.set(this.position.x, feetY + 0.32, this.position.z)
    this.v2.set(fx, 0, fz)
    const wall = this.physics.raycast(this.v1, this.v2, MOVE.radius + 0.5)
    if (!wall || Math.abs(wall.normal.y) > 0.5) return false

    // 2. Find its top edge by dropping a ray just past the face.
    const px = wall.point.x + fx * 0.3
    const pz = wall.point.z + fz * 0.3
    const drop = MOVE.mantleMaxHeight + 0.5
    this.v1.set(px, feetY + drop, pz)
    const top = this.physics.raycast(this.v1, DOWN, drop + 0.15)
    if (!top || top.normal.y < 0.55) return false
    const rise = top.point.y - feetY
    if (rise < MOVE.mantleMinHeight || rise > MOVE.mantleMaxHeight) return false

    // 3. Sphere-cast upward from the landing spot for headroom.
    const ex = px + fx * 0.28
    const ez = pz + fz * 0.28
    this.v1.set(ex, top.point.y + 0.42, ez)
    const ceiling = this.physics.sphereCast(this.v1, UP, 0.28, 0.85)
    if (ceiling && ceiling.distance < 0.22) return false
    if (ceiling && ceiling.distance < 0.8) this.forceCrouch = 1.0

    this.mantleFrom.copy(this.position)
    this.mantleTo.set(ex, top.point.y + 0.02, ez)
    this.mantleHeight = rise
    this.mantleDur = 0.3 + rise * 0.32
    this.mantleT = 0
    this.mantleProgress = 0.0001
    this.stance = 'mantle'
    this.isSliding = false
    this.onGround = false
    this.justMantled = true
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
    else if (m.crouchHeld || this.forceCrouch > 0) target = 1
    else target = 0

    if (target < this.crouchAmount && !this.canStand(true)) target = this.crouchAmount

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

  /** Sphere-cast upward to see whether there is room to stand back up. */
  private canStand(wantStand: boolean): boolean {
    if (!wantStand || !this.physics || this.crouchAmount < 0.05) return true
    const from = this.position.y + MOVE.crouchHeight - MOVE.radius
    this.v1.set(this.position.x, from, this.position.z)
    const need = MOVE.standHeight - MOVE.crouchHeight
    const hit = this.physics.sphereCast(this.v1, UP, MOVE.radius * 0.92, need + 0.05)
    return !hit || hit.distance > need
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
