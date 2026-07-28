import * as THREE from 'three'
import type { MaterialService } from '../core/Types'
import { Rand } from '../core/Rand'

/**
 * Procedural soldier construction.
 *
 * There are no model files, so the character is authored in code: a real bone
 * hierarchy plus a lofted body skinned to it. Two ideas make this tractable.
 *
 * 1. **The bind pose is the gameplay pose.** Bones are declared by their world
 *    position in a rifle-ready stance with every bind rotation identity. That
 *    makes bone inverses trivial (a negative translation), lets the rifle be
 *    authored in place rather than transplanted, and keeps skin deformation
 *    close to bind for the poses that actually get seen.
 * 2. **Weights come from bone segments.** Each surface part names a small set of
 *    candidate bones; a vertex takes the two nearest segments by inverse-power
 *    distance. Joints blend automatically, and there is no weight painting.
 *
 * The whole body merges into one BufferGeometry with one material group per
 * material name, so a soldier is six draw calls and every soldier shares the
 * same geometry — only the Skeleton is per-instance.
 *
 * Facing convention: the model looks down **+Z**, so its left hand is at +X.
 */

export const BONE_ORDER = [
  'root', 'pelvis', 'spine01', 'spine02', 'chest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'lowerArmL', 'handL',
  'clavicleR', 'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
] as const

export type BoneName = (typeof BONE_ORDER)[number]

interface BindDef {
  parent: BoneName | null
  /** World-space position in the bind pose. Bind rotation is always identity. */
  p: readonly [number, number, number]
}

/**
 * A 1.80 m soldier, seven and a half heads tall. Hip joint 0.90, shoulder 1.43,
 * chin 1.53, crown 1.78 — the proportions of a real adult male, because getting
 * these wrong is the single most legible failure in a character.
 */
export const BIND: Record<BoneName, BindDef> = {
  root: { parent: null, p: [0, 0, 0] },
  pelvis: { parent: 'root', p: [0, 0.95, 0] },
  spine01: { parent: 'pelvis', p: [0, 1.06, -0.005] },
  spine02: { parent: 'spine01', p: [0, 1.19, 0] },
  chest: { parent: 'spine02', p: [0, 1.33, 0.005] },
  neck: { parent: 'chest', p: [0, 1.5, -0.01] },
  head: { parent: 'neck', p: [0, 1.585, 0.012] },

  clavicleL: { parent: 'chest', p: [0.045, 1.435, 0.012] },
  upperArmL: { parent: 'clavicleL', p: [0.185, 1.425, 0] },
  lowerArmL: { parent: 'upperArmL', p: [0.155, 1.16, 0.1] },
  handL: { parent: 'lowerArmL', p: [-0.02, 1.16, 0.3] },

  clavicleR: { parent: 'chest', p: [-0.045, 1.435, 0.012] },
  upperArmR: { parent: 'clavicleR', p: [-0.185, 1.425, 0] },
  lowerArmR: { parent: 'upperArmR', p: [-0.29, 1.2, -0.13] },
  handR: { parent: 'lowerArmR', p: [-0.115, 1.13, 0.045] },

  thighL: { parent: 'pelvis', p: [0.095, 0.9, 0] },
  shinL: { parent: 'thighL', p: [0.095, 0.465, 0.035] },
  footL: { parent: 'shinL', p: [0.095, 0.075, -0.005] },
  toeL: { parent: 'footL', p: [0.095, 0.045, 0.145] },

  thighR: { parent: 'pelvis', p: [-0.095, 0.9, 0] },
  shinR: { parent: 'thighR', p: [-0.095, 0.465, 0.035] },
  footR: { parent: 'shinR', p: [-0.095, 0.075, -0.005] },
  toeR: { parent: 'footR', p: [-0.095, 0.045, 0.145] },
}

/** Bone tail for bones with no child, so every bone has a segment. */
const TAIL: Partial<Record<BoneName, readonly [number, number, number]>> = {
  head: [0, 1.78, 0.012],
  handL: [-0.075, 1.205, 0.375],
  handR: [-0.09, 1.19, 0.115],
  toeL: [0.095, 0.04, 0.2],
  toeR: [-0.095, 0.04, 0.2],
}

export type CharMaterial = 'skin' | 'uniform' | 'webbing' | 'helmet' | 'bootLeather' | 'gunmetal'

const MATERIAL_ORDER: CharMaterial[] = ['uniform', 'webbing', 'helmet', 'skin', 'bootLeather', 'gunmetal']

/** Base colours applied to the cloned materials; vertex colours modulate them. */
const BASE_COLOR: Record<CharMaterial, number> = {
  skin: 0xffffff,
  uniform: 0xffffff,
  webbing: 0xffffff,
  helmet: 0xffffff,
  bootLeather: 0xffffff,
  gunmetal: 0xffffff,
}

// --------------------------------------------------------------------------
// Noise
// --------------------------------------------------------------------------

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(Math.floor(x * 1013), 0x27d4eb2d)
  h ^= Math.imul(Math.floor(y * 1013) + 0x9e3779b9, 0x85ebca6b)
  h ^= Math.imul(Math.floor(z * 1013) + 0x7f4a7c15, 0xc2b2ae35)
  h ^= h >>> 15
  return ((h >>> 0) % 65536) / 65536
}

function smoothNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const w = zf * zf * (3 - 2 * zf)
  let acc = 0
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const wgt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
        acc += wgt * hash3(xi + dx, yi + dy, zi + dz)
      }
    }
  }
  return acc
}

function fbm(x: number, y: number, z: number, octaves = 3): number {
  let a = 0.5
  let f = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += a * smoothNoise(x * f, y * f, z * f)
    norm += a
    a *= 0.5
    f *= 2.07
  }
  return sum / norm
}

// --------------------------------------------------------------------------
// Camo / colour authoring
// --------------------------------------------------------------------------

export interface Palette {
  camo: [THREE.Color, THREE.Color, THREE.Color]
  camoScale: number
  webbing: THREE.Color
  helmet: THREE.Color
  boot: THREE.Color
  skin: THREE.Color
  gun: THREE.Color
  gunPolymer: THREE.Color
}

/**
 * Colours are authored in sRGB and land in linear working space, where they get
 * roughly four times darker. These values are picked so the darkest crevice
 * still sits above ~0.03 linear — a soldier that resolves to a black cut-out
 * against a bright sky is the classic failure of hand-picked character albedo.
 */
export function makePalette(rng: Rand): Palette {
  const scheme = rng.int(0, 2)
  const camo: [THREE.Color, THREE.Color, THREE.Color] =
    scheme === 0
      ? [new THREE.Color(0x74705a), new THREE.Color(0x968d6c), new THREE.Color(0x585746)] // woodland-arid
      : scheme === 1
        ? [new THREE.Color(0x8c8265), new THREE.Color(0xa89b7a), new THREE.Color(0x6b6149)] // desert
        : [new THREE.Color(0x646b55), new THREE.Color(0x7c8468), new THREE.Color(0x4a5040)] // olive
  // Load-bearing kit is a plain colour from the opposite family to the uniform
  // — coyote brown over green camo, ranger green over tan — because that is how
  // real loadouts are issued and because the hue break is what keeps carrier,
  // pouches, gloves and knee pads from merging into the sleeve once the light
  // drops. It is matched in value to the camo's own shadow tone rather than
  // pushed darker: buying the separation with another stop of black is how you
  // end up with the featureless silhouette this palette exists to avoid.
  const kit = scheme === 1 ? new THREE.Color(0x585e4c) : new THREE.Color(0x6a5647)
  return {
    camo,
    camoScale: rng.range(11, 15),
    webbing: new THREE.Color().copy(kit).multiplyScalar(rng.range(0.9, 1.1)),
    // The helmet cover sits between uniform and kit in value so the head reads
    // as its own shape against the shoulders at gameplay distance. At 0.88 it
    // was within a fifth of a stop of the uniform and the two ran together.
    helmet: new THREE.Color().copy(camo[0]).multiplyScalar(0.74),
    boot: new THREE.Color(0x4a4238).multiplyScalar(rng.range(0.88, 1.15)),
    skin: new THREE.Color().setHSL(0.072, rng.range(0.3, 0.44), rng.range(0.4, 0.56)),
    gun: new THREE.Color(0x565a60),
    gunPolymer: new THREE.Color(0x494b41),
  }
}

