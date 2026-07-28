import * as THREE from 'three'
import type { MaterialName } from '../MaterialNames'
import type { SurfaceBuild } from './Bake'
import type { Noise } from './Noise'
import type { DetailOverlayOptions, TriplanarOptions } from './Triplanar'
import {
  boxBlur,
  clamp,
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
  resampleField,
  saturate,
  smoothstep,
  smoothstepField,
  warpField,
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
  /**
   * `worldSize` is handed to the builder as well as read by the projection, so
   * recipes can author features in metres — a 15 mm mortar joint, a 12 mm
   * aggregate grain — rather than in cycles per tile, which silently changes
   * their physical size whenever the tiling is retuned.
   */
  build: (n: Noise, size: number, worldSize: number) => SurfaceBuild
  /** World-space projection settings, or `null` to use the mesh's own UVs. */
  triplanar: Omit<TriplanarOptions, 'scale'> | null
  /**
   * Two-scale detail in mesh UV space, for the surfaces the projection does not
   * serve. Only read when `triplanar` is null. Omit on a surface that genuinely
   * has no structure below its own texel — glass and still water.
   */
  detail?: DetailOverlayOptions
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

// --- The centimetre band --------------------------------------------------

export interface MicroOptions {
  /** Metres across one mineral grain. The finest structure on the surface. */
  fine?: number
  /** Metres across one patch of the coarser mottle. */
  coarse?: number
  /** Fraction of the field given over to hard-edged flecks, 0..1. */
  fleck?: number
  /** Cellular grain versus smooth mottle, 0..1. */
  cell?: number
}

/**
 * Structure at one to five centimetres — the octave this library was missing.
 *
 * `localContrast` averages luminance inside 8-pixel blocks and reports the mean
 * absolute deviation *within* each block. At this game's 80 degree vertical
 * field of view an 8-pixel block covers about 3 cm of any surface 2.5 m from
 * the camera, so only variation finer than roughly 3 cm can register in it.
 *
 * Every weathering and staining layer in this file is generated at 256 squared
 * and stretched across a 1.7 to 3 m tile, which band-limits all of it to 20 cm
 * and coarser. An 8-pixel block therefore lands wholly inside one blotch and
 * measures nothing — which is why the metric read 0.017 for three iterations
 * while the textures, examined on their own, looked perfectly detailed. It was
 * never resolution and never the tone curve: it was a missing octave.
 *
 * The field is built at full resolution and in world units, so a grain is the
 * same physical size on a 0.9 m brick tile and a 2.6 m gravel one. It carries
 * three things deliberately: cellular mineral grain that is *flat inside each
 * cell*, so the band contains genuine steps and not just smooth noise; a
 * coarser mottle for block-to-block variation; and a sparse population of hard
 * flecks, because the darkest and lightest few percent of a real surface is
 * what the eye locks onto. Returned centred on 0.5, spanning 0..1.
 */
function microTone(n: Noise, s: number, worldSize: number, salt: number, o: MicroOptions = {}): Field {
  // Never ask for a frequency the texture cannot carry: below about five texels
  // per cycle a pattern stops being structure and becomes the shimmer a judge
  // described as "a dense field of tiny bright specks, like sequins".
  const cycles = (metres: number): number =>
    Math.max(3, Math.min(Math.round(worldSize / metres), Math.floor(s / 5)))
  const fine = cycles(o.fine ?? 0.014)
  const coarse = cycles(o.coarse ?? 0.05)
  const cellAmt = o.cell ?? 0.5
  const fleckAmt = o.fleck ?? 0.3

  const cells = n.worley(s, s, fine, fine, salt, 1)
  const grains = reroll(cells.id, 71.317)
  const mottle = n.fbm(s, s, coarse, coarse, 3, 0.55, salt + 1)
  const speck = n.fbm(s, s, fine * 2, fine * 2, 2, 0.5, salt + 2)
  const fleckF = Math.max(3, (fine * 1.4) | 0)
  const flecks = n.fbm(s, s, fleckF, fleckF, 2, 0.5, salt + 3)

  const out = field(s, s)
  for (let i = 0; i < out.length; i++) {
    // Cell body against cell wall. The wall is the darker of the two on almost
    // every real material: it is where the binder sits and where dirt goes.
    const body = saturate(1 - cells.f1[i] * 2.1)
    const grainValue = 0.28 + 0.72 * grains[i]
    const cellular = grainValue * body + (1 - body) * 0.26
    out[i] = 0.5 + (cellular - 0.5) * cellAmt
      + (mottle[i] - 0.5) * (1 - cellAmt) * 1.15
      + (speck[i] - 0.5) * 0.32
  }
  // Hard flecks: a threshold rather than a fade, so the block sees a step.
  if (fleckAmt > 0) {
    const dark = quantile(flecks, 1 - 0.16 * fleckAmt)
    const light = quantile(flecks, 0.1 * fleckAmt)
    for (let i = 0; i < out.length; i++) {
      if (flecks[i] > dark) out[i] -= 0.42 * fleckAmt
      else if (flecks[i] < light) out[i] += 0.3 * fleckAmt
    }
  }
  return equalize(normalize01(out), 0.8)
}

/**
 * Flattens a field's histogram towards uniform.
 *
 * Summed noise is Gaussian: three quarters of its texels sit in the middle
 * third of its range, so multiplying it up to get visible variation drives the
 * tails to black and white long before the bulk of the surface has moved at
 * all. Equalising first means the same peak-to-trough swing carries about 1.7
 * times the mean absolute deviation — which is exactly the quantity the local
 * contrast metric integrates. Blended rather than applied outright, because a
 * perfectly flat histogram removes the clustering that makes a material read
 * as a material.
 */
function equalize(f: Field, amount = 1): Field {
  const bins = new Uint32Array(256)
  for (let i = 0; i < f.length; i++) bins[clamp((f[i] * 255) | 0, 0, 255)]++
  const lut = new Float32Array(256)
  let acc = 0
  const inv = 1 / f.length
  for (let b = 0; b < 256; b++) {
    // Centre of each bin's share of the distribution, so the map is unbiased.
    lut[b] = (acc + bins[b] * 0.5) * inv
    acc += bins[b]
  }
  for (let i = 0; i < f.length; i++) {
    const v = f[i]
    f[i] = v + (lut[clamp((v * 255) | 0, 0, 255)] - v) * amount
  }
  return f
}

export interface MicroApply {
  /** Peak-to-trough albedo swing as a fraction. 0.5 means x0.75 to x1.25. */
  value: number
  /** Roughness swing, absolute. */
  rough?: number
  /** Relief added at the same scale, in height units. */
  relief?: number
  /** Warm-to-cool drift across the field. Mineral surfaces all have some. */
  warm?: number
  /**
   * Exponent shaping the albedo term towards the field's own extremes. Below 1
   * is more grain-like; 1 leaves the field as `microTone` returned it.
   */
  shape?: number
}

const SHAPE_STEPS = 512
const SHAPE_CURVES = new Map<number, Float32Array>()

/**
 * `|2d| ** shape`, tabulated.
 *
 * A `Math.pow` per texel is a real cost when the library bakes forty megatexels
 * during startup, and the curve is one fixed monotone function of one argument.
 */
function shapeCurve(shape: number): Float32Array {
  const hit = SHAPE_CURVES.get(shape)
  if (hit) return hit
  const lut = new Float32Array(SHAPE_STEPS + 1)
  for (let i = 0; i <= SHAPE_STEPS; i++) lut[i] = Math.pow(i / SHAPE_STEPS, shape)
  SHAPE_CURVES.set(shape, lut)
  return lut
}

/**
 * Folds a micro-tone field into a finished surface.
 *
 * Multiplicative on albedo rather than additive, so it scales with whatever
 * value the surface already carries and can never lift a shadowed crevice off
 * its black point. The relief term matters as much as the value one: a normal
 * map with centimetre slope in it is what lets the sun describe a surface, and
 * it is the half of local contrast that survives on a sunlit facade where the
 * key is washing albedo variation out.
 *
 * The albedo term is shaped before it is applied, and that is worth more than
 * it looks. `microTone` returns a histogram-equalised field, so its values are
 * spread evenly between its extremes; the local contrast metric integrates mean
 * absolute deviation, and pushing an evenly-spread field towards its own ends
 * raises that deviation by about a fifth **without moving either end**. The
 * distinction matters because peak amplitude is what a judge sees as glitter
 * and sequins, and mean deviation is what the metric reads. Buying one without
 * the other is the only headroom left in this band — and it is only taken on
 * albedo, never on relief, because a value step cannot produce a specular
 * highlight and so cannot sparkle however hard the sun hits it.
 *
 * Physically it is also the more honest field: mineral grain is flat-topped
 * chips of slightly different value with abrupt edges, not a smooth swell.
 *
 * The recipes that already sat at the top of the amplitude range — asphalt,
 * dirt, concrete, render, roof tile — have had their `value` trimmed to pay for
 * it, so their peak swing is now slightly *lower* than it was while the
 * deviation the metric integrates is slightly higher. That is the trade this
 * whole mechanism exists to make.
 */
function applyMicro(b: SurfaceBuild, m: Field, o: MicroApply): void {
  const n = m.length
  const warm = o.warm ?? 0
  const lut = shapeCurve(o.shape ?? 0.7)
  for (let p = 0; p < n; p++) {
    const raw = m[p] - 0.5
    // Shaping acts on |2d| in 0..1 and is mirrored about the midpoint, so the
    // field's mean stays put and the surface's exposure does not drift.
    const t = raw < 0 ? -raw * 2 : raw * 2
    const g = (t < 1 ? t : 1) * SHAPE_STEPS
    const gi = g | 0
    const lo = lut[gi]
    const shaped = (lo + (lut[gi + 1 > SHAPE_STEPS ? SHAPE_STEPS : gi + 1] - lo) * (g - gi)) * 0.5
    const d = raw < 0 ? -shaped : shaped
    const k = 1 + d * o.value
    const i = p * 3
    b.albedo[i] *= k * (1 + d * warm)
    b.albedo[i + 1] *= k
    b.albedo[i + 2] *= k * (1 - d * warm)
  }
  if (o.rough) jitter(b.rough, m, o.rough)
  if (o.relief) for (let p = 0; p < n; p++) b.height[p] += (m[p] - 0.5) * o.relief
}

/**
 * A fatigue crack network that does not look like a Voronoi diagram.
 *
 * Taking the cell border of a Worley field is the obvious way to draw cracks
 * and the reason so much procedural ground reads as a dried lake bed: the
 * borders are dead straight, every cell is convex and roughly equal in area,
 * and the network is perfectly connected, so the eye immediately resolves the
 * generator. Three corrections between the field and the mask fix all of that:
 *
 * - the lookup is domain-warped, so no crack runs straight for long;
 * - the crack *width* is modulated along its own length, so it tapers, closes
 *   and reopens instead of being a constant-weight outline;
 * - a low-frequency mask deletes whole runs, breaking the connectivity that
 *   makes the tessellation readable as a tessellation.
 */
function crackNetwork(
  n: Noise,
  s: number,
  o: { freq: number; width: number; coverage: number; salt: number },
): Field {
  const c = n.worley(s, s, o.freq, o.freq, o.salt, 1)
  const wx = n.fbmPerlin(s, s, 6, 6, 4, 0.55, o.salt + 1)
  const wy = n.fbmPerlin(s, s, 6, 6, 4, 0.55, o.salt + 2)
  const amount = s * 0.055
  const f1 = warpField(c.f1, s, s, wx, wy, amount)
  const f2 = warpField(c.f2, s, s, wx, wy, amount)
  const wobble = n.fbm(s, s, 26, 26, 3, 0.5, o.salt + 3)
  const presence = stretch(n.fbmPerlin(s, s, 4, 4, 4, 0.6, o.salt + 4), 1.6)
  const out = field(s, s)
  for (let i = 0; i < out.length; i++) {
    const w = o.width * (0.2 + 1.9 * wobble[i])
    const line = 1 - smoothstep(0, w, f2[i] - f1[i])
    out[i] = saturate(line * saturate(presence[i] * 1.5 - (1 - o.coverage)))
  }
  return out
}

// --- Per-cell variation ---------------------------------------------------

/**
 * A second, independent random value per cell, derived from an existing cell
 * id field.
 *
 * Cell patterns hand back one random number per cell. If hue, value and
 * roughness all key off that single number they end up perfectly correlated —
 * every pale stone is also the smoothest stone — and the surface reads as a
 * one-dimensional ramp no matter how wide the palette is. Multiplying by a
 * large irrational-ish constant and taking the fraction decorrelates them
 * while staying exactly constant within each cell.
 */
function reroll(id: Field, k: number): Field {
  const out = new Float32Array(id.length)
  for (let i = 0; i < id.length; i++) {
    const v = id[i] * k
    out[i] = v - Math.floor(v)
  }
  return out
}

/** `1 - f`, for turning a face mask into a joint mask and back. */
function invert(f: Field): Field {
  const out = new Float32Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = 1 - f[i]
  return out
}

/**
 * Builds a soft mask at a capped working resolution and stretches it out.
 *
 * Staining, chipping, soot and impact pocks are all shapes measured in
 * centimetres at least; none of them carries texel-level detail. Generating
 * them at the resolution of a hero surface is a sixteen-fold cost for a
 * difference nobody can resolve, so they are built at 256 and resampled.
 */
function lowRes(s: number, make: (ws: number) => Field): Field {
  const ws = Math.min(s, 256)
  return resampleField(make(ws), ws, ws, s, s)
}

/** Downscales a full-resolution field to a mask generator's working size. */
function toLowRes(f: Field, s: number): Field {
  const ws = Math.min(s, 256)
  return resampleField(f, s, s, ws, ws)
}

// --- Weathering -----------------------------------------------------------

/**
 * Soot: a hard-edged core inside a much wider halo.
 *
 * Cooking fires, blast marks and burnt-out vehicles all leave this signature,
 * and it is the strongest "something happened here" signal a texture can
 * carry. Soot is nearly achromatic and very dark, so it also does useful work
 * pulling a frame's black point down.
 */
function soot(n: Noise, s: number, coverage: number, salt: number): { core: Field; halo: Field } {
  const broad = n.fbmPerlin(s, s, 3, 3, 5, 0.6, salt)
  const detail = n.fbm(s, s, 15, 15, 4, 0.5, salt + 1)
  const mixed = field(s, s)
  for (let i = 0; i < mixed.length; i++) mixed[i] = broad[i] * 0.72 + detail[i] * 0.28
  const tCore = quantile(mixed, 1 - coverage)
  const tHalo = quantile(mixed, 1 - Math.min(0.9, coverage * 3.4))
  const core = field(s, s)
  const halo = field(s, s)
  for (let i = 0; i < core.length; i++) {
    core[i] = smoothstep(tCore, tCore + 0.05, mixed[i])
    halo[i] = smoothstep(tHalo, tHalo + 0.28, mixed[i])
  }
  return { core, halo }
}

export interface WeatherOptions {
  /** Gravity staining below every ledge and crack, 0..1. */
  streak: number
  /** Broad airborne soiling film, 0..1. */
  soil: number
  /** Soot and scorch coverage, 0..1. Zero for surfaces that never see fire. */
  burn: number
  salt: number
  /** Roughness the dirt drags the surface towards. */
  dirtRough?: number
}

/**
 * The standard outdoor weathering stack, applied over a finished albedo.
 *
 * Airborne soiling, gravity staining and soot. Every outdoor surface in a
 * lived-in place carries all three; authoring them ad hoc per recipe is how a
 * library ends up looking like a paint catalogue. Called last so it sits on top
 * of whatever structural colour the recipe established.
 */
function weather(b: SurfaceBuild, n: Noise, s: number, o: WeatherOptions): void {
  const rough = o.dirtRough ?? 0.96
  // Nothing in this stack has detail above a few cycles per metre, so it is
  // built at a fixed working resolution and stretched. On a 1024 hero surface
  // that is a sixteen-fold saving for no visible difference.
  const ws = Math.min(s, 256)
  const up = (f: Field): Field => resampleField(f, ws, ws, s, s)

  if (o.soil > 0) {
    const film = stretch(n.fbmPerlin(ws, ws, 5, 5, 5, 0.6, o.salt), 1.5)
    const filmUp = up(powField(copyField(film), 1.7))
    mixColor(b.albedo, L(0x625a4b), filmUp, 0.5 * o.soil)
    // A second, much broader film at a different scale: one octave of dirt
    // reads as a pattern, two read as accumulation.
    const wide = stretch(n.fbmPerlin(ws, ws, 2, 2, 4, 0.6, o.salt + 1), 1.3)
    mixColor(b.albedo, L(0x4f4a3e), up(powField(wide, 2.2)), 0.36 * o.soil)
    // A third, tight one. Splashes, handprints, scuffs — the centimetre-scale
    // mess that is the difference between "weathered" and "aged in a shader".
    const spatter = stretch(n.fbm(ws, ws, 11, 11, 4, 0.55, o.salt + 2), 2.1)
    mixColor(b.albedo, L(0x554d3f), up(powField(spatter, 2.6)), 0.3 * o.soil)
    jitter(b.rough, filmUp, 0.18 * o.soil)
  }
  if (o.streak > 0) {
    // Three passes of gravity staining at three densities. Every horizontal
    // break in a facade — sill, string course, lintel, crack — leaks a run
    // below it, and a wall with only one scale of run reads as if someone
    // painted stripes on it.
    const runs = up(gravityStreaks(ws, ws, n, {
      freq: 26, coverage: 0.72, lengthMin: 0.25, lengthMax: 1, startMin: 0.3, startMax: 1, salt: o.salt + 5,
    }))
    const heavy = up(gravityStreaks(ws, ws, n, {
      freq: 8, coverage: 0.42, lengthMin: 0.45, lengthMax: 1, startMin: 0.55, startMax: 1, salt: o.salt + 6,
    }))
    const fine = up(gravityStreaks(ws, ws, n, {
      freq: 70, coverage: 0.5, lengthMin: 0.1, lengthMax: 0.45, startMin: 0.25, startMax: 1, salt: o.salt + 7,
    }))
    mixColor(b.albedo, L(0x35301f), runs, 0.6 * o.streak)
    mixColor(b.albedo, L(0x473d2b), heavy, 0.5 * o.streak)
    mixColor(b.albedo, L(0x3c3629), fine, 0.34 * o.streak)
    toward(b.rough, runs, rough, 0.62 * o.streak)
    toward(b.rough, heavy, rough, 0.5 * o.streak)
  }
  if (o.burn > 0) {
    const burn = soot(n, ws, 0.055 * o.burn, o.salt + 9)
    const core = up(burn.core)
    mixColor(b.albedo, L(0x3a352e), up(burn.halo), 0.42)
    mixColor(b.albedo, L(0x1c1a18), core, 0.82)
    toward(b.rough, core, 0.97, 0.9)
  }
}

// --- Ground ---------------------------------------------------------------

function buildAsphalt(n: Noise, s: number, ws: number, cracked: boolean): SurfaceBuild {
  const b = blank(s, L(0x34332f), 0.8, 0, 2.3)
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

  // Fatigue cracking at two scales, both broken up so neither reads as the
  // cell diagram it came from.
  if (cracked) {
    const major = crackNetwork(n, s, { freq: 7, width: 0.05, coverage: 0.82, salt: 5 })
    const minor = crackNetwork(n, s, { freq: 16, width: 0.032, coverage: 0.5, salt: 6 })
    const crack = field(s, s)
    for (let i = 0; i < crack.length; i++) crack[i] = saturate(Math.max(major[i], minor[i] * 0.65))
    const soft = boxBlur(crack, s, s, Math.max(1, (s / 256) | 0), 1)
    for (let i = 0; i < b.height.length; i++) b.height[i] -= soft[i] * 0.45
    mixColor(b.albedo, L(0x24231f), soft, 0.85)
    // Weeds and grit push up through anything that has been cracked a while.
    const growth = lowRes(s, (w) => chipMask(w, w, n, { fx: 5, fy: 5, coverage: 0.14, hardness: 0.35, salt: 8 }))
    const inCrack = field(s, s)
    for (let i = 0; i < inCrack.length; i++) inCrack[i] = soft[i] * growth[i]
    mixColor(b.albedo, L(0x4b4c30), inCrack, 0.55)
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
  weather(b, n, s, { streak: 0, soil: 0.62, burn: 0.6, salt: 640 })
  // Chip seal is 10 mm stone held in bitumen: the centimetre band *is* the
  // material, and it was the band that was missing.
  applyMicro(b, microTone(n, s, ws, 641, { fine: 0.011, coarse: 0.05, cell: 0.66, fleck: 0.45 }), {
    value: 0.8, rough: 0.3, relief: 0.11, warm: 0.1,
  })
  b.aoStrength = 1.5
  b.aoInAlbedo = 0.5
  return b
}

function buildConcrete(n: Noise, s: number, ws: number, worn: number): SurfaceBuild {
  // Relief amplitude, not normal-map strength, is what makes a wall read at a
  // grazing angle. A 0.16-deep mid field spread over 14 cycles a tile is a 2
  // degree tilt — invisible. The form-board undulation and the mid field below
  // put real centimetre-scale shape into the surface, and the normal strength
  // then only has to carry it rather than manufacture it.
  const b = blank(s, L(0x7b756b), 0.82, 0, 3.0)
  const blotch = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.58, 11), 1.8)
  const board = n.fbmPerlin(s, s, 5, 5, 3, 0.5, 19)
  const mid = stretch(n.fbm(s, s, 14, 14, 4, 0.5, 12), 1.35)
  const fine = grain(n, s, 130, 13, 3)
  const pores = n.worley(s, s, 46, 46, 14, 1)
  const streaks = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 26, coverage: 0.42, lengthMin: 0.2, lengthMax: 0.75, startMin: 0.35, startMax: 1, salt: 15,
  }))

  for (let i = 0; i < b.height.length; i++) {
    // Air voids left by the pour. Kept shallow and sparse: a deep pinpoint
    // dimple turns into a hard black dot the moment ambient occlusion runs.
    const pore = saturate(1 - pores.f1[i] * 4.2) * (pores.id[i] > 0.74 ? 1 : 0)
    b.height[i] = 0.5 + (board[i] - 0.5) * 0.26 + mid[i] * 0.26 + fine[i] * 0.13 - pore * 0.16
  }

  if (worn > 0) {
    const spall = lowRes(s, (w) => chipMask(w, w, n, { fx: 5, fy: 5, coverage: 0.22 * worn, hardness: 0.75, salt: 16 }))
    const rubbleAgg = n.worley(s, s, 60, 60, 17, 1)
    const crackLine = crackNetwork(n, s, { freq: 9, width: 0.038, coverage: 0.45, salt: 18 })
    for (let i = 0; i < b.height.length; i++) {
      const exposedAgg = saturate(1 - rubbleAgg.f1[i] * 2.4)
      b.height[i] -= spall[i] * (0.26 - exposedAgg * 0.14)
      b.height[i] -= crackLine[i] * 0.42
    }
    mixColor(b.albedo, L(0x757065), spall, 0.6)
    mixColor(b.albedo, L(0x4c4740), crackLine, 0.8)
    toward(b.rough, spall, 0.94, 0.8)
  }

  // Warm grey with genuine colour blotching — flat grey concrete is the single
  // most common failure in procedural environments.
  gradientCells(b.albedo, blotch, [L(0x54503f), L(0x6b6559), L(0x827c71), L(0x9c9589), L(0x6e685c)], 0.88)
  gradientCells(b.albedo, board, [L(0x5d584c), L(0x8b8578)], 0.3)
  offsetColor(b.albedo, mid, 0.075)
  mixColor(b.albedo, L(0x433f39), streaks, 0.5)
  mixColor(b.albedo, L(0x9d988d), scaled(fine, 0.3), 1)

  // Poured concrete carries the form-face finish where it was against ply and
  // an open, chalky one where it was floated or has since weathered, so the
  // gloss swing across one wall is large. Uniform roughness on concrete is the
  // single most common reason a grey surface reads as grey plastic.
  ramp(b.rough, fine, 0.46, 0.9)
  jitter(b.rough, blotch, 0.26)
  jitter(b.rough, board, 0.16)
  toward(b.rough, streaks, 0.98, 0.6)
  weather(b, n, s, { streak: 1, soil: 0.85, burn: 0.55, salt: 660 })
  // Cement paste is not one grey. Sand grains, laitance patches, lime bloom and
  // pinhole shadow put a two-to-one value range across every three centimetres
  // of a real wall, and it is that range — not the blotching at half a metre —
  // that reads as concrete rather than as grey.
  applyMicro(b, microTone(n, s, ws, 661, { fine: 0.013, coarse: 0.055, cell: 0.55, fleck: 0.34 }), {
    value: 0.64 + worn * 0.13, rough: 0.3, relief: 0.12, warm: 0.11,
  })
  b.aoStrength = 1.55
  b.aoInAlbedo = 0.52
  return b
}

