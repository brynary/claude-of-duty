#!/usr/bin/env node
/**
 * Deterministic screenshot harness.
 *
 * Boots the built game in headless Chrome, drives it to a named camera pose,
 * waits for the simulation to freeze and TAA to converge, then writes a PNG.
 *
 *   node tools/screenshot.mjs --poses alley,plaza --out shots/iter1
 *   node tools/screenshot.mjs --all --width 1920 --height 1080
 *
 * Exits non-zero if the game failed to boot or any console error was logged,
 * so the critic never grades a broken frame.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const ALL_POSES = ['alley', 'plaza', 'interior', 'weapon', 'ads', 'firefight', 'vista', 'sunset']

function parseArgs(argv) {
  const out = { poses: [], outDir: 'shots', width: 1920, height: 1080, quality: 'ultra', hud: null, port: 4173, keepServer: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') out.poses = [...ALL_POSES]
    else if (a === '--poses') out.poses = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--out') out.outDir = argv[++i]
    else if (a === '--width') out.width = Number(argv[++i])
    else if (a === '--height') out.height = Number(argv[++i])
    else if (a === '--quality') out.quality = argv[++i]
    else if (a === '--hud') out.hud = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
  }
  if (out.poses.length === 0) out.poses = [...ALL_POSES]
  return out
}

/** Finds the newest Chrome that puppeteer has already downloaded. */
function findChrome() {
  const envPath = process.env.CHROME_PATH
  if (envPath && existsSync(envPath)) return envPath

  const base = join(homedir(), '.cache', 'puppeteer', 'chrome')
  if (!existsSync(base)) throw new Error('No cached Chrome found. Set CHROME_PATH.')
  const builds = readdirSync(base)
    .filter((d) => d.startsWith('mac') || d.startsWith('linux') || d.startsWith('win'))
    .sort((a, b) => {
      const na = Number(a.split('-')[1]?.split('.')[0] ?? 0)
      const nb = Number(b.split('-')[1]?.split('.')[0] ?? 0)
      return nb - na
    })
  for (const b of builds) {
    const candidates = [
      join(base, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-linux64', 'chrome'),
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  throw new Error(`No Chrome executable inside ${base}`)
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
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
    console.log('[shot] starting preview server…')
    server = spawn('npx', ['vite', 'preview', '--port', String(opts.port), '--host', '127.0.0.1'], {
      cwd: root, stdio: 'ignore', detached: false,
    })
    if (!(await waitForServer(baseUrl, 60000))) {
      server.kill()
      throw new Error('Preview server never came up. Did `npm run build` succeed?')
    }
  }

  const browser = await launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-gpu',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--enable-webgl2-compute-context',
      '--disable-frame-rate-limit',
      '--hide-scrollbars',
      `--window-size=${opts.width},${opts.height}`,
    ],
    defaultViewport: { width: opts.width, height: opts.height, deviceScaleFactor: 1 },
    protocolTimeout: 180000,
  })

  const report = []
  let hadFailure = false

  for (const pose of opts.poses) {
    const page = await browser.newPage()
    const errors = []
    const warnings = []
    // favicon/sourcemap 404s are noise from the harness, not game failures.
    const isNoise = (text) => /favicon|\.map\b|Failed to load resource: the server responded with a status of 404/i.test(text)
    page.on('console', (msg) => {
      const t = msg.type()
      const text = msg.text()
      if (isNoise(text)) return
      if (t === 'error') errors.push(text)
      else if (t === 'warning') warnings.push(text)
    })
    page.on('pageerror', (err) => errors.push(String(err.message ?? err)))

    const hudParam = opts.hud === null ? '' : `&hud=${opts.hud}`
    const url = `${baseUrl}/?pose=${pose}&quality=${opts.quality}${hudParam}&autostart=1`

    let status = 'ok'
    let note = ''
    try {
      // The rAF loop means the page never goes network-idle; readiness is
      // signalled by the engine once the sim has frozen and TAA converged.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForFunction('window.__booted === true || window.__bootError', { timeout: 60000, polling: 100 })
      const bootErr = await page.evaluate(() => window.__bootError ?? null)
      if (bootErr) throw new Error(`boot failed: ${String(bootErr).split('\n').slice(0, 3).join(' | ')}`)
      await page.waitForFunction('window.__captureReady === true', { timeout: 120000, polling: 100 })
      // One extra rAF settle so the last presented frame is the one we read.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

      const file = join(outDir, `${pose}.png`)
      await page.screenshot({ path: file, type: 'png' })

      const info = await page.evaluate(() => {
        const e = window.__engine
        if (!e) return null
        return {
          frameMs: Number(e.frameMs?.toFixed?.(2) ?? 0),
          drawCalls: e.renderer?.info?.render?.calls ?? 0,
          triangles: e.renderer?.info?.render?.triangles ?? 0,
          textures: e.renderer?.info?.memory?.textures ?? 0,
          geometries: e.renderer?.info?.memory?.geometries ?? 0,
          programs: e.renderer?.info?.programs?.length ?? 0,
        }
      })
      note = info ? `${info.frameMs}ms ${info.drawCalls} calls ${(info.triangles / 1000).toFixed(0)}k tris ${info.textures} tex` : ''
      report.push({ pose, status, file, errors, warnings: warnings.slice(0, 5), perf: info })
      console.log(`[shot] ${pose.padEnd(10)} ✓  ${note}`)
    } catch (err) {
      status = 'FAILED'
      hadFailure = true
      const bootError = await page.evaluate(() => window.__bootError ?? null).catch(() => null)
      report.push({ pose, status, errors: [...errors, String(err.message ?? err), bootError].filter(Boolean) })
      console.error(`[shot] ${pose.padEnd(10)} ✗  ${err.message ?? err}`)
      if (bootError) console.error(`        boot error: ${bootError.split('\n')[0]}`)
      // Capture whatever is on screen to aid debugging.
      await page.screenshot({ path: join(outDir, `${pose}.FAILED.png`) }).catch(() => {})
    }

    if (errors.length) {
      hadFailure = true
      console.error(`[shot] ${pose}: ${errors.length} console error(s)`)
      for (const e of errors.slice(0, 4)) console.error(`        ${e.slice(0, 220)}`)
    }

    await page.close()
  }

  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  if (server) server.kill()

  console.log(`[shot] wrote ${report.filter((r) => r.status === 'ok').length}/${opts.poses.length} to ${outDir}`)
  process.exit(hadFailure ? 1 : 0)
}

main().catch((err) => {
  console.error('[shot] fatal:', err)
  process.exit(2)
})
