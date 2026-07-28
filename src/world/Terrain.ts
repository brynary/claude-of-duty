import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { surfaceOf, type MaterialName } from '../render/MaterialNames'
import type { MaterialService } from '../core/Types'
import type { Rand } from '../core/Rand'
import {
  ARRIS, Builder, KERB_H, TriSoup, chamferBox, cylinderGeom, plainBox,
  type StaticPhysics, rotRectSdf, smoothstep, valueNoise, toLocalXZ,
} from './Kit'

/**
 * Ground: a continuously displaced surface with paved zones cut into it,
 * kerbs, steps, potholes and camber. A flat plane is the loudest possible
 * signal that a level is a blockout, so nothing here is flat.
 *
 * The height field is a pure function of (x, z) so props, foliage and debris
 * can all sit on it exactly without a raycast.
 */

export interface GroundZone {
  name: string
  cx: number
  cz: number
  /** Half extents along the zone's local axes. */
  hw: number
  hd: number
  yaw: number
  mat: MaterialName
  /** Height offset relative to the base undulation. */
  lift: number
  /** Crown height at the centreline of a cambered carriageway. */
  camber: number
  /** Blend distance over which `lift` fades out at the zone edge. */
  feather: number
}

/** The district is laid out around these zones; buildings key off them too. */
export const ZONES: GroundZone[] = [
  // Market square, raised and cobbled.
  { name: 'plaza', cx: -10, cz: -13, hw: 15, hd: 13.5, yaw: 0, mat: 'cobblestone', lift: 0.17, camber: 0, feather: 0.65 },
  // Southern gate of the plaza feeding the market street.
  { name: 'gate', cx: -3, cz: 4.5, hw: 12, hd: 8, yaw: 0, mat: 'asphaltCracked', lift: 0.02, camber: 0.06, feather: 1.6 },
  // Two flanking routes.
  { name: 'street', cx: -3.4, cz: 23, hw: 7.6, hd: 13.5, yaw: 0, mat: 'asphaltCracked', lift: 0.0, camber: 0.09, feather: 1.5 },
  { name: 'alley', cx: 7.1, cz: 24, hw: 2.2, hd: 12, yaw: 0, mat: 'gravel', lift: 0.06, camber: 0, feather: 0.9 },
  { name: 'westlane', cx: -25, cz: 20, hw: 4.5, hd: 12, yaw: 0, mat: 'dirt', lift: 0.02, camber: 0, feather: 1.2 },
  // Demolished block, now a dirt lot.
  { name: 'lot', cx: 18.5, cz: 29.5, hw: 10, hd: 8.5, yaw: 0, mat: 'dirt', lift: -0.04, camber: 0, feather: 2.2 },
  // Road out of town, running toward the low sun.
  { name: 'highway', cx: 27, cz: 30.6, hw: 22, hd: 5.2, yaw: -0.349, mat: 'asphalt', lift: -0.02, camber: 0.11, feather: 1.8 },
  // Northern approach behind the mosque.
  { name: 'northroad', cx: -14, cz: -30.5, hw: 20, hd: 4.5, yaw: 0, mat: 'asphaltCracked', lift: 0.0, camber: 0.08, feather: 1.6 },
  { name: 'eastroad', cx: 20, cz: -8, hw: 5, hd: 16, yaw: 0, mat: 'asphaltCracked', lift: 0.0, camber: 0.08, feather: 1.6 },
]

export interface Pothole { x: number; z: number; r: number; depth: number }

export const POTHOLES: Pothole[] = [
  { x: -2.5, z: 17.0, r: 1.5, depth: 0.13 },
  { x: -6.2, z: 27.5, r: 1.9, depth: 0.16 },
  { x: 1.2, z: 8.0, r: 1.2, depth: 0.09 },
  { x: 16.5, z: 27.0, r: 2.4, depth: 0.2 },
  { x: 24.0, z: 30.6, r: 1.7, depth: 0.14 },
  { x: -12.0, z: 2.5, r: 1.4, depth: 0.1 },
  { x: 8.4, z: 21.5, r: 1.1, depth: 0.08 },
  { x: -20.0, z: -28.0, r: 2.0, depth: 0.15 },
]

