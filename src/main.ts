import { Engine } from './core/Engine'
import { MaterialSystem } from './render/Materials'
import { PhysicsSystem } from './physics/Physics'
import { LightingSystem } from './render/Lighting'
import { LevelSystem } from './world/Level'
import { PlayerSystem } from './player/PlayerSystem'
import { WeaponSystem } from './weapons/WeaponSystem'
import { AiSystem } from './ai/AiSystem'
import { FxSystem } from './fx/FxSystem'
import { AudioSystem } from './audio/AudioSystem'
import { HudSystem } from './ui/HudSystem'
import { PostFxSystem } from './render/PostFX'
import { PlayBotSystem } from './core/PlayBot'
import { TelemetrySystem } from './core/Telemetry'
import { MatchDirector } from './game/MatchDirector'
import { difficulty } from './game/Difficulty'
import { PrewarmSystem } from './render/Prewarm'
import { BootScreen } from './ui/BootScreen'

/**
 * Registration order is both init order and update order, so a system is
 * registered before anything that resolves it through `ctx.services`:
 * materials and physics underpin the level; fx and audio must exist before
 * weapons and AI call into them; post-processing renders last.
 *
 * Effects updating a frame before their emitters costs one frame of latency,
 * which is invisible, and buys a dependency order that is always satisfied.
 */
/** Resolves once the display has been given `count` frames. */
function presentedFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0
    const tick = (): void => {
      seen++
      if (seen >= count) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function boot(): Promise<void> {
  const container = document.getElementById('app')!
  const engine = new Engine(container)
  const bot = new PlayBotSystem()
  const telemetry = new TelemetrySystem()

  // Available to every system's init, but registered last so its own pass runs
  // after the world, the lighting patches and the weapons have all settled.
  const prewarm = new PrewarmSystem()
  prewarm.publish(engine.ctx)

  // A capture or a scripted run must never photograph the loading screen or
  // wait for a keypress that will not come, so those dismiss it themselves.
  const scripted = engine.config.pose !== null || engine.config.bot !== null
  const loading = new BootScreen(scripted)
  engine.ctx.boot = loading

  engine
    .add(new MaterialSystem())
    .add(new PhysicsSystem())
    .add(new LightingSystem())
    .add(new FxSystem())
    .add(new AudioSystem())
    .add(new LevelSystem())
    // The synthetic player writes input, so it must run before anything reads
    // it. Telemetry runs last, observing the frame every other system produced.
    .add(bot)
    .add(new PlayerSystem())
    .add(new AiSystem())
    // Difficulty holds the preset tables that AI and behaviour already import
    // as a singleton; registering it is what makes its dynamic adjustment run
    // at all. Unregistered, the presets worked and the adaptation was dead code.
    .add(difficulty)
    // The match owns wave cadence. It must come after AiSystem because it calls
    // ai.spawnWave, and after LevelSystem so the encounter director's staging
    // is fresh in the same frame.
    .add(new MatchDirector())
    .add(new WeaponSystem())
    .add(new HudSystem())
    .add(new PostFxSystem())
    .add(telemetry)
    .add(prewarm)

  await engine.init()
  engine.start()

  // Metal builds a pipeline on the first *executed* draw, not when the
  // program links — so pooled particles (instanceCount 0) and hidden scope
  // overlays sailed through every prewarm compile and then paid 95-140ms on
  // the first shot of the match. Two presented frames with one dead instance
  // held in each pool and the hidden extras drawn (their materials rest at
  // opacity 0) create every pipeline while the loading screen still covers
  // the canvas.
  engine.ctx.services.fx?.pipelineWarm(true)
  engine.ctx.services.weapons?.pipelineWarm(true)
  // Four frames, not two: the lighting bakes its sun shafts and their dust
  // motes on the third, and those must exist in the scene before the depth
  // pass below can compile the variants they need.
  await presentedFrames(4)
  engine.ctx.services.fx?.pipelineWarm(false)
  engine.ctx.services.weapons?.pipelineWarm(false)
  engine.ctx.services.fx?.warmDepthPass()

  const dbg = window as unknown as Record<string, unknown>
  dbg.__engine = engine
  dbg.__booted = true
  dbg.__telemetry = () => ({ ...telemetry.report(), botLog: bot.log })
  dbg.__fps = () => engine.perfReport()

  // The opening frames run underneath the loading screen. They are the
  // expensive ones — the post chain compiles its own shaders on the first, and
  // the light probes bake on the third — and the player should not be looking
  // at the world while that happens. Only then is the game offered.
  if (!engine.config.bot) await presentedFrames(6)
  engine.ctx.boot = undefined
  await loading.finish()

  // A perf run keeps the ordinary rAF loop — the point is to measure real
  // frame pacing under play — and only borrows the bot for input. Measurement
  // starts after a short settle so boot-adjacent work (probe bakes, first
  // shadow renders) does not pollute the window it is trying to characterise.
  if (engine.config.bot && engine.config.perf) {
    await presentedFrames(30)
    engine.resetPerfStats()
    const startElapsed = engine.ctx.elapsed
    dbg.__perfStarted = true
    const stopAt = engine.config.runSeconds
    const watch = () => {
      if (engine.ctx.elapsed - startElapsed >= stopAt) {
        dbg.__fpsReport = engine.perfReport()
        dbg.__runComplete = true
        return
      }
      requestAnimationFrame(watch)
    }
    requestAnimationFrame(watch)
    return
  }

  // A scripted run is driven by the harness rather than by the display, so it
  // completes as fast as the machine allows instead of in real time. Stepping
  // happens in slices so the page stays responsive and never trips the
  // browser's long-task watchdog.
  if (engine.config.bot) {
    engine.stop()
    const stopAt = engine.config.runSeconds
    const slice = () => {
      if (engine.ctx.elapsed >= stopAt) {
        dbg.__runComplete = true
        return
      }
      engine.step(30)
      setTimeout(slice, 0)
    }
    slice()
  }
}

boot().catch((err) => {
  console.error('[boot] failed', err)
  const dbg = window as unknown as Record<string, unknown>
  dbg.__bootError = String(err && (err as Error).stack ? (err as Error).stack : err)
  const pre = document.createElement('pre')
  pre.style.cssText = 'position:fixed;inset:0;color:#f66;background:#111;padding:24px;font:12px monospace;white-space:pre-wrap;z-index:9999'
  pre.textContent = `Boot failed:\n${err?.stack ?? err}`
  document.body.appendChild(pre)
})