// --------------------------------------------------------------------------
// Mesh builder
// --------------------------------------------------------------------------

interface Ring {
  x: number
  y: number
  z: number
  rx: number
  rz: number
  /** Superellipse exponent: 2 is a true ellipse, 4+ is a rounded rectangle. */
  n?: number
  /** Extra roll of the cross-section about the path tangent, radians. */
  roll?: number
}

interface PartOpts {
  mat: CharMaterial
  /** Candidate bones for skin weighting, most specific first. */
  bones: BoneName[]
  /** Per-candidate weight bias, defaults to 1. */
  bias?: number[]
  /** Base albedo; camo is generated when omitted and the material is uniform. */
  color?: THREE.Color
  /** Extra darkening applied on top of the ambient-occlusion estimate. */
  dark?: number
  /** How tightly vertices snap to the nearest bone. Higher is more rigid. */
  rigidity?: number
  /** Grime accumulates toward the bottom of the body. */
  grime?: number
}

interface SubMesh {
  pos: number[]
  nrm: number[]
  uv: number[]
  col: number[]
  si: number[]
  sw: number[]
  idx: number[]
}

const V_A = new THREE.Vector3()
const V_B = new THREE.Vector3()
const V_C = new THREE.Vector3()
const V_D = new THREE.Vector3()

/** Squared distance from p to segment ab. */
function distSqToSegment(px: number, py: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = px - a.x
  const apy = py - a.y
  const apz = pz - a.z
  const denom = abx * abx + aby * aby + abz * abz
  let t = denom > 1e-9 ? (apx * abx + apy * aby + apz * abz) / denom : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = apx - abx * t
  const dy = apy - aby * t
  const dz = apz - abz * t
  return dx * dx + dy * dy + dz * dz
}

class SoldierBuilder {
  private subs = new Map<CharMaterial, SubMesh>()
  private segA = new Map<BoneName, THREE.Vector3>()
  private segB = new Map<BoneName, THREE.Vector3>()
  private boneIndex = new Map<BoneName, number>()

  constructor(private palette: Palette, private rng: Rand) {
    for (let i = 0; i < BONE_ORDER.length; i++) this.boneIndex.set(BONE_ORDER[i], i)
    // Precompute every bone's segment in bind space for weighting.
    for (const name of BONE_ORDER) {
      const head = new THREE.Vector3(...BIND[name].p)
      let tail: THREE.Vector3 | null = null
      for (const other of BONE_ORDER) {
        if (BIND[other].parent === name) {
          tail = new THREE.Vector3(...BIND[other].p)
          break
        }
      }
      const explicit = TAIL[name]
      if (explicit) tail = new THREE.Vector3(...explicit)
      this.segA.set(name, head)
      this.segB.set(name, tail ?? head.clone().add(new THREE.Vector3(0, 0.08, 0)))
    }
  }

  private sub(mat: CharMaterial): SubMesh {
    let s = this.subs.get(mat)
    if (!s) {
      s = { pos: [], nrm: [], uv: [], col: [], si: [], sw: [], idx: [] }
      this.subs.set(mat, s)
    }
    return s
  }

  /** Albedo for a vertex: camo/base colour, ambient occlusion, wear, grime. */
  private colorAt(x: number, y: number, z: number, nx: number, ny: number, nz: number, o: PartOpts): [number, number, number] {
    const p = this.palette
    let c: THREE.Color
    if (o.color) {
      c = V_COL.copy(o.color)
    } else if (o.mat === 'uniform') {
      const s = p.camoScale
      const n1 = fbm(x * s + 3.1, y * s * 0.55 + 7.7, z * s + 1.3, 3)
      const n2 = fbm(x * s * 2.1 - 5.0, y * s * 1.1 + 2.2, z * s * 2.1 + 9.4, 2)
      c = V_COL.copy(n1 > 0.56 ? p.camo[1] : n1 < 0.43 ? p.camo[2] : p.camo[0])
      if (n2 > 0.68) c.lerp(p.camo[2], 0.55)
    } else if (o.mat === 'webbing') {
      c = V_COL.copy(p.webbing)
    } else if (o.mat === 'helmet') {
      c = V_COL.copy(p.helmet)
    } else if (o.mat === 'skin') {
      c = V_COL.copy(p.skin)
    } else if (o.mat === 'bootLeather') {
      c = V_COL.copy(p.boot)
    } else {
      c = V_COL.copy(p.gun)
    }

    // Sky-visibility approximation: downward-facing and inward-facing surfaces
    // sit in shadow. Cheap, and it is what sells the gear as layered.
    const sky = 0.5 + 0.5 * ny
    let ao = 0.5 + 0.5 * sky * sky
    // Cavity term: geometry hugging the body axis is occluded by the body.
    const radial = Math.sqrt(x * x + (z - 0.01) * (z - 0.01))
    ao *= 0.82 + 0.18 * Math.min(1, radial / 0.16)
    ao *= 1 - (o.dark ?? 0)

    // Edge wear on outward, near-horizontal normals: rubbed webbing and kit.
    const outward = Math.max(0, nx * Math.sign(x || 1) * 0.5 + nz * 0.5)
    const wear = (o.mat === 'webbing' || o.mat === 'helmet' || o.mat === 'gunmetal')
      ? outward * 0.14 * fbm(x * 26 + 11, y * 26, z * 26 + 4, 2)
      : 0

    // Grime pooling toward the boots and the seat of the trousers.
    const grime = (o.grime ?? 1) * Math.max(0, 1 - y / 0.9) * 0.22 * (0.4 + 0.6 * fbm(x * 9, y * 9, z * 9, 2))

    const speckle = 0.9 + 0.2 * fbm(x * 60 + 17, y * 60 + 3, z * 60 + 29, 2)
    // Floor the modulation: occlusion should deepen a crevice, not erase it.
    const k = Math.max(0.42, ao * speckle * (1 + wear) * (1 - grime))
    return [c.r * k, c.g * k, c.b * k]
  }

  private weightsAt(x: number, y: number, z: number, o: PartOpts): [number, number, number, number] {
    const rig = o.rigidity ?? 5
    let bi0 = 0
    let bw0 = -1
    let bi1 = 0
    let bw1 = -1
    for (let i = 0; i < o.bones.length; i++) {
      const name = o.bones[i]
      const d2 = distSqToSegment(x, y, z, this.segA.get(name)!, this.segB.get(name)!)
      const bias = o.bias ? (o.bias[i] ?? 1) : 1
      const w = bias / Math.pow(Math.sqrt(d2) + 0.012, rig)
      if (w > bw0) {
        bi1 = bi0
        bw1 = bw0
        bi0 = this.boneIndex.get(name)!
        bw0 = w
      } else if (w > bw1) {
        bi1 = this.boneIndex.get(name)!
        bw1 = w
      }
    }
    if (bw1 < 0) {
      bi1 = bi0
      bw1 = 0
    }
    const sum = bw0 + bw1
    return [bi0, bw0 / sum, bi1, bw1 / sum]
  }