/** Craters left by ordnance — deeper, with a raised lip. */
const CRATERS: Pothole[] = [
  { x: -8.0, z: -19.5, r: 3.4, depth: 0.55 },
  { x: 13.5, z: 32.5, r: 4.2, depth: 0.7 },
]

const _l2 = new THREE.Vector2()

/** Base undulation before any paving is applied. */
function baseHeight(x: number, z: number): number {
  return (
    valueNoise(x * 0.026, z * 0.026) * 0.34 +
    valueNoise(x * 0.083 + 11.4, z * 0.083 - 4.1) * 0.09 +
    valueNoise(x * 0.29 - 7.2, z * 0.29 + 3.6) * 0.022
  )
}

/**
 * Terrain height at a world position. Pure, cheap and deterministic — every
 * other generator uses it to seat props on the ground.
 */
export function groundHeight(x: number, z: number): number {
  let h = baseHeight(x, z)
  let lift = 0
  for (let i = 0; i < ZONES.length; i++) {
    const zn = ZONES[i]
    const d = rotRectSdf(x, z, zn.cx, zn.cz, zn.hw, zn.hd, zn.yaw)
    const w = 1 - smoothstep(-zn.feather, 0, d)
    if (w <= 0.001) continue
    let target = zn.lift
    if (zn.camber !== 0) {
      toLocalXZ(x, z, zn.cx, zn.cz, zn.yaw, _l2)
      const t = Math.min(1, Math.abs(_l2.y) / zn.hd)
      target += zn.camber * (1 - t * t)
    }
    lift = lift * (1 - w) + target * w
  }
  h += lift

  for (let i = 0; i < POTHOLES.length; i++) {
    const p = POTHOLES[i]
    const d = Math.hypot(x - p.x, z - p.z)
    if (d < p.r) h -= p.depth * (1 - smoothstep(0, p.r, d))
  }
  for (let i = 0; i < CRATERS.length; i++) {
    const p = CRATERS[i]
    const d = Math.hypot(x - p.x, z - p.z)
    if (d < p.r * 1.5) {
      // Bowl plus an ejecta lip so it reads as an impact, not a dent.
      h -= p.depth * (1 - smoothstep(0, p.r, d))
      h += p.depth * 0.28 * (smoothstep(p.r * 0.6, p.r, d) - smoothstep(p.r, p.r * 1.5, d))
    }
  }
  return h
}

/**
 * Height of the *rendered* ground triangle at (x, z).
 *
 * `groundHeight` is the analytic field; the terrain mesh samples it on a 1.6 m
 * grid and interpolates linearly between those samples. Over every convex bump
 * the drawn surface therefore sits *below* the analytic value — up to about
 * 4 cm — and a prop seated on `groundHeight` visibly hovers. Seating props on
 * the same interpolated surface the player can see removes that gap entirely.
 */
export function surfaceHeight(x: number, z: number): number {
  if (Math.abs(x) >= INNER || Math.abs(z) >= INNER) return groundHeight(x, z)
  const gx = (x + INNER) / INNER_CELL
  const gz = (z + INNER) / INNER_CELL
  const i = Math.floor(gx)
  const j = Math.floor(gz)
  const u = gx - i
  const v = gz - j
  const x0 = -INNER + i * INNER_CELL
  const z0 = -INNER + j * INNER_CELL
  const x1 = x0 + INNER_CELL
  const z1 = z0 + INNER_CELL
  const hA = groundHeight(x0, z0)
  const hD = groundHeight(x1, z1)
  // The grid emits (i,j)-(i,j+1)-(i+1,j+1) and (i,j)-(i+1,j+1)-(i+1,j); the
  // diagonal between them runs u == v.
  if (v >= u) {
    const hB = groundHeight(x0, z1)
    return hA + (hB - hA) * v + (hD - hB) * u
  }
  const hC = groundHeight(x1, z0)
  return hA + (hC - hA) * u + (hD - hC) * v
}

/**
 * The height a prop of footprint radius `radius` must sit at to touch the
 * ground everywhere. Takes the lowest rendered surface under the footprint and
 * bites `sink` into it, so contact edges disappear into the dirt rather than
 * hovering over a slope.
 */
