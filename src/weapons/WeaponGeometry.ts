import * as THREE from 'three'
import { Rand } from '../core/Rand'

/**
 * Procedural weapon construction: textures, materials, chamfered primitives and
 * the part builders that assemble each viewmodel.
 *
 * Every weapon is built from beveled boxes and low-segment cylinders. The bevel
 * is not decoration: each chamfer carries an `aWear` attribute of 1.0, and the
 * material shader lifts albedo toward bare metal and drops roughness there, so
 * edges read as polished-through finish exactly where a real firearm wears.
 */

// ---------------------------------------------------------------------------
// Procedural noise
// ---------------------------------------------------------------------------

/** Periodic value-noise pyramid. Tiles seamlessly so textures repeat cleanly. */
class NoiseField {
  private grids: Float32Array[] = []
  private sizes: number[] = []

  constructor(rand: Rand, levels = 7) {
    for (let l = 0; l < levels; l++) {
      const n = 1 << (l + 2)
      const g = new Float32Array(n * n)
      for (let i = 0; i < g.length; i++) g[i] = rand.next()
      this.grids.push(g)
      this.sizes.push(n)
    }
  }

  sample(level: number, u: number, v: number): number {
    const l = Math.min(level, this.grids.length - 1)
    const g = this.grids[l]
    const n = this.sizes[l]
    const x = u * n
    const y = v * n
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const j0 = ((x0 % n) + n) % n
    const j1 = (j0 + 1) % n
    const i0 = ((y0 % n) + n) % n
    const i1 = (i0 + 1) % n
    const a = g[i0 * n + j0]
    const b = g[i0 * n + j1]
    const c = g[i1 * n + j0]
    const d = g[i1 * n + j1]
    const top = a + (b - a) * sx
    const bot = c + (d - c) * sx
    return top + (bot - top) * sy
  }

  fbm(u: number, v: number, from: number, octaves: number): number {
    let amp = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(from + o, u, v)
      norm += amp
      amp *= 0.5
    }
    return sum / norm
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6))
  return t * t * (3 - 2 * t)
}

function makeDataTexture(data: Uint8Array, size: number, srgb: boolean, aniso: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = aniso
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** Sobel a height field into a tangent-space normal map. */
function heightToNormalTexture(height: Float32Array, size: number, strength: number, aniso: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      let nx = -dx * strength
      let ny = -dy * strength
      const nz = 1
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx *= inv
      ny *= inv
      const i = (y * size + x) * 4
      data[i] = Math.round((nx * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  }
  return makeDataTexture(data, size, false, aniso)
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _n = new THREE.Vector3()
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
const _uv = new THREE.Vector2()
const _mv = new THREE.Vector3()
const _nm3 = new THREE.Matrix3()

class GeomBuf {
  pos: number[] = []
  nrm: number[] = []
  uvs: number[] = []
  wear: number[] = []

  private vertex(p: THREE.Vector3, n: THREE.Vector3, w: number): void {
    this.pos.push(p.x, p.y, p.z)
    this.nrm.push(n.x, n.y, n.z)
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    if (ax >= ay && ax >= az) _uv.set(p.z, p.y)
    else if (ay >= az) _uv.set(p.x, p.z)
    else _uv.set(p.x, p.y)
    this.uvs.push(_uv.x, _uv.y)
    this.wear.push(w)
  }

  tri(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: THREE.Vector3, w: number): void {
    _e1.subVectors(p1, p0)
    _e2.subVectors(p2, p0)
    _n.crossVectors(_e1, _e2)
    if (_n.dot(n) >= 0) {
      this.vertex(p0, n, w)
      this.vertex(p1, n, w)
      this.vertex(p2, n, w)
    } else {
      this.vertex(p0, n, w)
      this.vertex(p2, n, w)
      this.vertex(p1, n, w)
    }
  }

  quad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, n: THREE.Vector3, w: number): void {
    this.tri(p0, p1, p2, n, w)
    this.tri(p0, p2, p3, n, w)
  }

  /** Same as quad but with per-vertex wear, for graded edges on curved parts. */
  quadW(
    p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
    n0: THREE.Vector3, n1: THREE.Vector3, n2: THREE.Vector3, n3: THREE.Vector3,
    w0: number, w1: number, w2: number, w3: number,
  ): void {
    _e1.subVectors(p1, p0)
    _e2.subVectors(p2, p0)
    _n.crossVectors(_e1, _e2)
    const flip = _n.dot(n0) < 0
    if (!flip) {
      this.vertex(p0, n0, w0); this.vertex(p1, n1, w1); this.vertex(p2, n2, w2)
      this.vertex(p0, n0, w0); this.vertex(p2, n2, w2); this.vertex(p3, n3, w3)
    } else {
      this.vertex(p0, n0, w0); this.vertex(p2, n2, w2); this.vertex(p1, n1, w1)
      this.vertex(p0, n0, w0); this.vertex(p3, n3, w3); this.vertex(p2, n2, w2)
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    g.setAttribute('aWear', new THREE.Float32BufferAttribute(this.wear, 1))
    return g
  }
}

const SIGNS: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
]

/**
 * Beveled box. 44 triangles; every silhouette edge is a 45 degree chamfer that
 * catches a specular line, which is what separates a machined part from a cube.
 */
export function chamferBox(w: number, h: number, d: number, chamfer = 0.0015): THREE.BufferGeometry {
  const X = w * 0.5
  const Y = h * 0.5
  const Z = d * 0.5
  const c = Math.min(chamfer, X * 0.49, Y * 0.49, Z * 0.49)
  const g = new GeomBuf()

  const vx = (sx: number, sy: number, sz: number, out: THREE.Vector3) => out.set(sx * X, sy * (Y - c), sz * (Z - c))
  const vy = (sx: number, sy: number, sz: number, out: THREE.Vector3) => out.set(sx * (X - c), sy * Y, sz * (Z - c))
  const vz = (sx: number, sy: number, sz: number, out: THREE.Vector3) => out.set(sx * (X - c), sy * (Y - c), sz * Z)

  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const p3 = new THREE.Vector3()

  // Six primary faces.
  for (const s of [-1, 1]) {
    _n.set(s, 0, 0)
    vx(s, -1, -1, p0); vx(s, 1, -1, p1); vx(s, 1, 1, p2); vx(s, -1, 1, p3)
    g.quad(p0, p1, p2, p3, _n, 0)
    _n.set(0, s, 0)
    vy(-1, s, -1, p0); vy(1, s, -1, p1); vy(1, s, 1, p2); vy(-1, s, 1, p3)
    g.quad(p0, p1, p2, p3, _n, 0)
    _n.set(0, 0, s)
    vz(-1, -1, s, p0); vz(1, -1, s, p1); vz(1, 1, s, p2); vz(-1, 1, s, p3)
    g.quad(p0, p1, p2, p3, _n, 0)
  }

  // Twelve edge bevels.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      _n.set(sx, sy, 0).normalize()
      vx(sx, sy, -1, p0); vx(sx, sy, 1, p1); vy(sx, sy, 1, p2); vy(sx, sy, -1, p3)
      g.quad(p0, p1, p2, p3, _n, 1)
    }
    for (const sz of [-1, 1]) {
      _n.set(sx, 0, sz).normalize()
      vx(sx, -1, sz, p0); vx(sx, 1, sz, p1); vz(sx, 1, sz, p2); vz(sx, -1, sz, p3)
      g.quad(p0, p1, p2, p3, _n, 1)
    }
  }
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      _n.set(0, sy, sz).normalize()
      vy(-1, sy, sz, p0); vy(1, sy, sz, p1); vz(1, sy, sz, p2); vz(-1, sy, sz, p3)
      g.quad(p0, p1, p2, p3, _n, 1)
    }
  }

  // Eight corner triangles.
  for (const [sx, sy, sz] of SIGNS) {
    _n.set(sx, sy, sz).normalize()
    vx(sx, sy, sz, p0); vy(sx, sy, sz, p1); vz(sx, sy, sz, p2)
    g.tri(p0, p1, p2, _n, 1)
  }

  return g.toGeometry()
}

export interface CylOpts {
  segments?: number
  capTop?: boolean
  capBottom?: boolean
  /** Fraction of a full turn, for partial shrouds. */
  thetaLength?: number
  thetaStart?: number
  /** How sharply the polished rim wear falls off toward the middle. */
  rimPower?: number
  /** Flat-shade the sides (machined facets) instead of smoothing them. */
  faceted?: boolean
}

/** Cylinder along +Y with graded rim wear and machined-facet option. */
export function cylGeom(rTop: number, rBottom: number, height: number, o: CylOpts = {}): THREE.BufferGeometry {
  const seg = o.segments ?? 16
  const thetaLength = o.thetaLength ?? Math.PI * 2
  const thetaStart = o.thetaStart ?? 0
  const closed = Math.abs(thetaLength - Math.PI * 2) < 1e-4
  const rimPower = o.rimPower ?? 6
  const g = new GeomBuf()
  const hy = height * 0.5

  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const n0 = new THREE.Vector3()
  const n1 = new THREE.Vector3()
  const slope = (rBottom - rTop) / Math.max(height, 1e-5)
  const wRim = 1
  const wMid = 0.04
  const gradeAt = (t: number) => wMid + (wRim - wMid) * Math.pow(t, rimPower)

  for (let i = 0; i < seg; i++) {
    const t0 = thetaStart + (i / seg) * thetaLength
    const t1 = thetaStart + ((i + 1) / seg) * thetaLength
    const c0 = Math.cos(t0)
    const s0 = Math.sin(t0)
    const c1 = Math.cos(t1)
    const s1 = Math.sin(t1)
    p0.set(c0 * rTop, hy, s0 * rTop)
    p1.set(c1 * rTop, hy, s1 * rTop)
    p2.set(c1 * rBottom, -hy, s1 * rBottom)
    p3.set(c0 * rBottom, -hy, s0 * rBottom)
    if (o.faceted) {
      const cm = Math.cos((t0 + t1) * 0.5)
      const sm = Math.sin((t0 + t1) * 0.5)
      n0.set(cm, slope, sm).normalize()
      g.quadW(p0, p1, p2, p3, n0, n0, n0, n0, gradeAt(1), gradeAt(1), gradeAt(1), gradeAt(1))
    } else {
      n0.set(c0, slope, s0).normalize()
      n1.set(c1, slope, s1).normalize()
      g.quadW(p0, p1, p2, p3, n0, n1, n1, n0, gradeAt(1), gradeAt(1), gradeAt(1), gradeAt(1))
    }
  }

  if (o.capTop !== false) {
    _n.set(0, 1, 0)
    const cen = new THREE.Vector3(0, hy, 0)
    for (let i = 0; i < seg; i++) {
      const t0 = thetaStart + (i / seg) * thetaLength
      const t1 = thetaStart + ((i + 1) / seg) * thetaLength
      p0.set(Math.cos(t0) * rTop, hy, Math.sin(t0) * rTop)
      p1.set(Math.cos(t1) * rTop, hy, Math.sin(t1) * rTop)
      g.tri(cen, p0, p1, _n, 0.5)
    }
  }
  if (o.capBottom !== false) {
    _n.set(0, -1, 0)
    const cen = new THREE.Vector3(0, -hy, 0)
    for (let i = 0; i < seg; i++) {
      const t0 = thetaStart + (i / seg) * thetaLength
      const t1 = thetaStart + ((i + 1) / seg) * thetaLength
      p0.set(Math.cos(t0) * rBottom, -hy, Math.sin(t0) * rBottom)
      p1.set(Math.cos(t1) * rBottom, -hy, Math.sin(t1) * rBottom)
      g.tri(cen, p0, p1, _n, 0.5)
    }
  }
  if (!closed) {
    // Seal the pie slice so partial shrouds are not see-through.
    for (const t of [thetaStart, thetaStart + thetaLength]) {
      const cs = Math.cos(t)
      const sn = Math.sin(t)
      _n.set(sn, 0, -cs)
      p0.set(cs * rTop, hy, sn * rTop)
      p1.set(cs * rBottom, -hy, sn * rBottom)
      p2.set(0, -hy, 0)
      p3.set(0, hy, 0)
      g.quad(p0, p1, p2, p3, _n, 0.3)
    }
  }
  return g.toGeometry()
}

