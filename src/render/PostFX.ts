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
 * Focus, in metres. Hip fire keeps everything from the muzzle out to the far
 * side of the street sharp and only softens the skyline; aiming pulls focus
 * onto the target and lets near cover fall away.
 */
const HIP_FOCUS_DISTANCE = 10
const HIP_FOCUS_RANGE = 90
const HIP_BOKEH_SCALE = 1.25
const ADS_FOCUS_DISTANCE = 24
const ADS_FOCUS_RANGE = 40
const ADS_BOKEH_SCALE = 2.4

/** Only genuinely bright things bloom: this is measured after exposure. */
const BLOOM_THRESHOLD = 0.92

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

    this.exposure = Number(urlParam('exposure') ?? 1) || 1
    const operator = (urlParam('tonemap') as ToneMapOperator | null) ?? 'agx'

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
        intensity: 0.32,
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
      aberration: config.chromaticAberration ? 0.0012 : 0,
      grainAmount: config.filmGrain ? 0.024 : 0,
      sharpenAmount: config.sharpen ? 0.25 : 0,
    })
    this.composer.addPass(new EffectPass(camera, this.lens))

    this.unsubscribe = ctx.events.on('player:damaged', ({ amount }) => {
      this.setDamageFlash(0.3 + amount * 0.012)
    })

    ctx.services.postfx = this
  }

  private createSsao(camera: THREE.PerspectiveCamera, normalBuffer: THREE.Texture): SSAOEffect {
    // `radius` is a fraction of the render height, so this is tuned to cover
    // roughly half a metre at conversational distance and then scaled down
    // with depth to stay world-stable.
    return new SSAOEffect(camera, normalBuffer, {
      blendFunction: BlendFunction.MULTIPLY,
      distanceScaling: true,
      depthAwareUpsampling: true,
      samples: 23,
      rings: 7,
      radius: 0.1,
      intensity: 1.0,
      bias: 0.035,
      fade: 0.015,
      minRadiusScale: 0.2,
      // Sunlit surfaces bounce enough light that heavy AO on them reads as
      // dirt rather than shadow — but back off, do not switch off.
      luminanceInfluence: 0.45,
      worldDistanceThreshold: 35,
      worldDistanceFalloff: 25,
      worldProximityThreshold: 0.4,
      worldProximityFalloff: 0.2,
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
        luminanceSmoothing: 0.25,
        intensity: 0.78,
        radius: 0.82,
        levels: 8,
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

  /** Scene exposure in stops-as-a-multiplier, applied before tone mapping. */
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
