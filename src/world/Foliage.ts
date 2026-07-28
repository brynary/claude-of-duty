import * as THREE from 'three'
import type { Rand } from '../core/Rand'
import type { MaterialService } from '../core/Types'
import {
  Builder, InstanceFarm, TriSoup, cylinderGeom, normalizeGeom, valueNoise,
} from './Kit'
import { settleHeight, surfaceHeight, zoneMaterialAt } from './Terrain'
import { insideAnyBuilding, xform } from './Buildings'

/**
 * Dry Mediterranean planting: grass tufts, weeds pushing through cracks,
 * date palms and a couple of olive trees — all instanced, all animated by a
 * shared wind uniform injected into the foliage material.
 *
 * Every plant here carries its outline in geometry. Nothing is a billboard and
 * nothing is alpha-cut; see `solidifyFoliage` for why.
 */

// ---------------------------------------------------------------------------
// Shared scratch
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const FALLBACK_SIDE = new THREE.Vector3(1, 0, 0)

const _blA0 = new THREE.Vector3()
const _blA1 = new THREE.Vector3()
const _blB0 = new THREE.Vector3()
const _blB1 = new THREE.Vector3()
const _blC = new THREE.Vector3()
const _blW = new THREE.Vector3()
const _blU = new THREE.Vector3()

/**
 * A tapered blade: `segs` quads running from `base` along `dir`, widening
 * across `wide`, bending along `bend` as the square of the distance, and
 * tapering to a point at the tip.
 *
 * One winding only. The foliage material is `DoubleSide`, so three.js flips the
 * shading normal on back faces for free and a second winding would buy nothing
 * but triangles — and there are tens of thousands of these.
 */
function taperedBlade(
  s: TriSoup,
  base: THREE.Vector3,
  dir: THREE.Vector3,
  wide: THREE.Vector3,
  bend: THREE.Vector3,
  len: number,
  halfWidth: number,
  segs: number,
  taperPow = 0.55,
  twist = 0,
): void {
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    _blC.copy(base).addScaledVector(dir, len * t).addScaledVector(bend, t * t)
    const hw = halfWidth * Math.pow(Math.max(0, 1 - t), taperPow)
    if (twist !== 0) {
      // Rolling the blade about its own axis gives every segment a different
      // normal, which is where a strip of grass gets its shading variation.
      _blU.crossVectors(dir, wide)
      _blW.copy(wide).multiplyScalar(Math.cos(twist * t)).addScaledVector(_blU, Math.sin(twist * t))
    } else {
      _blW.copy(wide)
    }
    _blB0.copy(_blC).addScaledVector(_blW, hw)
    _blB1.copy(_blC).addScaledVector(_blW, -hw)
    // The tip quad collapses to a triangle; `TriSoup.tri` drops the degenerate
    // half, so a two-segment leaflet costs three triangles rather than four.
    if (i > 0) s.quad(_blA0, _blA1, _blB1, _blB0, false)
    _blA0.copy(_blB0)
    _blA1.copy(_blB1)
  }
}

