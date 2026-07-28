import * as THREE from 'three'
import { SPRITE } from './FxTextures'
import type { Particles } from './Particles'
import type { Decals, DecalKind } from './Decals'
import type { Debris } from './Debris'
import type { GameContext, Surface } from '../core/Types'
import type { Rand } from '../core/Rand'

/**
 * Per-surface impact effects.
 *
 * The whole feel of shooting lives here: what a round does to a wall is the
 * player's only feedback that the shot connected with the world. Each surface
 * gets its own recipe — a hard initial burst, a directional spray, a lingering
 * cloud, a decal of the right colour and, where it earns its keep, real physics
 * debris carrying the round's impulse.
 */

export interface ImpactDeps {
  particles: Particles
  decals: Decals
  debris: Debris
  rand: Rand
}

const RICOCHET_SURFACES: ReadonlySet<Surface> = new Set<Surface>(['metal', 'thinMetal', 'concrete', 'tile', 'gravel'])

export class Impacts {
  private readonly n = new THREE.Vector3()
  private readonly t1 = new THREE.Vector3()
  private readonly t2 = new THREE.Vector3()
  private readonly ca = new THREE.Vector3()
  private readonly cb = new THREE.Vector3()
  private readonly incoming = new THREE.Vector3()
  private readonly reflected = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private readonly probeFrom = new THREE.Vector3()
  private readonly probeDir = new THREE.Vector3()
  private readonly box = new THREE.Box3()
  private readonly boxSize = new THREE.Vector3()
  private readonly shattered = new Set<number>()

  /**
   * Exponentially decayed count of recent impacts, and the multiplier derived
   * from it. A squad of seven puts twenty rounds a second into the geometry
   * around the player; at the full recipe that is well over a thousand live
   * cards, and the frame ends up behind them rather than in front. Twenty
   * simultaneous impacts read as a storm whether each one spends thirty cards
   * or eight, so under sustained fire each one spends fewer.
   */
  private rate = 0
  private rateTime = -1
  /** Cloud attenuation for the impact currently being dressed. */
  private cloud = 1

  constructor(private readonly deps: ImpactDeps) {}

  /** Builds an orthonormal tangent frame around the surface normal. */
  private basis(normal: THREE.Vector3): void {
    this.n.copy(normal).normalize()
    if (Math.abs(this.n.y) > 0.94) this.t1.set(1, 0, 0)
    else this.t1.set(0, 1, 0)
    this.t1.cross(this.n).normalize()
    this.t2.copy(this.n).cross(this.t1).normalize()
  }

  /** Random unit vector in a cone of half-angle `spread` around `axis`. */
  private cone(axis: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
    const r = this.deps.rand
    // Build the spread basis around the cone axis, not the surface normal —
    // ricochet and exit cones point somewhere else entirely.
    if (Math.abs(axis.y) > 0.94) this.ca.set(1, 0, 0)
    else this.ca.set(0, 1, 0)
    this.ca.cross(axis).normalize()
    this.cb.copy(axis).cross(this.ca).normalize()
    const a = r.range(0, Math.PI * 2)
    const s = Math.tan(Math.min(spread, 1.45)) * Math.sqrt(r.next())
    out.copy(axis)
    out.addScaledVector(this.ca, Math.cos(a) * s)
    out.addScaledVector(this.cb, Math.sin(a) * s)
    return out.normalize()
  }

