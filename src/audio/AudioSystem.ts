import * as THREE from 'three'
import type {
  AudioService, GameContext, PlayOptions, Surface, System,
} from '../core/Types'
import { Rand } from '../core/Rand'
import { SoundBank, weaponClassOf, type SoundDef, type WeaponClass } from './SoundBank'
import { Mixer, type SpatialOptions } from './Mixer'

/**
 * Procedural audio: synthesis, spatialisation, reverb and mix automation.
 *
 * Three constraints shape this system. There are no audio files, so every
 * sound is built from noise and oscillators at runtime. Browsers refuse to
 * start an AudioContext without a user gesture, so nothing is created or
 * generated until the player clicks — which also means the screenshot harness,
 * where no gesture ever happens, pays exactly zero cost. And audio is never
 * load-bearing: every entry point is guarded so a missing or broken
 * AudioContext degrades to silence rather than blocking the boot.
 */
export class AudioSystem implements System, AudioService {
  readonly name = 'audio'

  private game: GameContext | null = null
  private actx: AudioContext | null = null
  private mixer: Mixer | null = null
  private bank: SoundBank | null = null
  private rand = new Rand(0x1337)

  private failed = false
  private failures = 0
  private headless = false
  private started = false
  private gestureBound = false
  private ambienceStarted = false

  private pending: SoundDef[] = []

  // Listener state. Driven from the camera unless a system pushes its own.
  private listenerPos = new THREE.Vector3(0, 1.68, 0)
  private listenerFwd = new THREE.Vector3(0, 0, -1)
  private listenerUp = new THREE.Vector3(0, 1, 0)
  private externalListener = false

  // Hoisted scratch — nothing in the update path allocates.
  private tmpDir = new THREE.Vector3()
  private tmpVec = new THREE.Vector3()
  private tmpVec2 = new THREE.Vector3()

  private occlusionBudget = 0
  private zoneTimer = 0
  private lastIndoors = false
  private tailPhase = 0
  private lastTailAt = -1
  private lastMag = 999

  private ambGunfire = 8
  private ambDog = 22
  private ambVehicle = 30
  private ambCreak = 17
  private burstLeft = 0
  private burstDelay = 0
  private burstClass: WeaponClass = 'rifle'
  private burstPos = new THREE.Vector3()

  // --- lifecycle ----------------------------------------------------------

  init(ctx: GameContext): void {
    // Register first: nothing below is allowed to stop another system from
    // finding the audio service.
    ctx.services.audio = this
    this.game = ctx
    this.rand = new Rand((ctx.config.seed ^ 0x51a7) >>> 0)

    // The capture harness drives a fixed pose with no user gesture. Audio
    // cannot start there, so do not spend a millisecond pretending it can.
    this.headless = ctx.config.pose !== null || ctx.config.freezeAt !== null

    try {
      this.subscribe(ctx)
      if (!this.headless) this.bindGestures()
    } catch (err) {
      this.fail(err)
    }
  }

  private bindGestures(): void {
    if (this.gestureBound || typeof window === 'undefined') return
    this.gestureBound = true
    for (const evt of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
      window.addEventListener(evt, this.onGesture, { passive: true })
    }
    // Some setups (a page the user already interacted with, or an autoplay
    // policy override) allow audio straight away.
    this.tryStart()
  }

  private onGesture = (): void => {
    this.tryStart()
    const actx = this.actx
    if (!actx) return
    if (actx.state !== 'running') {
      void actx.resume().catch(() => {})
    }
    if (actx.state === 'running') this.unbindGestures()
  }

  private unbindGestures(): void {
    if (!this.gestureBound || typeof window === 'undefined') return
    this.gestureBound = false
    for (const evt of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
      window.removeEventListener(evt, this.onGesture)
    }
  }