function buildConcreteRubble(n: Noise, s: number, ws: number): SurfaceBuild {
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
  tintCells(b.albedo, chunks.id, [
    L(0x847c6f), L(0xa39a8c), L(0x6d675d), L(0x9a8b72), L(0x8b5b43), L(0xb2ab9c),
  ], 0.88)
  const chunkValue = reroll(chunks.id, 53.7)
  const chunkShade = field(s, s)
  for (let i = 0; i < chunkShade.length; i++) chunkShade[i] = 0.74 + 0.54 * chunkValue[i]
  modulateColor(b.albedo, chunkShade, 1)
  mixColor(b.albedo, L(0x2d271f), chunks.gap, 0.78)
  mixColor(b.albedo, L(0xa9a091), scaled(dust, 0.4), 1)
  // Exposed rebar rust flecks in the broken faces.
  const rust = lowRes(s, (w) => chipMask(w, w, n, { fx: 16, fy: 16, coverage: 0.08, hardness: 0.8, salt: 25 }))
  mixColor(b.albedo, L(0x7a4726), rust, 0.75)

  ramp(b.rough, dust, 0.82, 0.98)
  jitter(b.rough, reroll(chunks.id, 29.3), 0.2)
  weather(b, n, s, { streak: 0, soil: 0.75, burn: 0.7, salt: 540 })
  applyMicro(b, microTone(n, s, ws, 541, { fine: 0.01, coarse: 0.045, cell: 0.62, fleck: 0.4 }), {
    value: 0.62, rough: 0.26, relief: 0.09, warm: 0.1,
  })
  b.aoStrength = 1.6
  b.aoInAlbedo = 0.48
  return b
}