export function settleHeight(x: number, z: number, radius = 0.35, sink = 0.02): number {
  let lo = surfaceHeight(x, z)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const h = surfaceHeight(x + Math.cos(a) * radius, z + Math.sin(a) * radius)
    if (h < lo) lo = h
  }
  return lo - sink
}

const _n = new THREE.Vector3()

/** Analytic-ish surface normal, from central differences of the height field. */
export function groundNormal(x: number, z: number, out = _n): THREE.Vector3 {
  const e = 0.45
  const hx = groundHeight(x + e, z) - groundHeight(x - e, z)
  const hz = groundHeight(x, z + e) - groundHeight(x, z - e)
  return out.set(-hx, 2 * e, -hz).normalize()
}

/** Which paving a point sits on, with noisy edges so the joins are not straight. */
export function zoneMaterialAt(x: number, z: number): MaterialName {
  let best: MaterialName = 'sand'
  const wobble = valueNoise(x * 0.16, z * 0.16) * 0.85 + valueNoise(x * 0.5, z * 0.5) * 0.3
  for (let i = 0; i < ZONES.length; i++) {
    const zn = ZONES[i]
    const d = rotRectSdf(x, z, zn.cx, zn.cz, zn.hw, zn.hd, zn.yaw) + wobble
    if (d < 0) best = zn.mat
  }
  if (best === 'asphalt' || best === 'asphaltCracked') {
    // Wind-blown sand and worn patches break up the carriageway.
    const s = valueNoise(x * 0.11 + 40, z * 0.11 - 22)
    if (s > 0.52) return 'sand'
    if (s < -0.58) return 'concreteWorn'
  } else if (best === 'sand') {
    const s = valueNoise(x * 0.07 - 61, z * 0.07 + 18)
    if (s > 0.44) return 'dirt'
    if (s < -0.55) return 'gravel'
  } else if (best === 'cobblestone') {
    const s = valueNoise(x * 0.13 + 3, z * 0.13 + 71)
    if (s > 0.62) return 'sand'
    if (s < -0.66) return 'concreteWorn'
  }
  return best
}

interface GridBucket {
  pos: number[]
  nrm: number[]
  uv: number[]
}

function buildGrid(min: number, max: number, cell: number, skipInner: number): Map<MaterialName, GridBucket> {
  const buckets = new Map<MaterialName, GridBucket>()
  const n = Math.round((max - min) / cell)
  // Heights and normals are shared between the four cells touching a vertex;
  // sampling them once keeps terrain generation off the init critical path.
  const stride = n + 1
  const hs = new Float32Array(stride * stride)
  const ns = new Float32Array(stride * stride * 3)
  const tmpN = new THREE.Vector3()
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = min + i * cell
      const z = min + j * cell
      const k = i * stride + j
      hs[k] = groundHeight(x, z)
      groundNormal(x, z, tmpN)
      ns[k * 3] = tmpN.x
      ns[k * 3 + 1] = tmpN.y
      ns[k * 3 + 2] = tmpN.z
    }
  }
  const push = (b: GridBucket, i: number, j: number) => {
    const k = i * stride + j
    b.pos.push(min + i * cell, hs[k], min + j * cell)
    b.nrm.push(ns[k * 3], ns[k * 3 + 1], ns[k * 3 + 2])
    b.uv.push(min + i * cell, min + j * cell)
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = min + i * cell
      const z0 = min + j * cell
      const x1 = x0 + cell
      const z1 = z0 + cell
      if (skipInner > 0) {
        const inside =
          Math.max(Math.abs(x0), Math.abs(x1)) <= skipInner &&
          Math.max(Math.abs(z0), Math.abs(z1)) <= skipInner
        if (inside) continue
      }
      const mat = zoneMaterialAt(x0 + cell * 0.5, z0 + cell * 0.5)
      let b = buckets.get(mat)
      if (!b) {
        b = { pos: [], nrm: [], uv: [] }
        buckets.set(mat, b)
      }
      push(b, i, j)
      push(b, i, j + 1)
      push(b, i + 1, j + 1)
      push(b, i, j)
      push(b, i + 1, j + 1)
      push(b, i + 1, j)
    }
  }
  return buckets
}