  /** Creates the context and mixer. Safe to call any number of times. */
  private tryStart(): void {
    if (this.actx || this.failed || this.headless) return
    try {
      const g = globalThis as unknown as {
        AudioContext?: typeof AudioContext
        webkitAudioContext?: typeof AudioContext
      }
      const Ctor = g.AudioContext ?? g.webkitAudioContext
      if (!Ctor) {
        this.failed = true
        return
      }
      const actx = new Ctor({ latencyHint: 'interactive' })
      const seed = this.game?.config.seed ?? 1337
      this.actx = actx
      this.mixer = new Mixer(actx, seed)
      this.bank = new SoundBank(actx.sampleRate, seed)
      this.applyQuality(this.game?.config.quality ?? 'high')
      if (actx.state !== 'running') void actx.resume().catch(() => {})
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Tolerates a few transient Web Audio errors before giving up. One bad call
   * should not silence the game, but a context that keeps throwing is worse
   * than no audio at all.
   */
  private fail(err: unknown): void {
    if (this.failures === 0) console.warn('[audio]', err)
    if (++this.failures < 8) return
    console.warn('[audio] disabled after repeated failures')
    this.failed = true
    this.mixer = null
    this.bank = null
    this.actx = null
  }

  private applyQuality(level: string): void {
    if (!this.mixer) return
    switch (level) {
      case 'low': this.mixer.setVoiceBudget(18, 10); break
      case 'medium': this.mixer.setVoiceBudget(28, 14); break
      case 'ultra': this.mixer.setVoiceBudget(48, 24); break
      default: this.mixer.setVoiceBudget(40, 20); break
    }
  }

  // --- frame --------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    if (this.failed || this.headless) return
    const actx = this.actx
    const mixer = this.mixer
    if (!actx || !mixer) return
    if (actx.state !== 'running') return

    if (this.gestureBound) this.unbindGestures()

    try {
      if (this.bank) {
        this.pending.length = 0
        this.bank.step(4, this.pending)
        for (const d of this.pending) mixer.register(d)
        this.pending.length = 0
        if (this.bank.complete) {
          this.bank = null
          mixer.buildComplete()
          this.started = true
        }
      }

      mixer.update(dt)
      this.occlusionBudget = 5

      if (dt > 0) {
        this.updateZone(dt, ctx)
        this.updateAmbience(dt)
      }
    } catch (err) {
      this.fail(err)
    }
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    const mixer = this.mixer
    if (!mixer || this.failed || this.actx?.state !== 'running') return
    try {
      if (!this.externalListener) {
        const cam = ctx.camera
        cam.getWorldPosition(this.listenerPos)
        cam.getWorldDirection(this.listenerFwd)
        this.listenerUp.set(0, 1, 0).applyQuaternion(cam.quaternion)
      }
      this.externalListener = false
      mixer.setListener(
        this.listenerPos.x, this.listenerPos.y, this.listenerPos.z,
        this.listenerFwd.x, this.listenerFwd.y, this.listenerFwd.z,
        this.listenerUp.x, this.listenerUp.y, this.listenerUp.z,
      )
    } catch (err) {
      this.fail(err)
    }
  }

  // --- AudioService -------------------------------------------------------

  play(id: string, position?: THREE.Vector3, opts?: PlayOptions): void {
    if (!this.mixer) return
    try {
      if (position) this.playAt(id, position, opts)
      else this.mixer.play2D(id, opts ?? {})
    } catch (err) {
      this.fail(err)
    }
  }

  play2D(id: string, opts?: PlayOptions): void {
    if (!this.mixer) return
    try {
      this.mixer.play2D(id, opts ?? {})
    } catch (err) {
      this.fail(err)
    }
  }

  setListener(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    this.listenerPos.copy(position)
    this.listenerFwd.copy(forward)
    this.listenerUp.copy(up)
    this.externalListener = true
  }

  duck(amount: number, seconds: number): void {
    this.mixer?.duck(amount, seconds)
  }

  setReverbZone(zone: 'outdoor' | 'indoor' | 'tunnel' | 'hall'): void {
    this.mixer?.setZone(zone)
  }

  // --- spatial helpers ----------------------------------------------------

  /**
   * Positional playback with occlusion. A wall between the listener and the
   * source drops the level and strips the top end — the cue that tells you a
   * firefight is on the far side of a building rather than in front of you.
   */
  private playAt(id: string, position: THREE.Vector3, opts?: SpatialOptions): void {
    const mixer = this.mixer
    if (!mixer) return
    const dist = mixer.listenerDistance(position.x, position.y, position.z)

    let lowpass = opts?.lowpass ?? 22050
    let attenuation = opts?.attenuation ?? 1
    if (dist > 4 && this.occlusionBudget > 0 && !opts?.immediate) {
      this.occlusionBudget--
      if (this.isOccluded(position, dist)) {
        lowpass = Math.min(lowpass, 560)
        attenuation *= 0.42
      }
    }

    if (opts) {
      mixer.play(id, position.x, position.y, position.z, {
        ...opts, lowpass, attenuation,
      })
    } else {
      mixer.play(id, position.x, position.y, position.z, { lowpass, attenuation })
    }
  }

  private isOccluded(position: THREE.Vector3, dist: number): boolean {
    const physics = this.game?.services.physics
    if (!physics || dist < 1) return false
    this.tmpDir.copy(position).sub(this.listenerPos).divideScalar(dist)
    const hit = physics.raycast(this.listenerPos, this.tmpDir, dist - 0.3, { characters: false })
    return hit !== null
  }

  // --- events -------------------------------------------------------------

  private subscribe(ctx: GameContext): void {
    const events = ctx.events

    events.on('weapon:fired', (e) => this.onWeaponFired(e.weapon, e.origin, e.direction, e.loud))

    events.on('weapon:hit', (hit) => {
      if (!this.mixer) return
      this.playAt(`impact.${hit.surface}`, hit.point)
      // A shallow strike on something hard sends the round singing away.
      const grazing = Math.abs(hit.direction.dot(hit.normal)) < 0.55
      if (grazing && RICOCHET_SURFACES.has(hit.surface) && this.rand.bool(0.4)) {
        this.playAt('ricochet', hit.point, { delay: 0.01, volume: this.rand.range(0.5, 1) })
      }
    })

    events.on('weapon:reload', (e) => {
      switch (e.phase) {
        case 'start': this.play2D('weapon.magRelease'); break
        case 'magOut': this.play2D('weapon.magOut'); break
        case 'magIn': this.play2D('weapon.magIn'); break
        case 'end': this.play2D('weapon.bolt'); break
      }
    })

    events.on('weapon:switch', () => {
      this.play2D('weapon.lower')
      this.mixer?.play2D('weapon.raise', { delay: 0.3 })
    })

    events.on('weapon:dryFire', () => this.play2D('weapon.dryFire'))

    events.on('weapon:ammo', (e) => {
      if (e.mag < this.lastMag && e.mag > 0 && e.mag <= 5) this.play2D('ui.lowAmmo')
      this.lastMag = e.mag
    })

    events.on('damage:dealt', (e) => {
      if (e.target.team !== 'enemy') return
      this.play2D(e.hit.region === 'head' ? 'ui.headshot' : 'ui.hitmarker')
      if (e.hit.surface === 'flesh' && this.rand.bool(0.35)) {
        this.playAt('enemy.hurt', e.hit.point, { volume: 0.7 })
      }
    })

    events.on('entity:killed', (e) => {
      this.playAt('body.fall', e.entity.position, { delay: 0.4 })
      if (e.byPlayer) this.play2D('ui.kill')
    })

    events.on('player:damaged', () => {
      this.play2D('player.hurt', { volume: this.rand.range(0.8, 1) })
      this.mixer?.duck(0.3, 0.7)
    })

    events.on('player:died', () => {
      this.play2D('player.death')
      this.mixer?.duck(0.85, 3)
      this.mixer?.deafen(0.45, 6)
    })

    events.on('player:respawn', () => {
      this.lastMag = 999
    })

    events.on('player:footstep', (e) => {
      const id = `foot.${e.surface}.${e.running ? 'run' : 'walk'}`
      const d = this.listenerPos.distanceTo(e.position)
      // The player's own boots are not a point source three metres away.
      if (d < 1.8) this.play2D(id, { volume: e.running ? 0.55 : 0.4 })
      else this.playAt(id, e.position)
    })

    events.on('player:land', (e) => {
      const hard = e.impact > 0.55
      const d = this.listenerPos.distanceTo(e.position)
      const id = hard ? 'foot.land.hard' : 'foot.land.soft'
      if (d < 1.8) this.play2D(id, { volume: Math.min(1, 0.4 + e.impact * 0.7) })
      else this.playAt(id, e.position, { volume: Math.min(1, 0.4 + e.impact * 0.7) })
    })

    events.on('fx:explosion', (e) => this.onExplosion(e.point, e.radius))

    events.on('game:pause', (e) => this.mixer?.setPaused(e.paused))

    events.on('game:started', () => {
      this.tryStart()
      void this.actx?.resume().catch(() => {})
    })

    events.on('quality:changed', (e) => this.applyQuality(e.level))
  }

  private onWeaponFired(weapon: string, origin: THREE.Vector3, direction: THREE.Vector3, loud: boolean): void {
    const mixer = this.mixer
    if (!mixer) return
    const cls = weaponClassOf(weapon)
    const dist = mixer.listenerDistance(origin.x, origin.y, origin.z)

    mixer.sidechain(dist < 30 ? 1 : 0.5)

    if (!loud) {
      if (dist < 2.5) this.play2D('weapon.suppressed')
      else this.playAt('weapon.suppressed', origin)
      return
    }

    if (dist < 2.5) {
      // First person: dry, close and centred, with the room supplied by real
      // reflections cast against the level geometry.
      mixer.play2D(`weapon.${cls}.fire`, { volume: 1 })
      this.castShotReflection(cls)
    } else if (dist > 90) {
      this.playAt(`weapon.${cls}.distant`, origin)
    } else {
      this.playAt(`weapon.${cls}.fire`, origin)
      if (dist > 30) this.playAt(`weapon.${cls}.distant`, origin, { volume: 0.5, delay: 0.02 })
      this.maybeWhizby(origin, direction, dist)
    }
  }

  /**
   * Casts a ray at a nearby surface and plays a filtered copy of the shot from
   * where it lands, delayed by the round trip. Firing down an alley therefore
   * slaps off the walls, and firing in the open does not — which is the whole
   * point.
   */
  private castShotReflection(cls: WeaponClass): void {
    const mixer = this.mixer
    const physics = this.game?.services.physics
    if (!mixer || !physics) return
    const now = this.game?.elapsed ?? 0
    if (now - this.lastTailAt < 0.07) return
    this.lastTailAt = now

    const yaw = Math.atan2(this.listenerFwd.x, this.listenerFwd.z)
    const az = TAIL_AZIMUTHS[this.tailPhase++ % TAIL_AZIMUTHS.length]
    const a = yaw + az
    this.tmpDir.set(Math.sin(a), -0.05, Math.cos(a)).normalize()
    const hit = physics.raycast(this.listenerPos, this.tmpDir, 55, { characters: false })
    if (!hit) return

    const heavy = cls === 'sniper' || cls === 'shotgun' || cls === 'lmg'
    const d = hit.distance
    this.playAt(heavy ? 'weapon.tail.heavy' : 'weapon.tail.light', hit.point, {
      // Out to the wall and back again, hence twice the distance.
      delay: (2 * d) / 343,
      volume: Math.min(1, 22 / (8 + d)),
      immediate: true,
    })
  }

  /** A round that passes close enough to hear it go by. */
  private maybeWhizby(origin: THREE.Vector3, direction: THREE.Vector3, dist: number): void {
    this.tmpVec.copy(this.listenerPos).sub(origin)
    const along = this.tmpVec.dot(direction)
    if (along < 3 || along > dist + 120) return
    this.tmpVec2.copy(direction).multiplyScalar(along).add(origin)
    const miss = this.tmpVec2.distanceTo(this.listenerPos)
    if (miss > 3) return
    const flight = along / 820
    this.playAt('whizby', this.tmpVec2, { delay: flight, immediate: true, volume: 1 - miss / 4 })
    if (miss < 1.6) {
      this.playAt('crack.supersonic', this.tmpVec2, { delay: flight, immediate: true, volume: 1 - miss / 2.2 })
    }
  }

  private onExplosion(point: THREE.Vector3, radius: number): void {
    const mixer = this.mixer
    if (!mixer) return
    const d = mixer.listenerDistance(point.x, point.y, point.z)
    const big = radius > 6
    this.playAt(big ? 'explosion.large' : 'explosion.grenade', point, { immediate: d < 6 })
    this.playAt('debris.rain', point, { delay: 0.35 + d / 343, volume: 0.8 })
    mixer.duck(Math.max(0, 1 - d / 45), 2.6)
    mixer.sidechain(1)
    // Overpressure. Close enough and the world goes muffled and rings.
    const deafRange = radius * 2.2 + 6
    if (d < deafRange) {
      mixer.deafen(Math.pow(1 - d / deafRange, 0.7), 4.5)
    }
  }

  // --- ambience -----------------------------------------------------------

  private updateZone(dt: number, ctx: GameContext): void {
    this.zoneTimer -= dt
    if (this.zoneTimer > 0) return
    this.zoneTimer = 0.35
    const level = ctx.services.level
    if (!level) return
    const indoors = level.isIndoors(this.listenerPos)
    if (indoors === this.lastIndoors) return
    this.lastIndoors = indoors
    // Crossfade rather than cut; a hard reverb switch is instantly noticeable.
    this.mixer?.setZone(indoors ? 'indoor' : 'outdoor', 0.9)
  }

  private updateAmbience(dt: number): void {
    const mixer = this.mixer
    if (!mixer) return

    if (!this.ambienceStarted && this.started) {
      this.ambienceStarted = true
      mixer.startLoop('amb.wind', 1)
      mixer.startLoop('amb.city', 1)
    }
    if (!this.started) return

    // A burst of distant gunfire in progress.
    if (this.burstLeft > 0) {
      this.burstDelay -= dt
      if (this.burstDelay <= 0) {
        this.burstLeft--
        this.burstDelay = this.rand.range(0.07, 0.16)
        this.playAt(`weapon.${this.burstClass}.distant`, this.burstPos, {
          volume: this.rand.range(0.6, 1),
          immediate: false,
        })
      }
    }

    this.ambGunfire -= dt
    if (this.ambGunfire <= 0) {
      this.ambGunfire = this.rand.range(7, 21)
      this.burstClass = this.rand.pick(['rifle', 'smg', 'lmg'] as const)
      this.burstLeft = this.rand.int(2, 7)
      this.burstDelay = 0
      this.placeAround(this.burstPos, 95, 240, 1.5, 9)
    }

    this.ambDog -= dt
    if (this.ambDog <= 0) {
      this.ambDog = this.rand.range(18, 55)
      this.placeAround(this.tmpVec, 45, 130, 0.6, 2)
      this.playAt('amb.dog', this.tmpVec)
    }

    this.ambVehicle -= dt
    if (this.ambVehicle <= 0) {
      this.ambVehicle = this.rand.range(26, 70)
      this.placeAround(this.tmpVec, 70, 170, 0.5, 2)
      this.playAt('amb.vehicle', this.tmpVec)
    }

    this.ambCreak -= dt
    if (this.ambCreak <= 0) {
      this.ambCreak = this.rand.range(12, 34)
      this.placeAround(this.tmpVec, 7, 28, 2, 7)
      this.playAt('amb.creak', this.tmpVec)
    }
  }

  /** Random point on an annulus around the listener. */
  private placeAround(out: THREE.Vector3, minR: number, maxR: number, minY: number, maxY: number): void {
    const a = this.rand.next() * Math.PI * 2
    const r = this.rand.range(minR, maxR)
    out.set(
      this.listenerPos.x + Math.sin(a) * r,
      this.rand.range(minY, maxY),
      this.listenerPos.z + Math.cos(a) * r,
    )
  }

  // --- teardown -----------------------------------------------------------

  dispose(): void {
    this.unbindGestures()
    try {
      this.mixer?.dispose()
      void this.actx?.close().catch(() => {})
    } catch {
      // Nothing useful to do while tearing down.
    }
    this.mixer = null
    this.bank = null
    this.actx = null
  }
}

/** Directions probed for wall reflections, cycled shot to shot. */
const TAIL_AZIMUTHS = [
  Math.PI * 0.62, -Math.PI * 0.62, Math.PI, Math.PI * 0.28, -Math.PI * 0.28,
]

/** Surfaces hard enough to deflect a round rather than swallow it. */
const RICOCHET_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'concrete', 'metal', 'thinMetal', 'tile', 'gravel', 'plaster',
])