  private pushVertex(s: SubMesh, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, o: PartOpts): void {
    s.pos.push(x, y, z)
    s.nrm.push(nx, ny, nz)
    s.uv.push(u, v)
    const c = this.colorAt(x, y, z, nx, ny, nz, o)
    s.col.push(c[0], c[1], c[2])
    const w = this.weightsAt(x, y, z, o)
    s.si.push(w[0], w[2], 0, 0)
    s.sw.push(w[1], w[3], 0, 0)
  }

  /**
   * Lofts a tube through a list of rings. The frame is rebuilt per ring from the
   * path tangent, so limbs, torsos and boots all come from the same primitive.
   */
  tube(rings: Ring[], radial: number, opts: PartOpts & { capStart?: boolean; capEnd?: boolean; refUp?: THREE.Vector3 }): void {
    const s = this.sub(opts.mat)
    const base = s.pos.length / 3
    const n = rings.length
    const cols = radial + 1

    // Positions first; normals come from finite differences afterwards.
    const px: number[] = []
    const py: number[] = []
    const pz: number[] = []
    const tangents: THREE.Vector3[] = []
    for (let i = 0; i < n; i++) {
      const prev = rings[Math.max(0, i - 1)]
      const next = rings[Math.min(n - 1, i + 1)]
      tangents.push(new THREE.Vector3(next.x - prev.x, next.y - prev.y, next.z - prev.z).normalize())
    }
    const refDefault = new THREE.Vector3(0, 0, 1)
    for (let i = 0; i < n; i++) {
      const r = rings[i]
      const t = tangents[i]
      const ref = opts.refUp ?? (Math.abs(t.y) > 0.75 ? refDefault : V_UP)
      V_A.copy(ref).cross(t)
      if (V_A.lengthSq() < 1e-8) V_A.set(1, 0, 0)
      V_A.normalize() // right
      V_B.copy(t).cross(V_A).normalize() // front
      const roll = r.roll ?? 0
      if (roll !== 0) {
        V_C.copy(V_A).multiplyScalar(Math.cos(roll)).addScaledVector(V_B, Math.sin(roll))
        V_D.copy(V_A).multiplyScalar(-Math.sin(roll)).addScaledVector(V_B, Math.cos(roll))
        V_A.copy(V_C)
        V_B.copy(V_D)
      }
      const e = 2 / (r.n ?? 2)
      for (let j = 0; j < cols; j++) {
        const th = (j % radial) / radial * Math.PI * 2
        const ct = Math.cos(th)
        const st = Math.sin(th)
        const sx = Math.sign(ct) * Math.pow(Math.abs(ct), e) * r.rx
        const sz = Math.sign(st) * Math.pow(Math.abs(st), e) * r.rz
        px.push(r.x + V_A.x * sx + V_B.x * sz)
        py.push(r.y + V_A.y * sx + V_B.y * sz)
        pz.push(r.z + V_A.z * sx + V_B.z * sz)
      }
    }

    let arc = 0
    const arcs: number[] = [0]
    for (let i = 1; i < n; i++) {
      arc += Math.hypot(rings[i].x - rings[i - 1].x, rings[i].y - rings[i - 1].y, rings[i].z - rings[i - 1].z)
      arcs.push(arc)
    }
    const invArc = arc > 1e-6 ? 1 / arc : 1

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < cols; j++) {
        const k = i * cols + j
        const kUp = (Math.min(n - 1, i + 1)) * cols + j
        const kDn = (Math.max(0, i - 1)) * cols + j
        const jN = j === cols - 1 ? 1 : j + 1
        const jP = j === 0 ? cols - 2 : j - 1
        const kN = i * cols + jN
        const kP = i * cols + jP
        const dux = px[kUp] - px[kDn]
        const duy = py[kUp] - py[kDn]
        const duz = pz[kUp] - pz[kDn]
        const dvx = px[kN] - px[kP]
        const dvy = py[kN] - py[kP]
        const dvz = pz[kN] - pz[kP]
        let nx = duy * dvz - duz * dvy
        let ny = duz * dvx - dux * dvz
        let nz = dux * dvy - duy * dvx
        const len = Math.hypot(nx, ny, nz) || 1
        nx /= len
        ny /= len
        nz /= len
        this.pushVertex(s, px[k], py[k], pz[k], nx, ny, nz, j / radial, arcs[i] * invArc, opts)
      }
    }

    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = base + i * cols + j
        const b = base + (i + 1) * cols + j
        const c = base + (i + 1) * cols + j + 1
        const d = base + i * cols + j + 1
        s.idx.push(a, b, c, a, c, d)
      }
    }

    if (opts.capStart !== false) this.cap(s, rings[0], tangents[0], radial, opts, -1)
    if (opts.capEnd !== false) this.cap(s, rings[n - 1], tangents[n - 1], radial, opts, 1)
  }

  private cap(s: SubMesh, r: Ring, t: THREE.Vector3, radial: number, opts: PartOpts, dir: number): void {
    const base = s.pos.length / 3
    const ref = Math.abs(t.y) > 0.75 ? new THREE.Vector3(0, 0, 1) : V_UP
    V_A.copy(ref).cross(t).normalize()
    V_B.copy(t).cross(V_A).normalize()
    const nx = t.x * dir
    const ny = t.y * dir
    const nz = t.z * dir
    this.pushVertex(s, r.x, r.y, r.z, nx, ny, nz, 0.5, 0.5, opts)
    const e = 2 / (r.n ?? 2)
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2
      const ct = Math.cos(th)
      const st = Math.sin(th)
      const sx = Math.sign(ct) * Math.pow(Math.abs(ct), e) * r.rx
      const sz = Math.sign(st) * Math.pow(Math.abs(st), e) * r.rz
      this.pushVertex(
        s,
        r.x + V_A.x * sx + V_B.x * sz,
        r.y + V_A.y * sx + V_B.y * sz,
        r.z + V_A.z * sx + V_B.z * sz,
        nx, ny, nz,
        0.5 + ct * 0.5, 0.5 + st * 0.5,
        opts,
      )
    }
    for (let j = 0; j < radial; j++) {
      const a = base
      const b = base + 1 + j
      const c = base + 1 + ((j + 1) % radial)
      if (dir > 0) s.idx.push(a, b, c)
      else s.idx.push(a, c, b)
    }
  }

  /** Rounded box, used for plates, pouches, magazines and optics. */
  box(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion, opts: PartOpts, bevel = 0.006): void {
    const s = this.sub(opts.mat)
    const hx = half.x
    const hy = half.y
    const hz = half.z
    // Each row is [normal, u, v] with cross(u, v) === normal, which keeps the
    // triangle winding below consistent across all six faces.
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)],
    ]
    for (const [nAxis, uAxis, vAxis] of faces) {
      const base = s.pos.length / 3
      const ext = new THREE.Vector3(hx, hy, hz)
      const nWorld = nAxis.clone().applyQuaternion(quat)
      const c = new THREE.Vector3(nAxis.x * ext.x, nAxis.y * ext.y, nAxis.z * ext.z)
      const uLen = Math.abs(uAxis.x) * ext.x + Math.abs(uAxis.y) * ext.y + Math.abs(uAxis.z) * ext.z - bevel
      const vLen = Math.abs(vAxis.x) * ext.x + Math.abs(vAxis.y) * ext.y + Math.abs(vAxis.z) * ext.z - bevel
      for (let i = 0; i < 4; i++) {
        const su = i === 0 || i === 3 ? -1 : 1
        const sv = i < 2 ? -1 : 1
        const local = new THREE.Vector3(
          c.x + uAxis.x * uLen * su + vAxis.x * vLen * sv,
          c.y + uAxis.y * uLen * su + vAxis.y * vLen * sv,
          c.z + uAxis.z * uLen * su + vAxis.z * vLen * sv,
        ).applyQuaternion(quat).add(center)
        this.pushVertex(s, local.x, local.y, local.z, nWorld.x, nWorld.y, nWorld.z, i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1, opts)
      }
      s.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  /** Ellipsoid built from latitude rings; used for the skull and shoulders. */
  ellipsoid(center: THREE.Vector3, radii: THREE.Vector3, opts: PartOpts, lat = 9, lon = 14, yMin = -1, yMax = 1): void {
    const rings: Ring[] = []
    for (let i = 0; i <= lat; i++) {
      const tv = yMin + (yMax - yMin) * (i / lat)
      const clamped = Math.max(-0.999, Math.min(0.999, tv))
      const r = Math.sqrt(1 - clamped * clamped)
      rings.push({
        x: center.x,
        y: center.y + clamped * radii.y,
        z: center.z,
        rx: Math.max(0.004, r * radii.x),
        rz: Math.max(0.004, r * radii.z),
      })
    }
    this.tube(rings, lon, { ...opts, capStart: yMin > -0.999, capEnd: yMax < 0.999 })
  }

  build(): { geometry: THREE.BufferGeometry; order: CharMaterial[] } {
    const order = MATERIAL_ORDER.filter((m) => this.subs.has(m))
    let vCount = 0
    let iCount = 0
    for (const m of order) {
      const s = this.subs.get(m)!
      vCount += s.pos.length / 3
      iCount += s.idx.length
    }
    const pos = new Float32Array(vCount * 3)
    const nrm = new Float32Array(vCount * 3)
    const uv = new Float32Array(vCount * 2)
    const col = new Float32Array(vCount * 3)
    const si = new Uint16Array(vCount * 4)
    const sw = new Float32Array(vCount * 4)
    const idx = new Uint32Array(iCount)
    const geom = new THREE.BufferGeometry()

    let vo = 0
    let io = 0
    for (const m of order) {
      const s = this.subs.get(m)!
      const count = s.pos.length / 3
      pos.set(s.pos, vo * 3)
      nrm.set(s.nrm, vo * 3)
      uv.set(s.uv, vo * 2)
      col.set(s.col, vo * 3)
      si.set(s.si, vo * 4)
      sw.set(s.sw, vo * 4)
      for (let k = 0; k < s.idx.length; k++) idx[io + k] = s.idx[k] + vo
      geom.addGroup(io, s.idx.length, order.indexOf(m))
      vo += count
      io += s.idx.length
    }

    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geom.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geom.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    geom.setIndex(new THREE.BufferAttribute(idx, 1))
    // Bounds are authored, not derived: the bind pose is not the widest pose and
    // a skinned mesh must not pop out of the frustum mid-animation.
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.55)
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(-0.8, -0.4, -0.8), new THREE.Vector3(0.8, 2.1, 1.2))
    return { geometry: geom, order }
  }
}