function bucketToGeometry(b: GridBucket): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2))
  g.computeBoundingSphere()
  return g
}

export interface TerrainResult {
  meshes: THREE.Mesh[]
  triangles: number
}

const INNER = 56
const INNER_CELL = 1.6
const OUTER = 152
const OUTER_CELL = 8
const COLLISION_CELL = 3.2

/**
 * Builds the visual terrain (fine) plus a coarser collision copy, and drops a
 * low-resolution skirt out to the horizon so the ground never ends in mid-air.
 */
export function buildTerrain(
  root: THREE.Object3D,
  mats: MaterialService,
  physics: StaticPhysics,
): TerrainResult {
  const meshes: THREE.Mesh[] = []
  let triangles = 0

  const inner = buildGrid(-INNER, INNER, INNER_CELL, 0)
  for (const [mat, b] of inner) {
    const g = bucketToGeometry(b)
    const mesh = new THREE.Mesh(g, mats.get(mat))
    mesh.name = `terrain:${mat}`
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.userData.surface = surfaceOf(mat)
    root.add(mesh)
    meshes.push(mesh)
    triangles += b.pos.length / 9
  }

  const outer = buildGrid(-OUTER, OUTER, OUTER_CELL, INNER)
  const outerGeoms: THREE.BufferGeometry[] = []
  for (const [mat, b] of outer) {
    // The skirt is far away and hazy; one material keeps it to one draw call.
    void mat
    outerGeoms.push(bucketToGeometry(b))
  }
  if (outerGeoms.length > 0) {
    const merged = outerGeoms.length === 1 ? outerGeoms[0] : mergeGeometries(outerGeoms, false)
    if (merged) {
      const skirt = new THREE.Mesh(merged, mats.get('sand'))
      skirt.name = 'terrain:skirt'
      skirt.receiveShadow = false
      skirt.castShadow = false
      skirt.matrixAutoUpdate = false
      skirt.userData.surface = 'sand'
      root.add(skirt)
      meshes.push(skirt)
      triangles += merged.getAttribute('position').count / 3
    }
  }

  // Collision uses a coarser copy of the same height field — under 5 cm off
  // the visual surface, at a fifth of the trimesh cost.
  const colGrid = buildGrid(-INNER, INNER, COLLISION_CELL, 0)
  for (const [mat, b] of colGrid) {
    const g = bucketToGeometry(b)
    const proxy = new THREE.Mesh(g)
    proxy.name = `terrainCollision:${mat}`
    proxy.updateMatrixWorld(true)
    physics.addStatic(proxy, surfaceOf(mat))
    g.dispose()
  }

  // Safety floor well below the playable surface, so nothing can fall forever.
  physics.addStaticBox(
    new THREE.Vector3(0, -6, 0),
    new THREE.Vector3(200, 2, 200),
    new THREE.Quaternion(),
    'sand',
  )

  return { meshes, triangles }
}

// ---------------------------------------------------------------------------
// Kerbs, steps and thresholds
// ---------------------------------------------------------------------------

export interface KerbLine {
  x0: number
  z0: number
  x1: number
  z1: number
  mat?: MaterialName
}

/** Kerb runs framing the paved zones. Tops sit flush so nothing trips the player. */
export const KERBS: KerbLine[] = [
  // Plaza perimeter (three sides; the south side opens to the gate).
  { x0: -25.0, z0: -26.4, x1: 5.0, z1: -26.4 },
  { x0: -25.0, z0: -26.4, x1: -25.0, z1: 0.4 },
  { x0: 5.0, z0: -26.4, x1: 5.0, z1: -6.0 },
  { x0: 5.0, z0: -2.0, x1: 5.0, z1: 0.4 },
  // Market street pavements.
  { x0: -11.0, z0: 10.0, x1: -11.0, z1: 36.0 },
  { x0: 4.2, z0: 12.0, x1: 4.2, z1: 36.0 },
  // Highway shoulders.
  { x0: 8.0, z0: 24.3, x1: 45.0, z1: 37.8, mat: 'concreteWorn' },
  { x0: 10.0, z0: 34.2, x1: 46.0, z1: 47.0, mat: 'concreteWorn' },
  // North road.
  { x0: -34.0, z0: -35.4, x1: 6.0, z1: -35.4 },
  { x0: -34.0, z0: -25.6, x1: -26.0, z1: -25.6 },
]

