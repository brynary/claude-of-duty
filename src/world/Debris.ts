import * as THREE from 'three'
import type { MaterialName } from '../render/MaterialNames'
import type { Rand } from '../core/Rand'
import {
  Builder, InstanceFarm, chamferBox, cylinderGeom, decalQuad, rampPrism, catenary,
} from './Kit'
import { groundHeight } from './Terrain'
import { BUILDINGS, footprintBase, xform } from './Buildings'

/**
 * Damage, decay and the history of the place: collapsed structures, rubble
 * fields, sand drifted against every wall, scorch marks and stains.
 */

const SIDE_YAW = { n: 0, e: -Math.PI / 2, s: Math.PI, w: Math.PI / 2 } as const

/**
 * Wind-blown sand banked against every wall base. Nothing says "modelled in a
 * vacuum" louder than a wall meeting the ground at a perfect right angle.
 */
export function buildSandDrift(b: Builder, rng: Rand): void {
  for (const spec of BUILDINGS) {
    const yaw = spec.yaw ?? 0
    for (const side of ['n', 'e', 's', 'w'] as const) {
      const along = side === 'n' || side === 's' ? spec.w : spec.d
      const half = side === 'n' || side === 's' ? spec.d / 2 : spec.w / 2
      const seg = 1.6
      const n = Math.max(1, Math.round(along / seg))
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.22)) continue
        const t = (i + 0.5) / n - 0.5
        const localAlong = t * along
        const depth = rng.range(0.7, 1.35)
        const height = rng.range(0.12, 0.34)
        // Local offsets in the building frame, then rotated by the yaw.
        let lx = 0
        let lz = 0
        if (side === 'n') { lx = localAlong; lz = -half - depth / 2 }
        else if (side === 's') { lx = -localAlong; lz = half + depth / 2 }
        else if (side === 'e') { lx = half + depth / 2; lz = localAlong }
        else { lx = -half - depth / 2; lz = -localAlong }
        const c = Math.cos(yaw)
        const s = Math.sin(yaw)
        const wx = spec.cx + lx * c + lz * s
        const wz = spec.cz - lx * s + lz * c
        const g = rampPrism(seg * rng.range(0.9, 1.15), height, depth)
        b.geom('sand', g, xform(wx, groundHeight(wx, wz) - 0.03, wz, yaw + SIDE_YAW[side] + Math.PI))
      }
    }
  }
}