  impact(ctx: GameContext, point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, time: number): void {
    const dist = ctx.camera.position.distanceTo(point)
    if (dist > 140) return

    if (this.rateTime >= 0 && time > this.rateTime) this.rate *= Math.exp(-(time - this.rateTime) / 0.7)
    this.rateTime = time
    this.rate += 1
    const sustained = THREE.MathUtils.clamp(1 - (this.rate - 3) / 22, 0.35, 1)

    const density = THREE.MathUtils.clamp(ctx.config.particleBudget / 8000, 0.35, 1.25)
      * THREE.MathUtils.clamp(1 - (dist - 25) / 90, 0.28, 1)
      * sustained

    // Dust puffs are sized in metres but paid for in pixels, and a half-metre
    // puff two metres from the lens covers sixteen times the frame that the
    // same puff covers at eight. Near-field impacts therefore spend the same
    // *screen* budget as far ones instead of the same world budget — this is
    // the single largest contributor to `nearFieldLift`. `sustained` is already
    // in `density`, so it is deliberately not applied twice: twenty impacts a
    // second should still look like twenty impacts a second.
    this.cloud = this.deps.particles.allowance() * THREE.MathUtils.clamp(dist / 4.5, 0.3, 1)

    this.basis(normal)
    this.incoming.copy(point).sub(ctx.camera.position)
    if (this.incoming.lengthSq() < 1e-6) this.incoming.copy(this.n).negate()
    this.incoming.normalize()
    this.reflected.copy(this.incoming).addScaledVector(this.n, -2 * this.incoming.dot(this.n)).normalize()

    switch (surface) {
      case 'concrete':
      case 'tile':
        this.stone(ctx, point, time, density, 0xb7b0a2, 0x8f887b)
        break
      case 'plaster':
        this.stone(ctx, point, time, density, 0xe0dacb, 0xb8b2a3)
        break
      case 'metal':
      case 'thinMetal':
        this.metal(ctx, point, time, density, surface === 'thinMetal')
        break
      case 'wood':
        this.wood(ctx, point, time, density)
        break
      case 'dirt':
        this.granular(ctx, point, time, density, 0x6f5b40, 0x4a3b28)
        break
      case 'sand':
        this.granular(ctx, point, time, density, 0xd6c39a, 0xa89168)
        break
      case 'gravel':
        this.granular(ctx, point, time, density, 0x958c7d, 0x6b6459)
        break
      case 'glass':
        this.glass(ctx, point, time, density)
        break
      case 'water':
        this.water(ctx, point, time, density)
        break
      case 'flesh':
        this.flesh(ctx, point, time, density, 1)
        break
      case 'foliage':
        this.foliage(ctx, point, time, density)
        break
      case 'fabric':
        this.fabric(ctx, point, time, density)
        break
      case 'rubber':
        this.rubber(ctx, point, time, density)
        break
      default:
        this.stone(ctx, point, time, density, 0xb7b0a2, 0x8f887b)
    }

    this.placeDecal(ctx, point, surface, time)
    if (RICOCHET_SURFACES.has(surface)) this.ricochet(point, time, density, surface)
    ctx.services.audio?.play(`impact_${surface}`, point, { maxDistance: 60 })
  }

  // --- decals ---------------------------------------------------------------

  private placeDecal(ctx: GameContext, point: THREE.Vector3, surface: Surface, time: number): void {
    const r = this.deps.rand
    const kind: DecalKind = this.deps.decals.holeKindFor(surface, r.next())
    let size = 0.16
    let opacity = 1
    let hold = 40
    let fade = 8
    switch (surface) {
      case 'metal':
      case 'thinMetal': size = 0.1; break
      case 'glass': size = 0.34; break
      case 'flesh': size = 0.22; opacity = 0.9; hold = 30; break
      case 'water': size = 0.5; opacity = 0.5; hold = 0.6; fade = 1.2; break
      case 'sand':
      case 'dirt':
      case 'gravel': size = 0.26; opacity = 0.8; break
      case 'foliage': size = 0.2; opacity = 0.6; break
      default: size = 0.17
    }
    this.deps.decals.spawn(
      point, this.n, kind, size * r.range(0.85, 1.2), r.range(0, Math.PI * 2), time,
      opacity, 1, 1, 1, hold, fade,
    )
  }

  // --- per-surface recipes --------------------------------------------------

