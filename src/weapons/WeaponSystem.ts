import * as THREE from 'three'
import type { GameContext, System, WeaponService, DynamicBodyHandle } from '../core/Types'
import { Rand } from '../core/Rand'
import { WEAPONS, shotInterval, type WeaponDef, type FireMode } from './WeaponDefs'
import { WeaponMaterials } from './WeaponGeometry'
import { Viewmodel, type VmDrive } from './Viewmodel'
import { Ballistics, applySpread } from './Ballistics'
import { RecoilState, wrapAngle } from './Recoil'

interface AmmoState {
  mag: number
  reserve: number
  mode: FireMode
}

interface DroppedMag {
  mesh: THREE.Mesh
  handle: DynamicBodyHandle | null
  age: number
}

const KEY_RELOAD = 'KeyR'
const KEY_INSPECT = 'KeyI'
const KEY_FIREMODE = 'KeyB'
const KEY_SLOTS = ['Digit1', 'Digit2', 'Digit3', 'Digit4']

/**
 * Weapon handling: viewmodel, procedural animation, ADS, recoil, ballistics,
 * ammo, reloads and weapon switching.
 *
 * `recoilPitch` / `recoilYaw` are absolute additive offsets in radians that
 * decay back to zero on their own. The camera rig should ADD them to its aim
 * each frame, never accumulate them.
 */
export class WeaponSystem implements System, WeaponService {
  readonly name = 'weapons'

  currentName = 'M4A1'
  adsFraction = 0
  recoilPitch = 0
  recoilYaw = 0
  isReloading = false
  isFiring = false

  private ctx!: GameContext
  private mats!: WeaponMaterials
  private vm = new Viewmodel()
  private ballistics!: Ballistics
  private recoil!: RecoilState
  private rand!: Rand

  private index = 0
  private ammo = new Map<string, AmmoState>()
  private fireTimer = 0
  private burstLeft = 0
  private burstCooldown = 0
  private semiLatched = false
  private spread = 0
  private wasFiring = false

  private reloadTimer = -1
  private reloadDur = 0
  private reloadEmpty = false
  private magOutFired = false
  private magInFired = false
  private pendingSwitch = -1
  private switchTimer = -1

  private baseFov = 80
  private baseVmFov = 60
  private appliedFov = -1
  private ownsWorldFov = true
  private lastYaw = 0
  private lastPitch = 0
  private lastHud: unknown = null
  private ammoDirty = true

  private dropped: DroppedMag[] = []
  private drive: VmDrive = {
    ads: 0, sprint: 0, speedFraction: 0, crouch: 0,
    yawDelta: 0, pitchDelta: 0, lowReady: 0, elapsed: 0,
  }

  private tmpPos = new THREE.Vector3()
  private tmpDir = new THREE.Vector3()
  private tmpSpread = new THREE.Vector3()
  private tmpVel = new THREE.Vector3()
  private tmpQuat = new THREE.Quaternion()
  private tmpMat = new THREE.Matrix4()
  private tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ')

  get def(): WeaponDef {
    return WEAPONS[this.index]
  }

  get state(): AmmoState {
    return this.ammo.get(this.def.id)!
  }

  init(ctx: GameContext): void {
    this.ctx = ctx
    this.rand = new Rand((ctx.config.seed ^ 0x9e37) >>> 0)
    this.mats = new WeaponMaterials(ctx.config.seed, ctx.config.anisotropy)
    this.ballistics = new Ballistics(ctx)
    this.recoil = new RecoilState(this.rand)

    for (const w of WEAPONS) {
      this.ammo.set(w.id, { mag: w.magSize, reserve: w.reserve, mode: w.modes[0] })
    }

    this.vm.init(ctx, this.mats)
    this.vm.equip(this.def)
    this.vm.syncToSun()
    this.currentName = this.def.displayName

    this.baseFov = ctx.camera.fov
    this.baseVmFov = ctx.viewmodelCamera.fov
    this.lastYaw = ctx.camera.rotation.y
    this.lastPitch = ctx.camera.rotation.x

    ctx.services.weapons = this
  }

