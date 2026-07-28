import * as THREE from 'three'
import type { GameContext, System, LightingService } from '../core/Types'
import { SkyDome } from './Sky'
import { ShadowCascade } from './lighting/ShadowCascade'
import { LightPool, type LightLease } from './lighting/LightPool'
import { LightShafts } from './lighting/LightShafts'
import { SkyOcclusion } from './lighting/SkyOcclusion'
import { AerialPerspective } from './lighting/AerialPerspective'
import {
  DEFAULT_TIME_OF_DAY, SKY_PARAMS, SKY_SCALE_VISIBLE,
  betaMie, betaRayleigh, luminance, skyColor, sunBeamColor, sunDirectionFor, sunIntensity,
} from './lighting/SkyModel'

/**
 * Luminance the key light lands on with the sun high enough to matter.
 *
 * The single number that decides whether a daylight frame reads as daylight is
 * this against the fill, and the fill is set almost entirely by SKY_SCALE_ENV
 * in SkyModel — the hemisphere light below is under a tenth of it. At the
 * previous pair a patch of ground in shade sat at 44 per cent of the same patch
 * in sun; clear-sky daylight at a 21-degree elevation is nearer 24. That is the
 * measurement behind every "no discernible light direction", "flat uniform
 * lighting" and "nondirectional fill" note the critics have filed.
 *
 * Raised rather than only cutting the fill, for two reasons. It keeps sunlit
 * surfaces at the exposure the post chain is already calibrated to — a sunlit
 * mid-albedo ground plane stays at sRGB 107 — so widening the ratio does not
 * silently re-expose the whole frame. And it is what buys the frame a white
 * point: nothing in the world except a specular highlight is ever going to
 * reach the top of the tone curve, and a highlight's peak scales with the key.
 *
 * The absolute value is scene-referred and is only meaningful next to the post
 * chain's exposure — see SKY_SCALE_VISIBLE in SkyModel for the full
 * calibration. Changing exposure without changing these, or the reverse, moves
 * the whole frame.
 */
const SUN_TARGET_LUMINANCE = 2.9
/**
 * Uniform sky fill, on top of the image-based ambient.
 *
 * Deliberately small, and smaller than it looks: measured against the probe,
 * the environment map delivers about 0.23 of irradiance to an upward-facing
 * surface and this delivers 0.023. Moving it between 0.075 and 0.135, as the
 * previous two rounds did, changes the total fill by five per cent — it was
 * never the knob that flattened the light, and treating it as one is how two
 * rounds went by without the ratio actually moving.
 *
 * What it is still good for is the part of the sky a cube probe under-serves:
 * it is the one ambient term that survives when the environment map has not
 * been regenerated yet. Kept low so the *directional* half of the fill — the
 * bounce in SkyOcclusion — carries the shading variation instead.
 */
const HEMISPHERE_INTENSITY = 0.055

/**
 * Warm bounce standing in for the light a sunlit floor throws back into a room
 * the sun never reaches. Unshadowed: it is fill, not a key.
 *
 * The intensity and the decay have to be read together, because what was wrong
 * with the previous pair was the *shape*, not the level. At intensity 7 with the
 * physical decay of 2, this light delivered 1.44 of irradiance to the floor
 * directly beneath it against 1.04 from the sun on open ground — a bounce fill
 * 39 per cent brighter than direct sunlight — and then fell to 5 per cent of
 * sunlight four metres further out. A 27:1 falloff across one room reads as a
 * lamp on a stand, which is precisely what the placement comment says it is
 * trying not to look like, and it left the rest of the room dark anyway.
 *
 * The physical answer is that a decay of 2 is wrong here. Inverse square is the
 * falloff of a point, and what this stands in for is a patch of sunlit floor
 * several metres across; near an area source the falloff is far shallower.
 * Decay 1.35 with the intensity re-solved to match keeps the same irradiance at
 * six metres — the distance the old light was actually useful at — while
 * halving the hot spot under it and delivering four times as much at ten. Same
 * light in the room, spread over the room instead of pooled under one point.
 */
const INTERIOR_FILL_INTENSITY = 1.9
const INTERIOR_FILL_RANGE = 20
const INTERIOR_FILL_DECAY = 1.35

