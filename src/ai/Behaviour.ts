import * as THREE from 'three'
import type { GameContext, HitInfo } from '../core/Types'
import type { Rand } from '../core/Rand'
import type { PhysicsSystem } from '../physics/Physics'
import type { NavGrid, Steering } from './Navigation'
import type { Soldier } from './Soldier'

export type AiState =
  | 'idle' | 'patrol' | 'investigate' | 'engage' | 'seekCover'
  | 'suppress' | 'flank' | 'reload' | 'retreat' | 'dead'

/** Role handed down by the squad so the whole team does not do one thing. */
export type Role = 'hold' | 'suppress' | 'advance' | 'flank'

const DOWN = new THREE.Vector3(0, -1, 0)

const VIEW_RANGE = 55
/** Cosine of the vision half-angle before and after a soldier is alerted. */
const COS_FOV_CALM = Math.cos(1.05)
const COS_FOV_ALERT = Math.cos(1.65)

const PLAYER_RADIUS = 0.4

interface CoverSpot {
  pos: THREE.Vector3
  score: number
  /** Which way to lean out of it: +1, -1 or 0 for no firing line. */
  peek: number
}

/** Shared scratch — behaviour runs for every soldier every frame. */
const T1 = new THREE.Vector3()
const T2 = new THREE.Vector3()
const T3 = new THREE.Vector3()
const T4 = new THREE.Vector3()
const T5 = new THREE.Vector3()
const G1 = new THREE.Vector3()
const G2 = new THREE.Vector3()

export class Squad {
  members: Behaviour[] = []
  /** Rises while anyone has eyes on the player; drives group aggression. */
  alert = 0
  private roleTimer = 0
  private engagedTime = 0
  private ranked: Behaviour[] = []

  update(dt: number, playerPos: THREE.Vector3): void {
    let seeing = 0
    for (const m of this.members) if (m.soldier.alive && m.hasContact) seeing++

    this.alert = seeing > 0 ? Math.min(1, this.alert + dt * 1.5) : Math.max(0, this.alert - dt * 0.25)
    if (seeing > 0) this.engagedTime += dt

    this.assignFocus(playerPos)

    this.roleTimer -= dt
    if (this.roleTimer > 0) return
    this.roleTimer = 2.6

    // Order by distance so the closest soldiers press and the far ones shoot.
    this.ranked.length = 0
    for (const m of this.members) {
      if (m.soldier.alive && m.alerted) this.ranked.push(m)
      else if (m.soldier.alive) m.role = 'hold'
    }
    this.ranked.sort(
      (a, b) => a.soldier.position.distanceToSquared(playerPos) - b.soldier.position.distanceToSquared(playerPos),
    )

    // A firefight where everyone charges is chaos; one where nobody moves is a
    // diorama. One flanker, one or two closers, everyone else pinning.
    const maxAdvance = this.ranked.length >= 4 ? 2 : 1
    const allowFlank = this.ranked.length >= 3 && this.engagedTime > 3
    let advancing = 0
    let flanked = false
    for (let i = 0; i < this.ranked.length; i++) {
      const m = this.ranked[i]
      const dist = m.soldier.position.distanceTo(playerPos)
      if (allowFlank && !flanked && dist > 12 && i >= 1) {
        m.role = 'flank'
        flanked = true
      } else if (advancing < maxAdvance && dist > 9) {
        m.role = 'advance'
        advancing++
      } else {
        m.role = 'suppress'
      }
    }
  }

  /**
   * At most two soldiers shoot to hit at any moment; the rest walk their rounds
   * past the player. Six enemies all firing accurately kills the player in a
   * second and reads as unfair rather than intense, and this is the lever every
   * shooter actually pulls to control difficulty.
   */
  private assignFocus(playerPos: THREE.Vector3): void {
    let firstD = Infinity
    let secondD = Infinity
    let first: Behaviour | null = null
    let second: Behaviour | null = null
    for (const m of this.members) {
      m.focus = false
      if (!m.soldier.alive || !m.hasContact) continue
      const d = m.soldier.position.distanceToSquared(playerPos)
      if (d < firstD) {
        secondD = firstD
        second = first
        firstD = d
        first = m
      } else if (d < secondD) {
        secondD = d
        second = m
      }
    }
    if (first) first.focus = true
    if (second) second.focus = true
  }
}

