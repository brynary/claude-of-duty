import * as THREE from 'three'
import type { GameContext, System, Damageable } from './Types'

/**
 * Gameplay measurement.
 *
 * The visual work was only able to converge once the target was written as
 * numbers rather than adjectives. Feel has the same failure mode and needs the
 * same remedy, so this records what actually happened during a run — every
 * shot, every hit, every engagement, every death — and reduces it to a table
 * that can be compared against `.ai/FEEL_TARGET.md`.
 *
 * Nothing here influences the simulation. It subscribes to the event bus and
 * samples state; it never writes to it.
 */

/** One exchange between the player and one enemy, from first contact to resolution. */
export interface Engagement {
  enemyId: number
  /** Seconds from run start. */
  startedAt: number
  endedAt: number
  /** Distance in metres when the engagement opened. */
  openingDistance: number
  /** How the exchange resolved. */
  outcome: 'playerKilled' | 'playerDied' | 'disengaged' | 'unresolved'
  /** Seconds from the player's first damaging hit to the enemy dying. */
  timeToKill: number | null
  /** Seconds from the enemy first seeing the player to its first shot. */
  enemyReaction: number | null
  playerShotsFired: number
  playerHits: number
  playerHeadshots: number
  damageTaken: number
  /** True when the player never saw the enemy that damaged them. */
  killedFromUnseen: boolean
}

export interface DeathRecord {
  at: number
  killerId: number | null
  distance: number
  /** Seconds the player had been aware of this attacker. Null when ambushed. */
  awareFor: number | null
  healthBefore: number
}

/** A one-second bucket of activity, used to find pacing gaps. */
export interface PacingBucket {
  t: number
  shotsFired: number
  damageDealt: number
  damageTaken: number
  enemiesAlive: number
  enemiesInContact: number
  distanceMoved: number
}

export interface TelemetryReport {
  seed: number
  scenario: string
  skill: string
  duration: number

  // Combat
  shotsFired: number
  shotsHit: number
  accuracy: number
  headshots: number
  headshotRate: number
  kills: number
  deaths: number
  damageDealt: number
  damageTaken: number

  /** Seconds of sustained fire to kill one enemy, per engagement. */
  timeToKill: { mean: number | null; min: number | null; max: number | null; samples: number[] }
  /** Seconds from an enemy acquiring the player to its first shot. */
  enemyReaction: { mean: number | null; min: number | null; max: number | null; samples: number[] }
  /** Metres at which engagements opened. */
  engagementDistance: { mean: number | null; min: number | null; max: number | null }

  // Pacing
  engagements: Engagement[]
  /** Seconds between the end of one engagement and the start of the next. */
  downtime: { mean: number | null; max: number | null; samples: number[] }
  timeToFirstContact: number | null
  /** Fraction of the run with no enemy in contact. */
  idleFraction: number

  // Movement and handling
  distanceTravelled: number
  fractionSprinting: number
  fractionAds: number
  fractionCrouched: number
  fractionStationary: number
  reloads: number
  /** Times the player fired dry — a sign the reload cadence fights the fight. */
  dryFires: number
  weaponSwaps: number

  // Fairness
  deaths_detail: DeathRecord[]
  /** Deaths where the player had no line of sight to the killer beforehand. */
  unseenDeaths: number

  pacing: PacingBucket[]
}

interface EnemyTrack {
  id: number
  contactAt: number | null
  firstShotAt: number | null
  firstPlayerHitAt: number | null
  engagement: Engagement | null
}

const HEAD_REGIONS = new Set(['head'])

export class TelemetrySystem implements System {
  readonly name = 'telemetry'

  private ctx!: GameContext
  private t = 0

  private shotsFired = 0
  private shotsHit = 0
  private headshots = 0
  private kills = 0
  private damageDealt = 0
  private damageTaken = 0
  private reloads = 0
  private dryFires = 0
  private weaponSwaps = 0

  private tracks = new Map<number, EnemyTrack>()
  private engagements: Engagement[] = []
  private deaths: DeathRecord[] = []
  private pacing: PacingBucket[] = []

  private distanceTravelled = 0
  private sprintTime = 0
  private adsTime = 0
  private crouchTime = 0
  private stationaryTime = 0
  private noContactTime = 0
  private firstContactAt: number | null = null

  private lastPos = new THREE.Vector3()
  private havePos = false
  private bucket: PacingBucket = this.newBucket(0)