const POOL_SIZE: Record<string, number> = { low: 3, medium: 4, high: 5, ultra: 5 }
/**
 * Kept tight on purpose. Three compiles the point light count into every lit
 * material and walks the whole array per fragment however many of them are
 * idling at zero, and this system is not the only one holding a pool — the
 * effects and AI systems have their own. What was actually broken about
 * interiors was the allocation below, not the count.
 */
const INTERIOR_FILLS: Record<string, number> = { low: 0, medium: 4, high: 5, ultra: 5 }

/**
 * Fraction of the interior fills a shaft-lit room may take. Sunlit rooms are
 * the pretty ones and sort to the front, but they are also the rooms that least
 * need help; leaving them the whole budget is what left every unlit interior a
 * black void. See `placeInteriorFills`.
 */
const LIT_ROOM_FILL_SHARE = 0.4

/**
 * How far apart two placed fills must be, in metres.
 *
 * Tied to {@link INTERIOR_FILL_RANGE}, and it has to move with it: two fills
 * closer together than about half their reach are lighting the same air twice
 * while some other room gets nothing, and with only three slots reserved for
 * unlit interiors that is an expensive mistake. The candidate list this draws
 * from is already spaced by SkyOcclusion, more tightly than this — deliberately,
 * so there is a surplus to choose from and the spread-out ones can be picked.
 */
const INTERIOR_FILL_SPACING = 10

/**
 * Residual `FogExp2` density.
 *
 * Distance haze on the lit world is done properly by {@link AerialPerspective},
 * which replaces this fog wholesale on every material the cascade registers.
 * `scene.fog` stays set for two reasons: it is what turns on the `USE_FOG`
 * define and the view-depth varying that pass is built on, and unlit extras —
 * particle cards, decals — still want *some* distance cue. Small, because a
 * squared-exponential is the wrong curve and this is only its remainder.
 */
const RESIDUAL_FOG_DENSITY = 0.0016

/**
 * Fog radiance rolls off towards this rather than being hard-clipped, so haze
 * into a low sun stays visibly brighter and warmer than haze away from it
 * instead of both landing on the same near-white. Kept equal to the aerial
 * pass's own ceiling so `fogColor`, which this system advertises as the current
 * haze colour and the particle shaders read, is the colour the world is
 * actually fading towards.
 */
