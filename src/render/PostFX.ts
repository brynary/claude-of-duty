import * as THREE from 'three'
import {
  EffectComposer, RenderPass, EffectPass, ToneMappingEffect, ToneMappingMode,
  BloomEffect, SMAAEffect, VignetteEffect,
} from 'postprocessing'
import type { GameContext, System, PostFxService } from '../core/Types'

/**
 * The full-screen effect chain and the only place that calls renderer.render.
 * Renders the world, then clears depth and draws the viewmodel scene on top so
 * the weapon never intersects level geometry.
 *
 * STUB — replaced by the post-processing pass.
 */
export class PostFxSystem implements System, PostFxService {
  readonly name = 'postfx'

  private composer!: EffectComposer
  private ctx!: GameContext

  init(ctx: GameContext): void {
    this.ctx = ctx
    const { renderer, scene, camera } = ctx

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    })
    this.composer.addPass(new RenderPass(scene, camera))

    const viewmodelPass = new RenderPass(ctx.viewmodelScene, ctx.viewmodelCamera)
    viewmodelPass.clear = false
    viewmodelPass.clearPass.enabled = false
    this.composer.addPass(viewmodelPass)

    this.composer.addPass(new EffectPass(
      camera,
      new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.85, luminanceSmoothing: 0.3, mipmapBlur: true }),
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
      new VignetteEffect({ darkness: 0.35, offset: 0.3 }),
      new SMAAEffect(),
    ))

    ctx.services.postfx = this
  }

  render(dt: number): void {
    // Depth must be cleared between the world and the viewmodel; the composer's
    // second RenderPass does that via its own autoClear handling below.
    const gl = this.ctx.renderer
    gl.autoClear = false
    this.composer.render(dt)
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height)
  }

  setDamageFlash(_intensity: number): void {}
  setAdsBlur(_fraction: number): void {}

  dispose(): void {
    this.composer.dispose()
  }
}