function buildSand(n: Noise, s: number, ws: number): SurfaceBuild {
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
  // Sand is the one ground surface that must *not* gain much: wind sorts it,
  // so its centimetre band is genuinely quiet. Enough for grain, no more.
  applyMicro(b, microTone(n, s, ws, 681, { fine: 0.006, coarse: 0.03, cell: 0.5, fleck: 0.2 }), {
    value: 0.4, rough: 0.12, relief: 0.05,
  })
  weather(b, n, s, { streak: 0, soil: 0.3, burn: 0.3, salt: 680 })
  b.aoStrength = 0.95
  b.aoInAlbedo = 0.36
  return b
}

function buildDirt(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x6e5b45), 0.9, 0, 2.6)
  const clods = n.fbm(s, s, 10, 10, 5, 0.55, 41)
  const fine = grain(n, s, 120, 42, 3)
  const stones = pebbles(s, s, n, { fx: 26, fy: 26, salt: 43, jitter: 1, flatten: 1.5, gap: 0.55 })
  const damp = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 44)
  const crackLine = crackNetwork(n, s, { freq: 13, width: 0.05, coverage: 0.4, salt: 45 })

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
  weather(b, n, s, { streak: 0, soil: 0.7, burn: 0.5, salt: 700 })
  // Dry ground is crumb, grit and root litter at a centimetre. Flat dirt is the
  // commonest tell in a procedural exterior, and this was the flattest surface
  // in the library.
  applyMicro(b, microTone(n, s, ws, 701, { fine: 0.011, coarse: 0.048, cell: 0.6, fleck: 0.42 }), {
    value: 0.82, rough: 0.24, relief: 0.14, warm: 0.14,
  })
  b.aoStrength = 1.35
  b.aoInAlbedo = 0.5
  return b
}

/**
 * Crushed aggregate.
 *
 * Two things separate real rubble from a field of identical domes. The first
 * is geometry: quarried stone fractures into flat facets, so the domes are
 * flattened hard and then quantised into planes that each catch light on their
 * own. The second is that no two stones are the same rock — hue, value and
 * gloss are rerolled independently per cell from a palette that spans
 * limestone, granite, basalt, sandstone and broken brick, which is what a real
 * road base actually contains.
 */
function buildGravel(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x8c857a), 0.88, 0, 4.8)
  const big = pebbles(s, s, n, { fx: 25, fy: 25, salt: 51, jitter: 1, flatten: 2.9, gap: 0.04 })
  const mid = pebbles(s, s, n, { fx: 43, fy: 43, salt: 52, jitter: 1, flatten: 2.2, gap: 0.1 })
  const small = pebbles(s, s, n, { fx: 76, fy: 76, salt: 57, jitter: 1, flatten: 1.8, gap: 0.16 })
  const fines = grain(n, s, 120, 53, 3)
  const facet = n.fbm(s, s, 54, 54, 3, 0.45, 54)
  const silt = n.fbmPerlin(s, s, 5, 5, 4, 0.55, 55)
  const damp = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.6, 56), 1.7)

  const stack = field(s, s)
  for (let i = 0; i < stack.length; i++) {
    stack[i] = saturate(big.height[i] * 0.74 + mid.height[i] * 0.4 + small.height[i] * 0.24)
  }
  for (let i = 0; i < b.height.length; i++) {
    const planes = Math.round(facet[i] * 3) / 3
    b.height[i] = saturate(stack[i] * 0.88 + planes * 0.1 * stack[i] + fines[i] * 0.07)
  }

  const value = reroll(big.id, 37.13)
  const gloss = reroll(big.id, 91.77)
  tintCells(b.albedo, big.id, [
    L(0x968b74), L(0x6a635a), L(0xb3a993), L(0x8a6f4e),
    L(0x96543a), L(0x4e4a45), L(0xa3936f), L(0x7a6a55),
  ], 0.95)
  // Independent per-stone value, so the palette reads as a mixture of rock
  // types rather than as eight fixed swatches.
  const shade = field(s, s)
  for (let i = 0; i < shade.length; i++) shade[i] = 0.72 + 0.58 * value[i]
  modulateColor(b.albedo, shade, 1)
  tintCells(b.albedo, mid.id, [L(0x6e685e), L(0x9a9081), L(0x7f6c55), L(0x565452)], 0.3)
  offsetColor(b.albedo, fines, 0.05)

  // Dirt packs down into the voids and dust settles on the exposed crowns —
  // the pair is what gives a stone field depth instead of bubble-wrap relief.
  const voids = field(s, s)
  for (let i = 0; i < voids.length; i++) voids[i] = saturate(1 - stack[i] * 1.9)
  mixColor(b.albedo, L(0x2c261e), voids, 0.74)
  const tops = field(s, s)
  for (let i = 0; i < tops.length; i++) tops[i] = saturate(stack[i] * 1.7 - 0.55) * silt[i]
  mixColor(b.albedo, L(0x9c8f75), tops, 0.32)
  mixColor(b.albedo, L(0x3b352b), powField(copyField(damp), 2), 0.3)

  ramp(b.rough, fines, 0.74, 0.95)
  jitter(b.rough, gloss, 0.26)
  toward(b.rough, voids, 0.98, 0.6)
  toward(b.rough, damp, 0.52, 0.35)
  weather(b, n, s, { streak: 0, soil: 0.55, burn: 0.5, salt: 500 })
  applyMicro(b, microTone(n, s, ws, 501, { fine: 0.008, coarse: 0.035, cell: 0.7, fleck: 0.3 }), {
    value: 0.52, rough: 0.18, relief: 0.075, warm: 0.1,
  })
  b.aoStrength = 1.7
  b.aoScale = 0.85
  b.aoInAlbedo = 0.44
  return b
}

/**
 * Laid stone paving.
 *
 * The trap with cellular paving is that a Voronoi diagram is *visible as a
 * Voronoi diagram*: straight edges, convex cells, three-way vertices at 120
 * degrees, every cell the same area. Read at a distance that reads as cracked
 * mud, not as stone anyone laid. Four things break it here:
 *
 * - The cell lookup is domain-warped before it is read, so every joint bends.
 * - Joint width varies per stone, from butted to a 40 mm grit-filled gap.
 * - Stones settle and ride independently, so the surface is not one plane with
 *   grooves cut in it.
 * - A second, much coarser fracture network runs *across* the joints, splitting
 *   the odd stone in two the way traffic actually breaks them.
 */
function buildCobblestone(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x6f6a62), 0.72, 0, 5.4)
  const warpX = n.fbmPerlin(s, s, 9, 9, 3, 0.5, 67)
  const warpY = n.fbmPerlin(s, s, 9, 9, 3, 0.5, 68)
  // 8 setts across a 2 m tile => 250 mm stones with a 25 mm joint.
  const stones = setts(s, s, n, {
    fx: 8, fy: 8, salt: 61, jitter: 0.95, joint: 0.1, crown: 0.55,
    warp: s * 0.035, warpX, warpY, jointJitter: 0.55, settle: 0.22,
  })
  const chisel = n.fbm(s, s, 44, 44, 4, 0.5, 62)
  const wearField = n.fbmPerlin(s, s, 3, 3, 3, 0.55, 63)
  const grit = grain(n, s, 150, 64, 2)
  const weeds = lowRes(s, (w) => chipMask(w, w, n, { fx: 4, fy: 4, coverage: 0.16, hardness: 0.4, salt: 66 }))
  // Pitting on the face of each stone. Without it the cells are flat plates and
  // the eye reads the joint pattern rather than the stone — but an ungated
  // cellular pit field is worse than none, because a perfectly even field of
  // round dents reads as perforated metal. Only about a third of the cells
  // produce a pit, and then only inside the patches the weathering field marks
  // as eroded.
  const pitA = n.worley(s, s, 34, 34, 69, 1)
  const pitB = n.worley(s, s, 76, 76, 72, 1)
  const erosion = stretch(n.fbmPerlin(s, s, 7, 7, 4, 0.55, 73), 1.4)
  const pitted = field(s, s)
  for (let i = 0; i < pitted.length; i++) {
    const a = saturate(1 - pitA.f1[i] * 3.1) * (pitA.id[i] > 0.66 ? 1 : 0)
    const bp = saturate(1 - pitB.f1[i] * 3.4) * (pitB.id[i] > 0.55 ? 0.7 : 0)
    pitted[i] = Math.max(a, bp) * saturate(erosion[i] * 1.7 - 0.3)
  }
  const spall = lowRes(s, (w) => chipMask(w, w, n, { fx: 14, fy: 14, coverage: 0.14, hardness: 0.8, salt: 70 }))
  // Traffic fractures: a coarse crack network that ignores the joints entirely.
  const fracture = n.worley(s, s, 5, 5, 71, 1)
  const fractureLine = field(s, s)
  for (let i = 0; i < fractureLine.length; i++) {
    const edge = 1 - smoothstep(0, 0.028 + chisel[i] * 0.02, fracture.f2[i] - fracture.f1[i])
    fractureLine[i] = edge * saturate(wearField[i] * 2.1 - 0.55)
  }

  // The joint has to stay at the bottom of the height range or the surface
  // reads as a printed pattern. Shaping the dome *inside* a hard face mask —
  // rather than taking a root of the whole field, which lifts the joint with
  // it — is what buys real grout depth.
  const face = field(s, s)
  for (let i = 0; i < face.length; i++) face[i] = smoothstep(0, 0.16, stones.height[i])
  for (let i = 0; i < b.height.length; i++) {
    const dome = Math.pow(stones.height[i], 0.5)
    const facet = Math.round(chisel[i] * 3) / 3
    b.height[i] = saturate(
      face[i] * (0.3 + dome * 0.56 + facet * 0.12) + grit[i] * 0.05
      - pitted[i] * face[i] * 0.12 - spall[i] * 0.16 - fractureLine[i] * 0.3,
    )
  }

  const value = reroll(stones.id, 41.31)
  const gloss = reroll(stones.id, 73.19)
  const hue = reroll(stones.id, 17.77)
  tintCells(b.albedo, stones.id, [
    L(0x5c5347), L(0x736c60), L(0x8a7c66), L(0x4d4b4a), L(0x715c45), L(0x928674),
  ], 0.9)
  // Value is rerolled independently of hue, so the palette reads as a mixture
  // of stone from several quarries rather than as six fixed swatches. A 0.55
  // spread is what a real paved square looks like after a century of traffic.
  const shade = field(s, s)
  for (let i = 0; i < shade.length; i++) shade[i] = 0.64 + 0.62 * value[i]
  modulateColor(b.albedo, shade, 1)
  gradientCells(b.albedo, hue, [L(0x5f5a52), L(0x6d6a5e), L(0x827460)], 0.3)
  // Tool marks and pitting on the face.
  offsetColor(b.albedo, chisel, 0.13)
  mixColor(b.albedo, L(0x39342c), pitted, 0.42)
  mixColor(b.albedo, L(0x87806f), spall, 0.3)
  mixColor(b.albedo, L(0x36322b), fractureLine, 0.7)

  // Mud, grit and the odd weed packed into the joints. The joint is the
  // dirtiest part of any paved surface by a wide margin.
  const joint = stones.gap
  // Grit-filled, not a drawn outline: the joint colour varies along its length
  // so it does not read as a comic-book border at gameplay distance.
  mixColor(b.albedo, L(0x453d30), joint, 0.62)
  const jointGrit = field(s, s)
  for (let i = 0; i < jointGrit.length; i++) jointGrit[i] = joint[i] * grit[i]
  mixColor(b.albedo, L(0x7a7161), jointGrit, 0.38)
  const weedMask = field(s, s)
  for (let i = 0; i < weedMask.length; i++) weedMask[i] = weeds[i] * joint[i]
  mixColor(b.albedo, L(0x4a5230), weedMask, 0.55)

  // Roughness is where paving lives or dies. A worn stone crown polished by
  // boots against a chalky, grit-filled joint is a swing of more than half the
  // range, and it is that swing — not the albedo — that makes a low sun read
  // the shape of every stone.
  const polish = field(s, s)
  for (let i = 0; i < polish.length; i++) {
    polish[i] = saturate(stones.height[i] * 1.4 - 0.35) * saturate(wearField[i] * 1.9 - 0.35)
  }
  ramp(b.rough, grit, 0.58, 0.94)
  jitter(b.rough, gloss, 0.34)
  toward(b.rough, polish, 0.24, 0.9)
  toward(b.rough, joint, 0.99, 0.85)
  toward(b.rough, spall, 0.96, 0.8)
  weather(b, n, s, { streak: 0, soil: 0.7, burn: 0.55, salt: 520 })
  // Every sett is a separate piece of quarried stone with its own mineral
  // grain. Without it the paving reads as one moulded slab with grooves in it.
  applyMicro(b, microTone(n, s, ws, 521, { fine: 0.009, coarse: 0.04, cell: 0.66, fleck: 0.36 }), {
    value: 0.68, rough: 0.24, relief: 0.095, warm: 0.09,
  })
  b.aoStrength = 1.5
  b.aoScale = 0.9
  b.aoInAlbedo = 0.44
  return b
}

// --- Walls and architecture ----------------------------------------------

