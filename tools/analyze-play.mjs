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
 * Targets for tuning, against `.ai/FEEL_TARGET.md`.
 *
 * **Six of the thirteen are design judgements citing no research at all.** Each
 * carries a `source` field naming its provenance, and that field is printed
 * beside the range wherever a range is printed. That is deliberate: an earlier
 * version showed only the label and the range in the header block and kept the
 * reasoning in a branch that only ran on failure, so a target could be read and
 * quoted with no indication whether it was measured or invented. One was, and
 * came back through a third party as a suspected corrupted citation. A number
 * must never travel without its provenance.
 *
 * `source` vocabulary:
 *   §n [marker] — traceable to that section of FEEL_TARGET at that confidence
 *   derived      — arithmetic on sourced figures; the working is in `why`
 *   design       — a judgement call with no research basis, stated as such
 */
const TARGETS = {
  // NOT time-to-kill. This measures first damaging hit to death, which is
  // (STK-1) / (hitRate x RPM/60 x dutyCycle) — so it is dominated by accuracy,
  // not by weapon lethality, and it moves the wrong way when damage rises.
  // It was labelled "time to kill" for the first two rounds and read 1.47s
  // against a 200-300ms target, which framed an accuracy problem as a weapon
  // problem. True TTK is a property of the weapon table, not of a run, and is
  // verified by arithmetic in the gunfeel report: M4A1 4 STK at 780 RPM = 231ms.
  killDuration: { range: [0.8, 2.2], unit: 's', label: 'Kill duration (first hit to death)', source: 'derived',
    why: 'At the 4 shots-to-kill and 780 RPM the weapon table now specifies, and the 18-45% accuracy band, a kill takes 4/hitRate rounds at 76.9ms spacing across a burst duty cycle near 55%: roughly 0.9s at 45% accuracy and 2.2s at 18%. Wider than the sourced TTK because it deliberately includes the misses.' },
  killDurationMax: { range: [0, 4.0], unit: 's', label: 'Kill duration (worst)', source: 'design',
    why: 'A ceiling so a long tail cannot hide inside a healthy mean. An enemy taking longer than this to die has soaked an entire magazine of near-misses, which reads as unresponsive weapons whatever the cause.' },
  accuracy: { range: [0.18, 0.45], unit: '', label: 'Player accuracy', source: 'design',
    why: 'FEEL_TARGET contains no player-accuracy figure at all, so this range is invented. It earns its place only as a tripwire: §3.6 [stated] establishes that ADS spread in CoD is exactly zero, so an accuracy far below this band means spread or recoil is fighting the player rather than that the player is bad.' },
  enemyReaction: { range: [0.50, 1.00], unit: 's', label: 'Enemy reaction time', source: '§7.5 [stated]',
    why: 'sv_botMinReactionTime 500 / sv_botMaxReactionTime 1000, exactly. Note these are Black Ops (2010) multiplayer-bot dvars — §9 records that no modern CoD AI parameters are published, so this is the series\' own number but not a current one. Deliberately slower than the 200-300ms TTK so the player who sees first wins.' },
  engagementDistance: { range: [10, 30], unit: 'm', label: 'Engagement distance (mean)', source: '§6.3 [stated] + margin',
    why: 'Official CoD5 level-design standards specify 13m for SMG sightlines and 26m for rifle. The range brackets both anchors with modest margin; the widening is mine.' },
  downtimeMean: { range: [12, 28], unit: 's', label: 'Downtime between engagements', source: 'derived from §6.1 [measured] + §6.2 [estimated]',
    why: 'Round-based inter-round break is 10-15s (BO3 zombie_between_round_time), NOT the 25-45s TDM engagement cadence — §6.1 is explicit that a 30s break in a wave mode reads as a bug. What this metric measures is the gap from one engagement ending to the next contact, which is that break PLUS the approach time staging buys (§6.2, 5-11s). 10-15 + 5-11 = 15-26s, bounded at 12-28 for margin.' },
  downtimeMax: { range: [0, 45], unit: 's', label: 'Longest quiet stretch', source: 'design',
    why: 'A sanity ceiling on dead patches where the player walks with nothing to do, not a tuning target. No sourced figure bounds this; §6.1 argues extra quiet should come from inside the encounter — approach, disengagement, flanking — rather than a longer scheduled break.' },
  deathsPerMinute: { range: [0.3, 1.5], unit: '/min', label: 'Deaths per minute', source: '§6.1 [estimated] + widening',
    why: 'TDM arithmetic gives 0.83 deaths/min per player, one death roughly every 72s. Deliberately widened because §6.1 warns its own even-kill-distribution assumption is false, so a soft source deserves a wide band.' },
  killsPerMinute: { range: [3, 15], unit: '/min', label: 'Kills per minute', source: 'design',
    why: 'No research basis whatsoever — FEEL_TARGET contains no campaign or wave-mode kill-rate data. A wave encounter should reward more often than 6v6 deathmatch, but how much more is a guess. See the K/D note below.' },
  unseenDeathFraction: { range: [0, 0.25], unit: '', label: 'Deaths from unseen attackers', source: 'design',
    why: 'The clearest measure of feeling cheated. A death the player could not have anticipated should be rare.' },
  fractionAds: { range: [0.12, 0.45], unit: '', label: 'Time aiming down sights', source: 'design',
    why: 'ADS should be the considered option rather than the only viable one. Groundable in principle from §3.6 hipfire cones and §4.6 aim-assist capsule, but the weapon files do not say whether hipSpreadStandMin is a half-angle or a full cone, and the answer changes the result fourfold — so it must be computed in-engine, not asserted.' },
  fractionSprinting: { range: [0.10, 0.40], unit: '', label: 'Time sprinting', source: 'design',
    why: 'Rotation between fights. Near zero means fights never break; very high means the map is too empty.' },
  dryFireRate: { range: [0, 0.10], unit: '', label: 'Dry fires per reload', source: 'design',
    why: 'Running dry mid-fight repeatedly means the reload cadence fights the fight rhythm.' },
}

/**
 * A design commitment that lives in no single target and would otherwise go
 * unstated: a kills floor of 3/min against a deaths ceiling of 1.5/min implies
 * a K/D floor of 2.0, and at the range extremes as much as 10. Team deathmatch
 * is 1.0 by construction. Making the player markedly dominant is a legitimate
 * choice for a wave shooter — it is the power fantasy the genre sells — but it
 * is a choice, it is large, and it is currently distributed across two
 * unrelated ranges where nobody would ever see it.
 */
const IMPLIED_KD_FLOOR = 3 / 1.5

function pick(run) {
  const dur = Math.max(run.duration, 1e-6)
  const mins = dur / 60
  return {
    killDuration: run.timeToKill.mean,
    killDurationMax: run.timeToKill.max,
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
console.log('  Provenance travels with every range. "design" means invented, not measured.\n')
for (const k of keys) {
  const t = TARGETS[k]
  const range = `[${t.range[0]}, ${t.range[1]}]${t.unit ? ' ' + t.unit : ''}`
  console.log(`  ${t.label.padEnd(34)} ${range.padEnd(16)} ${t.source}`)
}
console.log(`\n  Implied K/D floor: ${IMPLIED_KD_FLOOR.toFixed(1)} (kills floor / deaths ceiling). TDM is 1.0 by construction.`)

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
