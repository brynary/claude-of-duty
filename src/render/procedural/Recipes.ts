import * as THREE from 'three'
import type { MaterialName } from '../MaterialNames'
import type { SurfaceBuild } from './Bake'
import type { Noise } from './Noise'
import type { TriplanarOptions } from './Triplanar'
import {
  boxBlur,
  contrast,
  normalize01,
  colorField,
  convexMask,
  copyField,
  field,
  fillColor,
  linearFromHex,
  mixColor,
  modulateColor,
  offsetColor,
  powField,
  saturate,
  smoothstep,
  smoothstepField,
  type ColorField,
  type Field,
} from './Fields'
import {
  bricks,
  chainlink,
  chipMask,
  corrugation,
  craters,
  gravityStreaks,
  leafCluster,
  pantiles,
  pebbles,
  planks,
  quantile,
  rustBlooms,
  sandRipples,
  scratches,
  setts,
  weave,
} from './Patterns'

/**
 * The material recipes.
 *
 * Each one composes noise, structural patterns and weathering layers into a
 * complete PBR surface. The rules every recipe follows:
 *
 * - **Albedo lives in 0.03..0.88 linear.** Nothing in the real world is pure
 *   black or pure white, and clamping is enforced at bake time.
 * - **Roughness always varies.** A constant roughness reads as plastic
 *   regardless of how good the albedo is; breakup is what sells PBR.
 * - **Everything has a history.** Edge wear on exposed geometry, grime in
 *   cavities, water staining running downhill, chipped coatings showing the
 *   substrate underneath.
 * - **Real-world scale.** `worldSize` is the number of metres one texture tile
 *   covers, so a brick really is 215 mm long and a roof tile really is 200 mm
 *   wide when the level places it.
 */

type Rgb = readonly [number, number, number]

const L = linearFromHex

export interface MaterialSpec {
  size: number
  /** Metres spanned by one texture tile. Drives triplanar scale and UV repeat. */
  worldSize: number
  build: (n: Noise, size: number) => SurfaceBuild
  /** World-space projection settings, or `null` to use the mesh's own UVs. */
  triplanar: Omit<TriplanarOptions, 'scale'> | null
  /** Repeat for UV-mapped materials. Defaults to 1:1 with `worldSize`. */
  repeat?: [number, number]
  physical?: boolean
  params?: THREE.MeshPhysicalMaterialParameters
  normalScale?: number
  aoIntensity?: number
}

// --- Small composition helpers -------------------------------------------

function blank(size: number, color: Rgb, rough: number, metal: number, normalStrength: number): SurfaceBuild {
  return {
    size,
    height: field(size, size, 0.5),
    albedo: fillColor(colorField(size, size), color),
    rough: field(size, size, rough),
    metal: field(size, size, metal),
    normalStrength,
  }
}

/**
 * Pushes a selector field out to fill 0..1 and adds contrast.
 *
 * fBm output clusters hard around its mean, so feeding it straight into a
 * colour gradient only ever reaches the middle of the palette and the surface
 * comes out flat. Stretching first is what makes tonal blotching actually read.
 */
function stretch(f: Field, amount = 1.6): Field {
  return contrast(normalize01(f), amount)
}

/** `dst = lo + (hi - lo) * src`, the workhorse for roughness authoring. */
function ramp(dst: Field, src: Field, lo: number, hi: number): Field {
  for (let i = 0; i < dst.length; i++) dst[i] = lo + (hi - lo) * src[i]
  return dst
}

/** `dst += (src - bias) * k` — additive breakup around a neutral point. */
function jitter(dst: Field, src: Field, k: number, bias = 0.5): Field {
  for (let i = 0; i < dst.length; i++) dst[i] += (src[i] - bias) * k
  return dst
}

/** Pulls `dst` towards `target` wherever `mask` is set. */
function toward(dst: Field, mask: Field, target: number, amount = 1): Field {
  for (let i = 0; i < dst.length; i++) dst[i] += (target - dst[i]) * mask[i] * amount
  return dst
}

function scaled(src: Field, k: number): Field {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i] * k
  return out
}

/** Assigns a palette entry per texel from a 0..1 selector field. */
function tintCells(alb: ColorField, sel: Field, palette: readonly Rgb[], amount = 1): ColorField {
  const n = sel.length
  const last = palette.length - 1
  for (let p = 0; p < n; p++) {
    const c = palette[Math.min(last, (sel[p] * palette.length) | 0)]
    const i = p * 3
    alb[i] += (c[0] - alb[i]) * amount
    alb[i + 1] += (c[1] - alb[i + 1]) * amount
    alb[i + 2] += (c[2] - alb[i + 2]) * amount
  }
  return alb
}

/** Smooth interpolation across a palette — for continuous tonal drift. */
function gradientCells(alb: ColorField, sel: Field, palette: readonly Rgb[], amount = 1): ColorField {
  const n = sel.length
  const segs = palette.length - 1
  for (let p = 0; p < n; p++) {
    const g = saturate(sel[p]) * segs
    const k = Math.min(segs - 1, g | 0)
    const t = g - k
    const a = palette[k]
    const b = palette[k + 1]
    const i = p * 3
    alb[i] += (a[0] + (b[0] - a[0]) * t - alb[i]) * amount
    alb[i + 1] += (a[1] + (b[1] - a[1]) * t - alb[i + 1]) * amount
    alb[i + 2] += (a[2] + (b[2] - a[2]) * t - alb[i + 2]) * amount
  }
  return alb
}

/**
 * Wood grain: latewood rings running along the board, bent around scattered
 * knots, plus longitudinal fibre streaks. The ring phase is warped by
 * anisotropic noise so the grain wanders the way sawn timber actually does.
 */
function woodGrain(
  n: Noise,
  s: number,
  ringFreq: number,
  warpAmt: number,
  knotCount: number,
  salt: number,
): { rings: Field; fibre: Field; knots: Field } {
  const wander = n.fbm(s, s, 4, 10, 4, 0.5, salt)
  const fibre = n.fbm(s, s, 5, 190, 2, 0.5, salt + 1)
  const rings = field(s, s)
  const knots = field(s, s)

  const rnd = n.rand(salt + 2)
  const kx = new Float32Array(knotCount)
  const ky = new Float32Array(knotCount)
  const kr = new Float32Array(knotCount)
  for (let i = 0; i < knotCount; i++) {
    kx[i] = rnd.next() * s
    ky[i] = rnd.next() * s
    kr[i] = rnd.range(0.012, 0.032) * s
  }

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x
      let phase = (y / s) * ringFreq + (wander[i] - 0.5) * warpAmt
      let knot = 0
      for (let k = 0; k < knotCount; k++) {
        let dx = x - kx[k]
        let dy = y - ky[k]
        if (dx > s * 0.5) dx -= s
        if (dx < -s * 0.5) dx += s
        if (dy > s * 0.5) dy -= s
        if (dy < -s * 0.5) dy += s
        const d = Math.sqrt(dx * dx + dy * dy * 2.2)
        // Grain crowds together as it flows around the knot.
        phase += (kr[k] * 2.6) / (d + kr[k] * 0.9) - 0.4
        knot = Math.max(knot, 1 - smoothstep(kr[k] * 0.55, kr[k] * 1.25, d))
      }
      const f = phase - Math.floor(phase)
      const band = Math.pow(Math.sin(f * Math.PI), 5)
      rings[i] = saturate(band * 0.85 + fibre[i] * 0.25)
      knots[i] = knot
    }
  }
  return { rings, fibre, knots }
}

/** Fine sandblast/pore grain shared by many surfaces. */
function grain(n: Noise, s: number, freq: number, salt: number, octaves = 3): Field {
  return n.fbm(s, s, freq, freq, octaves, 0.5, salt)
}

// --- Ground ---------------------------------------------------------------

function buildAsphalt(n: Noise, s: number, cracked: boolean): SurfaceBuild {
  const b = blank(s, L(0x34332f), 0.8, 0, 1.3)
  // 10-20 mm aggregate: coarse enough to catch light, fine enough that it does
  // not read as cobbles the moment the camera drops to eye height.
  const agg = n.worley(s, s, 96, 96, 1, 1)
  const fine = grain(n, s, 160, 2, 4)
  const macro = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.55, 3), 1.5)
  const patch = smoothstepField(copyField(macro), 0.62, 0.74)
  const dust = grain(n, s, 9, 4, 4)

  for (let i = 0; i < b.height.length; i++) {
    // Aggregate stones sitting proud of the bitumen matrix.
    const stone = saturate(1 - agg.f1[i] * 2.3)
    b.height[i] = 0.5 + stone * 0.14 * (0.4 + 0.6 * agg.id[i]) + fine[i] * 0.24 + macro[i] * 0.1
  }

  // Cracks: cellular borders, domain-warped so they wander like real fatigue
  // cracking rather than reading as a Voronoi diagram.
  if (cracked) {
    const cell = n.worley(s, s, 7, 7, 5, 1)
    const cell2 = n.worley(s, s, 15, 15, 6, 1)
    const wob = n.fbm(s, s, 12, 12, 3, 0.5, 7)
    const crack = field(s, s)
    for (let i = 0; i < crack.length; i++) {
      const e1 = 1 - smoothstep(0.0, 0.045 + wob[i] * 0.05, cell.f2[i] - cell.f1[i])
      const e2 = (1 - smoothstep(0.0, 0.03, cell2.f2[i] - cell2.f1[i])) * 0.55
      crack[i] = saturate(Math.max(e1, e2) * (0.35 + 0.9 * wob[i]))
    }
    const soft = boxBlur(crack, s, s, Math.max(1, (s / 256) | 0), 1)
    for (let i = 0; i < b.height.length; i++) b.height[i] -= soft[i] * 0.45
    mixColor(b.albedo, L(0x24231f), soft, 0.85)
    b.aoStrength = 1.25
  }

  gradientCells(b.albedo, macro, [L(0x272723), L(0x35342f), L(0x46443d)], 0.7)
  // Exposed aggregate is paler and grittier than the bitumen around it.
  const exposed = field(s, s)
  for (let i = 0; i < exposed.length; i++) exposed[i] = saturate(1 - agg.f1[i] * 2.6) * agg.id[i]
  mixColor(b.albedo, L(0x77736a), exposed, 0.5)
  mixColor(b.albedo, L(0x201f1c), patch, 0.5)
  mixColor(b.albedo, L(0x6a6459), scaled(dust, 0.35), 1)

  ramp(b.rough, fine, 0.68, 0.95)
  jitter(b.rough, macro, 0.16)
  // Polished tyre paths: slightly smoother, slightly darker.
  toward(b.rough, patch, 0.5, 0.55)
  b.aoInAlbedo = 0.4
  return b
}