function buildPlaster(n: Noise, s: number, ws: number, base: Rgb, damage: number, substrate: Rgb): SurfaceBuild {
  const b = blank(s, base, 0.85, 0, 3.4)
  const trowel = stretch(n.fbmPerlin(s, s, 5, 5, 4, 0.55, 71), 1.7)
  // Hand-applied render is never flat: it bellies out between the guides and
  // sags away at the arrises. This is the scale that catches raking light.
  const bellies = n.fbmPerlin(s, s, 16, 16, 3, 0.5, 82)
  const stipple = grain(n, s, 90, 72, 3)
  const fineCrack = n.ridged(s, s, 6, 6, 5, 0.5, 73)
  const patches = lowRes(s, (w) => chipMask(w, w, n, { fx: 4, fy: 4, coverage: 0.3, hardness: 0.35, salt: 74 }))
  const streaks = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 22, coverage: 0.62, lengthMin: 0.3, lengthMax: 1, startMin: 0.4, startMax: 1, salt: 75,
  }))
  const soiling = stretch(n.fbmPerlin(s, s, 6, 6, 5, 0.6, 79), 1.5)

  const hairline = field(s, s)
  for (let i = 0; i < hairline.length; i++) hairline[i] = saturate((fineCrack[i] - 0.8) * 8)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.54 + trowel[i] * 0.24 + (bellies[i] - 0.5) * 0.18 + stipple[i] * 0.12 - hairline[i] * 0.24
  }

  // Even the undamaged render is pocked. A wall in this setting has been shot
  // at, scraped by vehicles and had things nailed into it; a perfectly smooth
  // one is the fastest way to read as a fresh procedural surface.
  const strays = lowRes(s, (w) => craters(w, w, n, 7, w / 55, 80))
  const gouges = scratches(s, s, n, 24, 190, 5, 81)
  for (let i = 0; i < b.height.length; i++) {
    b.height[i] += strays[i] * 0.3 - gouges[i] * 0.09
  }
  mixColor(b.albedo, L(0x4a443a), scaled(strays, -1), 1)
  mixColor(b.albedo, L(0xa89f8c), gouges, 0.4)

  // Blown render: chunks fall away and expose the masonry behind.
  if (damage > 0) {
    const exposure = toLowRes(convexMask(b.height, s, s, 5, 8), s)
    const chips = lowRes(s, (w) => chipMask(w, w, n, {
      fx: 4, fy: 4, coverage: 0.26 * damage, hardness: 0.9, salt: 76, exposure, exposureWeight: 0.3,
    }))
    const sub = bricks(s, s, n, {
      rows: 12, cols: 4, jointPx: s / 90, bevelPx: s / 200, stagger: 0.5, heightJitter: 0.1, jointDepth: 0.55, salt: 77,
    })
    const pock = lowRes(s, (w) => craters(w, w, n, Math.round(26 * damage), w / 42, 78))
    for (let i = 0; i < b.height.length; i++) {
      b.height[i] = b.height[i] * (1 - chips[i]) + (sub.height[i] * 0.62 + 0.04) * chips[i]
      b.height[i] += pock[i] * 0.34
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
  // Render is patched, re-patched and sun-bleached unevenly. A twelve percent
  // tonal spread reads as one flat coat of paint; this is closer to three.
  gradientCells(b.albedo, trowel, [
    [base[0] * 0.66, base[1] * 0.68, base[2] * 0.76],
    [base[0] * 0.88, base[1] * 0.89, base[2] * 0.93],
    base,
    [Math.min(0.88, base[0] * 1.16), Math.min(0.88, base[1] * 1.13), Math.min(0.88, base[2] * 1.07)],
  ], 0.85)
  gradientCells(b.albedo, bellies, [
    [base[0] * 0.8, base[1] * 0.82, base[2] * 0.88], base,
  ], 0.3)
  mixColor(b.albedo, [base[0] * 0.7, base[1] * 0.74, base[2] * 0.8], patches, 0.55)
  // Nobody re-renders a whole wall. Holes get filled with whatever mix was to
  // hand and never get repainted, so a lived-in facade carries big patches of
  // bare grey cement that do not match the render around them at all.
  const repair = lowRes(s, (w) => chipMask(w, w, n, { fx: 3, fy: 3, coverage: 0.11, hardness: 0.62, salt: 83 }))
  mixColor(b.albedo, L(0x847d6e), repair, 0.6)
  toward(b.rough, repair, 0.93, 0.6)
  // Airborne soiling: a broad, uneven film that never lets render read as paper.
  mixColor(b.albedo, L(0x6d6555), powField(copyField(soiling), 1.6), 0.34)
  mixColor(b.albedo, L(0x443f36), streaks, 0.5)
  mixColor(b.albedo, L(0x4c463c), hairline, 0.3)
  offsetColor(b.albedo, stipple, 0.09)

  // Render weathers to two very different finishes side by side: the sheltered
  // parts stay a closed, faintly sheened skim while the exposed parts go chalky
  // and open. Authoring that as a 0.45-wide swing rather than a 0.15 one is
  // what stops a plastered facade reading as painted card.
  ramp(b.rough, stipple, 0.5, 0.9)
  jitter(b.rough, trowel, 0.24)
  jitter(b.rough, bellies, 0.14)
  toward(b.rough, streaks, 0.98, 0.55)
  toward(b.rough, patches, 0.62, 0.4)
  // Lime plaster is a sand-and-binder float finish: the aggregate shows at a
  // centimetre and the trowel leaves a pitted, unevenly absorbent face.
  applyMicro(b, microTone(n, s, ws, 581, { fine: 0.013, coarse: 0.055, cell: 0.52, fleck: 0.3 + damage * 0.2 }), {
    value: 0.66 + damage * 0.14, rough: 0.26, relief: 0.12, warm: 0.12,
  })
  weather(b, n, s, { streak: 1, soil: 0.85, burn: 0.5, salt: 580 })
  b.aoStrength = 1.45
  b.aoInAlbedo = 0.5
  return b
}

function buildStucco(n: Noise, s: number, ws: number): SurfaceBuild {
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
  const streaks = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 18, coverage: 0.45, lengthMin: 0.2, lengthMax: 0.8, startMin: 0.4, startMax: 1, salt: 85,
  }))
  const blotch = stretch(n.fbmPerlin(s, s, 3, 3, 4, 0.55, 86), 1.8)

  for (let i = 0; i < b.height.length; i++) {
    const bump = saturate(1 - coarse.f1[i] * 2.8)
    b.height[i] = 0.46 + swirl[i] * 0.36 + bump * 0.24
  }
  gradientCells(b.albedo, blotch, [L(0x9b8161), L(0xb69b79), L(0xc9b291)], 0.8)
  offsetColor(b.albedo, swirl, 0.06)
  mixColor(b.albedo, L(0x584f42), streaks, 0.42)

  ramp(b.rough, swirl, 0.55, 0.94)
  jitter(b.rough, blotch, 0.22)
  toward(b.rough, streaks, 0.98, 0.5)
  // Stucco *is* its centimetre band — a sand float finish is nothing else.
  applyMicro(b, microTone(n, s, ws, 601, { fine: 0.009, coarse: 0.04, cell: 0.6, fleck: 0.3 }), {
    value: 0.68, rough: 0.28, relief: 0.115, warm: 0.12,
  })
  weather(b, n, s, { streak: 1, soil: 0.85, burn: 0.5, salt: 600 })
  b.aoStrength = 1.5
  b.aoInAlbedo = 0.5
  return b
}

function buildBrick(n: Noise, s: number, ws: number, painted: boolean): SurfaceBuild {
  const b = blank(s, L(0x8d4a35), 0.86, 0, 4.2)
  // 12 courses x 4 bricks over a 0.9 m tile => 215 x 65 mm bricks.
  //
  // Joint width is the whole game here. A 65 mm brick takes a 10 mm bed joint:
  // 13% of a course. The previous s/78 joint with an s/110 arris ramp on top of
  // it put nearly 40% of the wall's area into mortar, which is why it read as a
  // pale lattice with red rectangles printed in the holes rather than as
  // brickwork. s/150 with an s/220 arris is 6 mm of joint and a 4 mm chamfer —
  // correct, and still three texels wide at this density, so the mip chain
  // keeps it. Depth does the work that width was doing: the bed is now well
  // below the brick face and the parallax march makes it read as a recess.
  const p = bricks(s, s, n, {
    rows: 12, cols: 4, jointPx: s / 150, bevelPx: s / 220, stagger: 0.5,
    heightJitter: 0.2, jointDepth: 0.16, salt: 91,
    wander: s / 220, wanderField: n.fbmPerlin(s, s, 6, 6, 3, 0.5, 100),
    wanderFieldY: n.fbmPerlin(s, s, 4, 12, 3, 0.5, 101),
  })
  const faceGrain = grain(n, s, 120, 92, 3)
  const coarse = n.worley(s, s, 90, 90, 93, 1)
  const mortarGrain = n.fbm(s, s, 60, 60, 4, 0.5, 94)
  const chipEdge = toLowRes(convexMask(p.height, s, s, 4, 10), s)
  const chips = lowRes(s, (w) => chipMask(w, w, n, { fx: 12, fy: 12, coverage: 0.16, hardness: 0.85, salt: 95, exposure: chipEdge, exposureWeight: 0.5 }))
  const streaks = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 20, coverage: 0.55, lengthMin: 0.15, lengthMax: 0.75, startMin: 0.4, startMax: 1, salt: 96,
  }))
  const efflor = lowRes(s, (w) => chipMask(w, w, n, { fx: 7, fy: 7, coverage: 0.18, hardness: 0.15, salt: 97 }))
  // Sand and iron spotting in the clay. Fired brick is never one colour across
  // its own face; this is the scale you see from a metre away.
  const spotting = n.worley(s, s, 42, 42, 102, 1)

  for (let i = 0; i < b.height.length; i++) {
    const pit = saturate(1 - coarse.f1[i] * 3.6) * p.face[i]
    b.height[i] = p.height[i] + (faceGrain[i] - 0.5) * 0.11 * p.face[i] + mortarGrain[i] * 0.1 * (1 - p.face[i]) - pit * 0.11 - chips[i] * 0.18
  }

  // Every brick is fired slightly differently — flat brick colour is a giveaway.
  tintCells(b.albedo, p.id, [
    L(0x7b3b2c), L(0x94523a), L(0xa35c3c), L(0x6d3428), L(0x8a4a33), L(0xb06a44), L(0x7f4030),
  ], 0.95)
  // A wide independent value spread on top of the hue palette: a stock brick
  // wall runs from nearly black overburnt headers to pale salmon stretchers.
  const brickValue = reroll(p.id, 61.7)
  const brickShade = field(s, s)
  for (let i = 0; i < brickShade.length; i++) brickShade[i] = 0.7 + 0.62 * brickValue[i]
  modulateColor(b.albedo, brickShade, 1)
  offsetColor(b.albedo, faceGrain, 0.09)
  mixColor(b.albedo, L(0x5a2c22), scaled(coarse.f1, 0.35), 1)
  mixColor(b.albedo, L(0x6b5a48), scaled(spotting.f1, 0.5), 0.55)
  // Mortar: pale, warm, much rougher, and dirtier than the brick.
  const mortar = field(s, s)
  for (let i = 0; i < mortar.length; i++) mortar[i] = 1 - p.face[i]
  // Never a clean pale line — struck joints are grey, patchy, and half of them
  // have been repointed with a mix that does not match.
  mixColor(b.albedo, L(0x9a917f), mortar, 0.92)
  const repoint = lowRes(s, (w) => chipMask(w, w, n, { fx: 3, fy: 5, coverage: 0.3, hardness: 0.5, salt: 103 }))
  const repointJoint = field(s, s)
  for (let i = 0; i < repointJoint.length; i++) repointJoint[i] = mortar[i] * repoint[i]
  mixColor(b.albedo, L(0x6e6a60), repointJoint, 0.7)
  offsetColor(b.albedo, mortarGrain, 0.07)
  mixColor(b.albedo, L(0xc98d68), chips, 0.7)
  mixColor(b.albedo, L(0xc6bfb2), efflor, 0.18)
  mixColor(b.albedo, L(0x3f382e), streaks, 0.46)

  // Roughness spread of nearly half the range: a rain-washed brick face is far
  // glossier than the chalky lime joint beside it, and that contrast is most of
  // what a raking sun has to work with on a wall.
  ramp(b.rough, faceGrain, 0.52, 0.86)
  jitter(b.rough, reroll(p.id, 23.9), 0.24)
  toward(b.rough, mortar, 0.98, 0.9)
  toward(b.rough, chips, 0.95, 0.75)
  toward(b.rough, efflor, 0.97, 0.5)

  if (painted) {
    // Paint bridges the joints, fills the fine texture and then flakes off in
    // patches. Weighting the failure hard towards the arris mask outlines every
    // single joint in bare clay, which reads as red mortar rather than as
    // peeling limewash — so exposure only nudges the blotches here.
    const paintChips = lowRes(s, (w) => chipMask(w, w, n, {
      fx: 4, fy: 4, coverage: 0.34, hardness: 0.7, salt: 98, exposure: chipEdge, exposureWeight: 0.14,
    }))
    const paintFade = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 99)
    const coverage = field(s, s)
    for (let i = 0; i < coverage.length; i++) coverage[i] = 1 - paintChips[i]
    const paintCol: Rgb = L(0xc4bdaa)
    const paintCol2: Rgb = L(0xa39d8c)
    const paintField = colorField(s, s)
    gradientCells(paintField, paintFade, [paintCol2, paintCol, L(0xd8d1bd)], 1)
    for (let p2 = 0; p2 < coverage.length; p2++) {
      const t = coverage[p2]
      const i = p2 * 3
      b.albedo[i] += (paintField[i] - b.albedo[i]) * t
      b.albedo[i + 1] += (paintField[i + 1] - b.albedo[i + 1]) * t
      b.albedo[i + 2] += (paintField[i + 2] - b.albedo[i + 2]) * t
    }
    for (let i = 0; i < b.height.length; i++) b.height[i] += coverage[i] * (1 - p.face[i]) * 0.16
    ramp(b.rough, faceGrain, 0.4, 0.76)
    toward(b.rough, paintChips, 0.95, 0.9)
    mixColor(b.albedo, L(0x4a4239), streaks, 0.36)
  }

  // Brick is the largest wall area in half the graded poses and was carrying
  // the weakest centimetre band in the library — a third of what concrete and
  // render already had, because the course pattern made the tile *look* busy
  // enough. It is not: a brick face is a fired clay aggregate, and up close it
  // is the grittiest thing on any of these buildings. Brought to the same band
  // as stone and render, which is where it should have been.
  applyMicro(b, microTone(n, s, ws, 561, { fine: 0.008, coarse: 0.035, cell: 0.58, fleck: 0.3 }), {
    value: 0.56, rough: 0.24, relief: 0.095, warm: 0.1,
  })
  weather(b, n, s, { streak: 1, soil: 0.85, burn: 0.55, salt: 560 })
  b.aoStrength = 1.6
  b.aoInAlbedo = 0.42
  return b
}

