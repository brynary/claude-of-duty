import * as THREE from 'three'
import type { GameContext, HitInfo, RaycastHit, Surface, Damageable } from '../core/Types'
import type { Rand } from '../core/Rand'
import type { WeaponDef } from './WeaponDefs'

/**
 * Hitscan ballistics with travel-time tracers, distance falloff, per-region
 * multipliers and material penetration.
 *
 * Penetration is resolved with a back-cast: shoot a probe from the far side of
 * the maximum penetrable depth back toward the entry point. Whatever it hits
 * first is the exit face, and the distance it travelled gives the wall
 * thickness for free. If the probe hits nothing (or immediately), the round is
 * still buried in the material and stops.
 */

interface PenetrationRule {
  /** Metres of this material a reference round can defeat. */
  depth: number
  /** Damage retained after passing through. */
  retain: number
}

const PENETRATION: Record<Surface, PenetrationRule> = {
  concrete: { depth: 0, retain: 0 },
  metal: { depth: 0.010, retain: 0.32 },
  thinMetal: { depth: 0.070, retain: 0.70 },
  wood: { depth: 0.160, retain: 0.62 },
  plaster: { depth: 0.200, retain: 0.76 },
  glass: { depth: 0.060, retain: 0.92 },
  dirt: { depth: 0.050, retain: 0.40 },
  sand: { depth: 0.040, retain: 0.34 },
  gravel: { depth: 0.030, retain: 0.30 },
  tile: { depth: 0.035, retain: 0.48 },
  rubber: { depth: 0.055, retain: 0.60 },
  fabric: { depth: 0.250, retain: 0.86 },
  foliage: { depth: 0.700, retain: 0.96 },
  water: { depth: 0.350, retain: 0.50 },
  flesh: { depth: 0.300, retain: 0.55 },
}

export interface ShotResult {
  /** Where the tracer should terminate. */
  end: THREE.Vector3
  hitEntity: boolean
  killed: boolean
  headshot: boolean
}

const _end = new THREE.Vector3()
const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _probe = new THREE.Vector3()
const _back = new THREE.Vector3()
const _exit = new THREE.Vector3()
const _tmp = new THREE.Vector3()

export class Ballistics {
  /** Reused so the tracer endpoint never allocates on the fire path. */
  readonly lastEnd = new THREE.Vector3()

  /**
   * Whether damageable entities scale by `HitInfo.region` themselves. Assumed
   * true so we never double-multiply a target that already does it; a target
   * that reports back the exact number it was given teaches us otherwise and
   * we take over region scaling for it.
   */
  private targetsScaleRegions = true
  private sawDamageEvent = false
  private sawKillEvent = false
  private lastReported = 0

  constructor(private ctx: GameContext) {
    ctx.events.on('damage:dealt', (e) => {
      this.sawDamageEvent = true
      this.lastReported = e.amount
    })
    ctx.events.on('entity:killed', () => { this.sawKillEvent = true })
  }

  /**
   * Traces one round. `origin` is the eye, `muzzle` only feeds the tracer so
   * the visual leaves the barrel while the maths stays centred on the camera.
   */
  fire(
    def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3,
    muzzle: THREE.Vector3, rand: Rand, byPlayer = true,
  ): ShotResult {
    const ctx = this.ctx
    const physics = ctx.services.physics
    const fx = ctx.services.fx
    const hud = ctx.services.hud

    _origin.copy(origin)
    _dir.copy(dir).normalize()
    _end.copy(_origin).addScaledVector(_dir, def.range)

    const result: ShotResult = { end: this.lastEnd, hitEntity: false, killed: false, headshot: false }

    if (!physics) {
      this.lastEnd.copy(_end)
      fx?.bulletTracer(muzzle, this.lastEnd, def.muzzleVelocity)
      return result
    }

    let remaining = def.range
    let damageScale = 1
    let travelled = 0
    let penetrations = 0
    let terminated = false

    while (remaining > 0.05) {
      const hit: RaycastHit | null = physics.raycast(_origin, _dir, remaining)
      if (!hit) break

      const distance = travelled + hit.distance
      const info = this.makeHitInfo(hit, _dir, distance, penetrations > 0)
      const base = this.damageAt(def, distance) * damageScale
      const regionMult = this.regionMult(def, info.region)
      const damage = base * (this.targetsScaleRegions ? 1 : regionMult)

      if (info.target && info.target.alive) {
        result.hitEntity = true
        const head = info.region === 'head'
        if (head) result.headshot = true

        this.sawDamageEvent = false
        this.sawKillEvent = false
        info.target.applyDamage(damage, info)
        const died = !info.target.alive

        if (this.sawDamageEvent) {
          // The entity announced the hit itself: it owns hit feedback. If it
          // reported back exactly what we handed it on a region that should
          // have scaled, it is not doing region multipliers after all.
          if (regionMult !== 1 && Math.abs(this.lastReported - damage) < 1e-3) {
            this.targetsScaleRegions = false
          }
        } else {
          this.targetsScaleRegions = false
          fx?.blood(info.point, info.normal, damage > 45 ? 1.6 : 1)
          ctx.events.emit('damage:dealt', { target: info.target, amount: damage, hit: info })
          if (byPlayer) hud?.hitmarker(died ? 'kill' : head ? 'headshot' : 'normal')
        }
        if (died) {
          result.killed = true
          if (!this.sawKillEvent) {
            ctx.events.emit('entity:killed', {
              entity: info.target, byPlayer, weapon: def.displayName, headshot: head,
            })
          }
        }
      } else {
        fx?.impact(info.point, info.normal, info.surface)
      }
      ctx.events.emit('weapon:hit', info)

      // Can the round keep going?
      const rule = PENETRATION[info.surface] ?? PENETRATION.concrete
      const maxDepth = rule.depth * def.penetration
      if (penetrations >= def.maxPenetrations || maxDepth <= 0.001 || damageScale < 0.12) {
        this.lastEnd.copy(info.point)
        terminated = true
        break
      }

      _probe.copy(info.point).addScaledVector(_dir, maxDepth)
      _back.copy(_dir).negate()
      const exitHit = physics.raycast(_probe, _back, maxDepth)
      if (!exitHit || exitHit.distance < 1e-3) {
        // Still inside the material: the round is captured.
        this.lastEnd.copy(info.point)
        terminated = true
        break
      }
      _exit.copy(_probe).addScaledVector(_back, exitHit.distance)
      const thickness = Math.max(maxDepth - exitHit.distance, 0)

      // Exit spall on the far face reads as a real through-and-through.
      _tmp.copy(exitHit.normal)
      fx?.impact(_exit, _tmp, info.surface)

      // Thicker material bleeds more energy than the material class alone.
      const depthFraction = maxDepth > 0 ? thickness / maxDepth : 1
      damageScale *= rule.retain * (1 - depthFraction * 0.45)
      penetrations++

      const step = hit.distance + (maxDepth - exitHit.distance) + 0.01
      travelled += step
      remaining -= step
      _origin.copy(_exit).addScaledVector(_dir, 0.01)
    }

    if (!terminated) this.lastEnd.copy(_end)
    result.end = this.lastEnd

    fx?.bulletTracer(muzzle, this.lastEnd, def.muzzleVelocity)
    return result
  }

