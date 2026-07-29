import * as THREE from 'three'
import type { GameContext, System, FxService, Surface, HitInfo } from '../core/Types'
import { Rand } from '../core/Rand'
import { buildFxTextures, type FxTextureSet } from './FxTextures'
import { Particles } from './Particles'
import { Decals } from './Decals'
import { Tracers } from './Tracers'
import { Debris } from './Debris'
import { Impacts } from './Impacts'
import { Explosions } from './Explosions'
import { Shells } from './Shells'
import { MuzzleFlash } from './MuzzleFlash'
import { Ambient } from './Ambient'
import { FxLightPool } from './FxLights'

/**
 * All transient visual effects: impacts, decals, tracers, muzzle flash, shell
 * ejection, explosions, blood, smoke and ambient atmosphere.
 *
 * Two things are worth knowing about the architecture:
 *
 * 1. **Nothing allocates per frame.** Particles are spawned by filling one
 *    shared parameter object and writing seven vec4s into a ring buffer; the
 *    GPU integrates their trajectories analytically. Decals, shells, debris and
 *    lights are all fixed-size pools sized from `ctx.config`.
 *
 * 2. **Soft particles need scene depth, so this system renders its own depth
 *    prepass** into a half-resolution target during `lateUpdate`, but only
 *    while depth-fading particles are actually alive. Without it, smoke and
 *    dust slice through the floor along a hard line, which is the single most
 *    obvious tell of amateur particle work.
 *
 * 3. **No card may own the frame.** `Particles.setScreenLimit` caps the
 *    projected size of an individual billboard and fades it out as it reaches
 *    the cap, so a puff spawned two metres from the lens thins away instead of
 *    laying a translucent sheet over the midground. Every world-space emitter
 *    here is additionally sized on the assumption that incoming fire lands
 *    close to the camera constantly.
 *
 * The system is also defensive about who drives it: effects fire both from
 * direct `FxService` calls and from the event bus, de-duplicated by position
 * and time, so a weapon system that only emits events still gets full VFX.
 */
export class FxSystem implements System, FxService {
  readonly name = 'fx'

  private ctx!: GameContext
  private textures!: FxTextureSet
  private world!: Particles
  private view!: Particles
  private decals!: Decals
  private tracers!: Tracers
  private debris!: Debris
  private impacts!: Impacts
  private explosions!: Explosions
  private shells!: Shells
  private muzzle!: MuzzleFlash
  private ambient!: Ambient
  private worldLights!: FxLightPool
  private viewLights!: FxLightPool
  private rand = new Rand(1337)

  private time = 0
  private tracerCounter = 0
  /** Owned here rather than left set on the post chain, so it always decays. */
  private screenFlash = 0

  // --- depth prepass ---
  private depthTarget: THREE.WebGLRenderTarget | null = null
  private depthMaterial = new THREE.MeshDepthMaterial()
  private softEnabled = true
  private readonly bufferSize = new THREE.Vector2()

  // --- de-duplication of event-driven vs direct calls ---
  private readonly recentPoints = new Float32Array(16 * 4)
  private recentHead = 0

  // --- one-shot fallbacks for a shot nobody dressed ---
  private pendingShot = false
  private readonly shotOrigin = new THREE.Vector3()
  private readonly shotDir = new THREE.Vector3()
  private sawMuzzle = false
  private sawTracer = false
  private sawShell = false

  private readonly tmpA = new THREE.Vector3()
  private readonly tmpB = new THREE.Vector3()
  private readonly tmpNormal = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly down = new THREE.Vector3(0, -1, 0)
  private readonly muzzleMatrix = new THREE.Matrix4()
  private readonly muzzleQuat = new THREE.Quaternion()
  private readonly unitScale = new THREE.Vector3(1, 1, 1)