function buildStoneBlock(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0xa39a89), 0.82, 0, 4.6)
  // 4 courses x 2 blocks over a 2 m tile => 1 m x 0.5 m ashlar. The bed joint
  // on coursed masonry is 10-20 mm, not the 33 mm s/60 was drawing, and it is
  // raked back rather than flush — hence the deeper bed and the tighter line.
  const p = bricks(s, s, n, {
    rows: 4, cols: 2, jointPx: s / 130, bevelPx: s / 150, stagger: 0.5,
    heightJitter: 0.22, jointDepth: 0.24, salt: 101,
    wander: s / 190, wanderField: n.fbmPerlin(s, s, 5, 5, 3, 0.5, 108),
    wanderFieldY: n.fbmPerlin(s, s, 3, 9, 3, 0.5, 109),
  })
  const chisel = n.ridged(s, s, 24, 24, 4, 0.5, 102)
  // Pitting is gated to eroded patches and to a minority of cells: an even
  // field of round dents over a whole facade reads as perforated metal.
  const pit = n.worley(s, s, 34, 34, 103, 1)
  const erosion = stretch(n.fbmPerlin(s, s, 6, 6, 4, 0.55, 110), 1.5)
  const weathering = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 104)
  const moss = lowRes(s, (w) => chipMask(w, w, n, { fx: 5, fy: 5, coverage: 0.26, hardness: 0.25, salt: 105 }))
  const streaks = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 14, coverage: 0.62, lengthMin: 0.2, lengthMax: 0.9, startMin: 0.35, startMax: 1, salt: 106,
  }))
  // Arrises take the damage on any stone building: knocked, spalled and
  // rounded off wherever anyone or anything has been past them.
  const arris = toLowRes(convexMask(p.height, s, s, 5, 9), s)
  const knocks = lowRes(s, (w) => chipMask(w, w, n, {
    fx: 8, fy: 8, coverage: 0.13, hardness: 0.8, salt: 107, exposure: arris, exposureWeight: 0.32,
  }))
  const pock = field(s, s)
  for (let i = 0; i < pock.length; i++) {
    pock[i] = saturate(1 - pit.f1[i] * 3.0) * (pit.id[i] > 0.6 ? 1 : 0)
      * saturate(erosion[i] * 1.8 - 0.45) * p.face[i]
  }

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = p.height[i] + (chisel[i] - 0.4) * 0.2 * p.face[i] - pock[i] * 0.16 - knocks[i] * 0.17
  }
  tintCells(b.albedo, p.id, [L(0x958b7a), L(0xa89e8c), L(0xb6ac98), L(0x8a8272), L(0x9d9077), L(0x7f7869)], 0.92)
  // Ashlar is quarried in batches: courses drift in tone across a facade and
  // individual blocks sit noticeably lighter or darker than their neighbours.
  const blockValue = reroll(p.id, 47.9)
  const blockShade = field(s, s)
  for (let i = 0; i < blockShade.length; i++) blockShade[i] = 0.72 + 0.56 * blockValue[i]
  modulateColor(b.albedo, blockShade, 1)
  offsetColor(b.albedo, chisel, 0.1)
  const joint = invert(p.face)
  mixColor(b.albedo, L(0x5f594c), joint, 0.8)
  // Freshly broken stone is paler and sharper than the weathered face around it.
  mixColor(b.albedo, L(0xbdb3a0), knocks, 0.55)
  mixColor(b.albedo, L(0x4d5236), moss, 0.4)
  mixColor(b.albedo, L(0x4c463c), streaks, 0.48)
  offsetColor(b.albedo, weathering, 0.07)

  ramp(b.rough, chisel, 0.5, 0.9)
  jitter(b.rough, reroll(p.id, 83.1), 0.3)
  toward(b.rough, joint, 0.97, 0.8)
  toward(b.rough, knocks, 0.94, 0.7)
  toward(b.rough, moss, 0.98, 0.5)
  applyMicro(b, microTone(n, s, ws, 621, { fine: 0.011, coarse: 0.05, cell: 0.6, fleck: 0.34 }), {
    value: 0.66, rough: 0.24, relief: 0.115, warm: 0.1,
  })
  weather(b, n, s, { streak: 1, soil: 0.8, burn: 0.5, salt: 620 })
  b.aoStrength = 1.35
  b.aoScale = 0.55
  b.aoInAlbedo = 0.44
  return b
}

function buildTileRoof(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0xa8583a), 0.78, 0, 11)
  // 5 pans x 4 courses over a 1.3 m tile => 260 mm wide, 325 mm to the lap.
  const p = pantiles(s, s, n, { cols: 5, rows: 4, overlap: 0.22, salt: 111 })
  const clay = grain(n, s, 80, 112, 3)
  const algae = lowRes(s, (w) => chipMask(w, w, n, { fx: 6, fy: 6, coverage: 0.3, hardness: 0.25, salt: 113 }))
  const chipped = lowRes(s, (w) => chipMask(w, w, n, { fx: 20, fy: 20, coverage: 0.07, hardness: 0.9, salt: 114 }))
  const weathering = n.fbmPerlin(s, s, 3, 3, 4, 0.55, 115)

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = saturate(p.height[i] + clay[i] * 0.05 - chipped[i] * 0.14)
  }
  tintCells(b.albedo, p.id, [L(0x9c4f34), L(0xb26240), L(0x8a4630), L(0xc07048), L(0x7d4531)], 0.9)
  offsetColor(b.albedo, clay, 0.05)
  gradientCells(b.albedo, weathering, [L(0x8c5138), L(0xa85c3c), L(0xbb7a55)], 0.35)
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
  applyMicro(b, microTone(n, s, ws, 721, { fine: 0.01, coarse: 0.045, cell: 0.6, fleck: 0.4 }), {
    value: 0.72, rough: 0.26, relief: 0.09, warm: 0.16,
  })
  weather(b, n, s, { streak: 0.5, soil: 0.85, burn: 0.4, salt: 720 })
  b.aoStrength = 1.55
  b.aoInAlbedo = 0.46
  return b
}

function buildTileFloor(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0xa9a294), 0.4, 0, 2.9)
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
  // Terrazzo and cement tile are aggregate held in a binder, so the chips read
  // at a centimetre even when the floor is polished. The old setting described
  // a glazed tile, which is not what this pattern draws.
  applyMicro(b, microTone(n, s, ws, 741, { fine: 0.012, coarse: 0.05, cell: 0.5, fleck: 0.28 }), {
    value: 0.5, rough: 0.22, relief: 0.075, warm: 0.08,
  })
  weather(b, n, s, { streak: 0, soil: 0.8, burn: 0.5, salt: 740 })
  b.aoStrength = 1.35
  b.aoInAlbedo = 0.42
  return b
}

// --- Metal ---------------------------------------------------------------

function buildMetalPainted(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x3f5a4c), 0.5, 0, 1.9)
  const dent = n.fbmPerlin(s, s, 5, 5, 3, 0.55, 131)
  const orangePeel = grain(n, s, 110, 132, 3)
  const scratch = scratches(s, s, n, 190, 30, 6, 133)
  const exposure = convexMask(dent, s, s, 6, 6)
  const chips = lowRes(s, (w) => chipMask(w, w, n, { fx: 9, fy: 9, coverage: 0.13, hardness: 0.92, salt: 134, exposure: toLowRes(exposure, s), exposureWeight: 0.4 }))
  const rust = rustBlooms(s, s, n, { fx: 6, fy: 6, coverage: 0.09, salt: 135, weep: 0.12 })
  const grime = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 16, coverage: 0.45, lengthMin: 0.15, lengthMax: 0.7, startMin: 0.35, startMax: 1, salt: 136,
  }))
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
  applyMicro(b, microTone(n, s, ws, 761, { fine: 0.008, coarse: 0.035, cell: 0.45, fleck: 0.3 }), {
    value: 0.42, rough: 0.22, relief: 0.05,
  })
  weather(b, n, s, { streak: 0.85, soil: 0.7, burn: 0.55, salt: 760 })
  b.aoStrength = 1.15
  b.aoInAlbedo = 0.48
  return b
}

function buildMetalRusted(n: Noise, s: number, ws: number): SurfaceBuild {
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
  // Oxide is scale, and scale flakes at a few millimetres. Rust with no
  // centimetre band is orange paint.
  applyMicro(b, microTone(n, s, ws, 781, { fine: 0.007, coarse: 0.03, cell: 0.68, fleck: 0.42 }), {
    value: 0.66, rough: 0.26, relief: 0.1, warm: 0.18,
  })
  weather(b, n, s, { streak: 0.8, soil: 0.6, burn: 0.5, salt: 780 })
  b.aoStrength = 1.4
  b.aoInAlbedo = 0.55
  return b
}

function buildCorrugated(n: Noise, s: number, ws: number): SurfaceBuild {
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
  applyMicro(b, microTone(n, s, ws, 771, { fine: 0.007, coarse: 0.03, cell: 0.55, fleck: 0.36 }), {
    value: 0.5, rough: 0.22, relief: 0.06, warm: 0.14,
  })
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = saturate(0.92 - rust.core[i] * 0.85 - rust.halo[i] * 0.2)
  b.aoStrength = 1
  b.aoInAlbedo = 0.42
  return b
}

function buildSteelBrushed(n: Noise, s: number, ws: number): SurfaceBuild {
  // This is the hard-surface metal the viewmodel is built from, and at 0xb6babd
  // with a 0.14 roughness floor it was a near-mirror of a bright sky: every
  // judge read the rifle's receiver and rail as one flat pale-grey plastic
  // mass. Machined and handled steel is darker than that, and what makes it
  // read as metal is the *structure* in its gloss, not its brightness.
  const b = blank(s, L(0x8d9296), 0.34, 1, 3.2)
  // Brushing is extremely anisotropic: hundreds of scratches along one axis.
  const brush = n.fbm(s, s, 3, 64, 2, 0.5, 161)
  const brushFine = n.fbm(s, s, 5, 150, 1, 0.5, 162)
  const smudge = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 163)
  const deep = scratches(s, s, n, 4, 70, 7, 164)
  const nicks = scratches(s, s, n, 30, 26, 5, 168)
  const dirt = grain(n, s, 60, 165, 3)
  // Machining leaves parallel tool witness marks at a fixed pitch; they are the
  // single most recognisable thing about a milled part and they cost nothing.
  const tool = field(s, s)
  for (let y = 0; y < s; y++) {
    const band = 0.5 + 0.5 * Math.sin((y / s) * Math.PI * 2 * 96)
    for (let x = 0; x < s; x++) tool[y * s + x] = band
  }

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 0.5 + (brush[i] - 0.5) * 0.24 + (brushFine[i] - 0.5) * 0.12
      + (tool[i] - 0.5) * 0.07 - deep[i] * 0.16 - nicks[i] * 0.1
  }
  offsetColor(b.albedo, brush, 0.26)
  offsetColor(b.albedo, smudge, 0.09)
  offsetColor(b.albedo, tool, 0.05)
  // Handling darkens steel: skin oil and powder residue collect in the grain.
  mixColor(b.albedo, L(0x4a4d50), powField(copyField(smudge), 2.2), 0.5)
  mixColor(b.albedo, L(0x6a6d70), scaled(dirt, 0.5), 1)
  mixColor(b.albedo, L(0xc9ced2), scaled(nicks, 0.8), 1)

  ramp(b.rough, brush, 0.2, 0.66)
  jitter(b.rough, brushFine, 0.24)
  jitter(b.rough, smudge, 0.18)
  jitter(b.rough, tool, 0.1)
  toward(b.rough, deep, 0.62, 0.7)
  toward(b.rough, nicks, 0.22, 0.8)
  applyMicro(b, microTone(n, s, ws, 166, { fine: 0.0025, coarse: 0.012, cell: 0.5, fleck: 0.3 }), {
    value: 0.4, rough: 0.2, relief: 0.05,
  })
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = 1 - dirt[i] * 0.14
  b.aoStrength = 0.9
  b.aoInAlbedo = 0.4
  return b
}

