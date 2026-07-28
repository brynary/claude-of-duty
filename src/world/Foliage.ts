import * as THREE from 'three'
import type { Rand } from '../core/Rand'
import type { MaterialService } from '../core/Types'
import {
  Builder, InstanceFarm, TriSoup, cylinderGeom, normalizeGeom, plainBox, valueNoise,
} from './Kit'
import { groundHeight, zoneMaterialAt } from './Terrain'
import { insideAnyBuilding, xform } from './Buildings'

/**
 * Dry Mediterranean planting: grass tufts, weeds pushing through cracks,
 * date palms and a couple of olive trees — all instanced, all animated by a
 * shared wind uniform injected into the foliage material.
 */

/** Two-sided tapered blade, curving away from vertical. */
function blade(s: TriSoup, dir: number, lean: number, h: number, w: number, curl: number, segs = 3): void {
  const dx = Math.cos(dir)
  const dz = Math.sin(dir)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const bend = lean * t * t + curl * t * t * t
    pts.push(new THREE.Vector3(dx * bend, h * t * (1 - 0.14 * t * t), dz * bend))
  }
  const nx = -dz
  const nz = dx
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs
    const t1 = (i + 1) / segs
    const w0 = (w * (1 - t0 * t0)) / 2
    const w1 = (w * (1 - t1 * t1)) / 2
    const a = pts[i].clone().addScaledVector(new THREE.Vector3(nx, 0, nz), w0)
    const b = pts[i].clone().addScaledVector(new THREE.Vector3(nx, 0, nz), -w0)
    const c = pts[i + 1].clone().addScaledVector(new THREE.Vector3(nx, 0, nz), -w1)
    const d = pts[i + 1].clone().addScaledVector(new THREE.Vector3(nx, 0, nz), w1)
    s.quadTwoSided(a, b, c, d)
  }
}

function tuftGeom(count: number, h: number, w: number, seed: number, lean = 0.18): THREE.BufferGeometry {
  const s = new TriSoup()
  for (let i = 0; i < count; i++) {
    const r1 = valueNoise(seed + i * 3.7, i * 1.3)
    const r2 = valueNoise(i * 2.1, seed - i * 4.4)
    const dir = (i / count) * Math.PI * 2 + r1 * 0.7
    blade(s, dir, lean * (0.6 + 0.8 * Math.abs(r2)), h * (0.65 + 0.45 * Math.abs(r1)), w, lean * 0.9, 2)
  }
  return s.toGeometry()
}

/** Broad-leaved weed clump, the kind that colonises a cracked pavement. */
function weedGeom(seed: number): THREE.BufferGeometry {
  const s = new TriSoup()
  for (let i = 0; i < 5; i++) {
    const r = valueNoise(seed + i * 5.1, i * 2.3)
    const dir = (i / 5) * Math.PI * 2 + r * 0.6
    blade(s, dir, 0.3 + Math.abs(r) * 0.25, 0.24 + Math.abs(r) * 0.18, 0.085, 0.16, 2)
  }
  return s.toGeometry()
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry()
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  for (const p of parts) {
    const pp = p.getAttribute('position')
    const nn = p.getAttribute('normal')
    const tt = p.getAttribute('uv')
    for (let i = 0; i < pp.count; i++) {
      pos.push(pp.getX(i), pp.getY(i), pp.getZ(i))
      nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i))
      uv.push(tt ? tt.getX(i) : 0, tt ? tt.getY(i) : 0)
    }
    p.dispose()
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return normalizeGeom(merged)
}

