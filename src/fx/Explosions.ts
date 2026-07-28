import * as THREE from 'three'
import { SPRITE } from './FxTextures'
import type { Particles } from './Particles'
import type { Decals } from './Decals'
import type { Debris } from './Debris'
import type { FxLightPool } from './FxLights'
import type { GameContext } from '../core/Types'
import type { Rand } from '../core/Rand'

const SRGB = THREE.SRGBColorSpace

/**
 * Explosions, run as a timed sequence rather than a single burst.
 *
 * Real detonations resolve over roughly four seconds and the order matters:
 * flash, fireball, shockwave, thrown debris, then a smoke column that keeps
 * rising long after the bang. Firing everything on frame one is the single
 * most common tell of a cheap explosion.
 */

interface Blast {
  active: boolean
  start: number
  radius: number
  point: THREE.Vector3
  ground: THREE.Vector3
  groundNormal: THREE.Vector3
  grounded: boolean
  stage: number
  columnTimer: number
  columnLeft: number
  shimmerTimer: number
  shimmerLeft: number
}

export interface ExplosionDeps {
  particles: Particles
  decals: Decals
  debris: Debris
  lights: FxLightPool
  rand: Rand
  /** Drives the post chain's hit flash; `closeness` is 0..1. */
  screenFlash(closeness: number): void
}

export class Explosions {
  private readonly blasts: Blast[] = []
  private readonly dir = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private readonly down = new THREE.Vector3(0, -1, 0)
  private readonly t1 = new THREE.Vector3()
  private readonly t2 = new THREE.Vector3()
  private readonly colour = new THREE.Color()

  constructor(private readonly deps: ExplosionDeps, pool = 4) {
    for (let i = 0; i < pool; i++) {
      this.blasts.push({
        active: false, start: 0, radius: 5,
        point: new THREE.Vector3(), ground: new THREE.Vector3(),
        groundNormal: new THREE.Vector3(0, 1, 0), grounded: false,
        stage: 0, columnTimer: 0, columnLeft: 0, shimmerTimer: 0, shimmerLeft: 0,
      })
    }
  }

  detonate(ctx: GameContext, point: THREE.Vector3, radius: number, time: number): void {
    const blast = this.blasts.find((b) => !b.active) ?? this.blasts[0]
    blast.active = true
    blast.start = time
    blast.radius = Math.max(0.6, radius)
    blast.point.copy(point)
    blast.stage = 0
    blast.columnTimer = 0
    blast.columnLeft = 14
    blast.shimmerTimer = 0
    blast.shimmerLeft = 26

    // Find the ground so the scorch, the dust ring and the column all sit on it.
    const physics = ctx.services.physics
    blast.grounded = false
    blast.ground.copy(point)
    blast.groundNormal.set(0, 1, 0)
    if (physics) {
      const hit = physics.raycast(point, this.down, blast.radius * 1.4 + 2, { characters: false })
      if (hit) {
        blast.ground.copy(hit.point)
        blast.groundNormal.copy(hit.normal)
        blast.grounded = true
      }
    }

    this.flash(ctx, blast, time)
  }

  // --- stages ---------------------------------------------------------------

