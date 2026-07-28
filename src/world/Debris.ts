import * as THREE from 'three'
import type { MaterialName } from '../render/MaterialNames'
import type { Rand } from '../core/Rand'
import {
  Builder, InstanceFarm, chamferBox, cylinderGeom, decalQuad, groundPatch, rampPrism, catenary,
} from './Kit'
import { POTHOLES, groundHeight, settleHeight, surfaceHeight } from './Terrain'
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
        b.geom('sand', g, xform(wx, surfaceHeight(wx, wz) - 0.04, wz, yaw + SIDE_YAW[side] + Math.PI))
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
      px, settleHeight(px, pz, 0.12, 0.01), pz, rng.range(0, 3.1), rng.range(0.7, 1.4), rng.spread(0.5), rng.spread(0.5))
  }
}

/**
 * Rubble heaps where a facade has come down.
 *
 * Two things changed here. The heaps are lower and elliptical rather than
 * conical, because a 0.8 m cone of boulders across a 4.4 m alley reads as a
 * barricade of eggs and walls off the corridor's leading lines. And every
 * fragment is scaled non-uniformly, so a heap made from four base shapes never
 * shows the same silhouette twice.
 */
export function buildRubblePiles(b: Builder, farm: InstanceFarm, rng: Rand): void {
  // x, z, radius, height factor, and how far the heap is stretched along z.
  const piles: [number, number, number, number, number][] = [
    // Pulled hard against the alley's west wall so the sightline stays open.
    [5.35, 21.4, 1.5, 0.26, 1.5], [-9.2, 33.4, 2.4, 0.4, 1.0],
    [9.9, 24.6, 2.2, 0.4, 1.0], [-24.4, -22.0, 2.0, 0.38, 1.1],
    [2.2, 36.6, 2.6, 0.42, 1.0], [-19.6, 15.4, 1.9, 0.36, 1.2],
    [15.6, 8.2, 2.0, 0.4, 1.0], [26.8, 20.6, 2.3, 0.4, 1.0],
    [-6.4, -0.8, 1.6, 0.34, 1.0], [12.0, 36.5, 2.8, 0.44, 1.0],
    [-30.6, 2.0, 2.1, 0.4, 1.0], [-1.4, -29.0, 1.9, 0.36, 1.3],
  ]
  for (const [x, z, r, hf, stretch] of piles) {
    const base = settleHeight(x, z, r * 0.5, 0.05)
    const n = Math.round(r * r * 5)
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2)
      const rr = Math.sqrt(rng.next()) * r
      const px = x + Math.cos(a) * rr
      const pz = z + Math.sin(a) * rr * stretch
      const py = base + Math.max(0.02, (1 - rr / r) * r * hf) * rng.range(0.4, 1.0)
      const s = rng.range(0.7, 1.3)
      farm.placeScaled(`rubble${rng.int(0, 3)}`, px, py, pz, rng.range(0, 3.1),
        s * rng.range(0.8, 1.25), s * rng.range(0.62, 1.0), s * rng.range(0.8, 1.25),
        rng.spread(0.7), rng.spread(0.7))
    }
    for (let i = 0; i < Math.round(r * 8); i++) {
      const a = rng.range(0, Math.PI * 2)
      const rr = Math.sqrt(rng.next()) * r * 1.6
      const px = x + Math.cos(a) * rr
      const pz = z + Math.sin(a) * rr * stretch
      farm.place('brick', px, settleHeight(px, pz, 0.09, 0.012), pz,
        rng.range(0, 3.1), rng.range(0.8, 1.2), rng.spread(0.5), rng.spread(0.5))
    }
    // Dust washed out from the heap, so it does not stop at a hard edge.
    b.geom('dirt', groundPatch(x, z, r * 1.5, r * 1.5 * stretch, x * 11 + z, surfaceHeight, 0.02))
    // Twisted rebar emerging from the heap.
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2)
      b.geom('rebar', catenary(
        new THREE.Vector3(x + rng.spread(r * 0.4), base + r * hf * 0.95, z + rng.spread(r * 0.4)),
        new THREE.Vector3(x + Math.cos(a) * r * 1.1, base + 0.08, z + Math.sin(a) * r * 1.1),
        0.2, 0.013, 6, 4))
    }
    const ch = Math.max(0.3, r * hf * 1.5)
    b.collide(r * 1.5, ch, r * 1.5 * stretch, x, base + ch / 2, z, 0, 'gravel')
  }
}

