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
  /** Balaclava, shemagh or neck gaiter over the lower face. */
  faceCover: THREE.Color
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
  // drops.
  //
  // Hue alone did not do it. Authored as fixed hexes the kit landed anywhere
  // from 0.45 stops under the uniform (olive) to 1.08 (desert) purely as a
  // side effect of which camo it happened to be paired with, and the shallow
  // end of that range is not separation at all: on `shots/iter7/firefight.png`
  // a carrier panel measured 85/255 against a sleeve at 73, half a stop apart,
  // and the two read as one mass with faint rectangles drawn on it. Anchoring
  // the kit's *value* to the uniform it is worn over and keeping only its hue
  // from the hex gives every scheme the same separation.
  //
  // This is not the "another stop of black" the previous note warned against.
  // That failure is the whole figure going dark and losing internal detail;
  // dropping the kit while the uniform stays put is the opposite operation —
  // it spends contrast on the boundary between carrier and sleeve, which is
  // exactly the boundary a viewer reads a soldier by.
  const kit = scheme === 1 ? new THREE.Color(0x585e4c) : new THREE.Color(0x6a5647)
  return {
    camo,
    camoScale: rng.range(9, 11.5),
    webbing: reValue(kit, camo[0], KIT_VALUE).multiplyScalar(rng.range(0.9, 1.1)),
    // The helmet cover sits well under the uniform so the head reads as its own
    // shape against the shoulders at gameplay distance. 0.88 was within a fifth
    // of a stop and the two ran together; 0.74 was still only 0.43 stops, which
    // survives neither aerial haze nor a figure eighty pixels tall.
    helmet: new THREE.Color().copy(camo[0]).multiplyScalar(0.55),
    // The face covering is the darkest cloth on the figure and it sits directly
    // under the one patch of skin, so it is the contrast that makes a head read
    // as a head. Anchored to the uniform for the same reason the kit is: a
    // fixed hex lands anywhere from a quarter of a stop to a stop and a half
    // under, depending only on which camo it was paired with.
    faceCover: reValue(
      scheme === 1 ? new THREE.Color(0x3a3a30) : new THREE.Color(0x2e3128),
      camo[0], 0.32,
    ),
    boot: new THREE.Color(0x4a4238).multiplyScalar(rng.range(0.88, 1.15)),
    // Weathered, not studio-lit. At L 0.40-0.56 skin measured 0.41-0.48 linear,
    // 1.6 stops over the uniform and the brightest thing anywhere on the figure
    // — which is how a soldier standing in a muzzle flash ends up as a white
    // cut-out with a face on it. A face that has been outdoors sits under a
    // stop above tan cloth, and the only skin still visible is a band of
    // cheekbone between the eye-pro and the covering.
    skin: new THREE.Color().setHSL(0.068, rng.range(0.34, 0.46), rng.range(0.3, 0.4)),
    // Matte black anodising and phosphate, not bare steel. 0x565a60 is a light
    // neutral grey; at metalness 0.72 that is an 11% reflector, so gunmetal sat
    // only 0.45 stops under the uniform in the olive scheme and went straight
    // past it wherever the sun caught it. On `shots/iter7/firefight.png` the
    // night-vision mount over the brow measured 152/255 against a helmet shell
    // at 100 and a face at 90 — the brightest thing on the head, and neutral
    // grey where everything around it is warm. Modern kit is the darkest thing
    // a soldier wears, and on the rifle that darkness is the silhouette.
    gun: new THREE.Color(0x3a3d42),
    gunPolymer: new THREE.Color(0x33352f),
  }
}

/**
 * Kit value as a fraction of the uniform it is worn over: 1.15 stops under.
 * Enough that carrier, pouches and gloves cut against the sleeve on a figure
 * eighty pixels tall, not so much that the kit becomes a hole in it — the
 * darkest scheme lands at 0.063 linear albedo, still a colour and not a void.
 */
const KIT_VALUE = 0.45

/** Rec.709 luminance of a colour already in the linear working space. */
function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/**
 * Returns `hue` scaled to `fraction` of `against`'s luminance — chroma from one
 * colour, value from another. Both are linear-space by the time they get here,
 * so this is a plain multiply rather than anything perceptual.
 */
