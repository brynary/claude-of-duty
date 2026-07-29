import * as THREE from 'three'
import type { GameContext, PrewarmService, System } from '../core/Types'

/**
 * Compiles every shader the game can need, before the first frame.
 *
 * three compiles a program the first time a material is drawn, and on this
 * renderer each compile costs tens to hundreds of milliseconds of frame time.
 * Left to itself the game paid that during play: the first firefight linked
 * around 90 programs across its opening second, and single stalls of 0.3-0.7 s
 * landed on the frames where a flash lit the street.
 *
 * Two things make a pre-warm possible at all:
 *
 *  - The lights are stable. Every pool keeps its lights in the scene and idles
 *    them at zero intensity rather than hiding them, so the light counts three
 *    bakes into a shader are the same at boot as in the middle of a firefight.
 *    Hiding one idle light invalidates everything compiled here.
 *  - Nothing that appears later is a surprise. Pools that spawn hidden, and
 *    materials that only ever exist on an object the player has not caused yet,
 *    register a stand-in through {@link PrewarmService} during their own init.
 *
 * `renderer.compile` walks the whole scene rather than only the visible part,
 * so hidden pool members are covered without revealing them, and it compiles
 * without drawing — no frame is produced and no effect state moves.
 */
export class PrewarmSystem implements System, PrewarmService {
  readonly name = 'prewarm'

  private readonly worldProxies = new THREE.Scene()
  private readonly viewmodelProxies = new THREE.Scene()

  init(ctx: GameContext): void {
    // Registered before any system that hands over stand-ins, so the service is
    // there when they init.
    ctx.services.prewarm = this
  }

  world(...objects: THREE.Object3D[]): void {
    for (const o of objects) this.worldProxies.add(o)
  }

  viewmodel(...objects: THREE.Object3D[]): void {
    for (const o of objects) this.viewmodelProxies.add(o)
  }

  postInit(ctx: GameContext): void {
    const renderer = ctx.renderer
    const previousTarget = renderer.getRenderTarget()
    const before = renderer.info.programs?.length ?? 0
    const started = performance.now()

    // Both scenes reach the screen through the post chain, which draws them
    // into HDR render targets. A shader's output conversion is part of what
    // three compiles, and it reads the bound target to decide: compiling with
    // none bound produces the sRGB variant, which the game then never uses.
    const probe = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType })
    renderer.setRenderTarget(probe)

    try {
      renderer.compile(ctx.scene, ctx.camera)
      renderer.compile(ctx.viewmodelScene, ctx.viewmodelCamera)
      // Stand-ins are compiled against the scene they will appear in, so they
      // get its lighting, not the empty proxy scene's.
      if (this.worldProxies.children.length > 0) {
        renderer.compile(this.worldProxies, ctx.camera, ctx.scene)
      }
      if (this.viewmodelProxies.children.length > 0) {
        renderer.compile(this.viewmodelProxies, ctx.viewmodelCamera, ctx.viewmodelScene)
      }
    } finally {
      renderer.setRenderTarget(previousTarget)
      probe.dispose()
    }

    // The stand-ins have served their purpose. Their geometry and materials are
    // shared with the real objects, so only the wrappers are released.
    this.worldProxies.clear()
    this.viewmodelProxies.clear()

    const after = renderer.info.programs?.length ?? 0
    const ms = performance.now() - started
    console.info(`[prewarm] ${after - before} shaders compiled in ${ms.toFixed(0)}ms, ${after} total`)
  }
}
