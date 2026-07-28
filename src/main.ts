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

/**
 * Registration order is update order. Physics settles before the player reads
 * the world; the player moves before weapons and the viewmodel key off the
 * camera; post-processing renders last.
 */
async function boot(): Promise<void> {
  const container = document.getElementById('app')!
  const engine = new Engine(container)

  engine
    .add(new MaterialSystem())
    .add(new PhysicsSystem())
    .add(new LightingSystem())
    .add(new LevelSystem())
    .add(new PlayerSystem())
    .add(new AiSystem())
    .add(new WeaponSystem())
    .add(new FxSystem())
    .add(new AudioSystem())
    .add(new HudSystem())
    .add(new PostFxSystem())

  await engine.init()
  engine.start()

  const dbg = window as unknown as Record<string, unknown>
  dbg.__engine = engine
  dbg.__booted = true
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