function reValue(hue: THREE.Color, against: THREE.Color, fraction: number): THREE.Color {
  const out = new THREE.Color().copy(hue)
  return out.multiplyScalar((luminance(against) * fraction) / Math.max(1e-4, luminance(hue)))
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
const V_E1 = new THREE.Vector3()
const V_E2 = new THREE.Vector3()
const V_N = new THREE.Vector3()
const V_P = new THREE.Vector3()

const SIGNS = [-1, 1] as const
const QUAD_SIGNS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
const AXIS_PAIRS: readonly (readonly [number, number])[] = [[0, 1], [0, 2], [1, 2]]

/**
 * Texture repeats per metre of surface.
 *
 * UVs used to run 0..1 across a whole part, which put the fabric weave — the
 * material library bakes 64 threads per tile and repeats twice — at roughly
 * four tiles per metre, so a ripstop thread came out four millimetres wide.
 * Real ripstop is nearer one. Authoring UVs in metres instead fixes the density
 * by construction whatever size a part happens to be, and it is what lets the
 * library's detail overlay land where it was designed to: its fine layer at
 * three tiles per UV unit becomes a five-centimetre grain, which is one to three
 * pixels on a soldier at gameplay distance — exactly the band `localContrast`
 * measures and the band a per-part UV had nothing in at all.
 */
const UV_SCALE = 6

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
      const n2 = fbm(x * s * 1.45 - 5.0, y * s * 0.8 + 2.2, z * s * 1.45 + 9.4, 2)
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

    // Contact shadow under kit. The underside of a pouch, a strap, a magazine
    // or a mag well is a hard dark line against whatever it is worn over, and
    // that line is most of what makes gear read as layered at gameplay distance
    // rather than as rectangles printed on a torso. It goes on after the floor
    // rather than into `ao`: the floor is there so occlusion deepens a crevice
    // instead of erasing a surface, and a seam is meant to be the crevice.
    const seam = o.mat === 'webbing' || o.mat === 'gunmetal' ? Math.max(0, -ny) * 0.22 : 0

    // Vertices sit two to five centimetres apart, so anything above about ten
    // cycles per metre is below the mesh's own Nyquist limit: the old 60 gave
    // every vertex an independent value in a ±10% band, which is noise, not
    // texture. Fine grain is the material overlay's job now that it compiles in
    // at all; this is the decimetre-scale soiling the overlay's coarse layer
    // does not reach.
    const speckle = 0.9 + 0.2 * fbm(x * 9 + 17, y * 9 + 3, z * 9 + 29, 2)
    // Floor the modulation: occlusion should deepen a crevice, not erase it.
    const k = Math.max(0.42, ao * speckle * (1 + wear) * (1 - grime)) * (1 - seam)
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
    // UVs are metres, not 0..1 per part. See UV_SCALE. The circumferential span
    // is rounded to a whole number of texture repeats and shared by every ring
    // so the wrap seam is invisible and the weave does not shear along a taper.
    let perim = 0
    for (const r of rings) perim += Math.PI * (r.rx + r.rz)
    const uSpan = Math.max(1, Math.round((perim / n) * UV_SCALE))

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
        this.pushVertex(s, px[k], py[k], pz[k], nx, ny, nz, (j / radial) * uSpan, arcs[i] * UV_SCALE, opts)
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
    this.pushVertex(s, r.x, r.y, r.z, nx, ny, nz, 0, 0, opts)
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
        sx * UV_SCALE, sz * UV_SCALE,
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

  /**
   * Chamfered box, used for plates, pouches, magazines and optics.
   *
   * The chamfer is geometry, not an inset. The previous version pulled each of
   * the six faces in by `bevel` and left the seams open, so every pouch, radio,
   * magazine and optic on every soldier had a six-millimetre slit around all
   * twelve of its edges that showed whatever was behind it. That is most of why
   * kit read as rectangles printed on a torso rather than objects sitting on
   * one: the only thing marking a pouch's edge was a dark gap.
   *
   * Closing it with twelve edge quads and eight corner triangles costs 32 extra
   * triangles per box and buys the thing that actually sells hard-surface kit —
   * a narrow band at every edge with its own normal, which catches the key light
   * as a bright line on the lit side and goes dark on the other. That edge
   * highlight is legible at a far smaller pixel size than the face it borders.
   */
  box(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion, opts: PartOpts, bevel = 0.005): void {
    const s = this.sub(opts.mat)
    const h = [half.x, half.y, half.z]
    const b = Math.min(bevel, Math.min(h[0], h[1], h[2]) * 0.42)

    /** Corner `sg` of the face whose normal runs along `axis`. */
    const corner = (sg: number[], axis: number): THREE.Vector3 =>
      new THREE.Vector3(
        sg[0] * (axis === 0 ? h[0] : h[0] - b),
        sg[1] * (axis === 1 ? h[1] : h[1] - b),
        sg[2] * (axis === 2 ? h[2] : h[2] - b),
      )

    // Emits a convex polygon wound so its geometric normal agrees with `n`.
    const poly = (pts: THREE.Vector3[], n: THREE.Vector3): void => {
      const e1 = V_E1.copy(pts[1]).sub(pts[0])
      const e2 = V_E2.copy(pts[2]).sub(pts[0])
      const flip = e1.cross(e2).dot(n) < 0
      const nw = V_N.copy(n).applyQuaternion(quat).normalize()
      // Box UVs are metres in the box's own frame, matching the tube loft, and
      // laid out on the two axes the face does not point along — projecting a
      // +X face onto XY would give all four corners the same u.
      const ax = Math.abs(n.x)
      const ay = Math.abs(n.y)
      const major = ax >= ay && ax >= Math.abs(n.z) ? 0 : ay >= Math.abs(n.z) ? 1 : 2
      const uAxis = major === 0 ? 'y' : 'x'
      const vAxis = major === 2 ? 'y' : 'z'
      const first = s.pos.length / 3
      for (const p of pts) {
        const w = V_P.copy(p).applyQuaternion(quat).add(center)
        this.pushVertex(s, w.x, w.y, w.z, nw.x, nw.y, nw.z, p[uAxis] * UV_SCALE, p[vAxis] * UV_SCALE, opts)
      }
      for (let i = 2; i < pts.length; i++) {
        if (flip) s.idx.push(first, first + i, first + i - 1)
        else s.idx.push(first, first + i - 1, first + i)
      }
    }

    const axisVec = (a: number, v: number): THREE.Vector3 =>
      new THREE.Vector3(a === 0 ? v : 0, a === 1 ? v : 0, a === 2 ? v : 0)

    // Six faces.
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3
      const v = (a + 2) % 3
      for (const sa of SIGNS) {
        const quad = QUAD_SIGNS.map(([su, sv]) => {
          const sg = [0, 0, 0]
          sg[a] = sa
          sg[u] = su
          sg[v] = sv
          return corner(sg, a)
        })
        poly(quad, axisVec(a, sa))
      }
    }
    // Twelve edge chamfers.
    for (const [a, c] of AXIS_PAIRS) {
      const f = 3 - a - c
      for (const sa of SIGNS) {
        for (const sc of SIGNS) {
          const pts: THREE.Vector3[] = []
          for (const sf of SIGNS) {
            const sg = [0, 0, 0]
            sg[a] = sa
            sg[c] = sc
            sg[f] = sf
            pts.push(corner(sg, sf === -1 ? a : c))
            pts.push(corner(sg, sf === -1 ? c : a))
          }
          poly(pts, axisVec(a, sa).add(axisVec(c, sc)).normalize())
        }
      }
    }
    // Eight corner triangles.
    for (const sx of SIGNS) {
      for (const sy of SIGNS) {
        for (const sz of SIGNS) {
          const sg = [sx, sy, sz]
          poly([corner(sg, 0), corner(sg, 1), corner(sg, 2)], new THREE.Vector3(sx, sy, sz).normalize())
        }
      }
    }
  }

  /**
   * A dome whose lower edge is cut at a different height for every azimuth.
   *
   * A helmet is not a body of revolution: it stops above the brow at the front,
   * scallops up over the ears and sweeps down over the occiput at the back, and
   * those three heights are the whole silhouette. Lofting it as a tube — which
   * is what produced the closed bucket this replaces — can only give a shape
   * that is the same height all the way round, so the front wall ended up three
   * centimetres in front of the face and no face was ever visible.
   *
   * `bottom` returns the cut as a latitude parameter in -1..1 for an azimuth
   * measured from +Z (the direction the model faces).
   *
   * The shell is solid, not a surface: an inner liner runs under the outer one
   * and the two are joined along the open edge. That is not decoration. Once the
   * front is cut away there is a two-and-a-half centimetre gap between the head
   * and the rim on each side, and with back faces culled a single-sided shell
   * would let the background straight through the silhouette there — a hole in
   * the head, which is worse than the closed bucket it replaces. The liner also
   * gives the rim a real thickness to catch light on, and it thins toward the
   * crown the way a suspension liner actually does.
   */
  shell(
    center: THREE.Vector3,
    radii: THREE.Vector3,
    opts: PartOpts,
    lon: number,
    lat: number,
    bottom: (theta: number) => number,
    liner = 0.87,
  ): void {
    const s = this.sub(opts.mat)
    const cols = lon + 1
    const uSpan = Math.max(1, Math.round(Math.PI * (radii.x + radii.z) * UV_SCALE))
    const inner = { ...opts, dark: (opts.dark ?? 0) + 0.42 }

    // `k` is 0 for the outer surface and 1 for the liner.
    const surface = (k: number, o: PartOpts): number => {
      const first = s.pos.length / 3
      for (let j = 0; j < cols; j++) {
        const th = ((j % lon) / lon) * Math.PI * 2
        const sinT = Math.sin(th)
        const cosT = Math.cos(th)
        const vb = bottom(th)
        for (let i = 0; i <= lat; i++) {
          // Biased toward the rim, where the curvature and the silhouette are.
          const t = vb + (1 - vb) * Math.pow(i / lat, 1.15)
          const sc = k === 0 ? 1 : liner + (1 - liner - 0.01) * Math.pow(Math.max(0, t), 4)
          const rr = Math.sqrt(Math.max(0, 1 - t * t))
          const rx = radii.x * sc
          const ry = radii.y * sc
          const rz = radii.z * sc
          const nx = ((rr * sinT) / rx) * (k === 0 ? 1 : -1)
          const ny = (t / ry) * (k === 0 ? 1 : -1)
          const nz = ((rr * cosT) / rz) * (k === 0 ? 1 : -1)
          const nl = Math.hypot(nx, ny, nz) || 1
          this.pushVertex(
            s,
            center.x + rx * rr * sinT, center.y + ry * t, center.z + rz * rr * cosT,
            nx / nl, ny / nl, nz / nl,
            (j / lon) * uSpan, (i / lat) * radii.y * 2 * UV_SCALE, o,
          )
        }
      }
      for (let j = 0; j < lon; j++) {
        for (let i = 0; i < lat; i++) {
          const a = first + j * (lat + 1) + i
          const c = first + (j + 1) * (lat + 1) + i
          if (k === 0) s.idx.push(a, c, c + 1, a, c + 1, a + 1)
          else s.idx.push(a, c + 1, c, a, a + 1, c + 1)
        }
      }
      return first
    }

    surface(0, opts)
    surface(1, inner)

    // Rim: the strip between the two surfaces along the open edge. It gets its
    // own vertices rather than reusing the shell's, because the whole point of
    // it is a normal that faces down and out — shared vertices would shade it
    // as more dome and it would read as a smear instead of an edge.
    const rimBase = s.pos.length / 3
    const rimOpts = { ...opts, dark: (opts.dark ?? 0) + 0.2 }
    for (let j = 0; j < cols; j++) {
      const th = ((j % lon) / lon) * Math.PI * 2
      const sinT = Math.sin(th)
      const cosT = Math.cos(th)
      const vb = bottom(th)
      const rr = Math.sqrt(Math.max(0, 1 - vb * vb))
      const sc = liner + (1 - liner - 0.01) * Math.pow(Math.max(0, vb), 4)
      const ox = radii.x * rr * sinT
      const oz = radii.z * rr * cosT
      const ol = Math.hypot(ox, oz) || 1
      const nx = (ox / ol) * 0.42
      const nz = (oz / ol) * 0.42
      const nl = Math.hypot(nx, 0.91, nz)
      for (let i = 0; i < 2; i++) {
        const k = i === 0 ? 1 : sc
        this.pushVertex(
          s,
          center.x + ox * k, center.y + radii.y * vb * (i === 0 ? 1 : sc), center.z + oz * k,
          nx / nl, -0.91 / nl, nz / nl,
          (j / lon) * uSpan, i * (1 - liner) * radii.x * UV_SCALE, rimOpts,
        )
      }
    }
    for (let j = 0; j < lon; j++) {
      const a = rimBase + j * 2
      const c = rimBase + (j + 1) * 2
      s.idx.push(a, a + 1, c + 1, a, c + 1, c)
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
    14,
    { mat: 'uniform', bones: legBones, bias: [0.55, 1, 1, 1], rigidity: 4.5, capStart: false, capEnd: false, grime: 0.6 },
  )

  // Cargo pocket on the outer thigh, and a hem seam under it.
  //
  // Below the belt the figure was 45% of its own height and carried nothing at
  // all — two tapering tubes and a knee pad. A viewer reads a soldier top-down,
  // so the legs are where the eye ends up after the head and the chest have
  // been taken in, and finding nothing there is what finishes the impression of
  // a mannequin. Cargo pockets are the one thing every combat trouser has.
  b.box(
    new THREE.Vector3(x + 0.072 * side, 0.735, 0.016),
    new THREE.Vector3(0.026, 0.084, 0.056),
    IDENT_Q,
    { mat: 'uniform', bones: [thigh], rigidity: 5, dark: 0.06, grime: 0.7 },
    0.007,
  )
  b.box(
    new THREE.Vector3(x + 0.074 * side, 0.812, 0.016),
    new THREE.Vector3(0.024, 0.015, 0.058),
    IDENT_Q,
    { mat: 'uniform', bones: [thigh], rigidity: 5, dark: 0.16, grime: 0.6 },
    0.004,
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
      { x: x * 0.99, y: 0.22, z: 0.002, rx: 0.062, rz: 0.07, n: 2.4 },
      { x: x * 0.99, y: 0.192, z: -0.002, rx: 0.071, rz: 0.077, n: 2.6 },
      { x: x * 0.99, y: 0.174, z: -0.005, rx: 0.068, rz: 0.074, n: 2.6 },
    ],
    14,
    { mat: 'uniform', bones: [thigh, shin, foot], bias: [0.7, 1, 0.8], rigidity: 5, capStart: false, capEnd: false, grime: 1.1 },
  )
  // Drawcord under the blousing.
  b.tube(
    [
      { x: x * 0.99, y: 0.204, z: -0.001, rx: 0.073, rz: 0.079, n: 2.6 },
      { x: x * 0.99, y: 0.196, z: -0.002, rx: 0.073, rz: 0.079, n: 2.6 },
    ],
    14,
    { mat: 'webbing', bones: [shin, foot], bias: [1, 0.6], rigidity: 5, capStart: false, capEnd: false, dark: 0.18, grime: 1.2 },
  )

  // Boot upper.
  b.tube(
    [
      { x: x * 0.99, y: 0.182, z: -0.004, rx: 0.063, rz: 0.069, n: 2.8 },
      { x: x * 0.99, y: 0.13, z: -0.006, rx: 0.059, rz: 0.067, n: 2.8 },
      { x: x * 0.99, y: 0.085, z: -0.004, rx: 0.056, rz: 0.071, n: 2.8 },
    ],
    12,
    { mat: 'bootLeather', bones: [shin, foot], bias: [0.7, 1], rigidity: 5, capStart: false, capEnd: false, grime: 1.4 },
  )

  // Boot foot: a horizontal loft from heel to toe.
  b.tube(
    [
      { x: x * 0.99, y: 0.072, z: -0.078, rx: 0.05, rz: 0.048, n: 3 },
      { x: x * 0.99, y: 0.074, z: -0.03, rx: 0.054, rz: 0.052, n: 3 },
      { x: x * 0.99, y: 0.072, z: 0.03, rx: 0.052, rz: 0.05, n: 3.2 },
      { x: x * 0.99, y: 0.064, z: 0.098, rx: 0.05, rz: 0.042, n: 3.4 },
      { x: x * 0.99, y: 0.056, z: 0.156, rx: 0.044, rz: 0.034, n: 3.4 },
      { x: x * 0.99, y: 0.05, z: 0.19, rx: 0.03, rz: 0.022, n: 3 },
    ],
    12,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, capStart: false, grime: 1.6, refUp: V_UP },
  )

  // Sole. A boot's sole is the one part of a soldier that is always in the
  // frame and always against something bright, so it is worth the three boxes:
  // a midsole slab, a lugged outsole under it and a raised heel block. The
  // single 36 mm slab it replaces gave the foot no ground line at all.
  b.box(
    new THREE.Vector3(x * 0.99, 0.032, 0.056),
    new THREE.Vector3(0.053, 0.014, 0.138),
    IDENT_Q,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, dark: 0.14, grime: 1.7 },
    0.005,
  )
  b.box(
    new THREE.Vector3(x * 0.99, 0.012, 0.058),
    new THREE.Vector3(0.05, 0.012, 0.134),
    IDENT_Q,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, dark: 0.3, grime: 2 },
    0.004,
  )
  b.box(
    new THREE.Vector3(x * 0.99, 0.012, -0.052),
    new THREE.Vector3(0.048, 0.014, 0.036),
    IDENT_Q,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, dark: 0.34, grime: 2 },
    0.004,
  )
  // Toe cap.
  b.box(
    new THREE.Vector3(x * 0.99, 0.056, 0.166),
    new THREE.Vector3(0.038, 0.02, 0.03),
    IDENT_Q,
    { mat: 'bootLeather', bones: [foot], rigidity: 6, dark: 0.06, grime: 1.4 },
    0.006,
  )

  // Drop pouch / dump bag on one thigh only — asymmetry reads as real kit.
  if (side === (rng.bool(0.5) ? 1 : -1)) {
    b.box(
      new THREE.Vector3(x + 0.098 * side, 0.655, 0.026),
      new THREE.Vector3(0.03, 0.086, 0.06),
      IDENT_Q,
      { mat: 'webbing', bones: [thigh], rigidity: 5, dark: 0.05, grime: 0.8 },
      0.008,
    )
    // Straps wrapping the thigh to hold it on.
    for (const [y, r] of [[0.735, 0.087], [0.6, 0.078]] as const) {
      b.tube(
        [
          { x, y, z: 0, rx: r, rz: r + 0.008, n: 2.4 },
          { x, y: y - 0.014, z: 0, rx: r, rz: r + 0.008, n: 2.4 },
        ],
        12,
        {
          mat: 'webbing', bones: [thigh], rigidity: 5, capStart: false, capEnd: false,
          dark: 0.16, grime: 0.8,
        },
      )
    }
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
      // A deltoid at 0.052 put the widest point of the shoulder at x = 0.237,
      // barely outside the plate carrier at 0.196, so the figure had no shoulder
      // line at all — it went hip, waist, chest, head as one taper. A soldier's
      // shoulder is the widest thing about him and it is the first thing a
      // silhouette says. 0.072 puts it at 0.257, and the carrier yoke over the
      // top takes the outline to 0.28.
      { x: sh.x + 0.014 * side, y: sh.y + 0.042, z: sh.z, rx: 0.064, rz: 0.064, n: 2.2 },
      { x: u1.x, y: u1.y, z: u1.z, rx: 0.072, rz: 0.07, n: 2.2 },
      { x: u2.x, y: u2.y, z: u2.z, rx: 0.056, rz: 0.058, n: 2.2 },
      { x: u3.x, y: u3.y, z: u3.z, rx: 0.046, rz: 0.048, n: 2.2 },
      { x: el.x, y: el.y, z: el.z, rx: 0.043, rz: 0.045, n: 2.4 },
    ],
    12,
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

  // Carrier shoulder yoke: the padded strap that runs over the trapezius and
  // caps the deltoid. It is weighted to the clavicle rather than the arm, which
  // is where a carrier actually hangs from, and it is what turns the shoulder
  // from a shape the sleeve happens to make into a hard edge of its own.
  b.tube(
    [
      { x: 0.052 * side, y: 1.462, z: 0.02, rx: 0.05, rz: 0.036, n: 3.2 },
      { x: 0.115 * side, y: 1.468, z: 0.014, rx: 0.055, rz: 0.04, n: 3.4 },
      { x: 0.185 * side, y: 1.455, z: 0.008, rx: 0.06, rz: 0.044, n: 3.4 },
      { x: 0.238 * side, y: 1.418, z: 0.004, rx: 0.055, rz: 0.042, n: 3.2 },
      { x: 0.262 * side, y: 1.372, z: 0.002, rx: 0.044, rz: 0.036, n: 3 },
    ],
    10,
    {
      mat: 'webbing', bones: ['chest', clav, upper], bias: [1, 1.3, 0.5], rigidity: 4,
      capStart: false, capEnd: false, dark: 0.04, grime: 0.3,
    },
  )
  // Buckle on top of the yoke.
  b.box(
    new THREE.Vector3(0.132 * side, 1.5, 0.012),
    new THREE.Vector3(0.026, 0.008, 0.02),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['chest', clav], bias: [1, 1], rigidity: 5, dark: 0.18, grime: 0.3 },
    0.003,
  )
  // Sleeve seam and a shoulder patch, so the upper arm is not one clean cone.
  b.tube(
    [
      { x: u1.x, y: u1.y - 0.012, z: u1.z, rx: 0.074, rz: 0.072, n: 2.2 },
      { x: u1.x, y: u1.y - 0.03, z: u1.z, rx: 0.071, rz: 0.069, n: 2.2 },
    ],
    12,
    {
      mat: 'uniform', bones: [clav, upper], bias: [0.5, 1], rigidity: 5,
      capStart: false, capEnd: false, dark: 0.12, grime: 0.2,
    },
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
    20,
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
    20,
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
      new THREE.Vector3(0.152 * s, 1.03, -0.02),
      new THREE.Vector3(0.034, 0.058, 0.052),
      IDENT_Q,
      { mat: 'webbing', bones: ['pelvis', 'spine01'], rigidity: 5, dark: 0.06 },
      0.008,
    )
  }

  // Cummerbund: the side panel of the carrier, standing proud of the ribs and
  // running past the widest point of the torso. A carrier that is only a front
  // and a back plate leaves the figure's outline as the body's own taper.
  for (const s of [1, -1]) {
    b.tube(
      [
        { x: 0.176 * s, y: 1.09, z: 0.062, rx: 0.026, rz: 0.05, n: 3.4 },
        { x: 0.188 * s, y: 1.09, z: -0.01, rx: 0.028, rz: 0.05, n: 3.4 },
        { x: 0.174 * s, y: 1.09, z: -0.078, rx: 0.026, rz: 0.05, n: 3.4 },
      ],
      7,
      {
        mat: 'webbing', bones: ['spine01', 'spine02'], rigidity: 4,
        capStart: false, capEnd: false, dark: 0.08, grime: 0.5,
      },
    )
  }

  // Sling, from the yoke on the support side down across the chest to the
  // weapon. It is the one line on a soldier that crosses everything else, and a
  // diagonal over a stack of horizontal pouches is worth more to reading the
  // figure than any single piece of kit. The far end blends onto the shooting
  // arm's bones by proximity, so it follows the weapon rather than the torso.
  b.tube(
    [
      { x: 0.088, y: 1.478, z: -0.008, rx: 0.009, rz: 0.02, n: 3 },
      { x: 0.104, y: 1.4, z: 0.096, rx: 0.009, rz: 0.02, n: 3 },
      { x: 0.06, y: 1.3, z: 0.168, rx: 0.009, rz: 0.02, n: 3 },
      { x: -0.012, y: 1.222, z: 0.186, rx: 0.009, rz: 0.019, n: 3 },
      { x: -0.078, y: 1.196, z: 0.15, rx: 0.008, rz: 0.017, n: 3 },
    ],
    6,
    {
      mat: 'webbing', bones: ['chest', 'spine02', 'lowerArmR'], bias: [1, 1, 0.5], rigidity: 3.5,
      dark: 0.1, grime: 0.4,
    },
  )

  // The back of a soldier is in frame whenever a squadmate is ahead of the
  // camera, which in these poses is most of the time, and the rear panel was a
  // single smooth bulge. Two compression straps and a pouch offset to one side
  // break it up. They ride on the panel that is already there rather than a
  // second slab behind it — a flat plate bag at the depth the panel already
  // occupies would have been a millimetre of z-fighting across the whole back.
  for (const y of [1.32, 1.19]) {
    b.tube(
      [
        { x: -0.118, y, z: -0.156, rx: 0.008, rz: 0.019, n: 3 },
        { x: 0, y, z: -0.174, rx: 0.008, rz: 0.019, n: 3 },
        { x: 0.118, y, z: -0.156, rx: 0.008, rz: 0.019, n: 3 },
      ],
      5,
      { mat: 'webbing', bones: ['spine02', 'chest'], rigidity: 5, dark: 0.2, grime: 0.5 },
    )
  }
  b.box(
    new THREE.Vector3(0.086, 1.11, -0.166),
    new THREE.Vector3(0.05, 0.052, 0.03),
    IDENT_Q,
    { mat: 'webbing', bones: ['spine01', 'spine02'], rigidity: 5, dark: 0.08, grime: 0.6 },
    0.008,
  )
  b.tube(
    [
      { x: -0.108, y: 1.395, z: -0.148, rx: 0.038, rz: 0.038, n: 2.4 },
      { x: 0.108, y: 1.395, z: -0.148, rx: 0.038, rz: 0.038, n: 2.4 },
    ],
    8,
    { mat: 'uniform', bones: ['chest'], rigidity: 5, dark: 0.1, grime: 0.5 },
  )
}