function buildConcrete(n: Noise, s: number, worn: number): SurfaceBuild {
  const b = blank(s, L(0x7b756b), 0.82, 0, 1.9)
  const blotch = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.58, 11), 1.8)
  const mid = stretch(n.fbm(s, s, 14, 14, 4, 0.5, 12), 1.35)
  const fine = grain(n, s, 130, 13, 3)
  const pores = n.worley(s, s, 46, 46, 14, 1)
  const streaks = gravityStreaks(s, s, n, {
    freq: 26, coverage: 0.42, lengthMin: 0.2, lengthMax: 0.75, startMin: 0.35, startMax: 1, salt: 15,
  })

  for (let i = 0; i < b.height.length; i++) {
    // Air voids left by the pour. Kept shallow and sparse: a deep pinpoint
    // dimple turns into a hard black dot the moment ambient occlusion runs.
    const pore = saturate(1 - pores.f1[i] * 4.2) * (pores.id[i] > 0.74 ? 1 : 0)
    b.height[i] = 0.62 + mid[i] * 0.16 + fine[i] * 0.1 - pore * 0.11
  }

  if (worn > 0) {
    const spall = chipMask(s, s, n, { fx: 5, fy: 5, coverage: 0.22 * worn, hardness: 0.75, salt: 16 })
    const rubbleAgg = n.worley(s, s, 60, 60, 17, 1)
    const cracks = n.worley(s, s, 9, 9, 18, 1)
    const crackLine = field(s, s)
    for (let i = 0; i < crackLine.length; i++) {
      crackLine[i] = (1 - smoothstep(0, 0.035 + mid[i] * 0.03, cracks.f2[i] - cracks.f1[i])) * saturate(blotch[i] * 1.8 - 0.35)
    }
    for (let i = 0; i < b.height.length; i++) {
      const exposedAgg = saturate(1 - rubbleAgg.f1[i] * 2.4)
      b.height[i] -= spall[i] * (0.16 - exposedAgg * 0.1)
      b.height[i] -= crackLine[i] * 0.3
    }
    mixColor(b.albedo, L(0x757065), spall, 0.6)
    mixColor(b.albedo, L(0x4c4740), crackLine, 0.8)
    toward(b.rough, spall, 0.94, 0.8)
  }

  // Warm grey with genuine colour blotching — flat grey concrete is the single
  // most common failure in procedural environments.
  gradientCells(b.albedo, blotch, [L(0x6b6559), L(0x827c71), L(0x948d81), L(0x767066)], 0.8)
  offsetColor(b.albedo, mid, 0.055)
  mixColor(b.albedo, L(0x433f39), streaks, 0.5)
  mixColor(b.albedo, L(0x9d988d), scaled(fine, 0.3), 1)

  ramp(b.rough, fine, 0.7, 0.94)
  jitter(b.rough, blotch, 0.14)
  toward(b.rough, streaks, 0.96, 0.5)
  b.aoInAlbedo = 0.4
  return b
}

function buildConcreteRubble(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x8a8377), 0.9, 0, 3.4)
  const chunks = pebbles(s, s, n, { fx: 9, fy: 9, salt: 21, jitter: 1, flatten: 2.2, gap: 0.16 })
  const small = pebbles(s, s, n, { fx: 24, fy: 24, salt: 22, jitter: 1, flatten: 1.6, gap: 0.24 })
  const dust = grain(n, s, 70, 23, 3)
  const facet = n.fbm(s, s, 40, 40, 3, 0.45, 24)

  for (let i = 0; i < b.height.length; i++) {
    // Broken concrete fractures into flat facets, not smooth pebbles.
    const facets = Math.round(facet[i] * 3) / 3
    b.height[i] = saturate(chunks.height[i] * 0.72 + small.height[i] * 0.3 + facets * 0.1 + dust[i] * 0.06)
  }
  gradientCells(b.albedo, chunks.id, [L(0x7d766a), L(0x9c9488), L(0xb0a99b)], 0.75)
  mixColor(b.albedo, L(0x5a544b), chunks.gap, 0.7)
  mixColor(b.albedo, L(0xa9a091), scaled(dust, 0.4), 1)
  // Exposed rebar rust flecks in the broken faces.
  const rust = chipMask(s, s, n, { fx: 16, fy: 16, coverage: 0.05, hardness: 0.8, salt: 25 })
  mixColor(b.albedo, L(0x7a4726), rust, 0.7)

  ramp(b.rough, dust, 0.82, 0.98)
  jitter(b.rough, chunks.id, 0.1)
  b.aoStrength = 1.35
  b.aoInAlbedo = 0.5
  return b
}

function buildSand(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xc7ab7f), 0.93, 0, 3.6)
  const ripple = sandRipples(s, s, n, 6, 26, 0.1, 31)
  const drift = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 32)
  const fine = grain(n, s, 150, 33, 3)
  const grit = n.worley(s, s, 70, 70, 34, 1)
  const stones = pebbles(s, s, n, { fx: 20, fy: 20, salt: 35, jitter: 1, flatten: 1.4, gap: 0.72 })

  for (let i = 0; i < b.height.length; i++) {
    const sparkle = saturate(1 - grit.f1[i] * 3.4)
    b.height[i] = 0.3 + ripple[i] * 0.42 + drift[i] * 0.2 + fine[i] * 0.09 + sparkle * 0.05 + stones.height[i] * 0.12
  }
  gradientCells(b.albedo, drift, [L(0xb0956b), L(0xc9ac80), L(0xdcc396)], 0.7)
  offsetColor(b.albedo, ripple, 0.05)
  // Damp/shaded sand in the ripple troughs is noticeably darker and cooler.
  const trough = field(s, s)
  for (let i = 0; i < trough.length; i++) trough[i] = saturate(1 - ripple[i] * 1.7)
  mixColor(b.albedo, L(0x8a7049), trough, 0.42)
  mixColor(b.albedo, L(0x9c8e78), scaled(stones.height, 0.7), 1)

  ramp(b.rough, fine, 0.88, 0.99)
  jitter(b.rough, drift, 0.06)
  b.aoStrength = 0.7
  b.aoInAlbedo = 0.3
  return b
}

function buildDirt(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x6e5b45), 0.9, 0, 2.6)
  const clods = n.fbm(s, s, 10, 10, 5, 0.55, 41)
  const fine = grain(n, s, 120, 42, 3)
  const stones = pebbles(s, s, n, { fx: 26, fy: 26, salt: 43, jitter: 1, flatten: 1.5, gap: 0.55 })
  const damp = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 44)
  const cracks = n.worley(s, s, 13, 13, 45, 1)
  const crackLine = field(s, s)
  for (let i = 0; i < crackLine.length; i++) {
    crackLine[i] = (1 - smoothstep(0, 0.05, cracks.f2[i] - cracks.f1[i])) * saturate(damp[i] * 2 - 0.7)
  }

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.45 + clods[i] * 0.28 + fine[i] * 0.1 + stones.height[i] * 0.22 - crackLine[i] * 0.3
  }
  gradientCells(b.albedo, clods, [L(0x574733), L(0x6f5c46), L(0x8a7358)], 0.75)
  mixColor(b.albedo, L(0x4a3d2d), damp, 0.3)
  mixColor(b.albedo, L(0x7d7466), scaled(stones.height, 0.55), 1)
  mixColor(b.albedo, L(0x3c3125), crackLine, 0.7)
  offsetColor(b.albedo, fine, 0.05)

  ramp(b.rough, fine, 0.82, 0.98)
  toward(b.rough, damp, 0.72, 0.4)
  b.aoStrength = 1.1
  b.aoInAlbedo = 0.45
  return b
}

function buildGravel(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x8c857a), 0.88, 0, 3.6)
  const big = pebbles(s, s, n, { fx: 16, fy: 16, salt: 51, jitter: 1, flatten: 1.5, gap: 0.1 })
  const small = pebbles(s, s, n, { fx: 34, fy: 34, salt: 52, jitter: 1, flatten: 1.3, gap: 0.18 })
  const fines = grain(n, s, 90, 53, 3)
  const dustField = n.fbmPerlin(s, s, 4, 4, 3, 0.55, 54)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = saturate(big.height[i] * 0.68 + small.height[i] * 0.42 + fines[i] * 0.1)
  }
  gradientCells(b.albedo, big.id, [L(0x6b655c), L(0x8d8479), L(0xa9a094), L(0x7a6d5e)], 0.8)
  tintCells(b.albedo, small.id, [L(0x777066), L(0x968d80), L(0x5f574d)], 0.28)
  // Fines and dust wash into the voids between stones.
  mixColor(b.albedo, L(0x8a8172), big.gap, 0.55)
  offsetColor(b.albedo, dustField, 0.06)

  ramp(b.rough, fines, 0.78, 0.96)
  jitter(b.rough, big.id, 0.14)
  b.aoStrength = 1.4
  b.aoInAlbedo = 0.5
  return b
}

function buildCobblestone(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x6f6a62), 0.72, 0, 4.6)
  // 8 setts across a 2 m tile => 250 mm stones with a 20 mm joint.
  const stones = setts(s, s, n, { fx: 8, fy: 8, salt: 61, jitter: 0.95, joint: 0.09, crown: 0.4 })
  const chisel = n.fbm(s, s, 44, 44, 4, 0.5, 62)
  const wearField = n.fbmPerlin(s, s, 3, 3, 3, 0.55, 63)
  const grit = grain(n, s, 140, 64, 2)

  for (let i = 0; i < b.height.length; i++) {
    // Setts are domed on top but nearly flat where feet and tyres polish them,
    // and split into facets rather than reading as poured pebbles.
    const dome = Math.pow(stones.height[i], 0.5)
    const facet = Math.round(chisel[i] * 3) / 3
    b.height[i] = saturate(dome * 0.78 + facet * 0.13 + grit[i] * 0.05)
  }
  gradientCells(b.albedo, stones.id, [L(0x554f48), L(0x6e6860), L(0x847c70), L(0x5e5a55)], 0.85)
  // Mud and grit packed into the joints.
  mixColor(b.albedo, L(0x3a3327), stones.gap, 0.8)
  const joint = stones.gap
  offsetColor(b.albedo, chisel, 0.05)

  const polish = field(s, s)
  for (let i = 0; i < polish.length; i++) polish[i] = saturate(stones.height[i] * 1.4 - 0.35) * saturate(wearField[i] * 1.6 - 0.2)
  ramp(b.rough, grit, 0.68, 0.9)
  toward(b.rough, polish, 0.32, 0.8)
  toward(b.rough, joint, 0.96, 0.7)
  b.aoStrength = 1.35
  b.aoInAlbedo = 0.45
  return b
}

// --- Walls and architecture ----------------------------------------------