/** Lays kerb stones along each run with per-stone jitter and a few gaps. */
export function buildKerbs(b: Builder, rng: Rand): void {
  for (const line of KERBS) {
    const dx = line.x1 - line.x0
    const dz = line.z1 - line.z0
    const len = Math.hypot(dx, dz)
    if (len < 0.1) continue
    const yaw = Math.atan2(-dz, dx)
    const stone = 0.92
    const count = Math.max(1, Math.round(len / stone))
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count
      const x = line.x0 + dx * t
      const z = line.z0 + dz * t
      if (rng.bool(0.07)) continue // missing stones, kicked out over the years
      const h = KERB_H + rng.range(-0.015, 0.025)
      const y = groundHeight(x, z) + h * 0.5 - 0.03
      b.box(
        line.mat ?? 'stoneBlock',
        stone * 0.94, h + 0.34, 0.22,
        x, y - 0.17, z,
        yaw + rng.spread(0.018),
        0.022,
      )
    }
  }
}

/** A flight of exterior steps cut into the ground. */
export function buildSteps(
  b: Builder,
  x: number, z: number, yaw: number,
  width: number, steps: number, rise: number, run: number,
  mat: MaterialName = 'concreteWorn',
): void {
  const base = groundHeight(x, z)
  b.push(x, base, z, yaw)
  const buried = 0.45
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise
    const h = top + buried
    b.solid(mat, width, h, run, 0, top - h * 0.5, -(i + 0.5) * run, 0, 0.02)
  }
  b.pop()
}

// ---------------------------------------------------------------------------
// Modelled paving
// ---------------------------------------------------------------------------

/**
 * The ground is the one surface every graded frame devotes its lower third to,
 * and a displaced height field alone leaves it as an untextured expanse: the
 * terrain grid samples at 1.6 m, so nothing on it varies faster than a metre
 * and the whole plane collapses to one value at gameplay distance.
 *
 * This lays the market square and the alley as real stone. Each flag is its own
 * solid with a chamfered arris, a 1.5 cm joint around it and a top surface a
 * centimetre off its neighbours', which buys three things at once: a
 * lit/shaded edge every 40 cm, a dark joint line that survives to 40 m, and —
 * because adjacent flags draw from four different materials chosen by low
 * frequency noise — a genuine albedo step at exactly the scale an 8 px block
 * measures. None of that is achievable with a tone curve or with more terrain
 * subdivision.
 */
interface PaveZone {
  x0: number
  x1: number
  z0: number
  z1: number
  /** Nominal course depth and stone length, in metres. */
  course: number
  len: number
  joint: number
  /** How far the proudest stone stands above the field. */
  relief: number
  /** Bare ground shows through where the surface has worn away. */
  bald: number
}

const PAVE_ZONES: PaveZone[] = [
  // The market square, laid in courses running east-west.
  { x0: -25.4, x1: 5.2, z0: -26.6, z1: 0.8, course: 0.46, len: 0.58, joint: 0.017, relief: 0.013, bald: 0.5 },
  // The alley: smaller setts, and a lot more of them missing.
  { x0: 4.65, x1: 9.6, z0: 11.0, z1: 35.4, course: 0.3, len: 0.36, joint: 0.014, relief: 0.011, bald: 0.62 },
  // The gate, where old setts still show through the tarmac that covered them.
  { x0: -11.4, x1: 9.6, z0: 4.6, z1: 13.6, course: 0.4, len: 0.48, joint: 0.016, relief: 0.012, bald: 0.3 },
  // Trench reinstatements down the market street. A carriageway that has never
  // been dug up is a carriageway nobody has ever laid a service under, and the
  // patch edges are the only thing breaking 400 m2 of road surface.
  { x0: -6.8, x1: -2.0, z0: 15.6, z1: 19.2, course: 0.38, len: 0.44, joint: 0.015, relief: 0.011, bald: 0.12 },
  { x0: -1.4, x1: 3.4, z0: 23.6, z1: 27.0, course: 0.36, len: 0.42, joint: 0.015, relief: 0.011, bald: 0.12 },
  { x0: -9.6, x1: -4.8, z0: 28.8, z1: 32.6, course: 0.4, len: 0.5, joint: 0.016, relief: 0.012, bald: 0.15 },
  { x0: -8.0, x1: -3.4, z0: 34.0, z1: 36.4, course: 0.36, len: 0.4, joint: 0.014, relief: 0.011, bald: 0.12 },
]