  private flash(ctx: GameContext, b: Blast, time: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const R = b.radius

    // Detonation flash: enormous, near-white, and gone in three frames.
    {
      const p = P.params
      p.position.copy(b.point)
      p.life = 0.07
      p.sizeStart = R * 0.7
      p.sizeEnd = R * 1.5
      p.drag = 8
      p.colorStart.setRGB(9.0, 8.0, 6.2)
      p.colorEnd.setRGB(4.0, 2.0, 0.6)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.tile = SPRITE.core
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // Fireball: additive smoke frames give it turbulent internal structure
    // instead of the flat orange ball that betrays a billboard.
    for (let i = 0; i < 16; i++) {
      const p = P.params
      p.position.copy(b.point).add(this.randomInSphere(R * 0.28))
      this.randomDirection(this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(2, 9) * (R / 4))
      p.velocity.y += r.range(1, 4)
      p.life = r.range(0.32, 0.7)
      p.sizeStart = R * r.range(0.3, 0.55)
      p.sizeEnd = R * r.range(0.9, 1.5)
      p.drag = 3.6
      p.gravity = -0.35
      p.turbulence = 1.1
      p.colorStart.setRGB(7.0, 3.6, 1.0)
      p.colorEnd.setRGB(1.1, 0.28, 0.05)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(2.5)
      p.tile = r.int(0, 4)
      p.frames = 16
      p.erode = 0.55
      p.soft = 0
      P.emit('smokeAdd', time)
    }

    // Embers thrown clear of the fireball.
    for (let i = 0; i < 44; i++) {
      const p = P.params
      p.position.copy(b.point).add(this.randomInSphere(R * 0.2))
      this.randomDirection(this.dir)
      this.dir.y = Math.abs(this.dir.y) * 0.8 + 0.15
      p.velocity.copy(this.dir).normalize().multiplyScalar(r.range(6, 26))
      p.life = r.range(0.6, 1.9)
      p.sizeStart = r.range(0.02, 0.05)
      p.sizeEnd = 0.006
      p.drag = 0.9
      p.gravity = 1
      p.colorStart.setRGB(5.5, 2.8, 0.7)
      p.colorEnd.setRGB(0.9, 0.14, 0.02)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.stretch = 0.035
      p.tile = SPRITE.ember
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // The light. Very bright, very brief.
    this.colour.setRGB(1.0, 0.66, 0.32)
    this.deps.lights.flash(b.point, this.colour, 240 * (R / 5), R * 6, 0.34, time, 3.4)

    // Physics: everything nearby gets thrown.
    ctx.services.physics?.applyRadialImpulse(b.point, R * 1.6, 16 * R)

    // Chunks of the ground itself.
    const chunkCount = Math.min(9, Math.round(R * 1.8))
    for (let i = 0; i < chunkCount; i++) {
      this.randomDirection(this.dir)
      this.dir.y = Math.abs(this.dir.y) + 0.5
      this.tmp.copy(this.dir).normalize().multiplyScalar(r.range(5, 13))
      this.deps.debris.spawn(
        ctx,
        this.t1.copy(b.ground).addScaledVector(b.groundNormal, 0.15),
        this.tmp,
        r.range(0.06, 0.16),
        'concrete',
        time,
      )
    }

    // Scorch on the ground.
    if (b.grounded) {
      this.deps.decals.spawn(
        b.ground, b.groundNormal,
        R > 3.5 ? 'scorchLarge' : 'scorchSmall',
        R * r.range(1.4, 1.9),
        r.range(0, Math.PI * 2), time, 0.92, 1, 1, 1, 120, 20,
      )
    }

    // Screen and mix response, scaled by how close the player is.
    const dist = ctx.camera.position.distanceTo(b.point)
    const closeness = THREE.MathUtils.clamp(1 - dist / (R * 5), 0, 1)
    if (closeness > 0.02) {
      this.deps.screenFlash(closeness * 0.85)
      ctx.services.audio?.duck(0.25 + closeness * 0.55, 0.7 + closeness * 1.6)
    }
    ctx.services.audio?.play('explosion', b.point, { maxDistance: 220 })
  }

  private shockwave(b: Blast, time: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const R = b.radius

    // Camera-facing pressure ring.
    {
      const p = P.params
      p.position.copy(b.point)
      p.life = 0.3
      p.sizeStart = R * 0.4
      p.sizeEnd = R * 3.1
      p.drag = 8
      p.colorStart.setRGB(2.4, 2.1, 1.8)
      p.colorEnd.setRGB(0.5, 0.42, 0.36)
      p.alphaStart = 0.55
      p.alphaEnd = 0
      p.tile = SPRITE.ring
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // Dust ripped off the ground and driven outward along it.
    if (!b.grounded) return
    this.tangentBasis(b.groundNormal)
    const count = 26
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r.spread(0.12)
      const p = P.params
      p.position.copy(b.ground).addScaledVector(b.groundNormal, 0.1)
      this.dir.copy(this.t1).multiplyScalar(Math.cos(a)).addScaledVector(this.t2, Math.sin(a))
      p.position.addScaledVector(this.dir, R * 0.3)
      p.velocity.copy(this.dir).multiplyScalar(r.range(7, 15) * (R / 5))
      p.velocity.addScaledVector(b.groundNormal, r.range(0.6, 2.2))
      p.life = r.range(1.6, 3.2)
      p.sizeStart = R * r.range(0.14, 0.26)
      p.sizeEnd = R * r.range(0.7, 1.25)
      p.drag = 2.1
      p.gravity = 0.04
      p.turbulence = 0.5
      p.colorStart.setHex(0xb5aa96, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x776e60, THREE.SRGBColorSpace)
      p.alphaStart = 0.55
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.9)
      p.tile = r.int(0, 4)
      p.frames = 16
      p.erode = 0.62
      p.soft = 0.6
      P.emit('smoke', time)
    }
  }

  private smokeBall(b: Blast, time: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const R = b.radius
    for (let i = 0; i < 14; i++) {
      const p = P.params
      p.position.copy(b.point).add(this.randomInSphere(R * 0.4))
      this.randomDirection(this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.8, 3.4))
      p.velocity.y += r.range(0.8, 2.4)
      p.life = r.range(2.6, 5)
      p.sizeStart = R * r.range(0.5, 0.85)
      p.sizeEnd = R * r.range(1.6, 2.8)
      p.drag = 1.5
      p.gravity = -0.09
      p.turbulence = 0.4
      p.colorStart.setHex(0x4a453f, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x2b2926, THREE.SRGBColorSpace)
      p.alphaStart = 0.72
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.5)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.68
      p.soft = 0.8
      P.emit('smoke', time)
    }
  }

  // --- update ---------------------------------------------------------------

  update(ctx: GameContext, time: number, dt: number): void {
    for (const b of this.blasts) {
      if (!b.active) continue
      const age = time - b.start

      if (b.stage === 0 && age >= 0.05) {
        this.shockwave(b, time)
        b.stage = 1
      }
      if (b.stage === 1 && age >= 0.11) {
        this.smokeBall(b, time)
        b.stage = 2
      }

      // Rising column, metered out so it climbs rather than appearing at once.
      if (b.columnLeft > 0 && age > 0.25) {
        b.columnTimer -= dt
        while (b.columnTimer <= 0 && b.columnLeft > 0) {
          b.columnTimer += 0.12
          b.columnLeft--
          this.column(b, time)
        }
      }

      // Heat shimmer over the scorched ground while it is still hot.
      if (b.shimmerLeft > 0 && age > 0.6) {
        b.shimmerTimer -= dt
        while (b.shimmerTimer <= 0 && b.shimmerLeft > 0) {
          b.shimmerTimer += 0.1
          b.shimmerLeft--
          this.shimmer(b, time)
        }
      }

      if (age > 6.5) b.active = false
    }
    void ctx
  }

  private column(b: Blast, time: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const R = b.radius
    const p = P.params
    p.position.copy(b.grounded ? b.ground : b.point).add(this.randomInSphere(R * 0.3))
    p.position.y += R * 0.3
    p.velocity.set(r.spread(0.7), r.range(2.2, 4.2), r.spread(0.7))
    p.life = r.range(3.5, 6)
    p.sizeStart = R * r.range(0.4, 0.7)
    p.sizeEnd = R * r.range(1.8, 3.2)
    p.drag = 0.9
    p.gravity = -0.12
    p.turbulence = 0.45
    p.colorStart.setHex(0x3c3934, SRGB)
    p.colorEnd.setHex(0x54514b, SRGB)
    p.alphaStart = 0.5
    p.alphaEnd = 0
    p.rotation = r.range(0, 6.28)
    p.rotationSpeed = r.spread(0.35)
    p.tile = r.int(0, 3)
    p.frames = 16
    p.erode = 0.7
    p.soft = 0.9
    P.emit('smoke', time)
  }

  /** Nearly invisible warm ripples over the burnt ground. */
  private shimmer(b: Blast, time: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const R = b.radius
    const p = P.params
    p.position.copy(b.grounded ? b.ground : b.point)
    p.position.x += r.spread(R * 0.9)
    p.position.z += r.spread(R * 0.9)
    p.position.y += r.range(0.05, 0.4)
    p.velocity.set(r.spread(0.15), r.range(0.5, 1.3), r.spread(0.15))
    p.life = r.range(1.1, 2.0)
    p.sizeStart = r.range(0.35, 0.7)
    p.sizeEnd = r.range(0.9, 1.6)
    p.drag = 1.2
    p.gravity = -0.25
    p.turbulence = 1.6
    p.colorStart.setRGB(0.5, 0.34, 0.18)
    p.colorEnd.setRGB(0.16, 0.1, 0.05)
    p.alphaStart = 0.1
    p.alphaEnd = 0
    p.rotation = r.range(0, 6.28)
    p.rotationSpeed = r.spread(1.6)
    p.tile = r.int(0, 8)
    p.frames = 16
    p.erode = 0.75
    p.soft = 0.4
    P.emit('smokeAdd', time)
  }

  // --- helpers --------------------------------------------------------------

  private readonly scratch = new THREE.Vector3()

  private randomInSphere(radius: number): THREE.Vector3 {
    const r = this.deps.rand
    this.randomDirection(this.scratch)
    return this.scratch.multiplyScalar(Math.cbrt(r.next()) * radius)
  }

  private randomDirection(out: THREE.Vector3): THREE.Vector3 {
    const r = this.deps.rand
    const z = r.range(-1, 1)
    const a = r.range(0, Math.PI * 2)
    const s = Math.sqrt(Math.max(0, 1 - z * z))
    return out.set(Math.cos(a) * s, z, Math.sin(a) * s)
  }

  private tangentBasis(normal: THREE.Vector3): void {
    if (Math.abs(normal.y) > 0.94) this.t1.set(1, 0, 0)
    else this.t1.set(0, 1, 0)
    this.t1.cross(normal).normalize()
    this.t2.copy(normal).cross(this.t1).normalize()
  }
}
