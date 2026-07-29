#!/usr/bin/env node
/**
 * Real-time frame-rate harness.
 *
 * Runs the built game with the synthetic player driving a live scenario — AI
 * spawning, movement, firing — but leaves the frame loop rAF-driven, so the
 * recorded frame times are what a player at this machine would experience.
 * Reports p50/p90/p99 FPS, worst frame, and stall counts.
 *
 *   node tools/perf.mjs                                # ultra, push, 45s
 *   node tools/perf.mjs --seconds 60 --trials 3 --out runs/perf-baseline
 *
 * The viewport is 1512x982 at deviceScaleFactor 2, matching this machine's
 * Retina panel, so GPU load is what the real screen would impose.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

function parseArgs(argv) {
  const o = {
    scenario: 'push', skill: 'average', seed: 1337, seconds: 45, trials: 1,
    port: 4173, quality: 'ultra', outDir: 'runs/perf-latest', width: 1512, height: 982, dpr: 2,
    vsync: false, headful: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scenario') o.scenario = argv[++i]
    else if (a === '--skill') o.skill = argv[++i]
    else if (a === '--seed') o.seed = Number(argv[++i])
    else if (a === '--seconds') o.seconds = Number(argv[++i])
    else if (a === '--trials') o.trials = Number(argv[++i])
    else if (a === '--out') o.outDir = argv[++i]
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--quality') o.quality = argv[++i]
    else if (a === '--width') o.width = Number(argv[++i])
    else if (a === '--height') o.height = Number(argv[++i])
    else if (a === '--dpr') o.dpr = Number(argv[++i])
    // Control runs: --vsync paces frames like a real display instead of
    // free-running; --headful renders in a visible window on the real screen.
    else if (a === '--vsync') o.vsync = true
    else if (a === '--headful') o.headful = true
  }
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

const fmt = (x, d = 1) => (x === undefined || x === null ? '—' : x.toFixed(d))

function printReport(label, r) {
  console.log(
    `[perf] ${label.padEnd(22)} fps p50 ${fmt(r.fps.p50)}  p90 ${fmt(r.fps.p90)}  p99 ${fmt(r.fps.p99)}  ` +
    `worst ${fmt(r.worstFrame.ms, 0)}ms@${fmt(r.worstFrame.atSeconds, 1)}s  ` +
    `stalls >50ms:${r.stalls.over50} >100ms:${r.stalls.over100} >250ms:${r.stalls.over250}  ` +
    `calls p50 ${r.drawCalls.p50}  tris p50 ${(r.triangles.p50 / 1e6).toFixed(2)}M`,
  )
  // Attribution for the frames the loop exists to kill.
  const bad = (r.stallEvents ?? []).filter((s) => s.ms >= 90)
  for (const s of bad.slice(0, 8)) {
    const top = (s.top ?? []).map((t) => `${t.name} ${t.ms}ms`).join(', ') || 'none ≥0.5ms'
    console.log(`        stall ${s.ms}ms @${s.atSeconds}s  tick ${s.tickMs}ms render ${s.renderMs}ms heapΔ ${s.heapDeltaMB}MB  [${top}]`)
  }
  if (bad.length > 8) console.log(`        …and ${bad.length - 8} more ≥90ms`)
}

async function main() {
  const opts = parseArgs(process.argv)
  const root = resolve(process.cwd())
  const outDir = resolve(root, opts.outDir)
  mkdirSync(outDir, { recursive: true })

  const baseUrl = `http://127.0.0.1:${opts.port}`
  let server = null
  if (!(await waitForServer(baseUrl, 1500))) {
    console.log('[perf] starting preview server…')
    server = spawn('npx', ['vite', 'preview', '--port', String(opts.port), '--host', '127.0.0.1'],
      { cwd: root, stdio: 'ignore' })
    if (!(await waitForServer(baseUrl, 60000))) {
      server.kill()
      throw new Error('Preview server never came up. Did `npm run build` succeed?')
    }
  }

  const profileDir = join(root, `.chrome-profile-perf-${process.pid}`)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  // Chrome intermittently dies at launch with a bare "Code: null" (crashpad
  // races a stale singleton). A fresh profile dir plus a short backoff clears
  // it; three strikes means something is actually wrong.
  const launchWithRetry = async (options, attempts = 3) => {
    for (let i = 1; ; i++) {
      try { return await launch(options) } catch (err) {
        if (i >= attempts) throw err
        console.warn(`[perf] launch attempt ${i} failed; retrying…`)
        await new Promise((r) => setTimeout(r, 3000 * i))
        rmSync(profileDir, { recursive: true, force: true })
        mkdirSync(profileDir, { recursive: true })
      }
    }
  }

  const browser = await launchWithRetry({
    executablePath: findChrome(),
    headless: !opts.headful,
    userDataDir: profileDir,
    args: [
      '--no-sandbox', '--disable-crashpad', '--disable-breakpad',
      '--disable-dev-shm-usage', '--enable-gpu', '--use-angle=metal',
      '--ignore-gpu-blocklist', '--hide-scrollbars',
      // Let rAF free-run: headless has no display to sync to, and an uncapped
      // loop measures true frame cost rather than a synthetic 60Hz ceiling.
      // --vsync keeps the pacing a real display would impose instead.
      ...(opts.vsync ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync']),
      `--window-size=${opts.width},${opts.height + 88}`,
    ],
    defaultViewport: { width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr },
    protocolTimeout: 600000,
  })

  const reports = []
  let failed = false

  for (let trial = 1; trial <= opts.trials; trial++) {
    const label = `${opts.quality}-${opts.scenario}-t${trial}`
    const page = await browser.newPage()
    const errors = []
    const noise = (t) => /favicon|\.map\b|status of 404/i.test(t)
    page.on('console', (m) => { if (m.type() === 'error' && !noise(m.text())) errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(String(e.message ?? e)))

    const url = `${baseUrl}/?bot=${opts.scenario}&skill=${opts.skill}&seed=${opts.seed}` +
      `&run=${opts.seconds}&quality=${opts.quality}&autostart=1&perf=1`

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForFunction('window.__booted === true || window.__bootError', { timeout: 180000, polling: 100 })
      const bootErr = await page.evaluate(() => window.__bootError ?? null)
      if (bootErr) throw new Error(`boot failed: ${String(bootErr).split('\n')[0]}`)

      await page.waitForFunction('window.__perfStarted === true', { timeout: 180000, polling: 100 })
      await page.waitForFunction('window.__runComplete === true',
        { timeout: opts.seconds * 3000 + 120000, polling: 200 })

      const report = await page.evaluate(() => window.__fpsReport)
      const play = await page.evaluate(() => window.__telemetry())
      report.label = label
      report.settings = { ...opts, trial }
      // Belt and braces: record what resolution the GPU actually rendered.
      report.resolution = await page.evaluate(() => {
        const gl = window.__engine?.renderer?.getContext?.()
        return gl ? { drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`, dpr: window.devicePixelRatio } : null
      })
      report.play = { kills: play.kills, deaths: play.deaths, shotsFired: play.shotsFired ?? null }
      reports.push(report)
      writeFileSync(join(outDir, `${label}.json`), JSON.stringify(report, null, 2))
      printReport(label, report)
    } catch (err) {
      failed = true
      console.error(`[perf] ${label.padEnd(22)} ✗ ${err.message ?? err}`)
    }

    if (errors.length) {
      failed = true
      console.error(`[perf] ${label}: ${errors.length} console error(s)`)
      for (const e of errors.slice(0, 3)) console.error(`        ${e.slice(0, 200)}`)
    }
    await page.close()
  }

  writeFileSync(join(outDir, 'perf.json'), JSON.stringify(reports, null, 2))
  await browser.close()
  if (server) server.kill()
  rmSync(profileDir, { recursive: true, force: true })

  if (reports.length > 1) {
    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    console.log(`[perf] median across trials: p50 ${fmt(med(reports.map((r) => r.fps.p50)))} fps, ` +
      `p99 ${fmt(med(reports.map((r) => r.fps.p99)))} fps`)
  }
  console.log(`[perf] wrote ${reports.length} report(s) to ${outDir}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('[perf] fatal:', e); process.exit(2) })