/**
 * Helmet geometry, in metres, so the numbers below can be checked against a
 * real one. A modern high-cut shell is about 0.22 wide and 0.26 front to back,
 * its crown sits 0.02 above the skull, the brow line clears the eyebrows, the
 * side cut runs above the ear and the back sweeps down over the occiput.
 */
const HELMET_C = new THREE.Vector3(0, 1.658, 0.004)
const HELMET_R = new THREE.Vector3(0.109, 0.142, 0.121)
/** Cut height at the front, at the ears and at the back. */
const HELMET_BROW_Y = 1.7
const HELMET_EAR_Y = 1.656
const HELMET_NAPE_Y = 1.606

/** The cut height, as an ellipsoid latitude, for an azimuth measured from +Z. */
function helmetCut(theta: number): number {
  const c = Math.cos(theta)
  const front = (HELMET_BROW_Y - HELMET_C.y) / HELMET_R.y
  const ear = (HELMET_EAR_Y - HELMET_C.y) / HELMET_R.y
  const nape = (HELMET_NAPE_Y - HELMET_C.y) / HELMET_R.y
  // Quadratic through the three measured heights, plus a shallow notch over
  // the bridge of the nose so the brow line is not a smooth arc.
  const mid = ear
  const curve = (front + nape) * 0.5 - ear
  const tilt = (front - nape) * 0.5
  return mid + tilt * c + curve * c * c - Math.max(0, c - 0.9) * 0.35
}