/** Date palm: a segmented, slightly leaning trunk with a crown of fronds. */
function palmGeom(seed: number, height: number): { trunk: THREE.BufferGeometry; fronds: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = []
  const segs = 11
  const lean = valueNoise(seed, seed * 1.7) * 0.16
  let y = 0
  let x = 0
  let z = 0
  for (let i = 0; i < segs; i++) {
    const t = i / segs
    const segH = height / segs
    const r = 0.28 - t * 0.11
    const c = cylinderGeom(r * 0.92, r, segH * 1.06, 8, false)
    const bend = lean * t * t * height
    parts.push(c.clone().applyMatrix4(xform(x + bend * 0.5, y + segH / 2, z + bend * 0.2, 0, 0, lean * t)))
    c.dispose()
    // Old frond bases ringing the trunk.
    if (i > 1 && i % 2 === 0) {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + i * 1.1
        parts.push(plainBox(0.1, 0.09, 0.14).applyMatrix4(
          xform(x + bend * 0.5 + Math.cos(a) * r, y + segH * 0.5, z + bend * 0.2 + Math.sin(a) * r, -a, 0.4)))
      }
    }
    y += segH
    x += bend * 0
    z += 0
  }
  const topX = lean * height * 0.5
  const s = new TriSoup()
  const fronds = 12
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + valueNoise(seed + i, i) * 0.4
    const droop = 0.35 + Math.abs(valueNoise(i * 3.3, seed)) * 0.9
    const len = 2.3 + valueNoise(seed * 2 + i, i * 1.7) * 0.6
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    const segsF = 4
    const pts: THREE.Vector3[] = []
    for (let k = 0; k <= segsF; k++) {
      const t = k / segsF
      pts.push(new THREE.Vector3(topX + dx * len * t, y + 0.25 + t * 0.75 - droop * t * t * 1.7, dz * len * t))
    }
    const nx = -dz
    const nz = dx
    for (let k = 0; k < segsF; k++) {
      const t0 = k / segsF
      const t1 = (k + 1) / segsF
      const w0 = 0.34 * Math.sin(Math.PI * Math.min(1, t0 * 1.4)) + 0.03
      const w1 = 0.34 * Math.sin(Math.PI * Math.min(1, t1 * 1.4)) + 0.03
      // Split each frond down the midrib and angle the halves for volume.
      for (const sgn of [-1, 1]) {
        const a0 = pts[k].clone()
        const a1 = pts[k + 1].clone()
        const b0 = pts[k].clone().addScaledVector(new THREE.Vector3(nx, -0.45, nz), sgn * w0)
        const b1 = pts[k + 1].clone().addScaledVector(new THREE.Vector3(nx, -0.45, nz), sgn * w1)
        s.quadTwoSided(a0, b0, b1, a1)
      }
    }
  }
  return { trunk: mergeParts(parts), fronds: normalizeGeom(s.toGeometry()) }
}

/** Canopy of an olive tree: overlapping crossed leaf cards. */
function canopyGeom(r: number, seed: number): THREE.BufferGeometry {
  const s = new TriSoup()
  for (let i = 0; i < 16; i++) {
    const a = valueNoise(seed + i * 2.7, i) * Math.PI * 2
    const b = valueNoise(i * 1.9, seed - i) * Math.PI
    const rr = r * (0.35 + 0.65 * Math.abs(valueNoise(i * 3.1, seed * 2)))
    const cx = Math.cos(a) * rr * 0.9
    const cy = Math.cos(b) * rr * 0.55
    const cz = Math.sin(a) * rr * 0.9
    const sz = r * 0.55
    const ang = a * 1.7
    const ux = Math.cos(ang) * sz
    const uz = Math.sin(ang) * sz
    s.quadTwoSided(
      new THREE.Vector3(cx - ux, cy - sz * 0.7, cz - uz),
      new THREE.Vector3(cx + ux, cy - sz * 0.7, cz + uz),
      new THREE.Vector3(cx + ux, cy + sz * 0.7, cz + uz),
      new THREE.Vector3(cx - ux, cy + sz * 0.7, cz - uz),
    )
  }
  return s.toGeometry()
}

export interface WindHandle {
  uniform: { value: number }
}

/**
 * Injects a vertex wind sway into the shared foliage/fabric materials without
 * clobbering whatever the material library already installed.
 */