/** Flat disc facing +Z, used for lenses. */
export function discGeom(radius: number, segments = 32): THREE.BufferGeometry {
  const g = new GeomBuf()
  const cen = new THREE.Vector3()
  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  _n.set(0, 0, 1)
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2
    const t1 = ((i + 1) / segments) * Math.PI * 2
    p0.set(Math.cos(t0) * radius, Math.sin(t0) * radius, 0)
    p1.set(Math.cos(t1) * radius, Math.sin(t1) * radius, 0)
    g.tri(cen, p0, p1, _n, 0)
  }
  return g.toGeometry()
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export type WeaponMatKey =
  | 'gunmetal' | 'phosphate' | 'steel' | 'polymer' | 'polymerTan' | 'rubber'
  | 'glass' | 'glassFront' | 'glove' | 'sleeve' | 'brass' | 'dark' | 'anodised'

interface WearParams {
  color: number
  roughness: number
  metalness: number
  wearColor: number
  wearAlbedo: number
  wearRough: number
  wearMetal: number
  envIntensity: number
  normalScale: number
}

/**
 * Shared texture + material library. One instance is built at init and reused
 * across every weapon so the whole arsenal shares a finish vocabulary.
 */
export class WeaponMaterials {
  private cache = new Map<string, THREE.Material>()
  readonly metalNormal: THREE.DataTexture
  readonly metalRough: THREE.DataTexture
  readonly metalAlbedo: THREE.DataTexture
  readonly polymerNormal: THREE.DataTexture
  readonly polymerRough: THREE.DataTexture
  readonly fabricNormal: THREE.DataTexture
  readonly camoAlbedo: THREE.DataTexture
  readonly gloveNormal: THREE.DataTexture
  readonly dotTexture: THREE.DataTexture
  readonly crossTexture: THREE.DataTexture
  readonly glareTexture: THREE.DataTexture