const FOG_ROLLOFF = 0.26

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
  private readonly occlusion = new SkyOcclusion()
  private readonly aerial = new AerialPerspective()
  private hemisphere = new THREE.HemisphereLight(0x9dbdea, 0x6a5c46, HEMISPHERE_INTENSITY)
  private fog = new THREE.FogExp2(0xb9c9d8, RESIDUAL_FOG_DENSITY)
  private interiorFills: THREE.PointLight[] = []

  private ctx!: GameContext
  private timeOfDay = DEFAULT_TIME_OF_DAY
  private environmentDirty = true
  private shaftsDirty = true
  private frames = 0
  private indoorBlend = 0
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
  private readonly tmpBetaR = new THREE.Vector3()
  private readonly tmpBetaM = new THREE.Vector3()

  init(ctx: GameContext): void {
    this.ctx = ctx
    const { scene, camera, config } = ctx

    this.applyTimeOfDay(this.timeOfDay)

    scene.add(this.sky.mesh)
    scene.add(this.sky.sunSource)
    scene.add(this.hemisphere)

    this.fog.density = RESIDUAL_FOG_DENSITY
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
    // The cascade's sweep is the only pass that sees every lit world material,
    // so both shading terms that have to touch all of them ride on it rather
    // than traversing the scene again.
    this.cascade.materialHook = this.patchWorldMaterial

    this.pool = new LightPool(scene, POOL_SIZE[config.quality] ?? 4)
    this.shafts = new LightShafts(scene)
    this.shafts.setVisible(config.volumetricLight)

    this.buildInteriorFills(scene, INTERIOR_FILLS[config.quality] ?? 2)
    this.setupViewmodelRig(ctx)

    this.environment = this.sky.generateEnvironment(ctx.renderer)
    scene.environment = this.environment
    // Deliberately not applied to the viewmodel scene — see update().
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
    // The haze evaluates the same Preetham model per fragment, so it is fed the
    // same inputs the dome is: distance must fade towards the sky it is fading
    // into, not towards a colour sampled somewhere else.
    this.aerial.setSun(
      betaRayleigh(SKY_PARAMS, this.tmpBetaR),
      betaMie(SKY_PARAMS, this.tmpBetaM),
      this.sunDirection,
      sunIntensity(this.sunDirection.y),
      SKY_PARAMS.mieDirectionalG,
    )

    // Ambient tint: the sky roughly opposite the sun, which is what actually
    // fills a shadow. Normalised so intensity alone controls its strength.
    this.tmpDir2.set(-this.sunDirection.x, 0.9, -this.sunDirection.z).normalize()
    skyColor(this.tmpDir2, this.sunDirection, SKY_PARAMS, SKY_SCALE_VISIBLE, this.ambientTint)
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
    // Enclosed surfaces fall back to bounce, and bounce is the colour of what
    // it bounced off — never the blue of a sky they cannot see.
    //
    // Its direction is the sun's azimuth reversed and tipped below the horizon.
    // A wall in shade is one whose normal points away from the sun, and what it
    // is looking at is the sunlit wall across the street plus the road between
    // them: both lie behind it relative to the sun, and the road is below. That
    // puts the warm fill exactly on the faces that have no key, which is what
    // gives a shaded surface any shading at all. Faded with the sun, since
    // there is nothing left to bounce once it is down — unlike the enclosed
    // floor, which has to survive to keep rooms out of the black.
    this.tmpDir2.set(-this.sunDirection.x, -0.22, -this.sunDirection.z).normalize()
    this.occlusion.setBounce(this.tmpDir2, this.bounceTint, horizonFade)

    for (const fill of this.interiorFills) fill.color.copy(this.bounceTint)

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
      // The viewmodel scene owns its own environment. Lighting the weapon with
      // the sky probe turns anything with high metalness into a mirror of the
      // sky, which reads as bright blue rather than gunmetal.
    }

    // Both probes need the level's collision, which lands during the level
    // system's init, and a settled physics world.
    if (this.shaftsDirty && this.frames > 2) {
      this.shaftsDirty = false
      this.occlusion.bake(ctx)
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
    // A room has a few metres of air across it, not ninety. Outdoor haze on an
    // interior greys out a space that should read as crisp and close.
    this.aerial.setStrength(THREE.MathUtils.lerp(1, 0.16, this.indoorBlend))
    if (ctx.scene.fog instanceof THREE.FogExp2) {
      ctx.scene.fog.density = RESIDUAL_FOG_DENSITY * THREE.MathUtils.lerp(1, 0.3, this.indoorBlend)
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

    // Looking into a low sun the horizon carries several times the radiance of
    // the sky behind the camera, and haze at that level bleaches every distant
    // surface. A hard cap fixes the brightness but flattens the difference —
    // both directions end up on the same near-white, which is the milky look.
    // A soft roll-off keeps the warm-into-the-sun, cool-away-from-it split that
    // is what aerial perspective is actually for.
    const k = FOG_ROLLOFF
    this.fogColor.setRGB(
      this.fogSample.r / (1 + this.fogSample.r / k),
      this.fogSample.g / (1 + this.fogSample.g / k),
      this.fogSample.b / (1 + this.fogSample.b / k),
      THREE.LinearSRGBColorSpace,
    )
  }

  // --- Shafts and interior fill --------------------------------------------

  private rebuildShafts(ctx: GameContext): void {
    if (ctx.config.volumetricLight) {
      try {
        // Tuned so a shaft reads clearly brighter than the ambient floor around
        // it but never out-shines the sunlit patch it lands on.
        this.shafts.build(ctx, this.sunDirection, this.sunTint, 0.18)
      } catch (err) {
        console.warn('[lighting] shaft probe failed', err)
      }
    }
    this.placeInteriorFills()
  }

  /**
   * Rooms the sun reaches get their fill under the shaft, which is where the
   * bounce actually comes from. Rooms it does not reach still need something,
   * or cutting the ambient by the occlusion term leaves them black.
   *
   * Sunlit rooms sort first and used to be handed the entire budget, which is
   * backwards: they are the rooms that least need help, and on a level with
   * more shafts than fills every unlit interior got nothing at all — the black
   * void the `interior` pose has been showing. So the shaft-lit rooms are
   * capped at a share of the slots and the rest are reserved for the darkest
   * interiors the occlusion bake found, whether or not any are needed.
   */
  private placeInteriorFills(): void {
    const lit = this.shafts.fillPoints
    const dark = this.occlusion.interiorPoints
    const total = this.interiorFills.length
    const litBudget = dark.length === 0 ? total : Math.floor(total * LIT_ROOM_FILL_SHARE)
    let slot = 0

    for (let i = 0; i < lit.length && slot < litBudget; i++, slot++) {
      const fill = this.interiorFills[slot]
      fill.position.copy(lit[i])
      fill.intensity = INTERIOR_FILL_INTENSITY
    }

    for (let i = 0; i < dark.length && slot < total; i++) {
      const point = dark[i]
      let crowded = false
      for (let j = 0; j < slot; j++) {
        if (
          this.interiorFills[j].position.distanceToSquared(point)
          < INTERIOR_FILL_SPACING * INTERIOR_FILL_SPACING
        ) crowded = true
      }
      if (crowded) continue
      const fill = this.interiorFills[slot++]
      fill.position.copy(point)
      // Unlit rooms have no sunlit floor patch to bounce off, only skylight
      // through whatever opening they have, so they get rather less.
      fill.intensity = INTERIOR_FILL_INTENSITY * 0.75
    }

    // Anything the dark rooms did not claim goes back to the lit ones rather
    // than idling at zero.
    for (let i = litBudget; i < lit.length && slot < total; i++, slot++) {
      const fill = this.interiorFills[slot]
      fill.position.copy(lit[i])
      fill.intensity = INTERIOR_FILL_INTENSITY
    }

    for (; slot < total; slot++) this.interiorFills[slot].intensity = 0
  }

  private buildInteriorFills(scene: THREE.Scene, count: number): void {
    for (let i = 0; i < count; i++) {
      // Faked bounce off a sunlit floor patch: warm, soft falloff, no shadow.
      const light = new THREE.PointLight(0xffd9a8, 0, INTERIOR_FILL_RANGE, INTERIOR_FILL_DECAY)
      light.color.copy(this.bounceTint)
      light.name = `interiorFill${i}`
      light.castShadow = false
      scene.add(light)
      this.interiorFills.push(light)
    }
  }

  /**
   * Every shading term this system adds to the lit world, in one hook.
   *
   * Bound once, so nothing here runs per frame — `onBeforeCompile` fires only
   * when a material is first registered or invalidated.
   */
  private readonly patchWorldMaterial = (
    shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> },
  ): void => {
    this.occlusion.patch(shader)
    this.aerial.patch(shader)
  }

  // --- Viewmodel -----------------------------------------------------------

  /**
   * The weapon scene is lit entirely by the weapon system, which owns a studio
   * rig and a studio environment probe tuned so the weapon reads as gunmetal
   * whichever way the player faces.
   *
   * This system used to add a second rig here. Two stacked rigs over-exposed
   * the weapon, and two of the three lights took their colour from the sky, so
   * anything metallic picked up a strong blue cast — the weapon rendered as
   * blue chrome. Lighting the viewmodel is a single owner's job; that owner is
   * the weapon system.
   */
  private setupViewmodelRig(_ctx: GameContext): void {}

  private updateViewmodelRig(_ctx: GameContext): void {}

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

  /**
   * A muzzle flash is a hand-sized emitter, but a point light with inverse
   * square falloff standing thirty centimetres off the barrel treats it as
   * infinitesimal, and irradiance thirty centimetres from an infinitesimal
   * source is unbounded. At the old figures anything within arm's reach took
   * fifty times the sun and clipped flat white — silhouette, material and all.
   * Pushing the light out past the muzzle and trimming the peak keeps the punch
   * at the two to four metres a flash is actually read at, without a
   * singularity sitting on the shooter's own chest.
   */
  private onWeaponFired = (e: { origin: THREE.Vector3; direction: THREE.Vector3; loud: boolean }): void => {
    const strength = e.loud ? 1 : 0.35
    this.tmpVec.copy(e.origin).addScaledVector(e.direction, 0.6)
    this.pool.flash(this.tmpVec, this.muzzleColor, 11 * strength, 16, 0.05, 2)
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
    this.occlusion.dispose()
    this.sky.dispose()
    this.sun.dispose()
    this.hemisphere.dispose()
    for (const fill of this.interiorFills) fill.dispose()
  }
}