/** Horizontal vector perpendicular to `dir`, with a fallback when it is vertical. */
function sideOf(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.crossVectors(dir, WORLD_UP)
  if (out.lengthSq() < 1e-8) out.copy(FALLBACK_SIDE)
  return out.normalize()
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

const NEIGHBOUR_X = [1, -1, 0, 0]
const NEIGHBOUR_Y = [0, 0, 1, -1]

/**
 * Turns the shared foliage surface from an alpha-tested billboard sheet into an
 * opaque leaf surface, and pads the texels the cutout used to discard.
 *
 * The baked albedo carries a leaf-cluster cutout in its alpha channel. That is
 * the right texture for a billboard card and the wrong one for every plant in
 * this level: grass blades, palm leaflets and olive leaves all carry their
 * outline in geometry, and the cutout was landing on that geometry at whatever
 * world-space offset the vertex happened to sit at, erasing arbitrary pieces of
 * it. Minification made it worse — a palm crown at fifteen metres lost most of
 * its frond area into the mip chain, and what survived had hard ragged holes
 * and stair-stepped edges that belonged to the texture rather than to the palm.
 *
 * So the test goes. The texels it used to discard have never been on screen, so
 * they still hold whatever the recipe left in the gaps between painted leaves —
 * near-black, at the albedo floor — and would read as soot the moment the test
 * is switched off. They are filled here by growing the nearest opaque texel
 * outward: the same edge padding every texture pipeline runs before it ships an
 * alpha-tested asset, and which also removes the dark fringe bilinear filtering
 * was pulling out of those texels along every leaf edge.
 */
export function solidifyFoliage(mats: MaterialService): void {
  const mat = mats.get('foliage') as THREE.MeshStandardMaterial
  if (mat.userData.__foliageSolid) return
  mat.userData.__foliageSolid = true

  const tex = mat.map
  const img = tex?.image as { data?: unknown; width?: number; height?: number } | undefined
  if (tex && img && img.data instanceof Uint8Array
    && typeof img.width === 'number' && img.width === img.height && img.width > 1) {
    if (padAlphaGaps(img.data, img.width)) tex.needsUpdate = true
  }

  mat.alphaTest = 0
  mat.needsUpdate = true
}

/**
 * Multi-source flood fill over an RGBA byte texture: every transparent texel
 * takes the colour of the nearest opaque one, wrapping at the edges because the
 * texture tiles. Linear in the texel count, and run exactly once during level
 * build.
 */
function padAlphaGaps(data: Uint8Array, size: number): boolean {
  const n = size * size
  const src = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  let tail = 0
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] >= 128) {
      src[i] = i
      queue[tail++] = i
    }
  }
  if (tail === 0 || tail === n) return false
  for (let head = 0; head < tail; head++) {
    const i = queue[head]
    const from = src[i]
    const a = from * 4
    const x = i % size
    const y = (i / size) | 0
    for (let k = 0; k < 4; k++) {
      const nx = (x + NEIGHBOUR_X[k] + size) % size
      const ny = (y + NEIGHBOUR_Y[k] + size) % size
      const j = ny * size + nx
      if (src[j] >= 0) continue
      src[j] = from
      const o = j * 4
      data[o] = data[a]
      data[o + 1] = data[a + 1]
      data[o + 2] = data[a + 2]
      queue[tail++] = j
    }
  }
  for (let i = 0; i < n; i++) data[i * 4 + 3] = 255
  return true
}

// ---------------------------------------------------------------------------
// Ground cover
// ---------------------------------------------------------------------------

const _grDir = new THREE.Vector3()
const _grWide = new THREE.Vector3()
const _grBend = new THREE.Vector3()
const _grBase = new THREE.Vector3()