/** Collapsed shell in the demolished lot: ragged walls, pancaked slabs, rebar. */
export function buildCollapsedBlock(b: Builder, farm: InstanceFarm, rng: Rand): void {
  const cx = 13.8
  const cz = 32.5
  const base = footprintBase(cx, cz, 8, 6)
  b.push(cx, base, cz, 0.22)
  // Two standing walls with blown-out tops, meeting at a corner.
  const wallRuns: [number, number, number, number][] = [
    [-3.6, -2.6, 3.6, -2.6],
    [-3.6, -2.6, -3.6, 2.4],
  ]
  for (const [x0, z0, x1, z1] of wallRuns) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const yaw = Math.atan2(-(z1 - z0), x1 - x0)
    const n = Math.round(len / 0.8)
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      const px = x0 + (x1 - x0) * t
      const pz = z0 + (z1 - z0) * t
      const h = Math.max(0.5, 3.6 * (0.35 + 0.65 * Math.sin(Math.PI * t)) + rng.spread(0.5))
      b.solid('brickRed', 0.82, h, 0.32, px, h / 2, pz, yaw, 0.03)
      if (rng.bool(0.4)) {
        b.geom('rebar', cylinderGeom(0.014, 0.014, rng.range(0.4, 0.9), 5),
          xform(px + rng.spread(0.2), h + 0.25, pz, rng.range(0, 3.1), rng.spread(0.5), rng.spread(0.6)))
      }
    }
  }
  // Pancaked floor slabs leaning off the rubble.
  for (let i = 0; i < 3; i++) {
    const tilt = rng.range(0.25, 0.62)
    const m = xform(rng.spread(2.0), 0.75 + i * 0.5, rng.spread(1.6), rng.range(0, 3.1), tilt, rng.spread(0.2))
    b.geom('concreteWorn', chamferBox(rng.range(2.4, 4.0), 0.24, rng.range(1.8, 3.2), 0.04), m)
    b.collideLocal(3.2, 0.3, 2.6, m, 'concrete')
    // Rebar trailing out of the broken edge.
    for (let k = 0; k < 4; k++) {
      const a = rng.range(0, Math.PI * 2)
      b.geom('rebar', catenary(
        new THREE.Vector3(rng.spread(1.6), 0.9 + i * 0.5, rng.spread(1.2)),
        new THREE.Vector3(Math.cos(a) * 1.7, 0.4 + i * 0.5, Math.sin(a) * 1.7),
        0.25, 0.013, 5, 4))
    }
  }
  // Rubble slope filling the corner.
  for (let i = 0; i < 34; i++) {
    const a = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(rng.next()) * 3.6
    const px = Math.cos(a) * r
    const pz = Math.sin(a) * r
    const py = Math.max(0, 1.25 - r * 0.33) * rng.range(0.5, 1.1)
    b.geom('concreteRubble', chamferBox(rng.range(0.3, 0.8), rng.range(0.15, 0.4), rng.range(0.3, 0.7), 0.03),
      xform(px, py, pz, rng.range(0, 3.1), rng.spread(0.5), rng.spread(0.5)))
  }
  b.collide(7.4, 1.3, 6.2, 0, 0.5, 0, 0, 'gravel')
  b.pop()
  // Loose debris spilling out around it.
  for (let i = 0; i < 60; i++) {
    const a = rng.range(0, Math.PI * 2)
    const r = 3.0 + Math.sqrt(rng.next()) * 5.5
    const px = cx + Math.cos(a) * r
    const pz = cz + Math.sin(a) * r
    farm.place(rng.bool(0.5) ? `chunk${rng.int(0, 3)}` : 'brick',
      px, groundHeight(px, pz) + 0.06, pz, rng.range(0, 3.1), rng.range(0.7, 1.4), rng.spread(0.5), rng.spread(0.5))
  }
}

/** Cone-shaped rubble piles where a facade has come down. */
export function buildRubblePiles(b: Builder, farm: InstanceFarm, rng: Rand): void {
  const piles: [number, number, number][] = [
    [5.6, 21.6, 1.8], [-9.2, 33.4, 2.4], [9.9, 24.6, 2.2], [-24.4, -22.0, 2.0],
    [2.2, 36.6, 2.6], [-19.6, 15.4, 1.9], [15.6, 8.2, 2.0], [26.8, 20.6, 2.3],
    [-6.4, -0.8, 1.6], [12.0, 36.5, 2.8], [-30.6, 2.0, 2.1], [-1.4, -29.0, 1.9],
  ]
  for (const [x, z, r] of piles) {
    const base = groundHeight(x, z)
    const n = Math.round(r * r * 5)
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2)
      const rr = Math.sqrt(rng.next()) * r
      const px = x + Math.cos(a) * rr
      const pz = z + Math.sin(a) * rr
      const py = base + Math.max(0.04, (1 - rr / r) * r * 0.42) * rng.range(0.5, 1.0)
      farm.place(`rubble${rng.int(0, 3)}`, px, py, pz, rng.range(0, 3.1), rng.range(0.7, 1.3), rng.spread(0.6), rng.spread(0.6))
    }
    for (let i = 0; i < Math.round(r * 6); i++) {
      const a = rng.range(0, Math.PI * 2)
      const rr = Math.sqrt(rng.next()) * r * 1.5
      const px = x + Math.cos(a) * rr
      const pz = z + Math.sin(a) * rr
      farm.place('brick', px, groundHeight(px, pz) + 0.05, pz, rng.range(0, 3.1), rng.range(0.85, 1.15), rng.spread(0.4), rng.spread(0.4))
    }
    // Twisted rebar emerging from the heap.
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2)
      b.geom('rebar', catenary(
        new THREE.Vector3(x + rng.spread(r * 0.4), base + r * 0.35, z + rng.spread(r * 0.4)),
        new THREE.Vector3(x + Math.cos(a) * r * 1.1, base + 0.08, z + Math.sin(a) * r * 1.1),
        0.2, 0.013, 6, 4))
    }
    b.collide(r * 1.5, r * 0.5, r * 1.5, x, base + r * 0.2, z, 0, 'gravel')
  }
}