const V_UP = new THREE.Vector3(0, 1, 0)
const V_COL = new THREE.Color()

// --------------------------------------------------------------------------
// Body construction
// --------------------------------------------------------------------------

function buildLeg(b: SoldierBuilder, side: 1 | -1, p: Palette, rng: Rand): void {
  const S = side === 1 ? 'L' : 'R'
  const x = 0.095 * side
  const thigh: BoneName = `thigh${S}` as BoneName
  const shin: BoneName = `shin${S}` as BoneName
  const foot: BoneName = `foot${S}` as BoneName

  const legBones: BoneName[] = ['pelvis', thigh, shin, foot]

  // Thigh: heaviest at the top, tapering to the knee, trouser blousing at the
  // hem. The superellipse keeps the leg from reading as a soda straw.
  b.tube(
    [
      { x, y: 0.955, z: 0.005, rx: 0.098, rz: 0.105, n: 2.6 },
      { x, y: 0.87, z: 0.008, rx: 0.096, rz: 0.104, n: 2.6 },
      { x: x * 1.0, y: 0.74, z: 0.016, rx: 0.086, rz: 0.094, n: 2.4 },
      { x: x * 0.99, y: 0.6, z: 0.026, rx: 0.076, rz: 0.084, n: 2.3 },
      { x: x * 0.99, y: 0.5, z: 0.034, rx: 0.072, rz: 0.08, n: 2.2 },
    ],
    12,
    { mat: 'uniform', bones: legBones, bias: [0.55, 1, 1, 1], rigidity: 4.5, capStart: false, capEnd: false, grime: 0.6 },
  )

  // Knee pad over the joint.
  b.tube(
    [
      { x: x * 0.99, y: 0.53, z: 0.036, rx: 0.072, rz: 0.081, n: 3 },
      { x: x * 0.99, y: 0.465, z: 0.04, rx: 0.078, rz: 0.088, n: 3.4 },
      { x: x * 0.99, y: 0.4, z: 0.036, rx: 0.072, rz: 0.08, n: 3 },
    ],
    12,
    { mat: 'webbing', bones: [thigh, shin], bias: [0.8, 1], rigidity: 4, capStart: false, capEnd: false, dark: 0.04 },
  )

  // Shin, flaring into the boot cuff.
  b.tube(
    [
      { x: x * 0.99, y: 0.47, z: 0.034, rx: 0.07, rz: 0.078, n: 2.3 },
      { x: x * 0.99, y: 0.36, z: 0.022, rx: 0.063, rz: 0.072, n: 2.3 },
      { x: x * 0.99, y: 0.26, z: 0.008, rx: 0.056, rz: 0.064, n: 2.3 },
      { x: x * 0.99, y: 0.2, z: 0.0, rx: 0.058, rz: 0.066, n: 2.4 },
      { x: x * 0.99, y: 0.175, z: -0.004, rx: 0.064, rz: 0.07, n: 2.6 },
    ],
    12,
    { mat: 'uniform', bones: [thigh, shin, foot], bias: [0.7, 1, 0.8], rigidity: 5, capStart: false, capEnd: false, grime: 1.1 },
  )

  // Boot upper.
  b.tube(
    [
      { x: x * 0.99, y: 0.185, z: -0.004, rx: 0.062, rz: 0.068, n: 2.8 },
      { x: x * 0.99, y: 0.13, z: -0.006, rx: 0.058, rz: 0.066, n: 2.8 },
      { x: x * 0.99, y: 0.085, z: -0.004, rx: 0.055, rz: 0.07, n: 2.8 },
    ],
    12,
    { mat: 'bootLeather', bones: [shin, foot], bias: [0.7, 1], rigidity: 5, capStart: false, capEnd: false, grime: 1.4 },
  )

  // Boot foot: a horizontal loft from heel to toe.
  b.tube(
    [
      { x: x * 0.99, y: 0.068, z: -0.072, rx: 0.048, rz: 0.045, n: 3 },
      { x: x * 0.99, y: 0.07, z: -0.03, rx: 0.052, rz: 0.05, n: 3 },
      { x: x * 0.99, y: 0.068, z: 0.03, rx: 0.05, rz: 0.048, n: 3.2 },
      { x: x * 0.99, y: 0.06, z: 0.095, rx: 0.047, rz: 0.04, n: 3.4 },
      { x: x * 0.99, y: 0.052, z: 0.15, rx: 0.04, rz: 0.032, n: 3.4 },
      { x: x * 0.99, y: 0.046, z: 0.183, rx: 0.026, rz: 0.02, n: 3 },
    ],
    12,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, capStart: false, grime: 1.6, refUp: V_UP },
  )

  // Sole slab with a lug edge.
  b.box(
    new THREE.Vector3(x * 0.99, 0.018, 0.055),
    new THREE.Vector3(0.05, 0.018, 0.13),
    IDENT_Q,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, dark: 0.22, grime: 1.8 },
    0.004,
  )

  // Drop pouch / dump bag on one thigh only — asymmetry reads as real kit.
  if (side === (rng.bool(0.5) ? 1 : -1)) {
    b.box(
      new THREE.Vector3(x * 1.25, 0.7, 0.02),
      new THREE.Vector3(0.035, 0.075, 0.06),
      IDENT_Q,
      { mat: 'webbing', bones: [thigh], rigidity: 5, dark: 0.05 },
    )
  }
}

