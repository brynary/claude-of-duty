import * as THREE from 'three'
import type { GameContext } from '../core/Types'
import { Locomotion, MOVE } from './Movement'

const DEG = Math.PI / 180
const TAU = Math.PI * 2
const PITCH_LIMIT = 89 * DEG

/**
 * Implicit (semi-implicit Euler) damped spring. Unconditionally stable at any
 * timestep, so the feel is identical at 30fps and 240fps — which a raw
 * `lerp(a, b, 0.1)` never is.
 */
export class Spring {
  value = 0
  vel = 0
  target = 0
  private omega: number

  constructor(freqHz: number, private damping: number) {
    this.omega = freqHz * TAU
  }

  setFrequency(freqHz: number, damping = this.damping): void {
    this.omega = freqHz * TAU
    this.damping = damping
  }

  update(dt: number): number {
    if (dt <= 0) return this.value
    const w = this.omega
    const f = 1 + 2 * dt * this.damping * w
    const hoo = dt * w * w
    const hhoo = dt * hoo
    const det = 1 / (f + hhoo)
    const v = (this.vel + hoo * (this.target - this.value)) * det
    this.value = (f * this.value + dt * this.vel + hhoo * this.target) * det
    this.vel = v
    return this.value
  }

  /** Inject an impulse sized so the response peaks at roughly `peak`. */
  pulse(peak: number): void {
    this.vel += peak * this.omega
  }

  reset(value = 0): void {
    this.value = value
    this.target = value
    this.vel = 0
  }
}

function approach(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt)
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * The camera rig. Everything the player feels but never consciously sees:
 * layered look lag, distance-driven head bob, breathing, recoil accumulation,
 * FOV kick, landing dips, view punch and roll.
 *
 * Layering is the whole trick: the aim angles are authoritative, the world
 * camera trails them by ~20ms, and the viewmodel camera trails the world camera
 * by another ~70ms. The weapon therefore swings behind the view on fast turns
 * without anyone animating it.
 */
export class CameraRig {
  /** Authoritative aim, updated straight from the mouse. */
  aimYaw = 0
  aimPitch = 0
  /** Rendered angles — what the player actually sees, and what we publish. */
  outYaw = 0
  outPitch = 0
  outRoll = 0
  /** Final world-space eye position including bob, dip and breathing. */
  readonly eye = new THREE.Vector3()
  fov = 80

  /** View angular velocity, rad/s — useful to the weapon system for sway. */
  lookVelYaw = 0
  lookVelPitch = 0
  /** How far the viewmodel trails the view, radians. */
  weaponLagYaw = 0
  weaponLagPitch = 0

  private camYaw = new Spring(16, 1.0)
  private camPitch = new Spring(16, 1.0)
  private vmYaw = new Spring(4.2, 1.0)
  private vmPitch = new Spring(4.2, 1.0)

  private fovSpring = new Spring(3.2, 0.85)
  private punchPitch = new Spring(2.6, 0.42)
  private punchYaw = new Spring(2.4, 0.4)
  private punchRoll = new Spring(2.2, 0.45)
  private landDip = new Spring(2.1, 0.55)
  private landPitch = new Spring(2.4, 0.5)
  private rollSpring = new Spring(2.4, 1.0)
  private pitchLean = new Spring(2.8, 1.0)

  private bobPhase = 0
  private stepIndex = -1
  private bobWeight = 0
  private idleTime = 0
  private breathT = 0
  private sprintBlend = 0
  private tacBlend = 0
  private adsSmooth = 0

  private prevRecoilPitch = 0
  private prevRecoilYaw = 0
  private recoilPitch = new Spring(5.5, 1.0)
  private recoilYaw = new Spring(5.5, 1.0)
  /** Fraction of every recoil kick that is never given back. */
  private static readonly RECOIL_KEEP = 0.3

  private readonly right = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  /** Total offset added to the stance eye position this frame. */
  private readonly bobOffset = new THREE.Vector3()

  reset(yaw: number, pitch: number): void {
    this.aimYaw = yaw
    this.aimPitch = pitch
    this.camYaw.reset(yaw)
    this.camPitch.reset(pitch)
    this.vmYaw.reset(yaw)
    this.vmPitch.reset(pitch)
    this.outYaw = yaw
    this.outPitch = pitch
    this.outRoll = 0
    this.punchPitch.reset()
    this.punchYaw.reset()
    this.punchRoll.reset()
    this.landDip.reset()
    this.landPitch.reset()
    this.rollSpring.reset()
    this.pitchLean.reset()
    this.bobPhase = 0
    this.stepIndex = -1
    this.bobWeight = 0
  }

