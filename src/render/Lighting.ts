import * as THREE from 'three'
import type { GameContext, System, LightingService } from '../core/Types'
import { SkyDome } from './Sky'
import { ShadowCascade } from './lighting/ShadowCascade'
import { LightPool, type LightLease } from './lighting/LightPool'
import { LightShafts } from './lighting/LightShafts'
import {
  DEFAULT_TIME_OF_DAY, SKY_PARAMS, SKY_SCALE_VISIBLE,
  luminance, skyColor, sunBeamColor, sunDirectionFor,
} from './lighting/SkyModel'

/** Luminance the key light lands on with the sun high enough to matter. */
const SUN_TARGET_LUMINANCE = 5.0
/** Sky-bounce fill, deliberately a small fraction of the key. */
const HEMISPHERE_INTENSITY = 0.16

const POOL_SIZE: Record<string, number> = { low: 3, medium: 4, high: 5, ultra: 5 }
const INTERIOR_FILLS: Record<string, number> = { low: 0, medium: 2, high: 3, ultra: 3 }
const FOG_DENSITY: Record<string, number> = { low: 0.0065, medium: 0.006, high: 0.0055, ultra: 0.0055 }

/**
 * Sun, sky, image-based ambient, the shadow cascade, volumetric shafts and the
 * pool of dynamic lights.
 *
 * Art direction is a single deliberate choice: late afternoon, sun 21 degrees
 * up and 70 degrees round, warm key against a cool sky bounce, shadows two and
 * a half times the height of whatever throws them. That colour opposition --
 * amber light, blue shadow -- is most of what makes rendered daylight read as
 * real, and a low sun is what gives geometry something to write with.
 */
export class LightingSystem implements System, LightingService {
  readonly name = 'lighting'

  /**
   * Accurate descriptor of the key light: direction, colour and intensity all
   * read correctly. It is deliberately *not* parented into the scene -- the
   * cascade owns the real directional lights, and adding this one would double
   * the sun. Read `sunDirection` in preference to `sun.position`.
   */
  readonly sun = new THREE.DirectionalLight(0xffecd3, SUN_TARGET_LUMINANCE)
  readonly sunDirection = new THREE.Vector3(0, 1, 0)
  environment: THREE.Texture | null = null

  /** Billboard the post chain may use as a god-ray source. */
  get sunSource(): THREE.Mesh {
    return this.sky.sunSource
  }

  /** Current aerial-perspective colour, matching the sky the camera is facing. */
  readonly fogColor = new THREE.Color()

  readonly sky = new SkyDome()
  private cascade: ShadowCascade | null = null
  private pool!: LightPool
  private shafts!: LightShafts
  private hemisphere = new THREE.HemisphereLight(0x9dbdea, 0x6a5c46, HEMISPHERE_INTENSITY)
  private fog = new THREE.FogExp2(0xb9c9d8, 0.0055)
  private interiorFills: THREE.PointLight[] = []
  private viewmodelRig = new THREE.Group()
  private viewmodelKey = new THREE.PointLight(0xffecd3, 6.5, 0, 2)
  private viewmodelFill = new THREE.PointLight(0x9dbdea, 1.7, 0, 2)
  private viewmodelRim = new THREE.PointLight(0xfff2de, 3.2, 0, 2)

  private ctx!: GameContext
  private timeOfDay = DEFAULT_TIME_OF_DAY
  private environmentDirty = true
  private shaftsDirty = true
  private frames = 0
  private indoorBlend = 0
  private baseFogDensity = 0.0055
  private projScale = 600
  private viewportHeight = 1080

  // Per-frame scratch. Nothing in the update path allocates.
  private readonly sunTint = new THREE.Color()
  private readonly ambientTint = new THREE.Color()
  private readonly bounceTint = new THREE.Color()
  private readonly fogSample = new THREE.Color()
  private readonly muzzleColor = new THREE.Color(1.0, 0.86, 0.62)
  private readonly explosionColor = new THREE.Color(1.0, 0.52, 0.2)
  private readonly tmpDir = new THREE.Vector3()
  private readonly tmpDir2 = new THREE.Vector3()
  private readonly tmpVec = new THREE.Vector3()
  private readonly tmpQuat = new THREE.Quaternion()
  private readonly viewmodelKeyRest = new THREE.Vector3(-0.62, 0.72, 0.34).normalize()