/** Ground-level decals: oil, scorch, tyre tracks and spilled sand. */
export function buildGroundDecals(b: Builder, rng: Rand): void {
  const stains: [number, number, number, MaterialName][] = [
    [-3.2, 22.6, 3.4, 'asphaltCracked'],
    [7.75, 28.0, 3.0, 'asphaltCracked'],
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
    // Welded to the drawn surface vertex by vertex. A flat quad up to 7.5 m
    // across, tilted onto paving that undulates by tens of centimetres, buries
    // one corner and lifts the other clear — which is precisely the "unlit
    // card lying on the cobblestone" read.
    b.geom(mat, groundPatch(x, z, r * 0.5, r * rng.range(0.38, 0.62), x * 3 + z, surfaceHeight, 0.018))
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
          xform(ox, surfaceHeight(ox, oz) + 0.016, oz, yaw, -Math.PI / 2))
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
        px, settleHeight(px, pz, 0.16, 0.0), pz, rng.range(0, 3.1), rng.range(0.6, 1.2), rng.spread(0.6), rng.spread(0.6))
    }
    for (let i = 0; i < 5; i++) {
      const a = rng.range(0, Math.PI * 2)
      b.geom('rebar', catenary(
        new THREE.Vector3(x + Math.cos(a) * r * 0.5, surfaceHeight(x, z) - 0.1, z + Math.sin(a) * r * 0.5),
        new THREE.Vector3(x + Math.cos(a) * r * 1.3, surfaceHeight(x, z) + 0.4, z + Math.sin(a) * r * 1.3),
        -0.3, 0.014, 6, 4))
    }
  }
}

/**
 * Standing water in every pothole and crater, plus a few slicks where a wall
 * drains onto the pavement.
 *
 * A wet patch is the cheapest specular event in a dusty scene: it reflects the
 * sky, breaks up a flat ground plane and immediately reads as weather that has
 * happened rather than a surface that was generated.
 */
export function buildPuddles(b: Builder, rng: Rand): void {
  // Water lies in a dish, so its surface is level: sample the hollow and pour
  // to a fixed height rather than following the paving.
  const pour = (x: number, z: number, r: number, fill: number) => {
    let lo = surfaceHeight(x, z)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      lo = Math.min(lo, surfaceHeight(x + Math.cos(a) * r * 0.6, z + Math.sin(a) * r * 0.6))
    }
    return lo + fill
  }
  const sheet = (x: number, z: number, rx: number, rz: number, y: number, seed: number): void => {
    b.geom('water', groundPatch(x, z, rx, rz, seed, () => y, 0, 2, 16))
  }
  for (const p of POTHOLES) {
    const r = p.r * rng.range(0.5, 0.78)
    const y = pour(p.x, p.z, r, p.depth * rng.range(0.24, 0.42))
    sheet(p.x, p.z, r * 0.9, r * 0.78, y, p.x * 7 + p.z)
    // Damp ground fanning out from the rim, welded to the paving under it.
    b.geom('asphaltCracked', groundPatch(p.x, p.z, r * 1.35, r * 1.15, p.z * 5 + 3, surfaceHeight, 0.014))
  }
  // Seepage down the shaded sides of the two routes and under the gateway.
  // Only where a wall or an overhang keeps the sun off — standing water in the
  // middle of a sunlit square is the tell that made these read as blue cards.
  const slicks: [number, number, number][] = [
    [6.4, 16.8, 1.1], [7.6, 23.2, 0.9], [6.9, 33.4, 1.3], [-9.6, 24.0, 1.2],
    [-4.0, 30.6, 1.5], [-19.4, 6.2, 0.9], [11.6, 12.0, 1.0],
  ]
  for (const [x, z, r] of slicks) {
    const y = pour(x, z, r, 0.012)
    sheet(x, z, r * 0.8, r * 0.55, y, x * 3 + z)
    b.geom('dirt', groundPatch(x, z, r * 1.35, r * 0.98, x - z, surfaceHeight, 0.01))
  }
}

/**
 * Sprayed tags, stencils and scorch on the frontages the graded cameras face.
 *
 * Each tag is a run of overlapping strokes rather than a texture, so it takes
 * scene light and sits at a believable height and reach — roughly shoulder to
 * head, always near a doorway or a corner where someone could stand.
 */