function buildArm(b: SoldierBuilder, side: 1 | -1): void {
  const S = side === 1 ? 'L' : 'R'
  const clav: BoneName = `clavicle${S}` as BoneName
  const upper: BoneName = `upperArm${S}` as BoneName
  const lower: BoneName = `lowerArm${S}` as BoneName
  const hand: BoneName = `hand${S}` as BoneName
  const bones: BoneName[] = ['chest', clav, upper, lower, hand]

  const sh = new THREE.Vector3(...BIND[upper].p)
  const el = new THREE.Vector3(...BIND[lower].p)
  const wr = new THREE.Vector3(...BIND[hand].p)

  const lerp = (a: THREE.Vector3, c: THREE.Vector3, t: number) => a.clone().lerp(c, t)

  // Deltoid to elbow.
  const u1 = lerp(sh, el, 0.18)
  const u2 = lerp(sh, el, 0.5)
  const u3 = lerp(sh, el, 0.82)
  b.tube(
    [
      { x: sh.x + 0.012 * side, y: sh.y + 0.035, z: sh.z, rx: 0.052, rz: 0.055, n: 2.2 },
      { x: u1.x, y: u1.y, z: u1.z, rx: 0.058, rz: 0.06, n: 2.2 },
      { x: u2.x, y: u2.y, z: u2.z, rx: 0.05, rz: 0.052, n: 2.2 },
      { x: u3.x, y: u3.y, z: u3.z, rx: 0.044, rz: 0.046, n: 2.2 },
      { x: el.x, y: el.y, z: el.z, rx: 0.042, rz: 0.044, n: 2.4 },
    ],
    10,
    { mat: 'uniform', bones, bias: [0.5, 0.7, 1, 0.9, 0.5], rigidity: 5, capStart: false, capEnd: false, grime: 0.2 },
  )

  // Elbow pad.
  const eA = lerp(el, u3, 0.35)
  const eB = lerp(el, wr, 0.2)
  b.tube(
    [
      { x: eA.x, y: eA.y, z: eA.z, rx: 0.043, rz: 0.045, n: 3 },
      { x: el.x, y: el.y, z: el.z, rx: 0.048, rz: 0.05, n: 3.4 },
      { x: eB.x, y: eB.y, z: eB.z, rx: 0.043, rz: 0.045, n: 3 },
    ],
    10,
    { mat: 'webbing', bones: [upper, lower], rigidity: 4, capStart: false, capEnd: false, dark: 0.05 },
  )

  // Forearm, rolled sleeve to glove cuff.
  const f1 = lerp(el, wr, 0.3)
  const f2 = lerp(el, wr, 0.62)
  b.tube(
    [
      { x: el.x, y: el.y, z: el.z, rx: 0.043, rz: 0.045, n: 2.3 },
      { x: f1.x, y: f1.y, z: f1.z, rx: 0.042, rz: 0.044, n: 2.3 },
      { x: f2.x, y: f2.y, z: f2.z, rx: 0.036, rz: 0.038, n: 2.3 },
      { x: wr.x, y: wr.y, z: wr.z, rx: 0.031, rz: 0.033, n: 2.4 },
    ],
    10,
    { mat: 'uniform', bones: [upper, lower, hand], bias: [0.7, 1, 0.7], rigidity: 5, capStart: false, capEnd: false, grime: 0.2 },
  )

  // Glove: fist wrapped around the weapon.
  const tail = new THREE.Vector3(...(TAIL[hand] ?? BIND[hand].p))
  const dir = tail.clone().sub(wr).normalize()
  const fistC = wr.clone().addScaledVector(dir, 0.055)
  b.ellipsoid(fistC, new THREE.Vector3(0.042, 0.052, 0.045), {
    mat: 'webbing', bones: [lower, hand], bias: [0.35, 1], rigidity: 6, dark: 0.08,
  }, 6, 10)
  // Thumb.
  b.tube(
    [
      { x: fistC.x + 0.018 * side, y: fistC.y + 0.02, z: fistC.z - 0.01, rx: 0.014, rz: 0.014 },
      { x: fistC.x + 0.006 * side, y: fistC.y + 0.03, z: fistC.z + 0.032, rx: 0.012, rz: 0.012 },
    ],
    6,
    { mat: 'webbing', bones: [hand], rigidity: 6, dark: 0.1 },
  )
}

