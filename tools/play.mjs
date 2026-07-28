#!/usr/bin/env node
/**
 * Headless play harness.
 *
 * Drives the built game through a scripted scenario with a synthetic player and
 * writes the telemetry stream to JSON. The simulation runs at a fixed timestep,
 * so a given seed, scenario and skill profile reproduce exactly — which is what
 * makes a blind A/B between two builds meaningful.
 *
 *   node tools/play.mjs --scenario push --skill average --seed 1337
 *   node tools/play.mjs --all --out runs/mybuild
 *   node tools/play.mjs --matrix --out runs/mybuild     # every scenario x skill
 *
 * Exits non-zero on a boot failure or a console error, so a broken build never
 * silently produces plausible-looking telemetry.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const SCENARIOS = ['push', 'hold', 'patrol', 'traverse']
const SKILLS = ['novice', 'average', 'expert']

function parseArgs(argv) {
  const o = {
    scenarios: [], skills: [], seeds: [1337], outDir: 'runs/latest',
    seconds: 90, port: 4173, quality: 'high', headful: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') { o.scenarios = [...SCENARIOS]; o.skills = ['average'] }
    else if (a === '--matrix') { o.scenarios = [...SCENARIOS]; o.skills = [...SKILLS] }
    else if (a === '--scenario') o.scenarios = argv[++i].split(',')
    else if (a === '--skill') o.skills = argv[++i].split(',')
    else if (a === '--seed') o.seeds = argv[++i].split(',').map(Number)
    else if (a === '--seconds') o.seconds = Number(argv[++i])
    else if (a === '--out') o.outDir = argv[++i]
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--quality') o.quality = argv[++i]
  }
  if (o.scenarios.length === 0) o.scenarios = ['push']
  if (o.skills.length === 0) o.skills = ['average']
  return o
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome')
  if (!existsSync(base)) throw new Error('No cached Chrome. Set CHROME_PATH.')
  const builds = readdirSync(base).sort((a, b) =>
    Number(b.split('-')[1]?.split('.')[0] ?? 0) - Number(a.split('-')[1]?.split('.')[0] ?? 0))
  for (const b of builds) {
    for (const c of [
      join(base, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-linux64', 'chrome'),
    ]) if (existsSync(c)) return c
  }
  throw new Error(`No Chrome executable under ${base}`)
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  const opts = parseArgs(process.argv)
  const root = resolve(process.cwd())
  const outDir = resolve(root, opts.outDir)
  mkdirSync(outDir, { recursive: true })

  const baseUrl = `http://127.0.0.1:${opts.port}`
  let server = null
  if (!(await waitForServer(baseUrl, 1500))) {
    console.log('[play] starting preview server…')
    server = spawn('npx', ['vite', 'preview', '--port', String(opts.port), '--host', '127.0.0.1'],
      { cwd: root, stdio: 'ignore' })
    if (!(await waitForServer(baseUrl, 60000))) {
      server.kill()
      throw new Error('Preview server never came up. Did `npm run build` succeed?')
    }
  }

  // A profile directory unique to this invocation. A fixed one intermittently
  // fails to launch with a bare "Code: null" — a stale lock survives a killed
  // Chrome, and the next run inherits it. That failure surfaces as a boot
  // timeout, which reads exactly like the game failing to start, so it is worth
  // eliminating the class rather than retrying through it.
  const profileDir = join(root, `.chrome-profile-play-${process.pid}`)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const browser = await launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir: profileDir,
    args: [
      '--no-sandbox', '--disable-crashpad', '--disable-breakpad',
      '--disable-dev-shm-usage', '--enable-gpu', '--use-angle=metal',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit', '--hide-scrollbars',
      // A scripted run does not need to present frames at display rate; letting
      // rAF free-run makes a 90-second simulation finish in a few seconds.
      '--disable-gpu-vsync', '--window-size=1280,720',
    ],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  })

  const runs = []
  let failed = false

  for (const scenario of opts.scenarios) {
    for (const skill of opts.skills) {
      for (const seed of opts.seeds) {
        const label = `${scenario}-${skill}-${seed}`
        const page = await browser.newPage()
        const errors = []
        const noise = (t) => /favicon|\.map\b|status of 404/i.test(t)
        page.on('console', (m) => { if (m.type() === 'error' && !noise(m.text())) errors.push(m.text()) })
        page.on('pageerror', (e) => errors.push(String(e.message ?? e)))

        const url = `${baseUrl}/?bot=${scenario}&skill=${skill}&seed=${seed}` +
          `&run=${opts.seconds}&quality=${opts.quality}&autostart=1&hud=0`

        try {
          const t0 = Date.now()
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
          await page.waitForFunction('window.__booted === true || window.__bootError', { timeout: 60000, polling: 100 })
          const bootErr = await page.evaluate(() => window.__bootError ?? null)
          if (bootErr) throw new Error(`boot failed: ${String(bootErr).split('\n')[0]}`)

          await page.waitForFunction('window.__runComplete === true', { timeout: 420000, polling: 200 })
          const report = await page.evaluate(() => window.__telemetry())
          const wall = ((Date.now() - t0) / 1000).toFixed(1)

          report.label = label
          runs.push(report)
          writeFileSync(join(outDir, `${label}.json`), JSON.stringify(report, null, 2))

          const ttk = report.timeToKill.mean
          console.log(
            `[play] ${label.padEnd(24)} ✓ ${wall}s wall  ` +
            `${report.kills}k/${report.deaths}d  acc ${(report.accuracy * 100).toFixed(0)}%  ` +
            `ttk ${ttk === null ? '—' : ttk.toFixed(2) + 's'}  ` +
            `engagements ${report.engagements.length}`,
          )
        } catch (err) {
          failed = true
          console.error(`[play] ${label.padEnd(24)} ✗ ${err.message ?? err}`)
        }

        if (errors.length) {
          failed = true
          console.error(`[play] ${label}: ${errors.length} console error(s)`)
          for (const e of errors.slice(0, 3)) console.error(`        ${e.slice(0, 200)}`)
        }
        await page.close()
      }
    }
  }

  writeFileSync(join(outDir, 'runs.json'), JSON.stringify(runs, null, 2))
  await browser.close()
  if (server) server.kill()
  rmSync(profileDir, { recursive: true, force: true })

  console.log(`[play] wrote ${runs.length} run(s) to ${outDir}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('[play] fatal:', e); process.exit(2) })