  init(ctx: GameContext): void {
    this.ctx = ctx
    this.rand = new Rand(ctx.config.seed ^ 0x7f2a13)
    this.time = ctx.elapsed

    const budget = ctx.config.particleBudget
    this.softEnabled = ctx.config.quality !== 'low'

    this.textures = buildFxTextures(ctx.config.anisotropy, ctx.config.seed)

    // The world pool is the one that can bury the frame, so it carries a
    // coverage budget. The unit is "fraction of the frame covered by live cloud
    // cards, averaged over their lives" — i.e. the mean alpha the smoke adds to
    // the frame. Measured on the firefight capture, the veil that flattened the
    // lower two thirds sat around 0.2: every tile of the analysed crop had its
    // black floor lifted 20-40 levels, the white point never reached 255 and no
    // pixel fell below 8. Smoke that reads as smoke rather than as a filter has
    // to concentrate its budget: 0.018 buys a visible plume over a tenth of the
    // frame, or an invisible film over all of it, and the difference is entirely
    // in the recipes. Particles enforces this on what is *drawn*, so it is a
    // ceiling rather than a hope. The viewmodel pool is four sprites at the
    // barrel and is never the problem, so it is left uncapped.
    this.world = new Particles(ctx.scene, Math.floor(budget * 0.9), this.textures, this.softEnabled, 0.018)
    this.view = new Particles(ctx.viewmodelScene, Math.min(320, Math.floor(budget * 0.1) + 96), this.textures, false, 1e3)
    // No world card may exceed ~20% of screen width, and they start thinning
    // at half of that. Without this a single impact cloud two metres from the
    // lens veils the whole midground.
    this.world.setScreenLimit(0.18, 0.36)
    this.view.setScreenLimit(0, 0)
    // Nothing within arm's reach. A cloud card at a metre is a sheet over the
    // sharpest part of the frame and never reads as volume; this is the term
    // `nearFieldLift` is actually measuring.
    this.world.setCloudNearFade(0.7, 1.6)
    this.decals = new Decals(ctx.scene, ctx.config.decalBudget, this.textures)
    this.tracers = new Tracers(ctx.scene, 96)
    this.debris = new Debris(ctx.scene, ctx.config.quality === 'low' ? 10 : 26, ctx.config.seed)
    // The chunks spawn hidden and wear one surface each, so the surfaces no
    // chunk currently carries would first reach the compiler mid-explosion.
    ctx.services.prewarm?.world(...this.debris.warmupProxies())
    ctx.services.prewarm?.depthOverride(this.depthMaterial)
    this.worldLights = new FxLightPool(ctx.scene, 3)
    this.viewLights = new FxLightPool(ctx.viewmodelScene, 1)

    this.impacts = new Impacts({
      particles: this.world,
      decals: this.decals,
      debris: this.debris,
      rand: this.rand,
    })
    this.explosions = new Explosions({
      particles: this.world,
      decals: this.decals,
      debris: this.debris,
      lights: this.worldLights,
      rand: this.rand,
      screenFlash: (closeness) => {
        this.screenFlash = Math.max(this.screenFlash, closeness)
      },
    })
    this.shells = new Shells(ctx.scene, ctx.config.quality === 'low' ? 12 : 28, this.world, this.rand)
    this.muzzle = new MuzzleFlash(this.world, this.view, this.worldLights, this.viewLights, this.rand)
    this.ambient = new Ambient(ctx.scene, this.textures, ctx.config.seed, this.world)

    this.createDepthTarget()

    ctx.events.on('fx:explosion', (e) => this.explosion(e.point, e.radius))
    ctx.events.on('weapon:hit', (hit) => this.onWeaponHit(hit))
    ctx.events.on('weapon:fired', (e) => {
      this.pendingShot = true
      this.shotOrigin.copy(e.origin)
      this.shotDir.copy(e.direction).normalize()
    })
    ctx.events.on('player:land', (e) => this.landing(e.position, e.impact))
    ctx.events.on('player:footstep', (e) => this.footstep(e.position, e.surface, e.running))
    ctx.events.on('entity:killed', (e) => this.deathPool(e.entity.position))

    ctx.services.fx = this
  }

