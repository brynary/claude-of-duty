#!/usr/bin/env node
/**
 * Gameplay analysis — the feel equivalent of `analyze.mjs`.
 *
 * Reduces a directory of telemetry runs to a table against target ranges, so
 * tuning is aimed at a number rather than at an adjective. The visual work
 * oscillated for three rounds between "washed out" and "crushed" because both
 * were directions rather than targets; this exists so the same mistake is not
 * repeated on feel.
 *
 *   node tools/analyze-play.mjs runs/mybuild
 *   node tools/analyze-play.mjs runs/before runs/after     # side by side
 *
 * Targets live in `.ai/FEEL_TARGET.md`. Every number below cites the line of
 * reasoning that produced it; if the research revises a figure, change it here
 * and in that document together.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

/**
 * Provisional targets, pending `.ai/FEEL_TARGET.md`. Ranges are deliberately
 * wide where the genre itself varies between titles.
 */
const TARGETS = {
  ttkMean: { range: [0.25, 0.65], unit: 's', label: 'Time to kill (mean)',
    why: 'CoD TTK is famously short; assault rifles sit in the 250-500ms band at effective range.' },
  ttkMax: { range: [0, 1.2], unit: 's', label: 'Time to kill (worst)',
    why: 'A long tail means an enemy soaked a magazine, which reads as unresponsive weapons.' },
  accuracy: { range: [0.18, 0.42], unit: '', label: 'Player accuracy',
    why: 'Typical competent play. Far below suggests spread or recoil is fighting the player; far above suggests no challenge.' },
  enemyReaction: { range: [0.35, 0.90], unit: 's', label: 'Enemy reaction time',
    why: 'Fast enough to feel alert, slow enough that the player who sees first wins. Below ~0.3s reads as cheating.' },
  engagementDistance: { range: [8, 28], unit: 'm', label: 'Engagement distance (mean)',
    why: 'CoD multiplayer engagements cluster at short-to-mid range; a map that only fights at one distance is monotonous.' },
  downtimeMean: { range: [4, 14], unit: 's', label: 'Downtime between engagements',
    why: 'The rhythm of fight-breathe-fight. Near zero is a continuous firefight with no shape.' },
  downtimeMax: { range: [0, 35], unit: 's', label: 'Longest quiet stretch',
    why: 'A long gap is a dead patch in the map where the player is walking with nothing to do.' },
  deathsPerMinute: { range: [0.3, 1.6], unit: '/min', label: 'Deaths per minute',
    why: 'Frequent enough for stakes, rare enough that death is informative rather than noise.' },
  killsPerMinute: { range: [3, 12], unit: '/min', label: 'Kills per minute',
    why: 'The pace of reward. Too low reads as a slog; too high as no resistance.' },
  unseenDeathFraction: { range: [0, 0.25], unit: '', label: 'Deaths from unseen attackers',
    why: 'The clearest measure of feeling cheated. A death the player could not have anticipated should be rare.' },
  fractionAds: { range: [0.12, 0.45], unit: '', label: 'Time aiming down sights',
    why: 'ADS should be the considered option, not the only viable one.' },
  fractionSprinting: { range: [0.10, 0.40], unit: '', label: 'Time sprinting',
    why: 'Rotation between fights. Near zero means fights never break; very high means the map is too empty.' },
  dryFireRate: { range: [0, 0.10], unit: '', label: 'Dry fires per reload',
    why: 'Running the magazine dry mid-fight repeatedly means the reload cadence fights the fight rhythm.' },
}

function pick(run) {
  const dur = Math.max(run.duration, 1e-6)
  const mins = dur / 60
  return {
    ttkMean: run.timeToKill.mean,
    ttkMax: run.timeToKill.max,
    accuracy: run.accuracy,
    enemyReaction: run.enemyReaction.mean,
    engagementDistance: run.engagementDistance.mean,
    downtimeMean: run.downtime.mean,
    downtimeMax: run.downtime.max,
    deathsPerMinute: run.deaths / mins,
    killsPerMinute: run.kills / mins,
    unseenDeathFraction: run.deaths ? run.unseenDeaths / run.deaths : 0,
    fractionAds: run.fractionAds,
    fractionSprinting: run.fractionSprinting,
    dryFireRate: run.reloads ? run.dryFires / run.reloads : 0,
  }
}