function buildTorso(b: SoldierBuilder, rng: Rand): void {
  const spine: BoneName[] = ['pelvis', 'spine01', 'spine02', 'chest', 'neck']

  // Hips through ribcage. Widening at the deltoids is handled by the arms.
  b.tube(
    [
      { x: 0, y: 0.86, z: 0.005, rx: 0.145, rz: 0.108, n: 3 },
      { x: 0, y: 0.95, z: 0.004, rx: 0.148, rz: 0.112, n: 3 },
      { x: 0, y: 1.05, z: 0.0, rx: 0.14, rz: 0.108, n: 2.8 },
      { x: 0, y: 1.14, z: 0.0, rx: 0.145, rz: 0.112, n: 2.7 },
      { x: 0, y: 1.24, z: 0.004, rx: 0.163, rz: 0.12, n: 2.7 },
      { x: 0, y: 1.33, z: 0.008, rx: 0.176, rz: 0.124, n: 2.7 },
      { x: 0, y: 1.4, z: 0.008, rx: 0.172, rz: 0.12, n: 2.7 },
      { x: 0, y: 1.45, z: 0.004, rx: 0.13, rz: 0.108, n: 2.6 },
      { x: 0, y: 1.485, z: -0.004, rx: 0.085, rz: 0.085, n: 2.4 },
    ],
    16,
    { mat: 'uniform', bones: spine, bias: [1, 1, 1, 1, 0.5], rigidity: 4, capStart: false, capEnd: false, grime: 0.35 },
  )

  // Neck.
  b.tube(
    [
      { x: 0, y: 1.45, z: -0.004, rx: 0.062, rz: 0.062 },
      { x: 0, y: 1.53, z: -0.008, rx: 0.056, rz: 0.058 },
    ],
    10,
    { mat: 'uniform', bones: ['chest', 'neck', 'head'], bias: [0.6, 1, 0.6], rigidity: 5, capStart: false, capEnd: false },
  )

  // Plate carrier: a boxy shell that is the single strongest silhouette cue.
  b.tube(
    [
      { x: 0, y: 1.09, z: 0.006, rx: 0.178, rz: 0.135, n: 5 },
      { x: 0, y: 1.16, z: 0.006, rx: 0.184, rz: 0.14, n: 5 },
      { x: 0, y: 1.25, z: 0.008, rx: 0.19, rz: 0.145, n: 4.6 },
      { x: 0, y: 1.34, z: 0.01, rx: 0.196, rz: 0.147, n: 4.4 },
      { x: 0, y: 1.41, z: 0.008, rx: 0.183, rz: 0.14, n: 4.4 },
    ],
    16,
    { mat: 'webbing', bones: ['spine01', 'spine02', 'chest'], bias: [0.6, 1, 1], rigidity: 4, capStart: false, capEnd: false, dark: 0.04, grime: 0.4 },
  )

  // Shoulder straps over the trapezius.
  for (const s of [1, -1]) {
    b.tube(
      [
        { x: 0.055 * s, y: 1.4, z: 0.13, rx: 0.045, rz: 0.028, n: 3 },
        { x: 0.075 * s, y: 1.45, z: 0.06, rx: 0.05, rz: 0.03, n: 3 },
        { x: 0.085 * s, y: 1.462, z: -0.02, rx: 0.05, rz: 0.03, n: 3 },
        { x: 0.075 * s, y: 1.44, z: -0.095, rx: 0.045, rz: 0.028, n: 3 },
      ],
      8,
      { mat: 'webbing', bones: ['chest', s === 1 ? 'clavicleL' : 'clavicleR'], bias: [1, 0.6], rigidity: 4, dark: 0.02 },
    )
  }

  // Magazine pouches across the front, deliberately uneven.
  const magY = 1.19
  for (let i = 0; i < 3; i++) {
    const px = (i - 1) * 0.082
    const jitter = rng.range(-0.008, 0.008)
    b.box(
      new THREE.Vector3(px, magY + jitter, 0.155),
      new THREE.Vector3(0.038, 0.062, 0.032),
      IDENT_Q,
      { mat: 'webbing', bones: ['spine02', 'chest'], rigidity: 5, dark: 0.02 },
    )
    // Flap.
    b.box(
      new THREE.Vector3(px, magY + jitter + 0.058, 0.157),
      new THREE.Vector3(0.039, 0.016, 0.035),
      IDENT_Q,
      { mat: 'webbing', bones: ['spine02', 'chest'], rigidity: 5, dark: 0.1 },
    )
  }

  // Radio on the left chest with a stubby antenna, admin pouch on the right.
  b.box(
    new THREE.Vector3(0.115, 1.325, 0.15),
    new THREE.Vector3(0.042, 0.055, 0.03),
    IDENT_Q,
    { mat: 'webbing', bones: ['chest'], rigidity: 5, dark: 0.05 },
  )
  b.tube(
    [
      { x: 0.135, y: 1.375, z: 0.145, rx: 0.006, rz: 0.006 },
      { x: 0.16, y: 1.5, z: 0.115, rx: 0.004, rz: 0.004 },
    ],
    5,
    { mat: 'gunmetal', bones: ['chest'], rigidity: 5, dark: 0.25 },
  )
  b.box(
    new THREE.Vector3(-0.115, 1.325, 0.148),
    new THREE.Vector3(0.045, 0.05, 0.026),
    IDENT_Q,
    { mat: 'webbing', bones: ['chest'], rigidity: 5, dark: 0.05 },
  )

  // Grenades.
  for (let i = 0; i < 2; i++) {
    b.ellipsoid(
      new THREE.Vector3(-0.145 + i * 0.05, 1.26, 0.16),
      new THREE.Vector3(0.022, 0.03, 0.022),
      { mat: 'gunmetal', bones: ['chest'], rigidity: 5, dark: 0.12 },
      5, 8,
    )
  }

  // Rear: hydration bladder and utility pouch.
  b.tube(
    [
      { x: 0, y: 1.15, z: -0.148, rx: 0.115, rz: 0.04, n: 4 },
      { x: 0, y: 1.26, z: -0.155, rx: 0.125, rz: 0.05, n: 4 },
      { x: 0, y: 1.36, z: -0.15, rx: 0.115, rz: 0.045, n: 4 },
    ],
    10,
    { mat: 'webbing', bones: ['spine02', 'chest'], rigidity: 5, dark: 0.12 },
  )

  // Belt with a buckle.
  b.tube(
    [
      { x: 0, y: 0.985, z: 0.002, rx: 0.152, rz: 0.116, n: 3 },
      { x: 0, y: 1.02, z: 0.002, rx: 0.152, rz: 0.116, n: 3 },
    ],
    14,
    { mat: 'webbing', bones: ['pelvis', 'spine01'], rigidity: 5, dark: 0.12, capStart: false, capEnd: false },
  )
  b.box(
    new THREE.Vector3(0, 1.0, 0.118),
    new THREE.Vector3(0.03, 0.022, 0.012),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['pelvis'], rigidity: 6, dark: 0.1 },
  )

  // Hip pouches.
  for (const s of [1, -1]) {
    b.box(
      new THREE.Vector3(0.14 * s, 1.03, -0.02),
      new THREE.Vector3(0.032, 0.055, 0.05),
      IDENT_Q,
      { mat: 'webbing', bones: ['pelvis', 'spine01'], rigidity: 5, dark: 0.06 },
    )
  }
}