function buildPlaster(n: Noise, s: number, base: Rgb, damage: number, substrate: Rgb): SurfaceBuild {
  const b = blank(s, base, 0.85, 0, 2.1)
  const trowel = stretch(n.fbmPerlin(s, s, 5, 5, 4, 0.55, 71), 1.7)
  const stipple = grain(n, s, 90, 72, 3)
  const fineCrack = n.ridged(s, s, 6, 6, 5, 0.5, 73)
  const patches = chipMask(s, s, n, { fx: 4, fy: 4, coverage: 0.3, hardness: 0.35, salt: 74 })
  const streaks = gravityStreaks(s, s, n, {
    freq: 22, coverage: 0.62, lengthMin: 0.3, lengthMax: 1, startMin: 0.4, startMax: 1, salt: 75,
  })
  const soiling = stretch(n.fbmPerlin(s, s, 6, 6, 5, 0.6, 79), 1.5)

  const hairline = field(s, s)
  for (let i = 0; i < hairline.length; i++) hairline[i] = saturate((fineCrack[i] - 0.8) * 8)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.66 + trowel[i] * 0.14 + stipple[i] * 0.09 - hairline[i] * 0.16
  }

  // Blown render: chunks fall away and expose the masonry behind.
  if (damage > 0) {
    const exposure = convexMask(b.height, s, s, 5, 8)
    const chips = chipMask(s, s, n, {
      fx: 4, fy: 4, coverage: 0.26 * damage, hardness: 0.9, salt: 76, exposure, exposureWeight: 0.3,
    })
    const sub = bricks(s, s, n, {
      rows: 12, cols: 4, jointPx: s / 90, bevelPx: s / 200, stagger: 0.5, heightJitter: 0.1, jointDepth: 0.55, salt: 77,
    })
    const pock = craters(s, s, n, Math.round(26 * damage), s / 42, 78)
    for (let i = 0; i < b.height.length; i++) {
      b.height[i] = b.height[i] * (1 - chips[i]) + (sub.height[i] * 0.5 + 0.1) * chips[i]
      b.height[i] += pock[i] * 0.28
    }
    mixColor(b.albedo, substrate, chips, 0.9)
    // A pale halo of crushed plaster around every break.
    const halo = field(s, s)
    const blurChips = boxBlur(chips, s, s, Math.max(2, (s / 60) | 0), 2)
    for (let i = 0; i < halo.length; i++) halo[i] = saturate(blurChips[i] * 2 - chips[i] * 2)
    mixColor(b.albedo, L(0xcfc7b6), halo, 0.35)
    mixColor(b.albedo, L(0x3d3730), scaled(pock, -1.6), 1)
    toward(b.rough, chips, 0.95, 0.9)
  }

  // Patch repairs never match the original render.
  gradientCells(b.albedo, trowel, [
    [base[0] * 0.86, base[1] * 0.86, base[2] * 0.9],
    base,
    [Math.min(0.88, base[0] * 1.1), Math.min(0.88, base[1] * 1.08), Math.min(0.88, base[2] * 1.04)],
  ], 0.75)
  mixColor(b.albedo, [base[0] * 0.82, base[1] * 0.84, base[2] * 0.86], patches, 0.4)
  // Airborne soiling: a broad, uneven film that never lets render read as paper.
  mixColor(b.albedo, L(0x6d6555), powField(copyField(soiling), 1.6), 0.34)
  mixColor(b.albedo, L(0x443f36), streaks, 0.5)
  mixColor(b.albedo, L(0x4c463c), hairline, 0.3)
  offsetColor(b.albedo, stipple, 0.045)

  ramp(b.rough, stipple, 0.76, 0.94)
  jitter(b.rough, trowel, 0.12)
  toward(b.rough, streaks, 0.97, 0.45)
  b.aoInAlbedo = 0.4
  return b
}

function buildStucco(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xb59a79), 0.9, 0, 6.0)
  // Heavy domain warping turns even noise into swept trowel arcs.
  const wx = n.fbm(s, s, 5, 5, 3, 0.5, 81)
  const wy = n.fbm(s, s, 5, 5, 3, 0.5, 82)
  const raw = n.fbm(s, s, 26, 26, 4, 0.5, 83)
  const swirl = field(s, s)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x
      const u = x + (wx[i] - 0.5) * s * 0.16
      const v = y + (wy[i] - 0.5) * s * 0.16
      const xi = ((Math.floor(u) % s) + s) % s
      const yi = ((Math.floor(v) % s) + s) % s
      swirl[i] = raw[yi * s + xi]
    }
  }
  const coarse = n.worley(s, s, 44, 44, 84, 1)
  const streaks = gravityStreaks(s, s, n, {
    freq: 18, coverage: 0.45, lengthMin: 0.2, lengthMax: 0.8, startMin: 0.4, startMax: 1, salt: 85,
  })
  const blotch = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.55, 86), 1.8)

  for (let i = 0; i < b.height.length; i++) {
    const bump = saturate(1 - coarse.f1[i] * 2.8)
    b.height[i] = 0.46 + swirl[i] * 0.36 + bump * 0.24
  }
  gradientCells(b.albedo, blotch, [L(0x9b8161), L(0xb69b79), L(0xc9b291)], 0.8)
  offsetColor(b.albedo, swirl, 0.06)
  mixColor(b.albedo, L(0x584f42), streaks, 0.42)

  ramp(b.rough, swirl, 0.8, 0.96)
  jitter(b.rough, blotch, 0.1)
  b.aoStrength = 1.2
  b.aoInAlbedo = 0.42
  return b
}

function buildBrick(n: Noise, s: number, painted: boolean): SurfaceBuild {
  const b = blank(s, L(0x8d4a35), 0.86, 0, 3.2)
  // 12 courses x 4 bricks over a 0.9 m tile => 215 x 65 mm bricks with 10 mm joints.
  const p = bricks(s, s, n, {
    rows: 12, cols: 4, jointPx: s / 78, bevelPx: s / 260, stagger: 0.5, heightJitter: 0.1, jointDepth: 0.38, salt: 91,
  })
  const faceGrain = grain(n, s, 120, 92, 3)
  const coarse = n.worley(s, s, 90, 90, 93, 1)
  const mortarGrain = n.fbm(s, s, 60, 60, 4, 0.5, 94)
  const chipEdge = convexMask(p.height, s, s, 4, 10)
  const chips = chipMask(s, s, n, { fx: 12, fy: 12, coverage: 0.1, hardness: 0.85, salt: 95, exposure: chipEdge, exposureWeight: 0.5 })
  const streaks = gravityStreaks(s, s, n, {
    freq: 20, coverage: 0.4, lengthMin: 0.15, lengthMax: 0.6, startMin: 0.4, startMax: 1, salt: 96,
  })
  const efflor = chipMask(s, s, n, { fx: 7, fy: 7, coverage: 0.12, hardness: 0.15, salt: 97 })

  for (let i = 0; i < b.height.length; i++) {
    const pit = saturate(1 - coarse.f1[i] * 3.6) * p.face[i]
    b.height[i] = p.height[i] + faceGrain[i] * 0.05 * p.face[i] + mortarGrain[i] * 0.07 * (1 - p.face[i]) - pit * 0.08 - chips[i] * 0.12
  }

  // Every brick is fired slightly differently — flat brick colour is a giveaway.
  tintCells(b.albedo, p.id, [
    L(0x7b3b2c), L(0x94523a), L(0xa35c3c), L(0x6d3428), L(0x8a4a33), L(0xb06a44), L(0x7f4030),
  ], 0.95)
  offsetColor(b.albedo, faceGrain, 0.06)
  mixColor(b.albedo, L(0x5a2c22), scaled(coarse.f1, 0.35), 1)
  // Mortar: pale, warm, much rougher, and dirtier than the brick.
  const mortar = field(s, s)
  for (let i = 0; i < mortar.length; i++) mortar[i] = 1 - p.face[i]
  mixColor(b.albedo, L(0xb5ad9c), mortar, 0.95)
  offsetColor(b.albedo, mortarGrain, 0.05)
  mixColor(b.albedo, L(0xc98d68), chips, 0.7)
  mixColor(b.albedo, L(0xc6bfb2), efflor, 0.12)
  mixColor(b.albedo, L(0x3f382e), streaks, 0.38)

  ramp(b.rough, faceGrain, 0.72, 0.9)
  toward(b.rough, mortar, 0.96, 0.85)
  toward(b.rough, chips, 0.94, 0.7)

  if (painted) {
    // Paint bridges the joints, fills the fine texture and then flakes off the
    // brick arrises first, letting the fired clay show through.
    const paintChips = chipMask(s, s, n, {
      fx: 4, fy: 4, coverage: 0.26, hardness: 0.9, salt: 98, exposure: chipEdge, exposureWeight: 0.4,
    })
    const paintFade = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 99)
    const coverage = field(s, s)
    for (let i = 0; i < coverage.length; i++) coverage[i] = 1 - paintChips[i]
    const paintCol: Rgb = L(0xb9c2bd)
    const paintCol2: Rgb = L(0x93a09c)
    const paintField = colorField(s, s)
    gradientCells(paintField, paintFade, [paintCol2, paintCol, L(0xcfd4cd)], 1)
    for (let p2 = 0; p2 < coverage.length; p2++) {
      const t = coverage[p2]
      const i = p2 * 3
      b.albedo[i] += (paintField[i] - b.albedo[i]) * t
      b.albedo[i + 1] += (paintField[i + 1] - b.albedo[i + 1]) * t
      b.albedo[i + 2] += (paintField[i + 2] - b.albedo[i + 2]) * t
    }
    for (let i = 0; i < b.height.length; i++) b.height[i] += coverage[i] * (1 - p.face[i]) * 0.16
    ramp(b.rough, faceGrain, 0.55, 0.78)
    toward(b.rough, paintChips, 0.93, 0.9)
    mixColor(b.albedo, L(0x4a4239), streaks, 0.3)
  }

  b.aoStrength = 1.25
  b.aoInAlbedo = 0.45
  return b
}