export function applyWind(mats: MaterialService, names: string[]): WindHandle {
  const uniform = { value: 0 }
  for (const name of names) {
    const mat = mats.get(name) as THREE.Material
    if (mat.userData.__windApplied) continue
    mat.userData.__windApplied = true
    const prev = mat.onBeforeCompile.bind(mat)
    const strength = name === 'foliage' ? 0.09 : 0.016
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer)
      shader.uniforms.uWindTime = uniform
      // The sway amplitude is clamped so merged world-space geometry (palm
      // fronds, hanging cloth) cannot be flung across the map by its height.
      shader.vertexShader = `uniform float uWindTime;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 windOrigin = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
        #else
          vec3 windOrigin = position;
        #endif
        float windPhase = uWindTime * 1.45 + windOrigin.x * 0.42 + windOrigin.z * 0.31;
        float windUp = clamp(transformed.y, 0.0, 1.0);
        float windAmp = windUp * windUp * ${strength.toFixed(4)};
        float gust = 0.65 + 0.35 * sin(uWindTime * 0.37 + windOrigin.x * 0.05);
        transformed.x += (sin(windPhase) + 0.35 * sin(windPhase * 2.7 + 1.3)) * windAmp * gust;
        transformed.z += (cos(windPhase * 0.83 + 0.6)) * windAmp * 0.7 * gust;
        `,
      )
    }
    const key = mat.customProgramCacheKey.bind(mat)
    mat.customProgramCacheKey = () => `${key()}|wind`
    mat.needsUpdate = true
  }
  return { uniform }
}

/** Registers instanced foliage kinds. */
export function defineFoliageKinds(farm: InstanceFarm): void {
  farm.define('tuftA', tuftGeom(5, 0.42, 0.055, 3.1), 'foliage', false, true)
  farm.define('tuftB', tuftGeom(5, 0.3, 0.05, 9.7), 'foliage', false, true)
  farm.define('tuftDry', tuftGeom(4, 0.55, 0.04, 17.3, 0.32), 'foliage', false, true)
  farm.define('weed', weedGeom(23.9), 'foliage', false, true)
  farm.define('bush', canopyGeom(0.55, 5.5), 'foliage', true, true)
}

/**
 * Scatters ground cover. Growth concentrates against walls, along kerbs and in
 * the cracks of the paving — the places nobody walks.
 */
export function scatterFoliage(farm: InstanceFarm, rng: Rand, density: number): void {
  const target = Math.round(1150 * density)
  let placed = 0
  let guard = 0
  while (placed < target && guard < target * 12) {
    guard++
    const x = rng.range(-44, 44)
    const z = rng.range(-46, 46)
    if (insideAnyBuilding(x, z, 0.45)) continue
    const mat = zoneMaterialAt(x, z)
    // Growth probability by surface: nothing survives in the middle of a road.
    let p: number
    switch (mat) {
      case 'asphalt': p = 0.03; break
      case 'asphaltCracked': p = 0.1; break
      case 'cobblestone': p = 0.12; break
      case 'concreteWorn': p = 0.14; break
      case 'gravel': p = 0.34; break
      case 'dirt': p = 0.55; break
      default: p = 0.42
    }
    const clump = valueNoise(x * 0.14, z * 0.14)
    p *= 0.35 + Math.max(0, clump) * 1.5
    if (!rng.bool(p)) continue
    const y = groundHeight(x, z)
    const kind = mat === 'dirt' || mat === 'sand'
      ? rng.pick(['tuftA', 'tuftB', 'tuftDry', 'tuftDry'])
      : rng.pick(['weed', 'tuftB', 'weed'])
    farm.place(kind, x, y - 0.03, z, rng.range(0, Math.PI * 2), rng.range(0.7, 1.35), rng.spread(0.09), rng.spread(0.09))
    placed++
  }

  // Weeds hugging the wall bases, where run-off collects.
  for (let i = 0; i < Math.round(190 * density); i++) {
    const x = rng.range(-42, 42)
    const z = rng.range(-44, 44)
    if (insideAnyBuilding(x, z, 0.05)) continue
    if (!insideAnyBuilding(x, z, 0.95)) continue
    const y = groundHeight(x, z)
    farm.place(rng.pick(['weed', 'tuftA', 'tuftDry']), x, y - 0.02, z, rng.range(0, Math.PI * 2), rng.range(0.8, 1.4))
  }
}