  init(ctx: GameContext): void {
    this.ctx = ctx
    const { scene, camera, config } = ctx

    this.applyTimeOfDay(this.timeOfDay)

    scene.add(this.sky.mesh)
    scene.add(this.sky.sunSource)
    scene.add(this.hemisphere)

    this.baseFogDensity = FOG_DENSITY[config.quality] ?? 0.0055
    this.fog.density = this.baseFogDensity
    this.fog.color.copy(this.fogColor)
    scene.fog = this.fog

    // The cascade wants the direction light travels, not the direction of the
    // sun from the ground.
    this.cascade = new ShadowCascade(
      scene,
      camera,
      config.shadowCascades,
      config.shadowMapSize,
      config.shadowDistance,
      this.tmpDir.copy(this.sunDirection).negate(),
    )
    this.cascade.setColor(this.sunTint, this.sun.intensity)

    this.pool = new LightPool(scene, POOL_SIZE[config.quality] ?? 4)
    this.shafts = new LightShafts(scene)
    this.shafts.setVisible(config.volumetricLight)

    this.buildInteriorFills(scene, INTERIOR_FILLS[config.quality] ?? 2)
    this.setupViewmodelRig(ctx)

    this.environment = this.sky.generateEnvironment(ctx.renderer)
    scene.environment = this.environment
    ctx.viewmodelScene.environment = this.environment
    this.environmentDirty = false

    // Discoverable by name for systems that only see the LightingService shape.
    scene.userData.sunLightSource = this.sky.sunSource
    scene.userData.lighting = this

    ctx.events.on('weapon:fired', this.onWeaponFired)
    ctx.events.on('fx:explosion', this.onExplosion)

    ctx.services.lighting = this
  }

  // --- Time of day ---------------------------------------------------------

  setTimeOfDay(t: number): void {
    const clamped = THREE.MathUtils.clamp(t, 0, 1)
    if (Math.abs(clamped - this.timeOfDay) < 1e-4) return
    this.timeOfDay = clamped
    this.applyTimeOfDay(clamped)
    this.cascade?.setLightDirection(this.tmpDir.copy(this.sunDirection).negate())
    this.cascade?.setColor(this.sunTint, this.sun.intensity)
    this.environmentDirty = true
    this.shaftsDirty = true
  }

  /** Recomputes every colour and intensity derived from the sun's position. */
  private applyTimeOfDay(t: number): void {
    sunDirectionFor(t, this.sunDirection)
    const elevation = Math.max(0, this.sunDirection.y)

    // Warm the key as the sun drops, and blend back off pure Preetham
    // extinction, which would otherwise reach a sodium orange by mid-afternoon.
    const whiteBlend = THREE.MathUtils.lerp(0.28, 0.55, THREE.MathUtils.clamp(elevation * 1.6, 0, 1))
    sunBeamColor(this.sunDirection, whiteBlend, this.sunTint)
    const tintLuminance = Math.max(0.08, luminance(this.sunTint))
    const horizonFade = THREE.MathUtils.smoothstep(elevation, 0.0, 0.14)

    this.sun.color.copy(this.sunTint)
    this.sun.intensity = (SUN_TARGET_LUMINANCE / tintLuminance) * horizonFade
    this.sun.position.copy(this.sunDirection).multiplyScalar(400)
    this.sun.target.position.set(0, 0, 0)

    this.sky.setSun(this.sunDirection, this.sunTint)

    // Ambient tint: the sky roughly opposite the sun, which is what actually
    // fills a shadow. Normalised so intensity alone controls its strength.
    this.tmpDir2.set(-this.sunDirection.x, 0.9, -this.sunDirection.z).normalize()
    skyColor(this.tmpDir2, this.sunDirection, SKY_PARAMS, 1, this.ambientTint)
    const peak = Math.max(this.ambientTint.r, this.ambientTint.g, this.ambientTint.b, 1e-4)
    this.ambientTint.setRGB(
      this.ambientTint.r / peak,
      this.ambientTint.g / peak,
      this.ambientTint.b / peak,
      THREE.LinearSRGBColorSpace,
    )
    this.hemisphere.color.copy(this.ambientTint)
    this.hemisphere.intensity = HEMISPHERE_INTENSITY * horizonFade

    // Ground bounce: sun colour filtered through dust and asphalt.
    this.bounceTint.setRGB(
      this.sunTint.r * 0.62,
      this.sunTint.g * 0.5,
      this.sunTint.b * 0.36,
      THREE.LinearSRGBColorSpace,
    )
    this.hemisphere.groundColor.copy(this.bounceTint)

    for (const fill of this.interiorFills) fill.color.copy(this.bounceTint)
    this.viewmodelKey.color.copy(this.sunTint)
    this.viewmodelFill.color.copy(this.ambientTint)
    this.viewmodelRim.color.copy(this.sunTint)

    this.updateFogColor(this.tmpDir.set(0, 0.05, -1))
  }

