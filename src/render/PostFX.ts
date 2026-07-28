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
 * Focus, in metres.
 *
 * Hip fire has no depth of field at all. The circle of confusion is
 * `smoothstep(0, focusRange, |distance - focusDistance|)` and the bokeh scale
 * multiplies it in the composite, so the previous 10 m / 90 m / 1.25 settings
 * blended a third of a half-resolution blur over anything 40 metres out —
 * every midground building in the level, softened in a frame the player is
 * supposed to be shooting across. No shipped gameplay frame does that. A bokeh
 * scale of zero is exactly zero, and the whole pass is skipped until the player
 * actually aims.
 *
 * Aiming pulls focus to a plane just past normal engagement range and lets near
 * cover and the far skyline fall away. The viewmodel cannot be defocused at all
 * — it is drawn after this pass, against a cleared depth buffer — so "near
 * blur on the handguard" is not available in this architecture.
 */
const HIP_FOCUS_DISTANCE = 20
const HIP_FOCUS_RANGE = 320
const HIP_BOKEH_SCALE = 0
const ADS_FOCUS_DISTANCE = 26
const ADS_FOCUS_RANGE = 150
const ADS_BOKEH_SCALE = 2

/** Below this the depth of field pass is a no-op, so it is skipped entirely. */
const DOF_EPSILON = 0.02

/**
 * Scene exposure. The tone curve is ACES with no pre-scale, so this is the only
 * thing standing between scene radiance and the curve: at 1.65 a scene
 * luminance of 0.18 lands on sRGB 132 and 0.5 lands on 211.
 */
const DEFAULT_EXPOSURE = 1.65

/**
 * Only genuinely bright things bloom, measured in scene luminance after
 * exposure. 1.4 / 1.65 = 0.85 linear, which is roughly sRGB 231 through the
 * grade — the sky disc, fires, muzzle flashes and sun glints, and nothing that
 * a white wall in sunlight can reach.
 */
const BLOOM_THRESHOLD = 1.4

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
 *   world → normals → SSAO → SSR → motion blur → depth of field (ADS only)
 *        → viewmodel (depth cleared) → bloom + tone map + grade
 *        → SMAA → temporal accumulation → lens
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
  private dofPass: EffectPass | null = null
  private bloom: BloomEffect | null = null

  private exposure = 1
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
    const operator = (urlParam('tonemap') as ToneMapOperator | null) ?? 'aces'

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
      this.dofPass = new EffectPass(camera, this.dof)
      this.dofPass.enabled = false
      this.composer.addPass(this.dofPass)
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

    this.composer.addPass(new EffectPass(camera, ...this.createHdrEffects(config.bloom, operator)))

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
      grainAmount: config.filmGrain ? 0.018 : 0,
      // Applied after the temporal accumulation, whose one-pixel jitter
      // footprint is a box filter and costs a little acutance.
      sharpenAmount: config.sharpen ? 0.38 : 0,
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
    // 0.055 * 540 is 30 texels — 60 screen pixels, or 0.46 m of world at 5 m
    // through an 80-degree lens, which is the scale contact occlusion wants.
    //
    // The old 0.1 was nearly twice that, and it was paired with a 0.4 m world
    // proximity cutoff: most of the spiral landed on surfaces further away in
    // depth than the cutoff allowed, so those samples contributed nothing while
    // still counting toward the divisor. The result was a broad, weak wash that
    // darkened nothing in particular. The window is now wider than the radius,
    // so a sample inside the sphere actually occludes.
    return new SSAOEffect(camera, normalBuffer, {
      blendFunction: BlendFunction.MULTIPLY,
      distanceScaling: true,
      depthAwareUpsampling: true,
      samples: 23,
      rings: 7,
      radius: 0.055,
      intensity: 2.2,
      bias: 0.02,
      fade: 0.01,
      minRadiusScale: 0.35,
      // Sunlit surfaces bounce enough light that heavy AO on them reads as
      // dirt rather than shadow — but back off, do not switch off. This is a
      // multiply over the full lit colour, not over the ambient term alone,
      // so some restraint in the highlights is the only defence there is.
      luminanceInfluence: 0.22,
      worldDistanceThreshold: 45,
      worldDistanceFalloff: 30,
      worldProximityThreshold: 0.7,
      worldProximityFalloff: 0.5,
      resolutionScale: 0.5,
    })
  }

  private createHdrEffects(useBloom: boolean, operator: ToneMapOperator): Effect[] {
    const effects: Effect[] = []

    if (useBloom) {
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: BLOOM_THRESHOLD / this.exposure,
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

    this.grade = new GradeEffect({ operator, exposure: this.exposure })
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
    if (!dof || !this.dofPass) return

    const t = this.smoothedAds
    // Nothing to blur at the hip end, so five full-screen passes get skipped
    // rather than resolving to a no-op. The bokeh scale is zero at t = 0, which
    // is what makes crossing the threshold invisible.
    this.dofPass.enabled = t > DOF_EPSILON
    if (!this.dofPass.enabled) return

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
   * Scene exposure as a linear multiplier, applied before tone mapping.
   * {@link DEFAULT_EXPOSURE} is the calibrated value; anything else re-grades
   * the whole image, and the bloom threshold follows so the same physical
   * brightness keeps blooming.
   */
  setExposure(value: number): void {
    this.exposure = value
    this.grade.exposure = value
    if (this.bloom) this.bloom.luminanceMaterial.threshold = BLOOM_THRESHOLD / value
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.composer.dispose()
  }
}
