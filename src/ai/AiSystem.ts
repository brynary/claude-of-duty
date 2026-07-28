import * as THREE from 'three'
import type { AiService, Damageable, GameContext, System } from '../core/Types'
import type { PhysicsSystem } from '../physics/Physics'
import { Rand } from '../core/Rand'
import { POSES } from '../core/Poses'
import { NavGrid, Steering } from './Navigation'
import { Behaviour, Squad, groundBelow } from './Behaviour'
import { Soldier, type SoldierWorld } from './Soldier'
import { buildSoldierAsset, type SoldierAsset } from './SoldierMesh'

/**
 * Enemy soldiers: procedural characters, navigation, cover-based combat,
 * animation and ragdoll death.
 *
 * Everything visible here is generated at init — three skinned soldier variants
 * sharing geometry and materials, a navigation grid sampled from the collision
 * world, and a muzzle-flash card plus a small pool of flash lights so a
 * firefight actually lights the scene rather than just drawing sprites on it.
 */

/** Corpses linger, then fade; roughly a CoD-length body persistence. */
const CORPSE_FADE_START = 9
const CORPSE_LIFETIME = 12
const MAX_LIVE = 10
const FLASH_LIGHTS = 3

export class AiSystem implements System, AiService {
  readonly name = 'ai'

  enemies: Damageable[] = []

  private ctx!: GameContext
  private physics!: PhysicsSystem
  private nav = new NavGrid()
  private steering!: Steering
  private squad = new Squad()
  private rng!: Rand
  private world!: SoldierWorld

  private assets: SoldierAsset[] = []
  private soldiers: Soldier[] = []
  private corpses: Soldier[] = []
  private byId = new Map<number, Behaviour>()

  private flashGeometry!: THREE.BufferGeometry
  private flashMaterial!: THREE.Material
  private lights: THREE.PointLight[] = []

  private waveTimer = 4
  private waveIndex = 0
  private spawnCandidates: THREE.Vector3[] = []
  private observer = new THREE.Vector3()
  private observerYaw = 0
  private scripted = false

  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
  private tmpC = new THREE.Vector3()