function buildHead(b: SoldierBuilder, rng: Rand, p: Palette): void {
  const hb: BoneName[] = ['neck', 'head']

  // Skull, cut off below the mask line. There is no jaw ellipsoid any more:
  // the face covering *is* the jaw volume. The two used to be authored two
  // millimetres apart across the whole chin, which is inside depth precision at
  // any distance a soldier is normally seen from, so bright skin and near-black
  // fabric interpenetrated into a flickering scribble exactly where a mouth
  // goes. That scribble, under a helmet rim that read as a brow line, is what a
  // viewer was calling a painted-on face. One surface, no fight, no face.
  b.ellipsoid(
    new THREE.Vector3(0, 1.658, 0.002),
    new THREE.Vector3(0.081, 0.107, 0.093),
    { mat: 'skin', bones: hb, bias: [0.4, 1], rigidity: 6 },
    9, 16,
    -0.45, 1,
  )

  // Face covering: neck up over the chin, mouth and nose to the bridge.
  // Standard modern kit, period-appropriate, and it removes every part of a
  // face that cannot survive being forty pixels tall. What is left visible is a
  // sixteen-millimetre band of cheekbone between the mask and the eye-pro,
  // which at gameplay distance is a warm line rather than a feature — enough to
  // say "person", not enough to say anything else.
  b.tube(
    [
      { x: 0, y: 1.432, z: -0.004, rx: 0.071, rz: 0.073, n: 2.4 },
      { x: 0, y: 1.492, z: 0.002, rx: 0.078, rz: 0.084, n: 2.3 },
      { x: 0, y: 1.548, z: 0.01, rx: 0.084, rz: 0.095, n: 2.2 },
      { x: 0, y: 1.578, z: 0.014, rx: 0.088, rz: 0.101, n: 2.2 },
      { x: 0, y: 1.602, z: 0.013, rx: 0.089, rz: 0.101, n: 2.2 },
      { x: 0, y: 1.614, z: 0.011, rx: 0.087, rz: 0.098, n: 2.2 },
    ],
    16,
    {
      mat: 'uniform', bones: ['neck', 'head'], bias: [0.7, 1], rigidity: 5,
      capStart: false, capEnd: false, dark: 0.06, grime: 0,
      color: p.faceCover,
    },
  )
  // Folded top edge, sitting proud across the bridge. A hard dark line here is
  // most of what says "there is fabric over that face".
  b.tube(
    [
      { x: 0, y: 1.606, z: 0.012, rx: 0.092, rz: 0.104, n: 2.2 },
      { x: 0, y: 1.618, z: 0.01, rx: 0.089, rz: 0.1, n: 2.2 },
    ],
    16,
    {
      mat: 'uniform', bones: ['head'], rigidity: 6, capStart: false, capEnd: false,
      dark: 0.16, grime: 0, color: p.faceCover,
    },
  )

  // Eye protection: a dark wraparound band across the strip of face the helmet
  // leaves open. It is the only feature on the head, it is one continuous shape
  // rather than a pair of marks, and it cannot be mistaken for anything painted
  // because it stands proud of the cheekbone and takes its own specular.
  b.tube(
    [
      // The path tracks the skull's own front contour with a few millimetres of
      // clearance. Straightening it, which is what a hand-typed arc does, buries
      // the bridge of the lens inside the face and leaves the ends floating.
      { x: 0.078, y: 1.656, z: 0.04, rx: 0.007, rz: 0.0105, n: 3.2 },
      { x: 0.06, y: 1.658, z: 0.074, rx: 0.007, rz: 0.0115, n: 3.2 },
      { x: 0.022, y: 1.66, z: 0.102, rx: 0.007, rz: 0.0115, n: 3.2 },
      { x: -0.022, y: 1.66, z: 0.102, rx: 0.007, rz: 0.0115, n: 3.2 },
      { x: -0.06, y: 1.658, z: 0.074, rx: 0.007, rz: 0.0115, n: 3.2 },
      { x: -0.078, y: 1.656, z: 0.04, rx: 0.007, rz: 0.0105, n: 3.2 },
    ],
    8,
    { mat: 'gunmetal', bones: ['head'], rigidity: 6, color: new THREE.Color(0x14161a), dark: 0.05, grime: 0 },
  )

  // Helmet shell, open at the front. See `shell`.
  b.shell(
    HELMET_C, HELMET_R,
    { mat: 'helmet', bones: ['head'], rigidity: 6, dark: 0.02, grime: 0 },
    22, 8, helmetCut,
  )
  // Brow visor: a short lip carried forward and down from the front edge. This
  // is what puts a hard shadow line across the eyes, and a shadowed eye area
  // under a brim is the whole of how a helmeted head reads at distance.
  b.tube(
    [
      { x: 0.088, y: 1.688, z: 0.046, rx: 0.01, rz: 0.015, n: 3 },
      { x: 0.06, y: 1.687, z: 0.1, rx: 0.012, rz: 0.017, n: 3 },
      { x: 0, y: 1.686, z: 0.124, rx: 0.013, rz: 0.018, n: 3 },
      { x: -0.06, y: 1.687, z: 0.1, rx: 0.012, rz: 0.017, n: 3 },
      { x: -0.088, y: 1.688, z: 0.046, rx: 0.01, rz: 0.015, n: 3 },
    ],
    7,
    { mat: 'helmet', bones: ['head'], rigidity: 6, dark: 0.12, grime: 0 },
  )
  // Shock cord and a cover seam over the shell: two thin proud bands that break
  // the dome into panels instead of leaving it one unbroken highlight. Both are
  // generated as latitude rings on the shell's own ellipsoid rather than typed
  // out by hand — typed points sank inside a curve they did not follow and came
  // back out as a scatter of specks.
  for (const [lat, thick] of [[0.62, 0.0042], [0.31, 0.0035]] as const) {
    const rr = Math.sqrt(1 - lat * lat)
    const ring: Ring[] = []
    for (let i = 0; i <= 12; i++) {
      const th = (i / 12) * Math.PI * 2
      ring.push({
        x: HELMET_C.x + (HELMET_R.x + thick * 0.6) * rr * Math.sin(th),
        y: HELMET_C.y + (HELMET_R.y + thick * 0.6) * lat,
        z: HELMET_C.z + (HELMET_R.z + thick * 0.6) * rr * Math.cos(th),
        rx: thick, rz: thick,
      })
    }
    b.tube(ring, 4, { mat: 'webbing', bones: ['head'], rigidity: 6, dark: 0.14, grime: 0 })
  }

  // Night-vision shroud, on the crown where a shroud actually bolts rather than
  // in the middle of the face. It used to be a bright neutral block sitting
  // right where a nose goes, at metalness 0.72, and it was the single lightest
  // thing on the head — one of the four marks that made a closed helmet read as
  // a face. Up here it breaks the top of the silhouette instead, which is the
  // one place on a soldier where a hard edge is worth having.
  b.box(
    new THREE.Vector3(0, 1.762, 0.078),
    new THREE.Vector3(0.023, 0.014, 0.026),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.24, grime: 0, color: new THREE.Color(0x232529) },
    0.004,
  )
  b.box(
    new THREE.Vector3(0, 1.778, 0.094),
    new THREE.Vector3(0.014, 0.018, 0.011),
    IDENT_Q,
    { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.2, grime: 0, color: new THREE.Color(0x232529) },
    0.003,
  )
  // Side accessory rails, lofted along the shell so they sit on it rather than
  // floating off the widest point of a curve they do not follow.
  for (const s of [1, -1]) {
    b.tube(
      [
        { x: 0.1 * s, y: 1.688, z: -0.052, rx: 0.007, rz: 0.011, n: 3 },
        { x: 0.108 * s, y: 1.684, z: 0.004, rx: 0.008, rz: 0.012, n: 3 },
        { x: 0.098 * s, y: 1.688, z: 0.056, rx: 0.007, rz: 0.011, n: 3 },
      ],
      5,
      { mat: 'gunmetal', bones: ['head'], rigidity: 6, dark: 0.22, grime: 0, color: new THREE.Color(0x26282c) },
    )
  }
  // Counterweight pouch at the rear: real kit, and a strong silhouette break on
  // the one axis a helmet otherwise has none.
  b.box(
    new THREE.Vector3(0, 1.672, -0.108),
    new THREE.Vector3(0.052, 0.038, 0.033),
    IDENT_Q,
    { mat: 'webbing', bones: ['head'], rigidity: 6, dark: 0.1, grime: 0 },
    0.008,
  )
  // Chin strap, from the side rail down under the covering.
  for (const s of [1, -1]) {
    b.tube(
      [
        { x: 0.101 * s, y: 1.654, z: 0.008, rx: 0.006, rz: 0.013, n: 3 },
        { x: 0.095 * s, y: 1.598, z: 0.038, rx: 0.006, rz: 0.012, n: 3 },
        { x: 0.064 * s, y: 1.556, z: 0.06, rx: 0.006, rz: 0.012, n: 3 },
        { x: 0.024 * s, y: 1.536, z: 0.064, rx: 0.006, rz: 0.012, n: 3 },
      ],
      5,
      { mat: 'webbing', bones: ['head'], rigidity: 6, dark: 0.16, grime: 0 },
    )
  }

  // Loadout variety. Both options break the helmet's outline; neither of them
  // puts anything face-like on the face.
  if (rng.bool(0.45)) {
    // Goggles pushed up onto the shell.
    b.tube(
      [
        { x: 0.099, y: 1.724, z: 0.042, rx: 0.019, rz: 0.021, n: 3.4 },
        { x: 0.046, y: 1.74, z: 0.088, rx: 0.024, rz: 0.026, n: 3.4 },
        { x: -0.046, y: 1.74, z: 0.088, rx: 0.024, rz: 0.026, n: 3.4 },
        { x: -0.099, y: 1.724, z: 0.042, rx: 0.019, rz: 0.021, n: 3.4 },
      ],
      6,
      { mat: 'gunmetal', bones: ['head'], rigidity: 6, color: new THREE.Color(0x1c1d1a), dark: 0.04, grime: 0 },
    )
  }
  if (rng.bool(0.4)) {
    // A scarf tail hanging off the neck. Cloth is the only thing on a soldier
    // that reads as soft, and a loose end is worth more to a silhouette than
    // anything rigid of the same size.
    const s = rng.bool(0.5) ? 1 : -1
    b.tube(
      [
        { x: 0.03 * s, y: 1.47, z: -0.062, rx: 0.038, rz: 0.014, n: 3 },
        { x: 0.058 * s, y: 1.418, z: -0.082, rx: 0.042, rz: 0.015, n: 3 },
        { x: 0.072 * s, y: 1.352, z: -0.076, rx: 0.036, rz: 0.014, n: 3 },
        { x: 0.078 * s, y: 1.296, z: -0.058, rx: 0.026, rz: 0.012, n: 3 },
      ],
      6,
      {
        mat: 'uniform', bones: ['neck', 'chest'], bias: [1, 0.6], rigidity: 4,
        dark: 0.08, grime: 0.4, color: p.faceCover,
      },
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
 * A single white texel, shared by every character material.
 *
 * The library's detail overlay — the two-scale value layer that stops a mesh-UV
 * material from losing all its contrast down the mip chain — is injected into
 * `map_fragment` and guarded by `#ifdef USE_MAP`, because it reads `vMapUv`.
 * Nulling `map` to take over albedo therefore silently compiled the whole thing
 * out, on exactly the materials `Triplanar.ts` names as needing it most: "the
 * viewmodel, the soldiers, every crate". A one-texel white map defines USE_MAP
 * and produces `vMapUv`, costs one sampler and one multiply by 1.0, and leaves
 * albedo where it belongs — on the vertex colours.
 */
let WHITE_MAP: THREE.DataTexture | null = null
function whiteMap(): THREE.DataTexture {
  if (!WHITE_MAP) {
    WHITE_MAP = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    WHITE_MAP.colorSpace = THREE.SRGBColorSpace
    WHITE_MAP.wrapS = THREE.RepeatWrapping
    WHITE_MAP.wrapT = THREE.RepeatWrapping
    WHITE_MAP.needsUpdate = true
  }
  return WHITE_MAP
}

/**
 * Borrows the material library's surface response — normal, roughness and the
 * two-scale detail overlay, which is where "not a flat untextured surface"
 * comes from — but takes over albedo entirely. The library authors its base
 * colours for walls and ground; stacking one on top of the vertex camo would
 * double up two unrelated darkening terms and sink the character into mud.
 *
 * Built from scratch and wired up by hand rather than with `clone()`. Two
 * things were wrong with cloning, both measured:
 *
 * 1. **`Material.copy` does not carry `onBeforeCompile`.** The detail overlay
 *    lives entirely in that callback, so no soldier has ever had it — on the
 *    exact materials `Triplanar.ts` names as needing it most, and whose own
 *    contrast it measures falling by two thirds across the mip chain. The
 *    overlay is also guarded by `#ifdef USE_MAP`, which is why `map` is a
 *    shared white texel rather than null.
 * 2. **`Material.copy` round-trips `userData` through JSON**, and the library
 *    parks the shared 1024x1024 detail texture in there inside the overlay's
 *    uniform block. `Texture.toJSON` serialises the whole four-megabyte image,
 *    so each clone cost 70-190 ms measured on this machine. Eighteen of them
 *    run during `init`.
 */
function characterMaterial(mats: MaterialService | undefined, name: CharMaterial): THREE.Material {
  const src = mats?.get(name) as THREE.MeshStandardMaterial | undefined
  const m = src instanceof THREE.MeshPhysicalMaterial
    ? new THREE.MeshPhysicalMaterial()
    : new THREE.MeshStandardMaterial()
  m.name = `soldier.${name}`
  m.vertexColors = true
  m.color.setHex(BASE_COLOR[name])
  m.side = THREE.FrontSide
  m.shadowSide = THREE.FrontSide

  if (src) {
    m.map = whiteMap()
    m.normalMap = src.normalMap
    m.normalScale.copy(src.normalScale)
    m.roughnessMap = src.roughnessMap
    m.metalnessMap = src.metalnessMap
    // Occlusion rides in the ORM's red channel and only ever multiplies
    // indirect light, so keeping it deepens the weave and the cavities without
    // touching anything the key light does.
    m.aoMap = src.aoMap
    m.aoMapIntensity = 0.65
    m.envMapIntensity = src.envMapIntensity
    if (m instanceof THREE.MeshPhysicalMaterial && src instanceof THREE.MeshPhysicalMaterial) {
      m.sheen = src.sheen
      m.sheenRoughness = src.sheenRoughness
      m.sheenColor.copy(src.sheenColor)
      m.clearcoat = src.clearcoat
      m.clearcoatRoughness = src.clearcoatRoughness
    }
    // By reference, so the overlay's uniform block is shared rather than
    // serialised. Both are plain properties on the source instance.
    m.onBeforeCompile = src.onBeforeCompile
    m.customProgramCacheKey = src.customProgramCacheKey
    m.userData = { surface: src.userData.surface, materialName: name }
  }

  m.roughness = name === 'gunmetal' ? 0.44 : name === 'skin' ? 0.58 : name === 'bootLeather' ? 0.6 : 0.85
  if (name === 'gunmetal') m.metalness = 0.72
  else if (name === 'helmet') m.metalness = 0.06
  else m.metalness = 0.02
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
  buildHead(b, rng, palette)
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
