import * as THREE from 'three'

/**
 * A fixed pool of point lights that other systems borrow for muzzle flashes,
 * explosions and burning debris.
 *
 * The pool is fixed and every light stays `visible`, idling at zero intensity.
 * three keys its shader cache on the number of visible lights, so toggling
 * visibility would recompile every material in the scene the first time a gun
 * is fired -- a guaranteed hitch at exactly the wrong moment.
 */
export interface LightLease {
  readonly light: THREE.PointLight
  readonly slot: number
}

interface Slot {
  light: THREE.PointLight
  /** Seconds left on an automatic flash; <= 0 when idle or manually held. */
  remaining: number
  duration: number
  peak: number
  /** Held by a caller through borrowLight() until it is handed back. */
  leased: boolean
  /** Larger wins when the pool is exhausted. */
  priority: number
}

export class LightPool {
  private slots: Slot[] = []
  private readonly group = new THREE.Group()

  constructor(scene: THREE.Object3D, size: number) {
    this.group.name = 'dynamicLights'
    scene.add(this.group)
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2)
      light.castShadow = false
      light.name = `poolLight${i}`
      this.group.add(light)
      this.slots.push({ light, remaining: 0, duration: 0, peak: 0, leased: false, priority: 0 })
    }
  }

  get size(): number {
    return this.slots.length
  }

  /** Claims a light until it is returned. Null when everything is busy. */
  borrow(priority = 1): LightLease | null {
    const slot = this.acquire(priority)
    if (!slot) return null
    slot.leased = true
    slot.remaining = 0
    slot.priority = priority
    return { light: slot.light, slot: this.slots.indexOf(slot) }
  }

  release(lease: LightLease): void {
    const slot = this.slots[lease.slot]
    if (!slot || slot.light !== lease.light) return
    slot.leased = false
    slot.priority = 0
    slot.remaining = 0
    slot.light.intensity = 0
  }

  /**
   * Fire-and-forget burst. Returns itself to the pool when it burns out, which
   * is what muzzle flashes and explosions want.
   */
  flash(
    position: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    distance: number,
    duration: number,
    priority = 1,
  ): void {
    const slot = this.acquire(priority)
    if (!slot) return
    slot.leased = false
    slot.priority = priority
    slot.peak = intensity
    slot.duration = Math.max(0.008, duration)
    slot.remaining = slot.duration
    slot.light.position.copy(position)
    slot.light.color.copy(color)
    slot.light.distance = distance
    slot.light.decay = 2
    slot.light.intensity = intensity
  }

  private acquire(priority: number): Slot | null {
    let idle: Slot | null = null
    let weakest: Slot | null = null
    for (const slot of this.slots) {
      if (!slot.leased && slot.remaining <= 0) {
        idle = slot
        break
      }
      if (slot.leased) continue
      if (!weakest || slot.remaining / Math.max(slot.duration, 1e-4) < weakest.remaining / Math.max(weakest.duration, 1e-4)) {
        weakest = slot
      }
    }
    if (idle) return idle
    // Steal the flash closest to burning out, but never from a higher priority.
    if (weakest && priority >= weakest.priority) return weakest
    return null
  }

  update(dt: number): void {
    if (dt <= 0) return
    for (const slot of this.slots) {
      if (slot.remaining <= 0) continue
      slot.remaining -= dt
      if (slot.remaining <= 0) {
        slot.remaining = 0
        slot.light.intensity = 0
        slot.priority = 0
        continue
      }
      // Sharp attack, exponential decay: a linear ramp reads as a lamp turning
      // off rather than as a flash.
      const t = slot.remaining / slot.duration
      slot.light.intensity = slot.peak * t * t * (0.55 + 0.45 * t)
    }
  }

  dispose(): void {
    for (const slot of this.slots) slot.light.dispose()
    this.group.removeFromParent()
  }
}