function buildHead(b: SoldierBuilder, rng: Rand): void {
  const hb: BoneName[] = ['neck', 'head']

  // Skull.
  b.ellipsoid(
    new THREE.Vector3(0, 1.655, 0.006),
    new THREE.Vector3(0.086, 0.113, 0.098),
    { mat: 'skin', bones: hb, bias: [0.4, 1], rigidity: 6 },
    9, 14,
  )
  // Jaw and chin volume.
  b.ellipsoid(
    new THREE.Vector3(0, 1.575, 0.024),
    new THREE.Vector3(0.072, 0.05, 0.082),
    { mat: 'skin', bones: hb, bias: [0.4, 1], rigidity: 6 },
    6, 12,
  )
  // Nose.
  b.tube(
    [
      { x: 0, y: 1.665, z: 0.085, rx: 0.013, rz: 0.012 },
      { x: 0, y: 1.632, z: 0.104, rx: 0.016, rz: 0.016 },
      { x: 0, y: 1.618, z: 0.092, rx: 0.012, rz: 0.01 },
    ],
    6,
    { mat: 'skin', bones: ['head'], rigidity: 6 },
  )
  // Brow ridge — the shadow line under the helmet is what makes a face read.
  b.box(
    new THREE.Vector3(0, 1.688, 0.078),
    new THREE.Vector3(0.072, 0.011, 0.028),
    IDENT_Q,
    { mat: 'skin', bones: ['head'], rigidity: 6, dark: 0.06 },
  )
  // Eye sockets.
  for (const s of [1, -1]) {
    b.ellipsoid(
      new THREE.Vector3(0.032 * s, 1.667, 0.082),
      new THREE.Vector3(0.017, 0.011, 0.012),
      { mat: 'gunmetal', bones: ['head'], rigidity: 6, color: new THREE.Color(0x2a2622), dark: 0.3 },
      4, 7,
    )
  }

  // Neck gaiter / balaclava over the lower face: standard modern kit and it
  // removes the need for facial detail that would not survive at 20 m.
  b.tube(
    [
      { x: 0, y: 1.47, z: -0.008, rx: 0.076, rz: 0.078, n: 2.4 },
      { x: 0, y: 1.545, z: 0.006, rx: 0.082, rz: 0.09, n: 2.3 },
      { x: 0, y: 1.6, z: 0.02, rx: 0.084, rz: 0.096, n: 2.2 },
      { x: 0, y: 1.638, z: 0.022, rx: 0.08, rz: 0.093, n: 2.2 },
    ],
    12,
    { mat: 'uniform', bones: ['neck', 'head'], bias: [0.7, 1], rigidity: 5, capStart: false, capEnd: false, dark: 0.05, color: new THREE.Color(0x24261f) },
  )

  // Helmet shell.
  b.tube(
    [
      { x: 0, y: 1.795, z: 0.006, rx: 0.038, rz: 0.042 },
      { x: 0, y: 1.783, z: 0.006, rx: 0.07, rz: 0.076 },
      { x: 0, y: 1.762, z: 0.006, rx: 0.095, rz: 0.103 },
      { x: 0, y: 1.73, z: 0.006, rx: 0.111, rz: 0.12 },
      { x: 0, y: 1.695, z: 0.006, rx: 0.119, rz: 0.129 },
      { x: 0, y: 1.655, z: 0.006, rx: 0.122, rz: 0.132 },
      { x: 0, y: 1.618, z: 0.004, rx: 0.121, rz: 0.13 },
      { x: 0, y: 1.6, z: 0.002, rx: 0.117, rz: 0.126 },
    ],
    14,
    { mat: 'helmet', bones: ['head'], rigidity: 6, capStart: false, capEnd: false, dark: 0.02, grime: 0 },
  )
  // Helmet rim lip.
  b.tube(
    [
      { x: 0, y: 1.606, z: 0.002, rx: 0.122, rz: 0.131, n: 2.1 },
      { x: 0, y: 1.594, z: 0.002, rx: 0.126, rz: 0.135, n: 2.1 },
      { x: 0, y: 1.588, z: 0.002, rx: 0.118, rz: 0.127, n: 2.1 },
    ],
    14,
    { mat: 'helmet', bones: ['head'], rigidity: 6, capStart: false, capEnd: false, dark: 0.16 },
  )
  // Night-vision mount and shroud on the brow.
  b.box(
    new THREE.Vector3(0, 1.735, 0.115),
    new THREE.Vector3(0.028, 0.02, 0.024),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.08 },
  )
  b.box(
    new THREE.Vector3(0, 1.752, 0.135),
    new THREE.Vector3(0.017, 0.03, 0.012),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.05 },
  )
  // Side accessory rails.
  for (const s of [1, -1]) {
    b.box(
      new THREE.Vector3(0.118 * s, 1.66, 0.03),
      new THREE.Vector3(0.008, 0.016, 0.05),
      IDENT_Q,
      { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.1 },
    )
  }
  // Counterweight pouch at the rear.
  b.box(
    new THREE.Vector3(0, 1.665, -0.11),
    new THREE.Vector3(0.05, 0.035, 0.03),
    IDENT_Q,
    { mat: 'webbing', bones: ['head'], rigidity: 6, dark: 0.1 },
  )
  // Chin strap.
  for (const s of [1, -1]) {
    b.tube(
      [
        { x: 0.115 * s, y: 1.618, z: 0.02, rx: 0.007, rz: 0.014, n: 3 },
        { x: 0.085 * s, y: 1.565, z: 0.045, rx: 0.007, rz: 0.013, n: 3 },
        { x: 0.04 * s, y: 1.53, z: 0.055, rx: 0.007, rz: 0.013, n: 3 },
      ],
      5,
      { mat: 'webbing', bones: ['head'], rigidity: 6, dark: 0.14 },
    )
  }
  // Some soldiers wear goggles pushed up on the brim.
  if (rng.bool(0.45)) {
    b.tube(
      [
        { x: 0.105, y: 1.706, z: 0.055, rx: 0.018, rz: 0.02, n: 3.4 },
        { x: 0.05, y: 1.722, z: 0.098, rx: 0.022, rz: 0.024, n: 3.4 },
        { x: -0.05, y: 1.722, z: 0.098, rx: 0.022, rz: 0.024, n: 3.4 },
        { x: -0.105, y: 1.706, z: 0.055, rx: 0.018, rz: 0.02, n: 3.4 },
      ],
      6,
      { mat: 'gunmetal', bones: ['head'], rigidity: 6, color: new THREE.Color(0x1c1d1a), dark: 0.02 },
    )
  }
}

const IDENT_Q = new THREE.Quaternion()

// --------------------------------------------------------------------------
// Rifle
// --------------------------------------------------------------------------

/** Rifle butt position and forward axis in bind space. */
const RIFLE_BUTT = new THREE.Vector3(-0.11, 1.34, -0.16)
const RIFLE_DIR = new THREE.Vector3(0.055, -0.14, 0.78).normalize()

function rifleBasis(): THREE.Matrix4 {
  const f = RIFLE_DIR.clone()
  const u = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize()
  const r = new THREE.Vector3().crossVectors(u, f).normalize()
  return new THREE.Matrix4().makeBasis(r, u, f).setPosition(RIFLE_BUTT)
}

function buildRifle(b: SoldierBuilder, basis: THREE.Matrix4, p: Palette): void {
  const q = new THREE.Quaternion().setFromRotationMatrix(basis)
  const toBind = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(basis)
  const ring = (x: number, y: number, z: number, rx: number, rz: number, n?: number): Ring => {
    const v = toBind(x, y, z)
    return { x: v.x, y: v.y, z: v.z, rx, rz, n }
  }
  const opts = (dark: number, color?: THREE.Color): PartOpts => ({
    mat: 'gunmetal', bones: ['handR', 'lowerArmR'], bias: [1, 0.12], rigidity: 7, dark, color, grime: 0,
  })
  const polymer = p.gunPolymer

  // Buttstock: pad, tube, cheek riser.
  b.box(toBind(0, 0.006, 0.016), new THREE.Vector3(0.021, 0.056, 0.016), q, opts(0.28, polymer))
  b.tube(
    [ring(0, 0.012, 0.03, 0.02, 0.03, 3.2), ring(0, 0.016, 0.115, 0.02, 0.032, 3.2), ring(0, 0.02, 0.2, 0.017, 0.028, 3.2)],
    8,
    opts(0.12, polymer),
  )
  b.box(toBind(0, 0.052, 0.13), new THREE.Vector3(0.016, 0.012, 0.055), q, opts(0.16, polymer))

  // Receiver: lower then upper, with a slab-sided profile.
  b.tube(
    [ring(0, 0.026, 0.2, 0.023, 0.038, 5), ring(0, 0.028, 0.26, 0.024, 0.04, 5), ring(0, 0.03, 0.36, 0.024, 0.041, 5), ring(0, 0.03, 0.425, 0.022, 0.038, 5)],
    10,
    opts(0.06),
  )
  // Charging handle and ejection port on the shooter's right (model -X).
  b.box(toBind(-0.026, 0.05, 0.3), new THREE.Vector3(0.006, 0.017, 0.045), q, opts(0.02))
  b.box(toBind(0, 0.072, 0.24), new THREE.Vector3(0.02, 0.008, 0.03), q, opts(0.1))

  // Top rail with tooth detail approximated by a ridged profile.
  b.tube(
    [ring(0, 0.072, 0.235, 0.014, 0.008, 3), ring(0, 0.076, 0.42, 0.014, 0.008, 3), ring(0, 0.076, 0.63, 0.013, 0.008, 3)],
    6,
    opts(0.0),
  )

  // Handguard.
  b.tube(
    [
      ring(0, 0.03, 0.43, 0.026, 0.03, 4),
      ring(0, 0.03, 0.5, 0.027, 0.031, 4),
      ring(0, 0.03, 0.58, 0.026, 0.03, 4),
      ring(0, 0.03, 0.635, 0.024, 0.027, 4),
    ],
    10,
    opts(0.04, polymer),
  )

  // Barrel, gas block, muzzle brake.
  b.tube([ring(0, 0.03, 0.62, 0.0105, 0.0105), ring(0, 0.03, 0.75, 0.0095, 0.0095)], 8, opts(0.05))
  b.box(toBind(0, 0.046, 0.645), new THREE.Vector3(0.012, 0.016, 0.018), q, opts(0.05))
  b.tube([ring(0, 0.03, 0.748, 0.016, 0.016, 3), ring(0, 0.03, 0.79, 0.016, 0.016, 3)], 8, opts(0.16))

  // Magazine, curved by offsetting the lower rings forward.
  b.tube(
    [
      ring(0, -0.005, 0.3, 0.017, 0.038, 4),
      ring(0, -0.07, 0.303, 0.017, 0.038, 4),
      ring(0, -0.135, 0.316, 0.017, 0.037, 4),
      ring(0, -0.195, 0.338, 0.016, 0.035, 4),
    ],
    8,
    opts(0.1, polymer),
  )

  // Pistol grip.
  b.tube(
    [ring(0, -0.01, 0.24, 0.018, 0.021, 3), ring(0, -0.07, 0.222, 0.019, 0.024, 3), ring(0, -0.115, 0.206, 0.017, 0.021, 3)],
    8,
    opts(0.1, polymer),
  )
  // Trigger guard.
  b.tube(
    [
      ring(0, -0.012, 0.262, 0.006, 0.006),
      ring(0, -0.038, 0.268, 0.006, 0.006),
      ring(0, -0.042, 0.292, 0.006, 0.006),
      ring(0, -0.02, 0.3, 0.006, 0.006),
    ],
    5,
    opts(0.08),
  )

  // Optic: riser, body, hood, lens.
  b.box(toBind(0, 0.092, 0.4), new THREE.Vector3(0.016, 0.018, 0.05), q, opts(0.06))
  b.tube(
    [ring(0, 0.115, 0.355, 0.02, 0.02, 2.6), ring(0, 0.115, 0.44, 0.022, 0.022, 2.6), ring(0, 0.115, 0.47, 0.024, 0.024, 2.6)],
    9,
    opts(0.03),
  )
  b.tube(
    [ring(0, 0.115, 0.468, 0.023, 0.023), ring(0, 0.115, 0.478, 0.023, 0.023)],
    9,
    { ...opts(0), color: new THREE.Color(0x2b4a55) },
  )

  // Angled foregrip.
  b.tube(
    [ring(0, 0.005, 0.53, 0.015, 0.017, 3), ring(0, -0.06, 0.505, 0.016, 0.018, 3), ring(0, -0.095, 0.487, 0.014, 0.016, 3)],
    7,
    opts(0.08, polymer),
  )

  // Sling loop under the stock.
  b.tube(
    [ring(0, -0.01, 0.185, 0.005, 0.005), ring(0, -0.03, 0.19, 0.005, 0.005), ring(0, -0.028, 0.215, 0.005, 0.005)],
    5,
    opts(0.15),
  )
}