function buildStoneBlock(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xa39a89), 0.82, 0, 3.8)
  // 4 courses x 2 blocks over a 2 m tile => 1 m x 0.5 m ashlar.
  const p = bricks(s, s, n, {
    rows: 4, cols: 2, jointPx: s / 60, bevelPx: s / 120, stagger: 0.5, heightJitter: 0.14, jointDepth: 0.4, salt: 101,
  })
  const chisel = n.ridged(s, s, 24, 24, 4, 0.5, 102)
  const pit = n.worley(s, s, 34, 34, 103, 1)
  const weather = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 104)
  const moss = chipMask(s, s, n, { fx: 5, fy: 5, coverage: 0.2, hardness: 0.25, salt: 105 })
  const streaks = gravityStreaks(s, s, n, {
    freq: 14, coverage: 0.5, lengthMin: 0.2, lengthMax: 0.8, startMin: 0.35, startMax: 1, salt: 106,
  })

  for (let i = 0; i < b.height.length; i++) {
    const pock = saturate(1 - pit.f1[i] * 3.2) * p.face[i]
    b.height[i] = p.height[i] + chisel[i] * 0.1 * p.face[i] - pock * 0.1
  }
  tintCells(b.albedo, p.id, [L(0x958b7a), L(0xa89e8c), L(0xb6ac98), L(0x8a8272)], 0.9)
  offsetColor(b.albedo, chisel, 0.07)
  const joint = field(s, s)
  for (let i = 0; i < joint.length; i++) joint[i] = 1 - p.face[i]
  mixColor(b.albedo, L(0x6e675b), joint, 0.85)
  mixColor(b.albedo, L(0x4d5236), moss, 0.35)
  mixColor(b.albedo, L(0x4c463c), streaks, 0.4)
  offsetColor(b.albedo, weather, 0.05)

  ramp(b.rough, chisel, 0.74, 0.94)
  toward(b.rough, joint, 0.95, 0.7)
  b.aoStrength = 1.3
  b.aoInAlbedo = 0.45
  return b
}

function buildTileRoof(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xa8583a), 0.78, 0, 11)
  // 5 pans x 4 courses over a 1.3 m tile => 260 mm wide, 325 mm to the lap.
  const p = pantiles(s, s, n, { cols: 5, rows: 4, overlap: 0.22, salt: 111 })
  const clay = grain(n, s, 80, 112, 3)
  const algae = chipMask(s, s, n, { fx: 6, fy: 6, coverage: 0.3, hardness: 0.25, salt: 113 })
  const chipped = chipMask(s, s, n, { fx: 20, fy: 20, coverage: 0.07, hardness: 0.9, salt: 114 })
  const weather = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 115)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = saturate(p.height[i] + clay[i] * 0.05 - chipped[i] * 0.14)
  }
  tintCells(b.albedo, p.id, [L(0x9c4f34), L(0xb26240), L(0x8a4630), L(0xc07048), L(0x7d4531)], 0.9)
  offsetColor(b.albedo, clay, 0.05)
  gradientCells(b.albedo, weather, [L(0x8c5138), L(0xa85c3c), L(0xbb7a55)], 0.35)
  // Algae collects in the shaded lap where water sits longest.
  const shade = field(s, s)
  for (let i = 0; i < shade.length; i++) shade[i] = saturate(1 - p.height[i] * 1.9)
  const algaeMask = field(s, s)
  for (let i = 0; i < algaeMask.length; i++) algaeMask[i] = algae[i] * (0.35 + 0.65 * shade[i])
  mixColor(b.albedo, L(0x4e5636), algaeMask, 0.5)
  mixColor(b.albedo, L(0xc98a66), chipped, 0.7)

  ramp(b.rough, clay, 0.66, 0.88)
  toward(b.rough, algaeMask, 0.95, 0.6)
  toward(b.rough, chipped, 0.93, 0.8)
  b.aoStrength = 1.4
  b.aoInAlbedo = 0.45
  return b
}

function buildTileFloor(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xa9a294), 0.4, 0, 2.4)
  // 4 x 4 tiles over a 1.2 m tile => 300 mm ceramic.
  const p = bricks(s, s, n, {
    rows: 4, cols: 4, jointPx: s / 70, bevelPx: s / 150, stagger: 0, heightJitter: 0.04, jointDepth: 0.42, salt: 121,
  })
  const marble = n.fbmPerlin(s, s, 8, 8, 5, 0.6, 122)
  const wearField = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 123)
  const grout = field(s, s)
  for (let i = 0; i < grout.length; i++) grout[i] = 1 - p.face[i]
  const groutGrain = grain(n, s, 100, 124, 3)
  const cracks = n.worley(s, s, 5, 5, 125, 1)
  const broken = field(s, s)
  for (let i = 0; i < broken.length; i++) {
    broken[i] = (1 - smoothstep(0, 0.02, cracks.f2[i] - cracks.f1[i])) * (p.id[i] > 0.78 ? 1 : 0) * p.face[i]
  }
  const scuff = scratches(s, s, n, 150, 26, 5, 126)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = p.height[i] + groutGrain[i] * 0.07 * grout[i] - broken[i] * 0.3
  }
  tintCells(b.albedo, p.id, [L(0xb4ad9e), L(0xa39b8c), L(0xbcb6a6), L(0x968f82)], 0.8)
  offsetColor(b.albedo, marble, 0.05)
  mixColor(b.albedo, L(0x8f887a), grout, 0.85)
  // Grout is filthy — it is the lowest, most absorbent part of the floor.
  mixColor(b.albedo, L(0x554e42), scaled(grout, 0.55), 1)
  mixColor(b.albedo, L(0x3c372f), broken, 0.7)

  // Polished in the middle of the room, worn matte along the traffic paths.
  ramp(b.rough, wearField, 0.22, 0.55)
  toward(b.rough, scuff, 0.68, 0.7)
  toward(b.rough, grout, 0.95, 0.9)
  toward(b.rough, broken, 0.9, 0.8)
  b.aoStrength = 1.15
  b.aoInAlbedo = 0.35
  return b
}

// --- Metal ---------------------------------------------------------------

function buildMetalPainted(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x3f5a4c), 0.5, 0, 1.9)
  const dent = n.fbmPerlin(s, s, 5, 5, 3, 0.55, 131)
  const orangePeel = grain(n, s, 110, 132, 3)
  const scratch = scratches(s, s, n, 190, 30, 6, 133)
  const exposure = convexMask(dent, s, s, 6, 6)
  const chips = chipMask(s, s, n, { fx: 9, fy: 9, coverage: 0.13, hardness: 0.92, salt: 134, exposure, exposureWeight: 0.4 })
  const rust = rustBlooms(s, s, n, { fx: 6, fy: 6, coverage: 0.09, salt: 135, weep: 0.12 })
  const grime = gravityStreaks(s, s, n, {
    freq: 16, coverage: 0.45, lengthMin: 0.15, lengthMax: 0.7, startMin: 0.35, startMax: 1, salt: 136,
  })
  const fade = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 137)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.6 + (dent[i] - 0.5) * 0.22 + orangePeel[i] * 0.05 - chips[i] * 0.05 - scratch[i] * 0.04 + rust.pits[i] * -0.06
  }
  gradientCells(b.albedo, fade, [L(0x33493e), L(0x405b4d), L(0x50705f)], 0.8)
  offsetColor(b.albedo, orangePeel, 0.03)
  // Bare steel under the chip, ringed by rust creeping under the paint film.
  mixColor(b.albedo, L(0x6f533c), rust.halo, 0.35)
  mixColor(b.albedo, L(0x8a4c26), rust.core, 0.75)
  mixColor(b.albedo, L(0x6e6e70), chips, 0.75)
  mixColor(b.albedo, L(0x5a3418), scaled(rust.pits, 0.9), 1)
  mixColor(b.albedo, L(0xc9c9cb), scaled(scratch, 0.45), 1)
  mixColor(b.albedo, L(0x3a352c), grime, 0.35)

  ramp(b.rough, orangePeel, 0.36, 0.6)
  jitter(b.rough, fade, 0.1)
  toward(b.rough, chips, 0.42, 0.8)
  toward(b.rough, rust.core, 0.92, 0.9)
  toward(b.rough, scratch, 0.28, 0.6)
  toward(b.rough, grime, 0.8, 0.4)
  for (let i = 0; i < b.metal.length; i++) {
    b.metal[i] = saturate(chips[i] * 0.9 * (1 - rust.core[i]) + scratch[i] * 0.35)
  }
  b.aoInAlbedo = 0.35
  return b
}

function buildMetalRusted(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x6b6b6d), 0.55, 0.9, 2.4)
  const rust = rustBlooms(s, s, n, { fx: 4, fy: 4, coverage: 0.62, salt: 141, weep: 0.25 })
  const rust2 = rustBlooms(s, s, n, { fx: 11, fy: 11, coverage: 0.4, salt: 142, weep: 0.08 })
  const flake = grain(n, s, 70, 143, 4)
  const scale = n.worley(s, s, 26, 26, 144, 1)
  const mill = scratches(s, s, n, 160, 24, 5, 145)

  const heavy = field(s, s)
  for (let i = 0; i < heavy.length; i++) heavy[i] = saturate(rust.core[i] * 0.75 + rust2.core[i] * 0.6)

  for (let i = 0; i < b.height.length; i++) {
    const scab = saturate(1 - scale.f1[i] * 2.2) * heavy[i]
    b.height[i] = 0.55 + flake[i] * 0.12 * heavy[i] + scab * 0.2 - rust.pits[i] * 0.12 - rust2.pits[i] * 0.07 + mill[i] * 0.02
  }
  gradientCells(b.albedo, flake, [L(0x5f5f61), L(0x74746f), L(0x87867e)], 0.6)
  mixColor(b.albedo, L(0x6b5340), rust.halo, 0.4)
  mixColor(b.albedo, L(0x8c4c22), heavy, 0.85)
  mixColor(b.albedo, L(0xa8652f), scaled(flake, 0.5), 0.5)
  mixColor(b.albedo, L(0x5a3419), rust.pits, 0.45)
  mixColor(b.albedo, L(0x3c2a1c), scaled(rust2.pits, 0.55), 1)

  ramp(b.rough, flake, 0.4, 0.62)
  toward(b.rough, heavy, 0.94, 0.95)
  toward(b.rough, rust.halo, 0.72, 0.4)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = saturate(0.92 - heavy[i] * 0.85 - rust.halo[i] * 0.18)
  b.aoStrength = 1.2
  b.aoInAlbedo = 0.4
  return b
}

function buildCorrugated(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x9aa0a2), 0.45, 0.85, 12)
  const ribs = corrugation(s, s, 6, 'sine')
  const dent = n.fbmPerlin(s, s, 7, 7, 3, 0.55, 151)
  const spangle = n.worley(s, s, 20, 20, 152, 1)
  const fine = grain(n, s, 120, 153, 3)
  const rust = rustBlooms(s, s, n, { fx: 5, fy: 5, coverage: 0.14, salt: 154, weep: 0.3 })
  const scratch = scratches(s, s, n, 40, 220, 6, 155)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = ribs[i] * 0.78 + (dent[i] - 0.5) * 0.14 + fine[i] * 0.04 - rust.pits[i] * 0.08
  }
  // Galvanising spangle: large zinc crystals with visibly different facets.
  const crystal = field(s, s)
  for (let i = 0; i < crystal.length; i++) crystal[i] = spangle.id[i]
  gradientCells(b.albedo, crystal, [L(0x8b9295), L(0x9ea4a6), L(0xb3b8ba)], 0.7)
  offsetColor(b.albedo, fine, 0.04)
  mixColor(b.albedo, L(0x7a5b42), rust.halo, 0.4)
  mixColor(b.albedo, L(0x945023), rust.core, 0.85)
  mixColor(b.albedo, L(0x5c3a20), rust.pits, 0.4)

  ramp(b.rough, fine, 0.34, 0.55)
  jitter(b.rough, crystal, 0.14)
  toward(b.rough, rust.core, 0.93, 0.95)
  toward(b.rough, scratch, 0.24, 0.5)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = saturate(0.92 - rust.core[i] * 0.85 - rust.halo[i] * 0.2)
  b.aoStrength = 0.85
  b.aoInAlbedo = 0.3
  return b
}