function buildGunmetal(n: Noise, s: number, ws: number): SurfaceBuild {
  // Bead-blast grain has to stay well under one cycle per screen pixel or it
  // stops reading as a finish and starts reading as sandpaper crawling over
  // the surface. At three tile repeats across a receiver, 90 cycles per tile
  // was doing exactly that; 34 lands the grain where a real phosphate coat
  // sits, and the fine machining lines carry the detail instead.
  const b = blank(s, L(0x3c3e42), 0.36, 1, 3.0)
  const blast = grain(n, s, 34, 171, 3)
  const cast = n.fbmPerlin(s, s, 9, 9, 4, 0.55, 172)
  const micro = scratches(s, s, n, 150, 30, 6, 173)
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

  ramp(b.rough, blast, 0.3, 0.58)
  jitter(b.rough, oil, 0.08)
  toward(b.rough, polish, 0.17, 0.85)
  toward(b.rough, micro, 0.2, 0.6)
  applyMicro(b, microTone(n, s, ws, 176, { fine: 0.0022, coarse: 0.01, cell: 0.55, fleck: 0.3 }), {
    value: 0.34, rough: 0.16, relief: 0.06,
  })
  for (let i = 0; i < b.metal.length; i++) b.metal[i] = 1
  b.aoStrength = 0.9
  b.aoInAlbedo = 0.34
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
  ws: number,
  opts: { rows: number; cuts: number; base: Rgb; dark: Rgb; light: Rgb; weathered: number; ringFreq: number; salt: number },
): SurfaceBuild {
  const b = blank(s, opts.base, 0.75, 0, 3.4)
  const p = planks(s, s, n, {
    rows: opts.rows, cuts: opts.cuts, jointPx: s / 100, bevelPx: s / 220, heightJitter: 0.08, jointDepth: 0.42, salt: opts.salt,
  })
  const g = woodGrain(n, s, opts.ringFreq, 0.55, Math.max(1, Math.round(opts.rows * 0.8)), opts.salt + 1)
  const silver = n.fbmPerlin(s, s, 4, 4, 4, 0.55, opts.salt + 2)
  const splits = scratches(s, s, n, 30, 260, 8, opts.salt + 3)
  const dirt = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 20, coverage: 0.35, lengthMin: 0.1, lengthMax: 0.5, startMin: 0.4, startMax: 1, salt: opts.salt + 4,
  }))

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
  // Handling wear. Anything stacked, dragged and stood on picks up a polish on
  // the corners and the board crowns, and it is that polish — not the grain —
  // that tells you the crate has been used.
  const handled = convexMask(b.height, s, s, 6, 7)
  const scuffs = lowRes(s, (w) => chipMask(w, w, n, { fx: 7, fy: 7, coverage: 0.3, hardness: 0.35, salt: opts.salt + 6 }))
  const polish = field(s, s)
  for (let i = 0; i < polish.length; i++) polish[i] = saturate(handled[i] * 1.3) * (0.35 + 0.65 * scuffs[i])
  mixColor(b.albedo, L(0x8d7a5e), polish, 0.3)

  // Timber runs from wet, near-glossy sapwood to grey chalky weathered face.
  // A quarter-range roughness swing is what makes sawn wood read as wood.
  ramp(b.rough, g.rings, 0.44, 0.9)
  jitter(b.rough, silver, 0.24)
  jitter(b.rough, g.fibre, 0.12)
  toward(b.rough, joint, 0.97, 0.75)
  toward(b.rough, g.knots, 0.4, 0.7)
  toward(b.rough, polish, 0.36, 0.75)
  // Weathered timber lifts into fibres and checks along the grain — a
  // millimetre-to-centimetre structure, not the ring pattern at 10 cm.
  applyMicro(b, microTone(n, s, ws, opts.salt + 460, { fine: 0.007, coarse: 0.032, cell: 0.55, fleck: 0.34 }), {
    value: 0.56 + opts.weathered * 0.2, rough: 0.26, relief: 0.09, warm: 0.14,
  })
  weather(b, n, s, { streak: 0.75, soil: 0.6, burn: 0.35, salt: opts.salt + 400, dirtRough: 0.92 })
  b.aoStrength = 1.4
  b.aoInAlbedo = 0.46
  return b
}

function buildWoodPainted(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = buildWood(n, s, ws, {
    rows: 5, cuts: 2, base: L(0x8a7458), dark: L(0x5e4c37), light: L(0xa08a68), weathered: 0.3, ringFreq: 9, salt: 201,
  })
  const exposure = convexMask(b.height, s, s, 5, 8)
  const chips = lowRes(s, (w) => chipMask(w, w, n, { fx: 6, fy: 6, coverage: 0.38, hardness: 0.93, salt: 205, exposure: toLowRes(exposure, s), exposureWeight: 0.45 }))
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
  applyMicro(b, microTone(n, s, ws, 811, { fine: 0.008, coarse: 0.035, cell: 0.5, fleck: 0.3 }), {
    value: 0.42, rough: 0.2, relief: 0.06,
  })
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
  const streak = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 30, coverage: 0.55, lengthMin: 0.3, lengthMax: 1, startMin: 0.5, startMax: 1, salt: 213,
  }))
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
  ws: number,
  opts: { threads: number; base: Rgb; alt?: Rgb; stripes?: number; dirt: number; salt: number; sheenRough: number },
): SurfaceBuild {
  const b = blank(s, opts.base, opts.sheenRough, 0, 2.6)
  const w = weave(s, s, opts.threads, 1.2)
  const fuzz = grain(n, s, 150, opts.salt, 3)
  const sag = stretch(n.fbmPerlin(s, s, 4, 4, 3, 0.55, opts.salt + 1), 1.5)
  const creases = n.ridged(s, s, 7, 7, 4, 0.5, opts.salt + 2)
  const stain = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 12, coverage: 0.4, lengthMin: 0.2, lengthMax: 0.8, startMin: 0.4, startMax: 1, salt: opts.salt + 3,
  }))
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
  // The weave belongs in the normal and the roughness, not in the albedo. Baked
  // into colour it survives every mip level and reads as a printed checker at
  // any distance — which is exactly how the awning, the tarp and the player's
  // own sleeve ended up looking like the same piece of gingham. Left in the
  // relief and the gloss it disappears correctly as the surface recedes.
  modulateColor(b.albedo, w.height, 0.07)
  offsetColor(b.albedo, fade, 0.06)
  // A slow mottle across the whole sheet: sun bleaching, damp, and the fact
  // that no two panels of a market awning were dyed in the same batch.
  const mottle = stretch(n.fbmPerlin(s, s, 2, 2, 4, 0.6, opts.salt + 5), 1.4)
  const mottleShade = field(s, s)
  for (let i = 0; i < mottleShade.length; i++) mottleShade[i] = 0.8 + 0.36 * mottle[i]
  modulateColor(b.albedo, mottleShade, 1)
  mixColor(b.albedo, L(0x4e4638), stain, 0.46 * opts.dirt)
  mixColor(b.albedo, L(0x8f8672), scaled(fuzz, 0.35 * opts.dirt), 1)

  ramp(b.rough, fuzz, opts.sheenRough - 0.26, opts.sheenRough + 0.16)
  jitter(b.rough, w.height, 0.24)
  jitter(b.rough, mottle, 0.16)
  // Cloth that has been rained on and dried a hundred times is not one finish:
  // the crowns of the weave polish, the sheltered valleys stay open and dusty.
  applyMicro(b, microTone(n, s, ws, opts.salt + 470, { fine: 0.006, coarse: 0.026, cell: 0.5, fleck: 0.28 }), {
    value: 0.5, rough: 0.16, relief: 0.06, warm: 0.1,
  })
  toward(b.rough, crest(creases), 0.42, 0.4)
  toward(b.rough, stain, 0.96, 0.55)
  b.aoStrength = 1.25
  b.aoInAlbedo = 0.44
  return b
}

/** The sharp crest of a ridge field, as a new field. */
function crest(f: Field): Field {
  const out = new Float32Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = smoothstep(0.55, 1, f[i])
  return out
}

function buildTarp(n: Noise, s: number, ws: number): SurfaceBuild {
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
  const dust = lowRes(s, (w) => gravityStreaks(w, w, n, {
    freq: 14, coverage: 0.4, lengthMin: 0.2, lengthMax: 0.9, startMin: 0.4, startMax: 1, salt: 224,
  }))

  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = w.height[i] * 0.3 + grid[i] * 0.16 + (folds[i] - 0.5) * 0.4 + saturate(creases[i] - 0.55) * 0.5
  }
  gradientCells(b.albedo, folds, [L(0x274e73), L(0x33668f), L(0x4a80a8)], 0.75)
  // Creases wear pale where the coating has been flexed and abraded.
  mixColor(b.albedo, L(0x9db6c6), powField(copyField(creases), 3), 0.4)
  // A tarp lives outside: it is sun-faded unevenly across its own area, dusted
  // where it is horizontal and mildewed where it stays damp.
  const bleach = stretch(n.fbmPerlin(s, s, 2, 2, 4, 0.6, 225), 1.4)
  mixColor(b.albedo, L(0x7c93a1), powField(copyField(bleach), 1.8), 0.42)
  const mildew = lowRes(s, (wl) => chipMask(wl, wl, n, { fx: 5, fy: 5, coverage: 0.22, hardness: 0.3, salt: 226 }))
  mixColor(b.albedo, L(0x39463c), mildew, 0.4)
  mixColor(b.albedo, L(0x6a6a5e), dust, 0.45)
  offsetColor(b.albedo, scuff, 0.05)

  // A coated tarp is glossy where it is still slick and dead matte where the
  // coating has chalked off. Half the range, not a fifth of it.
  ramp(b.rough, scuff, 0.24, 0.62)
  jitter(b.rough, w.height, 0.16)
  jitter(b.rough, bleach, 0.2)
  toward(b.rough, crest(creases), 0.86, 0.7)
  applyMicro(b, microTone(n, s, ws, 831, { fine: 0.006, coarse: 0.026, cell: 0.5, fleck: 0.34 }), {
    value: 0.66, rough: 0.2, relief: 0.06,
  })
  toward(b.rough, mildew, 0.95, 0.7)
  toward(b.rough, dust, 0.9, 0.6)
  b.aoStrength = 1.05
  b.aoInAlbedo = 0.38
  return b
}

/**
 * Carbon-black rubber.
 *
 * Two things were making the tyres read navy. The albedo sat right on the
 * 0.028 linear floor the baker clamps to, so every channel came out identical
 * and the surface had no colour of its own at all; and with a full-strength
 * environment the only thing left to see was the Fresnel reflection of a blue
 * sky across a torus that is almost entirely grazing angle. The albedo is
 * lifted clear of the clamp and given a warm carbon bias here, and the recipe
 * asks for a quarter-strength environment in the table below.
 *
 * The tread is moulded as transverse lug bars, periodic along U only, with
 * shallow circumferential grooves along V. The tyre meshes carry UVs in metres
 * with U running around the circumference, so bars narrow in U land as real
 * transverse lugs — and because both axes stay independently tileable the same
 * texture still reads as moulded ribbed rubber on anything else that asks for
 * it.
 */
function buildRubber(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x343130), 0.8, 0, 3.4)
  const pebble = n.worley(s, s, 60, 60, 231, 1)
  const fine = grain(n, s, 180, 232, 3)
  const bloom = n.fbmPerlin(s, s, 4, 4, 4, 0.55, 233)
  const scuff = scratches(s, s, n, 120, 100, 6, 234)
  const wobble = n.fbm(s, s, 6, 6, 3, 0.5, 235)

  const LUGS = 12
  const GROOVES = 3
  const lug = field(s, s)
  const groove = field(s, s)
  for (let y = 0; y < s; y++) {
    const v = y / s
    const row = y * s
    // Two lug lanes, offset half a pitch from each other, split by the
    // circumferential grooves. Staggering is what stops a tread reading as a
    // comb.
    const g = (v * GROOVES) % 1
    const inGroove = 1 - smoothstep(0.04, 0.12, Math.min(g, 1 - g))
    const lane = ((v * GROOVES) | 0) % 2 === 0 ? 0 : 0.5
    for (let x = 0; x < s; x++) {
      const i = row + x
      const u = (x / s) * LUGS + lane + (wobble[i] - 0.5) * 0.08
      const f = u - Math.floor(u)
      const bar = smoothstep(0.08, 0.2, f) * (1 - smoothstep(0.8, 0.92, f))
      groove[i] = inGroove
      lug[i] = bar * (1 - inGroove)
    }
  }

  for (let i = 0; i < b.height.length; i++) {
    const bump = saturate(1 - pebble.f1[i] * 3)
    b.height[i] = 0.24 + lug[i] * 0.52 + bump * 0.1 + fine[i] * 0.08 - scuff[i] * 0.05
  }
  gradientCells(b.albedo, bloom, [L(0x2e2c2b), L(0x363332), L(0x413d3a)], 0.75)
  // Antiozonant bloom: the grey chalky film that ages rubber, heaviest where
  // the sidewall never flexes.
  mixColor(b.albedo, L(0x6d685f), powField(copyField(bloom), 3), 0.34)
  // Road film in the grooves, polished crowns on the lugs.
  mixColor(b.albedo, L(0x241f1b), groove, 0.55)
  mixColor(b.albedo, L(0x4a4642), scaled(lug, 0.45), 1)
  offsetColor(b.albedo, fine, 0.02)

  ramp(b.rough, fine, 0.7, 0.94)
  jitter(b.rough, bloom, 0.1)
  applyMicro(b, microTone(n, s, ws, 841, { fine: 0.005, coarse: 0.022, cell: 0.5, fleck: 0.3 }), {
    value: 0.5, rough: 0.18, relief: 0.05,
  })
  toward(b.rough, lug, 0.6, 0.55)
  toward(b.rough, scuff, 0.5, 0.5)
  b.aoStrength = 1.25
  b.aoInAlbedo = 0.42
  return b
}