  private makeHitInfo(hit: RaycastHit, dir: THREE.Vector3, distance: number, penetrated: boolean): HitInfo {
    const target = hit.entity
    return {
      point: hit.point,
      normal: hit.normal,
      direction: dir.clone(),
      surface: hit.surface,
      distance,
      region: target ? resolveRegion(hit, target) : undefined,
      target,
      penetrated,
    }
  }

  /** Linear falloff between the two range bands. */
  damageAt(def: WeaponDef, distance: number): number {
    if (distance <= def.falloffStart) return def.damage
    if (distance >= def.falloffEnd) return def.damageMin
    const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart)
    return def.damage + (def.damageMin - def.damage) * t
  }

  private regionMult(def: WeaponDef, region: HitInfo['region']): number {
    switch (region) {
      case 'head': return def.headMult
      case 'chest': return def.chestMult
      case 'stomach': return def.stomachMult
      case 'arm':
      case 'leg': return def.limbMult
      default: return 1
    }
  }
}

/**
 * Body region for a character hit. Hitbox meshes are expected to advertise
 * `userData.region`; failing that the mesh name is matched, and failing that
 * the strike height above the entity origin is bracketed for a 1.8m figure.
 */
function resolveRegion(hit: RaycastHit, target: Damageable): HitInfo['region'] {
  const obj = hit.object
  const tagged = obj?.userData?.region as HitInfo['region'] | undefined
  if (tagged) return tagged
  const name = (obj?.name ?? '').toLowerCase()
  if (name.includes('head') || name.includes('helmet')) return 'head'
  if (name.includes('chest') || name.includes('torso')) return 'chest'
  if (name.includes('stomach') || name.includes('pelvis') || name.includes('abdom')) return 'stomach'
  if (name.includes('arm') || name.includes('hand')) return 'arm'
  if (name.includes('leg') || name.includes('foot') || name.includes('thigh')) return 'leg'

  const rel = hit.point.y - target.position.y
  if (rel >= 1.42) return 'head'
  if (rel >= 1.05) return 'chest'
  if (rel >= 0.78) return 'stomach'
  if (rel >= 0.05) return 'leg'
  // Entity origins that sit at the centre of mass rather than the feet.
  const centred = rel + 0.9
  if (centred >= 1.42) return 'head'
  if (centred >= 1.05) return 'chest'
  if (centred >= 0.78) return 'stomach'
  return 'leg'
}

/**
 * Cone spread. Uses the supplied deterministic PRNG so a replayed capture
 * produces an identical bullet stream.
 */
export function applySpread(dir: THREE.Vector3, radians: number, rand: Rand, out: THREE.Vector3): THREE.Vector3 {
  out.copy(dir).normalize()
  if (radians <= 1e-6) return out
  // Gaussian in the tangent plane gives a dense centre and a soft edge, which
  // is what a real cone of fire looks like on a wall.
  const ang = rand.next() * Math.PI * 2
  const mag = Math.min(Math.abs(rand.gaussian()) * 0.5, 1.4) * radians
  _tmp.set(0, 1, 0)
  if (Math.abs(out.y) > 0.95) _tmp.set(1, 0, 0)
  const right = _probe.crossVectors(out, _tmp).normalize()
  const up = _back.crossVectors(right, out).normalize()
  out.addScaledVector(right, Math.cos(ang) * mag)
  out.addScaledVector(up, Math.sin(ang) * mag)
  return out.normalize()
}