function buildSteelBrushed(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xb6babd), 0.3, 1, 2.6)
  // Brushing is extremely anisotropic: hundreds of scratches along one axis.
  const brush = n.fbm(s, s, 3, 44, 2, 0.5, 161)
  const brushFine = n.fbm(s, s, 5, 96, 1, 0.5, 162)
  const smudge = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 163)
  const deep = scratches(s, s, n, 4, 70, 7, 164)
  const dirt = grain(n, s, 60, 165, 3)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.5 + (brush[i] - 0.5) * 0.16 + (brushFine[i] - 0.5) * 0.08 - deep[i] * 0.1
  }
  offsetColor(b.albedo, brush, 0.1)
  offsetColor(b.albedo, smudge, 0.04)
  mixColor(b.albedo, L(0x8e8f8f), scaled(dirt, 0.3), 1)

  ramp(b.rough, brush, 0.14, 0.52)
  jitter(b.rough, brushFine, 0.16)
  jitter(b.rough, smudge, 0.12)
  toward(b.rough, deep, 0.5, 0.7)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = 1 - dirt[i] * 0.12
  b.aoStrength = 0.5
  b.aoInAlbedo = 0.15
  return b
}

function buildGunmetal(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x3c3e42), 0.36, 1, 1.7)
  const blast = grain(n, s, 90, 171, 3)
  const cast = n.fbmPerlin(s, s, 9, 9, 4, 0.55, 172)
  const micro = scratches(s, s, n, 260, 40, 6, 173)
  const wearField = n.fbmPerlin(s, s, 5, 5, 4, 0.6, 174)
  const exposure = convexMask(cast, s, s, 5, 7)
  const polish = field(s, s)
  for (let i = 0; i < polish.length; i++) polish[i] = saturate(exposure[i] * 0.7 + saturate(wearField[i] * 1.7 - 0.75))
  const oil = n.fbmPerlin(s, s, 3, 3, 3, 0.55, 175)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.55 + blast[i] * 0.14 + (cast[i] - 0.5) * 0.1 - micro[i] * 0.05
  }
  // Parkerised finish: dark, matte, faintly green-grey, worn bright on corners.
  gradientCells(b.albedo, cast, [L(0x33353a), L(0x3e4045), L(0x494b50)], 0.7)
  offsetColor(b.albedo, blast, 0.03)
  mixColor(b.albedo, L(0x9ea3a8), polish, 0.55)
  mixColor(b.albedo, L(0xb9bec2), scaled(micro, 0.5), 1)

  ramp(b.rough, blast, 0.32, 0.52)
  jitter(b.rough, oil, 0.08)
  toward(b.rough, polish, 0.17, 0.85)
  toward(b.rough, micro, 0.2, 0.6)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = 1
  b.aoStrength = 0.7
  b.aoInAlbedo = 0.2
  return b
}

function buildChainlink(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x8e9396), 0.42, 0.9, 4.2)
  const link = chainlink(s, s, 8, Math.max(2, s / 74))
  const fine = grain(n, s, 120, 181, 3)
  const rust = rustBlooms(s, s, n, { fx: 6, fy: 6, coverage: 0.28, salt: 182, weep: 0.15 })

  for (let i = 0; i < b.height.length; i++) b.height[i] = link.height[i] * 0.85 + fine[i] * 0.06
  b.alpha = link.alpha
  offsetColor(b.albedo, fine, 0.05)
  mixColor(b.albedo, L(0x8a5a34), rust.halo, 0.4)
  mixColor(b.albedo, L(0x8f4d24), rust.core, 0.7)

  ramp(b.rough, fine, 0.32, 0.58)
  toward(b.rough, rust.core, 0.9, 0.9)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = saturate(0.9 - rust.core[i] * 0.75)
  b.aoStrength = 0.6
  b.aoInAlbedo = 0.3
  return b
}

function buildRebar(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x7a6152), 0.75, 0.5, 6.5)
  // Transverse deformation ribs plus the two longitudinal ribs of hot-rolled bar.
  const ribs = field(s, s)
  for (let y = 0; y < s; y++) {
    const v = ((y / s) * 12) % 1
    const across = Math.pow(Math.sin(v * Math.PI), 2)
    for (let x = 0; x < s; x++) {
      const u = ((x / s) * 2) % 1
      const along = Math.pow(Math.sin(u * Math.PI), 8)
      ribs[y * s + x] = saturate(across * 0.7 + along * 0.5)
    }
  }
  const rust = rustBlooms(s, s, n, { fx: 7, fy: 7, coverage: 0.72, salt: 191, weep: 0.2 })
  const fine = grain(n, s, 130, 192, 3)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.45 + ribs[i] * 0.36 + fine[i] * 0.1 - rust.pits[i] * 0.14
  }
  gradientCells(b.albedo, fine, [L(0x6d5647), L(0x866650), L(0x9a7454)], 0.7)
  mixColor(b.albedo, L(0x8a4a20), rust.core, 0.8)
  mixColor(b.albedo, L(0x4a2a13), rust.pits, 0.7)
  mixColor(b.albedo, L(0x9a9a99), scaled(ribs, 0.3), 0.35)

  ramp(b.rough, fine, 0.65, 0.9)
  toward(b.rough, rust.core, 0.94, 0.8)
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = saturate(0.55 - rust.core[i] * 0.45)
  b.aoStrength = 1.1
  b.aoInAlbedo = 0.4
  return b
}

// --- Wood -----------------------------------------------------------------

function buildWood(
  n: Noise,
  s: number,
  opts: { rows: number; cuts: number; base: Rgb; dark: Rgb; light: Rgb; weathered: number; ringFreq: number; salt: number },
): SurfaceBuild {
  const b = blank(s, opts.base, 0.75, 0, 2.7)
  const p = planks(s, s, n, {
    rows: opts.rows, cuts: opts.cuts, jointPx: s / 100, bevelPx: s / 220, heightJitter: 0.08, jointDepth: 0.42, salt: opts.salt,
  })
  const g = woodGrain(n, s, opts.ringFreq, 0.55, Math.max(1, Math.round(opts.rows * 0.8)), opts.salt + 1)
  const silver = n.fbmPerlin(s, s, 4, 4, 4, 0.55, opts.salt + 2)
  const splits = scratches(s, s, n, 30, 260, 8, opts.salt + 3)
  const dirt = gravityStreaks(s, s, n, {
    freq: 20, coverage: 0.35, lengthMin: 0.1, lengthMax: 0.5, startMin: 0.4, startMax: 1, salt: opts.salt + 4,
  })

  for (let i = 0; i < b.height.length; i++) {
    // Latewood is harder and stands proud once the surface weathers.
    b.height[i] = p.height[i] + (g.rings[i] - 0.5) * 0.14 * p.face[i] + (g.fibre[i] - 0.5) * 0.05 - g.knots[i] * 0.06 - splits[i] * 0.12
  }
  gradientCells(b.albedo, p.id, [opts.dark, opts.base, opts.light], 0.55)
  mixColor(b.albedo, opts.dark, g.rings, 0.62)
  mixColor(b.albedo, [opts.dark[0] * 0.55, opts.dark[1] * 0.55, opts.dark[2] * 0.6], g.knots, 0.8)
  offsetColor(b.albedo, g.fibre, 0.05)
  if (opts.weathered > 0) {
    mixColor(b.albedo, L(0x9a958b), silver, 0.45 * opts.weathered)
    mixColor(b.albedo, L(0x6b665d), scaled(splits, 0.8), 1)
  }
  const joint = field(s, s)
  for (let i = 0; i < joint.length; i++) joint[i] = 1 - p.face[i]
  mixColor(b.albedo, [opts.dark[0] * 0.4, opts.dark[1] * 0.4, opts.dark[2] * 0.45], joint, 0.8)
  mixColor(b.albedo, L(0x3c352c), dirt, 0.32)

  ramp(b.rough, g.rings, 0.6, 0.86)
  jitter(b.rough, silver, 0.12)
  toward(b.rough, joint, 0.94, 0.7)
  toward(b.rough, g.knots, 0.55, 0.6)
  b.aoStrength = 1.15
  b.aoInAlbedo = 0.4
  return b
}

function buildWoodPainted(n: Noise, s: number): SurfaceBuild {
  const b = buildWood(n, s, {
    rows: 5, cuts: 2, base: L(0x8a7458), dark: L(0x5e4c37), light: L(0xa08a68), weathered: 0.3, ringFreq: 9, salt: 201,
  })
  const exposure = convexMask(b.height, s, s, 5, 8)
  const chips = chipMask(s, s, n, { fx: 6, fy: 6, coverage: 0.38, hardness: 0.93, salt: 205, exposure, exposureWeight: 0.45 })
  const fade = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 206)
  const crackle = n.ridged(s, s, 40, 40, 3, 0.5, 207)
  const paint = colorField(s, s)
  gradientCells(paint, fade, [L(0x6f8a94), L(0x87a2ab), L(0xa8bcc2)], 1)

  const coverage = field(s, s)
  for (let i = 0; i < coverage.length; i++) coverage[i] = 1 - chips[i]
  for (let p2 = 0; p2 < coverage.length; p2++) {
    const t = coverage[p2] * (0.9 + 0.1 * fade[p2])
    const i = p2 * 3
    b.albedo[i] += (paint[i] - b.albedo[i]) * t
    b.albedo[i + 1] += (paint[i + 1] - b.albedo[i + 1]) * t
    b.albedo[i + 2] += (paint[i + 2] - b.albedo[i + 2]) * t
  }
  // The paint film lifts at the chip edge before it lets go.
  const lip = boxBlur(chips, s, s, Math.max(1, (s / 130) | 0), 1)
  for (let i = 0; i < b.height.length; i++) {
    b.height[i] += coverage[i] * 0.05 + saturate(lip[i] - chips[i]) * 0.14 - crackle[i] * 0.02 * coverage[i]
  }
  ramp(b.rough, crackle, 0.42, 0.62)
  toward(b.rough, chips, 0.85, 0.9)
  b.normalStrength = 1.7
  return b
}