/** Ground-level decals: oil, scorch, tyre tracks and spilled sand. */
export function buildGroundDecals(b: Builder, rng: Rand): void {
  const stains: [number, number, number, MaterialName][] = [
    [-3.2, 22.6, 3.4, 'asphaltCracked'],
    [7.05, 27.4, 3.0, 'asphaltCracked'],
    [-8.0, -19.5, 6.4, 'concreteRubble'],
    [13.5, 32.5, 7.5, 'concreteRubble'],
    [17.2, 31.4, 5.5, 'asphaltCracked'],
    [-6.2, 27.5, 2.6, 'asphaltCracked'],
    [16.5, 27.0, 3.4, 'dirt'],
    [24.0, 30.6, 2.8, 'asphaltCracked'],
    [-2.5, 17.0, 2.2, 'dirt'],
    [6.6, 20.6, 2.4, 'dirt'],
    [-14.0, -12.0, 3.0, 'dirt'],
    [22.0, 24.0, 3.2, 'dirt'],
  ]
  for (const [x, z, r, mat] of stains) {
    b.geom(mat, decalQuad(r, r * rng.range(0.75, 1.25), 0.2, x * 3 + z),
      xform(x, groundHeight(x, z) + 0.018, z, rng.range(0, 3.1), -Math.PI / 2))
  }
  // Tyre tracks worn into the dust along the routes.
  const tracks: [number, number, number, number][] = [
    [-3.0, 10.0, -4.5, 34.0], [7.1, 13.0, 6.6, 34.0], [12.0, 23.0, 30.0, 33.5],
    [-8.0, -4.0, -14.0, -24.0], [16.0, -6.0, 22.0, 18.0],
  ]
  for (const [x0, z0, x1, z1] of tracks) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const yaw = Math.atan2(-(z1 - z0), x1 - x0)
    const n = Math.round(len / 2.4)
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      const px = x0 + (x1 - x0) * t
      const pz = z0 + (z1 - z0) * t
      for (const off of [-0.78, 0.78]) {
        const ox = px + Math.sin(yaw) * off
        const oz = pz + Math.cos(yaw) * off
        b.geom('dirt', decalQuad(2.3, 0.34, 0.08, i * 3 + off),
          xform(ox, groundHeight(ox, oz) + 0.016, oz, yaw, -Math.PI / 2))
      }
    }
  }
}

/** Scorched, cratered ground where ordnance landed, with an ejecta ring. */
export function buildCraterDressing(b: Builder, farm: InstanceFarm, rng: Rand): void {
  const craters: [number, number, number][] = [[-8.0, -19.5, 3.4], [13.5, 32.5, 4.2]]
  for (const [x, z, r] of craters) {
    for (let i = 0; i < 40; i++) {
      const a = rng.range(0, Math.PI * 2)
      const rr = r * rng.range(0.55, 1.6)
      const px = x + Math.cos(a) * rr
      const pz = z + Math.sin(a) * rr
      farm.place(rng.bool(0.4) ? `rubble${rng.int(0, 2)}` : `chunk${rng.int(0, 3)}`,
        px, groundHeight(px, pz) + 0.07, pz, rng.range(0, 3.1), rng.range(0.6, 1.2), rng.spread(0.6), rng.spread(0.6))
    }
    for (let i = 0; i < 5; i++) {
      const a = rng.range(0, Math.PI * 2)
      b.geom('rebar', catenary(
        new THREE.Vector3(x + Math.cos(a) * r * 0.5, groundHeight(x, z) - 0.1, z + Math.sin(a) * r * 0.5),
        new THREE.Vector3(x + Math.cos(a) * r * 1.3, groundHeight(x, z) + 0.4, z + Math.sin(a) * r * 1.3),
        -0.3, 0.014, 6, 4))
    }
  }
}

/**
 * Structural props that live between props and architecture: scaffolding,
 * lean-to shelters, and the wooden hoarding around a building site.
 */