  /**
   * One real prepass render behind the loading screen. The override-material
   * program variants are as varied as the scene itself — meshes, instanced
   * meshes with and without per-instance color, skinned soldiers, points,
   * sprites — and enumerating them in a scratch compile kept missing one;
   * every miss was a 115-172ms link inside lateUpdate, mid-combat. Rendering
   * the actual pass once compiles exactly what the scene contains. Soldiers
   * spawn later, so the skinned variant still rides the prewarm scratch.
   */
  postInit(ctx: GameContext): void {
    this.renderDepthPrepass(ctx, true)
  }

  // --- FxService ------------------------------------------------------------

  /**
   * One dead instance held in every pooled draw while the loading screen is
   * up. Programs compile at boot, but Metal builds a pipeline on the first
   * *executed* draw — and pools idling at instanceCount 0 never execute one
   * until the first shot, which then paid 15-80ms. Nothing rasterizes: every
   * held instance has life 0 and parks outside clip space.
   */
  warmDepthPass(): void {
    if (this.ctx) this.renderDepthPrepass(this.ctx, true)
  }

  pipelineWarm(on: boolean): void {
    this.world.warmDraw(on)
    this.view.warmDraw(on)
    this.tracers.warmDraw(on)
    this.debris.warmDraw(on)
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface): void {
    if (!this.ctx || this.claim(point, 0.05)) return
    this.impacts.impact(this.ctx, point, normal, surface, this.time)
  }

  bulletTracer(from: THREE.Vector3, to: THREE.Vector3, speed?: number): void {
    if (!this.ctx) return
    this.sawTracer = true
    this.emitTracer(from, to, speed ?? 340)
  }

  muzzleFlash(matrix: THREE.Matrix4, scale: number, inViewmodelScene: boolean): void {
    if (!this.ctx) return
    this.sawMuzzle = true
    this.muzzle.fire(this.ctx, matrix, scale, inViewmodelScene, this.time)
  }

  ejectShell(position: THREE.Vector3, velocity: THREE.Vector3, inViewmodelScene: boolean): void {
    if (!this.ctx) return
    this.sawShell = true
    this.shells.eject(this.ctx, position, velocity, inViewmodelScene, this.time)
  }

  explosion(point: THREE.Vector3, radius: number): void {
    if (!this.ctx || this.claim(point, 0.6)) return
    this.explosions.detonate(this.ctx, point, radius, this.time)
  }

  blood(point: THREE.Vector3, normal: THREE.Vector3, amount: number): void {
    if (!this.ctx) return
    this.impacts.impact(this.ctx, point, normal, 'flesh', this.time)
    if (amount > 1.4) this.deathPool(point)
  }

