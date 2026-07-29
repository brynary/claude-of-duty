#!/usr/bin/env node
/**
 * Verifies that pausing actually stops the world.
 *
 * The play harness never opens a menu, so nothing in it could ever have caught
 * this: pause disabled input and showed a menu while the simulation kept
 * running, so enemies acquired, aimed at and killed a player who could not
 * answer. This drives a real match, lets a firefight start, pauses, waits, and
 * checks that nothing advanced.
 *
 *   node tools/pausetest.mjs
 *
 * Exits non-zero if any monitored quantity moved while paused.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome')
  for (const b of readdirSync(base).sort().reverse()) {
    for (const c of [
      join(base, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-linux64', 'chrome'),
    ]) if (existsSync(c)) return c
  }
  throw new Error('no cached Chrome')
}

async function waitForServer(url, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { if ((await fetch(url)).ok) return true } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const PORT = 4188
const baseUrl = `http://127.0.0.1:${PORT}`
let server = null
if (!(await waitForServer(baseUrl, 1200))) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
    { cwd: process.cwd(), stdio: 'ignore' })
  if (!(await waitForServer(baseUrl, 60000))) { server.kill(); throw new Error('server did not start') }
}

const profile = join(process.cwd(), `.chrome-profile-pause-${process.pid}`)
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const browser = await launch({
  executablePath: findChrome(),
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-crashpad', '--use-angle=metal', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
  defaultViewport: { width: 1280, height: 720 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e.message ?? e).slice(0, 200)))

// A bot run so a firefight starts on its own, but with a long horizon so the
// run does not end while the test is working.
await page.goto(`${baseUrl}/?bot=hold&skill=average&seed=1337&run=600&quality=high&autostart=1`,
  { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction('window.__booted === true || window.__bootError', { timeout: 60000, polling: 100 })

const bootErr = await page.evaluate(() => window.__bootError ?? null)
if (bootErr) { console.error('boot failed:', String(bootErr).slice(0, 300)); process.exit(2) }

/** Snapshot of everything that must not move while paused. */
const sample = () => page.evaluate(() => {
  const e = window.__engine
  const t = window.__telemetry?.()
  const ai = e?.ctx?.services?.ai
  const player = e?.ctx?.services?.player
  return {
    elapsed: e?.ctx?.elapsed ?? null,
    playerHealth: player?.health ?? null,
    playerX: player?.position?.x ?? null,
    playerZ: player?.position?.z ?? null,
    damageTaken: t?.damageTaken ?? null,
    shotsFired: t?.shotsFired ?? null,
    kills: t?.kills ?? null,
    enemiesAlive: ai?.enemies?.filter?.((x) => x.alive)?.length ?? null,
  }
})

// Let a fight develop, driving the sim in slices the way main.ts does.
console.log('[pause] letting a firefight start…')
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => window.__engine?.step?.(30))
  await new Promise((r) => setTimeout(r, 10))
}

const armed = await sample()
console.log(`[pause] before: t=${armed.elapsed?.toFixed(1)}s hp=${armed.playerHealth?.toFixed(0)} ` +
  `taken=${Math.round(armed.damageTaken)} shots=${armed.shotsFired} alive=${armed.enemiesAlive}`)

if (!armed.enemiesAlive) {
  console.error('[pause] FAIL: no enemies alive, so the test would prove nothing')
  process.exit(1)
}

// Pause exactly as the menu does.
await page.evaluate(() => window.__engine.events.emit('game:pause', { paused: true }))
const atPause = await sample()

// Drive many frames while paused. Nothing may move.
for (let i = 0; i < 120; i++) {
  await page.evaluate(() => window.__engine?.step?.(30))
  await new Promise((r) => setTimeout(r, 4))
}
const afterPause = await sample()

const checks = [
  ['simulated time', atPause.elapsed, afterPause.elapsed],
  ['player health', atPause.playerHealth, afterPause.playerHealth],
  ['player x', atPause.playerX, afterPause.playerX],
  ['player z', atPause.playerZ, afterPause.playerZ],
  ['damage taken', atPause.damageTaken, afterPause.damageTaken],
  ['shots fired', atPause.shotsFired, afterPause.shotsFired],
  ['kills', atPause.kills, afterPause.kills],
  ['enemies alive', atPause.enemiesAlive, afterPause.enemiesAlive],
]

let failed = false
console.log(`\n[pause] drove 3600 frames while paused:`)
for (const [name, before, after] of checks) {
  const moved = typeof before === 'number' && typeof after === 'number'
    ? Math.abs(after - before) > 1e-6
    : before !== after
  if (moved) failed = true
  console.log(`  ${moved ? 'MOVED ' : 'held  '} ${name.padEnd(15)} ${before} -> ${after}`)
}

// And that resuming brings it back to life.
await page.evaluate(() => window.__engine.events.emit('game:pause', { paused: false }))
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => window.__engine?.step?.(30))
  await new Promise((r) => setTimeout(r, 8))
}
const resumed = await sample()
const advanced = (resumed.elapsed ?? 0) > (afterPause.elapsed ?? 0) + 1
console.log(`\n[pause] after resume: t=${resumed.elapsed?.toFixed(1)}s — ${advanced ? 'advancing again' : 'STILL FROZEN'}`)
if (!advanced) failed = true

await browser.close()
if (server) server.kill()
rmSync(profile, { recursive: true, force: true })

console.log(failed ? '\n[pause] FAIL' : '\n[pause] PASS — the world holds while paused and resumes cleanly')
process.exit(failed ? 1 : 0)
