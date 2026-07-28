import * as THREE from 'three'
import { Rand } from '../core/Rand'
import type { Damageable, GameContext, HudService, System } from '../core/Types'
import { callsign } from '../game/Callsigns'
import { getMatchService, type MatchPhase, type MatchService, type MatchState } from '../game/Match'
import { BANNER_SECONDS, WAVES } from '../game/MatchDefs'
import { AmmoPanel } from './Ammo'
import { Compass, type CompassMarker } from './Compass'
import { Crosshair, type HitKind } from './Crosshair'
import { BloodOverlay, DamageIndicators, MessageToast, Prompts, SprintArc, StatsOverlay } from './Indicators'
import { Killfeed, type Side } from './Killfeed'
import { AwardStack, ScorePanel, WaveBanner, pad2 } from './MatchHud'
import { Menus } from './Menus'
import { Minimap, type Contact } from './Minimap'
import { clamp, damp, el, installStyles, toggleClass } from './Style'

/** Seconds an enemy stays on the map after firing. */
const CONTACT_LIFE = 3.2
const MAX_CONTACTS = 16
/** Two calls describing the same event within this window are one event. */
const DEDUPE = 0.06

interface Blip {
  x: number
  z: number
  born: number
  live: boolean
}

/**
 * Heads-up display and menus: reticle, hitmarkers, ammunition, damage
 * feedback, compass, minimap, killfeed and the start / pause / settings /
 * death screens.
 *
 * The whole layer is DOM + CSS with canvases only where they earn it (the
 * minimap and the compass ruler). Per-frame work is limited to `transform`
 * and `opacity` writes that are skipped when the quantised value has not
 * changed, so the HUD never shows up in a frame-time profile.
 */
export class HudSystem implements System, HudService {
  readonly name = 'hud'

  private root!: HTMLDivElement
  private crosshair!: Crosshair
  private ammo!: AmmoPanel
  private compass!: Compass
  private minimap!: Minimap
  private feed!: Killfeed
  private damageArcs!: DamageIndicators
  private blood!: BloodOverlay
  private sprint!: SprintArc
  private prompts!: Prompts
  private toast!: MessageToast
  private stats!: StatsOverlay
  private menus!: Menus
  private scorePanel!: ScorePanel
  private awards!: AwardStack
  private banner!: WaveBanner

  private ctx!: GameContext
  private scale = 1
  private dpr = 1

  private blips: Blip[] = []
  private contacts: Contact[] = []
  private markers: CompassMarker[] = []
  private contactCount = 0
  private markerCount = 0

  private objective = new THREE.Vector3()
  private tmp = new THREE.Vector3()
  /** Deterministic timeline used only by fixed-pose captures. */
  private pending: { at: number; run: () => void }[] = []

  private bloom = 0
  private spreadPx = 6
  private health = 1
  private healthDriven = false
  private kills = 0
  private lastHitAt = -99
  private lastDirAt = -99
  private weaponName = ''
  private ammoDriven = false

  /**
   * The match layer, resolved lazily: it publishes itself during its own init
   * and may be registered after this system, so it cannot be read here at init
   * time. Everything below degrades to the pre-match HUD when it is absent.
   */
  private match: MatchService | undefined
  private lastPhase: MatchPhase | '' = ''
  private lastWave = -1
  private lastHostiles = -1
  private lastCountdown = -1
  /** True between a win or a loss and the next deploy. */
  private finished = false

  private started = false
  private paused = false
  private dead = false
  private announceStart = false
  private lastFrameStamp = 0
  private frameMs = 16
  private lockRetry = 0

  private offs: (() => void)[] = []