  // --- Frame ---------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    this.frames++
    this.pool.update(dt)

    if (this.environmentDirty) {
      this.environmentDirty = false
      this.environment = this.sky.generateEnvironment(ctx.renderer)
      ctx.scene.environment = this.environment
      ctx.viewmodelScene.environment = this.environment
    }

    // The probe needs the level's collision, which lands during the level
    // system's init, and a settled physics world.
    if (this.shaftsDirty && this.frames > 2) {
      this.shaftsDirty = false
      this.rebuildShafts(ctx)
    }
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const camera = ctx.camera
    camera.getWorldPosition(this.tmpVec)

    this.sky.follow(this.tmpVec, this.sunDirection)
    this.cascade?.update(dt, ctx.scene)

    // Aerial perspective tracks where the camera is looking, so haze runs warm
    // into the sun and cool away from it instead of sitting on one flat grey.
    camera.getWorldDirection(this.tmpDir)
    this.updateFogColor(this.tmpDir)

    const indoors = ctx.services.level?.isIndoors(this.tmpVec) ?? false
    const target = indoors ? 1 : 0
    this.indoorBlend += (target - this.indoorBlend) * Math.min(1, dt * 3)
    if (ctx.scene.fog instanceof THREE.FogExp2) {
      // Interiors have far less air between the camera and the far wall; the
      // outdoor density would grey out a room that should read as crisp.
      ctx.scene.fog.density = this.baseFogDensity * THREE.MathUtils.lerp(1, 0.3, this.indoorBlend)
      ctx.scene.fog.color.copy(this.fogColor)
    } else if (ctx.scene.fog === null) {
      ctx.scene.fog = this.fog
    }