/**
 * One paving flag: chamfered top, then a short skirt so a raised stone never
 * shows daylight under its own arris.
 *
 * Wound by hand rather than through `chamferBox` because at four thousand
 * stones the difference between 18 triangles and 44 is the difference between
 * this being free and this being a budget item.
 */
function emitFlag(
  s: TriSoup,
  x0: number, x1: number, z0: number, z1: number,
  top: number, bev: number, skirt: number,
): void {
  const ix0 = x0 + bev
  const ix1 = x1 - bev
  const iz0 = z0 + bev
  const iz1 = z1 - bev
  if (ix1 - ix0 < 0.02 || iz1 - iz0 < 0.02) return
  const yb = top - bev
  const yd = top - skirt
  // TriSoup copies out of these, so twelve scratch vectors serve every flag on
  // the map rather than six thousand allocations at load.
  const I00 = _f[0].set(ix0, top, iz0)
  const I10 = _f[1].set(ix1, top, iz0)
  const I11 = _f[2].set(ix1, top, iz1)
  const I01 = _f[3].set(ix0, top, iz1)
  const O00 = _f[4].set(x0, yb, z0)
  const O10 = _f[5].set(x1, yb, z0)
  const O11 = _f[6].set(x1, yb, z1)
  const O01 = _f[7].set(x0, yb, z1)
  // Top face, wound counter-clockwise seen from above.
  s.quad(I00, I01, I11, I10, false)
  // Chamfer ring, then the skirt, both wound clockwise from above so their
  // normals face outward and slightly up.
  s.quad(I00, I10, O10, O00, false)
  s.quad(I10, I11, O11, O10, false)
  s.quad(I11, I01, O01, O11, false)
  s.quad(I01, I00, O00, O01, false)
  const D00 = _f[8].set(x0, yd, z0)
  const D10 = _f[9].set(x1, yd, z0)
  const D11 = _f[10].set(x1, yd, z1)
  const D01 = _f[11].set(x0, yd, z1)
  s.quad(O00, O10, D10, D00, false)
  s.quad(O10, O11, D11, D10, false)
  s.quad(O11, O01, D01, D11, false)
  s.quad(O01, O00, D00, D01, false)
}

const _f: THREE.Vector3[] = Array.from({ length: 12 }, () => new THREE.Vector3())

/** Which stone a flag is cut from. Clustered, so repairs read as patches. */
function flagMaterial(x: number, z: number): MaterialName {
  const macro = valueNoise(x * 0.075 + 21, z * 0.075 - 13)
  if (macro > 0.54) return 'asphaltCracked' // a tarmac repair over the setts
  if (macro < -0.62) return 'concreteWorn' // a poured concrete patch
  const fine = valueNoise(x * 0.62 + 3.3, z * 0.62 + 7.1)
  if (fine > 0.34) return 'stoneBlock'
  if (fine < -0.46) return 'concreteWorn'
  return 'cobblestone'
}

/**
 * Lays the modelled paving, the gutter channels beside the kerbs and the
 * ironwork sunk into it.
 *
 * `blocked` is passed in rather than imported so this module stays free of a
 * cycle with the building list.
 */