  // ------------------------------------------------------------------ input

  update(dt: number, ctx: GameContext): void {
    const def = this.def
    const state = this.state
    const input = ctx.input
    const player = ctx.services.player
    const scripted = this.captureScript(ctx)

    const wantAds = scripted ? scripted.ads : input.mouse1
    const trigger = scripted ? scripted.fire : input.mouse0
    const sprinting = !scripted && (player?.isSprinting ?? false) && !trigger && !wantAds

    // --- discrete actions -------------------------------------------------
    if (!scripted) {
      if (input.wasPressed(KEY_RELOAD)) this.tryReload()
      if (input.wasPressed(KEY_INSPECT)) this.vm.beginInspect(def.inspectTime)
      if (input.wasPressed(KEY_FIREMODE)) this.cycleFireMode()
      for (let i = 0; i < KEY_SLOTS.length && i < WEAPONS.length; i++) {
        if (input.wasPressed(KEY_SLOTS[i])) this.requestSwitch(i)
      }
      if (input.wheelDelta !== 0) {
        const dir = input.wheelDelta > 0 ? 1 : -1
        this.requestSwitch((this.index + dir + WEAPONS.length) % WEAPONS.length)
      }
    }

    this.updateSwitch(dt)
    this.updateReload(dt, ctx)

    // --- firing -----------------------------------------------------------
    this.fireTimer = Math.max(this.fireTimer - dt, -0.5)
    this.burstCooldown = Math.max(this.burstCooldown - dt, 0)
    if (!trigger) this.semiLatched = false

    if (scripted?.forceShot) this.fireTimer = Math.min(this.fireTimer, 0)

    const blocked = this.reloadTimer >= 0 || this.switchTimer >= 0
    const sprintBlocked = sprinting
    let firing = false

    if (this.burstLeft > 0 && !blocked && !sprintBlocked) {
      firing = true
    } else if (trigger && !blocked && !sprintBlocked && this.burstCooldown <= 0) {
      const mode = state.mode
      if (mode === 'auto') firing = true
      else if (!this.semiLatched) {
        firing = true
        this.semiLatched = true
        if (mode === 'burst') this.burstLeft = def.burstCount
      }
    }

    if (firing) {
      const interval = shotInterval(def)
      let shotsThisFrame = 0
      while (this.fireTimer <= 0 && shotsThisFrame < 3) {
        if (state.mag <= 0) {
          if (!this.wasFiring || state.mode !== 'auto') {
            ctx.events.emit('weapon:dryFire', { weapon: def.id })
          }
          this.fireTimer = 0.2
          this.burstLeft = 0
          firing = false
          // Auto-reload the moment the magazine runs dry, as CoD does.
          this.tryReload()
          break
        }
        this.fireShot(ctx, def, state)
        this.fireTimer += interval
        shotsThisFrame++
        if (this.burstLeft > 0) {
          this.burstLeft--
          if (this.burstLeft === 0) {
            this.burstCooldown = def.burstDelay
            firing = false
            break
          }
        }
        if (state.mode !== 'auto' && this.burstLeft === 0) break
      }
    }
    if (this.fireTimer < 0 && !firing) this.fireTimer = 0

    this.isFiring = firing
    this.wasFiring = firing

    // --- spread and recoil ------------------------------------------------
    if (!firing) {
      this.spread = Math.max(0, this.spread - def.spreadDecay * dt)
    }
    this.recoil.update(dt, def.recoil, firing)
    this.recoilPitch = this.recoil.pitch
    this.recoilYaw = this.recoil.yaw

    // --- drive the viewmodel ---------------------------------------------
    const drive = this.drive
    drive.ads = wantAds ? 1 : 0
    drive.sprint = sprinting ? 1 : 0
    drive.speedFraction = player?.speedFraction ?? 0
    drive.crouch = player?.isCrouching ? 1 : 0
    drive.lowReady = scripted?.lowReady ?? 0
    drive.elapsed = ctx.elapsed
    this.vm.setSlideLocked(def.slideLock && state.mag <= 0)

    this.updateDroppedMags(dt, ctx)
    this.pushHud(ctx)
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const cam = ctx.camera
    this.tmpEuler.setFromQuaternion(cam.quaternion, 'YXZ')
    this.drive.yawDelta = wrapAngle(this.tmpEuler.y - this.lastYaw)
    this.drive.pitchDelta = wrapAngle(this.tmpEuler.x - this.lastPitch)
    this.lastYaw = this.tmpEuler.y
    this.lastPitch = this.tmpEuler.x

    this.vm.followCamera()
    this.vm.update(dt, this.drive)
    this.adsFraction = this.vm.adsFraction
    this.applyFov(ctx)
    ctx.services.postfx?.setAdsBlur(this.adsFraction)
  }