    // Recomputed per frame because aiming down sights narrows the field of
    // view, and dust motes are sized in metres rather than pixels.
    const fov = THREE.MathUtils.degToRad(camera.fov)
    this.projScale = this.viewportHeight / (2 * Math.tan(fov * 0.5))
    this.shafts.update(ctx.elapsed, this.tmpVec, this.projScale)
    this.updateViewmodelRig(ctx)
  }

  private updateFogColor(viewDirection: THREE.Vector3): void {
    // Sample just above the horizon: that is the band distant geometry sits in.
    this.tmpDir2.set(viewDirection.x, 0.055, viewDirection.z)
    if (this.tmpDir2.lengthSq() < 1e-6) this.tmpDir2.set(0, 1, 0)
    this.tmpDir2.normalize()
    skyColor(this.tmpDir2, this.sunDirection, SKY_PARAMS, SKY_SCALE_VISIBLE * 0.92, this.fogSample)

    // Looking into a low sun the horizon runs to several hundred nits of
    // forward-scattered light. Left alone it would bleach every distant surface
    // to white, so the haze is capped while its hue is kept.
    const lum = luminance(this.fogSample)
    const cap = 1.45
    const scale = lum > cap ? cap / lum : 1
    this.fogColor.setRGB(
      this.fogSample.r * scale,
      this.fogSample.g * scale,
      this.fogSample.b * scale,
      THREE.LinearSRGBColorSpace,
    )
  }

  // --- Shafts and interior fill --------------------------------------------

  private rebuildShafts(ctx: GameContext): void {
    if (!ctx.config.volumetricLight) return
    try {
      // Tuned so a shaft reads clearly brighter than the ambient floor around
      // it but never out-shines the sunlit patch it lands on.
      this.shafts.build(ctx, this.sunDirection, this.sunTint, 0.18)
    } catch (err) {
      console.warn('[lighting] shaft probe failed', err)
      return
    }
    // Park the interior fills in the rooms the probe found light entering.
    const points = this.shafts.fillPoints
    for (let i = 0; i < this.interiorFills.length; i++) {
      const fill = this.interiorFills[i]
      const point = points[i]
      if (point) {
        fill.position.copy(point)
        fill.intensity = 3.2
      } else {
        fill.intensity = 0
      }
    }
  }

  private buildInteriorFills(scene: THREE.Scene, count: number): void {
    for (let i = 0; i < count; i++) {
      // Faked bounce off a sunlit floor patch: warm, short range, no shadow.
      const light = new THREE.PointLight(0xffd9a8, 0, 9, 2)
      light.color.copy(this.bounceTint)
      light.name = `interiorFill${i}`
      light.castShadow = false
      scene.add(light)
      this.interiorFills.push(light)
    }
  }

  // --- Viewmodel -----------------------------------------------------------

  /**
   * The weapon lives in its own scene with its own camera, so none of the world
   * lighting reaches it. Point lights rather than directionals: if the weapon
   * shares a material with the world, that material has been set up for the
   * shadow cascade, and the cascade's shader treats every directional light in
   * scope as a cascade of one sun.
   */
  private setupViewmodelRig(ctx: GameContext): void {
    this.viewmodelRig.name = 'viewmodelLightRig'
    this.viewmodelKey.position.copy(this.viewmodelKeyRest).multiplyScalar(1.5)
    this.viewmodelFill.position.set(0.9, -0.15, 0.75)
    this.viewmodelRim.position.set(0.55, 0.45, -1.5)
    for (const light of [this.viewmodelKey, this.viewmodelFill, this.viewmodelRim]) {
      light.castShadow = false
      this.viewmodelRig.add(light)
    }
    ctx.viewmodelScene.add(this.viewmodelRig)
  }

  private updateViewmodelRig(ctx: GameContext): void {
    const vm = ctx.viewmodelCamera
    this.viewmodelRig.position.copy(vm.position)
    this.viewmodelRig.quaternion.copy(vm.quaternion)

    // Swing the key partly towards the real sun so turning through the world
    // reads on the weapon, without ever letting it fall completely dark.
    ctx.camera.getWorldQuaternion(this.tmpQuat).invert()
    this.tmpDir.copy(this.sunDirection).applyQuaternion(this.tmpQuat)
    this.tmpDir.multiplyScalar(0.45).addScaledVector(this.viewmodelKeyRest, 0.55)
    if (this.tmpDir.lengthSq() < 1e-5) this.tmpDir.copy(this.viewmodelKeyRest)
    this.viewmodelKey.position.copy(this.tmpDir).normalize().multiplyScalar(1.5)
  }

  // --- Dynamic lights ------------------------------------------------------

  /** Claims a pooled point light. Hand it back with `returnLight`. */
  borrowLight(priority = 1): LightLease | null {
    return this.pool.borrow(priority)
  }

  returnLight(lease: LightLease): void {
    this.pool.release(lease)
  }

  /** One-shot burst that returns itself to the pool as it burns out. */
  flashLight(
    position: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    distance: number,
    duration: number,
    priority = 1,
  ): void {
    this.pool.flash(position, color, intensity, distance, duration, priority)
  }

  private onWeaponFired = (e: { origin: THREE.Vector3; direction: THREE.Vector3; loud: boolean }): void => {
    const strength = e.loud ? 1 : 0.35
    this.tmpVec.copy(e.origin).addScaledVector(e.direction, 0.3)
    this.pool.flash(this.tmpVec, this.muzzleColor, 26 * strength, 16, 0.06, 2)
  }

  private onExplosion = (e: { point: THREE.Vector3; radius: number }): void => {
    this.pool.flash(e.point, this.explosionColor, 55 * e.radius, e.radius * 5, 0.42, 6)
  }

  // --- Lifecycle -----------------------------------------------------------

  resize(_width: number, height: number): void {
    this.viewportHeight = height
    // Splits are derived from the projection, which the aspect change rewrote.
    this.cascade?.refresh()
  }

  dispose(): void {
    this.ctx?.events.off('weapon:fired', this.onWeaponFired)
    this.ctx?.events.off('fx:explosion', this.onExplosion)
    this.cascade?.dispose()
    this.shafts?.dispose()
    this.pool?.dispose()
    this.sky.dispose()
    this.sun.dispose()
    this.hemisphere.dispose()
    for (const fill of this.interiorFills) fill.dispose()
    this.viewmodelKey.dispose()
    this.viewmodelFill.dispose()
    this.viewmodelRim.dispose()
    this.viewmodelRig.removeFromParent()
  }
}