function verdict(v, [lo, hi]) {
  if (v === null || v === undefined || Number.isNaN(v)) return ' n/a'
  if (v < lo) return ' LOW'
  if (v > hi) return 'HIGH'
  return '  ok'
}

function fmt(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (unit === '') return v.toFixed(3)
  if (unit === '/min') return v.toFixed(2)
  return v.toFixed(2) + unit
}

function loadDir(dir) {
  const d = resolve(dir)
  if (!existsSync(d)) throw new Error(`No such directory: ${d}`)
  return readdirSync(d)
    .filter((f) => f.endsWith('.json') && f !== 'runs.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')))
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('Usage: analyze-play.mjs <runDir> [runDir2 ...]')
  process.exit(1)
}

const keys = Object.keys(TARGETS)

console.log('\nTARGETS  (see .ai/FEEL_TARGET.md)')
for (const k of keys) {
  const t = TARGETS[k]
  console.log(`  ${t.label.padEnd(34)} [${t.range[0]}, ${t.range[1]}]${t.unit ? ' ' + t.unit : ''}`)
}

for (const dir of dirs) {
  const runs = loadDir(dir)
  if (runs.length === 0) { console.log(`\n=== ${basename(dir)} === (no runs)`); continue }
  console.log(`\n=== ${basename(dir)} ===`)

  const nameW = Math.max(22, ...runs.map((r) => (r.label ?? r.scenario).length + 1))
  console.log('  ' + 'run'.padEnd(nameW) + keys.map((k) => k.slice(0, 9).padStart(11)).join(''))

  const agg = {}
  for (const r of runs) {
    const m = pick(r)
    console.log('  ' + String(r.label ?? r.scenario).padEnd(nameW) +
      keys.map((k) => fmt(m[k], TARGETS[k].unit).padStart(11)).join(''))
    for (const k of keys) if (m[k] !== null && !Number.isNaN(m[k])) (agg[k] ||= []).push(m[k])
  }

  const mean = {}
  for (const k of keys) mean[k] = agg[k]?.length ? agg[k].reduce((a, b) => a + b, 0) / agg[k].length : null
  console.log('  ' + 'MEAN'.padEnd(nameW) + keys.map((k) => fmt(mean[k], TARGETS[k].unit).padStart(11)).join(''))
  console.log('  ' + 'VERDICT'.padEnd(nameW) + keys.map((k) => verdict(mean[k], TARGETS[k].range).padStart(11)).join(''))

  const bad = keys.filter((k) => verdict(mean[k], TARGETS[k].range).trim() !== 'ok' && mean[k] !== null)
  if (bad.length) {
    console.log('\n  Out of range:')
    for (const k of bad) {
      const t = TARGETS[k]
      console.log(`    ${t.label} — ${fmt(mean[k], t.unit)} against [${t.range[0]}, ${t.range[1]}]`)
      console.log(`      ${t.why}`)
    }
  } else {
    console.log('\n  Every metric in range.')
  }

  // Pacing shape: where the run went quiet.
  const first = runs[0]
  if (first?.pacing?.length) {
    const quiet = first.pacing.filter((b) => b.shotsFired === 0 && b.damageTaken === 0)
    const runsOfQuiet = []
    let start = null
    for (const b of first.pacing) {
      const isQuiet = b.shotsFired === 0 && b.damageTaken === 0
      if (isQuiet && start === null) start = b.t
      if (!isQuiet && start !== null) { runsOfQuiet.push([start, b.t]); start = null }
    }
    if (start !== null) runsOfQuiet.push([start, first.pacing.at(-1).t])
    const longest = runsOfQuiet.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0]
    console.log(`\n  Pacing (${first.label}): ${quiet.length}/${first.pacing.length}s quiet` +
      (longest ? `, longest lull ${longest[1] - longest[0]}s at t=${longest[0]}s` : ''))
  }
}
console.log()