export interface BehaviourDeps {
  ctx: GameContext
  physics: PhysicsSystem
  nav: NavGrid
  steering: Steering
  rng: Rand
  squad: Squad
}

export class Behaviour {
  state: AiState = 'idle'
  role: Role = 'hold'
  alerted = false
  hasContact = false
  /** Set by the squad: this soldier is currently allowed to shoot to hit. */
  focus = false

  /** Last position the player was seen or heard at. */
  lastKnown = new THREE.Vector3()
  private awareness = 0
  private timeInState = 0
  private losTimer = 0
  private losClear = false
  private contactTime = 0
  private lostTime = 99

  private path: THREE.Vector3[] = []
  private pathIndex = 0
  private repathTimer = 0
  private destination = new THREE.Vector3()
  private hasDestination = false
  private stuckTimer = 0
  private lastPos = new THREE.Vector3()

  private cover: CoverSpot | null = null
  private coverTimer = 0
  private inCover = false
  private peekTimer = 0
  private peeking = false

  private magazine = 30
  private burstLeft = 4
  private fireTimer = 0
  private burstPause = 0
  /** Cone half-angle in radians; tightens the longer a target is held. */
  private aimError = 0.11
  private suppressAim = new THREE.Vector3()

  private patrolTarget = new THREE.Vector3()
  private hasPatrol = false
  private idleLook = 0

  // Player state cached once per frame so tick methods never fight over scratch.
  private pPos = new THREE.Vector3()
  private pEye = new THREE.Vector3()
  private firePoint = new THREE.Vector3()

  constructor(readonly soldier: Soldier, private d: BehaviourDeps) {
    this.lastPos.copy(soldier.position)
    this.losTimer = d.rng.range(0, 0.12)
    this.lastKnown.copy(soldier.position)
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  private cachePlayer(): void {
    const p = this.d.ctx.services.player
    if (p) {
      this.pPos.copy(p.position)
      this.pEye.copy(p.eye)
      // Some player rigs report position at eye height; normalise to the feet.
      if (Math.abs(this.pPos.y - this.pEye.y) < 0.2) this.pPos.y = this.pEye.y - 1.62
    } else {
      this.pEye.copy(this.d.ctx.camera.position)
      this.pPos.set(this.pEye.x, this.pEye.y - 1.62, this.pEye.z)
    }
  }

  private updatePerception(dt: number): void {
    const s = this.soldier
    this.losTimer -= dt
    if (this.losTimer <= 0) {
      // Line of sight is the expensive part, so it runs at ~12 Hz with a
      // per-soldier phase offset rather than every frame for everyone.
      this.losTimer = 0.08
      T2.copy(this.pEye).sub(s.eye)
      const dist = T2.length()
      let visible = false
      if (dist < VIEW_RANGE && dist > 0.01) {
        T2.divideScalar(dist)
        T3.set(Math.sin(s.yaw), 0, Math.cos(s.yaw))
        const facing = T3.x * T2.x + T3.z * T2.z
        if (facing > (this.alerted ? COS_FOV_ALERT : COS_FOV_CALM)) {
          visible = !this.d.physics.raycast(s.eye, T2, dist - 0.25, { characters: false })
        }
      }
      this.losClear = visible
    }

    if (this.losClear) {
      this.lastKnown.copy(this.pEye)
      const dist = this.soldier.position.distanceTo(this.pEye)
      this.awareness = Math.min(1, this.awareness + dt * (this.alerted ? 6 : 1.6 + 30 / Math.max(6, dist)))
      this.contactTime += dt
      this.lostTime = 0
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.22)
      this.lostTime += dt
      if (this.lostTime > 1.2) this.contactTime = 0
    }
    const had = this.hasContact
    this.hasContact = this.losClear && this.awareness > 0.55
    if (this.awareness > 0.6) this.alerted = true
    else if (this.awareness <= 0.02 && this.lostTime > 12) this.alerted = false

    // Contact transitions are emitted so the play harness can measure reaction
    // time — the gap between a soldier acquiring the player and firing — rather
    // than estimate it. Both edges must fire exactly once per transition.
    if (this.hasContact !== had) {
      const p = this.d.ctx.services.player
      const dist = p ? this.soldier.position.distanceTo(p.eye) : 0
      if (this.hasContact) {
        this.contactAt = this.d.ctx.elapsed
        this.firedSinceContact = false
        this.d.ctx.events.emit('ai:contact', {
          id: this.soldier.id,
          position: this.soldier.position.clone(),
          distance: dist,
        })
      } else {
        this.d.ctx.events.emit('ai:lostContact', {
          id: this.soldier.id,
          heldFor: this.contactAt > 0 ? this.d.ctx.elapsed - this.contactAt : 0,
        })
      }
    }
  }