  /** Concrete, plaster, tile: hard grey burst, chips, a lingering slow cloud. */
  private stone(ctx: GameContext, point: THREE.Vector3, time: number, density: number, hot: number, cool: number): void {
    const P = this.deps.particles
    const r = this.deps.rand

    // 1. Hard initial burst, gone in a couple of frames. Not metered against
    //    the coverage budget: it lives for a fifth of a second, so it costs the
    //    frame almost nothing, and it is what makes the hit read at all.
    for (let i = 0; i < Math.ceil(3 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.03)
      this.cone(this.n, 1.0, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(3.5, 8.5))
      p.life = r.range(0.16, 0.3)
      p.sizeStart = r.range(0.06, 0.12)
      p.sizeEnd = r.range(0.22, 0.42)
      p.drag = 9
      p.gravity = 0.1
      p.colorStart.setHex(0xf2ede2, THREE.SRGBColorSpace)
      p.colorEnd.setHex(hot, THREE.SRGBColorSpace)
      p.alphaStart = 0.9
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(3)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.4
      p.soft = 0.35
      P.emit('smoke', time)
    }

    // 2. Chips flying, velocity-stretched so they read as solid fragments.
    for (let i = 0; i < Math.ceil(5 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.cone(this.n, 1.15, this.dir).lerp(this.reflected, 0.35).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(4, 13))
      p.life = r.range(0.5, 1.1)
      p.sizeStart = r.range(0.012, 0.032)
      p.sizeEnd = p.sizeStart * 0.85
      p.drag = 0.9
      p.gravity = 1
      p.colorStart.setHex(hot, THREE.SRGBColorSpace)
      p.colorEnd.setHex(cool, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 1
      p.rotationSpeed = r.spread(12)
      p.stretch = 0.02
      p.tile = r.bool(0.5) ? SPRITE.chip : SPRITE.granule
      p.soft = 0
      P.emit('sprite', time)
    }

    // 3. Slow-drifting cloud that hangs in the air. Sized so that a burst
    //    landing on cover two metres from the lens does not veil the frame:
    //    incoming fire hits close to the camera constantly, and this is the
    //    single largest source of near-field haze in the game.
    for (let i = 0; i < Math.ceil(3 * density * this.cloud); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, r.range(0.05, 0.22))
      this.cone(this.n, 1.3, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.35, 1.3))
      p.velocity.y += 0.35
      p.life = r.range(1.4, 2.6)
      p.sizeStart = r.range(0.14, 0.24)
      p.sizeEnd = r.range(0.42, 0.72)
      p.drag = 2.2
      p.gravity = -0.03
      p.turbulence = 0.16
      p.colorStart.setHex(hot, THREE.SRGBColorSpace)
      p.colorEnd.setHex(cool, THREE.SRGBColorSpace)
      p.alphaStart = 0.28 * this.cloud
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.6)
      p.tile = r.int(0, 2)
      p.frames = 16
      p.erode = 0.62
      p.soft = 0.65
      P.emit('smoke', time)
    }

    if (density > 0.55 && r.bool(0.45)) {
      this.tmp.copy(this.reflected).multiplyScalar(2.4).setY(Math.abs(this.reflected.y) * 2.4 + 1.4)
      this.deps.debris.spawn(ctx, this.probeFrom.copy(point).addScaledVector(this.n, 0.05), this.tmp, this.deps.rand.range(0.035, 0.07), 'concrete', time)
    }
  }

  /** Metal: bright bouncing sparks, a flash, a tangential ricochet spray. */
  private metal(ctx: GameContext, point: THREE.Vector3, time: number, density: number, thin: boolean): void {
    const P = this.deps.particles
    const r = this.deps.rand

    // Flash at the point of contact — two frames, no more.
    {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      p.life = 0.05
      p.sizeStart = 0.10
      p.sizeEnd = 0.18
      p.drag = 4
      p.colorStart.setRGB(2.9, 2.1, 1.05)
      p.colorEnd.setRGB(1.0, 0.44, 0.12)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.tile = SPRITE.core
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // Sparks: hot, stretched, and they bounce because gravity plus low drag
    // sends them skittering along the floor.
    for (let i = 0; i < Math.ceil(11 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.015)
      this.cone(this.reflected, 0.85, this.dir).lerp(this.n, 0.2).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(5, 19))
      p.life = r.range(0.22, 0.68)
      p.sizeStart = r.range(0.012, 0.026)
      p.sizeEnd = 0.004
      p.drag = 1.4
      p.gravity = 1.1
      p.colorStart.setRGB(5.0, 3.2, 1.2)
      p.colorEnd.setRGB(1.4, 0.32, 0.05)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.stretch = 0.055
      p.tile = SPRITE.streak
      p.soft = 0.05
      P.emit('spriteAdd', time)
    }

    // Tangential spray hugging the surface — the giveaway that a round skipped.
    for (let i = 0; i < Math.ceil(5 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.01)
      const a = r.range(0, Math.PI * 2)
      this.dir.copy(this.t1).multiplyScalar(Math.cos(a)).addScaledVector(this.t2, Math.sin(a))
      this.dir.addScaledVector(this.n, r.range(0.05, 0.25)).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(3, 9))
      p.life = r.range(0.14, 0.34)
      p.sizeStart = r.range(0.008, 0.018)
      p.sizeEnd = 0.003
      p.drag = 3.4
      p.gravity = 0.8
      p.colorStart.setRGB(4.4, 2.6, 0.9)
      p.colorEnd.setRGB(1.1, 0.2, 0.03)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.stretch = 0.07
      p.tile = SPRITE.streak
      p.soft = 0.05
      P.emit('spriteAdd', time)
    }

    // A little paint dust / smoke so it is not pure sparks.
    for (let i = 0; i < Math.ceil(2 * density * this.cloud); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.05)
      this.cone(this.n, 1.2, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.5, 1.6))
      p.life = r.range(0.5, 1.1)
      p.sizeStart = 0.06
      p.sizeEnd = r.range(0.2, 0.36)
      p.drag = 3
      p.gravity = -0.02
      p.colorStart.setHex(thin ? 0x8d8d90 : 0x6f6e70, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x4a4a4c, THREE.SRGBColorSpace)
      p.alphaStart = 0.32 * this.cloud
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(1.5)
      p.frames = 16
      p.erode = 0.5
      P.emit('smoke', time)
    }
    void ctx
  }

  /** Wood: splinters along the grain and a browner dust. */
  private wood(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand

    for (let i = 0; i < Math.ceil(6 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.cone(this.n, 1.0, this.dir).lerp(this.reflected, 0.3).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(3, 10))
      p.life = r.range(0.6, 1.4)
      p.sizeStart = r.range(0.02, 0.055)
      p.sizeEnd = p.sizeStart
      p.drag = 1.5
      p.gravity = 1
      p.colorStart.setHex(0xa87c4c, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6b4c2c, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 1
      p.rotationSpeed = r.spread(14)
      p.stretch = 0.012
      p.tile = SPRITE.splinter
      p.soft = 0
      P.emit('sprite', time)
    }

    for (let i = 0; i < Math.ceil(4 * density * this.cloud); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, r.range(0.02, 0.14))
      this.cone(this.n, 1.2, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1, 4))
      p.life = r.range(0.8, 1.8)
      p.sizeStart = r.range(0.07, 0.14)
      p.sizeEnd = r.range(0.28, 0.52)
      p.drag = 3.2
      p.gravity = 0.05
      p.turbulence = 0.14
      p.colorStart.setHex(0xb0916a, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6d5638, THREE.SRGBColorSpace)
      p.alphaStart = 0.4 * this.cloud
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(1.2)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.55
      P.emit('smoke', time)
    }

    if (density > 0.55 && r.bool(0.35)) {
      this.tmp.copy(this.reflected).multiplyScalar(3).setY(1.6)
      this.deps.debris.spawn(ctx, this.probeFrom.copy(point).addScaledVector(this.n, 0.05), this.tmp, r.range(0.03, 0.06), 'wood', time)
    }
  }

  /** Dirt, sand, gravel: a fan of granular debris kicked along the normal. */
  private granular(ctx: GameContext, point: THREE.Vector3, time: number, density: number, hot: number, cool: number): void {
    const P = this.deps.particles
    const r = this.deps.rand

    for (let i = 0; i < Math.ceil(11 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      // A fan, not a sphere: granular material sprays forward off the surface.
      this.cone(this.n, 0.55, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(3, 11))
      p.life = r.range(0.5, 1.2)
      p.sizeStart = r.range(0.012, 0.03)
      p.sizeEnd = p.sizeStart * 0.7
      p.drag = 1.1
      p.gravity = 1
      p.colorStart.setHex(hot, THREE.SRGBColorSpace)
      p.colorEnd.setHex(cool, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 0.8
      p.stretch = 0.012
      p.tile = SPRITE.granule
      p.soft = 0
      P.emit('sprite', time)
    }

    for (let i = 0; i < Math.ceil(4 * density * this.cloud); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, r.range(0.04, 0.2))
      this.cone(this.n, 0.8, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1.2, 3.6))
      p.life = r.range(1.1, 2.2)
      p.sizeStart = r.range(0.10, 0.19)
      p.sizeEnd = r.range(0.38, 0.68)
      p.drag = 2.6
      p.gravity = 0.06
      p.turbulence = 0.2
      p.colorStart.setHex(hot, THREE.SRGBColorSpace)
      p.colorEnd.setHex(cool, THREE.SRGBColorSpace)
      p.alphaStart = 0.32 * this.cloud
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.8)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.6
      P.emit('smoke', time)
    }
    void ctx
  }

  /** Glass: shards, a bright twinkle, and the pane itself gives way. */
  private glass(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand

    for (let i = 0; i < Math.ceil(16 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.01)
      this.cone(this.incoming, 0.9, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(2, 8))
      p.life = r.range(0.8, 1.6)
      p.sizeStart = r.range(0.02, 0.06)
      p.sizeEnd = p.sizeStart
      p.drag = 1.2
      p.gravity = 1
      p.colorStart.setRGB(1.6, 1.9, 2.0)
      p.colorEnd.setRGB(0.5, 0.62, 0.7)
      p.alphaStart = 0.95
      p.alphaEnd = 0.5
      p.rotationSpeed = r.spread(16)
      p.tile = SPRITE.shard
      p.soft = 0
      P.emit('sprite', time)
    }
    for (let i = 0; i < Math.ceil(6 * density); i++) {
      const p = P.params
      p.position.copy(point)
      this.cone(this.incoming, 1.1, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1, 5))
      p.life = r.range(0.3, 0.8)
      p.sizeStart = r.range(0.01, 0.03)
      p.sizeEnd = 0.004
      p.drag = 2
      p.gravity = 1
      p.colorStart.setRGB(2.2, 2.6, 3.0)
      p.colorEnd.setRGB(0.4, 0.6, 0.8)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.tile = SPRITE.spark
      p.soft = 0
      P.emit('spriteAdd', time)
    }
    ctx.services.audio?.play('glass_break', point, { maxDistance: 70 })
    this.tryShatter(ctx, point, time)
  }

  /**
   * Finds the pane behind the impact and takes it out of the world, replacing
   * it with falling shards. Only small, genuinely glass meshes are eligible so
   * a stray hit can never delete a wall.
   */
  private tryShatter(ctx: GameContext, point: THREE.Vector3, time: number): void {
    const physics = ctx.services.physics
    if (!physics) return
    this.probeFrom.copy(point).addScaledVector(this.n, 0.06)
    this.probeDir.copy(this.n).negate()
    const hit = physics.raycast(this.probeFrom, this.probeDir, 0.14, { characters: false })
    const obj = hit?.object
    if (!obj || hit.surface !== 'glass') return
    if (this.shattered.has(obj.id)) return

    const mesh = obj as THREE.Mesh
    if (!mesh.geometry) return
    mesh.geometry.computeBoundingBox()
    const bb = mesh.geometry.boundingBox
    if (!bb) return
    this.box.copy(bb).applyMatrix4(mesh.matrixWorld)
    this.box.getSize(this.boxSize)
    const volume = this.boxSize.x * this.boxSize.y * this.boxSize.z
    if (volume > 6) return

    this.shattered.add(obj.id)
    mesh.visible = false

    const r = this.deps.rand
    const P = this.deps.particles
    // Falling curtain of glass from across the whole pane.
    for (let i = 0; i < 46; i++) {
      const p = P.params
      p.position.set(
        THREE.MathUtils.lerp(this.box.min.x, this.box.max.x, r.next()),
        THREE.MathUtils.lerp(this.box.min.y, this.box.max.y, r.next()),
        THREE.MathUtils.lerp(this.box.min.z, this.box.max.z, r.next()),
      )
      p.velocity.copy(this.incoming).multiplyScalar(r.range(0.4, 2.4))
      p.velocity.y += r.range(-0.4, 0.6)
      p.life = r.range(1.2, 2.2)
      p.sizeStart = r.range(0.03, 0.1)
      p.sizeEnd = p.sizeStart
      p.drag = 0.5
      p.gravity = 1
      p.colorStart.setRGB(1.4, 1.7, 1.9)
      p.colorEnd.setRGB(0.45, 0.58, 0.68)
      p.alphaStart = 0.9
      p.alphaEnd = 0.3
      p.rotationSpeed = r.spread(10)
      p.tile = SPRITE.shard
      p.soft = 0
      P.emit('sprite', time)
    }
    for (let i = 0; i < 3; i++) {
      this.tmp.copy(this.incoming).multiplyScalar(2).setY(0.4)
      this.deps.debris.spawn(ctx, this.probeFrom.copy(point).addScaledVector(this.n, -0.1), this.tmp, r.range(0.05, 0.11), 'glass', time)
    }
  }

  /** Water: a splash crown, droplets and an expanding ripple. */
  private water(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand

    // Crown: a ring of upward-leaning sheets.
    const crownCount = Math.ceil(9 * density)
    for (let i = 0; i < crownCount; i++) {
      const a = (i / crownCount) * Math.PI * 2 + r.spread(0.2)
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.dir.copy(this.t1).multiplyScalar(Math.cos(a)).addScaledVector(this.t2, Math.sin(a))
      this.dir.addScaledVector(this.n, 2.4).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(2.2, 4.2))
      p.life = r.range(0.4, 0.75)
      p.sizeStart = r.range(0.1, 0.18)
      p.sizeEnd = r.range(0.22, 0.4)
      p.drag = 1.4
      p.gravity = 1
      p.colorStart.setRGB(1.5, 1.7, 1.8)
      p.colorEnd.setRGB(0.72, 0.86, 0.95)
      p.alphaStart = 0.85
      p.alphaEnd = 0
      p.rotation = a + Math.PI * 0.5
      p.tile = SPRITE.crown
      p.soft = 0.15
      P.emit('sprite', time)
    }

    for (let i = 0; i < Math.ceil(20 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.03)
      this.cone(this.n, 0.7, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(2, 7))
      p.life = r.range(0.5, 1.1)
      p.sizeStart = r.range(0.012, 0.032)
      p.sizeEnd = p.sizeStart * 0.8
      p.drag = 0.6
      p.gravity = 1
      p.colorStart.setRGB(1.3, 1.5, 1.7)
      p.colorEnd.setRGB(0.6, 0.75, 0.9)
      p.alphaStart = 0.9
      p.alphaEnd = 0.2
      p.stretch = 0.02
      p.tile = SPRITE.droplet
      p.soft = 0
      P.emit('sprite', time)
    }

    // Fine mist above the splash.
    for (let i = 0; i < Math.ceil(4 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, r.range(0.05, 0.3))
      this.cone(this.n, 1.0, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.4, 1.5))
      p.life = r.range(0.6, 1.2)
      p.sizeStart = 0.14
      p.sizeEnd = r.range(0.5, 0.9)
      p.drag = 3
      p.gravity = 0.15
      p.colorStart.setRGB(1.0, 1.1, 1.2)
      p.colorEnd.setRGB(0.7, 0.78, 0.85)
      p.alphaStart = 0.32
      p.alphaEnd = 0
      p.tile = SPRITE.mist
      p.soft = 0.4
      P.emit('sprite', time)
    }
    void ctx
  }

  /** Flesh: a directional mist cone and a short spray. No gore excess. */
  flesh(ctx: GameContext, point: THREE.Vector3, time: number, density: number, amount: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    const scale = THREE.MathUtils.clamp(amount, 0.4, 2.5)

    // Mist continues along the bullet path — the classic exit cone.
    for (let i = 0; i < Math.ceil(10 * density * scale); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.03)
      this.cone(this.incoming, 0.5, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1.5, 5.5) * scale)
      p.life = r.range(0.4, 0.9)
      p.sizeStart = r.range(0.05, 0.12) * scale
      p.sizeEnd = r.range(0.2, 0.42) * scale
      p.drag = 4.5
      p.gravity = 0.35
      p.turbulence = 0.12
      p.colorStart.setHex(0x8e1010, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x3a0606, THREE.SRGBColorSpace)
      p.alphaStart = 0.8
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(2)
      p.tile = SPRITE.mist
      p.soft = 0.25
      P.emit('sprite', time)
    }

    // A few heavier droplets that arc and land.
    for (let i = 0; i < Math.ceil(7 * density * scale); i++) {
      const p = P.params
      p.position.copy(point)
      this.cone(this.incoming, 0.9, this.dir).lerp(this.n, 0.25).normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(2, 7) * scale)
      p.life = r.range(0.5, 1.0)
      p.sizeStart = r.range(0.01, 0.028)
      p.sizeEnd = p.sizeStart
      p.drag = 0.8
      p.gravity = 1
      p.colorStart.setHex(0x6d0c0c, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x3a0505, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 0.8
      p.stretch = 0.02
      p.tile = SPRITE.droplet
      p.soft = 0
      P.emit('sprite', time)
    }
    void ctx
  }

  private foliage(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    for (let i = 0; i < Math.ceil(10 * density); i++) {
      const p = P.params
      p.position.copy(point)
      this.cone(this.n, 1.4, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.8, 4))
      p.life = r.range(1.2, 2.6)
      p.sizeStart = r.range(0.025, 0.06)
      p.sizeEnd = p.sizeStart
      p.drag = 2.2
      p.gravity = 0.55
      p.turbulence = 0.5
      p.colorStart.setHex(0x64803c, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x3d5226, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 0.6
      p.rotationSpeed = r.spread(7)
      p.tile = SPRITE.leaf
      p.soft = 0
      P.emit('sprite', time)
    }
    void ctx
  }

  private fabric(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    for (let i = 0; i < Math.ceil(6 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.cone(this.n, 1.1, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.6, 2.6))
      p.life = r.range(0.7, 1.5)
      p.sizeStart = r.range(0.05, 0.11)
      p.sizeEnd = r.range(0.2, 0.4)
      p.drag = 3.5
      p.gravity = 0.15
      p.colorStart.setHex(0xa89c8b, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6f665a, THREE.SRGBColorSpace)
      p.alphaStart = 0.55
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(2)
      p.tile = SPRITE.puff
      p.soft = 0.3
      P.emit('sprite', time)
    }
    for (let i = 0; i < Math.ceil(4 * density); i++) {
      const p = P.params
      p.position.copy(point)
      this.cone(this.n, 1.3, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1, 4))
      p.life = r.range(0.8, 1.6)
      p.sizeStart = r.range(0.015, 0.035)
      p.sizeEnd = p.sizeStart
      p.drag = 1.8
      p.gravity = 0.8
      p.colorStart.setHex(0x9d9080, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6a6155, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 0.5
      p.rotationSpeed = r.spread(9)
      p.tile = SPRITE.scrap
      p.soft = 0
      P.emit('sprite', time)
    }
    void ctx
  }

  private rubber(ctx: GameContext, point: THREE.Vector3, time: number, density: number): void {
    const P = this.deps.particles
    const r = this.deps.rand
    for (let i = 0; i < Math.ceil(7 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.cone(this.n, 1.0, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(1.5, 5))
      p.life = r.range(0.5, 1.1)
      p.sizeStart = r.range(0.012, 0.03)
      p.sizeEnd = p.sizeStart
      p.drag = 1.6
      p.gravity = 1
      p.colorStart.setHex(0x38383a, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x1e1e20, THREE.SRGBColorSpace)
      p.alphaStart = 1
      p.alphaEnd = 0.8
      p.rotationSpeed = r.spread(10)
      p.tile = SPRITE.chip
      p.soft = 0
      P.emit('sprite', time)
    }
    void ctx
  }

  /** A couple of long-lived sparks that skip away from a glancing hit. */
  private ricochet(point: THREE.Vector3, time: number, density: number, surface: Surface): void {
    if (!this.deps.rand.bool(surface === 'metal' || surface === 'thinMetal' ? 0.65 : 0.22)) return
    const P = this.deps.particles
    const r = this.deps.rand
    for (let i = 0; i < Math.ceil(3 * density); i++) {
      const p = P.params
      p.position.copy(point).addScaledVector(this.n, 0.02)
      this.cone(this.reflected, 0.28, this.dir)
      p.velocity.copy(this.dir).multiplyScalar(r.range(14, 30))
      p.life = r.range(0.5, 1.1)
      p.sizeStart = 0.02
      p.sizeEnd = 0.004
      p.drag = 0.9
      p.gravity = 1
      p.colorStart.setRGB(4.6, 2.9, 1.0)
      p.colorEnd.setRGB(1.1, 0.18, 0.02)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.stretch = 0.05
      p.tile = SPRITE.streak
      p.soft = 0
      P.emit('spriteAdd', time)
    }
  }
}
