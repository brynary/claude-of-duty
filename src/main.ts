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

  const dbg = window as unknown as Record<string, unknown>
  dbg.__engine = engine
  dbg.__booted = true
  dbg.__telemetry = () => ({ ...telemetry.report(), botLog: bot.log })

  // The opening frames run underneath the loading screen. They are the
  // expensive ones — the post chain compiles its own shaders on the first, and
  // the light probes bake on the third — and the player should not be looking
  // at the world while that happens. Only then is the game offered.
  if (!engine.config.bot) await presentedFrames(6)
  engine.ctx.boot = undefined
  await loading.finish()

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