  init(ctx: GameContext): void {
    this.ctx = ctx
    installStyles()

    this.root = document.createElement('div')
    this.root.id = 'cod-hud'
    document.body.appendChild(this.root)

    this.blood = new BloodOverlay(this.root, ctx.config.seed)
    this.minimap = new Minimap(this.root)
    this.compass = new Compass(this.root)
    this.feed = new Killfeed(this.root)
    this.ammo = new AmmoPanel(this.root)
    this.prompts = new Prompts(this.root)
    this.toast = new MessageToast(this.root)
    this.stats = new StatsOverlay(this.root)
    this.scorePanel = new ScorePanel(this.root)
    this.awards = new AwardStack(this.root)
    this.banner = new WaveBanner(this.root)

    const centre = el('div', 'center', this.root)
    this.damageArcs = new DamageIndicators(centre)
    this.sprint = new SprintArc(centre)
    this.crosshair = new Crosshair(centre)

    for (let i = 0; i < MAX_CONTACTS; i++) {
      this.blips.push({ x: 0, z: 0, born: -99, live: false })
      this.contacts.push({ x: 0, z: 0, strength: 0 })
      this.markers.push({ bearing: 0, kind: 'enemy', strength: 0 })
    }
    this.markers.push({ bearing: 0, kind: 'objective', strength: 0.9 })

    const level = ctx.services.level
    if (level) {
      level.bounds.getCenter(this.objective)
      const physics = ctx.services.physics
      if (physics) this.minimap.bake(physics, level.bounds)
    }

    this.menus = new Menus(ctx, {
      onDeploy: () => this.beginPlay(),
      onResume: () => this.resume(),
      onQuit: () => this.quitToMenu(),
      onRespawn: () => this.respawn(),
      onRestart: () => this.restartMatch(),
    })

    this.stats.setEnabled(ctx.config.stats)
    this.weaponName = ctx.services.weapons?.currentName ?? 'M4A1'
    this.ammo.setWeapon(this.weaponName)

    this.bindEvents()
    this.layout(window.innerWidth, window.innerHeight)

    if (ctx.config.autoStart) {
      this.started = true
      this.announceStart = true
      this.menus.show('none')
    } else {
      this.menus.show('start')
      ctx.input.enabled = false
    }
    if (ctx.config.pose) this.seedCaptureState()

    ctx.services.hud = this
  }

  // --- lifecycle -----------------------------------------------------------

  private bindEvents(): void {
    const { events } = this.ctx

    this.offs.push(events.on('weapon:ammo', ({ mag, reserve }) => {
      this.ammoDriven = true
      this.ammo.setAmmo(mag, reserve, this.ctx.elapsed)
    }))
    this.offs.push(events.on('weapon:switch', ({ to }) => this.setWeaponName(to)))
    this.offs.push(events.on('weapon:dryFire', () => {
      this.ammo.setAmmo(0, this.ammo.reserveRounds, this.ctx.elapsed)
    }))
    this.offs.push(events.on('weapon:fired', ({ origin }) => this.onShot(origin)))

    this.offs.push(events.on('damage:dealt', ({ target, hit }) => {
      if (target.team !== 'enemy' || !target.alive) return
      if (this.ctx.elapsed - this.lastHitAt < DEDUPE) return
      this.hitmarker(hit.region === 'head' ? 'headshot' : 'normal')
    }))

    this.offs.push(events.on('entity:killed', ({ entity, byPlayer, weapon, headshot }) => {
      if (byPlayer) {
        this.kills++
        // The match layer owns the objective line when it is present; this is
        // the standalone fallback so the HUD still reads correctly without it.
        if (!this.match) this.compass.setScore(`${pad2(this.kills)} / 12`)
        this.hitmarker('kill')
      }
      const victimSide: Side = entity.team === 'player' ? 'friendly' : 'enemy'
      const killerSide: Side = byPlayer ? 'you' : victimSide === 'enemy' ? 'friendly' : 'enemy'
      this.feed.add(
        byPlayer ? 'YOU' : callsign(killerSide, entity.id + 3),
        callsign(victimSide, entity.id),
        weapon || this.weaponName,
        headshot,
        killerSide,
        victimSide,
        this.ctx.elapsed,
      )
    }))

    this.offs.push(events.on('player:damaged', ({ amount, fromDirection }) => {
      this.blood.hit(amount)
      if (this.ctx.elapsed - this.lastDirAt < DEDUPE) return
      this.damageDirection(fromDirection)
    }))

    this.offs.push(events.on('player:died', () => this.onDeath()))
    this.offs.push(events.on('player:respawn', () => {
      this.dead = false
      this.health = 1
      this.healthDriven = false
      this.damageArcs.clear()
      if (this.menus.current === 'death') this.beginPlay()
    }))

    window.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('pointerlockchange', this.onLockChange)
    this.ctx.renderer.domElement.addEventListener('mousedown', this.onCanvasDown)
  }

