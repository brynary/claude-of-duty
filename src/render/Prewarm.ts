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

  /**
   * Publishes the service before the engine starts initialising systems.
   *
   * This system is registered last, so that its own work runs after every other
   * system has settled, but the stand-ins arrive during those systems' init —
   * which is earlier. Announcing itself up front resolves the two.
   */
  publish(ctx: GameContext): void {
    ctx.services.prewarm = this
  }

  init(ctx: GameContext): void {
    this.publish(ctx)
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
      // get its lighting, not the empty proxy scene's. They also need the same
      // shader patches the world's own materials carry, or the sweep that
      // applies them will invalidate this work the moment they are used.
      if (this.worldProxies.children.length > 0) {
        ctx.services.lighting?.prepareMaterials(this.worldProxies)
        renderer.compile(this.worldProxies, ctx.camera, ctx.scene)
      }
      if (this.viewmodelProxies.children.length > 0) {
        renderer.compile(this.viewmodelProxies, ctx.viewmodelCamera, ctx.viewmodelScene)
      }
      this.warmShadows(ctx)
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

  /**
   * Casters need a drawn frame, not just a compile.
   *
   * A shadow map is rendered with three's own depth material rather than the
   * object's, and `renderer.compile` does not touch that path — so a pooled
   * chunk of debris still compiled a depth shader the first time it flew and
   * cast a shadow. One frame into a four-pixel target, with the stand-ins in
   * the scene and culling switched off so nothing is skipped, covers it. The
   * frame is never presented and the post chain is not involved, so no effect
   * state moves and no pixel of it reaches the player.
   */
  private warmShadows(ctx: GameContext): void {
    const proxies = [...this.worldProxies.children]
    if (proxies.length === 0) return

    const holder = new THREE.Group()
    holder.name = 'prewarm'
    // On top of the camera, so the stand-ins are inside every frustum that
    // matters — including the near shadow cascade's.
    holder.position.copy(ctx.camera.position)
    for (const proxy of proxies) {
      proxy.traverse((o) => { o.frustumCulled = false })
      holder.add(proxy)
    }
    ctx.scene.add(holder)

    try {
      ctx.renderer.render(ctx.scene, ctx.camera)
    } finally {
      // Back to the proxy scene, so the caller's cleanup still owns them.
      for (const proxy of proxies) this.worldProxies.add(proxy)
      ctx.scene.remove(holder)
    }
  }
}