/** Two-sided tapered blade, curving away from vertical. */
function blade(s: TriSoup, dir: number, lean: number, h: number, w: number, curl: number, segs = 3): void {
  const dx = Math.cos(dir)
  const dz = Math.sin(dir)
  // A blade rises, then leans over: model it as a mostly vertical run with the
  // lean folded into the quadratic bend term.
  const rise = h * 0.92
  const reach = lean + curl
  _grDir.set(0, 1, 0)
  _grBend.set(dx * reach, -h * 0.09, dz * reach)
  _grWide.set(-dz, 0, dx)
  _grBase.set(0, 0, 0)
  taperedBlade(s, _grBase, _grDir, _grWide, _grBend, rise, w / 2, segs, 0.62, 0.9)
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
  for (let i = 0; i < 7; i++) {
    const r = valueNoise(seed + i * 5.1, i * 2.3)
    const dir = (i / 7) * Math.PI * 2 + r * 0.6
    blade(s, dir, 0.3 + Math.abs(r) * 0.25, 0.24 + Math.abs(r) * 0.18, 0.062, 0.16, 2)
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

// ---------------------------------------------------------------------------
// Date palm
// ---------------------------------------------------------------------------

/**
 * One frond of a date palm.
 *
 * A palm frond is pinnate: a stout tapering rachis with two ranks of narrow
 * leaflets set into it at an angle, so the whole thing has a shallow V section
 * and a feathered outline. Built as a card it has neither — it reads as a flat
 * leaf from the front and disappears to a hairline edge-on, which is exactly
 * how the crowns were being clocked in the plaza pose. Everything here is real
 * geometry, and at three triangles a leaflet it is cheap enough to be.
 */
interface FrondSpec {
  /** Azimuth the frond leaves the crown on. */
  azim: number
  len: number
  /** Departure angle above horizontal, in radians. Negative for a dead frond. */
  pitch: number
  /** How hard the rachis arcs over along its length. */
  droop: number
  /** Lateral curve, so no two fronds are a straight radial line. */
  sweep: number
  leafLen: number
  leafWidth: number
  /** Leaflet stations along the rachis; each carries a leaflet on both ranks. */
  stations: number
  seed: number
}

const SPINE_SEGS = 7
const _spine: THREE.Vector3[] = []
const _tangent: THREE.Vector3[] = []
for (let i = 0; i <= SPINE_SEGS; i++) {
  _spine.push(new THREE.Vector3())
  _tangent.push(new THREE.Vector3())
}
const _ringPrev = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const _ringCur = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const _fpos = new THREE.Vector3()
const _ftan = new THREE.Vector3()
const _fside = new THREE.Vector3()
const _fnorm = new THREE.Vector3()
const _fdir = new THREE.Vector3()
const _fwide = new THREE.Vector3()
const _fbend = new THREE.Vector3()
const _fbase = new THREE.Vector3()

function buildFrond(s: TriSoup, origin: THREE.Vector3, f: FrondSpec): void {
  const step = f.len / SPINE_SEGS
  let px = origin.x
  let py = origin.y
  let pz = origin.z
  for (let k = 0; k <= SPINE_SEGS; k++) {
    const t = k / SPINE_SEGS
    _spine[k].set(px, py, pz)
    const pitch = f.pitch - f.droop * t * t
    const az = f.azim + f.sweep * t * t
    _tangent[k].set(Math.cos(pitch) * Math.cos(az), Math.sin(pitch), Math.cos(pitch) * Math.sin(az))
    px += _tangent[k].x * step
    py += _tangent[k].y * step
    pz += _tangent[k].z * step
  }

  // Rachis: a three-sided tapering prism. Three faces is enough to catch a
  // different shade on each side of a 5 cm stalk, and it means the spine still
  // reads as a solid stem when the frond is seen exactly edge-on.
  const rBase = f.len * 0.011 + 0.005
  const radAt = (t: number): number => rBase * (1 - t * 0.85)
  for (let k = 0; k <= SPINE_SEGS; k++) {
    const t = k / SPINE_SEGS
    sideOf(_tangent[k], _fside)
    _fnorm.crossVectors(_fside, _tangent[k]).normalize()
    const r = radAt(t)
    for (let c = 0; c < 3; c++) {
      const a = (c / 3) * Math.PI * 2 + Math.PI / 2
      _ringCur[c].copy(_spine[k])
        .addScaledVector(_fside, Math.cos(a) * r)
        .addScaledVector(_fnorm, Math.sin(a) * r)
    }
    if (k > 0) {
      for (let c = 0; c < 3; c++) {
        const d = (c + 1) % 3
        s.quad(_ringPrev[c], _ringPrev[d], _ringCur[d], _ringCur[c], false)
      }
    }
    for (let c = 0; c < 3; c++) _ringPrev[c].copy(_ringCur[c])
  }

  for (let i = 0; i < f.stations; i++) {
    const t = 0.07 + 0.92 * (i / (f.stations - 1))
    const fk = t * SPINE_SEGS
    const k = Math.min(SPINE_SEGS - 1, Math.floor(fk))
    const fr = fk - k
    _fpos.lerpVectors(_spine[k], _spine[k + 1], fr)
    _ftan.lerpVectors(_tangent[k], _tangent[k + 1], fr).normalize()
    sideOf(_ftan, _fside)
    _fnorm.crossVectors(_fside, _ftan).normalize()

    const n1 = valueNoise(f.seed + i * 0.71, i * 1.93)
    const n2 = valueNoise(i * 2.37, f.seed * 1.31 + i)
    // Longest leaflets sit just past the middle of the rachis; they shorten
    // toward the base and come to a point at the tip.
    const shape = Math.pow(Math.sin(Math.PI * Math.min(1, 0.14 + t * 0.93)), 0.5)
    const ll = f.leafLen * (0.36 + 0.64 * shape) * (0.86 + 0.24 * Math.abs(n1))
    // Leaflets rake forward more the closer they sit to the tip.
    const rake = 0.40 + 0.60 * t + 0.10 * n2
    const sinR = Math.sin(rake)
    const cosR = Math.cos(rake)
    const r = radAt(t)
    for (let q = 0; q < 2; q++) {
      const sgn = q === 0 ? -1 : 1
      // Alternating out-of-plane pitch: the two ranks form the frond's V and
      // consecutive leaflets sit in slightly different planes, so the crown
      // never collapses to a flat sheet from any angle.
      const lift = (0.40 + 0.32 * Math.abs(n2)) * (i % 2 === 0 ? 1 : 0.52)
      _fdir.set(0, 0, 0)
        .addScaledVector(_ftan, sinR)
        .addScaledVector(_fside, sgn * Math.cos(lift) * cosR)
        .addScaledVector(_fnorm, Math.sin(lift) * cosR)
        .normalize()
      _fwide.crossVectors(_fdir, _ftan)
      if (_fwide.lengthSq() < 1e-8) _fwide.copy(_fnorm)
      _fwide.normalize()
      _fbend.set(0, -ll * (0.20 + 0.20 * Math.abs(n1)), 0)
      _fbase.copy(_fpos).addScaledVector(_fside, sgn * r * 0.75)
      taperedBlade(s, _fbase, _fdir, _fwide, _fbend, ll,
        f.leafWidth * (0.82 + 0.34 * Math.abs(n2)), 2, 0.5)
    }
  }
}

/** The stub left on a palm trunk where an old frond was cut away. */
function scarGeom(w: number, h: number, out: number): THREE.BufferGeometry {
  const s = new TriSoup().setInside(0, 0, -out)
  const hw = w / 2
  const hh = h / 2
  const tw = hw * 0.42
  const th = hh * 0.36
  const dy = -h * 0.24
  const base = [
    new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0), new THREE.Vector3(-hw, hh, 0),
  ]
  const tip = [
    new THREE.Vector3(-tw, -th + dy, out), new THREE.Vector3(tw, -th + dy, out),
    new THREE.Vector3(tw, th + dy, out), new THREE.Vector3(-tw, th + dy, out),
  ]
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    s.quad(base[i], base[j], tip[j], tip[i])
  }
  s.quad(tip[0], tip[1], tip[2], tip[3])
  return s.toGeometry()
}