  /** Clicking the world re-captures the mouse after a failed or lost lock. */
  private onCanvasDown = (): void => {
    if (!this.started || this.paused || this.dead || this.finished) return
    if (!document.pointerLockElement) this.requestLock()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      if (!this.started || this.dead || this.finished) return
      if (this.menus.current === 'settings') this.menus.back()
      else if (this.paused) this.resume()
      else this.pause()
      return
    }
    if (!this.started && (e.code === 'Enter' || e.code === 'Space') && this.menus.current === 'start') {
      e.preventDefault()
      this.beginPlay()
    }
  }

  /** Losing the pointer lock mid-fight means the player hit Escape or alt-tabbed. */
  private onLockChange = (): void => {
    if (!this.started || this.dead || this.finished) return
    if (!document.pointerLockElement && !this.menus.isOpen) this.pause()
  }

  private beginPlay(): void {
    this.started = true
    this.paused = false
    this.dead = false
    this.finished = false
    this.menus.show('none')
    this.ctx.input.enabled = true
    this.requestLock()
    this.announceStart = true
    this.ctx.events.emit('game:pause', { paused: false })
  }

  private pause(): void {
    if (this.paused) return
    this.paused = true
    this.menus.show('pause')
    this.ctx.input.enabled = false
    this.ctx.input.exitLock()
    this.ctx.events.emit('game:pause', { paused: true })
  }

  private resume(): void {
    this.paused = false
    this.menus.show('none')
    this.ctx.input.enabled = true
    this.requestLock()
    this.ctx.events.emit('game:pause', { paused: false })
  }

  private quitToMenu(): void {
    this.paused = false
    this.started = false
    this.finished = false
    this.match?.abandon()
    this.resetMatchHud()
    this.menus.show('start')
    this.ctx.input.enabled = false
    this.ctx.input.exitLock()
    this.ctx.events.emit('game:pause', { paused: true })
  }

  private onDeath(): void {
    this.dead = true
    this.health = 0

    // Charge the life before reading the phase: this is the one call that can
    // turn a death into the end of the match, and it is idempotent, so it does
    // not matter whether the director's own listener got here first.
    const match = this.match
    match?.reportPlayerDeath()
    if (match && match.state.phase === 'defeat') {
      this.showEnd(match)
      return
    }

    this.menus.setDeathCause(this.deathCause(match?.state))
    this.menus.show('death')
    this.ctx.input.enabled = false
    this.ctx.input.exitLock()
  }

  /**
   * What the death screen says. The full attribution — who, at what range,
   * how far you got — belongs on the mission-failed screen; between redeploys
   * the player only needs to know how much rope they have left.
   */
  private deathCause(state: MatchState | undefined): string {
    const killer = this.nearestEnemy()
    const who = killer ? callsign('enemy', killer.id) : 'ENEMY CONTACT'
    if (!state || !Number.isFinite(state.livesMax)) return `${who} — SECTOR 07`
    const left = Math.max(0, state.livesLeft)
    return `${who} — WAVE ${state.wave} — ${left} REINFORCEMENT${left === 1 ? '' : 'S'} LEFT`
  }

  /** Nearest hostile still standing: the best available guess at the killer. */
  private nearestEnemy(): Damageable | null {
    const ai = this.ctx.services.ai
    const player = this.ctx.services.player
    if (!ai || !player) return null
    let best: Damageable | null = null
    let bestD = Infinity
    for (const e of ai.enemies) {
      if (!e.alive) continue
      const d = e.position.distanceToSquared(player.eye)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  /** The `player:respawn` handler owns the UI side, so both paths agree. */
  private respawn(): void {
    this.ctx.events.emit('player:respawn', {})
  }

  // --- match layer ---------------------------------------------------------

  private showEnd(match: MatchService): void {
    if (this.finished) return
    this.finished = true
    this.banner.hide()
    this.awards.reset()
    this.ctx.input.enabled = false
    this.ctx.input.exitLock()
    const summary = match.summary()
    if (summary) this.menus.showResult(summary)
    else this.menus.show(match.state.phase === 'victory' ? 'victory' : 'defeat')
  }

  private restartMatch(): void {
    this.finished = false
    this.dead = false
    this.health = 1
    this.healthDriven = false
    this.kills = 0
    this.damageArcs.clear()
    this.resetMatchHud()
    this.match?.restart()
    this.ctx.events.emit('player:respawn', {})
    this.beginPlay()
  }

  private resetMatchHud(): void {
    this.banner.hide()
    this.awards.reset()
    this.scorePanel.reset()
    this.lastPhase = ''
    this.lastWave = -1
    this.lastHostiles = -1
    this.lastCountdown = -1
  }

  /**
   * Wave and phase transitions, and the end screens. Runs even when the HUD is
   * hidden, because winning and losing are not display concerns.
   */
  private pollMatch(elapsed: number): void {
    const match = this.match
    if (!match) return
    const s = match.state
    if (s.phase === this.lastPhase && s.wave === this.lastWave) return
    const enteredPhase = s.phase !== this.lastPhase
    this.lastPhase = s.phase
    this.lastWave = s.wave
    this.lastHostiles = -1
    this.lastCountdown = -1

    if (s.phase === 'wave') {
      const def = WAVES[Math.min(Math.max(s.wave - 1, 0), WAVES.length - 1)]
      const last = s.wave >= s.waveCount
      this.banner.show(
        `WAVE ${s.wave} OF ${s.waveCount}`,
        s.waveLabel,
        def.brief.toUpperCase(),
        elapsed,
        BANNER_SECONDS,
        last ? 'alert' : '',
      )
      return
    }
    if (s.phase === 'break') {
      // The banner is held for the whole break, counting down: this is the beat
      // where the player reloads, repositions and reads their score, and it
      // needs to be visibly a beat rather than an absence of enemies.
      this.banner.show(`WAVE ${s.wave} CLEARED`, 'REGROUP', 'STAND BY', elapsed, 0)
      return
    }
    this.banner.hide()
    if (enteredPhase && (s.phase === 'victory' || s.phase === 'defeat')) this.showEnd(match)
  }

  /**
   * Per-frame match readouts. Every string built here is guarded by the value
   * that produced it, so a steady frame allocates nothing.
   */
  private updateMatchHud(elapsed: number): void {
    const match = this.match
    if (!match) return
    const s = match.state

    if (s.phase === 'wave') {
      if (s.hostilesLeft !== this.lastHostiles) {
        this.lastHostiles = s.hostilesLeft
        this.compass.setObjective(`WAVE ${s.wave}/${s.waveCount} — ${s.waveLabel}`)
        this.compass.setScore(`${pad2(s.hostilesLeft)} LEFT`)
      }
    } else if (s.phase === 'break') {
      const tick = Math.ceil(s.breakLeft)
      if (tick !== this.lastCountdown) {
        this.lastCountdown = tick
        this.compass.setObjective('PLAZA HELD — REGROUP')
        this.compass.setScore(`NEXT ${pad2(tick)}`)
        this.banner.setSub(`NEXT WAVE IN ${tick}`)
      }
    } else if (s.phase === 'victory' && this.lastHostiles !== 0) {
      this.lastHostiles = 0
      this.compass.setObjective('PLAZA SECURED')
      this.compass.setScore(`${s.waveCount} / ${s.waveCount}`)
    }

    this.scorePanel.update(s, elapsed)
    this.awards.ingest(match.awards, match.awardSeq, elapsed)
    this.awards.update(elapsed)
    this.banner.update(elapsed)
  }

  /**
   * Chrome rejects a lock request made too soon after an Escape exit. Swallow
   * it and try once more rather than letting an unhandled rejection reach the
   * console — the capture harness treats a console error as a failed frame.
   */
  private requestLock(retry = true): void {
    const canvas = this.ctx.renderer.domElement
    try {
      const result = canvas.requestPointerLock() as unknown
      if (result instanceof Promise) result.catch(() => { if (retry) this.retryLock() })
    } catch {
      if (retry) this.retryLock()
    }
  }

  private retryLock(): void {
    window.clearTimeout(this.lockRetry)
    this.lockRetry = window.setTimeout(() => {
      if (this.started && !this.paused && !this.dead) this.requestLock(false)
    }, 1300)
  }

  // --- frame ---------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    if (this.announceStart) {
      this.announceStart = false
      ctx.events.emit('game:started', {})
    }

    const now = performance.now()
    if (this.lastFrameStamp > 0) this.frameMs += (now - this.lastFrameStamp - this.frameMs) * 0.1
    this.lastFrameStamp = now

    if (!this.match) this.match = getMatchService(ctx)
    this.pollMatch(ctx.elapsed)

    const hidden = ctx.config.hideHud
    toggleClass(this.root, 'hud-off', hidden)
    toggleClass(this.root, 'is-hidden', this.menus.isOpen)
    this.menus.update(ctx.elapsed)
    if (hidden) return

    const player = ctx.services.player
    const weapons = ctx.services.weapons
    const elapsed = ctx.elapsed

    const px = player ? player.position.x : ctx.camera.position.x
    const pz = player ? player.position.z : ctx.camera.position.z
    const yaw = player ? player.yaw : yawOf(ctx.camera)

    // --- reticle ---------------------------------------------------------
    const ads = weapons ? clamp(weapons.adsFraction, 0, 1) : 0
    this.bloom = damp(this.bloom, 0, 5.5, dt)
    const speed = player ? clamp(player.speedFraction, 0, 1.4) : 0
    const airborne = player ? !player.onGround : false
    const modelled =
      4.4 +
      speed * 9 +
      (airborne ? 8 : 0) -
      (player?.isCrouching ? 2.2 : 0) +
      this.bloom
    this.spreadPx = damp(this.spreadPx, clamp(this.coneToPixels(weapons) ?? modelled, 2.5, 46), 18, dt)
    this.crosshair.update(elapsed, this.spreadPx * (1 - ads * 0.4), ads, this.dead)

    // --- health ----------------------------------------------------------
    if (!this.healthDriven && player) this.health = clamp(player.health / 100, 0, 1)
    this.blood.update(dt, this.dead ? 0 : this.health)
    this.damageArcs.update(elapsed)
    this.sprint.update(dt, player?.isSprinting ?? false, staminaOf(player))

    // --- ammunition ------------------------------------------------------
    if (!this.ammoDriven) this.readAmmoFallback(weapons)
    const name = weapons?.currentName
    if (name && name !== this.weaponName) this.setWeaponName(name)
    this.ammo.setMode(fireModeOf(weapons))
    this.ammo.update(elapsed)
    this.prompts.update(
      elapsed,
      this.ammo.isLow && this.ammo.reserveRounds > 0,
      this.ammo.isEmpty,
      this.ammo.isLow,
      weapons?.isReloading ?? false,
    )
    this.toast.update(elapsed)

    // --- match, contacts, compass, minimap -------------------------------
    this.updateMatchHud(elapsed)
    this.feed.update(elapsed)
    this.gatherContacts(elapsed, px, pz)
    this.compass.update(headingOf(yaw), this.markers, this.markerCount)
    this.minimap.update(px, pz, yaw, this.contacts, this.contactCount)

    if (ctx.config.stats) {
      const info = ctx.renderer.info
      this.stats.update(dt, this.frameMs, info.render.calls, info.render.triangles, info.programs?.length ?? 0)
    }
  }

  /** Live enemy contacts feed both the minimap blips and the compass markers. */
  private gatherContacts(elapsed: number, px: number, pz: number): void {
    this.contactCount = 0
    this.markerCount = 0
    for (const b of this.blips) {
      if (!b.live) continue
      const age = elapsed - b.born
      if (age > CONTACT_LIFE) { b.live = false; continue }
      const strength = clamp(1 - Math.max(0, age - CONTACT_LIFE * 0.55) / (CONTACT_LIFE * 0.45), 0, 1)
      const c = this.contacts[this.contactCount++]
      c.x = b.x
      c.z = b.z
      c.strength = strength
      const m = this.markers[this.markerCount++]
      m.kind = 'enemy'
      m.strength = strength
      m.bearing = bearingTo(b.x - px, b.z - pz)
    }
    const obj = this.markers[this.markerCount++]
    obj.kind = 'objective'
    obj.strength = 0.9
    obj.bearing = bearingTo(this.objective.x - px, this.objective.z - pz)
  }

  private onShot(origin: THREE.Vector3): void {
    const camera = this.ctx.camera
    const fromPlayer = origin.distanceToSquared(camera.position) < 6.25
    if (fromPlayer) {
      this.bloom = Math.min(this.bloom + 3.2, 15)
      return
    }
    this.addContact(origin.x, origin.z, this.ctx.elapsed)
  }

  private addContact(x: number, z: number, elapsed: number): void {
    let slot: Blip | null = null
    for (const b of this.blips) {
      if (b.live && Math.abs(b.x - x) < 3 && Math.abs(b.z - z) < 3) { slot = b; break }
    }
    if (!slot) {
      let oldest = this.blips[0]
      for (const b of this.blips) {
        if (!b.live) { oldest = b; break }
        if (b.born < oldest.born) oldest = b
      }
      slot = oldest
    }
    slot.x = x
    slot.z = z
    slot.born = elapsed
    slot.live = true
  }

  /**
   * Prefers a real cone-of-fire angle if the weapon system publishes one,
   * projecting it through the camera exactly like the bullet spread it
   * represents. Falls back to a movement model otherwise.
   */
  private coneToPixels(weapons: unknown): number | null {
    const spread = (weapons as { spread?: number } | undefined)?.spread
    if (typeof spread !== 'number' || !isFinite(spread) || spread <= 0 || spread > 0.5) return null
    const half = THREE.MathUtils.degToRad(this.ctx.camera.fov) * 0.5
    const pixels = (Math.tan(spread) / Math.tan(half)) * (window.innerHeight * 0.5)
    return pixels / this.scale
  }

  private readAmmoFallback(weapons: unknown): void {
    const w = weapons as { mag?: number; reserve?: number } | undefined
    if (typeof w?.mag === 'number' && typeof w?.reserve === 'number') {
      this.ammo.setAmmo(w.mag, w.reserve, this.ctx.elapsed)
    }
  }

  /**
   * Populates the feed and the contact list for fixed-pose captures so the
   * interface is graded in the state it actually ships in. Deterministic: the
   * schedule is derived from the freeze time and the run seed.
   */
  private seedCaptureState(): void {
    const cfg = this.ctx.config
    const freeze = cfg.freezeAt ?? 2.5
    const rng = new Rand(cfg.seed ^ 0x4d21)
    this.kills = rng.int(4, 8)
    this.compass.setScore(`${pad2(this.kills)} / 12`)
    if (!this.ammoDriven) this.ammo.setAmmo(rng.int(14, 25), 120, 0)

    // The scoreboard is graded in these frames too, so it gets a plausible
    // seeded total rather than a zero the mission has not earned yet. Queued
    // rather than applied here: the director resets the board when the match
    // opens on the first frame, which is after this runs.
    const score = this.kills * 100 + rng.int(2, 7) * 50
    const streak = rng.int(0, 3)
    this.pending.push({ at: 0, run: () => getMatchService(this.ctx)?.seedCapture(score, this.kills, streak) })

    // Draws are taken here, not inside the closures, so the seeded feed does
    // not depend on the order `lateUpdate` happens to drain the queue.
    for (let i = 0; i < 3; i++) {
      const at = freeze - (3.4 - i * 1.35)
      const mine = i === 1
      const killerSide: Side = mine ? 'you' : 'friendly'
      const killer = mine ? 'YOU' : callsign('friendly', rng.int(0, 40))
      const victim = callsign('enemy', rng.int(0, 40))
      const headshot = rng.bool(0.35)
      this.pending.push({
        at,
        run: () => this.feed.add(
          killer, victim, this.weaponName, headshot, killerSide, 'enemy', Math.max(0, at),
        ),
      })
    }
    const level = this.ctx.services.level
    const centre = level ? level.bounds.getCenter(this.tmp) : this.tmp.set(0, 0, 0)
    const cx = centre.x
    const cz = centre.z
    for (let i = 0; i < 2; i++) {
      const at = freeze - 1.4 + i * 0.5
      const x = cx + rng.spread(14)
      const z = cz + rng.spread(14)
      this.pending.push({ at, run: () => this.addContact(x, z, Math.max(0, at)) })
    }
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    if (this.pending.length === 0) return
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (ctx.elapsed >= this.pending[i].at) {
        this.pending[i].run()
        this.pending.splice(i, 1)
      }
    }
  }

  resize(width: number, height: number): void {
    this.layout(width, height)
  }

  private layout(width: number, height: number): void {
    this.scale = clamp(Math.min(width / 1920, height / 1080), 0.6, 2.4)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.root.style.setProperty('--s', String(this.scale))
    this.menus.layout(this.scale)
    this.crosshair.layout(this.scale)
    this.awards.layout(this.scale)
    this.banner.layout(this.scale)
    this.compass.layout(this.scale, this.dpr)
    this.minimap.layout(this.scale, this.dpr)
  }

  // --- HudService ----------------------------------------------------------

  hitmarker(kind: HitKind): void {
    this.lastHitAt = this.ctx.elapsed
    this.crosshair.hitmarker(kind, this.ctx.elapsed)
  }

  killfeed(killer: string, victim: string, weapon: string, headshot: boolean): void {
    const mine = isPlayerName(killer)
    const killerSide: Side = mine ? 'you' : isPlayerName(victim) ? 'enemy' : 'friendly'
    const victimSide: Side = isPlayerName(victim) ? 'you' : 'enemy'
    this.feed.add(killer, victim, weapon, headshot, killerSide, victimSide, this.ctx.elapsed)
    if (mine) {
      this.kills++
      if (!this.match) this.compass.setScore(`${pad2(this.kills)} / 12`)
    }
  }

  damageDirection(worldDir: THREE.Vector3): void {
    this.lastDirAt = this.ctx.elapsed
    const player = this.ctx.services.player
    const yaw = player ? player.yaw : yawOf(this.ctx.camera)
    // `worldDir` points from the player toward whatever hurt them.
    const bearing = bearingTo(worldDir.x, worldDir.z) - headingOf(yaw)
    this.damageArcs.add(normaliseAngle(bearing), this.ctx.elapsed)
  }

  setAmmo(mag: number, reserve: number): void {
    this.ammoDriven = true
    this.ammo.setAmmo(mag, reserve, this.ctx.elapsed)
  }

  setWeaponName(name: string): void {
    this.weaponName = name
    this.ammo.setWeapon(name)
  }

  setHealth(fraction: number): void {
    this.healthDriven = true
    this.health = clamp(fraction, 0, 1)
  }

  showMessage(text: string, seconds = 2.5): void {
    this.toast.show(text.toUpperCase(), seconds, this.ctx.elapsed)
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.offs.length = 0
    window.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    this.ctx?.renderer.domElement.removeEventListener('mousedown', this.onCanvasDown)
    window.clearTimeout(this.lockRetry)
    this.menus?.dispose()
    this.root?.remove()
  }
}

/** Compass heading in degrees, where world -Z is north. */
function headingOf(yaw: number): number {
  return normalise360(-yaw * (180 / Math.PI))
}

/** World-space bearing of an offset, in degrees clockwise from north. */
function bearingTo(dx: number, dz: number): number {
  return normalise360(Math.atan2(dx, -dz) * (180 / Math.PI))
}

function normalise360(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

function normaliseAngle(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

function yawOf(camera: THREE.Object3D): number {
  return camera.rotation.y
}

function staminaOf(player: unknown): number | null {
  const s = (player as { stamina?: number } | undefined)?.stamina
  return typeof s === 'number' && isFinite(s) ? clamp(s, 0, 1) : null
}

function fireModeOf(weapons: unknown): string {
  const mode = (weapons as { fireMode?: string } | undefined)?.fireMode
  return typeof mode === 'string' && mode.length > 0 ? mode : 'AUTO'
}

function isPlayerName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'you' || n === 'player' || n === 'operator'
}