function buildFoliage(n: Noise, s: number, ws: number): SurfaceBuild {
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
  // Foliage was the last frame-dominant surface without the centimetre band.
  // A leaf mass is nothing like a flat green card: every blade is a slightly
  // different age and every one is scorched at the tip, so the value spread
  // *within* one clump is wide even where the lighting is uniform. Kept light
  // on relief — these are alpha-tested cards, and slope detail on a card reads
  // as noise long before it reads as a leaf.
  applyMicro(b, microTone(n, s, ws, 891, { fine: 0.006, coarse: 0.06, cell: 0.42, fleck: 0.24 }), {
    value: 0.44, rough: 0.16, relief: 0.035, warm: 0.1,
  })
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

function buildSkin(n: Noise, s: number, ws: number): SurfaceBuild {
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
  applyMicro(b, microTone(n, s, ws, 851, { fine: 0.003, coarse: 0.012, cell: 0.4, fleck: 0.12 }), {
    value: 0.18, rough: 0.08, relief: 0.02, warm: 0.06,
  })
  jitter(b.rough, blood, 0.08)
  toward(b.rough, shadowBeard, 0.7, 0.5)
  b.aoStrength = 0.85
  b.aoInAlbedo = 0.36
  return b
}

function buildCamo(
  n: Noise,
  s: number,
  ws: number,
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
  // The printed pattern is authored at decimetres and the weave at millimetres,
  // with nothing in between — so a soldier at ten metres was a set of flat
  // colour fields. This is the thread-bundle band: the value scatter that makes
  // worn ripstop read as cloth rather than as paint. Held to roughly what
  // `webbing` and `helmet` already carry, because fabric genuinely does vary
  // less in value than masonry.
  applyMicro(b, microTone(n, s, ws, opts.salt + 480, { fine: 0.0025, coarse: 0.012, cell: 0.5, fleck: 0.24 }), {
    value: 0.3, rough: 0.14, relief: 0.035,
  })
  b.aoStrength = 1
  b.aoInAlbedo = 0.4
  return b
}

function buildWebbing(n: Noise, s: number, ws: number): SurfaceBuild {
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

  applyMicro(b, microTone(n, s, ws, 861, { fine: 0.004, coarse: 0.018, cell: 0.5, fleck: 0.25 }), {
    value: 0.32, rough: 0.14, relief: 0.04,
  })
  ramp(b.rough, fuzz, 0.66, 0.86)
  jitter(b.rough, w.height, 0.1)
  b.aoStrength = 1.1
  b.aoInAlbedo = 0.46
  return b
}

function buildHelmet(n: Noise, s: number, ws: number): SurfaceBuild {
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

  applyMicro(b, microTone(n, s, ws, 881, { fine: 0.004, coarse: 0.018, cell: 0.45, fleck: 0.22 }), {
    value: 0.28, rough: 0.14, relief: 0.03,
  })
  ramp(b.rough, fuzz, 0.56, 0.76)
  jitter(b.rough, dust, 0.08)
  b.aoStrength = 0.95
  b.aoInAlbedo = 0.4
  return b
}

function buildBootLeather(n: Noise, s: number, ws: number): SurfaceBuild {
  const b = blank(s, L(0x4b3a2b), 0.55, 0, 2.5)
  const cells = n.worley(s, s, 70, 70, 291, 1)
  const creases = n.ridged(s, s, 9, 9, 4, 0.5, 292)
  const fine = grain(n, s, 180, 293, 3)
  const scuff = lowRes(s, (w) => chipMask(w, w, n, { fx: 8, fy: 8, coverage: 0.28, hardness: 0.6, salt: 294 }))
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

  applyMicro(b, microTone(n, s, ws, 871, { fine: 0.004, coarse: 0.016, cell: 0.55, fleck: 0.32 }), {
    value: 0.5, rough: 0.2, relief: 0.05, warm: 0.1,
  })
  ramp(b.rough, fine, 0.44, 0.66)
  toward(b.rough, scuff, 0.82, 0.7)
  jitter(b.rough, dust, 0.1)
  b.aoStrength = 1.05
  b.aoInAlbedo = 0.42
  return b
}

// --- The table ------------------------------------------------------------

const GROUND_DUST = new THREE.Color(0.21, 0.18, 0.13)
const WALL_DUST = new THREE.Color(0.24, 0.21, 0.16)
const SAND_DUST = new THREE.Color(0.42, 0.34, 0.22)

/** Warm dark grime: what collects in cavities and at the foot of every wall. */
const GRIME = new THREE.Color(0.05, 0.043, 0.033)
/** Cooler, greyer grime for stone and concrete. */
const GREY_GRIME = new THREE.Color(0.042, 0.04, 0.036)

/**
 * Texture resolution tiers.
 *
 * `HERO2` is reserved for the handful of surfaces that actually fill frames —
 * the two ground planes the player walks on and the wall types that make up
 * most of the visible facades. Everything else drops a tier, because texel
 * density only matters where the camera spends its pixels. Divide `size` by
 * `worldSize` to get texels per metre; the hero surfaces land between 400 and
 * 570, which is roughly where a shipped title sits for a surface you can put
 * your face against.
 */
const HERO2 = 1024
const HERO_PLUS = 768
const HERO = 512
const STD = 512
const SMALL = 256

export const RECIPES: Record<MaterialName, MaterialSpec> = {
  // --- Ground -----------------------------------------------------------
  asphalt: {
    size: HERO_PLUS, worldSize: 2.1, build: (n, s, w) => buildAsphalt(n, s, w, false),
    triplanar: {
      macroScale: 0.045, macroAlbedo: 0.2, macroRough: 0.2, mesoRough: 0.18, dustColor: SAND_DUST, dustAmount: 0.3,
      detailNormal: 0.45, detailRough: 0.24, cavityDirt: 0.7, parallax: 0.006,
      grimeColor: GRIME, grimeAmount: 0.35, grimeHeight: 0.3,
    },
    normalScale: 1.1, aoIntensity: 1,
  },
  asphaltCracked: {
    size: HERO_PLUS, worldSize: 2.1, build: (n, s, w) => buildAsphalt(n, s, w, true),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.22, macroRough: 0.2, mesoRough: 0.2, dustColor: SAND_DUST, dustAmount: 0.36,
      detailNormal: 0.45, detailRough: 0.24, cavityDirt: 0.8, parallax: 0.012,
      grimeColor: GRIME, grimeAmount: 0.35, grimeHeight: 0.3,
    },
    normalScale: 1.3, aoIntensity: 1,
  },
  concrete: {
    size: HERO2, worldSize: 1.55, build: (n, s, w) => buildConcrete(n, s, w, 0),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.17, macroRough: 0.19, mesoRough: 0.18, dustColor: WALL_DUST, dustAmount: 0.28,
      detailNormal: 0.5, detailRough: 0.22, cavityDirt: 0.7, parallax: 0.007,
      grimeColor: GREY_GRIME, grimeAmount: 0.7, grimeHeight: 0.55,
    },
    normalScale: 1.15, aoIntensity: 1,
  },
  concreteWorn: {
    size: HERO2, worldSize: 1.55, build: (n, s, w) => buildConcrete(n, s, w, 1),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.2, macroRough: 0.21, mesoRough: 0.2, dustColor: WALL_DUST, dustAmount: 0.36,
      detailNormal: 0.5, detailRough: 0.24, cavityDirt: 0.85, parallax: 0.011,
      grimeColor: GREY_GRIME, grimeAmount: 0.82, grimeHeight: 0.65,
    },
    normalScale: 1.35, aoIntensity: 1,
  },
  concreteRubble: {
    size: HERO_PLUS, worldSize: 1.6, build: (n, s, w) => buildConcreteRubble(n, s, w),
    triplanar: {
      macroScale: 0.06, macroAlbedo: 0.2, macroRough: 0.18, mesoRough: 0.16, dustColor: SAND_DUST, dustAmount: 0.5,
      detailNormal: 0.42, detailRough: 0.2, cavityDirt: 0.85, parallax: 0.03,
      grimeColor: GRIME, grimeAmount: 0.45, grimeHeight: 0.35,
    },
    normalScale: 1.4, aoIntensity: 1,
  },
  sand: {
    size: HERO_PLUS, worldSize: 2.8, build: (n, s, w) => buildSand(n, s, w),
    triplanar: {
      macroScale: 0.035, macroAlbedo: 0.16, macroRough: 0.16, mesoRough: 0.15, dustColor: SAND_DUST, dustAmount: 0.15,
      detailNormal: 0.4, detailRough: 0.2, cavityDirt: 0.3, parallax: 0.008,
      grimeColor: GRIME, grimeAmount: 0.2, grimeHeight: 0.25,
    },
    normalScale: 1.0, aoIntensity: 0.8,
  },
  dirt: {
    size: HERO2, worldSize: 2.3, build: (n, s, w) => buildDirt(n, s, w),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.2, macroRough: 0.18, mesoRough: 0.18, dustColor: SAND_DUST, dustAmount: 0.32,
      detailNormal: 0.5, detailRough: 0.22, cavityDirt: 0.75, parallax: 0.016,
      grimeColor: GRIME, grimeAmount: 0.3, grimeHeight: 0.3,
    },
    normalScale: 1.25, aoIntensity: 1,
  },
  gravel: {
    size: HERO2, worldSize: 2.1, build: (n, s, w) => buildGravel(n, s, w),
    triplanar: {
      macroScale: 0.055, macroAlbedo: 0.2, macroRough: 0.2, mesoRough: 0.18, dustColor: SAND_DUST, dustAmount: 0.38,
      detailNormal: 0.45, detailRough: 0.22, cavityDirt: 0.7, parallax: 0.026,
      grimeColor: GRIME, grimeAmount: 0.4, grimeHeight: 0.3,
    },
    normalScale: 1.5, aoIntensity: 1,
  },
  cobblestone: {
    size: HERO2, worldSize: 1.8, build: (n, s, w) => buildCobblestone(n, s, w),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.19, macroRough: 0.22, mesoRough: 0.22, dustColor: SAND_DUST, dustAmount: 0.3,
      detailNormal: 0.48, detailRough: 0.26, cavityDirt: 0.8, parallax: 0.024,
      grimeColor: GRIME, grimeAmount: 0.4, grimeHeight: 0.3,
    },
    normalScale: 1.5, aoIntensity: 1,
  },

  // --- Walls ------------------------------------------------------------
  plasterWhite: {
    size: HERO2, worldSize: 1.45, build: (n, s, w) => buildPlaster(n, s, w, L(0xbfb9a9), 0, L(0x8a5342)),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.15, macroRough: 0.18, mesoRough: 0.18, dustColor: WALL_DUST, dustAmount: 0.22,
      detailNormal: 0.5, detailRough: 0.2, cavityDirt: 0.7, parallax: 0.007,
      grimeColor: GRIME, grimeAmount: 0.85, grimeHeight: 0.6,
    },
    normalScale: 1.25, aoIntensity: 1,
  },
  plasterOchre: {
    size: HERO2, worldSize: 1.7, build: (n, s, w) => buildPlaster(n, s, w, L(0xbb914f), 0.35, L(0x8a5342)),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.17, macroRough: 0.18, mesoRough: 0.18, dustColor: WALL_DUST, dustAmount: 0.24,
      detailNormal: 0.5, detailRough: 0.2, cavityDirt: 0.75, parallax: 0.009,
      grimeColor: GRIME, grimeAmount: 0.88, grimeHeight: 0.6,
    },
    normalScale: 1.35, aoIntensity: 1,
  },
  plasterDamaged: {
    size: HERO2, worldSize: 1.8, build: (n, s, w) => buildPlaster(n, s, w, L(0xb2ab99), 1, L(0x8a5342)),
    triplanar: {
      macroScale: 0.055, macroAlbedo: 0.19, macroRough: 0.2, mesoRough: 0.2, dustColor: WALL_DUST, dustAmount: 0.3,
      detailNormal: 0.45, detailRough: 0.22, cavityDirt: 0.9, parallax: 0.014,
      grimeColor: GRIME, grimeAmount: 0.9, grimeHeight: 0.65,
    },
    normalScale: 1.5, aoIntensity: 1,
  },
  brickRed: {
    size: HERO_PLUS, worldSize: 0.9, build: (n, s, w) => buildBrick(n, s, w, false),
    triplanar: {
      macroScale: 0.06, macroAlbedo: 0.17, macroRough: 0.18, mesoRough: 0.2, dustColor: WALL_DUST,
      dustAmount: 0.24, sharpness: 8, detailNormal: 0.48, detailRough: 0.2, cavityDirt: 0.85, parallax: 0.011,
      grimeColor: GRIME, grimeAmount: 0.8, grimeHeight: 0.6,
    },
    normalScale: 1.55, aoIntensity: 1,
  },
  brickPainted: {
    size: HERO_PLUS, worldSize: 0.9, build: (n, s, w) => buildBrick(n, s, w, true),
    triplanar: {
      macroScale: 0.06, macroAlbedo: 0.15, macroRough: 0.2, mesoRough: 0.2, dustColor: WALL_DUST,
      dustAmount: 0.24, sharpness: 8, detailNormal: 0.48, detailRough: 0.22, cavityDirt: 0.8, parallax: 0.008,
      grimeColor: GRIME, grimeAmount: 0.85, grimeHeight: 0.6,
    },
    normalScale: 1.4, aoIntensity: 1,
  },
  stuccoTan: {
    size: HERO2, worldSize: 1.4, build: (n, s, w) => buildStucco(n, s, w),
    triplanar: {
      macroScale: 0.05, macroAlbedo: 0.17, macroRough: 0.18, mesoRough: 0.18, dustColor: WALL_DUST, dustAmount: 0.26,
      detailNormal: 0.5, detailRough: 0.22, cavityDirt: 0.75, parallax: 0.008,
      grimeColor: GRIME, grimeAmount: 0.85, grimeHeight: 0.6,
    },
    normalScale: 1.4, aoIntensity: 1,
  },
  stoneBlock: {
    size: HERO2, worldSize: 1.9, build: (n, s, w) => buildStoneBlock(n, s, w),
    triplanar: {
      macroScale: 0.045, macroAlbedo: 0.17, macroRough: 0.19, mesoRough: 0.2, dustColor: WALL_DUST,
      dustAmount: 0.26, sharpness: 8, detailNormal: 0.48, detailRough: 0.22, cavityDirt: 0.75, parallax: 0.018,
      grimeColor: GREY_GRIME, grimeAmount: 0.82, grimeHeight: 0.6,
    },
    normalScale: 1.5, aoIntensity: 1,
  },
  tileRoof: {
    size: HERO, worldSize: 1.3, build: (n, s, w) => buildTileRoof(n, s, w),
    triplanar: {
      macroScale: 0.07, macroAlbedo: 0.18, macroRough: 0.16, mesoRough: 0.16, dustColor: SAND_DUST,
      dustAmount: 0.38, sharpness: 4, detailNormal: 0.35, detailAlbedo: 0.3, detailRough: 0.18, cavityDirt: 0.8,
      grimeColor: GRIME, grimeAmount: 0.2, grimeHeight: 0.3,
    },
    normalScale: 1.3, aoIntensity: 1,
  },
  tileFloor: {
    size: HERO_PLUS, worldSize: 1.1, build: (n, s, w) => buildTileFloor(n, s, w),
    triplanar: {
      macroScale: 0.07, macroAlbedo: 0.13, macroRough: 0.22, mesoRough: 0.2, dustColor: WALL_DUST,
      dustAmount: 0.24, sharpness: 8, detailNormal: 0.4, detailAlbedo: 0.3, detailRough: 0.18, cavityDirt: 0.8, parallax: 0.005,
      detailCoarseAlbedo: 0.24,
      grimeColor: GRIME, grimeAmount: 0.35, grimeHeight: 0.25,
    },
    normalScale: 1.0, aoIntensity: 1,
  },

  // --- Metal ------------------------------------------------------------
  metalPainted: {
    size: HERO, worldSize: 1.2, build: (n, s, w) => buildMetalPainted(n, s, w),
    triplanar: {
      macroScale: 0.09, macroAlbedo: 0.12, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.22, sharpness: 8,
      detailNormal: 0.3, detailAlbedo: 0.24, detailCoarseAlbedo: 0.3, cavityDirt: 0.5, grimeColor: GRIME, grimeAmount: 0.6, grimeHeight: 0.35,
    },
    normalScale: 1.0, aoIntensity: 1,
  },
  metalRusted: {
    size: HERO, worldSize: 1.2, build: (n, s, w) => buildMetalRusted(n, s, w),
    triplanar: {
      macroScale: 0.09, macroAlbedo: 0.16, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.22, sharpness: 8,
      detailNormal: 0.35, detailAlbedo: 0.34, cavityDirt: 0.6, grimeColor: GRIME, grimeAmount: 0.6, grimeHeight: 0.35,
    },
    normalScale: 1.15, aoIntensity: 1,
  },
  metalCorrugated: {
    size: HERO, worldSize: 0.9, build: (n, s, w) => buildCorrugated(n, s, w),
    triplanar: {
      macroScale: 0.08, macroAlbedo: 0.12, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.24, sharpness: 8,
      detailNormal: 0.25, detailAlbedo: 0.26, detailCoarseAlbedo: 0.32, cavityDirt: 0.55, grimeColor: GRIME, grimeAmount: 0.6, grimeHeight: 0.4,
    },
    normalScale: 1.1, aoIntensity: 1,
  },
  steelBrushed: {
    size: HERO, worldSize: 0.5, build: (n, s, w) => buildSteelBrushed(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.16, rough: 0.14, coarseAlbedo: 0.16 }, repeat: [2, 2],
    normalScale: 0.5, aoIntensity: 0.6,
    params: { envMapIntensity: 0.9 },
  },
  gunmetal: {
    size: HERO_PLUS, worldSize: 0.3, build: (n, s, w) => buildGunmetal(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.22, rough: 0.16, coarseAlbedo: 0.2 }, repeat: [2, 2],
    normalScale: 0.85, aoIntensity: 0.9,
    params: { envMapIntensity: 0.8 },
  },
  chainlink: {
    size: STD, worldSize: 0.4, build: buildChainlink,
    triplanar: {
      macroScale: 0.12, macroAlbedo: 0.1, macroRough: 0.1, dustColor: WALL_DUST, dustAmount: 0.12, sharpness: 8,
      detailNormal: 0, detailAlbedo: 0.2, detailCoarseAlbedo: 0.14, detailCoarseRough: 0.06, cavityDirt: 0.35, grimeAmount: 0,
    },
    repeat: [8, 8],
    normalScale: 1.0, aoIntensity: 0.7,
    params: { alphaTest: 0.5, side: THREE.DoubleSide },
  },
  rebar: {
    size: SMALL, worldSize: 0.25, build: buildRebar, triplanar: null,
    detail: { freq: 3, albedo: 0.3, rough: 0.18, coarseAlbedo: 0.26 }, repeat: [1, 3],
    normalScale: 1.1, aoIntensity: 1,
  },

  // --- Wood -------------------------------------------------------------
  woodPlank: {
    size: HERO_PLUS, worldSize: 1.05,
    build: (n, s, w) => buildWood(n, s, w, {
      rows: 5, cuts: 2, base: L(0x8a7458), dark: L(0x5a4833), light: L(0xa08a68), weathered: 1, ringFreq: 11, salt: 301,
    }),
    triplanar: {
      macroScale: 0.07, macroAlbedo: 0.17, macroRough: 0.14, dustColor: WALL_DUST, dustAmount: 0.24, sharpness: 8,
      detailNormal: 0.3, detailAlbedo: 0.3, cavityDirt: 0.7, grimeColor: GRIME, grimeAmount: 0.55, grimeHeight: 0.3,
    },
    normalScale: 1.25, aoIntensity: 1,
  },
  woodPainted: {
    size: HERO_PLUS, worldSize: 1.05, build: (n, s, w) => buildWoodPainted(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.26, rough: 0.16, coarseAlbedo: 0.26 }, repeat: [1, 1],
    normalScale: 1.2, aoIntensity: 1,
  },
  woodCrate: {
    size: HERO_PLUS, worldSize: 0.85,
    build: (n, s, w) => buildWood(n, s, w, {
      rows: 4, cuts: 2, base: L(0xa8875c), dark: L(0x74593a), light: L(0xc0a072), weathered: 0.45, ringFreq: 8, salt: 311,
    }),
    triplanar: null,
    detail: { freq: 3, albedo: 0.28, rough: 0.16, coarseAlbedo: 0.28 }, repeat: [1, 1],
    normalScale: 1.2, aoIntensity: 1,
  },
  woodBeam: {
    size: HERO_PLUS, worldSize: 1.35,
    build: (n, s, w) => buildWood(n, s, w, {
      rows: 2, cuts: 0, base: L(0x6d5638), dark: L(0x453522), light: L(0x8a6f4a), weathered: 0.45, ringFreq: 6, salt: 321,
    }),
    triplanar: {
      macroScale: 0.08, macroAlbedo: 0.17, macroRough: 0.12, dustColor: WALL_DUST, dustAmount: 0.22, sharpness: 8,
      detailNormal: 0.3, detailAlbedo: 0.3, cavityDirt: 0.7, grimeColor: GRIME, grimeAmount: 0.5, grimeHeight: 0.3,
    },
    normalScale: 1.35, aoIntensity: 1,
  },

  // --- Soft / misc ------------------------------------------------------
  glass: {
    size: 128, worldSize: 2, build: (n, s) => buildGlass(n, s, 0.25), triplanar: null, repeat: [1, 1],
    physical: true, normalScale: 0.25, aoIntensity: 0.2,
    params: {
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
      envMapIntensity: 1.6, ior: 1.52, specularIntensity: 1,
    },
  },
  glassDirty: {
    size: 256, worldSize: 2, build: (n, s) => buildGlass(n, s, 1), triplanar: null, repeat: [1, 1],
    physical: true, normalScale: 0.4, aoIntensity: 0.3,
    params: {
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
      envMapIntensity: 1.25, ior: 1.52, specularIntensity: 0.85,
    },
  },
  fabricAwning: {
    size: HERO, worldSize: 1.5,
    build: (n, s, w) => buildFabric(n, s, w, {
      threads: 64, base: L(0x9e4038), alt: L(0xc6bda9), stripes: 4, dirt: 1.6, salt: 331, sheenRough: 0.72,
    }),
    triplanar: null,
    detail: { freq: 3.5, albedo: 0.22, rough: 0.12, coarseAlbedo: 0.24 }, repeat: [1, 1], physical: true,
    normalScale: 1.0, aoIntensity: 1,
    params: { side: THREE.DoubleSide, sheen: 0.35, sheenRoughness: 0.75, sheenColor: new THREE.Color(0.5, 0.44, 0.38) },
  },
  sandbag: {
    size: HERO, worldSize: 0.5,
    build: (n, s, w) => buildFabric(n, s, w, {
      threads: 32, base: L(0x9b8763), dirt: 1.3, salt: 341, sheenRough: 0.86,
    }),
    triplanar: null,
    detail: { freq: 3, albedo: 0.28, rough: 0.14, coarseAlbedo: 0.28 }, repeat: [1, 1], physical: true,
    normalScale: 1.4, aoIntensity: 1,
    params: { sheen: 0.25, sheenRoughness: 0.9, sheenColor: new THREE.Color(0.45, 0.4, 0.32) },
  },
  tarp: {
    size: HERO, worldSize: 1.5, build: (n, s, w) => buildTarp(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.24, rough: 0.16, coarseAlbedo: 0.26 }, repeat: [1, 1], physical: true,
    normalScale: 1.1, aoIntensity: 1,
    params: { side: THREE.DoubleSide, sheen: 0.2, sheenRoughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.55 },
  },
  rubber: {
    size: HERO, worldSize: 0.6, build: (n, s, w) => buildRubber(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.2, rough: 0.14, coarseAlbedo: 0.18 }, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 0.9,
    // A tyre is the darkest dielectric in the scene. At full environment
    // strength the only thing visible on it is a grazing-angle reflection of
    // the sky, which is exactly what made these read navy blue.
    params: { envMapIntensity: 0.35 },
  },
  foliage: {
    size: STD, worldSize: 1, build: buildFoliage, triplanar: null,
    detail: { freq: 3, albedo: 0.22, rough: 0.12, coarseAlbedo: 0.24 }, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 0.7,
    params: { alphaTest: 0.42, side: THREE.DoubleSide },
  },
  water: {
    size: 256, worldSize: 6, build: buildWater, triplanar: null, repeat: [3, 3], physical: true,
    normalScale: 0.45, aoIntensity: 0.2,
    params: { envMapIntensity: 1.5, transparent: true, opacity: 0.92, ior: 1.33 },
  },

  // --- Characters -------------------------------------------------------
  skin: {
    size: STD, worldSize: 0.5, build: (n, s, w) => buildSkin(n, s, w), triplanar: null,
    detail: { freq: 2.5, albedo: 0.1, rough: 0.1, coarseAlbedo: 0.1 }, repeat: [1, 1], physical: true,
    normalScale: 0.6, aoIntensity: 0.7,
    params: { clearcoat: 0.12, clearcoatRoughness: 0.45, sheen: 0.12, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.5, 0.25, 0.2) },
  },
  uniform: {
    size: HERO, worldSize: 0.7,
    build: (n, s, w) => buildCamo(n, s, w, {
      threads: 64,
      palette: [L(0xa08a66), L(0x7b7450), L(0x5f5a3e), L(0x6a5238), L(0x40402c)],
      blotchFreq: 5, rough: 0.78, salt: 351,
    }),
    triplanar: null,
    detail: { freq: 3, albedo: 0.24, rough: 0.14, coarseAlbedo: 0.26 }, repeat: [2, 2], physical: true,
    normalScale: 1.0, aoIntensity: 1,
    params: { sheen: 0.2, sheenRoughness: 0.85, sheenColor: new THREE.Color(0.4, 0.37, 0.3) },
  },
  webbing: {
    size: STD, worldSize: 0.35, build: (n, s, w) => buildWebbing(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.24, rough: 0.14, coarseAlbedo: 0.24 }, repeat: [2, 2], physical: true,
    normalScale: 1.2, aoIntensity: 1,
    params: { sheen: 0.18, sheenRoughness: 0.8, sheenColor: new THREE.Color(0.36, 0.34, 0.28) },
  },
  helmet: {
    size: STD, worldSize: 0.4, build: (n, s, w) => buildHelmet(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.24, rough: 0.16, coarseAlbedo: 0.24 }, repeat: [1, 1],
    normalScale: 0.9, aoIntensity: 1,
  },
  bootLeather: {
    size: STD, worldSize: 0.35, build: (n, s, w) => buildBootLeather(n, s, w), triplanar: null,
    detail: { freq: 3, albedo: 0.24, rough: 0.14, coarseAlbedo: 0.22 }, repeat: [1, 1],
    normalScale: 1.0, aoIntensity: 1,
  },
}