// --- Soft and miscellaneous ----------------------------------------------

function buildGlass(n: Noise, s: number, dirty: number): SurfaceBuild {
  const b = blank(s, L(0xdfe6e6), 0.06, 0, 0.35)
  // Float glass is never perfectly flat; a slow ripple is what makes a window
  // read as glass rather than as a hole in the wall.
  const ripple = n.fbmPerlin(s, s, 3, 3, 3, 0.5, 211)
  const dust = grain(n, s, 40, 212, 4)
  const streak = gravityStreaks(s, s, n, {
    freq: 30, coverage: 0.55, lengthMin: 0.3, lengthMax: 1, startMin: 0.5, startMax: 1, salt: 213,
  })
  const edgeGrime = n.fbmPerlin(s, s, 4, 4, 4, 0.6, 214)
  const spots = n.worley(s, s, 30, 30, 215, 1)

  const grime = field(s, s)
  for (let i = 0; i < grime.length; i++) {
    const speck = saturate(1 - spots.f1[i] * 4) * 0.6
    grime[i] = saturate((dust[i] * 0.5 + streak[i] * 0.8 + edgeGrime[i] * 0.35 + speck) * dirty)
  }
  for (let i = 0; i < b.height.length; i++) b.height[i] = 0.5 + (ripple[i] - 0.5) * 0.5 + grime[i] * 0.08
  mixColor(b.albedo, L(0x9a9683), grime, 0.75)
  ramp(b.rough, grime, 0.05, 0.4)
  jitter(b.rough, dust, 0.03)
  b.alpha = field(s, s)
  for (let i = 0; i < b.alpha.length; i++) b.alpha[i] = saturate(0.16 + grime[i] * 0.7)
  b.aoStrength = 0.2
  b.aoInAlbedo = 0.1
  return b
}

function buildFabric(
  n: Noise,
  s: number,
  opts: { threads: number; base: Rgb; alt?: Rgb; stripes?: number; dirt: number; salt: number; sheenRough: number },
): SurfaceBuild {
  const b = blank(s, opts.base, opts.sheenRough, 0, 2.6)
  const w = weave(s, s, opts.threads, 1.2)
  const fuzz = grain(n, s, 150, opts.salt, 3)
  const sag = stretch(n.fbmPerlin(s, s, 4, 4, 3, 0.55, opts.salt + 1), 1.5)
  const creases = n.ridged(s, s, 7, 7, 4, 0.5, opts.salt + 2)
  const stain = gravityStreaks(s, s, n, {
    freq: 12, coverage: 0.4, lengthMin: 0.2, lengthMax: 0.8, startMin: 0.4, startMax: 1, salt: opts.salt + 3,
  })
  const fade = n.fbmPerlin(s, s, 3, 3, 4, 0.55, opts.salt + 4)

  for (let i = 0; i < b.height.length; i++) {
    // The weave rides on top of the slack and lumps of the filled bag rather
    // than sitting on a perfect plane.
    b.height[i] = w.height[i] * 0.4 + (sag[i] - 0.5) * 0.5 + saturate(creases[i] - 0.6) * 0.3 + fuzz[i] * 0.08
  }
  if (opts.alt && opts.stripes) {
    // Awning stripes: a band pattern that tiles exactly across the sheet.
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = ((x / s) * opts.stripes) % 1
        if (u < 0.5) continue
        const i = (y * s + x) * 3
        b.albedo[i] = opts.alt[0]
        b.albedo[i + 1] = opts.alt[1]
        b.albedo[i + 2] = opts.alt[2]
      }
    }
  }
  // Sun bleaching on the exposed crowns of the weave.
  modulateColor(b.albedo, w.height, 0.22)
  offsetColor(b.albedo, fade, 0.06)
  mixColor(b.albedo, L(0x4e4638), stain, 0.4 * opts.dirt)
  mixColor(b.albedo, L(0x8f8672), scaled(fuzz, 0.35 * opts.dirt), 1)

  ramp(b.rough, fuzz, opts.sheenRough - 0.1, opts.sheenRough + 0.14)
  jitter(b.rough, w.height, 0.12)
  toward(b.rough, stain, 0.95, 0.5)
  b.aoStrength = 1.1
  b.aoInAlbedo = 0.4
  return b
}

function buildTarp(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x2f5f8a), 0.45, 0, 3.0)
  const w = weave(s, s, 64, 1.6)
  // Ripstop grid: a heavier thread every eighth pick.
  const grid = field(s, s)
  for (let y = 0; y < s; y++) {
    const gv = Math.pow(Math.sin(((y / s) * 32) % 1 * Math.PI), 20)
    for (let x = 0; x < s; x++) {
      const gu = Math.pow(Math.sin(((x / s) * 32) % 1 * Math.PI), 20)
      grid[y * s + x] = saturate(gu + gv)
    }
  }
  const creases = n.ridged(s, s, 5, 5, 5, 0.5, 221)
  const folds = n.fbmPerlin(s, s, 3, 3, 3, 0.55, 222)
  const scuff = grain(n, s, 90, 223, 3)
  const dust = gravityStreaks(s, s, n, {
    freq: 14, coverage: 0.4, lengthMin: 0.2, lengthMax: 0.9, startMin: 0.4, startMax: 1, salt: 224,
  })

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = w.height[i] * 0.3 + grid[i] * 0.16 + (folds[i] - 0.5) * 0.4 + saturate(creases[i] - 0.55) * 0.5
  }
  gradientCells(b.albedo, folds, [L(0x274e73), L(0x33668f), L(0x4a80a8)], 0.75)
  // Creases wear pale where the coating has been flexed and abraded.
  mixColor(b.albedo, L(0x9db6c6), powField(copyField(creases), 3), 0.35)
  mixColor(b.albedo, L(0x6a6a5e), dust, 0.35)
  offsetColor(b.albedo, scuff, 0.04)

  ramp(b.rough, scuff, 0.34, 0.58)
  jitter(b.rough, w.height, 0.1)
  toward(b.rough, dust, 0.85, 0.5)
  b.aoStrength = 0.9
  b.aoInAlbedo = 0.3
  return b
}

function buildRubber(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x2b2b2c), 0.72, 0, 1.9)
  const pebble = n.worley(s, s, 60, 60, 231, 1)
  const fine = grain(n, s, 180, 232, 3)
  const bloom = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 233)
  const scuff = scratches(s, s, n, 120, 100, 6, 234)

  for (let i = 0; i < b.height.length; i++) {
    const bump = saturate(1 - pebble.f1[i] * 3)
    b.height[i] = 0.55 + bump * 0.16 + fine[i] * 0.1 - scuff[i] * 0.05
  }
  gradientCells(b.albedo, bloom, [L(0x232324), L(0x2d2d2e), L(0x3a3a39)], 0.7)
  // Antiozonant bloom: the grey chalky film that ages rubber.
  mixColor(b.albedo, L(0x6a6a66), powField(copyField(bloom), 3), 0.3)
  offsetColor(b.albedo, fine, 0.02)

  ramp(b.rough, fine, 0.62, 0.88)
  jitter(b.rough, bloom, 0.12)
  toward(b.rough, scuff, 0.55, 0.5)
  b.aoStrength = 0.9
  b.aoInAlbedo = 0.3
  return b
}

function buildFoliage(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x4e6b32), 0.7, 0, 2.1)
  const cluster = leafCluster(s, s, n, 150, [
    L(0x4a6a2c), L(0x5c7d38), L(0x3c5626), L(0x6d8a3f), L(0x7a7f33), L(0x8a7a34),
  ])
  const veins = n.fbm(s, s, 100, 100, 3, 0.5, 241)
  const dust = grain(n, s, 30, 242, 3)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = cluster.height[i] * 0.3 + cluster.shade[i] * 0.5 + veins[i] * 0.08
  }
  b.albedo.set(cluster.color)
  modulateColor(b.albedo, cluster.shade, 0.45)
  mixColor(b.albedo, L(0x7d7256), scaled(dust, 0.3), 1)
  b.alpha = cluster.alpha
  ramp(b.rough, veins, 0.55, 0.8)
  jitter(b.rough, cluster.shade, 0.15)
  b.aoStrength = 0.6
  b.aoInAlbedo = 0.35
  return b
}

function buildWater(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x1d2a2c), 0.09, 0.02, 0.95)
  const big = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 251)
  const small = n.fbmPerlin(s, s, 18, 18, 4, 0.55, 252)
  const capillary = n.fbm(s, s, 70, 70, 3, 0.5, 253)
  const scum = n.fbmPerlin(s, s, 3, 3, 4, 0.6, 254)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.5 + (big[i] - 0.5) * 0.5 + (small[i] - 0.5) * 0.3 + (capillary[i] - 0.5) * 0.12
  }
  gradientCells(b.albedo, scum, [L(0x18262a), L(0x223133), L(0x2d3a35)], 0.8)
  mixColor(b.albedo, L(0x4a5540), powField(copyField(scum), 4), 0.35)
  ramp(b.rough, capillary, 0.06, 0.16)
  jitter(b.rough, scum, 0.06)
  b.aoStrength = 0.2
  b.aoInAlbedo = 0.1
  return b
}

// --- Characters -----------------------------------------------------------

function buildSkin(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0xba8a68), 0.52, 0, 1.8)
  const pores = n.worley(s, s, 62, 62, 261, 1)
  const fine = grain(n, s, 110, 262, 3)
  const wrinkle = n.ridged(s, s, 18, 18, 4, 0.5, 263)
  const blood = stretch(n.fbmPerlin(s, s, 5, 5, 4, 0.55, 264), 1.7)
  const stubble = n.worley(s, s, 90, 90, 265, 1)
  const dirt = n.fbmPerlin(s, s, 4, 4, 4, 0.6, 266)

  for (let i = 0; i < b.height.length; i++) {
    const pore = saturate(1 - pores.f1[i] * 3)
    b.height[i] = 0.62 - pore * 0.3 + fine[i] * 0.1 - saturate(wrinkle[i] - 0.55) * 0.4
  }
  // Circulation gives skin its blotchy warmth; a single flesh tone reads as vinyl.
  gradientCells(b.albedo, blood, [L(0x9d6e50), L(0xbd8c69), L(0xcda07e)], 0.9)
  mixColor(b.albedo, L(0xa8574a), powField(copyField(blood), 2), 0.34)
  const shadowBeard = field(s, s)
  for (let i = 0; i < shadowBeard.length; i++) shadowBeard[i] = saturate(1 - stubble.f1[i] * 3) * 0.5
  mixColor(b.albedo, L(0x53412f), shadowBeard, 0.4)
  mixColor(b.albedo, L(0x6b5a45), powField(copyField(dirt), 3), 0.35)

  // Oily on the high points, matte in the creases — the roughness signature
  // that stops CG skin looking like plastic.
  ramp(b.rough, fine, 0.42, 0.62)
  jitter(b.rough, blood, 0.08)
  toward(b.rough, shadowBeard, 0.7, 0.5)
  b.aoStrength = 0.75
  b.aoInAlbedo = 0.3
  return b
}