// --------------------------------------------------------------------------
// Asset assembly
// --------------------------------------------------------------------------

export interface SoldierAsset {
  geometry: THREE.BufferGeometry
  materials: THREE.Material[]
  boneInverses: THREE.Matrix4[]
  /** Rifle transform relative to the right hand bone. */
  rifleLocal: THREE.Matrix4
  palette: Palette
}

/**
 * Borrows the material library's surface response — normal and roughness maps,
 * which is where "not a flat untextured surface" comes from — but takes over
 * albedo entirely. The library authors its materials for walls and ground at
 * world scale; stacking its base colour on top of the vertex camo would double
 * up two unrelated darkening terms and sink the character into mud.
 */
function characterMaterial(mats: MaterialService | undefined, name: CharMaterial): THREE.Material {
  const src = mats?.get(name)
  const m = (src ? src.clone() : new THREE.MeshStandardMaterial()) as THREE.MeshStandardMaterial
  m.name = `soldier.${name}`
  m.vertexColors = true
  if (m.color) m.color.setHex(BASE_COLOR[name])
  if (m.emissive) m.emissive.setHex(0x000000)
  m.map = null
  m.aoMap = null
  m.lightMap = null
  m.alphaMap = null
  m.emissiveMap = null
  m.transparent = false
  m.opacity = 1

  if (m.roughness === undefined || m.roughness >= 0.99) {
    m.roughness = name === 'gunmetal' ? 0.44 : name === 'skin' ? 0.58 : name === 'bootLeather' ? 0.6 : 0.85
  }
  if (name === 'gunmetal') m.metalness = 0.72
  else if (name === 'helmet') m.metalness = 0.06
  else m.metalness = 0.02
  m.side = THREE.FrontSide
  m.shadowSide = THREE.FrontSide
  return m
}

/**
 * Builds one shared soldier asset. Call a handful of times with different seeds
 * to get loadout and palette variety; every instance of a variant shares its
 * geometry and materials, so variety costs nothing per soldier.
 */
export function buildSoldierAsset(mats: MaterialService | undefined, seed: number): SoldierAsset {
  const rng = new Rand(seed)
  const palette = makePalette(rng)
  const b = new SoldierBuilder(palette, rng)

  buildTorso(b, rng)
  buildHead(b, rng)
  buildLeg(b, 1, palette, rng)
  buildLeg(b, -1, palette, rng)
  buildArm(b, 1)
  buildArm(b, -1)

  const basis = rifleBasis()
  buildRifle(b, basis, palette)

  const { geometry, order } = b.build()
  const materials = order.map((name) => characterMaterial(mats, name))

  const boneInverses = BONE_ORDER.map((name) => {
    const p = BIND[name].p
    return new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2])
  })

  // Bind rotations are identity, so the hand's bind world matrix is a pure
  // translation and the rifle's local offset is a single inverse-multiply.
  const handBind = new THREE.Matrix4().makeTranslation(...BIND.handR.p)
  const rifleLocal = new THREE.Matrix4().copy(handBind).invert().multiply(basis)

  return { geometry, materials, boneInverses, rifleLocal, palette }
}

export interface SoldierRig {
  root: THREE.Group
  mesh: THREE.SkinnedMesh
  bones: Record<BoneName, THREE.Bone>
  boneArray: THREE.Bone[]
  skeleton: THREE.Skeleton
  /** Weapon frame: +Z along the barrel, origin at the buttpad. */
  rifle: THREE.Object3D
  muzzle: THREE.Object3D
  foregrip: THREE.Object3D
  magwell: THREE.Object3D
  ejectPort: THREE.Object3D
}

/** Instantiates a rig sharing `asset`'s geometry and materials. */
export function createSoldierRig(asset: SoldierAsset): SoldierRig {
  const root = new THREE.Group()
  root.name = 'soldier'

  const bones = {} as Record<BoneName, THREE.Bone>
  const boneArray: THREE.Bone[] = []
  for (const name of BONE_ORDER) {
    const bone = new THREE.Bone()
    bone.name = name
    bones[name] = bone
    boneArray.push(bone)
  }
  for (const name of BONE_ORDER) {
    const def = BIND[name]
    const bone = bones[name]
    if (def.parent) {
      const pp = BIND[def.parent].p
      bone.position.set(def.p[0] - pp[0], def.p[1] - pp[1], def.p[2] - pp[2])
      bones[def.parent].add(bone)
    } else {
      bone.position.set(def.p[0], def.p[1], def.p[2])
      root.add(bone)
    }
  }

  const skeleton = new THREE.Skeleton(boneArray, asset.boneInverses.map((m) => m.clone()))
  const mesh = new THREE.SkinnedMesh(asset.geometry, asset.materials)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  root.add(mesh)
  // Identity bind matrix: geometry is authored in the same space as the bones.
  mesh.bind(skeleton, new THREE.Matrix4())

  const rifle = new THREE.Object3D()
  rifle.name = 'rifle'
  asset.rifleLocal.decompose(rifle.position, rifle.quaternion, rifle.scale)
  bones.handR.add(rifle)

  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.03, 0.795)
  rifle.add(muzzle)

  const foregrip = new THREE.Object3D()
  foregrip.position.set(0, -0.075, 0.5)
  rifle.add(foregrip)

  const magwell = new THREE.Object3D()
  magwell.position.set(0, -0.13, 0.31)
  rifle.add(magwell)

  const ejectPort = new THREE.Object3D()
  ejectPort.position.set(-0.035, 0.06, 0.3)
  rifle.add(ejectPort)

  return { root, mesh, bones, boneArray, skeleton, rifle, muzzle, foregrip, magwell, ejectPort }
}