  constructor(seed: number, anisotropy: number) {
    const rand = new Rand(seed ^ 0x5eed)
    const noise = new NoiseField(rand)
    const S = 256

    // --- machined metal: fine grain, tool marks, pitting, long scratches ---
    const mh = new Float32Array(S * S)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S
        const v = y / S
        // Anisotropic grain: stretched along U to read as machining direction.
        const grain = noise.fbm(u * 0.35, v * 3.0, 3, 3)
        const pits = Math.pow(noise.fbm(u, v, 4, 2), 5)
        mh[y * S + x] = grain * 0.35 + pits * 1.2
      }
    }
    const scratch = (count: number, len: number, depth: number, wob: number) => {
      for (let i = 0; i < count; i++) {
        let x = rand.next() * S
        let y = rand.next() * S
        let ang = rand.bool(0.72) ? rand.spread(0.22) : Math.PI * 0.5 + rand.spread(0.5)
        const steps = Math.floor(len * (0.5 + rand.next()))
        for (let s = 0; s < steps; s++) {
          ang += rand.spread(wob)
          x += Math.cos(ang)
          y += Math.sin(ang)
          const xi = ((Math.round(x) % S) + S) % S
          const yi = ((Math.round(y) % S) + S) % S
          mh[yi * S + xi] += depth
        }
      }
    }
    scratch(90, 26, -0.55, 0.05)
    scratch(30, 60, -0.3, 0.02)
    this.metalNormal = heightToNormalTexture(mh, S, 0.28, anisotropy)

    const mr = new Uint8Array(S * S * 4)
    const ma = new Uint8Array(S * S * 4)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S
        const v = y / S
        const i = (y * S + x) * 4
        const blotch = noise.fbm(u, v, 1, 4)
        const fine = noise.fbm(u, v, 4, 2)
        const h = mh[y * S + x]
        // Scratches polish: locally lower roughness where metal is exposed.
        const polish = clamp01(-h * 0.9)
        let rough = 0.62 + (blotch - 0.5) * 0.34 + (fine - 0.5) * 0.12 - polish * 0.35
        rough = clamp01(rough)
        const rb = Math.round(rough * 255)
        mr[i] = rb; mr[i + 1] = rb; mr[i + 2] = rb; mr[i + 3] = 255
        // Albedo: soot/oil mottling plus brighter exposed metal in scratches.
        const dirt = smoothstep(0.62, 0.86, blotch) * 0.25
        const shine = polish * 0.5
        const lum = clamp01(0.78 - dirt + shine + (fine - 0.5) * 0.1)
        ma[i] = Math.round(lum * 252)
        ma[i + 1] = Math.round(lum * 250)
        ma[i + 2] = Math.round(lum * 255)
        ma[i + 3] = 255
      }
    }
    this.metalRough = makeDataTexture(mr, S, false, anisotropy)
    this.metalAlbedo = makeDataTexture(ma, S, true, anisotropy)

    // --- polymer: injection-moulded stipple ---
    const ph = new Float32Array(S * S)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S
        const v = y / S
        const cell = noise.sample(5, u, v)
        const fine = noise.sample(6, u, v)
        const broad = noise.fbm(u, v, 2, 3)
        ph[y * S + x] = Math.pow(cell, 1.6) * 0.9 + fine * 0.5 + broad * 0.25
      }
    }
    this.polymerNormal = heightToNormalTexture(ph, S, 0.55, anisotropy)
    const pr = new Uint8Array(S * S * 4)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4
        const u = x / S
        const v = y / S
        const sheen = noise.fbm(u, v, 2, 3)
        const wearShine = Math.pow(clamp01(ph[y * S + x] - 0.85), 1.5) * 0.5
        const rough = clamp01(0.74 + (sheen - 0.5) * 0.2 - wearShine)
        const rb = Math.round(rough * 255)
        pr[i] = rb; pr[i + 1] = rb; pr[i + 2] = rb; pr[i + 3] = 255
      }
    }
    this.polymerRough = makeDataTexture(pr, S, false, anisotropy)

    // --- fabric weave for sleeves and slings ---
    const F = 128
    const fh = new Float32Array(F * F)
    for (let y = 0; y < F; y++) {
      for (let x = 0; x < F; x++) {
        const weave = Math.sin(x * Math.PI * 0.5) * Math.sin(y * Math.PI * 0.5)
        const fuzz = noise.fbm(x / F, y / F, 4, 2)
        fh[y * F + x] = weave * 0.5 + fuzz * 0.6
      }
    }
    this.fabricNormal = heightToNormalTexture(fh, F, 0.5, anisotropy)

    // --- multicam-ish camo for the sleeve ---
    const C = 256
    const cam = new Uint8Array(C * C * 4)
    const palette: [number, number, number][] = [
      [0.30, 0.29, 0.22],
      [0.44, 0.41, 0.29],
      [0.22, 0.23, 0.19],
      [0.53, 0.47, 0.33],
      [0.16, 0.17, 0.15],
    ]
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = x / C
        const v = y / C
        const big = noise.fbm(u, v, 1, 3)
        const mid = noise.fbm(u * 1.0 + 0.31, v * 1.0 + 0.17, 2, 3)
        const spot = noise.fbm(u + 0.61, v + 0.44, 4, 2)
        let idx = big < 0.42 ? 2 : big < 0.55 ? 0 : big < 0.7 ? 1 : 3
        if (mid > 0.72) idx = 1
        if (spot > 0.84) idx = 4
        const p = palette[idx]
        const grit = (noise.sample(6, u, v) - 0.5) * 0.06
        const i = (y * C + x) * 4
        cam[i] = Math.round(clamp01(p[0] + grit) * 255)
        cam[i + 1] = Math.round(clamp01(p[1] + grit) * 255)
        cam[i + 2] = Math.round(clamp01(p[2] + grit) * 255)
        cam[i + 3] = 255
      }
    }
    this.camoAlbedo = makeDataTexture(cam, C, true, anisotropy)

    // --- glove: pebbled synthetic leather ---
    const gh = new Float32Array(F * F)
    for (let y = 0; y < F; y++) {
      for (let x = 0; x < F; x++) {
        const u = x / F
        const v = y / F
        gh[y * F + x] = Math.pow(noise.sample(4, u, v), 1.3) + noise.sample(6, u, v) * 0.35
      }
    }
    this.gloveNormal = heightToNormalTexture(gh, F, 0.6, anisotropy)

    // --- reticle sprites ---
    this.dotTexture = this.makeDot(64)
    this.crossTexture = this.makeCrosshair(128)
    this.glareTexture = this.makeGlare(64)
  }

  private makeDot(S: number): THREE.DataTexture {
    const data = new Uint8Array(S * S * 4)
    const cx = (S - 1) * 0.5
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x - cx) / (S * 0.5)
        const dy = (y - cx) / (S * 0.5)
        const r = Math.sqrt(dx * dx + dy * dy)
        // Tight core with an emitter halo, so bloom picks it up naturally.
        const core = Math.pow(clamp01(1 - r / 0.34), 1.4)
        const halo = Math.pow(clamp01(1 - r), 3.2) * 0.28
        const a = clamp01(core + halo)
        const i = (y * S + x) * 4
        data[i] = 255
        data[i + 1] = Math.round(clamp01(0.16 + core * 0.5) * 255)
        data[i + 2] = Math.round(clamp01(0.08 + core * 0.35) * 255)
        data[i + 3] = Math.round(a * 255)
      }
    }
    const t = makeDataTexture(data, S, false, 1)
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    return t
  }

  private makeCrosshair(S: number): THREE.DataTexture {
    const data = new Uint8Array(S * S * 4)
    const cx = (S - 1) * 0.5
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - cx
        const dy = y - cx
        const ar = Math.abs(dx)
        const ab = Math.abs(dy)
        let a = 0
        const thin = 0.9
        // Cross arms that stop short of the centre.
        if (ar < thin && ab > 2.5) a = Math.max(a, clamp01(1 - ab / (S * 0.48)))
        if (ab < thin && ar > 2.5) a = Math.max(a, clamp01(1 - ar / (S * 0.48)))
        // Mil dots down the vertical post.
        for (let k = 1; k <= 3; k++) {
          const py = k * S * 0.115
          const d = Math.sqrt(dx * dx + (dy - py) * (dy - py))
          if (d < 1.5) a = Math.max(a, 1 - d / 1.5)
        }
        if (ar < 0.9 && ab < 0.9) a = Math.max(a, 1)
        const i = (y * S + x) * 4
        data[i] = 12
        data[i + 1] = 14
        data[i + 2] = 15
        data[i + 3] = Math.round(clamp01(a) * 255)
      }
    }
    const t = makeDataTexture(data, S, false, 1)
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    return t
  }

  private makeGlare(S: number): THREE.DataTexture {
    const data = new Uint8Array(S * S * 4)
    const cx = (S - 1) * 0.5
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x - cx) / (S * 0.5)
        const dy = (y - cx) / (S * 0.5)
        const r = Math.sqrt(dx * dx + dy * dy)
        const a = Math.pow(clamp01(1 - r), 2.4)
        const i = (y * S + x) * 4
        data[i] = 150; data[i + 1] = 190; data[i + 2] = 255
        data[i + 3] = Math.round(a * 255)
      }
    }
    const t = makeDataTexture(data, S, false, 1)
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    return t
  }

  /**
   * Standard material with an `aWear` driven edge-wear term injected into the
   * albedo, roughness and metalness of the physical shading model.
   */
  private wearMaterial(key: string, p: WearParams, maps: {
    map?: THREE.Texture, roughnessMap?: THREE.Texture, normalMap?: THREE.Texture,
  }): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: p.color,
      roughness: p.roughness,
      metalness: p.metalness,
      envMapIntensity: p.envIntensity,
      dithering: true,
    })
    if (maps.map) m.map = maps.map
    if (maps.roughnessMap) m.roughnessMap = maps.roughnessMap
    if (maps.normalMap) {
      m.normalMap = maps.normalMap
      m.normalScale = new THREE.Vector2(p.normalScale, p.normalScale)
    }
    const wc = new THREE.Color(p.wearColor).convertSRGBToLinear()
    const f = (v: number) => v.toFixed(4)
    m.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float aWear;\nvarying float vWearF;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvWearF = aWear;')
      shader.fragmentShader =
        'varying float vWearF;\n' +
        shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>
	float wf = clamp( vWearF, 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( ${f(wc.r)}, ${f(wc.g)}, ${f(wc.b)} ), wf * ${f(p.wearAlbedo)} );`)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, ${f(p.wearRough)}, clamp( vWearF, 0.0, 1.0 ) );`)
          .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 1.0, clamp( vWearF, 0.0, 1.0 ) * ${f(p.wearMetal)} );`)
    }
    m.customProgramCacheKey = () => `wear-${key}`
    m.name = key
    return m
  }

  get(key: WeaponMatKey): THREE.Material {
    const hit = this.cache.get(key)
    if (hit) return hit
    let mat: THREE.Material
    switch (key) {
      case 'gunmetal':
        mat = this.wearMaterial(key, {
          color: 0x30322f, roughness: 0.52, metalness: 0.94,
          wearColor: 0xc9ccd0, wearAlbedo: 0.75, wearRough: 0.19, wearMetal: 1,
          envIntensity: 1.0, normalScale: 0.7,
        }, { map: this.metalAlbedo, roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'anodised':
        mat = this.wearMaterial(key, {
          color: 0x22252a, roughness: 0.46, metalness: 0.9,
          wearColor: 0xb9bec6, wearAlbedo: 0.8, wearRough: 0.16, wearMetal: 1,
          envIntensity: 1.05, normalScale: 0.55,
        }, { map: this.metalAlbedo, roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'phosphate':
        mat = this.wearMaterial(key, {
          color: 0x1b1d1f, roughness: 0.66, metalness: 0.85,
          wearColor: 0x8f949a, wearAlbedo: 0.6, wearRough: 0.26, wearMetal: 1,
          envIntensity: 0.85, normalScale: 0.85,
        }, { map: this.metalAlbedo, roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'steel':
        mat = this.wearMaterial(key, {
          color: 0x8d949b, roughness: 0.3, metalness: 1,
          wearColor: 0xd8dde2, wearAlbedo: 0.65, wearRough: 0.12, wearMetal: 1,
          envIntensity: 1.25, normalScale: 0.45,
        }, { map: this.metalAlbedo, roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'dark':
        mat = this.wearMaterial(key, {
          color: 0x0a0b0c, roughness: 0.78, metalness: 0.4,
          wearColor: 0x6d7176, wearAlbedo: 0.35, wearRough: 0.4, wearMetal: 0.6,
          envIntensity: 0.5, normalScale: 0.6,
        }, { roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'polymer':
        mat = this.wearMaterial(key, {
          color: 0x191b1c, roughness: 0.74, metalness: 0.03,
          wearColor: 0x53575a, wearAlbedo: 0.45, wearRough: 0.42, wearMetal: 0.05,
          envIntensity: 0.7, normalScale: 0.9,
        }, { roughnessMap: this.polymerRough, normalMap: this.polymerNormal })
        break
      case 'polymerTan':
        mat = this.wearMaterial(key, {
          color: 0x6d5c42, roughness: 0.78, metalness: 0.02,
          wearColor: 0x9c8b6d, wearAlbedo: 0.5, wearRough: 0.5, wearMetal: 0.05,
          envIntensity: 0.65, normalScale: 0.9,
        }, { roughnessMap: this.polymerRough, normalMap: this.polymerNormal })
        break
      case 'rubber':
        mat = this.wearMaterial(key, {
          color: 0x0f1011, roughness: 0.93, metalness: 0.0,
          wearColor: 0x3a3c3e, wearAlbedo: 0.3, wearRough: 0.7, wearMetal: 0,
          envIntensity: 0.35, normalScale: 1.15,
        }, { roughnessMap: this.polymerRough, normalMap: this.polymerNormal })
        break
      case 'brass':
        mat = this.wearMaterial(key, {
          color: 0xa8813a, roughness: 0.32, metalness: 1,
          wearColor: 0xe2c07a, wearAlbedo: 0.6, wearRough: 0.16, wearMetal: 1,
          envIntensity: 1.2, normalScale: 0.4,
        }, { roughnessMap: this.metalRough, normalMap: this.metalNormal })
        break
      case 'glove':
        mat = this.wearMaterial(key, {
          color: 0x24211e, roughness: 0.8, metalness: 0.0,
          wearColor: 0x4a453f, wearAlbedo: 0.35, wearRough: 0.62, wearMetal: 0,
          envIntensity: 0.45, normalScale: 1.0,
        }, { roughnessMap: this.polymerRough, normalMap: this.gloveNormal })
        break
      case 'sleeve':
        mat = this.wearMaterial(key, {
          color: 0xbfbfbf, roughness: 0.92, metalness: 0.0,
          wearColor: 0x8a8574, wearAlbedo: 0.25, wearRough: 0.85, wearMetal: 0,
          envIntensity: 0.4, normalScale: 0.8,
        }, { map: this.camoAlbedo, normalMap: this.fabricNormal })
        break
      case 'glass':
      case 'glassFront': {
        const g = new THREE.MeshStandardMaterial({
          color: key === 'glass' ? 0x121c2c : 0x0d1622,
          roughness: 0.035,
          metalness: 0.15,
          transparent: true,
          opacity: key === 'glass' ? 0.5 : 0.62,
          envMapIntensity: 2.6,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        g.name = key
        mat = g
        break
      }
      default:
        mat = new THREE.MeshStandardMaterial({ color: 0x555555 })
    }
    this.cache.set(key, mat)
    return mat
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    this.cache.clear()
    for (const t of [
      this.metalNormal, this.metalRough, this.metalAlbedo, this.polymerNormal,
      this.polymerRough, this.fabricNormal, this.camoAlbedo, this.gloveNormal,
      this.dotTexture, this.crossTexture, this.glareTexture,
    ]) t.dispose()
  }
}

// ---------------------------------------------------------------------------
// Part builder
// ---------------------------------------------------------------------------

interface Chunk {
  geom: THREE.BufferGeometry
  matrix: THREE.Matrix4
  wear: number
  uv: number
}

export interface PartOpts {
  rot?: [number, number, number]
  /** Chamfer size for boxes, metres. */
  c?: number
  /** Extra wear added on top of the geometry's own edge mask. */
  wear?: number
  /** Texture repeats per metre. */
  uv?: number
  scale?: [number, number, number]
  /** Cylinder axis; default 'z' (down the bore). */
  axis?: 'x' | 'y' | 'z'
  seg?: number
  caps?: boolean
  faceted?: boolean
  thetaLength?: number
  thetaStart?: number
}

const _mtx = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _eul = new THREE.Euler()
const _scl = new THREE.Vector3()

/**
 * Accumulates transformed primitives and merges them into one mesh per material
 * per target group. Keeps the whole rifle at roughly a dozen draw calls while
 * still allowing animated sub-parts to live in their own groups.
 */
export class PartBuilder {
  private targets = new Map<THREE.Object3D, Map<WeaponMatKey, Chunk[]>>()
  target: THREE.Object3D

  constructor(private mats: WeaponMaterials, root: THREE.Object3D) {
    this.target = root
  }

  into(target: THREE.Object3D): this {
    this.target = target
    return this
  }

  addGeom(mat: WeaponMatKey, geom: THREE.BufferGeometry, matrix: THREE.Matrix4, wear = 0, uv = 24): void {
    let byMat = this.targets.get(this.target)
    if (!byMat) {
      byMat = new Map()
      this.targets.set(this.target, byMat)
    }
    let list = byMat.get(mat)
    if (!list) {
      list = []
      byMat.set(mat, list)
    }
    list.push({ geom, matrix: matrix.clone(), wear, uv })
  }

  private compose(pos: [number, number, number], o?: PartOpts): THREE.Matrix4 {
    const r = o?.rot
    _eul.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'XYZ')
    _q.setFromEuler(_eul)
    const s = o?.scale
    _scl.set(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1)
    return _mtx.compose(_a.set(pos[0], pos[1], pos[2]), _q, _scl)
  }

  box(mat: WeaponMatKey, size: [number, number, number], pos: [number, number, number], o?: PartOpts): void {
    const g = chamferBox(size[0], size[1], size[2], o?.c ?? 0.0016)
    this.addGeom(mat, g, this.compose(pos, o), o?.wear ?? 0, o?.uv ?? 24)
  }

  /** Cylinder; `axis` rotates the +Y primitive onto x/y/z. */
  tube(mat: WeaponMatKey, rTop: number, rBottom: number, len: number, pos: [number, number, number], o?: PartOpts): void {
    const g = cylGeom(rTop, rBottom, len, {
      segments: o?.seg ?? 14,
      capTop: o?.caps !== false,
      capBottom: o?.caps !== false,
      faceted: o?.faceted,
      thetaLength: o?.thetaLength,
      thetaStart: o?.thetaStart,
    })
    const axis = o?.axis ?? 'z'
    const r = o?.rot ?? [0, 0, 0]
    const pre = axis === 'z' ? [Math.PI / 2, 0, 0] : axis === 'x' ? [0, 0, Math.PI / 2] : [0, 0, 0]
    _eul.set(r[0] + pre[0], r[1] + pre[1], r[2] + pre[2], 'YXZ')
    _q.setFromEuler(_eul)
    _scl.set(1, 1, 1)
    _mtx.compose(_a.set(pos[0], pos[1], pos[2]), _q, _scl)
    this.addGeom(mat, g, _mtx, o?.wear ?? 0, o?.uv ?? 24)
  }

  disc(mat: WeaponMatKey, radius: number, pos: [number, number, number], o?: PartOpts): void {
    const g = discGeom(radius, o?.seg ?? 32)
    this.addGeom(mat, g, this.compose(pos, o), o?.wear ?? 0, o?.uv ?? 24)
  }

  /** Merges everything accumulated and attaches the meshes to their groups. */
  build(): void {
    for (const [target, byMat] of this.targets) {
      for (const [matKey, chunks] of byMat) {
        const geom = mergeChunks(chunks)
        const mesh = new THREE.Mesh(geom, this.mats.get(matKey))
        mesh.name = `${target.name || 'part'}_${matKey}`
        mesh.castShadow = matKey !== 'glass' && matKey !== 'glassFront'
        mesh.receiveShadow = true
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        target.add(mesh)
      }
    }
    this.targets.clear()
  }
}

function mergeChunks(chunks: Chunk[]): THREE.BufferGeometry {
  let total = 0
  for (const c of chunks) total += c.geom.getAttribute('position').count
  const pos = new Float32Array(total * 3)
  const nrm = new Float32Array(total * 3)
  const uvs = new Float32Array(total * 2)
  const wear = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    const p = c.geom.getAttribute('position')
    const n = c.geom.getAttribute('normal')
    const u = c.geom.getAttribute('uv')
    const w = c.geom.getAttribute('aWear')
    _nm3.getNormalMatrix(c.matrix)
    for (let i = 0; i < p.count; i++) {
      _mv.fromBufferAttribute(p, i).applyMatrix4(c.matrix)
      pos[(o + i) * 3] = _mv.x
      pos[(o + i) * 3 + 1] = _mv.y
      pos[(o + i) * 3 + 2] = _mv.z
      _mv.fromBufferAttribute(n, i).applyMatrix3(_nm3).normalize()
      nrm[(o + i) * 3] = _mv.x
      nrm[(o + i) * 3 + 1] = _mv.y
      nrm[(o + i) * 3 + 2] = _mv.z
      uvs[(o + i) * 2] = u.getX(i) * c.uv
      uvs[(o + i) * 2 + 1] = u.getY(i) * c.uv
      wear[o + i] = Math.min(1, w.getX(i) + c.wear)
    }
    o += p.count
    c.geom.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setAttribute('aWear', new THREE.BufferAttribute(wear, 1))
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------
// Shared sub-assemblies
// ---------------------------------------------------------------------------

const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

/** Tapered cylinder spanning two points; used for barrels, arms and struts. */
function tubeBetween(
  b: PartBuilder, mat: WeaponMatKey, r0: number, r1: number,
  from: [number, number, number], to: [number, number, number],
  seg = 12, wear = 0, uv = 24,
): void {
  _a.set(from[0], from[1], from[2])
  _b.set(to[0], to[1], to[2])
  _dir.subVectors(_b, _a)
  const len = _dir.length()
  if (len < 1e-5) return
  _dir.divideScalar(len)
  _q.setFromUnitVectors(_up, _dir)
  _c.addVectors(_a, _b).multiplyScalar(0.5)
  _mtx.compose(_c, _q, _scl.set(1, 1, 1))
  b.addGeom(mat, cylGeom(r1, r0, len, { segments: seg, rimPower: 10 }), _mtx, wear, uv)
}

/**
 * MIL-STD-1913 rail: a base strip plus individually modelled recoil ribs at the
 * real 10.2mm pitch. The gaps between ribs are actual geometry, not a texture,
 * so grazing light breaks across them.
 */
function addRail(
  b: PartBuilder, mat: WeaponMatKey, x: number, yBase: number,
  z0: number, z1: number, width = 0.0212, wear = 0.2,
): void {
  const zMin = Math.min(z0, z1)
  const zMax = Math.max(z0, z1)
  const len = zMax - zMin
  b.box(mat, [width, 0.0042, len], [x, yBase + 0.0021, (zMin + zMax) * 0.5], { c: 0.0006, uv: 40, wear: 0.1 })
  const pitch = 0.0102
  const count = Math.max(1, Math.floor(len / pitch))
  const start = zMin + (len - count * pitch) * 0.5 + pitch * 0.5
  for (let i = 0; i < count; i++) {
    b.box(mat, [width, 0.0054, 0.0056], [x, yBase + 0.0068, start + i * pitch], { c: 0.0011, uv: 40, wear })
  }
}

/** M-LOK style slot: a recessed dark inset that reads as a real cut-out. */
function addSlots(
  b: PartBuilder, x: number, y: number, z0: number, z1: number,
  slotLen: number, gap: number, size: [number, number, number], rot?: [number, number, number],
): void {
  const pitch = slotLen + gap
  const count = Math.max(1, Math.floor((z1 - z0) / pitch))
  const start = z0 + ((z1 - z0) - count * pitch) * 0.5 + pitch * 0.5
  for (let i = 0; i < count; i++) {
    b.box('dark', [size[0], size[1], slotLen], [x, y, start + i * pitch], { c: 0.0009, rot, uv: 40, wear: 0.05 })
  }
}

interface MagOpts {
  slices?: number
  width?: number
  depth?: number
  sliceLen?: number
  curve?: number
  body?: WeaponMatKey
  ribs?: boolean
}

/** Curved box magazine walked along an arc, one moulded slice at a time. */
function addMagazine(b: PartBuilder, o: MagOpts = {}): number {
  const slices = o.slices ?? 7
  const w = o.width ?? 0.0265
  const d = o.depth ?? 0.045
  const len = o.sliceLen ?? 0.028
  const curve = o.curve ?? 0.031
  const body = o.body ?? 'polymer'
  const m = new THREE.Matrix4()
  const step = new THREE.Matrix4()
  const rot = new THREE.Matrix4()
  let lowest = 0
  const spin = new THREE.Matrix4().makeRotationX(curve)
  for (let i = 0; i < slices; i++) {
    const t = i / (slices - 1)
    // Feed-lip end is slightly wider than the body: real mags taper.
    const sw = w * (1 - t * 0.04)
    const sd = d * (1 - t * 0.06)
    const g = chamferBox(sw, len * 1.03, sd, 0.0022)
    step.makeTranslation(0, -len * (i + 0.5), 0)
    m.identity()
    for (let k = 0; k < i; k++) m.multiply(spin).multiply(new THREE.Matrix4().makeTranslation(0, -len, 0))
    m.multiply(spin)
    rot.makeTranslation(0, -len * 0.5, 0)
    m.multiply(rot)
    b.addGeom(body, g, m, 0.08 + t * 0.12, 30)
    if (o.ribs !== false && i > 0 && i < slices - 1) {
      const rib = chamferBox(sw + 0.0016, 0.0032, sd * 0.72, 0.0008)
      b.addGeom(body, rib, m, 0.35, 30)
    }
    _a.setFromMatrixPosition(m)
    if (_a.y < lowest) lowest = _a.y
  }
  // Floorplate.
  const plate = chamferBox(w + 0.004, 0.011, d + 0.004, 0.0018)
  const pm = new THREE.Matrix4()
  pm.identity()
  for (let k = 0; k < slices; k++) pm.multiply(spin).multiply(new THREE.Matrix4().makeTranslation(0, -len, 0))
  pm.multiply(new THREE.Matrix4().makeTranslation(0, 0.001, 0))
  b.addGeom('polymer', plate, pm, 0.45, 30)
  return lowest
}

/** Standalone single-material magazine used for the physics drop on reload. */
export function buildMagDropMesh(mats: WeaponMaterials, o: MagOpts = {}): THREE.Mesh {
  const g = new THREE.Group()
  const b = new PartBuilder(mats, g)
  addMagazine(b, o)
  b.build()
  const merged: Chunk[] = []
  for (const child of g.children) {
    const mesh = child as THREE.Mesh
    merged.push({ geom: mesh.geometry, matrix: new THREE.Matrix4(), wear: 0, uv: 1 })
  }
  const geom = mergeChunks(merged)
  geom.center()
  const mesh = new THREE.Mesh(geom, mats.get(o.body ?? 'polymer'))
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.surface = 'thinMetal'
  return mesh
}

/** Pistol grip with moulded finger swells and a checkered panel. */
function addPistolGrip(
  b: PartBuilder, mat: WeaponMatKey, top: [number, number, number],
  length: number, angle: number, width = 0.032,
): void {
  const dirY = -Math.cos(angle)
  const dirZ = Math.sin(angle)
  const cx = top[0]
  const cy = top[1] + dirY * length * 0.5
  const cz = top[2] + dirZ * length * 0.5
  b.box(mat, [width, length, 0.042], [cx, cy, cz], { rot: [angle, 0, 0], c: 0.006, uv: 34, wear: 0.12 })
  // Finger swells on the front face.
  for (let i = 0; i < 3; i++) {
    const t = 0.24 + i * 0.24
    const px = cx
    const py = top[1] + dirY * length * t
    const pz = top[2] + dirZ * length * t - 0.019 * Math.cos(angle)
    b.box(mat, [width * 0.96, 0.016, 0.008], [px, py, pz], { rot: [angle, 0, 0], c: 0.003, uv: 34, wear: 0.5 })
  }
  // Beavertail / backstrap flare.
  b.box(mat, [width * 0.95, 0.03, 0.02], [cx, top[1] - 0.006 + dirY * 0.012, top[2] + 0.026 + dirZ * 0.012], {
    rot: [angle * 0.6, 0, 0], c: 0.005, uv: 34, wear: 0.3,
  })
  // Grip cap.
  b.box('dark', [width * 0.9, 0.007, 0.036], [top[0] + dirY * 0, top[1] + dirY * (length + 0.002), top[2] + dirZ * (length + 0.002)], {
    rot: [angle, 0, 0], c: 0.002, uv: 34, wear: 0.4,
  })
}

/** Trigger guard drawn as three chamfered members, plus the trigger itself. */
function addTriggerGuard(b: PartBuilder, mat: WeaponMatKey, zFront: number, zRear: number, yTop: number, depth: number, width = 0.029): void {
  const yBot = yTop - depth
  b.box(mat, [width, 0.0075, zRear - zFront], [0, yBot, (zFront + zRear) * 0.5], { c: 0.0022, uv: 34, wear: 0.35 })
  b.box(mat, [width, depth * 0.55, 0.008], [0, yTop - depth * 0.34, zFront + 0.002], { rot: [0.28, 0, 0], c: 0.002, uv: 34, wear: 0.3 })
  b.box(mat, [width, depth * 0.5, 0.008], [0, yTop - depth * 0.3, zRear - 0.003], { rot: [-0.2, 0, 0], c: 0.002, uv: 34, wear: 0.25 })
}

/** Gloved hand: palm, four curling fingers, thumb and a cuffed forearm. */
interface HandOpts {
  /** +1 right hand, -1 left hand. */
  side: number
  palm: [number, number, number]
  /** Rotation applied to the whole hand, XYZ euler. */
  rot: [number, number, number]
  /** Where the forearm exits toward, in weapon space. */
  elbow: [number, number, number]
  wrist: [number, number, number]
  /** 0 relaxed .. 1 fully closed. */
  curl?: number
  thumbOver?: boolean
}

function addHand(b: PartBuilder, o: HandOpts): void {
  const s = o.side
  const curl = o.curl ?? 1
  const base = new THREE.Matrix4().compose(
    _a.set(o.palm[0], o.palm[1], o.palm[2]),
    _q.setFromEuler(_eul.set(o.rot[0], o.rot[1] * s, o.rot[2] * s, 'XYZ')),
    _scl.set(1, 1, 1),
  )

  const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z)
  const RY = (a: number) => new THREE.Matrix4().makeRotationY(a)
  const RX = (a: number) => new THREE.Matrix4().makeRotationX(a)
  const local = (x: number, y: number, z: number, out: THREE.Matrix4) => out.copy(base).multiply(T(x * s, y, z))

  const m = new THREE.Matrix4()

  // Palm: thicker across the knuckles, tapering toward the wrist.
  local(0, 0, 0, m)
  b.addGeom('glove', chamferBox(0.031, 0.086, 0.060, 0.008), m, 0.12, 40)
  local(-0.001, 0.028, -0.012, m)
  b.addGeom('glove', chamferBox(0.030, 0.030, 0.040, 0.007), m, 0.3, 40)
  // Reinforced knuckle pad, the classic tactical-glove read.
  local(-0.002, 0.032, -0.026, m)
  b.addGeom('dark', chamferBox(0.028, 0.022, 0.016, 0.005), m, 0.45, 40)
  // Wrist cinch strap.
  local(0, -0.042, 0.004, m)
  b.addGeom('dark', chamferBox(0.034, 0.010, 0.056, 0.004), m, 0.35, 40)

  // Four fingers wrapping around the front, curling about the grip axis.
  const segLens = [0.030, 0.024, 0.019]
  const widths = [0.0145, 0.0135, 0.0120]
  for (let f = 0; f < 4; f++) {
    const fy = 0.031 - f * 0.0178
    const chain = new THREE.Matrix4()
    local(-0.005, fy, -0.026, chain)
    // Splay along the grip so the fingers do not read as one slab.
    chain.multiply(RX(0.07 - f * 0.05))
    chain.multiply(RY(s * 0.55))
    const bends = [0.78 * curl, 0.82 * curl, 0.62 * curl]
    const taper = f === 3 ? 0.86 : f === 0 ? 0.95 : 1
    for (let k = 0; k < 3; k++) {
      chain.multiply(RY(s * bends[k]))
      const w = widths[k] * taper
      const seg = new THREE.Matrix4().copy(chain).multiply(T(0, 0, -segLens[k] * taper * 0.5))
      b.addGeom('glove', chamferBox(w, w * 0.95, segLens[k] * taper, 0.0045), seg, 0.18 + k * 0.12, 55)
      if (k < 2) {
        const kn = new THREE.Matrix4().copy(chain).multiply(T(s * w * 0.35, 0, -segLens[k] * taper))
        b.addGeom('glove', chamferBox(w * 0.8, w * 0.8, 0.009, 0.003), kn, 0.55, 55)
      }
      chain.multiply(T(0, 0, -segLens[k] * taper))
    }
  }

  // Thumb laid over the top.
  const thumb = new THREE.Matrix4()
  local(0.010, 0.030, 0.008, thumb)
  thumb.multiply(RY(s * (o.thumbOver ? 0.95 : 0.55)))
  thumb.multiply(RX(o.thumbOver ? 0.15 : -0.35))
  const t0 = new THREE.Matrix4().copy(thumb).multiply(T(0, 0, -0.019))
  b.addGeom('glove', chamferBox(0.017, 0.017, 0.038, 0.006), t0, 0.2, 55)
  thumb.multiply(T(0, 0, -0.036))
  thumb.multiply(RY(s * 0.45))
  const t1 = new THREE.Matrix4().copy(thumb).multiply(T(0, 0, -0.014))
  b.addGeom('glove', chamferBox(0.0145, 0.0145, 0.030, 0.005), t1, 0.35, 55)

  // Wrist, cuff and camo sleeve running off frame.
  const w = o.wrist
  const e = o.elbow
  tubeBetween(b, 'glove', 0.026, 0.024, [w[0], w[1], w[2]], [
    w[0] + (e[0] - w[0]) * 0.16, w[1] + (e[1] - w[1]) * 0.16, w[2] + (e[2] - w[2]) * 0.16,
  ], 12, 0.15, 40)
  tubeBetween(b, 'dark', 0.0285, 0.0285, [
    w[0] + (e[0] - w[0]) * 0.14, w[1] + (e[1] - w[1]) * 0.14, w[2] + (e[2] - w[2]) * 0.14,
  ], [
    w[0] + (e[0] - w[0]) * 0.26, w[1] + (e[1] - w[1]) * 0.26, w[2] + (e[2] - w[2]) * 0.26,
  ], 12, 0.3, 40)
  tubeBetween(b, 'sleeve', 0.030, 0.050, [
    w[0] + (e[0] - w[0]) * 0.24, w[1] + (e[1] - w[1]) * 0.24, w[2] + (e[2] - w[2]) * 0.24,
  ], e, 14, 0.05, 12)
}

// ---------------------------------------------------------------------------
// Weapon models
// ---------------------------------------------------------------------------

export interface WeaponModel {
  root: THREE.Group
  /** Sight axis reference: -Z runs down the line of sight, origin on that axis. */
  aim: THREE.Object3D
  muzzle: THREE.Object3D
  ejectPort: THREE.Object3D
  magazine: THREE.Group
  charging: THREE.Group
  trigger: THREE.Group
  slide: THREE.Group | null
  leftHand: THREE.Group
  rightHand: THREE.Group
  /** Sight window radius and its distance from the aim node, for dot fade. */
  windowRadius: number
  /** Local position of the optic glass, used to place the collimated reticle. */
  glassOffset: THREE.Vector3
  reticleKind: 'dot' | 'cross' | 'none'
  /** Angular size of the reticle in radians; it is collimated, so size is angular. */
  reticleAngle: number
  magDrop: THREE.Mesh
  overallLength: number
}

function newGroup(name: string, parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group()
  g.name = name
  parent.add(g)
  return g
}

/** Tube red dot: housing, hood, turrets, both lenses and a QD mount. */
function addRedDot(b: PartBuilder, root: THREE.Group, z: number, railTop: number, axisY: number): { window: number } {
  const r = 0.0205
  // Mount block from rail to tube.
  b.box('anodised', [0.026, axisY - railTop, 0.052], [0, (railTop + axisY) * 0.5 - 0.004, z], { c: 0.0022, uv: 34, wear: 0.25 })
  b.box('anodised', [0.030, 0.010, 0.030], [0, railTop + 0.004, z + 0.004], { c: 0.0018, uv: 34, wear: 0.3 })
  // QD throw lever on the left.
  b.box('steel', [0.008, 0.020, 0.030], [-0.017, railTop + 0.010, z + 0.004], { c: 0.0018, uv: 40, wear: 0.55 })
  // Main tube, faceted so it reads as machined rather than injection moulded.
  b.tube('anodised', r, r, 0.062, [0, axisY, z], { seg: 16, faceted: true, caps: false, uv: 30, wear: 0.06 })
  b.tube('anodised', r + 0.0022, r + 0.0022, 0.008, [0, axisY, z - 0.027], { seg: 16, faceted: true, uv: 30, wear: 0.5 })
  b.tube('anodised', r + 0.0026, r + 0.0026, 0.009, [0, axisY, z + 0.027], { seg: 16, faceted: true, uv: 30, wear: 0.5 })
  // Elevation turret and battery cap.
  b.tube('anodised', 0.0092, 0.0105, 0.012, [0, axisY + r + 0.005, z + 0.006], { axis: 'y', seg: 12, uv: 40, wear: 0.4 })
  b.tube('anodised', 0.0088, 0.0100, 0.011, [r + 0.004, axisY, z + 0.006], { axis: 'x', seg: 12, uv: 40, wear: 0.4 })
  b.tube('anodised', 0.0115, 0.0115, 0.010, [-r - 0.004, axisY, z - 0.004], { axis: 'x', seg: 14, uv: 40, wear: 0.45 })
  // Brightness rocker.
  b.box('dark', [0.006, 0.012, 0.016], [-r - 0.004, axisY - 0.012, z + 0.012], { c: 0.0012, uv: 40, wear: 0.3 })
  // Killflash-free lenses: rear clear, front slightly deeper tint.
  b.disc('glass', r - 0.0035, [0, axisY, z + 0.0245], { seg: 24 })
  b.disc('glassFront', r - 0.0035, [0, axisY, z - 0.0245], { seg: 24 })
  root.userData.opticZ = z
  return { window: r - 0.0045 }
}

/** Holographic sight: squared hood with a wide rectangular window. */
function addHoloSight(b: PartBuilder, z: number, railTop: number, axisY: number): { window: number } {
  const hw = 0.021
  const hh = 0.020
  b.box('anodised', [0.040, axisY - railTop - 0.004, 0.072], [0, (railTop + axisY) * 0.5, z + 0.012], { c: 0.0025, uv: 34, wear: 0.28 })
  // Hood: four members framing the glass.
  b.box('anodised', [0.006, hh * 2 + 0.010, 0.050], [hw + 0.003, axisY, z], { c: 0.0018, uv: 36, wear: 0.4 })
  b.box('anodised', [0.006, hh * 2 + 0.010, 0.050], [-hw - 0.003, axisY, z], { c: 0.0018, uv: 36, wear: 0.4 })
  b.box('anodised', [hw * 2 + 0.012, 0.007, 0.050], [0, axisY + hh + 0.004, z], { c: 0.0018, uv: 36, wear: 0.45 })
  b.box('anodised', [hw * 2 + 0.012, 0.006, 0.020], [0, axisY - hh - 0.003, z - 0.014], { c: 0.0018, uv: 36, wear: 0.35 })
  b.box('dark', [0.020, 0.012, 0.016], [0.0, axisY - hh + 0.002, z + 0.028], { c: 0.0014, uv: 40, wear: 0.3 })
  // Glass pane, canted very slightly like a real holo window.
  const glass = chamferBox(hw * 2 - 0.002, hh * 2 - 0.002, 0.0018, 0.0006)
  _mtx.compose(_a.set(0, axisY, z - 0.004), _q.setFromEuler(_eul.set(0.06, 0, 0, 'XYZ')), _scl.set(1, 1, 1))
  b.addGeom('glass', glass, _mtx, 0, 20)
  return { window: hw - 0.004 }
}

/** Variable-power scope: objective bell, erector tube, turrets, ocular flange. */
function addScope(b: PartBuilder, z: number, railTop: number, axisY: number): { window: number } {
  const rTube = 0.0155
  const rObj = 0.0285
  const rOcu = 0.0225
  // Rings.
  for (const rz of [z + 0.055, z - 0.055]) {
    b.tube('anodised', rTube + 0.006, rTube + 0.006, 0.020, [0, axisY, rz], { seg: 16, faceted: true, uv: 34, wear: 0.35 })
    b.box('anodised', [0.030, axisY - railTop - rTube, 0.022], [0, (railTop + axisY - rTube) * 0.5, rz], { c: 0.002, uv: 34, wear: 0.3 })
    b.box('steel', [0.0075, 0.014, 0.020], [0.020, axisY - rTube * 0.6, rz], { c: 0.0015, uv: 40, wear: 0.6 })
  }
  b.tube('anodised', rTube, rTube, 0.30, [0, axisY, z], { seg: 18, faceted: true, caps: false, uv: 30, wear: 0.05 })
  // Objective bell forward.
  b.tube('anodised', rObj, rTube, 0.045, [0, axisY, z - 0.172], { seg: 18, faceted: true, caps: false, uv: 30, wear: 0.1 })
  b.tube('anodised', rObj, rObj, 0.030, [0, axisY, z - 0.210], { seg: 18, faceted: true, caps: false, uv: 30, wear: 0.12 })
  b.tube('anodised', rObj + 0.0025, rObj + 0.0025, 0.006, [0, axisY, z - 0.226], { seg: 18, faceted: true, uv: 30, wear: 0.6 })
  b.disc('glassFront', rObj - 0.004, [0, axisY, z - 0.228], { seg: 28 })
  // Ocular bell and rubber eyecup.
  b.tube('anodised', rTube, rOcu, 0.030, [0, axisY, z + 0.163], { seg: 18, faceted: true, caps: false, uv: 30, wear: 0.1 })
  b.tube('anodised', rOcu, rOcu, 0.028, [0, axisY, z + 0.192], { seg: 18, faceted: true, caps: false, uv: 30, wear: 0.15 })
  b.tube('rubber', rOcu + 0.004, rOcu + 0.004, 0.016, [0, axisY, z + 0.212], { seg: 18, uv: 30, wear: 0.4 })
  b.disc('glass', rOcu - 0.004, [0, axisY, z + 0.204], { seg: 28 })
  // Magnification ring with grip ribs.
  b.tube('anodised', rTube + 0.004, rTube + 0.004, 0.022, [0, axisY, z + 0.130], { seg: 18, faceted: true, uv: 34, wear: 0.4 })
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    b.box('anodised', [0.0022, 0.0022, 0.020], [Math.sin(a) * (rTube + 0.005), axisY + Math.cos(a) * (rTube + 0.005), z + 0.130], {
      rot: [0, 0, -a], c: 0.0006, uv: 40, wear: 0.7,
    })
  }
  // Turrets.
  b.tube('anodised', 0.0125, 0.0135, 0.019, [0, axisY + rTube + 0.008, z - 0.02], { axis: 'y', seg: 14, uv: 36, wear: 0.4 })
  b.tube('anodised', 0.0115, 0.0125, 0.017, [rTube + 0.008, axisY, z - 0.02], { axis: 'x', seg: 14, uv: 36, wear: 0.4 })
  b.tube('anodised', 0.0105, 0.0105, 0.014, [-rTube - 0.006, axisY, z - 0.02], { axis: 'x', seg: 14, uv: 36, wear: 0.35 })
  return { window: rOcu - 0.006 }
}

/** Folding backup iron sights, in the down position behind an optic. */
function addFoldedSights(b: PartBuilder, railTop: number, zFront: number, zRear: number): void {
  b.box('anodised', [0.019, 0.008, 0.030], [0, railTop + 0.005, zFront], { c: 0.0012, uv: 40, wear: 0.4 })
  b.box('anodised', [0.016, 0.005, 0.020], [0, railTop + 0.011, zFront - 0.002], { rot: [0.12, 0, 0], c: 0.0011, uv: 40, wear: 0.6 })
  b.box('anodised', [0.019, 0.008, 0.026], [0, railTop + 0.005, zRear], { c: 0.0012, uv: 40, wear: 0.4 })
  b.box('anodised', [0.017, 0.005, 0.018], [0, railTop + 0.011, zRear + 0.002], { rot: [-0.14, 0, 0], c: 0.0011, uv: 40, wear: 0.6 })
}

/** Collapsible carbine stock riding a buffer tube. */
function addCarbineStock(b: PartBuilder, zTube0: number, zTube1: number, y: number): void {
  const len = zTube1 - zTube0
  b.tube('anodised', 0.0155, 0.0155, len, [0, y, (zTube0 + zTube1) * 0.5], { seg: 16, faceted: true, caps: false, uv: 30, wear: 0.1 })
  // Adjustment detent notches along the underside of the tube.
  for (let i = 0; i < 6; i++) {
    const z = zTube0 + 0.035 + i * 0.024
    if (z > zTube1 - 0.01) break
    b.box('dark', [0.010, 0.005, 0.008], [0, y - 0.0155, z], { c: 0.0012, uv: 40, wear: 0.4 })
  }
  const zBody = zTube1 - 0.075
  b.box('polymer', [0.046, 0.062, 0.115], [0, y + 0.004, zBody], { c: 0.007, uv: 26, wear: 0.15 })
  // Cheek weld ridge and the sloped comb.
  b.box('polymer', [0.030, 0.016, 0.115], [0, y + 0.036, zBody + 0.004], { rot: [0.05, 0, 0], c: 0.005, uv: 26, wear: 0.4 })
  // Toe of the stock, angled.
  b.box('polymer', [0.040, 0.030, 0.055], [0, y - 0.030, zBody + 0.020], { rot: [-0.25, 0, 0], c: 0.005, uv: 26, wear: 0.25 })
  // Release lever underneath.
  b.box('polymer', [0.022, 0.014, 0.040], [0, y - 0.036, zBody - 0.020], { rot: [0.1, 0, 0], c: 0.003, uv: 34, wear: 0.5 })
  // QD sling socket.
  b.tube('steel', 0.007, 0.007, 0.008, [0.023, y + 0.006, zBody - 0.030], { axis: 'x', seg: 12, uv: 40, wear: 0.7 })
  b.tube('dark', 0.0042, 0.0042, 0.010, [0.023, y + 0.006, zBody - 0.030], { axis: 'x', seg: 10, uv: 40, wear: 0.2 })
  // Rubber buttpad.
  b.box('rubber', [0.044, 0.078, 0.016], [0, y + 0.002, zTube1 + 0.006], { rot: [-0.08, 0, 0], c: 0.004, uv: 30, wear: 0.35 })
}

export type WeaponKind = 'rifle' | 'smg' | 'sniper' | 'pistol'

export function buildWeaponModel(kind: WeaponKind, mats: WeaponMaterials): WeaponModel {
  switch (kind) {
    case 'smg': return buildSmg(mats)
    case 'sniper': return buildSniper(mats)
    case 'pistol': return buildPistol(mats)
    default: return buildRifle(mats)
  }
}

function shell(root: THREE.Group): {
  aim: THREE.Object3D, muzzle: THREE.Object3D, port: THREE.Object3D,
  mag: THREE.Group, charging: THREE.Group, trigger: THREE.Group,
  lh: THREE.Group, rh: THREE.Group,
} {
  return {
    aim: newGroup('aim', root),
    muzzle: newGroup('muzzle', root),
    port: newGroup('port', root),
    mag: newGroup('magazine', root),
    charging: newGroup('charging', root),
    trigger: newGroup('trigger', root),
    lh: newGroup('leftHand', root),
    rh: newGroup('rightHand', root),
  }
}

/**
 * 14.5" carbine. Origin is on the bore axis at the trigger; -Z is downrange.
 * Overall length 84cm with the stock extended, matching a real M4A1.
 */
function buildRifle(mats: WeaponMaterials): WeaponModel {
  const root = new THREE.Group()
  root.name = 'rifle'
  const s = shell(root)
  const b = new PartBuilder(mats, root)

  const railBase = 0.0245
  const railTop = railBase + 0.0042
  const opticAxis = 0.0665
  const opticZ = -0.052

  // --- upper receiver -----------------------------------------------------
  b.box('gunmetal', [0.038, 0.046, 0.250], [0, -0.001, -0.025], { c: 0.0035, uv: 26 })
  b.box('gunmetal', [0.031, 0.008, 0.250], [0, 0.0235, -0.025], { c: 0.0022, uv: 30, wear: 0.15 })
  // Charging-handle raceway and rear plate.
  b.box('gunmetal', [0.040, 0.040, 0.016], [0, -0.002, 0.102], { c: 0.003, uv: 30, wear: 0.2 })
  // Ejection port recess, dust cover hanging open, brass deflector.
  b.box('dark', [0.006, 0.023, 0.062], [0.0182, 0.004, 0.004], { c: 0.001, uv: 34 })
  b.box('gunmetal', [0.005, 0.026, 0.058], [0.0295, -0.012, 0.004], { rot: [0, 0, -0.95], c: 0.0012, uv: 34, wear: 0.5 })
  b.box('gunmetal', [0.010, 0.020, 0.026], [0.0205, 0.011, 0.042], { rot: [0, 0.4, 0.3], c: 0.003, uv: 30, wear: 0.45 })
  // Forward assist.
  b.tube('gunmetal', 0.0085, 0.0085, 0.014, [0.0245, -0.006, 0.058], { axis: 'x', seg: 12, uv: 36, wear: 0.5 })
  b.tube('steel', 0.0055, 0.0055, 0.008, [0.0305, -0.006, 0.058], { axis: 'x', seg: 10, uv: 40, wear: 0.75 })
  // Bolt catch and magazine release.
  b.box('gunmetal', [0.006, 0.012, 0.034], [-0.0205, -0.016, -0.014], { c: 0.0012, uv: 36, wear: 0.55 })
  b.tube('gunmetal', 0.0075, 0.0075, 0.010, [0.0215, -0.029, -0.016], { axis: 'x', seg: 12, uv: 36, wear: 0.65 })
  // Safety selector, both sides.
  for (const sx of [-1, 1]) {
    b.tube('gunmetal', 0.0075, 0.0075, 0.006, [sx * 0.0205, -0.020, 0.021], { axis: 'x', seg: 12, uv: 36, wear: 0.5 })
    b.box('gunmetal', [0.005, 0.010, 0.024], [sx * 0.0245, -0.024, 0.028], { rot: [0.5, 0, 0], c: 0.0012, uv: 36, wear: 0.6 })
  }
  // Takedown pins.
  for (const z of [-0.128, 0.086]) {
    b.tube('steel', 0.0055, 0.0055, 0.006, [-0.0205, -0.014, z], { axis: 'x', seg: 10, uv: 40, wear: 0.7 })
  }

  // --- lower receiver, magwell, grip, trigger -----------------------------
  b.box('gunmetal', [0.036, 0.064, 0.076], [0, -0.055, -0.055], { c: 0.004, uv: 26, wear: 0.1 })
  b.box('gunmetal', [0.040, 0.012, 0.082], [0, -0.084, -0.055], { c: 0.004, uv: 30, wear: 0.4 })
  b.box('gunmetal', [0.034, 0.038, 0.060], [0, -0.040, 0.010], { c: 0.004, uv: 26, wear: 0.12 })
  addTriggerGuard(b, 'gunmetal', -0.014, 0.040, -0.026, 0.036)
  addPistolGrip(b, 'polymer', [0, -0.026, 0.030], 0.115, 0.36)

  b.into(s.trigger)
  s.trigger.position.set(0, -0.026, 0.014)
  b.box('steel', [0.008, 0.030, 0.010], [0, -0.016, 0.002], { rot: [0.12, 0, 0], c: 0.002, uv: 44, wear: 0.7 })
  b.box('steel', [0.010, 0.008, 0.012], [0, -0.030, 0.004], { rot: [0.3, 0, 0], c: 0.002, uv: 44, wear: 0.85 })
  b.into(root)

  b.into(s.mag)
  s.mag.position.set(0, -0.030, -0.055)
  addMagazine(b, { slices: 7, width: 0.0265, depth: 0.046, sliceLen: 0.028, curve: 0.030 })
  b.into(root)

  // --- barrel, gas system, handguard --------------------------------------
  b.tube('phosphate', 0.0132, 0.0132, 0.026, [0, 0, -0.162], { seg: 16, uv: 30, wear: 0.3 })
  b.tube('phosphate', 0.0102, 0.0092, 0.290, [0, 0, -0.320], { seg: 16, caps: false, uv: 26 })
  b.tube('phosphate', 0.0112, 0.0102, 0.030, [0, 0, -0.480], { seg: 16, caps: false, uv: 30, wear: 0.2 })
  // Low-profile gas block and gas tube.
  b.box('phosphate', [0.024, 0.028, 0.034], [0, 0.004, -0.414], { c: 0.002, uv: 34, wear: 0.35 })
  b.tube('steel', 0.0032, 0.0032, 0.250, [0, 0.0155, -0.290], { seg: 8, caps: false, uv: 40, wear: 0.25 })

  // Octagonal free-float handguard with real M-LOK cut-outs.
  b.tube('anodised', 0.0262, 0.0262, 0.284, [0, 0, -0.305], { seg: 8, faceted: true, caps: false, uv: 22, wear: 0.08 })
  b.tube('anodised', 0.0285, 0.0285, 0.014, [0, 0, -0.170], { seg: 8, faceted: true, uv: 30, wear: 0.5 })
  b.tube('anodised', 0.0272, 0.0272, 0.010, [0, 0, -0.442], { seg: 8, faceted: true, uv: 30, wear: 0.55 })
  addSlots(b, 0.0250, -0.006, -0.430, -0.190, 0.032, 0.014, [0.006, 0.013, 0])
  addSlots(b, -0.0250, -0.006, -0.430, -0.190, 0.032, 0.014, [0.006, 0.013, 0])
  addSlots(b, 0, -0.0252, -0.430, -0.190, 0.032, 0.014, [0.013, 0.006, 0])
  // Short bottom rail for the sling swivel and a QD socket up front.
  b.tube('steel', 0.0062, 0.0062, 0.008, [-0.026, 0.004, -0.424], { axis: 'x', seg: 12, uv: 40, wear: 0.7 })
  b.tube('dark', 0.0036, 0.0036, 0.010, [-0.026, 0.004, -0.424], { axis: 'x', seg: 10, uv: 40 })

  // Continuous top rail from the receiver to the handguard front.
  addRail(b, 'anodised', 0, railBase, -0.440, 0.100)
  addFoldedSights(b, railTop, -0.400, 0.062)

  // --- muzzle device ------------------------------------------------------
  b.tube('phosphate', 0.0118, 0.0118, 0.048, [0, 0, -0.526], { seg: 14, caps: false, uv: 34, wear: 0.25 })
  b.tube('phosphate', 0.0128, 0.0128, 0.007, [0, 0, -0.504], { seg: 14, uv: 34, wear: 0.6 })
  b.tube('phosphate', 0.0122, 0.0122, 0.006, [0, 0, -0.549], { seg: 14, uv: 34, wear: 0.7 })
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.5 + (i - 2) * 0.62
    b.box('dark', [0.005, 0.012, 0.026], [Math.sin(a) * 0.010, -Math.cos(a) * 0.010, -0.522], {
      rot: [0, 0, -a], c: 0.001, uv: 40,
    })
  }
  b.disc('dark', 0.0058, [0, 0, -0.5525], { seg: 16 })

  // --- stock ---------------------------------------------------------------
  addCarbineStock(b, 0.100, 0.288, 0.004)

  // --- charging handle -----------------------------------------------------
  b.into(s.charging)
  b.box('anodised', [0.030, 0.008, 0.062], [0, 0.0195, 0.128], { c: 0.0018, uv: 36, wear: 0.4 })
  b.box('anodised', [0.046, 0.010, 0.020], [-0.006, 0.0205, 0.152], { c: 0.0022, uv: 36, wear: 0.75 })
  b.box('anodised', [0.014, 0.014, 0.012], [-0.026, 0.0205, 0.150], { rot: [0, 0, 0.2], c: 0.002, uv: 40, wear: 0.9 })
  b.into(root)

  // --- optic ---------------------------------------------------------------
  const optic = addRedDot(b, root, opticZ, railTop, opticAxis)

  // --- hands ---------------------------------------------------------------
  b.into(s.rh)
  addHand(b, {
    side: 1,
    palm: [0.0315, -0.078, 0.050],
    rot: [-0.36, 0, 0.06],
    wrist: [0.040, -0.126, 0.086],
    elbow: [0.150, -0.320, 0.320],
    curl: 1,
  })
  b.into(s.lh)
  addHand(b, {
    side: -1,
    palm: [-0.0425, -0.006, -0.306],
    rot: [-Math.PI / 2 + 0.12, 0, 0.1],
    wrist: [-0.050, -0.030, -0.258],
    elbow: [-0.185, -0.235, -0.060],
    curl: 0.92,
    thumbOver: true,
  })
  b.into(root)
  b.build()

  s.aim.position.set(0, opticAxis, opticZ)
  s.muzzle.position.set(0, 0, -0.556)
  s.port.position.set(0.026, 0.008, 0.004)

  return {
    root,
    aim: s.aim,
    muzzle: s.muzzle,
    ejectPort: s.port,
    magazine: s.mag,
    charging: s.charging,
    trigger: s.trigger,
    slide: null,
    leftHand: s.lh,
    rightHand: s.rh,
    windowRadius: optic.window,
    glassOffset: new THREE.Vector3(0, opticAxis, opticZ),
    reticleKind: 'dot',
    reticleAngle: 0.012,
    magDrop: buildMagDropMesh(mats, { slices: 7, width: 0.0265, depth: 0.046, sliceLen: 0.028, curve: 0.030 }),
    overallLength: 0.845,
  }
}

/** Compact 9mm PDW with a folding stock, vertical grip and holographic sight. */
function buildSmg(mats: WeaponMaterials): WeaponModel {
  const root = new THREE.Group()
  root.name = 'smg'
  const s = shell(root)
  const b = new PartBuilder(mats, root)

  const railBase = 0.0225
  const railTop = railBase + 0.0042
  const sightAxis = 0.0565
  const sightZ = -0.030

  // Stamped-look receiver with a raised spine.
  b.box('polymerTan', [0.042, 0.048, 0.205], [0, -0.002, -0.030], { c: 0.004, uv: 28 })
  b.box('anodised', [0.034, 0.010, 0.205], [0, 0.0215, -0.030], { c: 0.0022, uv: 32, wear: 0.2 })
  b.box('anodised', [0.040, 0.036, 0.014], [0, -0.002, 0.078], { c: 0.003, uv: 32, wear: 0.25 })
  b.box('dark', [0.006, 0.020, 0.048], [0.0202, 0.005, 0.004], { c: 0.001, uv: 34 })
  b.box('anodised', [0.005, 0.022, 0.044], [0.0295, -0.010, 0.004], { rot: [0, 0, -0.9], c: 0.0012, uv: 34, wear: 0.5 })
  b.tube('anodised', 0.0072, 0.0072, 0.010, [0.0225, -0.026, -0.014], { axis: 'x', seg: 12, uv: 36, wear: 0.6 })
  b.box('anodised', [0.005, 0.010, 0.022], [-0.0235, -0.018, 0.024], { rot: [0.4, 0, 0], c: 0.0012, uv: 36, wear: 0.6 })

  // Magwell in the grip, so the magazine sits under the trigger group.
  b.box('polymerTan', [0.034, 0.054, 0.062], [0, -0.048, -0.026], { c: 0.004, uv: 28, wear: 0.12 })
  addTriggerGuard(b, 'polymerTan', -0.010, 0.038, -0.024, 0.034, 0.030)
  addPistolGrip(b, 'polymer', [0, -0.024, 0.028], 0.104, 0.30, 0.030)

  b.into(s.trigger)
  s.trigger.position.set(0, -0.024, 0.012)
  b.box('steel', [0.007, 0.028, 0.009], [0, -0.015, 0.002], { rot: [0.12, 0, 0], c: 0.002, uv: 44, wear: 0.7 })
  b.into(root)

  b.into(s.mag)
  s.mag.position.set(0, -0.026, -0.026)
  addMagazine(b, { slices: 6, width: 0.024, depth: 0.038, sliceLen: 0.027, curve: 0.018, body: 'polymer' })
  b.into(root)

  // Short barrel and shrouded handguard.
  b.tube('phosphate', 0.0105, 0.0095, 0.150, [0, 0, -0.205], { seg: 14, caps: false, uv: 26 })
  b.tube('anodised', 0.0245, 0.0245, 0.150, [0, 0, -0.200], { seg: 8, faceted: true, caps: false, uv: 22, wear: 0.1 })
  b.tube('anodised', 0.0268, 0.0268, 0.012, [0, 0, -0.132], { seg: 8, faceted: true, uv: 30, wear: 0.5 })
  addSlots(b, 0.0234, -0.006, -0.262, -0.150, 0.028, 0.012, [0.006, 0.012, 0])
  addSlots(b, -0.0234, -0.006, -0.262, -0.150, 0.028, 0.012, [0.006, 0.012, 0])
  addRail(b, 'anodised', 0, railBase, -0.270, 0.072, 0.0206)

  // Angled foregrip.
  b.box('polymer', [0.026, 0.058, 0.034], [0, -0.048, -0.212], { rot: [0.38, 0, 0], c: 0.005, uv: 30, wear: 0.35 })
  b.box('polymer', [0.028, 0.010, 0.040], [0, -0.026, -0.214], { c: 0.003, uv: 30, wear: 0.3 })

  // Muzzle brake with side ports.
  b.tube('phosphate', 0.0125, 0.0125, 0.040, [0, 0, -0.296], { seg: 14, caps: false, uv: 34, wear: 0.25 })
  for (let i = 0; i < 3; i++) {
    for (const sx of [-1, 1]) {
      b.box('dark', [0.004, 0.010, 0.008], [sx * 0.011, 0.002, -0.284 - i * 0.011], { c: 0.001, uv: 40 })
    }
  }
  b.disc('dark', 0.0055, [0, 0, -0.3165], { seg: 16 })

  // Side-folding skeleton stock.
  b.box('anodised', [0.030, 0.030, 0.020], [0, 0.000, 0.090], { c: 0.003, uv: 34, wear: 0.4 })
  b.box('anodised', [0.012, 0.016, 0.120], [-0.012, 0.014, 0.156], { c: 0.0025, uv: 34, wear: 0.3 })
  b.box('anodised', [0.012, 0.016, 0.120], [-0.012, -0.020, 0.156], { c: 0.0025, uv: 34, wear: 0.3 })
  b.box('polymer', [0.020, 0.070, 0.020], [-0.012, -0.004, 0.222], { rot: [-0.06, 0, 0], c: 0.005, uv: 28, wear: 0.3 })
  b.box('rubber', [0.024, 0.074, 0.012], [-0.012, -0.004, 0.236], { rot: [-0.06, 0, 0], c: 0.004, uv: 30, wear: 0.4 })
  b.tube('steel', 0.0062, 0.0062, 0.008, [0.017, 0.000, 0.086], { axis: 'x', seg: 12, uv: 40, wear: 0.7 })

  b.into(s.charging)
  b.box('anodised', [0.050, 0.009, 0.026], [-0.014, 0.0175, 0.070], { c: 0.002, uv: 36, wear: 0.7 })
  b.box('anodised', [0.014, 0.014, 0.014], [-0.036, 0.0175, 0.070], { rot: [0, 0, 0.25], c: 0.002, uv: 40, wear: 0.9 })
  b.into(root)

  const sight = addHoloSight(b, sightZ, railTop, sightAxis)

  b.into(s.rh)
  addHand(b, {
    side: 1,
    palm: [0.0300, -0.080, 0.046],
    rot: [-0.30, 0, 0.06],
    wrist: [0.038, -0.124, 0.078],
    elbow: [0.148, -0.310, 0.310],
    curl: 1,
  })
  b.into(s.lh)
  addHand(b, {
    side: -1,
    palm: [-0.0295, -0.062, -0.214],
    rot: [-0.34, 0, -0.12],
    wrist: [-0.036, -0.104, -0.184],
    elbow: [-0.170, -0.270, -0.030],
    curl: 1,
  })
  b.into(root)
  b.build()

  s.aim.position.set(0, sightAxis, sightZ)
  s.muzzle.position.set(0, 0, -0.320)
  s.port.position.set(0.027, 0.008, 0.004)

  return {
    root,
    aim: s.aim,
    muzzle: s.muzzle,
    ejectPort: s.port,
    magazine: s.mag,
    charging: s.charging,
    trigger: s.trigger,
    slide: null,
    leftHand: s.lh,
    rightHand: s.rh,
    windowRadius: sight.window,
    glassOffset: new THREE.Vector3(0, sightAxis, sightZ),
    reticleKind: 'dot',
    reticleAngle: 0.017,
    magDrop: buildMagDropMesh(mats, { slices: 6, width: 0.024, depth: 0.038, sliceLen: 0.027, curve: 0.018 }),
    overallLength: 0.56,
  }
}

/** Bolt-action precision rifle in a chassis stock, with a variable scope. */
function buildSniper(mats: WeaponMaterials): WeaponModel {
  const root = new THREE.Group()
  root.name = 'sniper'
  const s = shell(root)
  const b = new PartBuilder(mats, root)

  const railBase = 0.0285
  const railTop = railBase + 0.0042
  const scopeAxis = 0.0855
  const scopeZ = -0.055

  // Receiver and chassis.
  b.tube('anodised', 0.0225, 0.0225, 0.230, [0, 0.002, -0.055], { seg: 14, faceted: true, caps: false, uv: 26 })
  b.box('anodised', [0.046, 0.026, 0.230], [0, -0.018, -0.055], { c: 0.003, uv: 26, wear: 0.1 })
  b.box('anodised', [0.038, 0.014, 0.230], [0, 0.0245, -0.055], { c: 0.0025, uv: 30, wear: 0.15 })
  addRail(b, 'anodised', 0, railBase, -0.170, 0.060, 0.0212)
  // Ejection port.
  b.box('dark', [0.007, 0.026, 0.060], [0.0212, 0.008, -0.020], { c: 0.0012, uv: 34 })

  // Bolt body and handle (animated on cycling).
  b.into(s.charging)
  b.tube('steel', 0.0105, 0.0105, 0.120, [0, 0.008, 0.012], { seg: 14, caps: false, uv: 34, wear: 0.35 })
  b.tube('steel', 0.0075, 0.0075, 0.052, [0.020, 0.002, 0.030], { axis: 'x', seg: 12, uv: 36, wear: 0.5, rot: [0.35, 0, 0] })
  b.tube('polymer', 0.0125, 0.0125, 0.024, [0.048, -0.008, 0.040], { axis: 'x', seg: 14, uv: 34, wear: 0.4 })
  b.into(root)

  // Detachable box magazine.
  b.box('anodised', [0.036, 0.030, 0.080], [0, -0.040, -0.048], { c: 0.003, uv: 28, wear: 0.2 })
  b.into(s.mag)
  s.mag.position.set(0, -0.050, -0.048)
  addMagazine(b, { slices: 3, width: 0.030, depth: 0.062, sliceLen: 0.026, curve: 0.012, body: 'anodised' })
  b.into(root)

  addTriggerGuard(b, 'anodised', 0.012, 0.062, -0.032, 0.038, 0.026)
  addPistolGrip(b, 'polymer', [0, -0.030, 0.048], 0.120, 0.20, 0.034)

  b.into(s.trigger)
  s.trigger.position.set(0, -0.032, 0.034)
  b.box('steel', [0.006, 0.030, 0.009], [0, -0.016, 0.002], { rot: [0.08, 0, 0], c: 0.002, uv: 44, wear: 0.7 })
  b.into(root)

  // Heavy fluted barrel.
  b.tube('phosphate', 0.0195, 0.0195, 0.040, [0, 0, -0.185], { seg: 16, caps: false, uv: 30, wear: 0.2 })
  b.tube('phosphate', 0.0168, 0.0138, 0.420, [0, 0, -0.412], { seg: 16, caps: false, uv: 24 })
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    b.box('dark', [0.005, 0.005, 0.240], [Math.sin(a) * 0.0155, Math.cos(a) * 0.0155, -0.330], {
      rot: [0, 0, -a], c: 0.0012, uv: 30,
    })
  }
  // Suppressor-ready brake.
  b.tube('phosphate', 0.0215, 0.0215, 0.062, [0, 0, -0.648], { seg: 16, caps: false, uv: 32, wear: 0.3 })
  for (let i = 0; i < 4; i++) {
    for (const sx of [-1, 1]) {
      b.box('dark', [0.005, 0.016, 0.008], [sx * 0.019, 0.002, -0.626 - i * 0.013], { c: 0.001, uv: 40 })
    }
  }
  b.disc('dark', 0.0075, [0, 0, -0.6795], { seg: 18 })

  // Chassis handguard with a folded bipod.
  b.box('anodised', [0.048, 0.046, 0.240], [0, -0.004, -0.290], { c: 0.005, uv: 24, wear: 0.1 })
  addSlots(b, 0.0245, -0.010, -0.395, -0.185, 0.034, 0.014, [0.006, 0.014, 0])
  addSlots(b, -0.0245, -0.010, -0.395, -0.185, 0.034, 0.014, [0.006, 0.014, 0])
  b.box('anodised', [0.030, 0.014, 0.055], [0, -0.030, -0.372], { c: 0.003, uv: 30, wear: 0.4 })
  for (const sx of [-1, 1]) {
    b.box('anodised', [0.010, 0.012, 0.150], [sx * 0.012, -0.036, -0.320], { rot: [0.06, 0, 0], c: 0.002, uv: 30, wear: 0.45 })
    b.box('rubber', [0.014, 0.014, 0.016], [sx * 0.012, -0.036, -0.248], { c: 0.003, uv: 34, wear: 0.5 })
  }

  // Chassis stock: cheek riser, adjustable butt, thumbhole.
  b.box('polymer', [0.042, 0.058, 0.150], [0, -0.006, 0.150], { c: 0.006, uv: 24, wear: 0.12 })
  b.box('polymer', [0.036, 0.030, 0.120], [0, 0.036, 0.160], { c: 0.005, uv: 26, wear: 0.3 })
  b.tube('steel', 0.0042, 0.0042, 0.046, [0.014, 0.020, 0.150], { axis: 'y', seg: 10, uv: 40, wear: 0.6 })
  b.box('polymer', [0.038, 0.086, 0.024], [0, -0.010, 0.232], { rot: [-0.05, 0, 0], c: 0.005, uv: 26, wear: 0.25 })
  b.box('rubber', [0.040, 0.090, 0.014], [0, -0.010, 0.248], { rot: [-0.05, 0, 0], c: 0.004, uv: 30, wear: 0.4 })
  b.tube('steel', 0.0062, 0.0062, 0.008, [0.021, -0.020, 0.196], { axis: 'x', seg: 12, uv: 40, wear: 0.7 })

  const scope = addScope(b, scopeZ, railTop, scopeAxis)

  b.into(s.rh)
  addHand(b, {
    side: 1,
    palm: [0.0325, -0.088, 0.070],
    rot: [-0.20, 0, 0.06],
    wrist: [0.042, -0.134, 0.104],
    elbow: [0.152, -0.320, 0.330],
    curl: 1,
  })
  b.into(s.lh)
  addHand(b, {
    side: -1,
    palm: [-0.0430, -0.010, -0.288],
    rot: [-Math.PI / 2 + 0.10, 0, 0.1],
    wrist: [-0.050, -0.034, -0.240],
    elbow: [-0.185, -0.240, -0.050],
    curl: 0.9,
    thumbOver: true,
  })
  b.into(root)
  b.build()

  s.aim.position.set(0, scopeAxis, scopeZ)
  s.muzzle.position.set(0, 0, -0.682)
  s.port.position.set(0.028, 0.012, -0.020)

  return {
    root,
    aim: s.aim,
    muzzle: s.muzzle,
    ejectPort: s.port,
    magazine: s.mag,
    charging: s.charging,
    trigger: s.trigger,
    slide: null,
    leftHand: s.lh,
    rightHand: s.rh,
    windowRadius: scope.window,
    glassOffset: new THREE.Vector3(0, scopeAxis, scopeZ + 0.204),
    reticleKind: 'cross',
    reticleAngle: 0.40,
    magDrop: buildMagDropMesh(mats, { slices: 3, width: 0.030, depth: 0.062, sliceLen: 0.026, curve: 0.012, body: 'anodised' }),
    overallLength: 1.16,
  }
}

/** Service pistol with a cycling slide and true three-dot irons. */
function buildPistol(mats: WeaponMaterials): WeaponModel {
  const root = new THREE.Group()
  root.name = 'pistol'
  const s = shell(root)
  const b = new PartBuilder(mats, root)

  const sightAxis = 0.0235
  const rearZ = 0.052

  // Frame.
  b.box('polymer', [0.028, 0.030, 0.150], [0, -0.024, -0.020], { c: 0.004, uv: 30, wear: 0.15 })
  b.box('polymer', [0.026, 0.012, 0.060], [0, -0.040, -0.062], { c: 0.003, uv: 34, wear: 0.2 })
  addSlots(b, 0, -0.0455, -0.086, -0.040, 0.010, 0.006, [0.012, 0.004, 0])
  addTriggerGuard(b, 'polymer', -0.004, 0.040, -0.032, 0.034, 0.026)
  addPistolGrip(b, 'polymer', [0, -0.030, 0.036], 0.104, 0.28, 0.030)
  // Checkered side panels.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      b.box('polymer', [0.003, 0.058, 0.004], [sx * 0.0155, -0.078 + i * 0.001, 0.030 + i * 0.007], {
        rot: [0.28, 0, 0], c: 0.0008, uv: 44, wear: 0.55,
      })
    }
  }
  b.box('steel', [0.006, 0.010, 0.020], [-0.016, -0.016, 0.028], { c: 0.0012, uv: 40, wear: 0.7 })

  b.into(s.trigger)
  s.trigger.position.set(0, -0.030, 0.018)
  b.box('steel', [0.006, 0.026, 0.008], [0, -0.014, 0.000], { rot: [0.1, 0, 0], c: 0.0016, uv: 44, wear: 0.75 })
  b.into(root)

  b.into(s.mag)
  s.mag.position.set(0, -0.032, 0.048)
  addMagazine(b, { slices: 4, width: 0.022, depth: 0.034, sliceLen: 0.027, curve: 0.010, body: 'anodised', ribs: false })
  b.into(root)

  // Slide, animated on every shot.
  const slide = newGroup('slide', root)
  b.into(slide)
  b.box('gunmetal', [0.030, 0.030, 0.176], [0, 0.006, -0.024], { c: 0.0035, uv: 30, wear: 0.18 })
  b.box('gunmetal', [0.022, 0.010, 0.176], [0, 0.021, -0.024], { c: 0.002, uv: 34, wear: 0.35 })
  // Cocking serrations, front and rear.
  for (let i = 0; i < 7; i++) {
    for (const sx of [-1, 1]) {
      b.box('gunmetal', [0.004, 0.024, 0.0035], [sx * 0.0148, 0.006, 0.048 - i * 0.0072], { c: 0.0008, uv: 46, wear: 0.7 })
    }
  }
  for (let i = 0; i < 4; i++) {
    for (const sx of [-1, 1]) {
      b.box('gunmetal', [0.004, 0.020, 0.0035], [sx * 0.0148, 0.006, -0.078 - i * 0.0072], { c: 0.0008, uv: 46, wear: 0.7 })
    }
  }
  // Ejection port and extractor.
  b.box('dark', [0.006, 0.016, 0.044], [0.0148, 0.014, -0.020], { c: 0.001, uv: 36 })
  b.box('steel', [0.005, 0.008, 0.020], [0.0152, 0.020, 0.004], { c: 0.001, uv: 40, wear: 0.8 })
  // Sights: rear notch and front post, dots inset.
  b.box('gunmetal', [0.024, 0.010, 0.010], [0, 0.0205, rearZ], { c: 0.0012, uv: 44, wear: 0.5 })
  b.box('dark', [0.0042, 0.008, 0.011], [0, 0.0225, rearZ], { c: 0.0008, uv: 44 })
  b.box('gunmetal', [0.008, 0.010, 0.008], [0, 0.0205, -0.100], { c: 0.0012, uv: 44, wear: 0.6 })
  b.box('steel', [0.0035, 0.0035, 0.003], [0, 0.0235, -0.1042], { c: 0.0008, uv: 46, wear: 1 })
  b.into(root)

  // Barrel and muzzle crown peeking from the slide.
  b.tube('steel', 0.0092, 0.0092, 0.020, [0, 0.006, -0.108], { seg: 14, uv: 34, wear: 0.5 })
  b.disc('dark', 0.0045, [0, 0.006, -0.1181], { seg: 14 })
  b.tube('steel', 0.0038, 0.0038, 0.070, [0, -0.010, -0.080], { seg: 10, caps: false, uv: 40, wear: 0.4 })

  b.into(s.rh)
  addHand(b, {
    side: 1,
    palm: [0.0295, -0.088, 0.058],
    rot: [-0.28, 0, 0.05],
    wrist: [0.038, -0.132, 0.090],
    elbow: [0.140, -0.310, 0.300],
    curl: 1,
  })
  b.into(s.lh)
  addHand(b, {
    side: -1,
    palm: [-0.0295, -0.086, 0.052],
    rot: [-0.28, 0, -0.05],
    wrist: [-0.040, -0.128, 0.086],
    elbow: [-0.150, -0.300, 0.300],
    curl: 0.75,
    thumbOver: true,
  })
  b.into(root)
  b.build()

  s.aim.position.set(0, sightAxis, rearZ)
  s.muzzle.position.set(0, 0.006, -0.120)
  s.port.position.set(0.020, 0.016, -0.020)

  return {
    root,
    aim: s.aim,
    muzzle: s.muzzle,
    ejectPort: s.port,
    magazine: s.mag,
    charging: s.charging,
    trigger: s.trigger,
    slide,
    leftHand: s.lh,
    rightHand: s.rh,
    windowRadius: 0.010,
    glassOffset: new THREE.Vector3(0, sightAxis, rearZ),
    reticleKind: 'none',
    reticleAngle: 0,
    magDrop: buildMagDropMesh(mats, { slices: 4, width: 0.022, depth: 0.034, sliceLen: 0.027, curve: 0.010, ribs: false }),
    overallLength: 0.205,
  }
}
