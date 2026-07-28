import * as THREE from 'three'

/**
 * A fixed pool of point lights used by muzzle flashes and explosions.
 *
 * The lights are created once at init and never added to or removed from the
 * scene afterwards: changing a scene's light count forces three to recompile
 * every material in it, which would hitch the frame exactly when the action
 * starts. Idle lights simply sit at zero intensity.
 */

interface Flash {
  light: THREE.PointLight
  start: number
  duration: number
  peak: number
  /** Higher values decay faster; 1 is linear. */
  curve: number
  active: boolean
}

export class FxLightPool {
  private readonly flashes: Flash[] = []

  constructor(scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2)
      light.castShadow = false
      light.visible = false
      light.name = `fx-flash-${i}`
      scene.add(light)
      this.flashes.push({ light, start: -1e9, duration: 0.1, peak: 0, curve: 2, active: false })
    }
  }

  /**
   * Lights the scene for `duration` seconds. Returns false when every light is
   * already busy with a brighter flash, so callers can skip the visual too.
   */
  flash(
    position: THREE.Vector3,
    colour: THREE.Color,
    peak: number,
    distance: number,
    duration: number,
    time: number,
    curve = 2.2,
  ): boolean {
    let best: Flash | null = null
    let bestScore = Infinity
    for (const f of this.flashes) {
      const remaining = f.active ? Math.max(0, 1 - (time - f.start) / f.duration) * f.peak : -1
      if (remaining < bestScore) {
        bestScore = remaining
        best = f
      }
    }
    if (!best || bestScore > peak) return false

    best.light.position.copy(position)
    best.light.color.copy(colour)
    best.light.distance = distance
    best.light.decay = 2
    best.light.intensity = peak
    best.light.visible = true
    best.start = time
    best.duration = duration
    best.peak = peak
    best.curve = curve
    best.active = true
    return true
  }

  update(time: number): void {
    for (const f of this.flashes) {
      if (!f.active) continue
      const u = (time - f.start) / f.duration
      if (u >= 1 || u < 0) {
        f.active = false
        f.light.intensity = 0
        f.light.visible = false
        continue
      }
      // Instant attack, sharp decay — a muzzle flash is over before the eye
      // resolves it, and a lingering point light instantly reads as fake.
      f.light.intensity = f.peak * Math.pow(1 - u, f.curve)
    }
  }

  dispose(): void {
    for (const f of this.flashes) {
      f.light.removeFromParent()
      f.light.dispose()
    }
  }
}