  init(ctx: GameContext): void {
    this.ctx = ctx
    this.physics = ctx.services.physics as PhysicsSystem
    this.rng = new Rand(ctx.config.seed ^ 0x5eed10)
    this.steering = new Steering(this.physics)
    this.world = { ctx, physics: this.physics, rng: this.rng }

    const mats = ctx.services.materials
    for (let i = 0; i < 3; i++) this.assets.push(buildSoldierAsset(mats, ctx.config.seed + i * 977))

    this.flashGeometry = buildMuzzleFlash()
    this.flashMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })

    // Lights are created up front and only ever change intensity: adding or
    // removing one at runtime forces every material in the scene to recompile.
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffcf8c, 0, 11, 2)
      l.castShadow = false
      ctx.scene.add(l)
      this.lights.push(l)
    }

    // Rapier only builds its scene-query acceleration structures inside step(),
    // so every raycast before the first step returns null. Systems that sample
    // the world during init — this one does, heavily — have to prime it first
    // or they silently see an empty world.
    this.physics.world.step()

    const level = ctx.services.level
    if (level) {
      this.nav.build(this.physics, level.bounds)
      if (this.nav.walkableCount === 0) {
        this.physics.world.step()
        this.nav.build(this.physics, level.bounds)
      }
    }

    this.resolveObserver()
    this.buildSpawnCandidates()

    ctx.events.on('weapon:fired', (e) => {
      if (e.loud) this.notifyNoise(e.origin, 38)
    })
    ctx.events.on('fx:explosion', (e) => this.notifyNoise(e.point, e.radius + 26))
    ctx.events.on('damage:dealt', (e) => {
      const b = this.byId.get(e.target.id)
      if (b) b.onDamaged(e.hit)
    })

    ctx.services.ai = this

    this.scripted = ctx.config.pose !== null
    this.spawnWave(this.scripted ? 7 : 6)
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * The camera the encounter is composed for: the fixed pose during a capture,
   * otherwise the live player.
   */
  private resolveObserver(): void {
    const pose = this.ctx.config.pose ? POSES[this.ctx.config.pose] : null
    if (pose) {
      this.observer.set(...pose.position)
      this.observerYaw = THREE.MathUtils.degToRad(pose.yaw)
      return
    }
    const level = this.ctx.services.level
    const player = this.ctx.services.player
    if (player) {
      this.observer.copy(player.eye)
      this.observerYaw = player.yaw
    } else if (level) {
      this.observer.copy(level.playerSpawn)
      this.observer.y += 1.68
      this.observerYaw = level.playerSpawnYaw
    }
  }

  /**
   * Builds a ranked list of places to put enemies. Points inside the observer's
   * forward arc with a clear line to them come first — an encounter the camera
   * cannot see is not an encounter — with the level's own spawn points as
   * fallback so ordinary play still uses authored positions.
   */
  private buildSpawnCandidates(): void {
    this.spawnCandidates.length = 0
    // Camera convention: yaw 0 looks down -Z, so forward and right are these.
    const fwdX = -Math.sin(this.observerYaw)
    const fwdZ = -Math.cos(this.observerYaw)
    const rightX = Math.cos(this.observerYaw)
    const rightZ = -Math.sin(this.observerYaw)

    const angles = [0.06, -0.2, 0.28, -0.42, 0.44, -0.1, 0.2, -0.55, 0.58]
    const ranges = [11, 16, 8.5, 20, 13.5, 24, 18, 9.5, 22]
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i]
      const r = ranges[i]
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const x = this.observer.x + (fwdX * ca + rightX * sa) * r
      const z = this.observer.z + (fwdZ * ca + rightZ * sa) * r
      if (!groundBelow(this.physics, x, this.observer.y + 8, z, this.tmpA)) continue
      if (!this.nav.isWalkable(this.tmpA.x, this.tmpA.z)) continue
      // Require a clear line to the chest, so the soldier is actually on screen.
      this.tmpB.set(this.tmpA.x, this.tmpA.y + 1.25, this.tmpA.z)
      this.tmpC.copy(this.tmpB).sub(this.observer)
      const dist = this.tmpC.length()
      this.tmpC.divideScalar(dist)
      if (this.physics.raycast(this.observer, this.tmpC, dist - 0.4, { characters: false })) continue
      this.spawnCandidates.push(this.tmpA.clone())
    }

    const level = this.ctx.services.level
    if (!level) return
    for (const p of level.spawnPoints) {
      if (!groundBelow(this.physics, p.x, p.y + 6, p.z, this.tmpA)) {
        this.spawnCandidates.push(p.clone())
        continue
      }
      this.spawnCandidates.push(this.tmpA.clone())
    }
  }

  spawnWave(count: number): void {
    if (!this.ctx) return
    this.resolveObserver()
    if (this.waveIndex > 0) this.buildSpawnCandidates()
    const wave = this.waveIndex++

    for (let i = 0; i < count; i++) {
      if (this.soldiers.length >= MAX_LIVE) break
      const spot = this.pickSpawn(i, wave)
      if (!spot) continue

      const asset = this.assets[(i + wave) % this.assets.length]
      const s = new Soldier(this.world, asset, this.flashGeometry, this.flashMaterial)
      s.maxHealth = 100
      s.health = 100
      const yaw = Math.atan2(this.observer.x - spot.x, this.observer.z - spot.z)
      s.spawn(spot, yaw, this.ctx.scene)
      s.aimTarget.copy(this.observer)

      const b = new Behaviour(s, {
        ctx: this.ctx,
        physics: this.physics,
        nav: this.nav,
        steering: this.steering,
        rng: this.rng,
        squad: this.squad,
      })
      this.squad.members.push(b)
      this.byId.set(s.id, b)
      this.soldiers.push(s)
      this.enemies.push(s)
      this.ctx.entities.set(s.id, s)
      this.ctx.events.emit('entity:spawned', { entity: s })

      if (this.scripted) {
        // A capture pose needs soldiers fighting in frame, not relocating to
        // cover somewhere behind a wall.
        b.forceEngage(this.observer)
        b.holdPosition(30)
        b.role = i < 2 ? 'suppress' : i === 2 ? 'advance' : 'suppress'
      }
    }
  }

  private pickSpawn(index: number, wave: number): THREE.Vector3 | null {
    const n = this.spawnCandidates.length
    if (n === 0) return null
    for (let attempt = 0; attempt < n; attempt++) {
      const c = this.spawnCandidates[(index + attempt + wave * 3) % n]
      let clash = false
      for (const s of this.soldiers) {
        if (s.alive && s.position.distanceToSquared(c) < 2.6) { clash = true; break }
      }
      if (clash) continue
      this.tmpA.copy(c)
      if (this.nav.nearestWalkable(this.tmpA, 3, this.tmpB)) return this.tmpB.clone()
      return c.clone()
    }
    return null
  }

  notifyNoise(position: THREE.Vector3, radius: number): void {
    for (const b of this.squad.members) {
      if (b.soldier.alive) b.hearNoise(position, radius)
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: GameContext): void {
    // The capture nudge runs even on frozen frames (dt === 0), because the
    // graded frame is the one where simulation has already stopped.
    if (ctx.config.freezeAt !== null && ctx.elapsed >= ctx.config.freezeAt - 0.05) this.forceCaptureAction()

    if (dt > 0) {
      this.retireDead()

      const player = ctx.services.player
      this.tmpA.copy(player ? player.position : ctx.camera.position)
      this.squad.update(dt, this.tmpA)
      if (this.scripted) this.enforceScriptedRoles()

      for (const b of this.squad.members) {
        if (b.soldier.alive) b.update(dt)
      }
      for (const s of this.soldiers) s.update(dt)

      this.updateCorpses(dt)
      this.updateWaves(dt)
    }

    this.updateFlashLights()
  }

  /**
   * A capture pose must keep its composition: soldiers hold their ground and
   * shoot rather than flanking off camera.
   */
  private enforceScriptedRoles(): void {
    for (let i = 0; i < this.squad.members.length; i++) {
      const b = this.squad.members[i]
      if (b.role === 'flank') b.role = 'suppress'
      b.holdPosition(30)
    }
  }

  private retireDead(): void {
    for (let i = this.soldiers.length - 1; i >= 0; i--) {
      const s = this.soldiers[i]
      if (s.alive) continue
      this.soldiers.splice(i, 1)
      this.corpses.push(s)
      const ei = this.enemies.indexOf(s)
      if (ei >= 0) this.enemies.splice(ei, 1)
      const bi = this.squad.members.findIndex((b) => b.soldier === s)
      if (bi >= 0) this.squad.members.splice(bi, 1)
      this.byId.delete(s.id)
    }
  }

  private updateCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const s = this.corpses[i]
      s.update(dt)
      if (s.deadTime > CORPSE_LIFETIME) {
        s.dispose()
        this.corpses.splice(i, 1)
      } else if (s.deadTime > CORPSE_FADE_START) {
        s.setFade(1 - (s.deadTime - CORPSE_FADE_START) / (CORPSE_LIFETIME - CORPSE_FADE_START))
      }
    }
  }

  private updateWaves(dt: number): void {
    if (this.soldiers.length > 2) {
      this.waveTimer = 6
      return
    }
    this.waveTimer -= dt
    if (this.waveTimer <= 0) {
      this.waveTimer = 12
      this.spawnWave(4)
    }
  }

  /** Places the flash light pool on whoever is actually shooting. */
  private updateFlashLights(): void {
    let used = 0
    for (const s of this.soldiers) {
      if (used >= FLASH_LIGHTS) break
      if (!s.alive || !s.isFlashing) continue
      const l = this.lights[used++]
      l.position.copy(s.muzzleWorld)
      l.intensity = 26
    }
    for (let i = used; i < FLASH_LIGHTS; i++) this.lights[i].intensity = 0
  }

  /**
   * Guarantees the frozen capture frame has a firefight in it: the soldiers with
   * a clear line to the camera hold a muzzle flash and a recoil pose.
   */
  private forceCaptureAction(): void {
    let lit = 0
    for (const s of this.soldiers) {
      if (!s.alive) continue
      this.tmpA.copy(s.muzzleWorld).sub(this.observer)
      const dist = this.tmpA.length()
      if (dist < 0.5 || dist > 40) continue
      this.tmpA.divideScalar(dist)
      if (this.physics.raycast(this.observer, this.tmpA, dist - 0.5, { characters: false })) continue
      s.forceFlash()
      if (++lit >= 3) break
    }
  }

  dispose(): void {
    for (const s of this.soldiers) s.dispose()
    for (const s of this.corpses) s.dispose()
    this.soldiers.length = 0
    this.corpses.length = 0
    this.enemies.length = 0
    this.squad.members.length = 0
    for (const l of this.lights) l.removeFromParent()
    for (const a of this.assets) {
      a.geometry.dispose()
      for (const m of a.materials) m.dispose()
    }
    this.flashGeometry.dispose()
    this.flashMaterial.dispose()
  }
}