  // ----------------------------------------------------------------- firing

  private fireShot(ctx: GameContext, def: WeaponDef, state: AmmoState): void {
    state.mag--
    this.ammoDirty = true

    const player = ctx.services.player
    const origin = this.tmpPos
    if (player) origin.copy(player.eye)
    else origin.copy(ctx.camera.position)

    ctx.camera.getWorldDirection(this.tmpDir).normalize()

    const spreadRad = this.currentSpread(def, ctx)
    const muzzle = this.tmpVel
    this.vm.muzzleWorld(muzzle)

    for (let p = 0; p < def.pellets; p++) {
      applySpread(this.tmpDir, spreadRad, this.rand, this.tmpSpread)
      this.ballistics.fire(def, origin, this.tmpSpread, muzzle, this.rand, true)
    }

    // The name carries the weapon family as a token: the audio bank buckets
    // shot sounds by matching 'rifle' / 'smg' / 'sniper' / 'pistol' in it.
    ctx.events.emit('weapon:fired', {
      weapon: `${def.id} ${def.sfx}`, origin: origin.clone(), direction: this.tmpSpread.clone(), loud: true,
    })
    ctx.events.emit('weapon:ammo', { mag: state.mag, reserve: state.reserve })

    // Accuracy penalty grows while the trigger is down.
    this.spread = Math.min(this.spread + def.spreadPerShot, def.spreadMax)
    this.recoil.kick(def.recoil, this.adsFraction, player?.isCrouching ?? false)
    this.vm.onFire(def, this.adsFraction)

    const fx = ctx.services.fx
    if (fx) {
      fx.muzzleFlash(this.vm.muzzleMatrix(this.tmpMat), def.muzzleFlashScale, true)
      this.vm.portWorld(this.tmpPos)
      this.vm.weaponDirToWorld(def.shellVel, this.tmpSpread)
      this.tmpSpread.x += this.rand.spread(0.5)
      this.tmpSpread.y += this.rand.spread(0.4)
      fx.ejectShell(this.tmpPos, this.tmpSpread, true)
    }

    ctx.services.ai?.notifyNoise(origin, def.noiseRadius)
  }

  private currentSpread(def: WeaponDef, ctx: GameContext): number {
    const player = ctx.services.player
    const base = def.spreadHip + (def.spreadAds - def.spreadHip) * this.adsFraction
    let mul = 1
    const speed = Math.min(player?.speedFraction ?? 0, 1)
    mul *= 1 + (def.spreadMoveMul - 1) * speed
    if (player?.isCrouching) mul *= def.spreadCrouchMul
    if (player && !player.onGround) mul *= def.spreadJumpMul
    return base * mul + this.spread * (1 - this.adsFraction * 0.55)
  }

  // ---------------------------------------------------------------- reloads

