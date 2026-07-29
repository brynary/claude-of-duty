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
  /**
   * Physics and other stability-sensitive work step at this rate, and the whole
   * simulation does when `config.fixedStep` is set.
   */
  readonly fixedStep = 1 / 60

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
      // The screenshot harness reads the canvas after a frame has been
      // composited, which needs the buffer kept; play does not, and keeping a
      // 3024x1964 surface alive across compositing costs a full-surface copy
      // every frame. Only a capture run pays for it.
      preserveDrawingBuffer: this.config.pose !== null || this.config.freezeAt !== null,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.config.maxPixelRatio))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Tone mapping is applied inside the post chain, not here.
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    // PCF, stated plainly. `PCFSoftShadowMap` is deprecated in this version of
    // three and silently becomes PCF on the first shadow render — which is one
    // frame *after* the shader pre-warm, so every material in the level was
    // compiled once for soft PCF and then again for PCF.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
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
    const boot = this.ctx.boot
    // Every stage the loading screen will be told about, in order: one per
    // system, then one more for each system that also has settling work to do.
    boot?.begin([
      ...this.systems.map((s) => s.name),
      ...this.systems.filter((s) => s.postInit).map((s) => s.name),
    ])

    for (const s of this.systems) {
      await boot?.stage(s.name)
      const t0 = performance.now()
      await s.init(this.ctx)
      const ms = performance.now() - t0
      if (ms > 50) console.info(`[engine] ${s.name} init ${ms.toFixed(0)}ms`)
    }

    // Pause is enforced here, in one place, rather than by each system opting
    // in. Only the match director and the audio mixer ever subscribed to
    // `game:pause`, so the AI, weapons, physics and player controller all kept
    // running behind the menu: enemies acquired the player, aimed and killed
    // them while their input was disabled and they could not answer. Pausing
    // has to be a property of the frame loop, because a system that forgets to
    // listen fails silently and only in the one situation nobody measures — a
    // scripted run never opens a menu.
    this.events.on('game:pause', (p) => { this.paused = p.paused })

    this.handleResize()

    // Resize first: the pre-warm compiles against the render state the first
    // frame will actually use.
    for (const s of this.systems) {
      if (!s.postInit) continue
      await boot?.stage(s.name)
      const t0 = performance.now()
      await s.postInit(this.ctx)
      const ms = performance.now() - t0
      if (ms > 50) console.info(`[engine] ${s.name} postInit ${ms.toFixed(0)}ms`)
    }
  }

  /**
   * True while a menu holds the game. Rendering continues so the paused frame
   * stays on screen behind the menu; simulation does not.
   */
  private paused = false

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
    // A fixed step makes a run a pure function of its seed and input log. Real
    // frame times vary with machine load, and a physics-driven game diverges
    // from a different dt within a second or two, so telemetry gathered under
    // variable timing is not comparable between builds.
    const deltaMs = now - this.lastTime
    const rawDt = this.config.fixedStep
      ? this.fixedStep
      : Math.min(deltaMs / 1000, 0.1)
    this.lastTime = now
    // Record before tick: the gap that just ended was produced by the
    // *previous* tick, so this pairs each delta with the work that caused it.
    this.recordFrame(deltaMs, now)
    this.tick(rawDt, now)
  }

  // --- Frame-time telemetry -------------------------------------------------
  // Wall-clock gaps between rAF callbacks, which is what the player perceives:
  // it includes our update and render work, the browser's compositor, and any
  // GC or shader-compile stall — not just the time spent inside tick().

  private perfDeltas: number[] = []
  private perfCalls: number[] = []
  private perfTris: number[] = []
  private perfWorstAt = 0
  private perfStartAt = 0
  /**
   * Attribution for slow frames. Per-system CPU time is measured every tick
   * into a preallocated array (update in the first half, lateUpdate in the
   * second); when a frame's delta crosses the stall threshold, the previous
   * tick's timings, render time and heap movement are logged so the stall can
   * be blamed rather than guessed at. A big delta with a small tick points
   * outside our code: GC, shader compile in the driver, or the compositor.
   */
  private sysTimes: Float64Array | null = null
  private lastTickMs = 0
  private lastRenderMs = 0
  private lastHeapBytes = 0
  private stallLog: Record<string, unknown>[] = []

  private recordFrame(deltaMs: number, now: number): void {
    // The first frame after start()/reset has no meaningful predecessor.
    if (this.perfStartAt === 0) { this.perfStartAt = now; return }
    this.perfDeltas.push(deltaMs)
    if (deltaMs >= (this.perfDeltas[this.perfWorstAt] ?? 0)) this.perfWorstAt = this.perfDeltas.length - 1
    this.perfCalls.push(this.renderer.info.render.calls)
    this.perfTris.push(this.renderer.info.render.triangles)

    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    const heap = mem?.usedJSHeapSize ?? 0
    const heapDelta = heap - this.lastHeapBytes
    this.lastHeapBytes = heap

    if (deltaMs > 50 && this.stallLog.length < 200) {
      const n = this.systems.length
      const top: { name: string; ms: number }[] = []
      if (this.sysTimes) {
        for (let i = 0; i < n; i++) {
          const ms = this.sysTimes[i] + this.sysTimes[n + i]
          if (ms >= 0.5) top.push({ name: this.systems[i].name, ms: +ms.toFixed(1) })
        }
        top.sort((a, b) => b.ms - a.ms)
      }
      this.stallLog.push({
        atSeconds: +this.ctx.elapsed.toFixed(2),
        ms: +deltaMs.toFixed(1),
        tickMs: +this.lastTickMs.toFixed(1),
        renderMs: +this.lastRenderMs.toFixed(1),
        heapDeltaMB: +(heapDelta / 1048576).toFixed(1),
        top: top.slice(0, 6),
      })
    }
  }

  /** Forget everything measured so far; the next frame starts a fresh window. */
  resetPerfStats(): void {
    this.perfDeltas = []
    this.perfCalls = []
    this.perfTris = []
    this.perfWorstAt = 0
    this.perfStartAt = 0
    this.stallLog = []
    this.lastHeapBytes = 0
  }

  /**
   * Percentiles of the measurement window. `fps.p50` is the headline number;
   * `fps.p99` is the classic "1% low". Stalls are counted at the thresholds a
   * player can feel: a 50ms frame is a visible hitch, a 100ms one is a hang.
   */
  perfReport(): Record<string, unknown> {
    const n = this.perfDeltas.length
    if (n === 0) return { frames: 0 }
    const sorted = [...this.perfDeltas].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))]
    const sum = this.perfDeltas.reduce((a, b) => a + b, 0)
    const sortedCalls = [...this.perfCalls].sort((a, b) => a - b)
    const sortedTris = [...this.perfTris].sort((a, b) => a - b)
    const mid = Math.floor(n / 2)
    let timeInStallMs = 0
    let over50 = 0, over100 = 0, over250 = 0
    for (const d of this.perfDeltas) {
      if (d > 50) { over50++; timeInStallMs += d }
      if (d > 100) over100++
      if (d > 250) over250++
    }
    return {
      frames: n,
      seconds: sum / 1000,
      fps: { mean: 1000 / (sum / n), p50: 1000 / at(0.5), p90: 1000 / at(0.9), p99: 1000 / at(0.99) },
      frameMs: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[n - 1] },
      worstFrame: {
        ms: this.perfDeltas[this.perfWorstAt],
        atSeconds: this.perfDeltas.slice(0, this.perfWorstAt).reduce((a, b) => a + b, 0) / 1000,
      },
      stalls: { over50, over100, over250, timeInStallMs },
      stallEvents: this.stallLog,
      drawCalls: { p50: sortedCalls[mid], max: sortedCalls[n - 1] },
      triangles: { p50: sortedTris[mid], max: sortedTris[n - 1] },
    }
  }

  /**
   * One simulated frame. Split out from the rAF loop so the play harness can
   * drive the simulation as fast as the machine allows: presenting at display
   * rate makes a ninety-second scripted run take ninety seconds of wall clock,
   * which is far too slow to sweep a matrix of scenarios and skill profiles.
   */
  step(times = 1): void {
    for (let i = 0; i < times; i++) this.tick(this.fixedStep, performance.now(), true)
  }

  private tick(rawDt: number, now: number, headless = false): void {
    const frozen = this.config.freezeAt !== null && this.ctx.elapsed >= this.config.freezeAt
    // A paused frame advances by zero, exactly as a frozen capture frame does.
    // Systems still get their update call, so menus animate and the HUD keeps
    // drawing, but nothing that integrates dt can move — no AI decisions, no
    // ballistics, no physics, no damage.
    const dt = frozen || this.paused ? 0 : rawDt

    this.ctx.elapsed += dt
    this.renderer.info.reset()

    const n = this.systems.length
    const times = this.sysTimes ?? (this.sysTimes = new Float64Array(n * 2))
    const tickStart = performance.now()
    let mark = tickStart
    for (let i = 0; i < n; i++) {
      this.systems[i].update?.(dt, this.ctx)
      const t = performance.now()
      times[i] = t - mark
      mark = t
    }
    for (let i = 0; i < n; i++) {
      this.systems[i].lateUpdate?.(dt, this.ctx)
      const t = performance.now()
      times[n + i] = t - mark
      mark = t
    }

    // A headless run still renders periodically: shaders, the shadow cascade
    // and the light probes all run on the render path, and skipping it entirely
    // would measure a game nobody is playing. Once every eight frames keeps
    // that machinery live at a fraction of the cost.
    const shouldRender = !headless || this.frames % 8 === 0
    if (shouldRender) {
      const renderStart = performance.now()
      const postfx = this.ctx.services.postfx
      if (postfx) postfx.render(rawDt)
      else this.renderer.render(this.scene, this.camera)
      this.lastRenderMs = performance.now() - renderStart
    }
    this.lastTickMs = performance.now() - tickStart
    this.frames++

    this.input.endFrame()
    this.frameMs += (performance.now() - now - this.frameMs) * 0.1

    if (frozen) this.markCaptureReady()
  }

  private frames = 0

  /**
   * The screenshot harness polls `window.__captureReady`. It is only set once
   * the sim has reached the requested freeze time and a full frame has been
   * presented, so captures are deterministic.
   */
  private captureFrames = 0
  private markCaptureReady(): void {
    // Let TAA converge on the frozen frame before declaring readiness — then
    // stop the loop on an exact frame count. Left running, the accumulator
    // kept blending jittered frames while the harness polled, so two captures
    // of the same build differed by however many extra frames the polling
    // latency allowed (measured: 12-20% of pixels, small deltas). The drawing
    // buffer is preserved, so the screenshot reads this exact frame.
    this.captureFrames++
    if (this.captureFrames === 25) {
      ;(window as unknown as Record<string, unknown>).__captureReady = true
      this.stop()
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
