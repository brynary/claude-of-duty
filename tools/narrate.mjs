#!/usr/bin/env node
/**
 * Turns a telemetry run into a readable account of what happened.
 *
 * A blind A/B on *fun* needs something a judge can reason about. Raw telemetry
 * is falsifiable but abstract, and nobody can tell whether a match was
 * enjoyable from a JSON blob of engagement records. This reconstructs the run
 * as a timeline — contacts, exchanges, kills, deaths, lulls — so a reader can
 * follow the shape of the fight and say where it sagged, where it felt unfair,
 * and whether one tactic solved everything.
 *
 *   node tools/narrate.mjs runs/mybuild/push-average-1337.json
 *   node tools/narrate.mjs runs/mybuild            # every run in the directory
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

function fmt(t) {
  return String(t.toFixed(1)).padStart(6)
}

function bar(value, max, width = 20) {
  if (max <= 0) return ''
  const n = Math.round((value / max) * width)
  return '#'.repeat(Math.max(0, Math.min(width, n)))
}

function narrate(run) {
  const out = []
  const L = (s) => out.push(s)

  L(`# ${run.label ?? run.scenario}`)
  L('')
  L(`scenario ${run.scenario} · skill ${run.skill} · seed ${run.seed} · ${run.duration.toFixed(0)}s`)
  L('')

  // --- Headline ------------------------------------------------------------
  L('## Outcome')
  L('')
  L(`${run.kills} kills, ${run.deaths} deaths, ${(run.accuracy * 100).toFixed(0)}% accuracy ` +
    `(${run.shotsHit}/${run.shotsFired} shots), ${run.headshots} headshots.`)
  L(`Dealt ${Math.round(run.damageDealt)} damage, took ${Math.round(run.damageTaken)}.`)
  L(`Travelled ${run.distanceTravelled.toFixed(0)}m. ` +
    `${(run.fractionSprinting * 100).toFixed(0)}% sprinting, ` +
    `${(run.fractionAds * 100).toFixed(0)}% aiming, ` +
    `${(run.fractionStationary * 100).toFixed(0)}% stationary.`)
  L(`${run.reloads} reloads, ${run.dryFires} of them after running dry mid-fight.`)
  L('')

  // --- Timeline ------------------------------------------------------------
  const events = []
  for (const e of run.engagements) {
    events.push({ t: e.startedAt, kind: 'contact', e })
    if (e.outcome === 'playerKilled') events.push({ t: e.endedAt, kind: 'kill', e })
    else if (e.outcome === 'disengaged') events.push({ t: e.endedAt, kind: 'broke', e })
  }
  for (const d of run.deaths_detail) events.push({ t: d.at, kind: 'death', d })
  events.sort((a, b) => a.t - b.t)

  L('## Timeline')
  L('')
  let last = 0
  for (const ev of events) {
    const gap = ev.t - last
    if (gap > 3) L(`${fmt(last + gap / 2)}  … ${gap.toFixed(0)}s quiet …`)
    last = ev.t

    if (ev.kind === 'contact') {
      const e = ev.e
      const react = e.enemyReaction === null ? 'never fired' : `returned fire after ${e.enemyReaction.toFixed(2)}s`
      L(`${fmt(ev.t)}  contact — enemy ${e.enemyId} at ${e.openingDistance.toFixed(0)}m, ${react}` +
        (e.killedFromUnseen ? '   [player had not seen it]' : ''))
    } else if (ev.kind === 'kill') {
      const e = ev.e
      const ttk = e.timeToKill === null ? '?' : e.timeToKill.toFixed(2) + 's'
      const acc = e.playerShotsFired ? ((e.playerHits / e.playerShotsFired) * 100).toFixed(0) + '%' : '—'
      L(`${fmt(ev.t)}  killed enemy ${e.enemyId} — ${ttk} to kill, ` +
        `${e.playerHits}/${e.playerShotsFired} hits (${acc})` +
        (e.playerHeadshots ? `, ${e.playerHeadshots} headshot` : '') +
        (e.damageTaken ? `, took ${Math.round(e.damageTaken)} doing it` : ''))
    } else if (ev.kind === 'broke') {
      L(`${fmt(ev.t)}  lost contact with enemy ${ev.e.enemyId} after ${(ev.e.endedAt - ev.e.startedAt).toFixed(0)}s`)
    } else if (ev.kind === 'death') {
      const d = ev.d
      const aware = d.awareFor === null
        ? 'never saw the attacker'
        : `had been aware of it for ${d.awareFor.toFixed(1)}s`
      L(`${fmt(ev.t)}  *** PLAYER DIED *** killed by enemy ${d.killerId ?? '?'} at ${d.distance.toFixed(0)}m — ${aware}`)
    }
  }
  L('')

  // --- Pacing --------------------------------------------------------------
  if (run.pacing?.length) {
    L('## Pacing')
    L('')
    L('Each row is one second. Bars are shots fired; `!` marks damage taken.')
    L('')
    const maxShots = Math.max(1, ...run.pacing.map((b) => b.shotsFired))
    for (const b of run.pacing) {
      const hurt = b.damageTaken > 0 ? ` !${Math.round(b.damageTaken)}` : ''
      const alive = b.enemiesAlive ? ` (${b.enemiesInContact}/${b.enemiesAlive} in contact)` : ''
      L(`${String(b.t).padStart(4)}s ${bar(b.shotsFired, maxShots).padEnd(20)}${hurt}${alive}`)
    }
    L('')

    const quiet = run.pacing.filter((b) => b.shotsFired === 0 && b.damageTaken === 0).length
    L(`${quiet} of ${run.pacing.length} seconds were quiet.`)
    L('')
  }

  // --- Bot decisions -------------------------------------------------------
  if (run.botLog?.length) {
    L('## What the player did')
    L('')
    for (const entry of run.botLog.slice(0, 120)) {
      L(`${fmt(entry.t)}  ${entry.action}`)
    }
    if (run.botLog.length > 120) L(`  … ${run.botLog.length - 120} more`)
    L('')
  }

  return out.join('\n')
}

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: narrate.mjs <run.json | runDir>')
  process.exit(1)
}
const p = resolve(arg)
if (!existsSync(p)) { console.error(`No such path: ${p}`); process.exit(1) }

const files = statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => f.endsWith('.json') && f !== 'runs.json').sort().map((f) => join(p, f))
  : [p]

for (const f of files) {
  console.log(narrate(JSON.parse(readFileSync(f, 'utf8'))))
  if (files.length > 1) console.log('\n' + '='.repeat(72) + '\n')
}