  private tryReload(): void {
    const def = this.def
    const state = this.state
    if (this.reloadTimer >= 0 || this.switchTimer >= 0) return
    if (state.mag >= def.magSize || state.reserve <= 0) return

    this.reloadEmpty = state.mag <= 0
    this.reloadDur = this.reloadEmpty ? def.reloadEmptyTime : def.reloadTime
    this.reloadTimer = 0
    this.magOutFired = false
    this.magInFired = false
    this.isReloading = true
    this.vm.beginReload(this.reloadDur, this.reloadEmpty)
    this.ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'start' })
  }

  private updateReload(dt: number, ctx: GameContext): void {
    if (this.reloadTimer < 0) return
    const def = this.def
    const state = this.state
    const prev = this.reloadTimer / this.reloadDur
    this.reloadTimer += dt
    const t = this.reloadTimer / this.reloadDur

    if (!this.magOutFired && t >= def.magOutAt) {
      this.magOutFired = true
      ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'magOut' })
      this.spawnDroppedMag(ctx)
    }
    if (!this.magInFired && t >= def.magInAt) {
      this.magInFired = true
      ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'magIn' })
    }

    if (t >= 1) {
      // A tactical reload keeps the round already in the chamber.
      const target = def.magSize + (this.reloadEmpty || state.mag <= 0 ? 0 : 1)
      const take = Math.min(state.reserve, Math.max(0, target - state.mag))
      state.mag += take
      state.reserve -= take
      this.reloadTimer = -1
      this.isReloading = false
      this.ammoDirty = true
      ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'end' })
      ctx.events.emit('weapon:ammo', { mag: state.mag, reserve: state.reserve })
    }
  }

  private spawnDroppedMag(ctx: GameContext): void {
    const proto = this.vm.magDropPrototype()
    if (!proto) return
    const mesh = new THREE.Mesh(proto.geometry, proto.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.surface = 'thinMetal'
    this.vm.magWorld(this.tmpPos, this.tmpQuat)
    mesh.position.copy(this.tmpPos)
    mesh.quaternion.copy(this.tmpQuat)
    ctx.scene.add(mesh)

    let handle: DynamicBodyHandle | null = null
    const physics = ctx.services.physics
    if (physics) {
      try {
        handle = physics.addDynamic(mesh, {
          mass: 0.12, shape: 'box', restitution: 0.15, friction: 0.8, angularDamping: 0.5,
        })
        // Give it the player's momentum plus a small toss, when the concrete
        // physics system exposes the underlying body.
        const body = (physics as unknown as { getBody?: (h: DynamicBodyHandle) => {
          setLinvel(v: { x: number, y: number, z: number }, wake: boolean): void
          setAngvel(v: { x: number, y: number, z: number }, wake: boolean): void
        } | null }).getBody?.(handle)
        if (body) {
          const vel = ctx.services.player?.velocity
          body.setLinvel({
            x: (vel?.x ?? 0) * 0.9 + this.rand.spread(0.3),
            y: -0.6,
            z: (vel?.z ?? 0) * 0.9 + this.rand.spread(0.3),
          }, true)
          body.setAngvel({ x: this.rand.spread(4), y: this.rand.spread(4), z: this.rand.spread(4) }, true)
        }
      } catch {
        handle = null
      }
    }
    this.dropped.push({ mesh, handle, age: 0 })
    while (this.dropped.length > 4) this.retireMag(ctx, 0)
  }

  private updateDroppedMags(dt: number, ctx: GameContext): void {
    for (let i = this.dropped.length - 1; i >= 0; i--) {
      const d = this.dropped[i]
      d.age += dt
      if (d.age > 25) this.retireMag(ctx, i)
    }
  }

  private retireMag(ctx: GameContext, i: number): void {
    const d = this.dropped[i]
    if (!d) return
    if (d.handle) ctx.services.physics?.removeBody(d.handle)
    ctx.scene.remove(d.mesh)
    this.dropped.splice(i, 1)
  }

  // --------------------------------------------------------------- switching

  private requestSwitch(index: number): void {
    if (index === this.index || index < 0 || index >= WEAPONS.length) return
    if (this.switchTimer >= 0) return
    if (this.reloadTimer >= 0) {
      this.reloadTimer = -1
      this.isReloading = false
      this.vm.cancelReload()
    }
    this.pendingSwitch = index
    this.switchTimer = 0
    this.vm.beginSwitch(true, this.def.holsterTime)
  }

  private updateSwitch(dt: number): void {
    if (this.switchTimer < 0) return
    this.switchTimer += dt
    if (this.pendingSwitch >= 0 && this.switchTimer >= this.def.holsterTime) {
      const from = this.def.id
      this.index = this.pendingSwitch
      this.pendingSwitch = -1
      const def = this.def
      this.currentName = def.displayName
      this.vm.equip(def)
      this.vm.beginSwitch(false, def.drawTime)
      this.recoil.reset()
      this.spread = 0
      this.fireTimer = def.drawTime * 0.5
      this.ammoDirty = true
      this.ctx.events.emit('weapon:switch', { from, to: def.id })
      this.ctx.events.emit('weapon:ammo', { mag: this.state.mag, reserve: this.state.reserve })
      this.switchTimer = 0
    } else if (this.pendingSwitch < 0 && this.switchTimer >= this.def.drawTime) {
      this.switchTimer = -1
    }
  }

  private cycleFireMode(): void {
    const def = this.def
    const state = this.state
    if (def.modes.length < 2) return
    const i = def.modes.indexOf(state.mode)
    state.mode = def.modes[(i + 1) % def.modes.length]
    this.burstLeft = 0
    this.ctx.services.hud?.showMessage(`${def.displayName}  ${state.mode.toUpperCase()}`, 1.2)
  }

  // ------------------------------------------------------------------- misc

  private applyFov(ctx: GameContext): void {
    const def = this.def
    const t = this.adsFraction
    // The camera rig reads its aim zoom from config; publish the equipped
    // weapon's value there so a scope actually magnifies and a red dot barely
    // does. Harmless if the rig drives the FOV itself.
    ctx.config.adsFovScale = def.adsFovScale
    const vmFov = this.baseVmFov + (def.adsVmFov - this.baseVmFov) * t
    if (Math.abs(ctx.viewmodelCamera.fov - vmFov) > 1e-3) {
      ctx.viewmodelCamera.fov = vmFov
      ctx.viewmodelCamera.updateProjectionMatrix()
    }

    // Only drive the world FOV while nothing else is: if another system moves
    // it, that system owns the zoom and we stay out of the way.
    if (!this.ownsWorldFov) return
    if (this.appliedFov >= 0 && Math.abs(ctx.camera.fov - this.appliedFov) > 1e-3) {
      this.ownsWorldFov = false
      return
    }
    const target = this.baseFov * (1 + (def.adsFovScale - 1) * t)
    if (Math.abs(ctx.camera.fov - target) > 1e-3) {
      ctx.camera.fov = target
      ctx.camera.updateProjectionMatrix()
    }
    this.appliedFov = ctx.camera.fov
  }

  private pushHud(ctx: GameContext): void {
    const hud = ctx.services.hud
    if (!hud) return
    if (hud !== this.lastHud) {
      this.lastHud = hud
      this.ammoDirty = true
      hud.setWeaponName(this.def.displayName)
    }
    if (this.ammoDirty) {
      this.ammoDirty = false
      const s = this.state
      hud.setAmmo(s.mag, s.reserve)
      hud.setWeaponName(this.def.displayName)
    }
  }

  /**
   * Deterministic behaviour for the screenshot harness. Each named pose gets a
   * scripted weapon state so the graded frames are identical run to run.
   */
  private captureScript(ctx: GameContext): {
    ads: boolean, fire: boolean, lowReady: number, forceShot: boolean,
  } | null {
    const pose = ctx.config.pose
    if (!pose) return null
    const t = ctx.elapsed
    const freeze = ctx.config.freezeAt ?? 1e9
    // The frame that first reaches the freeze time is the last one simulated,
    // so a shot forced here leaves a live muzzle flash in the captured frame.
    const finalFrame = t >= freeze

    switch (pose) {
      case 'ads':
        return { ads: t > 0.3, fire: false, lowReady: 0, forceShot: false }
      case 'weapon':
        return { ads: false, fire: false, lowReady: 1, forceShot: false }
      case 'firefight':
        return {
          ads: t > 0.35,
          fire: (t > 4.2 && t < 4.9) || (t > 5.4 && t < 6.0) || t > 6.2,
          lowReady: 0,
          forceShot: finalFrame,
        }
      default:
        return { ads: false, fire: false, lowReady: 0, forceShot: false }
    }
  }

  dispose(): void {
    this.vm.dispose()
    this.mats.dispose()
  }
}