  init(ctx: GameContext): void {
    this.ctx = ctx
    const e = ctx.events

    e.on('weapon:fired', () => {
      this.shotsFired++
      this.bucket.shotsFired++
      for (const track of this.tracks.values()) {
        if (track.engagement) track.engagement.playerShotsFired++
      }
    })

    e.on('weapon:reload', (p) => { if (p.phase === 'start') this.reloads++ })
    e.on('weapon:dryFire', () => this.dryFires++)
    e.on('weapon:switch', () => this.weaponSwaps++)

    e.on('damage:dealt', (p) => {
      if (p.target.team !== 'enemy') return
      this.damageDealt += p.amount
      this.bucket.damageDealt += p.amount
      this.shotsHit++
      const head = p.hit.region ? HEAD_REGIONS.has(p.hit.region) : false
      if (head) this.headshots++

      const track = this.track(p.target.id)
      if (track.firstPlayerHitAt === null) track.firstPlayerHitAt = this.t
      const eng = this.openEngagement(track, p.target)
      eng.playerHits++
      if (head) eng.playerHeadshots++
    })

    e.on('entity:killed', (p) => {
      if (p.entity.team !== 'enemy') return
      this.kills++
      const track = this.tracks.get(p.entity.id)
      if (!track?.engagement) return
      const eng = track.engagement
      eng.outcome = 'playerKilled'
      eng.endedAt = this.t
      eng.timeToKill = track.firstPlayerHitAt === null ? null : this.t - track.firstPlayerHitAt
      this.closeEngagement(track)
    })

    e.on('ai:contact', (p) => {
      const track = this.track(p.id)
      if (track.contactAt === null) track.contactAt = this.t
      if (this.firstContactAt === null) this.firstContactAt = this.t
      const enemy = ctx.entities.get(p.id)
      if (enemy) {
        const eng = this.openEngagement(track, enemy)
        if (eng.openingDistance === 0) eng.openingDistance = p.distance
      }
    })

    e.on('ai:lostContact', (p) => {
      const track = this.tracks.get(p.id)
      if (track) track.contactAt = null
    })

    e.on('ai:engaged', (p) => {
      const track = this.track(p.id)
      if (track.firstShotAt === null) {
        track.firstShotAt = this.t
        if (track.engagement && track.engagement.enemyReaction === null) {
          track.engagement.enemyReaction = p.sinceContact
        }
      }
    })

    e.on('player:damaged', (p) => {
      this.damageTaken += p.amount
      this.bucket.damageTaken += p.amount
      // Attribute to whichever enemy currently holds contact and is nearest to
      // the direction the damage came from.
      const eng = this.nearestOpenEngagement()
      if (eng) eng.damageTaken += p.amount
    })

    e.on('player:died', () => {
      const player = ctx.services.player
      const attacker = this.nearestContactEnemy()
      this.deaths.push({
        at: this.t,
        killerId: attacker?.id ?? null,
        distance: attacker && player ? attacker.position.distanceTo(player.eye) : 0,
        awareFor: attacker ? this.awarenessDuration(attacker.id) : null,
        healthBefore: 100,
      })
      for (const track of this.tracks.values()) {
        if (track.engagement) {
          track.engagement.outcome = 'playerDied'
          track.engagement.endedAt = this.t
          this.closeEngagement(track)
        }
      }
    })
  }

  update(dt: number, ctx: GameContext): void {
    if (dt <= 0) return
    this.t += dt

    const player = ctx.services.player
    const weapons = ctx.services.weapons
    const ai = ctx.services.ai

    if (player) {
      if (this.havePos) {
        const moved = player.position.distanceTo(this.lastPos)
        this.distanceTravelled += moved
        this.bucket.distanceMoved += moved
        if (moved / dt < 0.15) this.stationaryTime += dt
      }
      this.lastPos.copy(player.position)
      this.havePos = true

      if (player.isSprinting) this.sprintTime += dt
      if (player.isCrouching) this.crouchTime += dt
    }
    if (weapons && weapons.adsFraction > 0.6) this.adsTime += dt

    const inContact = this.countContacts()
    if (inContact === 0) this.noContactTime += dt

    // Roll the pacing bucket once per simulated second.
    const second = Math.floor(this.t)
    if (second !== this.bucket.t) {
      this.bucket.enemiesAlive = ai ? ai.enemies.filter((e) => e.alive).length : 0
      this.bucket.enemiesInContact = inContact
      this.pacing.push(this.bucket)
      this.bucket = this.newBucket(second)
    }

    // Close engagements whose enemy has been out of contact for a while.
    for (const track of this.tracks.values()) {
      const eng = track.engagement
      if (!eng) continue
      if (track.contactAt === null && this.t - eng.startedAt > 8) {
        eng.outcome = 'disengaged'
        eng.endedAt = this.t
        this.closeEngagement(track)
      }
    }
  }

  // --- helpers -------------------------------------------------------------

  private newBucket(t: number): PacingBucket {
    return { t, shotsFired: 0, damageDealt: 0, damageTaken: 0, enemiesAlive: 0, enemiesInContact: 0, distanceMoved: 0 }
  }