export function buildPaving(
  b: Builder,
  rng: Rand,
  blocked: (x: number, z: number, margin?: number) => boolean,
): void {
  const soups = new Map<MaterialName, TriSoup>()
  const soupFor = (m: MaterialName): TriSoup => {
    let s = soups.get(m)
    if (!s) {
      s = new TriSoup()
      soups.set(m, s)
    }
    return s
  }

  for (const zn of PAVE_ZONES) {
    let z = zn.z0
    while (z < zn.z1) {
      // Course depths walk, so the horizontal joints are never a ruled grid.
      const depth = zn.course * rng.range(0.82, 1.2)
      const zc0 = z
      const zc1 = Math.min(zn.z1, z + depth)
      // Running bond: every course starts on its own foot.
      let x = zn.x0 - rng.range(0, zn.len)
      while (x < zn.x1) {
        const len = zn.len * rng.range(0.62, 1.45)
        const fx0 = Math.max(zn.x0, x)
        const fx1 = Math.min(zn.x1, x + len)
        x += len
        if (fx1 - fx0 < 0.1 || zc1 - zc0 < 0.1) continue
        const cx = (fx0 + fx1) / 2
        const cz = (zc0 + zc1) / 2
        if (blocked(cx, cz, 0.15)) continue
        // Where the terrain shader has already gone to sand or dirt the
        // paving has worn out; leaving those flags off is what stops the
        // field reading as a tiled rectangle with hard edges.
        const under = zoneMaterialAt(cx, cz)
        if ((under === 'sand' || under === 'dirt' || under === 'gravel') && rng.bool(zn.bald)) continue
        if (rng.bool(0.035)) continue // a stone lifted and never replaced
        // A flag is a rigid plane laid on a surface that is not one, so it
        // needs its own bed height: seated on the centre sample, the ground
        // pushes up through the downhill half of every stone on a slope. Where
        // the four corners disagree by more than about 5 cm the paving has long
        // since broken up — around the crater, at the lip of the raised square —
        // and leaving those flags off is what feathers the field into bare
        // ground instead of ending it on a ruled line.
        const hx = (fx1 - fx0) / 2 - 0.02
        const hz = (zc1 - zc0) / 2 - 0.02
        let hi = -Infinity
        let lo = Infinity
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const h = surfaceHeight(cx + sx * hx, cz + sz * hz)
            if (h > hi) hi = h
            if (h < lo) lo = h
          }
        }
        if (hi - lo > 0.055) continue
        if (hi - lo > 0.03 && rng.bool(0.5)) continue
        const j = zn.joint * rng.range(0.7, 1.4)
        // Biased toward the high corner, not sat on it. A stone bedded on its
        // highest corner stands its whole height-difference proud on the low
        // side and the square reads as a field of loose blocks; letting the
        // ground bury a centimetre of the uphill edge is what real paving does.
        let top = hi * 0.62 + lo * 0.38 + zn.relief * rng.range(0.2, 1.0)
        if (rng.bool(0.07)) top -= zn.relief * rng.range(0.9, 2.0)
        // Each stone's own outline wobbles, so the courses never resolve into a
        // ruled grid at distance.
        const wx = zn.joint * rng.range(0, 0.9)
        const wz = zn.joint * rng.range(0, 0.9)
        emitFlag(
          soupFor(flagMaterial(cx, cz)),
          fx0 + j / 2 + wx, fx1 - j / 2 + wx * 0.4, zc0 + j / 2 + wz, zc1 - j / 2 + wz * 0.4,
          top, Math.min(0.01, zn.relief * 0.7), 0.09,
        )
      }
      z = zc1
    }
  }

  // Gutter channels: a run of narrow, dished stones hard against the kerb.
  // A carriageway that meets its kerb on a ruled line is the loudest thing
  // left on a street once the paving itself has relief.
  for (const line of KERBS) {
    const dx = line.x1 - line.x0
    const dz = line.z1 - line.z0
    const len = Math.hypot(dx, dz)
    if (len < 2) continue
    const nx = -dz / len
    const nz = dx / len
    const n = Math.round(len / 0.62)
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n
      const px = line.x0 + dx * t + nx * 0.3
      const pz = line.z0 + dz * t + nz * 0.3
      if (blocked(px, pz, 0.1)) continue
      const s = soupFor(i % 5 === 0 ? 'concreteWorn' : 'stoneBlock')
      const half = 0.19
      const along = (len / n) * 0.46
      // Axis-aligned footprint oriented to whichever way the run leads.
      const wx = Math.abs(dx) > Math.abs(dz) ? along : half
      const wz = Math.abs(dx) > Math.abs(dz) ? half : along
      // Highest corner again: a channel stone that lets the carriageway push
      // through it is worse than no channel at all.
      let top = -Infinity
      let low = Infinity
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const h = surfaceHeight(px + sx * wx, pz + sz * wz)
          if (h > top) top = h
          if (h < low) low = h
        }
      }
      if (top - low > 0.07) continue
      emitFlag(s, px - wx, px + wx, pz - wz, pz + wz, top - 0.004, 0.014, 0.09)
    }
  }

  for (const [m, s] of soups) {
    if (s.triangleCount === 0) continue
    b.geom(m, s.toGeometry())
  }
}