export function buildWallMarks(b: Builder, rng: Rand): void {
  // x, z on the wall plane, the yaw whose local -Z points out of the wall, and
  // a scale. Anchors sit on real faces: the alley's two walls, the market
  // street frontages and the plaza's east row.
  const spots: [number, number, number, number][] = [
    [9.18, 11.4, Math.PI / 2, 1.0], [9.18, 16.8, Math.PI / 2, 0.8],
    [5.02, 14.6, -Math.PI / 2, 0.9], [5.02, 27.4, -Math.PI / 2, 1.1],
    [9.19, 26.2, Math.PI / 2, 1.0], [9.19, 32.6, Math.PI / 2, 0.85],
    [-10.48, 20.6, -Math.PI / 2, 1.05], [-10.48, 30.2, -Math.PI / 2, 0.9],
    [-13.0, -0.55, 0, 1.0], [-21.34, 22.0, -Math.PI / 2, 0.95],
    [5.02, -11.4, -Math.PI / 2, 0.9], [-25.34, -20.0, -Math.PI / 2, 1.0],
    [5.02, 33.0, -Math.PI / 2, 0.8],
  ]
  const inks: MaterialName[] = ['rubber', 'brickRed', 'metalPainted', 'rubber']
  for (const [x, z, yaw, s] of spots) {
    const y = groundHeight(x, z) + rng.range(1.25, 1.75)
    const ink = rng.pick(inks)
    b.push(x, y, z, yaw)
    // Backing haze from the overspray. Grime, not fresh plaster, and barely
    // wider than the tag: a pale 2 m panel behind every piece of graffiti was
    // covering a ninth of the alley frame in flat cards.
    b.geom('dirt', decalQuad(1.25 * s, 0.62 * s, 0.34, x * 5 + z), xform(0, 0, -0.013))
    let cx = -0.85 * s
    while (cx < 0.85 * s) {
      const w = rng.range(0.12, 0.3) * s
      const h = rng.range(0.16, 0.42) * s
      const lean = rng.spread(0.35)
      b.geom(ink, decalQuad(w, 0.05 * s, 0.25, cx * 31), xform(cx, rng.spread(0.12) * s, -0.018, 0, 0, lean))
      b.geom(ink, decalQuad(0.05 * s, h, 0.25, cx * 17 + 2), xform(cx + rng.spread(0.05), rng.spread(0.1) * s, -0.018, 0, 0, lean * 0.4))
      if (rng.bool(0.45)) {
        b.geom(ink, decalQuad(w * 0.7, 0.045 * s, 0.3, cx * 7), xform(cx, h * 0.5, -0.018, 0, 0, rng.spread(0.5)))
      }
      cx += w * rng.range(0.7, 1.15)
    }
    // A drip or two, because spray always runs.
    for (let i = 0; i < rng.int(1, 3); i++) {
      b.geom(ink, decalQuad(0.02 * s, rng.range(0.1, 0.3) * s, 0.2, i * 13 + x),
        xform(rng.spread(0.7) * s, -rng.range(0.15, 0.35) * s, -0.019))
    }
    b.pop()
  }
  // Soot fanning up the wall out of the openings that took a fire.
  const scorch: [number, number, number, number, number, number][] = [
    [9.18, 9.8, Math.PI / 2, 1.8, 2.4, 2.6],
    [5.02, 16.4, -Math.PI / 2, 1.6, 1.9, 2.0],
    [5.02, 30.2, -Math.PI / 2, 2.2, 2.6, 3.0],
    [-10.48, 26.4, -Math.PI / 2, 2.4, 2.8, 3.2],
    [-16.4, -0.55, 0, 2.0, 2.4, 2.6],
    [5.02, -18.0, -Math.PI / 2, 2.2, 2.7, 3.0],
  ]
  for (const [x, z, yaw, w, cy, h] of scorch) {
    const y = groundHeight(x, z)
    b.push(x, y, z, yaw)
    // A plume, not a rectangle. One 1.8 x 2.6 m tyre-rubber quad was reading
    // as a roller shutter bolted to the alley wall — five soft lobes that
    // narrow at the source and fan out as they rise read as fire damage.
    const lobes = 6
    for (let i = 0; i < lobes; i++) {
      const t = i / (lobes - 1)
      const lw = w * (0.34 + 0.62 * t) * rng.range(0.8, 1.15)
      const lh = h * 0.34 * rng.range(0.75, 1.2)
      b.geom(i < 2 ? 'rubber' : 'dirt',
        decalQuad(lw, lh, 0.4, x * 9 + z + i * 3.1),
        xform(rng.spread(w * 0.22 * t), cy - h * 0.34 + t * h * 0.72, -0.016 - i * 0.0012))
    }
    // Scorched, spalled render at the mouth of the opening itself.
    b.geom('concreteRubble', decalQuad(w * 0.5, h * 0.22, 0.34, z * 3), xform(rng.spread(0.2), cy - h * 0.4, -0.013))
    b.pop()
  }
}