  smokePuff(point: THREE.Vector3, radius: number): void {
    if (!this.ctx) return
    const r = this.rand
    const allow = this.world.allowance()
    // Fewer, larger volumes. Three big soft cards read as a body of smoke; a
    // dozen small ones read as a stain, cost four times the fill and pile into
    // the same translucent sheet whenever two puffs happen near each other.
    const count = Math.round(3 * Math.min(radius, 3) * allow)
    for (let i = 0; i < count; i++) {
      const p = this.world.params
      p.position.copy(point)
      p.position.x += r.spread(radius * 0.3)
      p.position.y += r.spread(radius * 0.25)
      p.position.z += r.spread(radius * 0.3)
      p.velocity.set(r.spread(0.6), r.range(0.2, 1.1), r.spread(0.6))
      p.life = r.range(1.6, 3.0)
      p.sizeStart = radius * r.range(0.9, 1.4)
      p.sizeEnd = radius * r.range(2.2, 3.4)
      p.drag = 1.6
      p.gravity = -0.06
      p.turbulence = 0.3
      p.colorStart.setHex(0x8d8880, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x5a5650, THREE.SRGBColorSpace)
      p.alphaStart = 0.44
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.5)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.5
      p.soft = 1.2
      this.world.emit('smoke', this.time)
    }
  }

  // --- event handlers -------------------------------------------------------

  private onWeaponHit(hit: HitInfo): void {
    if (this.claim(hit.point, 0.05)) return
    this.impacts.impact(this.ctx, hit.point, hit.normal, hit.surface, this.time)
  }

  /** Dust kicked out from under the player's boots on a hard landing. */
  private landing(position: THREE.Vector3, impact: number): void {
    const strength = THREE.MathUtils.clamp(impact, 0, 1)
    if (strength < 0.12) return
    const r = this.rand
    const allow = this.world.allowance()
    const count = Math.round((2 + strength * 4) * allow)
    for (let i = 0; i < count; i++) {
      const a = r.range(0, Math.PI * 2)
      const p = this.world.params
      p.position.copy(position)
      p.position.y += 0.03
      p.velocity.set(Math.cos(a) * r.range(0.8, 2.6) * strength, r.range(0.1, 0.6), Math.sin(a) * r.range(0.8, 2.6) * strength)
      p.life = r.range(0.7, 1.3)
      p.sizeStart = r.range(0.16, 0.3)
      p.sizeEnd = r.range(0.6, 1.0)
      p.drag = 3
      p.gravity = 0.04
      p.turbulence = 0.2
      p.colorStart.setHex(0xa89f8d, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x746c5f, THREE.SRGBColorSpace)
      p.alphaStart = 0.3 * strength + 0.06
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.7)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.5
      p.soft = 0.8
      this.world.emit('smoke', this.time)
    }
  }

  private footstep(position: THREE.Vector3, surface: Surface, running: boolean): void {
    if (surface !== 'sand' && surface !== 'dirt' && surface !== 'gravel') return
    const r = this.rand
    // A footstep is under the camera by definition, so it is pure near-field
    // haze and nothing else. One card, and only when the frame can afford it.
    if (this.world.allowance() < 0.5) return
    const count = running ? 2 : 1
    for (let i = 0; i < count; i++) {
      const p = this.world.params
      p.position.copy(position)
      p.position.y += 0.02
      p.velocity.set(r.spread(0.5), r.range(0.05, 0.35), r.spread(0.5))
      p.life = r.range(0.5, 1.0)
      p.sizeStart = r.range(0.10, 0.2)
      p.sizeEnd = r.range(0.44, 0.8)
      p.drag = 3.4
      p.gravity = 0.03
      p.colorStart.setHex(surface === 'sand' ? 0xcbbd9d : 0x8e8371, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6a6154, THREE.SRGBColorSpace)
      p.alphaStart = running ? 0.26 : 0.16
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.5
      p.soft = 0.6
      this.world.emit('smoke', this.time)
    }
  }

  /** Blood pooling under a body, projected onto whatever it fell on. */
  private deathPool(position: THREE.Vector3): void {
    const physics = this.ctx.services.physics
    this.tmpA.copy(position)
    this.tmpA.y += 0.4
    this.tmpNormal.copy(this.up)
    let point = this.tmpA
    if (physics) {
      const hit = physics.raycast(this.tmpA, this.down, 2.6, { characters: false })
      if (!hit) return
      point = this.tmpB.copy(hit.point)
      this.tmpNormal.copy(hit.normal)
    }
    const r = this.rand
    this.decals.spawn(point, this.tmpNormal, 'bloodPool', r.range(0.55, 0.9), r.range(0, Math.PI * 2), this.time, 0.9, 1, 1, 1, 120, 25)
    for (let i = 0; i < 3; i++) {
      this.decals.spawn(
        this.tmpA.set(point.x + r.spread(0.5), point.y, point.z + r.spread(0.5)),
        this.tmpNormal,
        r.bool() ? 'bloodA' : 'bloodB',
        r.range(0.2, 0.42), r.range(0, Math.PI * 2), this.time, 0.85, 1, 1, 1, 120, 25,
      )
    }
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Returns true when an effect has already been played at this point in the
   * last frame or two, so a system that both calls `FxService` and emits an
   * event does not double up.
   */
  private claim(point: THREE.Vector3, radius: number): boolean {
    const r2 = radius * radius
    for (let i = 0; i < 16; i++) {
      const o = i * 4
      if (this.time - this.recentPoints[o + 3] > 0.09) continue
      const dx = this.recentPoints[o] - point.x
      const dy = this.recentPoints[o + 1] - point.y
      const dz = this.recentPoints[o + 2] - point.z
      if (dx * dx + dy * dy + dz * dz <= r2) return true
    }
    const o = this.recentHead * 4
    this.recentHead = (this.recentHead + 1) % 16
    this.recentPoints[o] = point.x
    this.recentPoints[o + 1] = point.y
    this.recentPoints[o + 2] = point.z
    this.recentPoints[o + 3] = this.time
    return false
  }

  private emitTracer(from: THREE.Vector3, to: THREE.Vector3, speed: number): void {
    this.tracerCounter++
    // Every third round is a true tracer; the rest get a faint disturbance so
    // sustained fire still reads as a stream without turning into a laser show.
    const bright = this.tracerCounter % 3 === 0
    this.tracers.spawn(from, to, bright ? speed : speed * 1.25, this.time, bright)
  }

  /** Dresses a shot that the weapon system only announced via the bus. */
  private dressPendingShot(): void {
    if (!this.pendingShot) return
    this.pendingShot = false
    const ctx = this.ctx

    if (!this.sawMuzzle) {
      this.muzzleQuat.setFromUnitVectors(this.tmpA.set(0, 0, -1), this.shotDir)
      this.muzzleMatrix.compose(this.shotOrigin, this.muzzleQuat, this.unitScale)
      this.muzzle.fire(ctx, this.muzzleMatrix, 1, false, this.time, this.shotDir)
    }
    if (!this.sawTracer) {
      const physics = ctx.services.physics
      const hit = physics?.raycast(this.shotOrigin, this.shotDir, 180)
      this.tmpB.copy(this.shotOrigin).addScaledVector(this.shotDir, hit ? hit.distance : 120)
      this.emitTracer(this.shotOrigin, this.tmpB, 340)
    }
    if (!this.sawShell) {
      ctx.camera.getWorldDirection(this.tmpA)
      this.tmpB.copy(this.tmpA).cross(this.up).normalize()
      this.tmpA.copy(this.shotOrigin).addScaledVector(this.tmpB, 0.06).addScaledVector(this.up, -0.02)
      this.tmpB.multiplyScalar(2.6).addScaledVector(this.up, 1.9)
      this.shells.eject(ctx, this.tmpA, this.tmpB, false, this.time)
    }
  }

  // --- frame ----------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    this.time = ctx.elapsed
    // Cost every card against the frame it will actually appear in.
    const focal = ctx.camera.projectionMatrix.elements[5]
    this.world.setViewpoint(ctx.camera.position, focal, ctx.camera.aspect)
    this.view.setViewpoint(ctx.viewmodelCamera.position, focal, ctx.camera.aspect)
    this.explosions.update(ctx, this.time, dt)
    this.shells.update(ctx, this.time, dt)
    this.debris.update(ctx, this.time)
    this.ambient.update(ctx, this.time, dt)
    this.decals.update(this.time)
    this.worldLights.update(this.time)
    this.viewLights.update(this.time)

    if (this.screenFlash > 0) {
      this.screenFlash = Math.max(0, this.screenFlash - dt * 2.4)
      ctx.services.postfx?.setDamageFlash(this.screenFlash)
    }
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    this.dressPendingShot()
    this.sawMuzzle = false
    this.sawTracer = false
    this.sawShell = false

    const depth = this.renderDepthPrepass(ctx)

    const near = ctx.camera.near
    const far = ctx.camera.far
    this.world.setDepth(depth, near, far)
    this.tracers.setDepth(depth, near, far)
    this.view.setDepth(null, ctx.viewmodelCamera.near, ctx.viewmodelCamera.far)
    this.world.update(this.time)
    this.view.update(this.time)
    this.tracers.update(this.time)
  }

  // --- depth prepass --------------------------------------------------------

  private createDepthTarget(): void {
    this.disposeDepthTarget()
    if (!this.softEnabled) return
    this.ctx.renderer.getDrawingBufferSize(this.bufferSize)
    const w = Math.max(160, Math.floor(this.bufferSize.x * 0.5))
    const h = Math.max(120, Math.floor(this.bufferSize.y * 0.5))
    const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType)
    depthTexture.format = THREE.DepthFormat
    depthTexture.minFilter = THREE.NearestFilter
    depthTexture.magFilter = THREE.NearestFilter
    this.depthTarget = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      depthTexture,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    })

    // three allocates the FBO and its textures on first bind, which used to
    // land in the same frame as the first live soft particle — stacked on top
    // of that frame's other first-use costs. Bind once now so the multi-MB
    // allocation happens here instead; no draw is issued, so no frame state
    // advances and the played frames are untouched.
    const gl = this.ctx.renderer
    const prev = gl.getRenderTarget()
    gl.setRenderTarget(this.depthTarget)
    gl.clear(true, true, false)
    gl.setRenderTarget(prev)
  }

  private disposeDepthTarget(): void {
    if (!this.depthTarget) return
    this.depthTarget.depthTexture?.dispose()
    this.depthTarget.dispose()
    this.depthTarget = null
  }

  /**
   * Renders scene depth only, at half resolution, so particles can fade where
   * they intersect geometry. Skipped entirely on frames where nothing is
   * fading, which is most of them; returns null in that case so the particle
   * shader disables its depth fade rather than reading a stale buffer.
   */
  private renderDepthPrepass(ctx: GameContext, force = false): THREE.DepthTexture | null {
    const target = this.depthTarget
    if (!target) return null
    if (!force && !this.world.needsDepth(this.time) && !this.tracers.active(this.time)) return null

    const gl = ctx.renderer
    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    const prevShadow = gl.shadowMap.autoUpdate
    const prevOverride = ctx.scene.overrideMaterial
    const prevBackground = ctx.scene.background

    // The effects themselves must not occlude the effects.
    this.world.setVisible(false)
    this.tracers.setVisible(false)

    ctx.scene.overrideMaterial = this.depthMaterial
    ctx.scene.background = null
    gl.shadowMap.autoUpdate = false
    gl.autoClear = true
    gl.setRenderTarget(target)
    gl.clear(true, true, false)
    gl.render(ctx.scene, ctx.camera)

    gl.setRenderTarget(prevTarget)
    gl.autoClear = prevAutoClear
    gl.shadowMap.autoUpdate = prevShadow
    ctx.scene.overrideMaterial = prevOverride
    ctx.scene.background = prevBackground
    this.world.setVisible(true)
    this.tracers.setVisible(true)
    return target.depthTexture
  }

  resize(_width: number, _height: number): void {
    if (!this.ctx) return
    this.createDepthTarget()
  }

  dispose(): void {
    this.disposeDepthTarget()
    this.depthMaterial.dispose()
    this.world.dispose()
    this.view.dispose()
    this.decals.dispose()
    this.tracers.dispose()
    this.debris.dispose()
    this.shells.dispose()
    this.ambient.dispose()
    this.worldLights.dispose()
    this.viewLights.dispose()
    this.textures.dispose()
  }
}
