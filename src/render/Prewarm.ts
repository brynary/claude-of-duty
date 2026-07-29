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
  private readonly depthOverrides: THREE.Material[] = []

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

  depthOverride(material: THREE.Material): void {
    this.depthOverrides.push(material)
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
      this.warmDepthOverrides(ctx)
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
  /**
   * The soft-particle prepass renders the world with `scene.overrideMaterial`,
   * a path `renderer.compile` never visits — so its depth program used to link
   * on the first frame each geometry flavour appeared in the pass: measured as
   * 120-160ms fx-attributed stalls landing mid-firefight, when a soldier first
   * stood in frustum with smoke drifting. Proxies *wearing* the override
   * material stand in for the scene it will be laid over — one per geometry
   * flavour covers the plain, instanced and skinned program variants — and a
   * target matching the prepass's own is bound so the compiled programs get
   * the output encoding the real pass will use. Compile only, no draw.
   */
  private warmDepthOverrides(ctx: GameContext): void {
    if (this.depthOverrides.length === 0) return

    const box = new THREE.BoxGeometry(0.1, 0.1, 0.1)
    const skinnedGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1)
    const vertexCount = skinnedGeo.attributes.position.count
    const weights = new Float32Array(vertexCount * 4)
    for (let i = 0; i < vertexCount; i++) weights[i * 4] = 1
    skinnedGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(vertexCount * 4), 4))
    skinnedGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))

    const depthTexture = new THREE.DepthTexture(16, 12, THREE.UnsignedIntType)
    depthTexture.format = THREE.DepthFormat
    const target = new THREE.WebGLRenderTarget(16, 12, {
      depthBuffer: true, depthTexture, stencilBuffer: false, generateMipmaps: false,
    })

    const scratch = new THREE.Scene()
    for (const material of this.depthOverrides) {
      const plain = new THREE.Mesh(box, material)
      const instanced = new THREE.InstancedMesh(box, material, 1)
      const bone = new THREE.Bone()
      const skinned = new THREE.SkinnedMesh(skinnedGeo, material)
      skinned.add(bone)
      skinned.bind(new THREE.Skeleton([bone]))
      // Dust motes and shaft particles are THREE.Points with culling off, so
      // the prepass meets the points primitive too — its own program variant.
      // This one linked mid-combat at 117-130ms until it was added here.
      const points = new THREE.Points(box, material)
      scratch.add(plain, instanced, skinned, points)
    }

    const gl = ctx.renderer
    const prevTarget = gl.getRenderTarget()
    const prevShadow = gl.shadowMap.autoUpdate
    const prevAutoClear = gl.autoClear
    try {
      // Drawn, not merely compiled. Metal builds a pipeline state when a draw
      // using it is first *executed*, so a compile-only warm linked the
      // programs and left the pipelines to be built mid-match anyway — worth
      // 115-180ms inside lateUpdate the first time a soldier or a mote stood
      // in the prepass. The proxies wear the override material themselves, so
      // this draws exactly the program/geometry pairs the pass will meet, into
      // a 16x12 target with the same attachment formats. The scratch scene is
      // never in the world and nothing is presented.
      gl.shadowMap.autoUpdate = false
      gl.autoClear = true
      gl.setRenderTarget(target)
      gl.clear(true, true, false)
      gl.render(scratch, ctx.camera)
    } finally {
      gl.setRenderTarget(prevTarget)
      gl.shadowMap.autoUpdate = prevShadow
      gl.autoClear = prevAutoClear
      target.dispose()
      depthTexture.dispose()
      box.dispose()
      skinnedGeo.dispose()
    }
  }

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
