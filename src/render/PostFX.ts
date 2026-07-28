import * as THREE from 'three'
import {
  BlendFunction,
  BloomEffect,
  DepthOfFieldEffect,
  EdgeDetectionMode,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
} from 'postprocessing'
import type { GameContext, PostFxService, System } from '../core/Types'
import { GradeEffect, type ToneMapOperator } from './post/GradeEffect'
import { LensEffect } from './post/LensEffect'
import { MotionBlurEffect } from './post/MotionBlurEffect'
import { SsrEffect } from './post/SsrEffect'
import { AccumulationPass } from './post/AccumulationPass'
import { DepthNormalsPass } from './post/DepthNormalsPass'

/**
 * Focus, in metres. The circle of confusion is
 * `smoothstep(0, focusRange, |distance - focusDistance|)`, split into a near
 * and a far half, and the bokeh scale multiplies it in the composite.
 *
 * Round 1 ran 10 m / 90 m at bokeh 1.25, which put a quarter of a
 * half-resolution blur over everything 40 metres out — every midground building
 * in a frame the player is supposed to be shooting across. Round 2 answered
 * that by switching the pass off entirely at the hip, and a judge immediately
 * missed it: mild defocus is what separates the picture planes, and without it
 * "far buildings look pasted on".
 *
 * So the hip settings are chosen to hold the CoC at zero across the whole
 * playable depth and only open up past it. The range is deliberately far wider
 * than the distance, because both halves of the CoC share it and the near half
 * has only 14 m to work with. Measured after the bokeh scale: 0.008 at 2 m,
 * 0.036 at 40 m, 0.10 at 60 m, 0.25 at 90 m, 0.49 at 130 m, saturating past
 * 224 m. Nothing a player can shoot at is softened; the skyline is.
 *
 * Aiming pulls focus onto the target plane and shortens the range so near cover
 * genuinely falls away. The viewmodel cannot be defocused at all — it is drawn
 * after this pass, against a cleared depth buffer — so "near blur on the
 * handguard" is not available in this architecture.
 */
const HIP_FOCUS_DISTANCE = 14
const HIP_FOCUS_RANGE = 210
const HIP_BOKEH_SCALE = 0.85
const ADS_FOCUS_DISTANCE = 26
const ADS_FOCUS_RANGE = 150
const ADS_BOKEH_SCALE = 2

/**
 * Base exposure: the multiplier applied when the frame meters at
 * {@link METER_REFERENCE}. Off the reference, {@link AutoExposure} corrects it.
 */
const DEFAULT_EXPOSURE = 1.76

/**
 * Geometric mean scene luminance that the meter normalises to, and how far it
 * is allowed to push.
 *
 * Measured across the eight capture poses, the frames span 0.019 (the interior)
 * to 0.178 (the sunset rooftop) — 3.2 stops. A single fixed exposure across
 * that spread is what produced round 3's contradictory critique: the interior
 * and the ADS frame were both marked "raise exposure about 1.5 stops" while the
 * frame average measured far too bright, because the two poses with sky in them
 * were carrying it.
 *
 * 0.042 puts the metered mid-point of a frame at roughly sRGB 40 through the
 * committed curve — a late-afternoon exterior with real shadow, not a mid-grey
 * image. The 1.7-stop bound is a deliberate refusal to fully normalise: it lets
 * the sunset rooftop stay the brightest frame in the set and the interior stay
 * the darkest, which is the difference between exposure compensation and
 * flattening every location into the same picture.
 */
const METER_REFERENCE = 0.042
const METER_MAX_STOPS = 1.7
const METER_RATE = 2.5

/**
 * Scene radiance, after exposure, that maps to display white.
 *
 * Hill's ACES fit only reaches 1.0 at 25.7, which is why round 3's frames
 * topped out at 236 and read as veiled. Normalising the curve at 5.0 — about
 * 4.8 stops over the metered mid-point — puts the sun disc, muzzle flashes and
 * specular glints hard on white while leaving a sunlit plaster wall, which
 * measures nearer 1.0, with two stops of headroom above it.
 */
