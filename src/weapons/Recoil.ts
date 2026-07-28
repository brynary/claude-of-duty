import { Rand } from '../core/Rand'

/**
 * Camera recoil, modelled on the two-part system described in FEEL_TARGET §3.5.
 *
 * Each shot adds a kick with a directional bias and a large random component,
 * and a **centre speed** pulls the view back toward zero *continuously* —
 * "It applies immediately on firing, but during full-auto fire there is usually
 * too much kick to fully recentre before the next shot." `[stated]`
 *
 * That last sentence is the whole model, and gating recentring behind "the
 * trigger is up" (which is what this class used to do) turns a bounded climb
 * into an unbounded one. With the centre speed running every frame the offset
 * converges to `kick / (1 - e^(-recovery / shotsPerSecond))` instead of summing
 * without limit, so a magazine has a ceiling and the player pulls against a
 * bias rather than chasing a runaway.
 *
 * The `pattern` is a *bias* curve, not a memorisable path: §3.5 is explicit
 * that CoD is "a randomised cone with a directional bias, not a memorisable
 * fixed spray pattern like CS or Battlefield." The horizontal term is therefore
 * small next to `jitter`; the vertical term only shapes how the first shots
 * feel heavier than the settled tail.
 */
export interface RecoilProfile {
  /** Base vertical kick per shot, radians. */
  pitch: number
  /** Base horizontal kick per shot, radians. */
  yaw: number
  /** Fraction of the kick that is randomised, 0..1. */
  jitter: number
  /** Shaped bias; sampled by shot index and held at the tail. */
  pattern: readonly (readonly [number, number])[]
  /** Spring frequency for how fast the view snaps to the new target. */
  snap: number
  /**
   * Centre speed: how fast the view is pulled back toward zero, per second.
   * Applies every frame, including while the trigger is held.
   */
  recovery: number
  /** Multiplier on `recovery` once the trigger is released. */
  settle: number
  /** Fraction of the kick that never returns (permanent climb), 0..1. */
  permanent: number
  /** Recoil reduction while aiming down sights. */
  adsScale: number
  /** Viewmodel kick, metres back and radians up. */
  kickBack: number
  kickUp: number
  kickRoll: number
  /** Viewmodel recovery spring frequency. */
  visualSnap: number
}

const TWO_PI = Math.PI * 2

/**
 * Per-weapon recoil runtime. Owns the camera offset that the player rig adds to
 * its aim; the value is an absolute offset that decays to zero, never a delta.
 */
export class RecoilState {
  /** Current camera offset, radians. Read by the camera rig. */
  pitch = 0
  yaw = 0

  private targetPitch = 0
  private targetYaw = 0
  /** Portion of the climb that does not walk back down between bursts. */
  private restPitch = 0
  private restYaw = 0
  private velPitch = 0
  private velYaw = 0
  private shotIndex = 0
  private sinceShot = 10
  private wander = 0

  constructor(private rand: Rand) {}

  /** Called on every shot; returns the visual kick scale for the viewmodel. */
  kick(profile: RecoilProfile, adsFraction: number, crouched: boolean): void {
    const pattern = profile.pattern
    const i = Math.min(this.shotIndex, pattern.length - 1)
    const [pm, ym] = pattern[i]
    // Beyond the authored pattern the spray wanders slowly and predictably.
    this.wander += this.rand.spread(0.35)
    this.wander = Math.max(-1, Math.min(1, this.wander * 0.86))
    const tail = this.shotIndex >= pattern.length ? this.wander : 0

    let scale = 1 - adsFraction * (1 - profile.adsScale)
    if (crouched) scale *= 0.86

    const jitterP = 1 + this.rand.spread(profile.jitter)
    const jitterY = this.rand.spread(profile.jitter * 1.6)

    const dPitch = profile.pitch * pm * jitterP * scale
    const dYaw = profile.yaw * (ym + tail * 0.8 + jitterY) * scale
    this.targetPitch += dPitch
    this.targetYaw += dYaw
    this.restPitch += dPitch * profile.permanent
    this.restYaw += dYaw * profile.permanent * 0.5

    this.shotIndex++
    this.sinceShot = 0
  }