export function buildStructures(b: Builder, rng: Rand): void {
  // Scaffold against the apartment's street facade — a climbable silhouette.
  b.push(-10.2, groundHeight(-10.2, 29.5), 29.5, 0)
  for (let bay = 0; bay < 2; bay++) {
    for (const sz of [-1.1, 1.1]) {
      for (const sx of [0, 1.1]) {
        b.geom('metalRusted', cylinderGeom(0.028, 0.028, 6.6, 6), xform(sx, 3.3, sz + bay * 2.2))
        b.collide(0.12, 6.6, 0.12, sx, 3.3, sz + bay * 2.2, 0, 'metal')
      }
    }
    for (const y of [1.8, 3.6, 5.4]) {
      b.geom('metalRusted', cylinderGeom(0.024, 0.024, 2.3, 6), xform(0.55, y, -1.1 + bay * 2.2, 0, 0, Math.PI / 2))
      b.geom('metalRusted', cylinderGeom(0.024, 0.024, 2.3, 6), xform(0.55, y, 1.1 + bay * 2.2, 0, 0, Math.PI / 2))
      b.geom('metalRusted', cylinderGeom(0.024, 0.024, 2.3, 6), xform(0, y, bay * 2.2, 0, Math.PI / 2, 0))
      b.geom('metalRusted', cylinderGeom(0.024, 0.024, 2.3, 6), xform(1.1, y, bay * 2.2, 0, Math.PI / 2, 0))
      // Boarded deck.
      for (let p = 0; p < 3; p++) {
        b.box('woodPlank', 1.3, 0.04, 0.34, 0.55, y + 0.05, -0.75 + p * 0.38 + bay * 2.2, 0, 0.008)
      }
      b.collide(1.4, 0.12, 2.3, 0.55, y + 0.04, bay * 2.2, 0, 'wood')
    }
  }
  b.pop()

  // Lean-to shelter of corrugated sheet in the lot.
  b.push(11.4, groundHeight(11.4, 25.6), 25.6, 0.8)
  for (const sx of [-1.4, 1.4]) {
    b.solid('woodBeam', 0.1, 2.3, 0.1, sx, 1.15, -1.1, 0, 0.015)
    b.solid('woodBeam', 0.1, 1.7, 0.1, sx, 0.85, 1.1, 0, 0.015)
  }
  b.geom('metalCorrugated', chamferBox(3.2, 0.05, 2.5, 0.02), xform(0, 2.0, 0, 0, 0.24))
  b.geom('tarp', chamferBox(0.05, 1.6, 2.3, 0.02), xform(-1.44, 0.8, 0))
  b.collide(3.0, 0.2, 2.4, 0, 2.0, 0, 0, 'thinMetal')
  b.pop()

  // Timber hoarding around a half-finished plot.
  b.push(-27.0, groundHeight(-27, 4.0), 4.0, 0.1)
  for (let i = 0; i < 12; i++) {
    b.solid('woodPlank', 0.24, 2.2 + rng.spread(0.12), 0.05, -1.5 + i * 0.27, 1.1, 0, 0, 0.01, 'wood')
  }
  b.box('woodBeam', 3.4, 0.1, 0.1, 0, 2.0, -0.09, 0, 0.015)
  b.box('woodBeam', 3.4, 0.1, 0.1, 0, 0.5, -0.09, 0, 0.015)
  b.pop()

  // Chain-link fencing along the highway's northern verge. The mesh is modelled
  // as actual wires rather than a quad, so it reads as see-through whatever the
  // material library does with it, and never walls off a sightline.
  for (let i = 0; i < 7; i++) {
    const t = i * 2.5
    const x = 14.0 + t * 0.9397
    const z = 26.8 + t * 0.342
    const y = groundHeight(x, z)
    b.push(x, y, z, -0.349)
    for (let k = 0; k < 11; k++) {
      b.plate('chainlink', 0.016, 1.85, 0.016, -1.15 + k * 0.23, 0.95, 0)
    }
    for (let k = 0; k < 5; k++) {
      b.plate('chainlink', 2.35, 0.014, 0.014, 0, 0.24 + k * 0.42, 0)
    }
    for (const sx of [-1.2, 1.2]) {
      b.geom('metalRusted', cylinderGeom(0.035, 0.035, 2.05, 6), xform(sx, 1.02, 0))
      b.collide(0.12, 2.0, 0.12, sx, 1.0, 0, 0, 'metal')
    }
    b.geom('metalRusted', cylinderGeom(0.03, 0.03, 2.4, 6), xform(0, 1.95, 0, 0, 0, Math.PI / 2))
    b.pop()
  }
}