/**
 * Muzzle flash card: a four-point star of crossed quads plus a short cone, with
 * a white-hot core fading to orange. Vertex colours carry the gradient so a
 * single additive material serves every soldier.
 */
function buildMuzzleFlash(): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []

  const core = [1.0, 0.96, 0.82]
  const mid = [1.0, 0.62, 0.18]
  const edge = [0.55, 0.15, 0.02]

  const quad = (w: number, h: number, roll: number, z: number) => {
    const base = pos.length / 3
    const c = Math.cos(roll)
    const s = Math.sin(roll)
    const pts: [number, number][] = [[-w, -h], [w, -h], [w, h], [-w, h]]
    for (const [u, v] of pts) {
      pos.push(u * c - v * s, u * s + v * c, z)
      col.push(edge[0], edge[1], edge[2])
    }
    // Bright centre vertex.
    const centre = pos.length / 3
    pos.push(0, 0, z)
    col.push(core[0], core[1], core[2])
    for (let i = 0; i < 4; i++) {
      idx.push(centre, base + i, base + ((i + 1) % 4))
    }
  }

  quad(0.055, 0.16, 0, 0.01)
  quad(0.16, 0.055, 0, 0.012)
  quad(0.13, 0.13, Math.PI / 4, 0.008)

  // Forward cone: the plume down the barrel line.
  const tip = pos.length / 3
  pos.push(0, 0, 0.26)
  col.push(mid[0], mid[1], mid[2])
  const ringStart = pos.length / 3
  const seg = 7
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2
    pos.push(Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.0)
    col.push(core[0], core[1], core[2])
  }
  for (let i = 0; i < seg; i++) {
    idx.push(tip, ringStart + i, ringStart + ((i + 1) % seg))
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.1), 0.4)
  return g
}