  update(dt: number, profile: RecoilProfile, firing: boolean): void {
    if (dt <= 0) return
    this.sinceShot += dt

    // Centre speed runs every frame, trigger up or down. Between bursts it runs
    // faster, which is the view snapping back the moment you stop shooting.
    const held = firing || this.sinceShot <= 0.055
    const rate = held ? profile.recovery : profile.recovery * profile.settle
    const k = Math.exp(-rate * dt)
    this.targetPitch = this.restPitch + (this.targetPitch - this.restPitch) * k
    this.targetYaw = this.restYaw + (this.targetYaw - this.restYaw) * k

    if (!firing && this.sinceShot > 0.28) {
      this.shotIndex = 0
      const settle = Math.exp(-2.2 * dt)
      this.wander *= Math.exp(-3 * dt)
      this.restPitch *= settle
      this.restYaw *= settle
      if (Math.abs(this.targetPitch) < 1e-5) this.targetPitch = 0
      if (Math.abs(this.targetYaw) < 1e-5) this.targetYaw = 0
    }

    const w = profile.snap
    this.pitch = springStep(this.pitch, this.targetPitch, dt, w, (v) => (this.velPitch = v), this.velPitch)
    this.yaw = springStep(this.yaw, this.targetYaw, dt, w, (v) => (this.velYaw = v), this.velYaw)
  }

  reset(): void {
    this.pitch = this.yaw = 0
    this.targetPitch = this.targetYaw = 0
    this.restPitch = this.restYaw = 0
    this.velPitch = this.velYaw = 0
    this.shotIndex = 0
    this.wander = 0
  }

  get shots(): number {
    return this.shotIndex
  }
}

/**
 * Implicitly integrated critically damped spring. Unconditionally stable at any
 * timestep, so a frame hitch cannot make the weapon explode.
 */
export function springStep(
  x: number, target: number, dt: number, omega: number,
  setVel: (v: number) => void, vel: number,
): number {
  const f = 1 + 2 * dt * omega
  const oo = omega * omega
  const hoo = dt * oo
  const hhoo = dt * hoo
  const det = 1 / (f + hhoo)
  const detX = f * x + dt * vel + hhoo * target
  const detV = vel + hoo * (target - x)
  setVel(detV * det)
  return detX * det
}

/** Scalar spring with the velocity carried in a two-slot array. */
export class Spring1 {
  value = 0
  private vel = 0
  private setVel = (v: number) => { this.vel = v }

  step(target: number, dt: number, omega: number): number {
    this.value = springStep(this.value, target, dt, omega, this.setVel, this.vel)
    return this.value
  }

  set(v: number): void {
    this.value = v
    this.vel = 0
  }

  nudge(v: number): void {
    this.vel += v
  }
}

/** Three independent critically damped springs, for positions and eulers. */
export class Spring3 {
  x = 0
  y = 0
  z = 0
  private vx = 0
  private vy = 0
  private vz = 0
  private sx = (v: number) => { this.vx = v }
  private sy = (v: number) => { this.vy = v }
  private sz = (v: number) => { this.vz = v }

  step(tx: number, ty: number, tz: number, dt: number, omega: number): void {
    this.x = springStep(this.x, tx, dt, omega, this.sx, this.vx)
    this.y = springStep(this.y, ty, dt, omega, this.sy, this.vy)
    this.z = springStep(this.z, tz, dt, omega, this.sz, this.vz)
  }

  nudge(nx: number, ny: number, nz: number): void {
    this.vx += nx
    this.vy += ny
    this.vz += nz
  }

  set(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z
    this.vx = this.vy = this.vz = 0
  }
}

/** Wraps an angle to [-PI, PI] so yaw deltas across the seam stay small. */
export function wrapAngle(a: number): number {
  let v = a % TWO_PI
  if (v > Math.PI) v -= TWO_PI
  if (v < -Math.PI) v += TWO_PI
  return v
}