function buildCamo(
  n: Noise,
  s: number,
  opts: { threads: number; palette: readonly Rgb[]; blotchFreq: number; rough: number; salt: number },
): SurfaceBuild {
  const b = blank(s, opts.palette[1], opts.rough, 0, 2.1)
  const w = weave(s, s, opts.threads, 1.3)
  const big = n.fbmPerlin(s, s, opts.blotchFreq, opts.blotchFreq, 4, 0.6, opts.salt)
  const mid = n.fbmPerlin(s, s, opts.blotchFreq * 2, opts.blotchFreq * 2, 4, 0.6, opts.salt + 1)
  const small = n.fbmPerlin(s, s, opts.blotchFreq * 5, opts.blotchFreq * 5, 3, 0.55, opts.salt + 2)
  const fuzz = grain(n, s, 170, opts.salt + 3, 3)
  const dust = n.fbmPerlin(s, s, 3, 3, 4, 0.6, opts.salt + 4)
  const wearField = n.fbmPerlin(s, s, 6, 6, 4, 0.6, opts.salt + 5)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = w.height[i] * 0.6 + fuzz[i] * 0.12 + (dust[i] - 0.5) * 0.16
  }

  // Layered blotches, each thresholded hard, is how real camouflage is printed.
  const layers = opts.palette.length
  const t1 = quantile(big, 0.55)
  const t2 = quantile(mid, 0.68)
  const t3 = quantile(small, 0.78)
  for (let p = 0; p < w.height.length; p++) {
    let idx = 0
    if (big[p] > t1) idx = 1
    if (mid[p] > t2) idx = Math.min(layers - 1, 2)
    if (small[p] > t3) idx = Math.min(layers - 1, 3)
    if (big[p] > t1 && mid[p] > t2 && small[p] > t3) idx = layers - 1
    const c = opts.palette[Math.min(layers - 1, idx)]
    const i = p * 3
    b.albedo[i] = c[0]
    b.albedo[i + 1] = c[1]
    b.albedo[i + 2] = c[2]
  }
  modulateColor(b.albedo, w.height, 0.25)
  offsetColor(b.albedo, fuzz, 0.035)
  // Sun-faded on the crowns, dusty in the low-lying weave.
  mixColor(b.albedo, L(0x9c9078), powField(copyField(dust), 2), 0.3)
  mixColor(b.albedo, L(0xc6bca6), powField(copyField(wearField), 4), 0.18)

  ramp(b.rough, fuzz, opts.rough - 0.08, opts.rough + 0.12)
  jitter(b.rough, w.height, 0.1)
  b.aoStrength = 1
  b.aoInAlbedo = 0.4
  return b
}

function buildWebbing(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x565241), 0.72, 0, 3.2)
  const w = weave(s, s, 32, 1.6)
  // Woven nylon tape: heavy ribs along the strap plus a tight cross weave.
  const ribs = field(s, s)
  for (let y = 0; y < s; y++) {
    const v = Math.pow(Math.sin(((y / s) * 8) % 1 * Math.PI), 1.5)
    for (let x = 0; x < s; x++) ribs[y * s + x] = v
  }
  const fuzz = grain(n, s, 160, 271, 3)
  const dust = n.fbmPerlin(s, s, 3, 3, 4, 0.6, 272)
  const abrasion = scratches(s, s, n, 60, 200, 6, 273)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = w.height[i] * 0.45 + ribs[i] * 0.4 + fuzz[i] * 0.1
  }
  gradientCells(b.albedo, dust, [L(0x474433), L(0x585441), L(0x6b6650)], 0.8)
  modulateColor(b.albedo, w.height, 0.25)
  mixColor(b.albedo, L(0x8d8571), abrasion, 0.35)
  offsetColor(b.albedo, fuzz, 0.03)

  ramp(b.rough, fuzz, 0.66, 0.86)
  jitter(b.rough, w.height, 0.1)
  b.aoStrength = 1.05
  b.aoInAlbedo = 0.4
  return b
}

function buildHelmet(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x5f5c46), 0.62, 0, 1.9)
  const cloth = weave(s, s, 64, 1.4)
  const camo = n.fbmPerlin(s, s, 5, 5, 4, 0.6, 281)
  const camo2 = n.fbmPerlin(s, s, 11, 11, 4, 0.6, 282)
  const scuff = scratches(s, s, n, 80, 140, 6, 283)
  const dust = n.fbmPerlin(s, s, 3, 3, 4, 0.6, 284)
  const fuzz = grain(n, s, 150, 285, 3)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = cloth.height[i] * 0.4 + fuzz[i] * 0.14 + (dust[i] - 0.5) * 0.12 - scuff[i] * 0.05
  }
  const t1 = quantile(camo, 0.55)
  const t2 = quantile(camo2, 0.7)
  const palette: Rgb[] = [L(0x6b6650), L(0x53553c), L(0x40402f), L(0x7d7458)]
  for (let p = 0; p < camo.length; p++) {
    let idx = 0
    if (camo[p] > t1) idx = 1
    if (camo2[p] > t2) idx = 2
    if (camo[p] > t1 && camo2[p] > t2) idx = 3
    const c = palette[idx]
    const i = p * 3
    b.albedo[i] = c[0]
    b.albedo[i + 1] = c[1]
    b.albedo[i + 2] = c[2]
  }
  modulateColor(b.albedo, cloth.height, 0.2)
  mixColor(b.albedo, L(0x9d937a), powField(copyField(dust), 2), 0.3)
  mixColor(b.albedo, L(0x8e8a76), scuff, 0.3)

  ramp(b.rough, fuzz, 0.56, 0.76)
  jitter(b.rough, dust, 0.08)
  b.aoStrength = 0.9
  b.aoInAlbedo = 0.35
  return b
}

function buildBootLeather(n: Noise, s: number): SurfaceBuild {
  const b = blank(s, L(0x4b3a2b), 0.55, 0, 2.5)
  const cells = n.worley(s, s, 70, 70, 291, 1)
  const creases = n.ridged(s, s, 9, 9, 4, 0.5, 292)
  const fine = grain(n, s, 180, 293, 3)
  const scuff = chipMask(s, s, n, { fx: 8, fy: 8, coverage: 0.28, hardness: 0.6, salt: 294 })
  const dust = n.fbmPerlin(s, s, 4, 4, 4, 0.6, 295)

  for (let i = 0; i < b.height.length; i++) {
    const pebbleGrain = saturate(1 - cells.f1[i] * 2.8)
    b.height[i] = 0.55 + pebbleGrain * 0.16 + fine[i] * 0.08 - saturate(creases[i] - 0.55) * 0.35
  }
  gradientCells(b.albedo, cells.id, [L(0x3f3023), L(0x4e3c2c), L(0x5c4732)], 0.75)
  // Scuffed leather goes pale and matte where the finish has been abraded off.
  mixColor(b.albedo, L(0x7a6247), scuff, 0.4)
  mixColor(b.albedo, L(0x8d7c63), powField(copyField(dust), 3), 0.4)
  offsetColor(b.albedo, fine, 0.03)

  ramp(b.rough, fine, 0.44, 0.66)
  toward(b.rough, scuff, 0.82, 0.7)
  jitter(b.rough, dust, 0.1)
  b.aoStrength = 1
  b.aoInAlbedo = 0.35
  return b
}

// --- The table ------------------------------------------------------------

const GROUND_DUST = new THREE.Color(0.21, 0.18, 0.13)
const WALL_DUST = new THREE.Color(0.24, 0.21, 0.16)
const SAND_DUST = new THREE.Color(0.42, 0.34, 0.22)

const HERO = 512
const STD = 256
const SMALL = 128

