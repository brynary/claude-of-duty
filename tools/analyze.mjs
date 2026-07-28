#!/usr/bin/env node
/**
 * Objective tonal analysis of captured frames.
 *
 * Three rounds of critique oscillated between "washed out" and "crushed"
 * because each round was given a direction to move rather than a target to hit.
 * This measures the image so the target can be stated as numbers.
 *
 *   node tools/analyze.mjs shots/iter3
 *   node tools/analyze.mjs shots/iter2 shots/iter3      # side by side
 *
 * Decoding happens in headless Chrome via canvas, which avoids adding an image
 * library as a dependency.
 */
import { launch } from 'puppeteer-core'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

/**
 * What a shipped daylight FPS frame looks like when measured. Derived from the
 * blind judges' own measurements of which frames read as shipped and which read
 * as untuned, plus the failure modes they named.
 */
const TARGET = {
  meanLuma: [32, 55],
  /** Global spread. Both prior iterations sat near 32; punchy frames are higher. */
  stdLuma: [45, 65],
  /** Real blacks must exist, but must not swallow the frame. */
  pctBelow8: [1.5, 10],
  /** A true white point must be present — speculars and the sun. */
  pctAbove247: [0.05, 3],
  maxLuma: [250, 255],
  /** Local detail. This is what "micro-contrast" means numerically. */
  localContrast: [0.030, 0.070],
  /**
   * Near-field haze. Measured as how much the bottom-centre of the frame (the
   * closest ground, typically under 4m) has been lifted toward fog colour. A
   * shipped frame has effectively none.
   */
  nearFieldLift: [0, 0.06],
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome')
  const builds = readdirSync(base).sort((a, b) =>
    Number(b.split('-')[1]?.split('.')[0] ?? 0) - Number(a.split('-')[1]?.split('.')[0] ?? 0))
  for (const b of builds) {
    for (const c of [
      join(base, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(base, b, 'chrome-linux64', 'chrome'),
    ]) if (existsSync(c)) return c
  }
  throw new Error('No cached Chrome found')
}

/** Runs in the page: decode a data URL and measure it. */
async function measure(page, dataUrl) {
  return page.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)

    // Exclude the HUD margins so interface pixels do not skew the histogram.
    const x0 = Math.round(w * 0.10)
    const x1 = Math.round(w * 0.90)
    const y0 = Math.round(h * 0.10)
    const y1 = Math.round(h * 0.92)
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0)
    const px = d.data
    const cw = d.width
    const ch = d.height

    const lum = new Float32Array(cw * ch)
    let sum = 0
    let below8 = 0
    let above247 = 0
    let max = 0
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      const L = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]
      lum[i] = L
      sum += L
      if (L < 8) below8++
      if (L > 247) above247++
      if (L > max) max = L
    }
    const mean = sum / lum.length
    let varAcc = 0
    for (let i = 0; i < lum.length; i++) varAcc += (lum[i] - mean) ** 2
    const std = Math.sqrt(varAcc / lum.length)

    // Local contrast: mean absolute deviation inside 8px blocks, normalised.
    let lcAcc = 0
    let lcN = 0
    const B = 8
    for (let by = 0; by + B < ch; by += B) {
      for (let bx = 0; bx + B < cw; bx += B) {
        let bs = 0
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) bs += lum[(by + y) * cw + bx + x]
        const bm = bs / (B * B)
        let dev = 0
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) dev += Math.abs(lum[(by + y) * cw + bx + x] - bm)
        lcAcc += dev / (B * B) / 255
        lcN++
      }
    }

    // Near-field lift: how far the closest ground sits above true black at its
    // darkest. Heavy near haze shows up as a raised floor in this strip.
    const nx0 = Math.round(cw * 0.25)
    const nx1 = Math.round(cw * 0.60)
    const ny0 = Math.round(ch * 0.80)
    const near = []
    for (let y = ny0; y < ch; y++) for (let x = nx0; x < nx1; x++) near.push(lum[y * cw + x])
    near.sort((a, b) => a - b)
    const nearFloor = near[Math.floor(near.length * 0.02)] / 255

    return {
      mean: +mean.toFixed(1),
      std: +std.toFixed(1),
      pctBelow8: +((below8 / lum.length) * 100).toFixed(2),
      pctAbove247: +((above247 / lum.length) * 100).toFixed(2),
      max: Math.round(max),
      localContrast: +(lcAcc / lcN).toFixed(4),
      nearFieldLift: +nearFloor.toFixed(4),
    }
  }, dataUrl)
}

function verdict(value, [lo, hi]) {
  if (value < lo) return 'LOW '
  if (value > hi) return 'HIGH'
  return ' ok '
}

async function main() {
  const dirs = process.argv.slice(2)
  if (dirs.length === 0) {
    console.error('Usage: analyze.mjs <shotDir> [shotDir2 ...]')
    process.exit(1)
  }

  const browser = await launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('about:blank')

  const results = {}
  for (const dir of dirs) {
    const d = resolve(dir)
    const label = basename(d)
    results[label] = {}
    for (const f of readdirSync(d).filter((f) => f.endsWith('.png') && !f.includes('FAILED')).sort()) {
      const url = `data:image/png;base64,${readFileSync(join(d, f)).toString('base64')}`
      results[label][basename(f, '.png')] = await measure(page, url)
    }
  }
  await browser.close()

  const metrics = ['mean', 'std', 'pctBelow8', 'pctAbove247', 'max', 'localContrast', 'nearFieldLift']
  const targetKey = { mean: 'meanLuma', std: 'stdLuma', pctBelow8: 'pctBelow8', pctAbove247: 'pctAbove247', max: 'maxLuma', localContrast: 'localContrast', nearFieldLift: 'nearFieldLift' }

  console.log('\nTARGET RANGES')
  for (const m of metrics) console.log(`  ${m.padEnd(15)} ${JSON.stringify(TARGET[targetKey[m]])}`)

  for (const [label, poses] of Object.entries(results)) {
    console.log(`\n=== ${label} ===`)
    console.log('  pose         ' + metrics.map((m) => m.slice(0, 9).padStart(11)).join(''))
    const agg = {}
    for (const [pose, r] of Object.entries(poses)) {
      console.log('  ' + pose.padEnd(13) + metrics.map((m) => String(r[m]).padStart(11)).join(''))
      for (const m of metrics) (agg[m] ||= []).push(r[m])
    }
    console.log('  ' + 'MEAN'.padEnd(13) + metrics.map((m) => (agg[m].reduce((a, b) => a + b, 0) / agg[m].length).toFixed(3).padStart(11)).join(''))
    console.log('  ' + 'VERDICT'.padEnd(13) + metrics.map((m) => verdict(agg[m].reduce((a, b) => a + b, 0) / agg[m].length, TARGET[targetKey[m]]).padStart(11)).join(''))
  }
  console.log()
}

main().catch((e) => { console.error(e); process.exit(1) })
