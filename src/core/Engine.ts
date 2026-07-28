import * as THREE from 'three'
import { EventBus } from './Events'
import { Input } from './Input'
import { createConfig, type Config } from './Config'
import type { GameContext, System, Services } from './Types'

/**
 * Owns the WebGL context, the frame loop and system lifecycle. Systems are
 * updated in registration order; `lateUpdate` runs afterwards for anything
 * that must observe the final camera transform (viewmodel, audio listener).
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly viewmodelScene = new THREE.Scene()
  readonly viewmodelCamera: THREE.PerspectiveCamera
  readonly input = new Input()
  readonly events = new EventBus()
  readonly config: Config
  readonly ctx: GameContext

  private systems: System[] = []
  private running = false
  private lastTime = 0
  private frameId = 0
  /** Physics and other stability-sensitive work step at this fixed rate. */
  readonly fixedStep = 1 / 120

  /** Rolling average frame time in ms, for the stats overlay. */
  frameMs = 0

  constructor(container: HTMLElement) {
    this.config = createConfig()

    const canvas = document.createElement('canvas')
    container.appendChild(canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by TAA/SMAA in the post chain
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      // Needed so the screenshot harness can read pixels after a frame.
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.config.maxPixelRatio))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Tone mapping is applied inside the post chain, not here.
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.shadowMap.autoUpdate = true
    this.renderer.info.autoReset = false

    const aspect = window.innerWidth / window.innerHeight
    this.camera = new THREE.PerspectiveCamera(this.config.fov, aspect, 0.06, 900)
    this.camera.rotation.order = 'YXZ'

    // The viewmodel renders with a tighter FOV and its own near plane so the
    // weapon never clips into world geometry.
    this.viewmodelCamera = new THREE.PerspectiveCamera(60, aspect, 0.006, 12)
    this.viewmodelCamera.rotation.order = 'YXZ'
    this.viewmodelScene.name = 'viewmodel'

    this.scene.name = 'world'

    this.input.attach(canvas)

    const services: Services = {}
    this.ctx = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      viewmodelScene: this.viewmodelScene,
      viewmodelCamera: this.viewmodelCamera,
      input: this.input,
      events: this.events,
      config: this.config,
      elapsed: 0,
      entities: new Map(),
      services,
    }

    window.addEventListener('resize', this.handleResize)
  }

  add(system: System): this {
    this.systems.push(system)
    return this
  }

  async init(): Promise<void> {
    for (const s of this.systems) {
      const t0 = performance.now()
      await s.init(this.ctx)
      const ms = performance.now() - t0
      if (ms > 50) console.info(`[engine] ${s.name} init ${ms.toFixed(0)}ms`)
    }
    this.handleResize()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.frameId = requestAnimationFrame(this.loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.frameId)
  }

  private loop = (now: number) => {
    if (!this.running) return
    this.frameId = requestAnimationFrame(this.loop)

    // Clamp so a background tab or a long GC pause cannot tunnel the player
    // through the world when the tab regains focus.
    const rawDt = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    const frozen = this.config.freezeAt !== null && this.ctx.elapsed >= this.config.freezeAt
    const dt = frozen ? 0 : rawDt

    this.ctx.elapsed += dt
    this.renderer.info.reset()

    for (const s of this.systems) s.update?.(dt, this.ctx)
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx)

    const postfx = this.ctx.services.postfx
    if (postfx) {
      postfx.render(rawDt)
    } else {
      this.renderer.render(this.scene, this.camera)
    }

    this.input.endFrame()
    this.frameMs += (performance.now() - now - this.frameMs) * 0.1

    if (frozen) this.markCaptureReady()
  }

  /**
   * The screenshot harness polls `window.__captureReady`. It is only set once
   * the sim has reached the requested freeze time and a full frame has been
   * presented, so captures are deterministic.
   */
  private captureFrames = 0
  private markCaptureReady(): void {
    // Let TAA converge on the frozen frame before declaring readiness.
    this.captureFrames++
    if (this.captureFrames > 24) {
      ;(window as unknown as Record<string, unknown>).__captureReady = true
    }
  }

  private handleResize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.config.maxPixelRatio))
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.viewmodelCamera.aspect = w / h
    this.viewmodelCamera.updateProjectionMatrix()
    for (const s of this.systems) s.resize?.(w, h)
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.handleResize)
    for (const s of this.systems) s.dispose?.()
    this.input.dispose()
    this.renderer.dispose()
  }
}