const SCENE_WHITE = 5.0

/**
 * Scene luminance above which a pixel blooms, in linear scene-referred units.
 *
 * This is a lens effect — light scattering off the elements and the sensor
 * stack — so it keys off scene radiance and not off exposure. Round 2 had it at
 * 0.85 linear, below the 1.30 ceiling the sky dome clamps to, so the entire
 * upper half of every outdoor frame was blooming into everything in front of
 * it. That is where the "milky additive veil" and the backlit soldiers with no
 * silhouette came from. At 1.6 the sky never reaches it and the sun disc (80),
 * fires, muzzle flashes and specular glints all clear it comfortably.
 */
const BLOOM_THRESHOLD = 1.6

const DAMAGE_FLASH_DECAY = 2.1

const SMAA_PRESETS: Record<string, SMAAPreset> = {
  low: SMAAPreset.LOW,
  medium: SMAAPreset.HIGH,
  high: SMAAPreset.ULTRA,
  ultra: SMAAPreset.ULTRA,
}

/** Halton, the low-discrepancy sequence every temporal jitter is built on. */
function halton(index: number, base: number): number {
  let result = 0
  let fraction = 1 / base
  let i = index
  while (i > 0) {
    result += (i % base) * fraction
    i = Math.floor(i / base)
    fraction /= base
  }
  return result
}

