#!/usr/bin/env node
/**
 * Blind A/B setup for the visual critic.
 *
 * Copies the same pose from two shot directories into a neutral folder as
 * `<pose>_A.png` / `<pose>_B.png` with the assignment randomised per pose, and
 * writes the answer key to a file the critic is not shown. This lets the critic
 * judge which iteration looks better without knowing which is newer, which is
 * the only way to get an honest read on whether a change actually helped.
 *
 *   node tools/blind.mjs --a shots/iter1 --b shots/iter2 --out shots/blind
 *   node tools/blind.mjs --reveal shots/blind      # print the key afterwards
 */
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { randomInt } from 'node:crypto'

function parseArgs(argv) {
  const out = { a: null, b: null, outDir: 'shots/blind', reveal: null }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--a') out.a = argv[++i]
    else if (arg === '--b') out.b = argv[++i]
    else if (arg === '--out') out.outDir = argv[++i]
    else if (arg === '--reveal') out.reveal = argv[++i]
  }
  return out
}

const opts = parseArgs(process.argv)

if (opts.reveal) {
  const keyPath = join(resolve(opts.reveal), '.key.json')
  if (!existsSync(keyPath)) {
    console.error(`No key at ${keyPath}`)
    process.exit(1)
  }
  const key = JSON.parse(readFileSync(keyPath, 'utf8'))
  console.log(`A = ${key.labelA}   B = ${key.labelB}`)
  for (const [pose, mapping] of Object.entries(key.poses)) {
    console.log(`  ${pose.padEnd(12)} A=${mapping.A}  B=${mapping.B}`)
  }
  process.exit(0)
}

if (!opts.a || !opts.b) {
  console.error('Usage: blind.mjs --a <dirA> --b <dirB> [--out <dir>]')
  process.exit(1)
}

const dirA = resolve(opts.a)
const dirB = resolve(opts.b)
const outDir = resolve(opts.outDir)

for (const d of [dirA, dirB]) {
  if (!existsSync(d)) {
    console.error(`Missing directory: ${d}`)
    process.exit(1)
  }
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const posesA = new Set(readdirSync(dirA).filter((f) => f.endsWith('.png') && !f.includes('FAILED')).map((f) => basename(f, '.png')))
const posesB = new Set(readdirSync(dirB).filter((f) => f.endsWith('.png') && !f.includes('FAILED')).map((f) => basename(f, '.png')))
const shared = [...posesA].filter((p) => posesB.has(p)).sort()

if (shared.length === 0) {
  console.error('No poses present in both directories.')
  process.exit(1)
}

const key = { labelA: basename(dirA), labelB: basename(dirB), poses: {} }

for (const pose of shared) {
  // Randomise per pose so the critic cannot learn "A is always the new one".
  const flip = randomInt(2) === 1
  const srcForA = flip ? dirB : dirA
  const srcForB = flip ? dirA : dirB
  copyFileSync(join(srcForA, `${pose}.png`), join(outDir, `${pose}_A.png`))
  copyFileSync(join(srcForB, `${pose}.png`), join(outDir, `${pose}_B.png`))
  key.poses[pose] = { A: basename(srcForA), B: basename(srcForB) }
}

writeFileSync(join(outDir, '.key.json'), JSON.stringify(key, null, 2))
console.log(`[blind] ${shared.length} pose pair(s) in ${outDir}`)
console.log(`[blind] poses: ${shared.join(', ')}`)
console.log('[blind] key withheld — reveal with: node tools/blind.mjs --reveal ' + opts.outDir)
