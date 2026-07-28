import * as THREE from 'three'
import type { GameContext, System, PlayerService, HitInfo, Team } from '../core/Types'
import { applyPose } from '../core/Poses'
import type { PhysicsSystem } from '../physics/Physics'
import { Locomotion, MOVE, type MoveIntent } from './Movement'
import { CameraRig } from './CameraRig'

/** Seconds out of combat before health starts coming back. */
const REGEN_DELAY = 3.1
const REGEN_RATE = 34
/** Window for a double tap to mean "tactical sprint". */
const DOUBLE_TAP = 0.28
const RESPAWN_DELAY = 4.0

/**
 * Character controller and camera rig: ground movement, sprint, crouch, slide,
 * mantle, jump, head bob, view sway, recoil accumulation and health.
 *
 * The system runs entirely inside `update()` rather than `lateUpdate()` so that
 * every later system — AI, weapons, viewmodel, audio — observes the final
 * camera for this frame. The one-frame delay on consuming weapon recoil is
 * deliberate and imperceptible.
 */
export class PlayerSystem implements System, PlayerService {
  readonly name = 'player'

  // --- PlayerService --------------------------------------------------------
  /** Feet position: the point the capsule stands on, not the eye. */
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  readonly eye = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = true
  isSprinting = false
  isCrouching = false
  isSliding = false
  health = 100
  speedFraction = 0

  // --- damageable-shaped, but deliberately not in ctx.entities --------------
  readonly id = 0
  readonly team: Team = 'player'
  maxHealth = 100
  alive = true

  /** View angular velocity and viewmodel trail, for the weapon system. */
  get lookVelocityYaw(): number { return this.rig.lookVelYaw }
  get lookVelocityPitch(): number { return this.rig.lookVelPitch }
  get weaponLagYaw(): number { return this.rig.weaponLagYaw }
  get weaponLagPitch(): number { return this.rig.weaponLagPitch }
  /** 0..1 crouch blend, so the viewmodel can settle with the stance. */
  get crouchFraction(): number { return this.loco.crouchAmount }

  private readonly loco = new Locomotion()
  private readonly rig = new CameraRig()
  private readonly intent: MoveIntent = {
    forward: 0, strafe: 0, yaw: 0,
    jumpPressed: false, crouchHeld: false, crouchPressed: false,
    sprintHeld: false, tacSprint: false, walkHeld: false,
    ads: 0, busy: false,
  }

  private posed = false
  private readonly poseEye = new THREE.Vector3()
  private readonly spawn = new THREE.Vector3()
  private spawnYaw = 0

  private lastDamageAt = -99
  private deathAt = 0
  private respawning = false
  private damageFlash = 0
  private hudHealth = -1
  private adsFallback = 0

  private crouchToggle = false
  private lastForwardTap = -99
  private lastSprintTap = -99
  private tacLatch = false

  private readonly bounds = new THREE.Box3()
  private hasBounds = false
  private unbind: (() => void)[] = []
  private eventsRef: GameContext['events'] | null = null

  init(ctx: GameContext): void {
    ctx.services.player = this
    this.eventsRef = ctx.events
    this.rig.setFov(ctx.config.fov)

    const level = ctx.services.level
    if (level) {
      this.spawn.copy(level.playerSpawn)
      this.spawnYaw = level.playerSpawnYaw
      this.bounds.copy(level.bounds)
      this.hasBounds = !this.bounds.isEmpty()
    }

    this.loco.attach((ctx.services.physics as PhysicsSystem | undefined) ?? null, this.spawn)
    this.rig.reset(this.spawnYaw, 0)
    this.publish()

    if (ctx.config.pose) {
      const pose = applyPose(ctx.camera, ctx.config.pose)
      if (pose) {
        this.posed = true
        this.poseEye.set(...pose.position)
        this.yaw = THREE.MathUtils.degToRad(pose.yaw)
        this.pitch = THREE.MathUtils.degToRad(pose.pitch)
        this.rig.reset(this.yaw, this.pitch)
        this.rig.setFov(pose.fov ?? ctx.config.fov)
        this.eye.copy(this.poseEye)
        this.position.set(this.poseEye.x, this.poseEye.y - MOVE.eyeStand, this.poseEye.z)
        this.loco.teleport(this.position)
      }
    }

    this.unbind.push(
      ctx.events.on('player:damaged', (p) => this.takeDamage(ctx, p.amount, p.fromDirection)),
      ctx.events.on('player:respawn', () => { if (!this.respawning) this.doRespawn(ctx, false) }),
    )
  }