interface TreeSite { x: number; z: number; h: number; palm: boolean }

/** Hand-placed trees: they are landmarks, not scatter. */
const TREES: TreeSite[] = [
  { x: -4.6, z: -12.4, h: 6.4, palm: true },
  { x: -15.4, z: -8.2, h: 7.2, palm: true },
  { x: -19.8, z: -20.6, h: 5.8, palm: true },
  { x: 2.6, z: -23.6, h: 6.8, palm: true },
  { x: -24.2, z: -6.4, h: 6.0, palm: true },
  { x: 15.6, z: -14.0, h: 7.0, palm: true },
  { x: -12.6, z: 14.6, h: 6.2, palm: true },
  { x: 27.5, z: 8.0, h: 6.6, palm: true },
  { x: -30.0, z: 27.0, h: 5.6, palm: true },
  { x: -7.4, z: -5.0, h: 3.4, palm: false },
  { x: -22.0, z: -12.0, h: 3.0, palm: false },
  { x: 6.0, z: 36.5, h: 3.2, palm: false },
  { x: -25.0, z: 36.0, h: 3.4, palm: false },
]

export function buildTrees(b: Builder, farm: InstanceFarm, rng: Rand): void {
  for (let i = 0; i < TREES.length; i++) {
    const t = TREES[i]
    const y = groundHeight(t.x, t.z)
    if (t.palm) {
      b.push(t.x, y - 0.1, t.z, rng.range(0, Math.PI * 2))
      const palm = palmGeom(i * 7.3 + 1, t.h)
      b.geom('woodBeam', palm.trunk)
      b.geom('foliage', palm.fronds)
      palm.trunk.dispose()
      palm.fronds.dispose()
      b.collide(0.55, t.h, 0.55, 0, t.h / 2, 0, 0, 'wood')
      b.pop()
      // A raised ring of kerbstones around the base, half buried in sand.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        b.box('stoneBlock', 0.5, 0.34, 0.24, t.x + Math.cos(a) * 0.85, y - 0.05, t.z + Math.sin(a) * 0.85, -a, 0.03)
      }
      for (let k = 0; k < 5; k++) {
        farm.place('tuftDry', t.x + rng.spread(0.6), y, t.z + rng.spread(0.6), rng.range(0, 3.1), rng.range(0.8, 1.3))
      }
    } else {
      b.push(t.x, y, t.z, rng.range(0, Math.PI * 2))
      const trunkH = t.h * 0.42
      b.geom('woodBeam', cylinderGeom(0.15, 0.26, trunkH, 8), new THREE.Matrix4().makeTranslation(0, trunkH / 2, 0))
      b.collide(0.4, trunkH, 0.4, 0, trunkH / 2, 0, 0, 'wood')
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4
        const len = t.h * 0.4
        b.geom('woodBeam', cylinderGeom(0.05, 0.1, len, 6),
          xform(Math.cos(a) * len * 0.25, trunkH + len * 0.35, Math.sin(a) * len * 0.25, -a, 0, 0.7))
        b.geom('foliage', canopyGeom(t.h * 0.3, i * 3 + k),
          xform(Math.cos(a) * len * 0.5, trunkH + len * 0.7, Math.sin(a) * len * 0.5))
      }
      b.geom('foliage', canopyGeom(t.h * 0.36, i * 11), new THREE.Matrix4().makeTranslation(0, trunkH + t.h * 0.32, 0))
      b.pop()
    }
  }
}
