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
 * Targets sourced from `.ai/FEEL_TARGET.md`. Each cites the section it came
 * from and its confidence marker. Where our game differs structurally from the
 * source — a wave-based encounter rather than 6v6 team deathmatch — the
 * adjustment and its reasoning are stated, so nobody later mistakes a judgement
 * call for a measurement.
 */
const TARGETS = {
  ttkMean: { range: [0.20, 0.35], unit: 's', label: 'Time to kill (mean)',
    why: 'FEEL_TARGET §1, §2.1 [measured]: MW2019 just under 200ms, BO6 ARs 260-340ms. MWIII at 300ms+ was widely disliked and is the only recent title at 150HP.' },
  ttkMax: { range: [0, 0.60], unit: 's', label: 'Time to kill (worst)',
    why: 'Twice the upper target. Beyond this an enemy has soaked most of a magazine, which reads as unresponsive weapons.' },
  accuracy: { range: [0.18, 0.45], unit: '', label: 'Player accuracy',
    why: 'FEEL_TARGET §5 [stated]: ADS spread in CoD is exactly zero on every weapon inspected. Low accuracy here means spread or recoil is fighting the player.' },
  enemyReaction: { range: [0.50, 1.00], unit: 's', label: 'Enemy reaction time',
    why: 'FEEL_TARGET §7.5 [stated]: Black Ops sv_bot dvars give 500-1000ms sighting to first shot. Deliberately slower than the 200-300ms TTK so the player who sees first wins.' },
  engagementDistance: { range: [10, 30], unit: 'm', label: 'Engagement distance (mean)',
    why: 'FEEL_TARGET §6.3 [stated]: official CoD5 level-design standards specify 13m for SMG sightlines and 26m for rifle.' },
  downtimeMean: { range: [10, 40], unit: 's', label: 'Downtime between engagements',
    why: 'FEEL_TARGET §6.1 [estimated] derives 25-45s from TDM score limits. Widened at the low end because a wave-based encounter clusters more tightly than 6v6 — but near zero is still one continuous firefight with no shape.' },
  downtimeMax: { range: [0, 60], unit: 's', label: 'Longest quiet stretch',
    why: 'A long gap is a dead patch where the player walks with nothing to do. FEEL_TARGET §6.2 puts spawn to first contact at 5-10s.' },
  deathsPerMinute: { range: [0.3, 1.5], unit: '/min', label: 'Deaths per minute',
    why: 'FEEL_TARGET §6.1 [estimated]: TDM maths gives 0.83 deaths/min per player, one death roughly every 72s.' },
  killsPerMinute: { range: [3, 15], unit: '/min', label: 'Kills per minute',
    why: 'Campaign-shaped rather than the TDM figure: a wave encounter rewards far more frequently than 6v6. Too low reads as a slog, too high as no resistance.' },
  unseenDeathFraction: { range: [0, 0.25], unit: '', label: 'Deaths from unseen attackers',
    why: 'The clearest measure of feeling cheated. A death the player could not have anticipated should be rare.' },
  fractionAds: { range: [0.12, 0.45], unit: '', label: 'Time aiming down sights',
    why: 'ADS should be the considered option rather than the only viable one, given hipfire is meant to stay usable close in.' },
  fractionSprinting: { range: [0.10, 0.40], unit: '', label: 'Time sprinting',
    why: 'Rotation between fights. Near zero means fights never break; very high means the map is too empty.' },
  dryFireRate: { range: [0, 0.10], unit: '', label: 'Dry fires per reload',
    why: 'Running dry mid-fight repeatedly means the reload cadence fights the fight rhythm.' },
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
