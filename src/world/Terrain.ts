import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { surfaceOf, type MaterialName } from '../render/MaterialNames'
import type { MaterialService } from '../core/Types'
import type { Rand } from '../core/Rand'
import {
  Builder, KERB_H, type StaticPhysics, rotRectSdf, smoothstep, valueNoise, toLocalXZ,
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

interface Pothole { x: number; z: number; r: number; depth: number }

const POTHOLES: Pothole[] = [
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
