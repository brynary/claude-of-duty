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

/**
 * Muzzle-flash light, sized against the sun (2.1) and the interior fills (5.2)
 * in Lighting.ts.
 *
 * The light sits in the plume ahead of the barrel, not on the muzzle itself.
 * At the muzzle the shooter's own support hand is 0.30m away and his plate
 * carrier 0.49m, so inverse-square turns any intensity useful at scene range
 * into 50-140x sunlight on his own body: the soldier clips to a featureless
 * white mannequin and blooms, which is exactly what iteration 2 shipped.
 * Offsetting forward puts the nearest part of the shooter 0.70m out and drops
 * the near-field by ~5x, so the flash reads as a hot rim on the gloves and the
 * near side of the carrier while a wall 2m in front still takes about 0.6 of a
 * sun's worth of warm bounce. Range is short for the same reason — a rifle
 * flash lights the couple of metres around the shooter, not the whole plaza.
 *
 * With the card re-authored down to a sane radiance (see {@link buildMuzzleFlash})
 * this light is now what a viewer reads most of the flash by, and that is the
 * right way round: a light shows gear, normal maps and form, while a card can
 * only paint over them. At 6.0 the support hand takes 12 lux at 0.70m and grades
 * to around 200/255 on its lit side — hot, not clipped — the near face of the
 * carrier about 6.6 lux at 0.95m, and the ground 1.4m below about 3, which puts
 * a warm pool at roughly 125/255 under a soldier firing in a shadowed street.
 */
const FLASH_LIGHT_INTENSITY = 6
const FLASH_LIGHT_RANGE = 6.5
const FLASH_LIGHT_OFFSET = 0.4

/**
 * Flash light colour. Pushed warmer than the old 0xffcf8c, which was pale enough
 * that the lit side of a soldier came out the same neutral as the sun. Burning
 * propellant lights kit orange, and the hue break against a low sun is half of
 * what separates a firing soldier from the wall behind him.
 */
const FLASH_LIGHT_COLOR = 0xffbe7a

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
    // No `toneMapped: false` here: the Engine leaves renderer tone mapping off
    // and the ACES curve runs as a post effect over the whole buffer, so the
    // flag would be a no-op that reads like an unlit escape hatch. The card is
    // meant to go through the same curve as everything else and bloom off its
    // own core.
    this.flashMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    // Lights are created up front and only ever change intensity: adding or
    // removing one at runtime forces every material in the scene to recompile.
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const l = new THREE.PointLight(FLASH_LIGHT_COLOR, 0, FLASH_LIGHT_RANGE, 2)
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
      l.position.copy(s.muzzleWorld).addScaledVector(s.muzzleDir, FLASH_LIGHT_OFFSET)
      l.intensity = FLASH_LIGHT_INTENSITY
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

/** Linear RGB, scene-referred — not an sRGB colour. */
type Rgb = readonly [number, number, number]

/**
 * Muzzle flash card: a warm four-point star with a small hot core, a soft halo
 * behind it and a short plume down the barrel line. Vertex colours carry the
 * gradient so a single additive material serves every soldier.
 *
 * **Additive layers sum, and the sum is the only number that matters.** The old
 * card ignored that. It stacked three overlapping quads and a cone, each with
 * the same near-white (1.00, 0.96, 0.82) centre vertex, so the axis carried
 * (4.00, 3.84, 3.28) linear head on. Display white is 3.5 scene-linear here —
 * PostFX grades 5.0 to white after a base exposure of 1.44 — so all three
 * channels cleared it together and no amount of roll-off in the curve could
 * pull a colour back out of them: predicted (255, 255, 254), and measured
 * (255, 255, 251) on `shots/iter7/plaza.png` over a blob wider than the
 * shooter's chest. Stacking one hue four times only ever gets brighter, never
 * warmer, and a white disc is what "consumed by a clipped bloom halo" looks
 * like from the outside.
 *
 * It lands on the chest because it has to: a soldier aiming at the camera has
 * his barrel fully foreshortened, so the card is drawn square on his plate
 * carrier with nothing to hide behind. Every capture pose is that case. So the
 * card has to be readable *as a flash sitting on a soldier*, which means the
 * peak has to be budgeted rather than tuned layer by layer.
 *
 * Layer totals on the axis, viewed head on:
 *
 * | layer | R | G | B |
 * |---|---|---|---|
 * | halo  | 0.55 | 0.26 | 0.070 |
 * | star  | 0.95 | 0.52 | 0.160 |
 * | core  | 1.30 | 0.98 | 0.540 |
 * | plume tip | 0.10 | 0.04 | 0.008 |
 * | **total** | **2.90** | **1.80** | **0.778** |
 *
 * Red clips, green sits two thirds of a stop under it and blue nearly two stops
 * under, so the hottest texel grades to (253, 245, 217) — hot amber, not paper.
 * That is the same budget the player's own flash was re-authored to.
 *
 * Luminance 1.96 still clears the 1.6 bloom threshold, but only within 18mm of
 * the axis: the source feeding bloom is two pixels across at 15m and four at 8m,
 * against a card the old one blew past the threshold across its entire 0.37m
 * span. From there out the star grades through gold to deep orange
 * (181, 119, 46) at the rim, which is a flash a viewer can see a soldier behind.
 *
 * Every layer is a single triangle fan with one centre vertex, so no layer
 * overlaps itself and the table above is exact rather than an estimate. Tip to
 * tip the star spans 0.27m — a rifle fireball — against the old card's 0.37m.
 */