/**
 * Grime banked into the bottom half-metre of every facade, plus rust streaks
 * running down from whatever is bolted to it. Nothing in a dusty town has a
 * clean wall base.
 */
export function buildWallGrime(b: Builder, rng: Rand): void {
  const proud = 0.022
  for (const spec of BUILDINGS) {
    const yaw = spec.yaw ?? 0
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    for (const side of ['n', 'e', 's', 'w'] as const) {
      const along = side === 'n' || side === 's' ? spec.w : spec.d
      const half = side === 'n' || side === 's' ? spec.d / 2 : spec.w / 2
      const n = Math.max(1, Math.round(along / 2.6))
      // Local outward normal of this face, before the building's own yaw.
      const dx = side === 'e' ? 1 : side === 'w' ? -1 : 0
      const dz = side === 's' ? 1 : side === 'n' ? -1 : 0
      const ox = dx * c + dz * s
      const oz = -dx * s + dz * c
      // Rotating a decal by this yaw sends its +Z normal along (ox, oz).
      const face = Math.atan2(ox, oz)
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5
        const localAlong = t * along + rng.spread(0.5)
        const lx = side === 'n' ? localAlong : side === 's' ? -localAlong : dx * half
        const lz = side === 'e' ? localAlong : side === 'w' ? -localAlong : dz * half
        const wx = spec.cx + lx * c + lz * s + ox * proud
        const wz = spec.cz - lx * s + lz * c + oz * proud
        const base = groundHeight(wx, wz)
        // Kept to the bottom half-metre. Run any taller and the band stops
        // reading as splash-back off the paving and starts reading as a
        // painted dado — and it was the largest single element in the alley
        // frame by area.
        b.geom('dirt', decalQuad(along / n + rng.range(0, 0.6), rng.range(0.34, 0.72), 0.3, wx * 3 + wz),
          xform(wx, base + rng.range(0.16, 0.34), wz, face))
        if (rng.bool(0.3)) {
          b.geom('metalRusted', decalQuad(rng.range(0.1, 0.26), rng.range(0.9, 2.4), 0.3, wz * 7 + 1),
            xform(wx + oz * rng.spread(along * 0.3), base + rng.range(1.8, 3.4), wz - ox * rng.spread(along * 0.3), face))
        }
      }
    }
  }
}

/**
 * Structural props that live between props and architecture: scaffolding,
 * lean-to shelters, and the wooden hoarding around a building site.
 */
export function buildStructures(b: Builder, rng: Rand): void {
  // Scaffold against the apartment's street facade — a climbable silhouette.
  b.push(-10.2, settleHeight(-10.2, 29.5, 1.2, 0.05), 29.5, 0)
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
  b.push(11.4, settleHeight(11.4, 25.6, 1.5, 0.05), 25.6, 0.8)
  for (const sx of [-1.4, 1.4]) {
    b.solid('woodBeam', 0.1, 2.3, 0.1, sx, 1.15, -1.1, 0, 0.015)
    b.solid('woodBeam', 0.1, 1.7, 0.1, sx, 0.85, 1.1, 0, 0.015)
  }
  b.geom('metalCorrugated', chamferBox(3.2, 0.05, 2.5, 0.02), xform(0, 2.0, 0, 0, 0.24))
  b.geom('tarp', chamferBox(0.05, 1.6, 2.3, 0.02), xform(-1.44, 0.8, 0))
  b.collide(3.0, 0.2, 2.4, 0, 2.0, 0, 0, 'thinMetal')
  b.pop()

  // Timber hoarding around a half-finished plot.
  b.push(-27.0, settleHeight(-27, 4.0, 1.7, 0.06), 4.0, 0.1)
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
    const y = settleHeight(x, z, 1.2, 0.06)
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