  /** Wall-clock time of the current contact, for reaction-time measurement. */
  private contactAt = 0
  private firedSinceContact = false

  /** Called by the firing path on the first shot of each contact. */
  protected noteShot(distance: number): void {
    if (this.firedSinceContact) return
    this.firedSinceContact = true
    this.d.ctx.events.emit('ai:engaged', {
      id: this.soldier.id,
      distance,
      sinceContact: this.contactAt > 0 ? this.d.ctx.elapsed - this.contactAt : 0,
    })
  }

  /** Gunfire and explosions; effect falls off with distance. */
  hearNoise(position: THREE.Vector3, radius: number): void {
    const d = this.soldier.position.distanceTo(position)
    if (d > radius) return
    const strength = 1 - d / radius
    this.awareness = Math.min(1, this.awareness + strength * 0.75)
    if (!this.losClear) this.lastKnown.copy(position)
    if (this.awareness > 0.5) this.alerted = true
  }

  /** Being shot is the loudest signal there is. */
  onDamaged(hit: HitInfo): void {
    this.alerted = true
    this.awareness = 1
    if (!this.losClear) {
      this.lastKnown.copy(hit.point).addScaledVector(hit.direction, -14)
      this.lastKnown.y += 1.4
    }
    // Flush a soldier out of cover that is clearly not protecting it.
    if (this.inCover && this.d.rng.bool(0.5)) {
      this.cover = null
      this.coverTimer = 0
      this.inCover = false
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private setDestination(p: THREE.Vector3, force = false): void {
    if (!force && this.hasDestination && this.destination.distanceToSquared(p) < 1.6) return
    this.destination.copy(p)
    this.hasDestination = true
    this.pathIndex = 0
    if (this.d.nav.findPath(this.soldier.position, p, this.path) === 0) {
      this.path.length = 0
      this.hasDestination = false
    }
  }

  private clearPath(): void {
    this.path.length = 0
    this.pathIndex = 0
    this.hasDestination = false
    this.soldier.moveSpeed = 0
    this.soldier.moveDir.set(0, 0, 0)
  }

  /** @returns true once the soldier has arrived or has nowhere to go. */
  private followPath(dt: number, speed: number): boolean {
    const s = this.soldier
    if (this.pathIndex >= this.path.length) {
      s.moveSpeed = 0
      return true
    }
    const wp = this.path[this.pathIndex]
    T1.set(wp.x - s.position.x, 0, wp.z - s.position.z)
    const dist = T1.length()
    const last = this.pathIndex === this.path.length - 1
    if (dist < (last ? 0.4 : 0.8)) {
      this.pathIndex++
      if (this.pathIndex >= this.path.length) {
        s.moveSpeed = 0
        return true
      }
      return false
    }
    T1.divideScalar(dist)
    // Neighbouring soldiers must not mirror each other into the same corner.
    this.d.steering.setBias(s.id % 2 === 0 ? 1 : -1)
    this.d.steering.avoid(s.eye, T1, T2)
    this.separate(T3)
    T2.add(T3)
    T2.y = 0
    if (T2.lengthSq() < 1e-6) T2.copy(T1)
    s.moveDir.copy(T2).normalize()
    // Ease off near the end so the soldier arrives rather than overshooting.
    s.moveSpeed = speed * (last ? Math.max(0.35, Math.min(1, dist / 1.2)) : 1)

    // A soldier wedged on geometry re-paths instead of grinding forever.
    if (s.position.distanceToSquared(this.lastPos) < 0.0004) {
      this.stuckTimer += dt
      if (this.stuckTimer > 0.7) {
        this.stuckTimer = 0
        this.setDestination(this.destination, true)
      }
    } else {
      this.stuckTimer = 0
      this.lastPos.copy(s.position)
    }
    return false
  }

  private separate(out: THREE.Vector3): void {
    out.set(0, 0, 0)
    for (const other of this.d.squad.members) {
      if (other === this || !other.soldier.alive) continue
      T4.copy(this.soldier.position).sub(other.soldier.position)
      T4.y = 0
      const d2 = T4.lengthSq()
      if (d2 > 1.7 || d2 < 1e-5) continue
      out.addScaledVector(T4.normalize(), (1.3 - Math.sqrt(d2)) * 0.9)
    }
  }

  // -------------------------------------------------------------------------
  // Cover
  // -------------------------------------------------------------------------

  /**
   * Scores nearby standable positions for cover. A good spot breaks the line
   * from the player to the soldier's chest *and* still lets the soldier lean
   * out onto the player — cover you cannot shoot from is just a corner to die
   * in, and AI that picks those looks broken.
   */
  private findCover(): CoverSpot | null {
    const { nav, physics, rng } = this.d
    const s = this.soldier
    let best: CoverSpot | null = null
    const wantRange = this.role === 'advance' ? 10 : 16

    for (let i = 0; i < 14; i++) {
      if (!nav.randomPointNear(s.position, 1.5, 11, rng, G1)) continue
      const distToPlayer = G1.distanceTo(this.pEye)
      if (distToPlayer < 5 || distToPlayer > 34) continue

      T2.set(G1.x, G1.y + 1.05, G1.z)
      T3.copy(this.pEye).sub(T2)
      const d = T3.length()
      if (d < 0.5) continue
      T3.divideScalar(d)
      if (!physics.raycast(T2, T3, d - 0.3, { characters: false })) continue

      // Peek test: step sideways and see whether a firing line opens up.
      let peekDir = 0
      for (const side of [1, -1]) {
        T5.set(T2.x - T3.z * side * 0.75, T2.y, T2.z + T3.x * side * 0.75)
        T4.copy(this.pEye).sub(T5)
        const pd = T4.length()
        T4.divideScalar(pd)
        if (!physics.raycast(T5, T4, pd - 0.3, { characters: false })) {
          peekDir = side
          break
        }
      }

      const rangeScore = 1 - Math.min(1, Math.abs(distToPlayer - wantRange) / 22)
      const travel = 1 - Math.min(1, s.position.distanceTo(G1) / 12)
      const score = (peekDir !== 0 ? 1.6 : 0.35) + rangeScore * 1.1 + travel * 0.7 - this.crowding(G1) * 1.2
      if (!best || score > best.score) best = { pos: G1.clone(), score, peek: peekDir }
    }
    return best
  }

  private crowding(p: THREE.Vector3): number {
    let c = 0
    for (const other of this.d.squad.members) {
      if (other === this || !other.soldier.alive || !other.cover) continue
      const d = other.cover.pos.distanceTo(p)
      if (d < 3) c += 1 - d / 3
    }
    return c
  }

  // -------------------------------------------------------------------------
  // Shooting
  // -------------------------------------------------------------------------

  private muzzleClear(): boolean {
    const s = this.soldier
    T1.copy(this.pEye).sub(s.muzzleWorld)
    const dist = T1.length()
    if (dist < 0.5 || dist > 65) return false
    T1.divideScalar(dist)
    return !this.d.physics.raycast(s.muzzleWorld, T1, dist - 0.4, { characters: false })
  }

  private fire(dt: number, target: THREE.Vector3): void {
    const s = this.soldier
    this.fireTimer -= dt
    if (this.burstPause > 0) {
      this.burstPause -= dt
      return
    }
    if (this.fireTimer > 0) return
    if (this.magazine <= 0) {
      this.enter('reload')
      return
    }

    const { ctx, physics, rng } = this.d
    this.firePoint.copy(target)
    this.fireTimer = 0.085 + rng.range(0, 0.02)
    this.magazine--
    this.burstLeft--
    s.fireVisuals()
    ctx.services.audio?.play('enemyFire', s.muzzleWorld, { volume: 0.85, maxDistance: 110 })

    // Aim at centre of mass, then push the shot into a cone. First contact is
    // deliberately loose: the player should hear rounds crack past before any
    // of them land, and soldiers the squad has not given focus to never stop
    // walking their rounds around the target.
    T1.copy(this.firePoint)
    T1.y += 0.95
    T2.copy(T1).sub(s.muzzleWorld)
    const dist = T2.length() || 1
    this.noteShot(dist)
    T2.divideScalar(dist)
    T3.set(-T2.z, 0, T2.x).normalize()
    T4.crossVectors(T2, T3).normalize()

    if (!this.focus) {
      // Deliberate near-miss: offset the point of aim by about a body width so
      // the tracer passes the player instead of being a coin flip.
      const off = 1.0 + rng.next() * 1.5
      const ang = rng.next() * Math.PI * 2
      T2.addScaledVector(T3, (Math.cos(ang) * off) / dist)
      T2.addScaledVector(T4, (Math.sin(ang) * off * 0.55) / dist)
      T2.normalize()
    }

    const settle = Math.min(1, this.contactTime / 3.2)
    const moving = Math.min(1, s.velocity.length() / 4)
    const spread = this.aimError * (2.0 - settle * 0.9) * (1 + moving * 0.8) * (s.stance === 'crouch' ? 0.8 : 1)
    const a = rng.next() * Math.PI * 2
    const r = Math.abs(rng.gaussian()) * spread * 0.8
    T2.addScaledVector(T3, Math.cos(a) * r).addScaledVector(T4, Math.sin(a) * r).normalize()

    const worldHit = physics.raycast(s.muzzleWorld, T2, 90, { characters: false })
    const wallDist = worldHit ? worldHit.distance : 90
    const playerDist = rayCapsule(s.muzzleWorld, T2, this.pPos, PLAYER_RADIUS)
    const hitPlayer = playerDist > 0 && playerDist < wallDist

    T5.copy(s.muzzleWorld).addScaledVector(T2, hitPlayer ? playerDist : wallDist)
    ctx.services.fx?.bulletTracer(s.muzzleWorld, T5, 340)

    if (hitPlayer) {
      T3.copy(T2).negate()
      ctx.events.emit('player:damaged', { amount: 5 + rng.range(0, 3.5), fromDirection: T3.clone() })
      if (rng.bool(0.3)) ctx.services.fx?.blood(T5, T3, 0.3)
    } else if (worldHit) {
      ctx.services.fx?.impact(worldHit.point, worldHit.normal, worldHit.surface)
    }

    if (this.burstLeft <= 0) {
      // Disciplined bursts with a real gap between them: rate of fire is the
      // other half of how lethal a squad is, and a continuous stream both
      // sounds wrong and leaves the player no window to move.
      this.burstLeft = rng.int(3, 5)
      this.burstPause = rng.range(0.6, 1.6) * (this.hasContact ? 0.85 : 1.5)
    }
  }

  /** Unaimed fire around the last known position, to pin the player down. */
  private suppressFire(dt: number): void {
    if (this.suppressAim.lengthSq() < 1e-6) this.suppressAim.copy(this.lastKnown)
    this.suppressAim.x += this.d.rng.spread(2.4) * dt
    this.suppressAim.z += this.d.rng.spread(2.4) * dt
    this.suppressAim.y = this.lastKnown.y - 1.4
    if (this.suppressAim.distanceToSquared(this.lastKnown) > 12) this.suppressAim.copy(this.lastKnown)
    this.fire(dt, this.suppressAim)
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private enter(next: AiState): void {
    if (this.state === next) return
    this.state = next
    this.timeInState = 0
    if (next !== 'engage' && next !== 'suppress') this.soldier.leanTarget = 0
    if (next === 'reload') this.soldier.startReload()
    if (next === 'seekCover' || next === 'flank' || next === 'retreat') this.clearPath()
  }

  update(dt: number): void {
    if (!this.soldier.alive) {
      this.state = 'dead'
      return
    }
    this.timeInState += dt
    this.cachePlayer()
    this.updatePerception(dt)

    this.repathTimer -= dt
    this.coverTimer -= dt
    // Every second on target shaves the cone; this is the whole "they are
    // ranging you in" feeling. It bottoms out well short of perfect, because
    // an enemy that never misses is not a difficulty setting, it is a wall.
    this.aimError = THREE.MathUtils.lerp(this.aimError, 0.05, dt * 0.35)

    switch (this.state) {
      case 'idle': this.tickIdle(dt); break
      case 'patrol': this.tickPatrol(dt); break
      case 'investigate': this.tickInvestigate(dt); break
      case 'engage': this.tickEngage(dt); break
      case 'seekCover': this.tickSeekCover(dt); break
      case 'suppress': this.tickSuppress(dt); break
      case 'flank': this.tickFlank(dt); break
      case 'reload': this.tickReload(dt); break
      case 'retreat': this.tickRetreat(dt); break
      case 'dead': break
    }
  }

  private aimAtLastKnown(weight: number): void {
    const s = this.soldier
    s.aimTarget.copy(this.lastKnown)
    s.aimWeight += (weight - s.aimWeight) * 0.12
  }

  private tickIdle(dt: number): void {
    const s = this.soldier
    this.clearPath()
    s.faceTarget = null
    s.stance = 'stand'
    s.aimWeight += (0.18 - s.aimWeight) * 0.05
    // Scan: sweep the head so an idle soldier is not a statue.
    this.idleLook += dt * 0.6
    const look = s.yaw + Math.sin(this.idleLook) * 0.9
    s.aimTarget.set(s.position.x + Math.sin(look) * 12, s.position.y + 1.5, s.position.z + Math.cos(look) * 12)
    if (this.alerted) this.enter('engage')
    else if (this.awareness > 0.15) this.enter('investigate')
    else if (this.timeInState > 3 + this.d.rng.next() * 4) this.enter('patrol')
  }

  private tickPatrol(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.alerted) { this.enter('engage'); return }
    if (this.awareness > 0.15) { this.enter('investigate'); return }
    if (!this.hasPatrol || this.repathTimer <= 0) {
      if (this.d.nav.randomPointNear(s.position, 5, 16, this.d.rng, T1)) {
        this.patrolTarget.copy(T1)
        this.hasPatrol = true
        this.setDestination(this.patrolTarget, true)
      }
      this.repathTimer = 6
    }
    s.faceTarget = null
    s.aimWeight += (0.2 - s.aimWeight) * 0.05
    s.aimTarget.set(s.position.x + Math.sin(s.yaw) * 12, s.position.y + 1.55, s.position.z + Math.cos(s.yaw) * 12)
    if (this.followPath(dt, 2.1)) {
      this.hasPatrol = false
      this.enter('idle')
    }
  }

  private tickInvestigate(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.alerted) { this.enter('engage'); return }
    if (this.awareness <= 0.02) { this.enter('patrol'); return }
    if (this.repathTimer <= 0) {
      this.setDestination(this.lastKnown, true)
      this.repathTimer = 1.5
    }
    this.aimAtLastKnown(0.75)
    s.faceTarget = this.lastKnown
    if (this.followPath(dt, 3.3) && this.timeInState > 5) this.enter('patrol')
  }

  private tickEngage(dt: number): void {
    const s = this.soldier
    const dist = s.position.distanceTo(this.pPos)

    if (!this.alerted && this.lostTime > 6) { this.enter('patrol'); return }
    if (this.magazine <= 0) { this.enter('reload'); return }
    if (this.role === 'flank') { this.enter('flank'); return }

    if (!this.inCover && this.coverTimer <= 0 && this.role !== 'advance') {
      this.coverTimer = 2.4
      this.cover = this.findCover()
      if (this.cover) { this.enter('seekCover'); return }
    }

    this.aimAtLastKnown(1)
    s.faceTarget = this.lastKnown

    if (this.role === 'advance' && dist > 9 && this.lostTime < 3) {
      if (this.repathTimer <= 0) {
        this.repathTimer = 0.9
        this.setDestination(this.pPos, true)
      }
      this.followPath(dt, dist > 18 ? 4.7 : 3.1)
      s.stance = 'stand'
    } else {
      this.clearPath()
      s.stance = dist > 14 ? 'crouch' : 'stand'
    }

    if (this.hasContact && this.muzzleClear()) this.fire(dt, this.pPos)
    else if (this.lostTime < 3.5 && this.d.squad.alert > 0.5 && this.d.rng.bool(0.02)) this.enter('suppress')
  }

  private tickSeekCover(dt: number): void {
    const s = this.soldier
    if (!this.cover) { this.enter('engage'); return }
    if (!this.hasDestination) this.setDestination(this.cover.pos, true)
    this.aimAtLastKnown(0.85)
    s.faceTarget = this.lastKnown
    s.stance = 'stand'
    // Moving fast between cover reads as urgency; strolling reads as a demo.
    if (this.followPath(dt, 5.1) || this.timeInState > 6) {
      this.inCover = true
      this.enter('suppress')
    }
  }

  private tickSuppress(dt: number): void {
    const s = this.soldier
    if (this.magazine <= 0) { this.enter('reload'); return }
    if (!this.alerted && this.lostTime > 7) { this.inCover = false; this.enter('patrol'); return }
    if (this.role === 'advance' || this.role === 'flank') { this.inCover = false; this.enter('engage'); return }

    this.clearPath()
    s.faceTarget = this.lastKnown
    this.aimAtLastKnown(1)

    // Pop out, shoot, drop back. That rhythm is what makes cover read as cover.
    this.peekTimer -= dt
    if (this.peekTimer <= 0) {
      this.peeking = !this.peeking
      this.peekTimer = this.peeking ? this.d.rng.range(0.8, 1.8) : this.d.rng.range(0.6, 1.4)
    }
    s.stance = this.peeking ? 'stand' : 'crouch'
    s.leanTarget = this.peeking && this.cover ? this.cover.peek * 0.9 : 0

    if (!this.peeking) return
    if (this.hasContact && this.muzzleClear()) this.fire(dt, this.pPos)
    else if (this.lostTime < 6) this.suppressFire(dt)
  }

  private tickFlank(dt: number): void {
    const s = this.soldier
    if (this.role !== 'flank' || this.magazine <= 0) { this.enter('engage'); return }
    if (this.repathTimer <= 0) {
      this.repathTimer = 3
      // Head for a position off to one side of the player, not straight at them.
      T1.set(this.pPos.x - s.position.x, 0, this.pPos.z - s.position.z)
      const d = T1.length() || 1
      T1.divideScalar(d)
      const side = this.soldier.id % 2 === 0 ? 1 : -1
      T2.set(
        this.pPos.x - T1.x * 6 - T1.z * 9 * side,
        this.pPos.y,
        this.pPos.z - T1.z * 6 + T1.x * 9 * side,
      )
      this.setDestination(T2, true)
    }
    this.inCover = false
    s.stance = 'stand'
    s.faceTarget = this.hasContact ? this.lastKnown : null
    this.aimAtLastKnown(this.hasContact ? 1 : 0.5)
    const done = this.followPath(dt, 5.3)
    if (this.hasContact && this.muzzleClear()) this.fire(dt, this.pPos)
    if (done || this.timeInState > 9) {
      this.role = 'suppress'
      this.enter('engage')
    }
  }

  private tickReload(_dt: number): void {
    const s = this.soldier
    s.stance = this.inCover || this.d.squad.alert > 0.4 ? 'crouch' : 'stand'
    s.leanTarget = 0
    this.clearPath()
    this.aimAtLastKnown(0.55)
    s.faceTarget = this.lastKnown
    if (!s.isReloading) {
      this.magazine = 30
      this.burstLeft = this.d.rng.int(3, 6)
      this.enter(this.inCover ? 'suppress' : 'engage')
    }
  }

  private tickRetreat(dt: number): void {
    const s = this.soldier
    s.stance = 'stand'
    if (this.repathTimer <= 0) {
      this.repathTimer = 2.5
      T1.copy(s.position).sub(this.lastKnown).setY(0).normalize().multiplyScalar(14).add(s.position)
      if (this.d.nav.nearestWalkable(T1, 6, T2)) this.setDestination(T2, true)
    }
    this.aimAtLastKnown(0.6)
    s.faceTarget = null
    if (this.followPath(dt, 5.4) || this.timeInState > 7) this.enter('engage')
  }

  /**
   * Suppresses cover-seeking for a while, so a soldier fights from where it is.
   * Used by scripted capture poses that need a composed frame.
   */
  holdPosition(seconds: number): void {
    this.coverTimer = seconds
    this.cover = null
    this.inCover = false
  }

  /** Drops the soldier straight into a fight; used to script capture poses. */
  forceEngage(target: THREE.Vector3): void {
    this.alerted = true
    this.awareness = 1
    this.hasContact = true
    this.losClear = true
    this.lastKnown.copy(target)
    this.aimError = 0.07
    this.contactTime = 1.2
    this.burstLeft = 5
    this.enter('engage')
  }
}

/**
 * Distance along `dir` at which the ray first enters a vertical capsule
 * standing at `base`, or -1. Done analytically because the player is not
 * guaranteed to own a collider in the physics world.
 */
function rayCapsule(origin: THREE.Vector3, dir: THREE.Vector3, base: THREE.Vector3, radius: number): number {
  const ax = base.x
  const ay = base.y + 0.35
  const az = base.z
  const uy = 1.27 // spine from ankle to eye

  const wx = origin.x - ax
  const wy = origin.y - ay
  const wz = origin.z - az
  const a = dir.lengthSq()
  const b = dir.y * uy
  const c = uy * uy
  const d = dir.x * wx + dir.y * wy + dir.z * wz
  const e = uy * wy
  const denom = a * c - b * b
  let sc = denom > 1e-9 ? (b * e - c * d) / denom : -d / a
  if (sc < 0) sc = 0
  let tc = denom > 1e-9 ? (a * e - b * d) / denom : e / c
  tc = tc < 0 ? 0 : tc > 1 ? 1 : tc

  const dx = origin.x + dir.x * sc - ax
  const dy = origin.y + dir.y * sc - (ay + uy * tc)
  const dz = origin.z + dir.z * sc - az
  const gap = Math.hypot(dx, dy, dz)
  if (gap > radius) return -1
  return Math.max(0.1, sc - Math.sqrt(Math.max(0, radius * radius - gap * gap)))
}

/** Ground height under a point, for placing spawns. */
export function groundBelow(physics: PhysicsSystem, x: number, y: number, z: number, out: THREE.Vector3): boolean {
  G2.set(x, y, z)
  const hit = physics.raycast(G2, DOWN, 45, { characters: false })
  if (!hit) return false
  out.copy(hit.point)
  return true
}