  update(dt: number, ctx: GameContext): void {
    const weapons = ctx.services.weapons
    let ads = weapons ? THREE.MathUtils.clamp(weapons.adsFraction, 0, 1) : 0
    if (!weapons) {
      const want = ctx.input.mouse1 ? 1 : 0
      this.adsFallback += (want - this.adsFallback) * (1 - Math.exp(-14 * dt))
      ads = this.adsFallback
    }

    if (this.posed) {
      this.rig.updatePosedFov(dt, ctx, ads)
      this.rig.applyPosed(ctx.camera, ctx.viewmodelCamera, this.poseEye, this.yaw, this.pitch)
      this.eye.copy(this.poseEye)
      this.speedFraction = 0
      this.pushHud(ctx)
      return
    }

    // Click to take the mouse if nothing else has claimed it.
    if (ctx.input.mouse0Pressed && !ctx.input.locked && ctx.input.enabled) ctx.input.requestLock()

    this.rig.look(dt, ctx, ads)
    this.buildIntent(ctx, ads, weapons?.isFiring === true || weapons?.isReloading === true)

    this.loco.update(dt, this.intent)
    this.clampToBounds(ctx)
    this.reactToLocomotion(ctx, dt)
    this.updateHealth(dt, ctx)

    const hurt = 1 - THREE.MathUtils.clamp(this.health / this.maxHealth, 0, 1)
    this.rig.update(dt, ctx, this.loco, ads, this.intent.strafe, hurt)
    this.rig.applyTo(ctx.camera, ctx.viewmodelCamera)
    if (!this.alive) this.applyDeathCam(ctx, dt)

    this.publish()
    this.pushHud(ctx)
  }

  /** Capture poses are re-asserted after every other system has had its say. */
  lateUpdate(_dt: number, ctx: GameContext): void {
    if (!this.posed) return
    ctx.camera.position.copy(this.poseEye)
    ctx.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }

  // --- input ---------------------------------------------------------------

  private buildIntent(ctx: GameContext, ads: number, busy: boolean): void {
    const inp = ctx.input
    const m = this.intent
    const dead = !this.alive

    m.forward = dead ? 0 : inp.axis('KeyS', 'KeyW')
    m.strafe = dead ? 0 : inp.axis('KeyA', 'KeyD')
    m.yaw = this.rig.aimYaw
    m.ads = ads
    m.busy = busy

    if (inp.wasPressed('KeyW')) {
      if (ctx.elapsed - this.lastForwardTap < DOUBLE_TAP) this.tacLatch = true
      this.lastForwardTap = ctx.elapsed
    }
    if (inp.wasPressed('ShiftLeft')) {
      if (ctx.elapsed - this.lastSprintTap < DOUBLE_TAP) this.tacLatch = true
      this.lastSprintTap = ctx.elapsed
    }
    if (m.forward < 0.5 || ads > 0.3 || busy || dead) this.tacLatch = false

    if (inp.wasPressed('KeyC')) this.crouchToggle = !this.crouchToggle
    const crouchEdge = inp.wasPressed('ControlLeft') || inp.wasPressed('KeyC')

    m.sprintHeld = !dead && (inp.isDown('ShiftLeft') || this.tacLatch)
    m.tacSprint = this.tacLatch
    if (m.sprintHeld && m.forward > 0.5) this.crouchToggle = false

    m.crouchHeld = !dead && (inp.isDown('ControlLeft') || this.crouchToggle)
    m.crouchPressed = !dead && crouchEdge && m.crouchHeld
    m.walkHeld = inp.isDown('AltLeft')
    m.jumpPressed = !dead && inp.wasPressed('Space')
  }

  // --- reactions -----------------------------------------------------------

  private reactToLocomotion(ctx: GameContext, _dt: number): void {
    if (this.loco.justLanded && this.loco.landImpact > 3.0) {
      ctx.events.emit('player:land', {
        position: this.loco.position.clone(),
        impact: this.loco.landImpact,
      })
      // Hard landings hurt: nothing below the threshold, then it ramps fast.
      if (this.loco.landImpact > MOVE.fallHurtSpeed) {
        const over = (this.loco.landImpact - MOVE.fallHurtSpeed) /
          (MOVE.fallDeathSpeed - MOVE.fallHurtSpeed)
        const damage = Math.min(100, 14 + over * over * 110)
        ctx.events.emit('player:damaged', {
          amount: damage,
          fromDirection: new THREE.Vector3(0, -1, 0),
        })
      }
    }
    if (this.loco.justMantled) this.sfx(ctx, 'mantle', 0.7)
    if (this.loco.justSlid) this.sfx(ctx, 'slide', 0.85)
  }

  /** Audio ids are owned by another system; never let a missing one kill the
   * frame loop. */
  private sfx(ctx: GameContext, id: string, volume: number, positional = true): void {
    try {
      if (positional) ctx.services.audio?.play(id, this.loco.position, { volume })
      else ctx.services.audio?.play2D(id, { volume })
    } catch {
      /* the sound bank has not authored this id */
    }
  }