const _frondOrigin = new THREE.Vector3()

/** Date palm: a segmented, slightly leaning trunk with a crown of fronds. */
function palmGeom(seed: number, height: number): { trunk: THREE.BufferGeometry; fronds: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = []
  const segs = 11
  const lean = valueNoise(seed, seed * 1.7) * 0.16
  const scars = [scarGeom(0.19, 0.16, 0.052), scarGeom(0.165, 0.14, 0.043), scarGeom(0.205, 0.15, 0.058)]
  const RINGS = 3
  const PER_RING = 8
  let y = 0
  for (let i = 0; i < segs; i++) {
    const t = i / segs
    const segH = height / segs
    const r = 0.28 - t * 0.11
    const c = cylinderGeom(r * 0.92, r, segH * 1.06, 10, false)
    const bend = lean * t * t * height
    parts.push(c.clone().applyMatrix4(xform(bend * 0.5, y + segH / 2, bend * 0.2, 0, 0, lean * t)))
    c.dispose()
    // The diamond lattice of old leaf bases. Successive rings advance a third
    // of a step around the trunk, so the scars spiral the way they do on a real
    // date palm rather than stacking into bands — and it is the only relief a
    // six metre column of trunk has to carry a shadow on.
    if (i >= 1 && i < segs - 1) {
      for (let ring = 0; ring < RINGS; ring++) {
        // The ring's own point on the trunk curve, not the segment centre's —
        // half a segment of lean is the same distance as a scar protrudes, so
        // using the segment value floats them off one side of the trunk.
        const rowT = (i + (ring + 0.5) / RINGS) / segs
        const rowBend = lean * rowT * rowT * height
        const ry = y + segH * ((ring + 0.5) / RINGS)
        const rowR = 0.28 - rowT * 0.11
        for (let k = 0; k < PER_RING; k++) {
          const row = i * RINGS + ring
          const a = (k / PER_RING) * Math.PI * 2 + row * 0.3
          const j = valueNoise(seed + row * 3.1, k * 2.3)
          parts.push(scars[(row + k) % scars.length].clone().applyMatrix4(xform(
            rowBend * 0.5 + Math.cos(a) * rowR * 0.95,
            ry,
            rowBend * 0.2 + Math.sin(a) * rowR * 0.95,
            Math.PI / 2 - a + j * 0.09, 0.46 + j * 0.16)))
        }
      }
    }
    y += segH
  }
  for (const g of scars) g.dispose()

  const topX = lean * height * 0.5
  const crownY = y
  // A short collar where the fronds emerge, so the crown has a mass the fronds
  // hang off rather than a point they all converge on.
  parts.push(cylinderGeom(0.1, 0.2, 0.42, 9, false)
    .applyMatrix4(xform(topX, crownY + 0.16, 0)))

  const s = new TriSoup()
  const leafLen = height * 0.088
  const leafWidth = height * 0.0052
  const push = (i: number, spec: Omit<FrondSpec, 'seed'>): void => {
    _frondOrigin.set(
      topX + Math.cos(spec.azim) * 0.13,
      crownY + 0.16 + valueNoise(seed * 2 + i, i * 0.9) * 0.13,
      Math.sin(spec.azim) * 0.13,
    )
    buildFrond(s, _frondOrigin, { ...spec, seed: seed * 3.1 + i * 1.7 })
  }

  let idx = 0
  // Outer whorl: long, nearly horizontal at the base and arcing well over.
  for (let i = 0; i < 8; i++) {
    const j = valueNoise(seed + i * 1.3, i * 2.7)
    push(idx++, {
      azim: (i / 8) * Math.PI * 2 + j * 0.28,
      len: height * 0.44 * (0.9 + 0.16 * Math.abs(j)),
      pitch: 0.30 + 0.22 * j,
      droop: 1.55 + 0.45 * Math.abs(j),
      sweep: j * 0.34,
      leafLen, leafWidth, stations: 26,
    })
  }
  // Inner whorl: shorter, steeper, filling the middle of the crown.
  for (let i = 0; i < 5; i++) {
    const j = valueNoise(seed * 1.9 + i * 2.1, i * 1.1)
    push(idx++, {
      azim: (i / 5) * Math.PI * 2 + 0.6 + j * 0.3,
      len: height * 0.34 * (0.9 + 0.16 * Math.abs(j)),
      pitch: 0.82 + 0.24 * j,
      droop: 1.15 + 0.35 * Math.abs(j),
      sweep: -j * 0.3,
      leafLen: leafLen * 0.88, leafWidth, stations: 22,
    })
  }
  // Spears: the new growth at the centre, still nearly closed.
  for (let i = 0; i < 3; i++) {
    const j = valueNoise(seed * 0.7 + i, i * 3.3)
    push(idx++, {
      azim: (i / 3) * Math.PI * 2 + 1.2,
      len: height * 0.23,
      pitch: 1.32 + 0.1 * j,
      droop: 0.42,
      sweep: j * 0.2,
      leafLen: leafLen * 0.6, leafWidth: leafWidth * 0.9, stations: 16,
    })
  }
  // The skirt of dead fronds hanging back against the trunk.
  for (let i = 0; i < 4; i++) {
    const j = valueNoise(seed * 1.3 + i * 4.7, i * 0.6)
    push(idx++, {
      azim: (i / 4) * Math.PI * 2 + 0.35,
      len: height * 0.27,
      pitch: -0.52 - 0.2 * Math.abs(j),
      droop: 0.55,
      sweep: j * 0.5,
      leafLen: leafLen * 0.55, leafWidth: leafWidth * 0.85, stations: 16,
    })
  }

  return { trunk: mergeParts(parts), fronds: normalizeGeom(s.toGeometry()) }
}