function buildMuzzleFlash(): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []

  /**
   * Rim ring for {@link fan}: `n` vertices as x, y, r, g, b, at a radius and
   * colour that may alternate to cut a star out of the ring.
   */
  const ring = (n: number, radius: (i: number) => number, colour: (i: number) => Rgb): number[] => {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = radius(i)
      const c = colour(i)
      out.push(Math.cos(a) * r, Math.sin(a) * r, c[0], c[1], c[2])
    }
    return out
  }

  /** Centre-bright triangle fan lying flat in the plane z, facing the barrel. */
  const fan = (z: number, centre: Rgb, rim: readonly number[]) => {
    const c = pos.length / 3
    pos.push(0, 0, z)
    col.push(centre[0], centre[1], centre[2])
    const base = pos.length / 3
    const n = rim.length / 5
    for (let i = 0; i < n; i++) {
      const o = i * 5
      pos.push(rim[o], rim[o + 1], z)
      col.push(rim[o + 2], rim[o + 3], rim[o + 4])
    }
    for (let i = 0; i < n; i++) idx.push(c, base + i, base + ((i + 1) % n))
  }

  const BLACK: Rgb = [0, 0, 0]
  // Halo: widest, dimmest, deep orange, out to nothing. This is what gives the
  // flash a soft edge without asking bloom to invent one.
  fan(0.006, [0.55, 0.26, 0.07], ring(12, () => 0.105, () => BLACK))

  // Star: four 0.135m points with 0.048m valleys between them. Rim colour is
  // keyed to radius, not to which kind of vertex it is — the fireball cools
  // outward, so the near valleys stay hotter than the far points.
  const TIP: Rgb = [0.26, 0.08, 0.012]
  const VALLEY: Rgb = [0.44, 0.17, 0.035]
  fan(
    0.010,
    [0.95, 0.52, 0.16],
    ring(8, (i) => (i % 2 === 0 ? 0.135 : 0.048), (i) => (i % 2 === 0 ? TIP : VALLEY)),
  )

  // Core: the only part that reaches display white, and it is 7cm across.
  fan(0.014, [1.3, 0.98, 0.54], ring(8, () => 0.036, () => [0.34, 0.15, 0.03]))

  // Plume: a short cone down the barrel line, hottest at its base. Head on, a
  // ray crosses it once and picks up the tip colour on the axis, which is why
  // the table above charges the axis only 0.10 for it. Side on it is crossed
  // twice near the base for (1.44, 0.80, 0.22) — a warm ember, under the bloom
  // threshold, because side on the flash light does the reading and a card that
  // blooms from an angle would only veil the shooter beside it.
  const tip = pos.length / 3
  pos.push(0, 0, 0.22)
  col.push(0.1, 0.04, 0.008)
  const ringStart = pos.length / 3
  const seg = 8
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2
    pos.push(Math.cos(a) * 0.042, Math.sin(a) * 0.042, 0)
    col.push(0.72, 0.4, 0.11)
  }
  for (let i = 0; i < seg; i++) idx.push(tip, ringStart + i, ringStart + ((i + 1) % seg))

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.09), 0.2)
  return g
}