  private track(id: number): EnemyTrack {
    let t = this.tracks.get(id)
    if (!t) {
      t = { id, contactAt: null, firstShotAt: null, firstPlayerHitAt: null, engagement: null }
      this.tracks.set(id, t)
    }
    return t
  }

  private openEngagement(track: EnemyTrack, enemy: Damageable): Engagement {
    if (track.engagement) return track.engagement
    const player = this.ctx.services.player
    const eng: Engagement = {
      enemyId: track.id,
      startedAt: this.t,
      endedAt: this.t,
      openingDistance: player ? enemy.position.distanceTo(player.eye) : 0,
      outcome: 'unresolved',
      timeToKill: null,
      enemyReaction: null,
      playerShotsFired: 0,
      playerHits: 0,
      playerHeadshots: 0,
      damageTaken: 0,
      killedFromUnseen: track.contactAt === null,
    }
    track.engagement = eng
    this.engagements.push(eng)
    return eng
  }

  private closeEngagement(track: EnemyTrack): void {
    track.engagement = null
    track.firstPlayerHitAt = null
    track.firstShotAt = null
  }

  private countContacts(): number {
    let n = 0
    for (const track of this.tracks.values()) if (track.contactAt !== null) n++
    return n
  }

  private awarenessDuration(id: number): number | null {
    const track = this.tracks.get(id)
    return track?.contactAt === null || track?.contactAt === undefined ? null : this.t - track.contactAt
  }

  private nearestContactEnemy(): Damageable | null {
    const player = this.ctx.services.player
    if (!player) return null
    let best: Damageable | null = null
    let bestD = Infinity
    for (const track of this.tracks.values()) {
      const e = this.ctx.entities.get(track.id)
      if (!e || !e.alive) continue
      const d = e.position.distanceTo(player.eye)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  private nearestOpenEngagement(): Engagement | null {
    const player = this.ctx.services.player
    if (!player) return null
    let best: Engagement | null = null
    let bestD = Infinity
    for (const track of this.tracks.values()) {
      if (!track.engagement) continue
      const e = this.ctx.entities.get(track.id)
      if (!e) continue
      const d = e.position.distanceTo(player.eye)
      if (d < bestD) { bestD = d; best = track.engagement }
    }
    return best
  }

  private stats(xs: number[]): { mean: number | null; min: number | null; max: number | null } {
    if (xs.length === 0) return { mean: null, min: null, max: null }
    return {
      mean: xs.reduce((a, b) => a + b, 0) / xs.length,
      min: Math.min(...xs),
      max: Math.max(...xs),
    }
  }

  report(): TelemetryReport {
    const ttk = this.engagements.map((e) => e.timeToKill).filter((x): x is number => x !== null)
    const reaction = this.engagements.map((e) => e.enemyReaction).filter((x): x is number => x !== null)
    const dist = this.engagements.map((e) => e.openingDistance).filter((d) => d > 0)

    const ordered = [...this.engagements].sort((a, b) => a.startedAt - b.startedAt)
    const gaps: number[] = []
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i].startedAt - ordered[i - 1].endedAt
      if (gap > 0) gaps.push(gap)
    }

    const d = Math.max(this.t, 1e-6)
    return {
      seed: this.ctx.config.seed,
      scenario: this.ctx.config.bot ?? 'none',
      skill: this.ctx.config.botSkill,
      duration: this.t,

      shotsFired: this.shotsFired,
      shotsHit: this.shotsHit,
      accuracy: this.shotsFired ? this.shotsHit / this.shotsFired : 0,
      headshots: this.headshots,
      headshotRate: this.shotsHit ? this.headshots / this.shotsHit : 0,
      kills: this.kills,
      deaths: this.deaths.length,
      damageDealt: this.damageDealt,
      damageTaken: this.damageTaken,

      timeToKill: { ...this.stats(ttk), samples: ttk },
      enemyReaction: { ...this.stats(reaction), samples: reaction },
      engagementDistance: this.stats(dist),

      engagements: this.engagements,
      downtime: { mean: this.stats(gaps).mean, max: this.stats(gaps).max, samples: gaps },
      timeToFirstContact: this.firstContactAt,
      idleFraction: this.noContactTime / d,

      distanceTravelled: this.distanceTravelled,
      fractionSprinting: this.sprintTime / d,
      fractionAds: this.adsTime / d,
      fractionCrouched: this.crouchTime / d,
      fractionStationary: this.stationaryTime / d,
      reloads: this.reloads,
      dryFires: this.dryFires,
      weaponSwaps: this.weaponSwaps,

      deaths_detail: this.deaths,
      unseenDeaths: this.deaths.filter((x) => x.awareFor === null).length,

      pacing: this.pacing,
    }
  }
}