  private clampToBounds(ctx: GameContext): void {
    if (!this.hasBounds) return
    const p = this.loco.position
    const r = MOVE.radius
    p.x = THREE.MathUtils.clamp(p.x, this.bounds.min.x + r, this.bounds.max.x - r)
    p.z = THREE.MathUtils.clamp(p.z, this.bounds.min.z + r, this.bounds.max.z - r)
    // Out the bottom of the world: put them back rather than falling forever.
    if (p.y < this.bounds.min.y) this.doRespawn(ctx, true)
  }

  private publish(): void {
    this.position.copy(this.loco.position)
    this.velocity.copy(this.loco.velocity)
    this.eye.copy(this.rig.eye)
    this.yaw = this.rig.outYaw
    this.pitch = this.rig.outPitch
    this.onGround = this.loco.onGround
    this.isSprinting = this.loco.isSprinting
    this.isCrouching = this.loco.crouchAmount > 0.5
    this.isSliding = this.loco.isSliding
    this.speedFraction = THREE.MathUtils.clamp(this.loco.speed / MOVE.sprint, 0, 1)
  }

  // --- health --------------------------------------------------------------

  /** Damageable-compatible entry point; routes through the event so the HUD,
   * post FX and camera all see one path. */
  applyDamage(amount: number, hit: HitInfo): void {
    this.eventsRef?.emit('player:damaged', {
      amount,
      fromDirection: hit.direction.clone().negate(),
    })
  }

  private takeDamage(ctx: GameContext, amount: number, from: THREE.Vector3): void {
    if (amount <= 0 || !this.alive) return
    // Capture mode must never produce a death screen mid-pose.
    const floor = this.posed ? 25 : 0
    this.health = Math.max(floor, this.health - amount)
    this.lastDamageAt = ctx.elapsed
    this.damageFlash = Math.min(1, this.damageFlash + THREE.MathUtils.clamp(amount / 35, 0.12, 0.8))

    if (!this.posed) this.rig.damagePunch(amount, from)
    ctx.services.hud?.damageDirection(from)
    this.sfx(ctx, 'playerHurt', Math.min(1, 0.35 + amount / 60), false)

    if (this.health <= 0 && !this.posed) {
      this.alive = false
      this.health = 0
      this.deathAt = ctx.elapsed
      ctx.events.emit('player:died', {})
      ctx.services.audio?.duck(0.6, 2.0)
    }
  }

  private updateHealth(dt: number, ctx: GameContext): void {
    this.damageFlash *= Math.exp(-4.5 * dt)

    if (this.alive) {
      if (ctx.elapsed - this.lastDamageAt > REGEN_DELAY && this.health < this.maxHealth) {
        this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt)
      }
    } else if (ctx.elapsed - this.deathAt > RESPAWN_DELAY) {
      this.doRespawn(ctx, true)
    }

    const postfx = ctx.services.postfx
    if (postfx) {
      // Low health keeps a slow red pulse on screen, CoD's most legible tell.
      const frac = this.health / this.maxHealth
      const low = frac < 0.4 ? (1 - frac / 0.4) * (0.22 + 0.07 * Math.sin(ctx.elapsed * 4.2)) : 0
      postfx.setDamageFlash(Math.min(1, Math.max(this.damageFlash, low)))
    }
  }

  private pushHud(ctx: GameContext): void {
    const frac = this.health / this.maxHealth
    if (Math.abs(frac - this.hudHealth) > 0.004) {
      this.hudHealth = frac
      ctx.services.hud?.setHealth(frac)
    }
  }

  private applyDeathCam(ctx: GameContext, _dt: number): void {
    const t = THREE.MathUtils.clamp((ctx.elapsed - this.deathAt) / 1.15, 0, 1)
    const e = t * t * (3 - 2 * t)
    const cam = ctx.camera
    cam.position.y = THREE.MathUtils.lerp(cam.position.y, this.loco.position.y + 0.34, e)
    cam.rotation.z = THREE.MathUtils.lerp(cam.rotation.z, 1.22, e)
    cam.rotation.x = THREE.MathUtils.lerp(cam.rotation.x, -0.22, e)
    ctx.viewmodelCamera.position.copy(cam.position)
    ctx.viewmodelCamera.rotation.copy(cam.rotation)
  }

  private doRespawn(ctx: GameContext, announce: boolean): void {
    this.respawning = true
    this.health = this.maxHealth
    this.alive = true
    this.damageFlash = 0
    this.lastDamageAt = ctx.elapsed
    this.crouchToggle = false
    this.tacLatch = false
    this.loco.teleport(this.spawn)
    this.rig.reset(this.spawnYaw, 0)
    this.publish()
    if (announce) ctx.events.emit('player:respawn', {})
    this.respawning = false
  }

  dispose(): void {
    for (const off of this.unbind) off()
    this.unbind.length = 0
    this.loco.dispose()
  }
}