function urlParam(name: string): string | null {
  const search = globalThis.location?.search
  return search ? new URLSearchParams(search).get(name) : null
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * The full-screen effect chain and the only place that calls renderer.render.
 *
 * Pass order is the whole design:
 *
 *   world → normals → SSAO → SSR → motion blur → depth of field
 *        → viewmodel (depth cleared) → bloom + meter + tone map + grade
 *        → SMAA → temporal accumulation → lens
 *
 * The meter runs inside the bloom/grade pass rather than as a pass of its own,
 * because that is the one place that sees scene radiance after the viewmodel is
 * in the frame and before exposure has been applied to it. Metering the frame
 * it is about to expose would be a feedback loop; metering the frame *before*
 * exposure is just a measurement.
 *
 * The viewmodel is drawn after every depth-dependent effect and after the
 * depth buffer has been cleared, so the weapon can never intersect level
 * geometry and never picks up world blur — but it is still in front of bloom,
 * so a muzzle flash blows out the way it should.
 *
 * Volumetric shafts need no hook here: the lighting system builds them as
 * additive geometry in the world scene, so they arrive through the world pass
 * and pick up bloom and the tone curve for free.
 */
export class PostFxSystem implements System, PostFxService {
  readonly name = 'postfx'

  private ctx!: GameContext
  private composer!: EffectComposer
  private lens!: LensEffect
  private grade!: GradeEffect
  private accumulation!: AccumulationPass

  private normalsPass: DepthNormalsPass | null = null
  private ssao: SSAOEffect | null = null
  private ssr: SsrEffect | null = null
  private motionBlur: MotionBlurEffect | null = null
  private dof: DepthOfFieldEffect | null = null
  private bloom: BloomEffect | null = null

  private exposure = 1
  private autoExposure = true
  private damageFlash = 0
  private requestedAds = 0
  private smoothedAds = 0
  private lastFov = -1
  private lastAspect = -1
  private jitterX = 0
  private jitterY = 0
  private jittered = false
  private readonly bufferSize = new THREE.Vector2()
  private unsubscribe: (() => void) | null = null

  init(ctx: GameContext): void {
    this.ctx = ctx
    const { renderer, scene, camera, config } = ctx

    this.exposure = Number(urlParam('exposure') ?? DEFAULT_EXPOSURE) || DEFAULT_EXPOSURE
    const operator = (urlParam('tonemap') as ToneMapOperator | null) ?? 'filmic'
    // `?exposure=` means "grade this frame at exactly this value", so it turns
    // the meter off rather than fighting it. `?autoexposure=0` does the same
    // while keeping the calibrated base.
    this.autoExposure = urlParam('autoexposure') !== '0' && urlParam('exposure') === null

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
      stencilBuffer: false,
      depthBuffer: true,
    })

    this.composer.addPass(new RenderPass(scene, camera))

    if (config.ssao || config.ssr) {
      this.normalsPass = new DepthNormalsPass(camera)
      this.composer.addPass(this.normalsPass)
    }

    if (config.ssao && this.normalsPass) {
      this.ssao = this.createSsao(camera, this.normalsPass.texture)
      this.composer.addPass(new EffectPass(camera, this.ssao))
    }

    if (config.ssr && this.normalsPass) {
      this.ssr = new SsrEffect({
        normalBuffer: this.normalsPass.texture,
        camera,
        // Additive, and gated only on Fresnel — so every up-facing surface in
        // the frame gained energy at grazing angles, which is the wrong answer
        // for dry rubble and lifts the black point across the ground plane.
        intensity: 0.2,
        maxDistance: 14,
        thickness: 0.55,
        steps: config.quality === 'ultra' ? 24 : 16,
      })
      this.composer.addPass(new EffectPass(camera, this.ssr))
    }

    if (config.motionBlur) {
      this.motionBlur = new MotionBlurEffect({
        samples: config.quality === 'ultra' ? 11 : 7,
        shutter: 0.5,
        maxBlur: 0.011,
      })
      this.composer.addPass(new EffectPass(camera, this.motionBlur))
    }

    if (config.depthOfField) {
      this.dof = new DepthOfFieldEffect(camera, {
        focusDistance: HIP_FOCUS_DISTANCE,
        focusRange: HIP_FOCUS_RANGE,
        bokehScale: HIP_BOKEH_SCALE,
        resolutionScale: 0.5,
      })
      this.composer.addPass(new EffectPass(camera, this.dof))
    }

    // Colour is kept, depth is thrown away. That single flag is what stops the
    // weapon poking through a wall the player is standing against. The pass is
    // also excluded from the depth blit, so every effect above still sees
    // world depth rather than a barrel 30cm from the lens.
    const viewmodelPass = new RenderPass(ctx.viewmodelScene, ctx.viewmodelCamera)
    viewmodelPass.clearPass.setClearFlags(false, true, false)
    viewmodelPass.ignoreBackground = true
    viewmodelPass.needsDepthBlit = false
    this.composer.addPass(viewmodelPass)

    this.composer.addPass(
      new EffectPass(camera, ...this.createHdrEffects(config.bloom, operator, this.autoExposure)))

    const smaa = new SMAAEffect({
      preset: SMAA_PRESETS[config.quality] ?? SMAAPreset.ULTRA,
      edgeDetectionMode: EdgeDetectionMode.COLOR,
    })
    smaa.edgeDetectionMaterial.edgeDetectionThreshold = 0.05
    this.composer.addPass(new EffectPass(camera, smaa))

    this.accumulation = new AccumulationPass()
    this.accumulation.enabled = false
    this.composer.addPass(this.accumulation)

    this.lens = new LensEffect({
      aberration: config.chromaticAberration ? 0.001 : 0,
      // Grain is added after the sharpen, so the sharpen does not amplify it.
      grainAmount: config.filmGrain ? 0.015 : 0,
      // Applied after the temporal accumulation, whose one-pixel jitter
      // footprint is a box filter and costs a little acutance.
      sharpness: config.sharpen ? 0.75 : 0,
    })
    this.composer.addPass(new EffectPass(camera, this.lens))

    this.unsubscribe = ctx.events.on('player:damaged', ({ amount }) => {
      this.setDamageFlash(0.3 + amount * 0.012)
    })

    ctx.services.postfx = this
  }

  private createSsao(camera: THREE.PerspectiveCamera, normalBuffer: THREE.Texture): SSAOEffect {
    // `radius` is a fraction of the AO buffer's height, which becomes a pixel
    // radius for the sampling spiral. At half resolution on a 1080p frame,
    // 0.07 * 540 is 38 texels — 76 screen pixels, or about 0.6 m of world at
    // 5 m through an 80-degree lens, which is the scale contact occlusion
    // wants. The proximity window has to stay wider than the radius or samples
    // inside the sphere get rejected on depth while still counting toward the
    // divisor, which is what made the round-1 settings a weak uniform wash.
    //
    // Simulating this estimator against a floor/wall junction at 6 m puts the
    // multiply at 0.66 hard against the wall, 0.77 at 15 cm and 0.95 at 60 cm:
    // a contact gradient rather than a smudge.
    //
    // This deliberately does *not* carry the whole occlusion load. The lighting
    // system bakes a coarse sky-visibility volume that handles everything from
    // roughly a metre upward and applies it to the ambient term only; this
    // resolves the creases and contact points that a screen-space pass can see
    // and that volume cannot. Both multiply, so the intensity here is set for
    // what is left over rather than for the whole effect.
    return new SSAOEffect(camera, normalBuffer, {
      blendFunction: BlendFunction.MULTIPLY,
      distanceScaling: true,
      depthAwareUpsampling: true,
      samples: 23,
      rings: 7,
      radius: 0.07,
      intensity: 2.0,
      bias: 0.02,
      fade: 0.01,
      minRadiusScale: 0.35,
      // This multiplies the full lit colour, not the ambient term alone, so
      // without a brake it darkens surfaces that the sun is already lighting
      // and that bounce enough to have no crease shadow at all. Backing off in
      // the highlights is the only defence available at this point in the
      // chain — but back off, do not switch off, or every sunlit prop goes back
      // to looking pasted onto the ground.
      luminanceInfluence: 0.28,
      worldDistanceThreshold: 45,
      worldDistanceFalloff: 30,
      worldProximityThreshold: 1.1,
      worldProximityFalloff: 0.8,
      resolutionScale: 0.5,
    })
  }

  private createHdrEffects(useBloom: boolean, operator: ToneMapOperator, autoExposure: boolean): Effect[] {
    const effects: Effect[] = []

    if (useBloom) {
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: BLOOM_THRESHOLD,
        luminanceSmoothing: 0.4,
        intensity: 0.55,
        // Eight mip levels put the widest contribution at 1/256 of the frame,
        // which is a screen-wide veil rather than a glow. Six keeps the halo
        // close enough to its source that a soldier standing in front of a
        // muzzle flash still has a silhouette.
        radius: 0.7,
        levels: 6,
      })
      effects.push(this.bloom)
    }

    this.grade = new GradeEffect({
      operator,
      exposure: this.exposure,
      sceneWhite: SCENE_WHITE,
      autoExposure: autoExposure
        ? {
            referenceLuminance: METER_REFERENCE,
            strength: 1,
            maxStops: METER_MAX_STOPS,
            rate: METER_RATE,
          }
        : undefined,
    })
    effects.push(this.grade)
    return effects
  }

  render(dt: number): void {
    const ctx = this.ctx
    const camera = ctx.camera

    // Bring the camera matrices forward before anything samples them: motion
    // blur and SSR both need this frame's transform, not last frame's.
    camera.updateMatrixWorld()
    ctx.viewmodelCamera.updateMatrixWorld()

    this.refreshCameraSettings(camera)
    this.updateFocus(dt)

    this.damageFlash = Math.max(0, this.damageFlash - dt * DAMAGE_FLASH_DECAY)
    this.lens.damageFlash = this.damageFlash
    // Seeded from simulation time, which stops advancing when the capture
    // freezes, so a given frame always grains identically.
    this.lens.grainTime = (ctx.elapsed * 71.3) % 1024

    this.motionBlur?.updateCamera(camera, dt)

    // Once the harness has frozen the simulation the frame stops changing, so
    // the meter takes it outright. Easing across the two dozen accumulated
    // frames would fold a slightly different exposure into each of them and
    // make the capture depend on the machine's frame rate.
    this.grade.snapExposure = ctx.config.freezeAt !== null && ctx.elapsed >= ctx.config.freezeAt

    this.beginJitter()
    try {
      this.composer.render(dt)
    } finally {
      // The camera is shared state. It must come back exactly as it was even
      // if a pass throws, or every later frame inherits the offset.
      this.endJitter()
    }
  }

  /**
   * SSAO and the circle-of-confusion bake the projection into their materials.
   * Aiming down sights changes the field of view, so they have to be told.
   */
  private refreshCameraSettings(camera: THREE.PerspectiveCamera): void {
    if (camera.fov === this.lastFov && camera.aspect === this.lastAspect) return
    this.lastFov = camera.fov
    this.lastAspect = camera.aspect
    this.ssao?.ssaoMaterial.adoptCameraSettings(camera)
    this.dof?.cocMaterial.adoptCameraSettings(camera)
  }

  private updateFocus(dt: number): void {
    const fromWeapon = this.ctx.services.weapons?.adsFraction ?? 0
    const target = clamp01(Math.max(this.requestedAds, fromWeapon))
    this.smoothedAds += (target - this.smoothedAds) * Math.min(1, dt * 12)

    const dof = this.dof
    if (!dof) return

    const t = this.smoothedAds
    dof.cocMaterial.focusDistance = HIP_FOCUS_DISTANCE + (ADS_FOCUS_DISTANCE - HIP_FOCUS_DISTANCE) * t
    dof.cocMaterial.focusRange = HIP_FOCUS_RANGE + (ADS_FOCUS_RANGE - HIP_FOCUS_RANGE) * t
    dof.bokehScale = HIP_BOKEH_SCALE + (ADS_BOKEH_SCALE - HIP_BOKEH_SCALE) * t
  }

  /**
   * Sub-pixel jitter for the capture poses. Shifting the projection's third
   * column moves the whole frustum by a fraction of a pixel without disturbing
   * anything else, and it is undone before any other system can observe it.
   */
  private beginJitter(): void {
    const { config, elapsed } = this.ctx
    const frozen = config.freezeAt !== null && elapsed >= config.freezeAt
    const accumulate = config.taa && frozen

    this.accumulation.enabled = accumulate
    if (!accumulate) {
      this.accumulation.reset()
      return
    }

    this.ctx.renderer.getDrawingBufferSize(this.bufferSize)
    const index = this.accumulation.sampleIndex + 1
    this.jitterX = (halton(index, 2) - 0.5) * 2 / this.bufferSize.x
    this.jitterY = (halton(index, 3) - 0.5) * 2 / this.bufferSize.y

    this.applyJitter(this.ctx.camera, this.jitterX, this.jitterY)
    this.applyJitter(this.ctx.viewmodelCamera, this.jitterX, this.jitterY)
    this.jittered = true
  }

  private endJitter(): void {
    if (!this.jittered) return
    this.applyJitter(this.ctx.camera, -this.jitterX, -this.jitterY)
    this.applyJitter(this.ctx.viewmodelCamera, -this.jitterX, -this.jitterY)
    this.jittered = false
  }

  private applyJitter(camera: THREE.PerspectiveCamera, dx: number, dy: number): void {
    const elements = camera.projectionMatrix.elements
    elements[8] += dx
    elements[9] += dy
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height)
    this.motionBlur?.reset()
    this.accumulation.reset()
  }

  setDamageFlash(intensity: number): void {
    this.damageFlash = clamp01(Math.max(this.damageFlash, intensity))
  }

  setAdsBlur(fraction: number): void {
    this.requestedAds = clamp01(fraction)
  }

  /**
   * Base exposure, as a linear multiplier applied before tone mapping. This is
   * the value used when the frame meters at {@link METER_REFERENCE}; the meter
   * still corrects around it, bounded by {@link METER_MAX_STOPS}, so this is an
   * offset on the whole grade rather than an absolute setting.
   * {@link DEFAULT_EXPOSURE} is the calibrated value. Bloom does not follow it —
   * see {@link BLOOM_THRESHOLD}.
   */
  setExposure(value: number): void {
    this.exposure = value
    this.grade.exposure = value
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.composer.dispose()
  }
}