  /** Seeds the FOV spring so the first frame does not zoom in from nothing. */
  setFov(value: number): void {
    this.fovSpring.reset(value)
    this.fov = value
  }

  /**
   * Mouse look and recoil accumulation. Runs before movement so the player
   * moves along the direction they are looking this frame, not last frame.
   */
  look(dt: number, ctx: GameContext, ads: number): void {
    const { input, config } = ctx
    const sens = config.sensitivity * (1 - 0.38 * ads)
    if (input.enabled && input.locked) {
      this.aimYaw -= input.mouseDX * sens
      this.aimPitch -= input.mouseDY * sens
    }

    // Recoil arrives as an absolute offset owned by the weapon. Fold a slice of
    // every kick permanently into the aim so the muzzle climbs and the player
    // has to pull back down; the rest recovers on its own.
    const w = ctx.services.weapons
    const rp = w ? w.recoilPitch : 0
    const ry = w ? w.recoilYaw : 0
    if (Math.abs(rp) > Math.abs(this.prevRecoilPitch)) {
      this.aimPitch += (rp - this.prevRecoilPitch) * CameraRig.RECOIL_KEEP
    }
    if (Math.abs(ry) > Math.abs(this.prevRecoilYaw)) {
      this.aimYaw += (ry - this.prevRecoilYaw) * CameraRig.RECOIL_KEEP
    }
    this.prevRecoilPitch = rp
    this.prevRecoilYaw = ry
    this.recoilPitch.target = rp
    this.recoilYaw.target = ry
    this.recoilPitch.update(dt)
    this.recoilYaw.update(dt)

    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch, -PITCH_LIMIT, PITCH_LIMIT)
  }

  /** Everything that reacts to the body: bob, dip, roll, breathing, FOV. */
  update(
    dt: number,
    ctx: GameContext,
    loco: Locomotion,
    ads: number,
    strafeInput: number,
    hurt: number,
  ): void {
    const cfg = ctx.config
    this.adsSmooth += (ads - this.adsSmooth) * approach(18, dt)
    const adsEase = smoothstep(this.adsSmooth)

    this.sprintBlend += ((loco.isSprinting ? 1 : 0) - this.sprintBlend) * approach(7, dt)
    this.tacBlend += ((loco.isTacSprinting ? 1 : 0) - this.tacBlend) * approach(5.5, dt)

    const prevYaw = this.outYaw
    const prevPitch = this.outPitch

    // --- layered look lag ---------------------------------------------------
    this.camYaw.target = this.aimYaw
    this.camPitch.target = this.aimPitch
    const baseYaw = this.camYaw.update(dt)
    const basePitch = this.camPitch.update(dt)

    // --- head bob, driven by distance travelled -----------------------------
    const speed = loco.speed
    const moving = loco.onGround && speed > 0.5 && !loco.isSliding
    if (moving) {
      this.idleTime = 0
      // Phase advances with distance covered, never with time: stop dead and
      // the cycle stops exactly where the foot was.
      const stride = THREE.MathUtils.clamp(1.05 + speed * 0.16, 0.9, 2.2)
      this.bobPhase += (speed * dt / stride) * Math.PI
    } else {
      this.idleTime += dt
      if (this.idleTime > 0.3) {
        this.bobPhase = 0
        this.stepIndex = -1
      }
    }

    const speedNorm = THREE.MathUtils.clamp(speed / MOVE.run, 0, 1.5)
    const bobTarget = moving ? speedNorm : 0
    this.bobWeight += (bobTarget - this.bobWeight) * approach(moving ? 9 : 6, dt)
    const bobGain = this.bobWeight * (1 - adsEase * 0.94)

    const p = this.bobPhase
    const bobLateral = Math.sin(p) * 0.040 * bobGain
    const bobVertical = Math.cos(p * 2) * 0.026 * bobGain
    const bobForward = Math.sin(p * 2 + 0.6) * 0.011 * bobGain
    const bobRoll = Math.sin(p) * 1.05 * DEG * bobGain
    const bobPitchOsc = Math.cos(p * 2) * 0.42 * DEG * bobGain

    // Footstep on the bottom of each half-cycle, with the surface underfoot.
    const idx = Math.floor(p / Math.PI - 0.5)
    if (moving && idx !== this.stepIndex) {
      this.stepIndex = idx
      this.emitFootstep(ctx, loco)
    }

    // --- breathing ----------------------------------------------------------
    this.breathT += dt
    const rest = 1 - THREE.MathUtils.clamp(speedNorm, 0, 1) * 0.65
    const breathAmp = 0.0016 * rest * (1 + loco.fatigue * 2.4 + hurt * 1.9) * (1 + adsEase * 0.4)
    const breathYaw = (Math.sin(this.breathT * 1.13) * 0.6 + Math.sin(this.breathT * 0.47 + 1.7) * 0.4) * breathAmp
    const breathPitch = Math.sin(this.breathT * 1.61 + 0.9) * breathAmp * 0.8
    const breathRise = Math.sin(this.breathT * 1.61 + 0.9) * 0.0035 * rest * (1 + loco.fatigue)

    // --- landing, slide and strafe response ---------------------------------
    if (loco.justLanded && loco.landImpact > 3.0) {
      const hard = THREE.MathUtils.clamp(loco.landImpact / 14, 0, 1.15)
      this.landDip.pulse(-0.045 - 0.13 * hard * hard)
      this.landPitch.pulse(-(0.022 + 0.105 * hard))
      this.punchRoll.pulse(hard * 1.6 * DEG * Math.sign(strafeInput || 1))
    }
    if (loco.justSlid) {
      this.fovSpring.pulse(8)
      this.landDip.pulse(-0.035)
    }
    if (loco.justJumped) this.landDip.pulse(0.02)

    // Roll: a little into the strafe, a lot into the slide.
    const lateral = speed > 0.2
      ? (this.right.set(Math.cos(baseYaw), 0, -Math.sin(baseYaw)).dot(loco.velocity)) / Math.max(speed, 1)
      : 0
    let rollTarget = -strafeInput * 0.95 * DEG * (1 - adsEase * 0.65)
    rollTarget -= (lateral * 5.0 * DEG + 2.4 * DEG) * loco.slideIntensity
    this.rollSpring.target = rollTarget

    // Pitch lean: nose down under acceleration, up when sliding to a stop.
    this.pitchLean.target = -this.sprintBlend * 0.9 * DEG - loco.slideIntensity * 1.8 * DEG

    // --- mantle arc ---------------------------------------------------------
    let mantlePitch = 0
    let mantleRoll = 0
    let mantleLateral = 0
    if (loco.mantleProgress > 0) {
      const t = loco.mantleProgress
      const h = THREE.MathUtils.clamp(loco.mantleHeight / MOVE.mantleMaxHeight, 0.2, 1)
      const arc = Math.sin(Math.PI * Math.pow(t, 0.72))
      mantlePitch = -(0.055 + 0.10 * h) * arc
      mantleRoll = 3.4 * DEG * h * Math.sin(Math.PI * t)
      mantleLateral = 0.055 * h * Math.sin(Math.PI * t)
    }

    // --- FOV ----------------------------------------------------------------
    const adsFov = cfg.fov * cfg.adsFovScale
    const runFov = cfg.fov * (1 + 0.055 * this.sprintBlend + 0.065 * this.tacBlend + 0.05 * loco.slideIntensity)
    this.fovSpring.target = THREE.MathUtils.lerp(runFov, adsFov, adsEase)
    this.fov = this.fovSpring.update(dt)

    // --- integrate the springs ---------------------------------------------
    const dip = this.landDip.update(dt)
    const landPitch = this.landPitch.update(dt)
    const roll = this.rollSpring.update(dt)
    const lean = this.pitchLean.update(dt)
    const punchP = this.punchPitch.update(dt)
    const punchY = this.punchYaw.update(dt)
    const punchR = this.punchRoll.update(dt)

    // --- compose ------------------------------------------------------------
    this.outYaw = baseYaw + punchY + breathYaw + this.recoilYaw.value
    this.outPitch = THREE.MathUtils.clamp(
      basePitch + punchP + breathPitch + bobPitchOsc + landPitch + lean + mantlePitch + this.recoilPitch.value,
      -PITCH_LIMIT, PITCH_LIMIT,
    )
    this.outRoll = roll + punchR + bobRoll + mantleRoll

    if (dt > 0) {
      this.lookVelYaw = (this.outYaw - prevYaw) / dt
      this.lookVelPitch = (this.outPitch - prevPitch) / dt
    }

    // Eye position: stance height, then bob in view space, then vertical dip.
    this.right.set(Math.cos(this.outYaw), 0, -Math.sin(this.outYaw))
    this.forward.set(-Math.sin(this.outYaw), 0, -Math.cos(this.outYaw))
    const slideShake = loco.slideIntensity > 0.05
      ? Math.sin(this.breathT * 46) * 0.004 * loco.slideIntensity
      : 0

    this.bobOffset.set(0, bobVertical + dip + breathRise + slideShake, 0)
    this.bobOffset.addScaledVector(this.right, bobLateral + mantleLateral)
    this.bobOffset.addScaledVector(this.forward, bobForward)
    this.eye.copy(loco.position)
    this.eye.y += loco.eyeHeight
    this.eye.add(this.bobOffset)

    // --- viewmodel: a second, slower follower -------------------------------
    this.vmYaw.target = this.aimYaw
    this.vmPitch.target = this.aimPitch
    // Aiming locks the weapon to the view; hipfire lets it swing.
    const lagScale = 1 - adsEase * 0.86
    this.vmYaw.setFrequency(4.2 + adsEase * 14, 1.0)
    this.vmPitch.setFrequency(4.2 + adsEase * 14, 1.0)
    const vy = this.vmYaw.update(dt)
    const vp = this.vmPitch.update(dt)
    const maxLag = 0.13
    this.weaponLagYaw = THREE.MathUtils.clamp((vy - this.outYaw) * lagScale, -maxLag, maxLag)
    this.weaponLagPitch = THREE.MathUtils.clamp((vp - this.outPitch) * lagScale, -maxLag, maxLag)
  }

  /**
   * Writes the frame's camera state. The viewmodel camera inherits the eye but
   * only 60% of the bob, so the weapon visibly floats against the view.
   */
  applyTo(camera: THREE.PerspectiveCamera, vm: THREE.PerspectiveCamera): void {
    camera.position.copy(this.eye)
    camera.rotation.set(this.outPitch, this.outYaw, this.outRoll, 'YXZ')
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov
      camera.updateProjectionMatrix()
    }

    vm.position.copy(this.eye).addScaledVector(this.bobOffset, -0.4)
    vm.rotation.set(
      this.outPitch + this.weaponLagPitch,
      this.outYaw + this.weaponLagYaw,
      this.outRoll * 0.85,
      'YXZ',
    )
  }

  /**
   * Capture mode still needs the FOV to reflect the aim state (the `ads` pose
   * is graded on its sight picture) but nothing else may move.
   */
  updatePosedFov(dt: number, ctx: GameContext, ads: number): void {
    this.adsSmooth += (ads - this.adsSmooth) * approach(18, dt)
    const cfg = ctx.config
    this.fovSpring.target = THREE.MathUtils.lerp(cfg.fov, cfg.fov * cfg.adsFovScale, smoothstep(this.adsSmooth))
    this.fov = this.fovSpring.update(dt)
  }

  /** Snap the rig to a fixed capture pose with every offset zeroed. */
  applyPosed(camera: THREE.PerspectiveCamera, vm: THREE.PerspectiveCamera, pos: THREE.Vector3, yaw: number, pitch: number): void {
    this.eye.copy(pos)
    this.outYaw = yaw
    this.outPitch = pitch
    this.outRoll = 0
    camera.position.copy(pos)
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov
      camera.updateProjectionMatrix()
    }
    vm.position.copy(pos)
    vm.rotation.set(pitch, yaw, 0, 'YXZ')
  }

  /** Damage response: punch away from the hit, roll, and shove the view. */
  damagePunch(amount: number, fromDirection: THREE.Vector3): void {
    const mag = THREE.MathUtils.clamp(amount / 30, 0.15, 1.6)
    // fromDirection points at the attacker; resolve it into view space.
    const f = this.forward.set(-Math.sin(this.outYaw), 0, -Math.cos(this.outYaw))
    const r = this.right.set(Math.cos(this.outYaw), 0, -Math.sin(this.outYaw))
    const front = f.x * fromDirection.x + f.z * fromDirection.z
    const side = r.x * fromDirection.x + r.z * fromDirection.z
    this.punchPitch.pulse(mag * 3.4 * DEG * (front > 0 ? 1 : -0.6))
    this.punchYaw.pulse(-side * mag * 4.2 * DEG)
    this.punchRoll.pulse(side * mag * 5.0 * DEG)
    this.landDip.pulse(-mag * 0.022)
  }

  private emitFootstep(ctx: GameContext, loco: Locomotion): void {
    ctx.events.emit('player:footstep', {
      position: loco.position.clone(),
      surface: loco.groundSurface,
      running: loco.speed > MOVE.run * 0.92,
    })
  }
}