/** Ironwork sunk into the paving: gully gratings and manhole covers. */
export function buildDrainage(b: Builder, rng: Rand): void {
  // Gullies sit in the gutter line where water would actually collect.
  const gullies: [number, number, number][] = [
    [4.6, -6.2, 0], [4.6, -19.4, 0], [-24.6, -9.0, 0], [-24.6, -21.6, 0],
    [-10.6, 14.6, 0], [-10.6, 26.2, 0], [4.0, 18.4, 0], [4.0, 30.6, 0],
    [7.05, 22.2, 0], [-2.0, 6.4, Math.PI / 2], [21.4, 27.6, -0.349],
  ]
  for (const [x, z, yaw] of gullies) {
    b.push(x, surfaceHeight(x, z) + 0.005, z, yaw)
    // Kerb-side frame, then five bars over a dark void. The void plate has to
    // finish a few millimetres *above* the terrain, not below it: sunk under
    // the ground plane it is invisible and the grating reads as five bars
    // lying on the road rather than as a hole in it.
    b.slab('concreteWorn', 0.62, 0.075, 0.44, 0, -0.026, 0)
    b.plate('asphalt', 0.5, 0.09, 0.32, 0, -0.043, 0)
    for (let i = 0; i < 5; i++) {
      b.slab('metalRusted', 0.44, 0.035, 0.03, 0, 0.006, -0.13 + i * 0.065)
    }
    b.slab('metalRusted', 0.03, 0.035, 0.34, -0.22, 0.006, 0)
    b.slab('metalRusted', 0.03, 0.035, 0.34, 0.22, 0.006, 0)
    b.pop()
  }
  // Manhole covers: a rebated frame, a ribbed disc and a lifting slot.
  const covers: [number, number][] = [
    [-8.4, -10.6], [-14.8, -18.2], [-3.6, -22.4], [-5.2, 19.0],
    [-1.8, 28.8], [6.9, 17.4], [14.2, 26.4], [24.8, 31.4], [-18.4, -4.6],
  ]
  for (const [x, z] of covers) {
    const y = surfaceHeight(x, z) + 0.004
    const yaw = rng.range(0, Math.PI * 2)
    b.push(x, y, z, yaw)
    b.geom('concreteWorn', cylinderGeom(0.46, 0.5, 0.14, 16), _tf(0, -0.06, 0))
    b.geom('metalRusted', cylinderGeom(0.39, 0.4, 0.05, 16), _tf(0, 0.008, 0))
    // Raised diamond pattern on the lid — eight ribs is enough to read.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI
      b.geom('metalRusted', plainBox(0.7, 0.014, 0.028), _tf(0, 0.036, 0, a))
    }
    b.geom('metalRusted', chamferBox(0.1, 0.02, 0.04, ARRIS), _tf(0.26, 0.04, 0))
    b.pop()
  }
}

const _tfQ = new THREE.Quaternion()
const _tfP = new THREE.Vector3()
const _tfS = new THREE.Vector3(1, 1, 1)

/** Local translate + yaw, without pulling in the buildings module. */
function _tf(x: number, y: number, z: number, yaw = 0): THREE.Matrix4 {
  _tfQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  return new THREE.Matrix4().compose(_tfP.set(x, y, z), _tfQ, _tfS)
}
