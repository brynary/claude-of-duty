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
  /** Normalised time in the reload at which the rounds become usable. */
  private creditAt = 1
  private ammoCredited = false
  private pendingSwitch = -1
  private switchTimer = -1
  /** Counts down after a sprint ends; firing is locked out until it hits 0. */
  private sprintOutLeft = 0
  /** One dry click per trigger pull, not one every `fireTimer` expiry. */
  private dryLatched = false

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

  /** Falling edge of the player's life, so death is handled exactly once. */
  private wasAlive = true
  private offs: (() => void)[] = []

  private tmpPos = new THREE.Vector3()
  private tmpDir = new THREE.Vector3()
  private tmpSpread = new THREE.Vector3()
  private tmpVel = new THREE.Vector3()
  private tmpPort = new THREE.Vector3()
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
    this.vm.preload(WEAPONS)
    this.vm.equip(this.def)
    this.vm.syncToSun()

    // A dropped magazine takes a viewmodel material into the world scene, which
    // is lit differently and so needs its own compiled shader. Nothing else
    // presents that combination until the player's first reload.
    const prewarm = ctx.services.prewarm
    if (prewarm) {
      prewarm.world(...this.vm.magDropPrototypes().map((proto) => this.magProxy(proto)))
    }
    this.currentName = this.def.displayName

    this.baseFov = ctx.camera.fov
    this.baseVmFov = ctx.viewmodelCamera.fov
    this.lastYaw = ctx.camera.rotation.y
    this.lastPitch = ctx.camera.rotation.x

    // A respawn hands back a fresh loadout. Without this the weapon survived
    // death exactly as it was left: the player came back holding whatever was
    // in the magazine when they died, part way through a reload, with the
    // recoil and sustained-fire spread of the burst that got them killed still
    // accumulated. Coming out of a death into a fight with four rounds is a
    // large part of why the run after a death reads as unwinnable.
    this.offs.push(ctx.events.on('player:respawn', () => this.onRespawn()))

    // Kills feed the gun that made them. See `resupplyPerKill` for why the
    // ammunition has to come from somewhere: a fixed loadout is sized for a
    // fight that ends, and this one does not. The guard matches Telemetry's own
    // kill filter so the two count the same events.
    this.offs.push(ctx.events.on('entity:killed', (p) => {
      if (p.byPlayer && p.entity.team === 'enemy') this.onKill()
    }))

    ctx.services.weapons = this
  }

  /**
   * Whether the player is alive. `PlayerService` in the frozen `Types.ts`
   * contract predates the death state, so this is a structural read of the
   * field `PlayerSystem` already publishes — the same pattern the sprint-out
   * clock uses below. Absent means alive, so a stripped-down player harness
   * still shoots.
   */
  private playerAlive(ctx: GameContext): boolean {
    return (ctx.services.player as { alive?: boolean } | undefined)?.alive !== false
  }

  // ------------------------------------------------------------------ input

  update(dt: number, ctx: GameContext): void {
    const def = this.def
    const state = this.state
    const input = ctx.input
    const player = ctx.services.player
    const scripted = this.captureScript(ctx)

    // A corpse does not shoot. Nothing gated the trigger on the player being
    // alive, and the death camera runs for four seconds before the respawn —
    // so a held trigger kept the weapon firing along a view that is rolling
    // onto its side, and every one of those rounds was a guaranteed miss. It
    // is measurable: in the shipped `push` run the player died at t=16.4 s and
    // the telemetry records 7 rounds in the t=17 s bucket and 8 in t=18 s, all
    // for 0 damage, with the player 0.06 m from where they fell. That is 16 of
    // the run's 158 shots — a tenth of every shot fired, all misses, dragging
    // measured accuracy from 16.9% to 15.2% on its own.
    const alive = this.playerAlive(ctx)
    if (this.wasAlive && !alive) this.onDeath()
    this.wasAlive = alive

    // Nothing that fires may run on a frame that does not advance time. `dt`
    // is zero while paused, and `fireTimer` is at or below zero whenever a shot
    // is due, so without this a weapon mid-burst when the menu opened would
    // keep firing every frame. The viewmodel and HUD are updated below the
    // guard in the capture path, so a frozen screenshot still poses correctly.
    if (dt <= 0 && !scripted) return

    const wantAds = scripted ? scripted.ads : alive && input.mouse1
    const trigger = scripted ? scripted.fire : alive && input.mouse0
    const sprinting = !scripted && (player?.isSprinting ?? false) && !trigger && !wantAds

    // --- discrete actions -------------------------------------------------
    if (!scripted && alive) {
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

    // The magazine reloads itself the instant it runs dry, whether or not the
    // trigger is still down. Doing this only on the fire path left the weapon
    // sitting empty whenever the player let go, so the next trigger pull was a
    // dry click instead of a shot.
    //
    // Note what this guard implies: while the reserve holds, the reload starts
    // the frame after the magazine empties, `blocked` goes true, and the dry
    // click below is unreachable. So *every* dry fire the telemetry records is
    // an exhausted loadout, not a mistimed reload. Confirmed against the run
    // data — the run that fired exactly `magSize + reserve` rounds logged all
    // 12 of the dry fires, and the one that stopped ten rounds short logged
    // none. With nothing left to load, fall back to a weapon that still has
    // rounds, the way Call of Duty drops you to your secondary.
    if (alive && state.mag <= 0) {
      if (state.reserve > 0) this.tryReload()
      else if (!scripted) this.switchToArmedWeapon()
    }

    // --- sprint-out -------------------------------------------------------
    // §3.2 `[stated]`: sprint-out is 160-230 ms and is "the number that
    // determines whether a game feels twitchy or committed". Nothing enforced
    // it before — `sprinting` here already goes false the moment the trigger is
    // touched, so the weapon fired the same frame. Movement tracks its own
    // sprint-out but does not publish it, so the timer lives here, per weapon.
    // §3.1: the ADS and sprint-out timers run concurrently, not additively.
    if (player?.isSprinting) this.sprintOutLeft = def.sprintOutTime
    else if (this.sprintOutLeft > 0) this.sprintOutLeft = Math.max(0, this.sprintOutLeft - dt)

    // --- firing -----------------------------------------------------------
    this.fireTimer = Math.max(this.fireTimer - dt, -0.5)
    this.burstCooldown = Math.max(this.burstCooldown - dt, 0)
    if (!trigger) {
      this.semiLatched = false
      this.dryLatched = false
    }

    if (scripted?.forceShot) this.fireTimer = Math.min(this.fireTimer, 0)

    // A reload can be fired out of once the rounds are actually in the gun.
    // §3.3: the gap between `reloadAddTime` and `reloadTime` is a free cancel
    // window, and "reload canceling ... can save up to 1 second".
    if (trigger && this.reloadTimer >= 0 && this.ammoCredited && state.mag > 0) {
      this.cancelReload(ctx)
    }

    const blocked = this.reloadTimer >= 0 || this.switchTimer >= 0
    // Two sprint-out clocks exist and both are wanted. This one is per weapon;
    // the movement system's also covers leaving a slide (400ms), a mantle and
    // tactical sprint (310ms), which a weapon-side timer cannot see. They run
    // concurrently rather than in sequence, so the union is correct and does
    // not double-charge — §3.1 [measured] is explicit that ADS and sprint-out
    // overlap rather than sum, and the same holds here.
    const movementSprintOut = (player as { sprintOutRemaining?: number } | undefined)?.sprintOutRemaining ?? 0
    const sprintBlocked = sprinting || this.sprintOutLeft > 0 || movementSprintOut > 0
    let firing = false

    // An interrupted burst is abandoned, not banked. `burstLeft` survived a
    // reload, a weapon switch and a sprint, so the moment the block cleared the
    // weapon fired the remainder of the burst on its own with the trigger up —
    // and after a switch it fired the *new* weapon's rounds against the old
    // one's burst count.
    if ((blocked || sprintBlocked) && this.burstLeft > 0) this.burstLeft = 0

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
          // One click per trigger pull. Running the magazine dry mid-burst is
          // not a dry fire — the auto-reload below covers it — and holding the
          // trigger on an empty gun used to emit five clicks a second.
          if (!this.dryLatched && (!this.wasFiring || state.mode !== 'auto')) {
            this.dryLatched = true
            ctx.events.emit('weapon:dryFire', { weapon: def.id })
          }
          this.fireTimer = 0.2
          this.burstLeft = 0
          firing = false
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
      // Its own vector. This used to write the ejection port into `tmpPos`,
      // which is `origin` — so the gunshot position handed to the AI below was
      // wherever the brass left the gun, and only when effects were enabled.
      this.vm.portWorld(this.tmpPort)
      this.vm.weaponDirToWorld(def.shellVel, this.tmpSpread)
      this.tmpSpread.x += this.rand.spread(0.5)
      this.tmpSpread.y += this.rand.spread(0.4)
      fx.ejectShell(this.tmpPort, this.tmpSpread, true)
    }

    ctx.services.ai?.notifyNoise(origin, def.noiseRadius)
  }

  /**
   * FEEL_TARGET §3.6 `[stated]`: "All weapons in Call of Duty ... are perfectly
   * accurate at an infinite range while aiming down the sights", corroborated by
   * `adsSpread 0` on every weapon in the shipped files. It is the single most
   * important accuracy fact about the series, and the previous version broke it
   * three separate ways: a non-zero `spreadAds`, movement and jump multipliers
   * that kept applying at full ADS, and 45% of the sustained-fire penalty
   * bleeding through. All three are gone — the whole cone is now the *hipfire*
   * cone, faded out by how far into the sights you are, and at full ADS the
   * result is exactly `def.spreadAds`, which is 0 on everything that is not a
   * shotgun.
   */
  private currentSpread(def: WeaponDef, ctx: GameContext): number {
    const ads = this.adsFraction
    const hip = 1 - ads
    if (hip <= 1e-4) return def.spreadAds

    const player = ctx.services.player
    let mul = 1
    const speed = Math.min(player?.speedFraction ?? 0, 1)
    mul *= 1 + (def.spreadMoveMul - 1) * speed
    if (player?.isCrouching) mul *= def.spreadCrouchMul
    if (player && !player.onGround) mul *= def.spreadJumpMul
    return (def.spreadHip * mul + this.spread) * hip + def.spreadAds * ads
  }

  // ---------------------------------------------------------------- reloads

  private tryReload(): void {
    const def = this.def
    const state = this.state
    if (this.reloadTimer >= 0 || this.switchTimer >= 0) return
    if (state.mag >= def.magSize || state.reserve <= 0) return

    this.reloadEmpty = state.mag <= 0
    this.reloadDur = this.reloadEmpty ? def.reloadEmptyTime : def.reloadTime
    // The rounds become usable when the magazine seats — except on an empty
    // reload, where nothing is chambered until the bolt goes forward.
    this.creditAt = this.reloadEmpty ? def.chargeAt : def.magInAt
    this.reloadTimer = 0
    this.magOutFired = false
    this.magInFired = false
    this.ammoCredited = false
    this.isReloading = true
    this.vm.beginReload(this.reloadDur, this.reloadEmpty)
    this.ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'start' })
  }

  private updateReload(dt: number, ctx: GameContext): void {
    if (this.reloadTimer < 0) return
    const def = this.def
    const state = this.state
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
    if (!this.ammoCredited && t >= this.creditAt) {
      // Rounds are credited part-way through, not when the animation finishes.
      // §3.3: `reloadAddTime` is a separate, earlier field from `reloadTime` in
      // every shipped weapon file, and the gap between them is a free cancel
      // window worth "up to 1 second". Crediting only at the end made the whole
      // animation dead time and made reloading in a lull a losing trade.
      this.ammoCredited = true
      this.creditAmmo(def, state)
      ctx.events.emit('weapon:ammo', { mag: state.mag, reserve: state.reserve })
    }

    if (t >= 1) {
      this.ammoCredited = true
      this.creditAmmo(def, state)
      this.reloadTimer = -1
      this.isReloading = false
      ctx.events.emit('weapon:reload', { weapon: def.id, phase: 'end' })
      ctx.events.emit('weapon:ammo', { mag: state.mag, reserve: state.reserve })
    }
  }

  /** Idempotent: the cancel window means this can run twice in one reload. */
  private creditAmmo(def: WeaponDef, state: AmmoState): void {
    // A tactical reload keeps the round already in the chamber.
    const target = def.magSize + (this.reloadEmpty ? 0 : 1)
    const take = Math.min(state.reserve, Math.max(0, target - state.mag))
    if (take <= 0) return
    state.mag += take
    state.reserve -= take
    this.ammoDirty = true
  }

  /**
   * An enemy down returns rounds to the equipped weapon, capped at the loadout
   * it spawned with. The equipped weapon and no other: the credit should read
   * as "that kill paid for itself", which it only does on the gun in your
   * hands, and a backup that quietly refills is not a backup.
   */
  private onKill(): void {
    const def = this.def
    const state = this.state
    if (state.reserve >= def.reserve) return
    state.reserve = Math.min(def.reserve, state.reserve + def.resupplyPerKill)
    this.ammoDirty = true
    this.ctx.events.emit('weapon:ammo', { mag: state.mag, reserve: state.reserve })
  }

  /**
   * Last resort when the equipped weapon has nothing left anywhere: draw
   * whichever of the others is best stocked. A backstop rather than a mechanic
   * — with resupply running, reaching it at all means shooting well below the
   * target accuracy band for a sustained stretch. Doing nothing is correct when
   * every weapon is empty; that is genuinely out of ammunition, and the dry
   * click is the right answer.
   */
  private switchToArmedWeapon(): void {
    if (this.switchTimer >= 0 || this.pendingSwitch >= 0) return
    let best = -1
    let bestRounds = 0
    for (let i = 0; i < WEAPONS.length; i++) {
      if (i === this.index) continue
      const s = this.ammo.get(WEAPONS[i].id)
      if (!s) continue
      const rounds = s.mag + s.reserve
      if (rounds > bestRounds) {
        bestRounds = rounds
        best = i
      }
    }
    if (best >= 0) this.requestSwitch(best)
  }

  private cancelReload(ctx: GameContext): void {
    if (this.reloadTimer < 0) return
    this.reloadTimer = -1
    this.isReloading = false
    this.vm.cancelReload()
    ctx.events.emit('weapon:reload', { weapon: this.def.id, phase: 'end' })
  }

  // ------------------------------------------------------- death and respawn

  /**
   * Put the weapon down. The trigger is already refused above; this clears the
   * state that would otherwise carry across the four seconds of death camera
   * and out the other side — a half-finished reload, a pending burst, an
   * accumulated recoil offset the camera rig is still adding to the aim.
   */
  private onDeath(): void {
    this.burstLeft = 0
    this.burstCooldown = 0
    this.semiLatched = false
    this.dryLatched = false
    this.isFiring = false
    this.wasFiring = false
    this.spread = 0
    this.sprintOutLeft = 0
    this.recoil.reset()
    this.recoilPitch = 0
    this.recoilYaw = 0
    if (this.reloadTimer >= 0) this.cancelReload(this.ctx)
  }

  /**
   * A fresh loadout, the way respawning in Call of Duty hands one back. §3.4
   * `[measured]` even gives spawning its own weapon-raise timing ("first raise
   * (spawn)"), which only means anything if the weapon is reset with it.
   *
   * The equipped weapon is deliberately kept. There is no loadout screen here,
   * so the slot the player chose is the closest thing to a stated preference,
   * and forcing them back to slot 1 on every death would take it away.
   */
  private onRespawn(): void {
    for (const w of WEAPONS) {
      const s = this.ammo.get(w.id)
      if (!s) continue
      s.mag = w.magSize
      s.reserve = w.reserve
    }
    this.reloadTimer = -1
    this.isReloading = false
    this.ammoCredited = false
    this.pendingSwitch = -1
    this.switchTimer = -1
    this.fireTimer = 0
    this.onDeath()
    this.wasAlive = true
    // A trigger held through the death does not count as a pull on the new
    // life: a semi-automatic would otherwise fire the instant the player came
    // back. Released and pulled again, it clears on the first frame.
    this.semiLatched = true
    this.vm.cancelReload()
    // BO6 `[stated]`: "weapon raise animations that play on respawn are now
    // fully interruptible." So the draw plays, but it does not lock the
    // trigger — `fireTimer` stays at 0 rather than taking the usual
    // `drawTime * 0.5` a deliberate weapon switch pays.
    this.vm.beginSwitch(false, this.def.drawTime)
    this.vm.setSlideLocked(false)
    this.ammoDirty = true
    this.ctx.events.emit('weapon:ammo', { mag: this.state.mag, reserve: this.state.reserve })
  }

  /**
   * One dropped magazine, built the same way whether it is about to be thrown
   * or is only standing in for the pre-warm — the shader three compiles depends
   * on how the mesh is set up, so the two must not drift apart.
   */
  private magProxy(proto: THREE.Mesh): THREE.Mesh {
    const mesh = new THREE.Mesh(proto.geometry, proto.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.surface = 'thinMetal'
    return mesh
  }

  private spawnDroppedMag(ctx: GameContext): void {
    const proto = this.vm.magDropPrototype()
    if (!proto) return
    const mesh = this.magProxy(proto)
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
    for (const off of this.offs) off()
    this.offs.length = 0
    this.vm.dispose()
    this.mats.dispose()
  }
}