export const RECIPES: Record<MaterialName, MaterialSpec> = {
  // --- Ground -----------------------------------------------------------
  asphalt: {
    size: HERO, worldSize: 3, build: (n, s) => buildAsphalt(n, s, false),
    triplanar: { macroScale: 0.045, macroAlbedo: 0.2, macroRough: 0.16, dustColor: SAND_DUST, dustAmount: 0.22 },
    normalScale: 0.9, aoIntensity: 1,
  },
  asphaltCracked: {
    size: STD, worldSize: 3, build: (n, s) => buildAsphalt(n, s, true),
    triplanar: { macroScale: 0.05, macroAlbedo: 0.22, macroRough: 0.16, dustColor: SAND_DUST, dustAmount: 0.26 },
    normalScale: 1.1, aoIntensity: 1,
  },
  concrete: {
    size: HERO, worldSize: 2.5, build: (n, s) => buildConcrete(n, s, 0),
    triplanar: { macroScale: 0.05, macroAlbedo: 0.17, macroRough: 0.15, dustColor: WALL_DUST, dustAmount: 0.2 },
    normalScale: 0.8, aoIntensity: 1,
  },
  concreteWorn: {
    size: HERO, worldSize: 2.5, build: (n, s) => buildConcrete(n, s, 1),
    triplanar: { macroScale: 0.05, macroAlbedo: 0.2, macroRough: 0.17, dustColor: WALL_DUST, dustAmount: 0.28 },
    normalScale: 1.0, aoIntensity: 1,
  },
  concreteRubble: {
    size: STD, worldSize: 2, build: buildConcreteRubble,
    triplanar: { macroScale: 0.06, macroAlbedo: 0.2, macroRough: 0.14, dustColor: SAND_DUST, dustAmount: 0.4 },
    normalScale: 1.2, aoIntensity: 1,
  },
  sand: {
    size: HERO, worldSize: 4, build: buildSand,
    triplanar: { macroScale: 0.035, macroAlbedo: 0.16, macroRough: 0.1, dustColor: SAND_DUST, dustAmount: 0.15 },
    normalScale: 0.8, aoIntensity: 0.8,
  },
  dirt: {
    size: STD, worldSize: 3.5, build: buildDirt,
    triplanar: { macroScale: 0.05, macroAlbedo: 0.2, macroRough: 0.14, dustColor: SAND_DUST, dustAmount: 0.25 },
    normalScale: 1.0, aoIntensity: 1,
  },
  gravel: {
    size: HERO, worldSize: 3, build: buildGravel,
    triplanar: { macroScale: 0.055, macroAlbedo: 0.18, macroRough: 0.12, dustColor: SAND_DUST, dustAmount: 0.3 },
    normalScale: 1.1, aoIntensity: 1,
  },
  cobblestone: {
    size: STD, worldSize: 2, build: buildCobblestone,
    triplanar: { macroScale: 0.05, macroAlbedo: 0.18, macroRough: 0.16, dustColor: SAND_DUST, dustAmount: 0.22 },
    normalScale: 1.1, aoIntensity: 1,
  },

  // --- Walls ------------------------------------------------------------
  plasterWhite: {
    size: HERO, worldSize: 2.5, build: (n, s) => buildPlaster(n, s, L(0xbfb9a9), 0, L(0x8a5342)),
    triplanar: { macroScale: 0.05, macroAlbedo: 0.14, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.16 },
    normalScale: 0.8, aoIntensity: 1,
  },
  plasterOchre: {
    size: HERO, worldSize: 2.5, build: (n, s) => buildPlaster(n, s, L(0xbb914f), 0.35, L(0x8a5342)),
    triplanar: { macroScale: 0.05, macroAlbedo: 0.16, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.18 },
    normalScale: 0.95, aoIntensity: 1,
  },
  plasterDamaged: {
    size: STD, worldSize: 2.5, build: (n, s) => buildPlaster(n, s, L(0xb2ab99), 1, L(0x8a5342)),
    triplanar: { macroScale: 0.055, macroAlbedo: 0.18, macroRough: 0.16, dustColor: WALL_DUST, dustAmount: 0.24 },
    normalScale: 1.2, aoIntensity: 1,
  },
  brickRed: {
    size: HERO, worldSize: 0.9, build: (n, s) => buildBrick(n, s, false),
    triplanar: { macroScale: 0.06, macroAlbedo: 0.16, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.18, sharpness: 8 },
    normalScale: 1.0, aoIntensity: 1,
  },
  brickPainted: {
    size: STD, worldSize: 0.9, build: (n, s) => buildBrick(n, s, true),
    triplanar: { macroScale: 0.06, macroAlbedo: 0.14, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.18, sharpness: 8 },
    normalScale: 0.9, aoIntensity: 1,
  },
  stuccoTan: {
    size: STD, worldSize: 2, build: buildStucco,
    triplanar: { macroScale: 0.05, macroAlbedo: 0.16, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.2 },
    normalScale: 1.1, aoIntensity: 1,
  },
  stoneBlock: {
    size: STD, worldSize: 2, build: buildStoneBlock,
    triplanar: { macroScale: 0.045, macroAlbedo: 0.16, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.2, sharpness: 8 },
    normalScale: 1.1, aoIntensity: 1,
  },
  tileRoof: {
    size: STD, worldSize: 1.3, build: buildTileRoof,
    triplanar: { macroScale: 0.07, macroAlbedo: 0.18, macroRough: 0.14, dustColor: SAND_DUST, dustAmount: 0.3, sharpness: 4 },
    normalScale: 1.2, aoIntensity: 1,
  },
  tileFloor: {
    size: STD, worldSize: 1.2, build: buildTileFloor,
    triplanar: { macroScale: 0.07, macroAlbedo: 0.12, macroRough: 0.18, dustColor: WALL_DUST, dustAmount: 0.18, sharpness: 8 },
    normalScale: 0.8, aoIntensity: 1,
  },

  // --- Metal ------------------------------------------------------------
  metalPainted: {
    size: STD, worldSize: 1.6, build: buildMetalPainted,
    triplanar: { macroScale: 0.09, macroAlbedo: 0.12, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.2, sharpness: 8 },
    normalScale: 0.9, aoIntensity: 1,
  },
  metalRusted: {
    size: STD, worldSize: 1.6, build: buildMetalRusted,
    triplanar: { macroScale: 0.09, macroAlbedo: 0.16, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.2, sharpness: 8 },
    normalScale: 1.0, aoIntensity: 1,
  },
  metalCorrugated: {
    size: STD, worldSize: 1, build: buildCorrugated,
    triplanar: { macroScale: 0.08, macroAlbedo: 0.12, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.22, sharpness: 8 },
    normalScale: 1.0, aoIntensity: 1,
  },
  steelBrushed: {
    size: STD, worldSize: 1, build: buildSteelBrushed, triplanar: null, repeat: [2, 2],
    normalScale: 0.5, aoIntensity: 0.6,
    params: { envMapIntensity: 1.15 },
  },
  gunmetal: {
    size: STD, worldSize: 0.35, build: buildGunmetal, triplanar: null, repeat: [3, 3],
    normalScale: 0.7, aoIntensity: 0.8,
    params: { envMapIntensity: 1.0 },
  },
  chainlink: {
    size: STD, worldSize: 0.4, build: buildChainlink,
    triplanar: { macroScale: 0.12, macroAlbedo: 0.1, macroRough: 0.1, dustColor: WALL_DUST, dustAmount: 0.12, sharpness: 8 },
    repeat: [8, 8],
    normalScale: 0.9, aoIntensity: 0.7,
    params: { alphaTest: 0.5, side: THREE.DoubleSide },
  },
  rebar: {
    size: SMALL, worldSize: 0.25, build: buildRebar, triplanar: null, repeat: [1, 3],
    normalScale: 1.0, aoIntensity: 1,
  },

  // --- Wood -------------------------------------------------------------
  woodPlank: {
    size: STD, worldSize: 1.2,
    build: (n, s) => buildWood(n, s, {
      rows: 5, cuts: 2, base: L(0x8a7458), dark: L(0x5a4833), light: L(0xa08a68), weathered: 1, ringFreq: 11, salt: 301,
    }),
    triplanar: { macroScale: 0.07, macroAlbedo: 0.16, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.22, sharpness: 8 },
    normalScale: 1.0, aoIntensity: 1,
  },
  woodPainted: {
    size: STD, worldSize: 1.2, build: buildWoodPainted, triplanar: null, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 1,
  },
  woodCrate: {
    size: STD, worldSize: 0.9,
    build: (n, s) => buildWood(n, s, {
      rows: 4, cuts: 2, base: L(0xa8875c), dark: L(0x74593a), light: L(0xc0a072), weathered: 0.45, ringFreq: 8, salt: 311,
    }),
    triplanar: null, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 1,
  },
  woodBeam: {
    size: STD, worldSize: 1.6,
    build: (n, s) => buildWood(n, s, {
      rows: 2, cuts: 0, base: L(0x6d5638), dark: L(0x453522), light: L(0x8a6f4a), weathered: 0.7, ringFreq: 6, salt: 321,
    }),
    triplanar: { macroScale: 0.08, macroAlbedo: 0.16, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.2, sharpness: 8 },
    normalScale: 1.1, aoIntensity: 1,
  },

  // --- Soft / misc ------------------------------------------------------
  glass: {
    size: SMALL, worldSize: 2, build: (n, s) => buildGlass(n, s, 0.25), triplanar: null, repeat: [1, 1],
    physical: true, normalScale: 0.25, aoIntensity: 0.2,
    params: {
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
      envMapIntensity: 1.6, ior: 1.52, specularIntensity: 1,
    },
  },
  glassDirty: {
    size: STD, worldSize: 2, build: (n, s) => buildGlass(n, s, 1), triplanar: null, repeat: [1, 1],
    physical: true, normalScale: 0.4, aoIntensity: 0.3,
    params: {
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
      envMapIntensity: 1.25, ior: 1.52, specularIntensity: 0.85,
    },
  },
  fabricAwning: {
    size: STD, worldSize: 1.5,
    build: (n, s) => buildFabric(n, s, {
      threads: 64, base: L(0x9e4038), alt: L(0xc6bda9), stripes: 4, dirt: 1.6, salt: 331, sheenRough: 0.72,
    }),
    triplanar: null, repeat: [1, 1], physical: true,
    normalScale: 1.0, aoIntensity: 1,
    params: { side: THREE.DoubleSide, sheen: 0.35, sheenRoughness: 0.75, sheenColor: new THREE.Color(0.5, 0.44, 0.38) },
  },
  sandbag: {
    size: STD, worldSize: 0.5,
    build: (n, s) => buildFabric(n, s, {
      threads: 32, base: L(0x9b8763), dirt: 1.3, salt: 341, sheenRough: 0.86,
    }),
    triplanar: null, repeat: [1, 1], physical: true,
    normalScale: 1.4, aoIntensity: 1,
    params: { sheen: 0.25, sheenRoughness: 0.9, sheenColor: new THREE.Color(0.45, 0.4, 0.32) },
  },
  tarp: {
    size: STD, worldSize: 1.5, build: buildTarp, triplanar: null, repeat: [1, 1], physical: true,
    normalScale: 1.1, aoIntensity: 1,
    params: { side: THREE.DoubleSide, sheen: 0.2, sheenRoughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.55 },
  },
  rubber: {
    size: STD, worldSize: 0.6, build: buildRubber, triplanar: null, repeat: [1, 1],
    normalScale: 0.9, aoIntensity: 0.9,
  },
  foliage: {
    size: STD, worldSize: 1, build: buildFoliage, triplanar: null, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 0.7,
    params: { alphaTest: 0.42, side: THREE.DoubleSide },
  },
  water: {
    size: STD, worldSize: 6, build: buildWater, triplanar: null, repeat: [3, 3], physical: true,
    normalScale: 0.45, aoIntensity: 0.2,
    params: { envMapIntensity: 1.5, transparent: true, opacity: 0.92, ior: 1.33 },
  },

  // --- Characters -------------------------------------------------------
  skin: {
    size: STD, worldSize: 0.5, build: buildSkin, triplanar: null, repeat: [1, 1], physical: true,
    normalScale: 0.6, aoIntensity: 0.7,
    params: { clearcoat: 0.12, clearcoatRoughness: 0.45, sheen: 0.12, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.5, 0.25, 0.2) },
  },
  uniform: {
    size: STD, worldSize: 0.8,
    build: (n, s) => buildCamo(n, s, {
      threads: 64,
      palette: [L(0xa08a66), L(0x7b7450), L(0x5f5a3e), L(0x6a5238), L(0x40402c)],
      blotchFreq: 5, rough: 0.78, salt: 351,
    }),
    triplanar: null, repeat: [2, 2], physical: true,
    normalScale: 1.0, aoIntensity: 1,
    params: { sheen: 0.2, sheenRoughness: 0.85, sheenColor: new THREE.Color(0.4, 0.37, 0.3) },
  },
  webbing: {
    size: STD, worldSize: 0.35, build: buildWebbing, triplanar: null, repeat: [2, 2], physical: true,
    normalScale: 1.2, aoIntensity: 1,
    params: { sheen: 0.18, sheenRoughness: 0.8, sheenColor: new THREE.Color(0.36, 0.34, 0.28) },
  },
  helmet: {
    size: STD, worldSize: 0.4, build: buildHelmet, triplanar: null, repeat: [1, 1],
    normalScale: 0.9, aoIntensity: 1,
  },
  bootLeather: {
    size: STD, worldSize: 0.35, build: buildBootLeather, triplanar: null, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 1,
  },
}