// ---------------------------------------------------------------------------
// Olive
// ---------------------------------------------------------------------------

const _spDir = new THREE.Vector3()
const _spInner = new THREE.Vector3()
const _spSide = new THREE.Vector3()
const _spNorm = new THREE.Vector3()
const _spBend = new THREE.Vector3()
const _spBase = new THREE.Vector3()
const _spLeaf = new THREE.Vector3()
const _spWide = new THREE.Vector3()
/** Stays zero: an olive leaf is stiff and does not bend along its length. */
const _spNoBend = new THREE.Vector3()

/**
 * An olive canopy, built as sprays rather than as crossed cards.
 *
 * The tree at (-7.4, -5.0) stands 5.5 m from the plaza camera and 5 m off its
 * axis, so its canopy clips into the left edge of that frame at close range —
 * near enough that the sixteen crossed quads this used to be read as a flat
 * painted slab. Each spray is now a twig with leaves in opposite pairs along
 * it, so the canopy has interior structure and an open, airy edge, which is
 * what an olive actually looks like and is far more forgiving than trying to
 * build a solid silhouette out of flat quads.
 */
function canopyGeom(r: number, seed: number): THREE.BufferGeometry {
  const s = new TriSoup()
  const sprays = Math.max(12, Math.round(150 * r * r))
  // Olive leaves run 4-8 cm. These sit at the top of that: leaf area is what
  // closes a canopy up, and widening the blade buys coverage at no extra
  // triangle where adding sprays would cost one for every three pixels.
  const leafLen = 0.085
  const leafHalf = 0.0125
  for (let i = 0; i < sprays; i++) {
    const u = valueNoise(seed + i * 1.77, i * 0.93)
    const w = valueNoise(seed * 0.71 + i * 3.1, i * 1.29)
    // Golden-angle spiral over an evenly divided polar axis, so the sprays
    // actually cover the shell instead of piling up around its equator, then
    // squashed in Y because an olive is wider than it is tall.
    const az = (i + 0.5) * 2.39996 + u * 0.55
    const cosT = 1 - (2 * (i + 0.5)) / sprays
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    _spDir.set(Math.cos(az) * sinT, cosT * 0.72, Math.sin(az) * sinT).normalize()
    // Low-discrepancy radial spread: a shell with thickness rather than a
    // hollow ball the camera can see the inside of.
    const rr = r * (0.56 + 0.44 * ((i * 0.6180339887) % 1)) * (0.9 + 0.2 * Math.abs(w))
    _spInner.copy(_spDir).multiplyScalar(rr * 0.26)
    const twigLen = rr * 0.74
    sideOf(_spDir, _spSide)
    _spNorm.crossVectors(_spSide, _spDir).normalize()
    _spBend.set(_spSide.x * rr * 0.16, -rr * 0.2, _spSide.z * rr * 0.16)
    taperedBlade(s, _spInner, _spDir, _spSide, _spBend, twigLen, 0.005, 3, 0.4)

    const leaves = 5
    for (let k = 0; k < leaves; k++) {
      const t = 0.28 + 0.72 * (k / (leaves - 1))
      const n1 = valueNoise(seed + i * 0.9 + k * 2.3, k * 1.7)
      const n2 = valueNoise(k * 3.1 + i, seed * 0.9 - k)
      _spBase.copy(_spInner).addScaledVector(_spDir, twigLen * t).addScaledVector(_spBend, t * t)
      const roll = k * 1.4 + u * 2.0
      for (let q = 0; q < 2; q++) {
        const sgn = q === 0 ? -1 : 1
        const c = Math.cos(roll)
        const sn = Math.sin(roll)
        _spLeaf.set(0, 0, 0)
          .addScaledVector(_spSide, sgn * c * 0.86)
          .addScaledVector(_spNorm, sgn * sn * 0.86)
          .addScaledVector(_spDir, 0.5 + 0.2 * n1)
          .normalize()
        _spWide.crossVectors(_spLeaf, _spDir)
        if (_spWide.lengthSq() < 1e-8) _spWide.copy(_spNorm)
        _spWide.normalize()
        const ll = leafLen * (0.78 + 0.44 * Math.abs(n2))
        taperedBlade(s, _spBase, _spLeaf, _spWide, _spNoBend, ll,
          leafHalf * (0.85 + 0.3 * Math.abs(n1)), 2, 0.35)
      }
    }
  }
  return s.toGeometry()
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Registers instanced foliage kinds. */
export function defineFoliageKinds(farm: InstanceFarm): void {
  farm.define('tuftA', tuftGeom(7, 0.42, 0.042, 3.1), 'foliage', false, true)
  farm.define('tuftB', tuftGeom(7, 0.3, 0.038, 9.7), 'foliage', false, true)
  farm.define('tuftDry', tuftGeom(6, 0.55, 0.032, 17.3, 0.32), 'foliage', false, true)
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
    // Seated on the drawn surface, not the analytic field: over a bump the
    // mesh sits several centimetres lower and a tuft hovers on its own shadow.
    const y = surfaceHeight(x, z)
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
    const y = surfaceHeight(x, z)
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
    const y = settleHeight(t.x, t.z, 0.9, 0.06)
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
        farm.place('tuftDry', t.x + rng.spread(0.6), y + 0.04, t.z + rng.spread(0.6), rng.range(0, 3.1), rng.range(0.8, 1.3))
      }
    } else {
      b.push(t.x, y, t.z, rng.range(0, Math.PI * 2))
      const trunkH = t.h * 0.42
      b.geom('woodBeam', cylinderGeom(0.15, 0.26, trunkH, 8), new THREE.Matrix4().makeTranslation(0, trunkH / 2, 0))
      b.collide(0.4, trunkH, 0.4, 0, trunkH / 2, 0, 0, 'wood')
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4
        const len = t.h * 0.4
        b.geom('woodBeam', cylinderGeom(0.032, 0.072, len, 6),
          xform(Math.cos(a) * len * 0.25, trunkH + len * 0.35, Math.sin(a) * len * 0.25, -a, 0, 0.7))
        // Two secondary limbs off each main branch, so the canopy has something
        // to hang from at the range the plaza camera looks at it from.
        for (let m = 0; m < 2; m++) {
          const sa = a + (m === 0 ? 0.45 : -0.45)
          const sl = len * 0.5
          b.geom('woodBeam', cylinderGeom(0.014, 0.03, sl, 5),
            xform(Math.cos(sa) * len * 0.55, trunkH + len * 0.62, Math.sin(sa) * len * 0.55, -sa, 0, 0.85))
        }
        b.geom('foliage', canopyGeom(t.h * 0.3, i * 3 + k),
          xform(Math.cos(a) * len * 0.5, trunkH + len * 0.7, Math.sin(a) * len * 0.5))
      }
      b.geom('foliage', canopyGeom(t.h * 0.36, i * 11), new THREE.Matrix4().makeTranslation(0, trunkH + t.h * 0.32, 0))
      b.pop()
    }
  }
}
