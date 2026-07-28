import type { Noise } from './Noise'
import {
  bilinearWrap,
  boxBlur,
  clamp,
  colorField,
  field,
  saturate,
  smoothstep,
  warpField,
  type ColorField,
  type Field,
} from './Fields'

/**
 * Structural patterns — the man-made geometry layer of a material: brick
 * courses, plank runs, corrugation, weave, tile grids, scattered aggregate.
 *
 * Every pattern is exactly tileable: cell counts are integers over the [0,1)
 * domain and all lookups wrap. Row staggering only ever uses `row % 2`, so the
 * bond pattern also repeats cleanly at the tile boundary.
 */

/** What every cell-based pattern hands back to a recipe. */
export interface CellPattern {
  /** 0 in the deepest joint, 1 on a raised face. */
  height: Field
  /** 1 on the face, 0 in the joint — the mask for per-face treatment. */
  face: Field
  /** Stable random value per cell, for per-brick / per-plank variation. */
  id: Field
}

export interface BrickOptions {
  /** Courses across the tile. Must be even for the running bond to wrap. */
  rows: number
  /** Bricks per course. */
  cols: number
  /** Joint width in texels. */
  jointPx: number
  /** Softness of the brick arris, in texels. */
  bevelPx: number
  /** How far the courses shift each row: 0.5 is a running bond. */
  stagger: number
  /** Height spread between individual bricks. */
  heightJitter: number
  /** Depth of the mortar bed below the brick face, 0..1. */
  jointDepth: number
  salt?: number
  /**
   * Per-texel wander of the joint line, in texels. A machine-straight mortar
   * line over a whole facade is the single loudest "this is a tiled texture"
   * signal a brick wall can send; real bedding wanders by several millimetres
   * from course to course and along each course.
   */
  wander?: number
  /** Field driving the wander, 0..1. Required if `wander` is set. */
  wanderField?: Field
  /** Second wander field, for the perpendicular axis. */
  wanderFieldY?: Field
}

export function bricks(w: number, h: number, noise: Noise, o: BrickOptions): CellPattern {
  const height = field(w, h)
  const face = field(w, h)
  const id = field(w, h)
  const rnd = noise.rand(o.salt ?? 11)
  const ids = new Float32Array(o.rows * o.cols)
  for (let i = 0; i < ids.length; i++) ids[i] = rnd.next()
  // Each brick sits a shade proud of or behind its neighbours, and each course
  // is bedded a shade thicker than the one below. Both are independent of the
  // colour id, so a pale brick is not automatically a proud one.
  const seat = new Float32Array(o.rows * o.cols)
  for (let i = 0; i < seat.length; i++) seat[i] = rnd.next()
  const courseBed = new Float32Array(o.rows)
  for (let i = 0; i < courseBed.length; i++) courseBed[i] = rnd.range(-1, 1)

  const cellW = w / o.cols
  const cellH = h / o.rows
  const half = o.jointPx * 0.5
  const bevel = Math.max(0.5, o.bevelPx)
  const wander = o.wander ?? 0
  const wx = o.wanderField
  const wy = o.wanderFieldY ?? o.wanderField

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      // The wander is applied to the *sample* position, so the joint, the
      // bevel and the cell id all bend together and the brick stays whole.
      const sx = wander > 0 && wx ? x + (wx[i] - 0.5) * wander : x
      const sy = wander > 0 && wy ? y + (wy[i] - 0.5) * wander : y
      const gy = (sy / h) * o.rows
      const ry = ((Math.floor(gy) % o.rows) + o.rows) % o.rows
      const fy = gy - Math.floor(gy)
      const edgeY = Math.min(fy, 1 - fy) * cellH
      const gx = (sx / w) * o.cols + (ry % 2) * o.stagger
      const fx = gx - Math.floor(gx)
      const cx = ((Math.floor(gx) % o.cols) + o.cols) % o.cols
      const edgeX = Math.min(fx, 1 - fx) * cellW
      const d = Math.min(edgeX, edgeY)
      // A slightly wider bed joint than perpend, the way a wall is actually
      // laid, plus a per-course thickness drift.
      const t = smoothstep(half + courseBed[ry] * half * 0.35, half + bevel, d)
      const k = ry * o.cols + cx
      const cellId = ids[k]
      const brickTop = 1 - o.heightJitter * seat[k]
      face[i] = t
      id[i] = cellId
      height[i] = o.jointDepth + t * (brickTop - o.jointDepth)
    }
  }
  return { height, face, id }
}

export interface PlankOptions {
  /** Boards across the tile, running along U. */
  rows: number
  /** Butt joints per board run. */
  cuts: number
  jointPx: number
  bevelPx: number
  heightJitter: number
  jointDepth: number
  salt?: number
}

/** Board runs with staggered butt joints — decking, fencing, boarded windows. */
export function planks(w: number, h: number, noise: Noise, o: PlankOptions): CellPattern {
  const height = field(w, h)
  const face = field(w, h)
  const id = field(w, h)
  const rnd = noise.rand(o.salt ?? 23)

  // Butt joints per board run. The board before the first cut and the board
  // after the last are the *same* board wrapping round the tile edge, so its
  // colour and height carry across the seam instead of changing there.
  const segments = Math.max(1, o.cuts)
  const cutsPerRow: Float32Array[] = []
  const idsPerRow: Float32Array[] = []
  for (let r = 0; r < o.rows; r++) {
    const cs = new Float32Array(o.cuts)
    for (let c = 0; c < o.cuts; c++) cs[c] = (c + 0.35 + rnd.range(0, 0.3)) / o.cuts
    cs.sort()
    cutsPerRow.push(cs)
    const is = new Float32Array(segments)
    for (let c = 0; c < is.length; c++) is[c] = rnd.next()
    idsPerRow.push(is)
  }

  const cellH = h / o.rows
  const half = o.jointPx * 0.5
  const bevel = Math.max(0.5, o.bevelPx)

  for (let y = 0; y < h; y++) {
    const gy = (y / h) * o.rows
    const ry = Math.floor(gy)
    const fy = gy - ry
    const edgeY = Math.min(fy, 1 - fy) * cellH
    const cs = cutsPerRow[ry]
    const is = idsPerRow[ry]
    const row = y * w
    for (let x = 0; x < w; x++) {
      const u = x / w
      let seg = segments - 1
      let dCut = 1e9
      for (let c = 0; c < cs.length; c++) {
        if (u >= cs[c]) seg = c
        const dd = Math.abs(u - cs[c])
        const wrapped = Math.min(dd, 1 - dd) * w
        if (wrapped < dCut) dCut = wrapped
      }
      const d = Math.min(edgeY, dCut)
      const t = smoothstep(half, half + bevel, d)
      const cellId = is[seg]
      const i = row + x
      face[i] = t
      id[i] = cellId
      height[i] = o.jointDepth + t * (1 - o.heightJitter * cellId - o.jointDepth)
    }
  }
  return { height, face, id }
}

/**
 * Corrugated sheet profile. Ribs vary along U so that, under the triplanar
 * projection used for architecture, they stand vertically on walls.
 */
export function corrugation(w: number, h: number, ribs: number, kind: 'sine' | 'trapezoid' = 'sine'): Field {
  const out = field(w, h)
  for (let x = 0; x < w; x++) {
    const u = ((x / w) * ribs) % 1
    let v: number
    if (kind === 'sine') {
      v = 0.5 - 0.5 * Math.cos(u * Math.PI * 2)
    } else {
      // Flat pan, steep web, flat crown — the trapezoidal profile of roofing steel.
      const a = 0.18
      const b = 0.32
      v = u < a ? 0 : u < b ? (u - a) / (b - a) : u < 1 - b ? 1 : u < 1 - a ? (1 - a - u) / (b - a) : 0
    }
    for (let y = 0; y < h; y++) out[y * w + x] = v
  }
  return out
}

/**
 * Plain weave. Alternating cells put the warp or the weft on top, each with a
 * rounded cross-section, which is what gives cloth its characteristic
 * cross-hatched specular breakup.
 */
export function weave(w: number, h: number, threads: number, roundness = 1): { height: Field } {
  const height = field(w, h)
  for (let y = 0; y < h; y++) {
    const gv = (y / h) * threads
    const rv = Math.floor(gv)
    const fv = gv - rv
    const row = y * w
    for (let x = 0; x < w; x++) {
      const gu = (x / w) * threads
      const ru = Math.floor(gu)
      const fu = gu - ru
      const over = ((ru + rv) & 1) === 0
      // Cross-section of the visible thread, plus the dimmer one crossing under.
      const top = Math.sin(Math.PI * (over ? fv : fu))
      const under = Math.sin(Math.PI * (over ? fu : fv))
      height[row + x] = saturate(Math.pow(top, 1 / roundness) * 0.78 + under * 0.22)
    }
  }
  return { height }
}

export interface PebbleOptions {
  fx: number
  fy: number
  salt: number
  jitter: number
  /** 1 = hemispheres, higher = flatter, worn tops. */
  flatten: number
  /** Gap between neighbouring stones, in cell units. */
  gap: number
}

export interface PebblePattern {
  height: Field
  id: Field
  /** 1 in the gaps between stones. */
  gap: Field
}

/** Scattered domed stones — gravel, cobbles, rubble, aggregate. */
export function pebbles(w: number, h: number, noise: Noise, o: PebbleOptions): PebblePattern {
  const { f1, f2, id } = noise.worley(w, h, o.fx, o.fy, o.salt, o.jitter)
  const height = field(w, h)
  const gap = field(w, h)
  for (let i = 0; i < height.length; i++) {
    const radius = 0.5 - o.gap * 0.5
    const r = saturate(1 - f1[i] / radius)
    const dome = Math.pow(r, 1 / o.flatten)
    // Second-nearest distance gives a clean crease exactly between stones.
    const border = saturate((f2[i] - f1[i]) * 3)
    height[i] = dome * (0.55 + 0.45 * id[i])
    gap[i] = 1 - border
  }
  return { height, id, gap }
}

export interface SettOptions {
  fx: number
  fy: number
  salt: number
  jitter: number
  /** Joint width, in cell units. */
  joint: number
  /** How much the face of each stone domes up towards its centre, 0..1. */
  crown: number
  /** Texels of domain warp applied before the cells are read. */
  warp?: number
  /** Field driving the warp along U, 0..1. */
  warpX?: Field
  /** Field driving the warp along V, 0..1. */
  warpY?: Field
  /** Spread of joint width between stones, in cell units. */
  jointJitter?: number
  /** How far individual stones settle below or ride above the paving, 0..1. */
  settle?: number
}

/**
 * Tightly packed irregular stones — cobble setts, ashlar rubble, crazy paving.
 *
 * Unlike `pebbles`, this keys off the *border* distance (`f2 - f1`) rather
 * than the distance to the feature point, so the stones tessellate the whole
 * surface with nothing but a joint between them. Scattered domes leave gaps
 * and read as loose aggregate; a laid stone surface must not.
 */
export function setts(w: number, h: number, noise: Noise, o: SettOptions): PebblePattern {
  const raw = noise.worley(w, h, o.fx, o.fy, o.salt, o.jitter)
  let f1 = raw.f1
  let f2 = raw.f2
  let id = raw.id
  // Straight Voronoi edges meeting at convex vertices is what makes procedural
  // paving read as a diagram rather than as stone. Warping the lookup bends
  // every joint; the id field is warped by the same amount with a nearest
  // lookup so cell colour stays locked to cell shape.
  if (o.warp && o.warpX && o.warpY) {
    f1 = warpField(f1, w, h, o.warpX, o.warpY, o.warp)
    f2 = warpField(f2, w, h, o.warpX, o.warpY, o.warp)
    id = warpField(id, w, h, o.warpX, o.warpY, o.warp, true)
  }
  const height = field(w, h)
  const gap = field(w, h)
  const jointJitter = o.jointJitter ?? 0
  const settle = o.settle ?? 0
  for (let i = 0; i < height.length; i++) {
    const edge = f2[i] - f1[i]
    // Joint width varies stone to stone: a paved surface laid by hand has
    // tight butt joints in one place and a 30 mm gap filled with grit next to it.
    const joint = o.joint * (1 + jointJitter * (id[i] - 0.5) * 2)
    const face = smoothstep(0, joint, edge)
    const crown = Math.pow(saturate(edge / (joint * 5)), 0.6)
    // Stones ride and settle independently. Without this the whole surface is
    // one plane with grooves cut in it, and light has nothing to break on.
    // The settle value is a decorrelated reroll of the id so the palest stone
    // is not also always the highest one.
    const r = id[i] * 7.31
    const sit = 1 - settle * (r - Math.floor(r))
    height[i] = face * (1 - o.crown + o.crown * crown) * (0.78 + 0.22 * id[i]) * sit
    gap[i] = 1 - face
  }
  return { height, id, gap }
}

export interface PantileOptions {
  cols: number
  rows: number
  /** Fraction of a row hidden under the course above. */
  overlap: number
  salt?: number
}

/** Barrel roof tiles: half-round pans in courses, each lapping the one below. */
export function pantiles(w: number, h: number, noise: Noise, o: PantileOptions): CellPattern {
  const height = field(w, h)
  const face = field(w, h)
  const id = field(w, h)
  const rnd = noise.rand(o.salt ?? 41)
  const ids = new Float32Array(o.rows * o.cols)
  for (let i = 0; i < ids.length; i++) ids[i] = rnd.next()

  for (let y = 0; y < h; y++) {
    const gy = (y / h) * o.rows
    const ry = Math.floor(gy)
    const fy = gy - ry
    const row = y * w
    // Course step: the bottom edge of each tile stands proud, casting the
    // strong horizontal shadow line that reads as "roof" from any distance.
    const lap = smoothstep(0, o.overlap, fy)
    const shadow = 1 - smoothstep(0, o.overlap * 0.55, fy)
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * o.cols + (ry % 2) * 0.5
      let cx = Math.floor(gx)
      const fx = gx - cx
      cx = ((cx % o.cols) + o.cols) % o.cols
      const barrel = Math.sin(Math.PI * saturate(fx))
      const cellId = ids[ry * o.cols + cx]
      const i = row + x
      const base = 0.22 + 0.62 * Math.pow(barrel, 0.72) * (0.9 + 0.1 * cellId)
      height[i] = saturate(base * (0.55 + 0.45 * lap) + 0.18 * lap - shadow * 0.3)
      face[i] = saturate(barrel * 1.6)
      id[i] = cellId
    }
  }
  return { height, face, id }
}

/** Diamond-woven chainlink: height for the wire relief, alpha for the holes. */
export function chainlink(w: number, h: number, cells: number, wirePx: number): { height: Field; alpha: Field } {
  const height = field(w, h)
  const alpha = field(w, h)
  const diag = Math.SQRT1_2
  for (let y = 0; y < h; y++) {
    const v = y / h
    const row = y * w
    for (let x = 0; x < w; x++) {
      const u = x / w
      const a = (((u + v) * cells) % 1 + 1) % 1
      const b = (((u - v) * cells) % 1 + 1) % 1
      const da = Math.min(a, 1 - a) * (w / cells) * diag
      const db = Math.min(b, 1 - b) * (w / cells) * diag
      const near = Math.min(da, db)
      const i = row + x
      const cover = 1 - smoothstep(wirePx * 0.5, wirePx * 0.5 + 1.2, near)
      alpha[i] = cover
      // Round wire cross-section, with the over-strand sitting slightly proud.
      const prof = saturate(1 - near / (wirePx * 0.6))
      const over = da < db ? 1 : 0.72
      height[i] = Math.sqrt(prof) * over
    }
  }
  return { height, alpha }
}

/**
 * Wind-formed sand ripples: a warped wave train with an asymmetric profile.
 *
 * `fu` and `fv` must be integers — the wave runs diagonally, and only integer
 * cycles per axis bring the phase back to itself at the tile edge.
 */
export function sandRipples(w: number, h: number, noise: Noise, fu: number, fv: number, warpAmp: number, salt = 5): Field {
  const wx = noise.fbm(w, h, 3, 3, 3, 0.55, salt)
  const wy = noise.fbm(w, h, 2, 2, 3, 0.55, salt + 1)
  const out = field(w, h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      const u = (x / w) + (wx[i] - 0.5) * warpAmp
      const v = (y / h) + (wy[i] - 0.5) * warpAmp * 0.35
      const p = u * fu + v * fv
      // Steep lee slope, long windward slope.
      const q = p - Math.floor(p)
      out[i] = q < 0.62 ? Math.pow(q / 0.62, 0.8) : 1 - (q - 0.62) / 0.38
    }
  }
  return out
}

/**
 * Thin directional scratches. Anisotropic ridged noise squeezed until only the
 * ridge crests survive gives believable machining and scuff marks far more
 * cheaply than drawing individual lines.
 */
export function scratches(w: number, h: number, noise: Noise, fx: number, fy: number, sharp: number, salt = 9): Field {
  // Octaves double the frequency, so the top octave has to stay well under
  // Nyquist. Past that the lattice degenerates into white noise and the
  // scratches lose their direction, which is the whole point of them.
  const octaves = Math.max(1, Math.min(3, Math.floor(Math.log2((w * 0.4) / Math.max(fx, fy))) + 1))
  const r = noise.ridged(w, h, fx, fy, octaves, 0.45, salt)
  const out = field(w, h)
  for (let i = 0; i < out.length; i++) out[i] = Math.pow(saturate(r[i]), sharp)
  return out
}

export interface StreakOptions {
  /** Streaks across the tile. */
  freq: number
  /** How much of the surface streaks at all, 0..1. */
  coverage: number
  /** Vertical extent as a fraction of the tile. */
  lengthMin: number
  lengthMax: number
  /** Where streaks start, as a fraction of tile height (1 = top). */
  startMin: number
  startMax: number
  salt: number
}

/**
 * Gravity-driven staining. Water runs down from sills, ledges and cracks and
 * deposits dirt in tapering vertical trails — one of the strongest readability
 * cues that a wall has been outside for years.
 *
 * Row 0 is the bottom of the texture (DataTexture is not flipped), so streaks
 * run from a high row towards lower ones.
 */
export function gravityStreaks(w: number, h: number, noise: Noise, o: StreakOptions): Field {
  const density = field(w, h)
  noise.fillValue(density, w, h, o.freq, 1, o.salt, 0.6)
  noise.fillValue(density, w, h, o.freq * 3, 1, o.salt + 1, 0.3)
  noise.fillValue(density, w, h, o.freq * 9, 1, o.salt + 2, 0.1)
  const starts = field(w, h)
  noise.fillValue(starts, w, h, Math.max(2, o.freq >> 1), 1, o.salt + 3, 1)
  const lens = field(w, h)
  noise.fillValue(lens, w, h, Math.max(2, o.freq), 1, o.salt + 4, 1)

  const out = field(w, h)
  const thr = 1 - o.coverage
  for (let x = 0; x < w; x++) {
    const d = density[x]
    if (d <= thr) continue
    const amp = (d - thr) / Math.max(1e-4, 1 - thr)
    const startY = (o.startMin + (o.startMax - o.startMin) * starts[x]) * h
    const len = Math.max(2, (o.lengthMin + (o.lengthMax - o.lengthMin) * lens[x]) * h)
    const y0 = Math.max(0, Math.floor(startY - len))
    const y1 = Math.min(h - 1, Math.ceil(startY))
    for (let y = y0; y <= y1; y++) {
      const t = (startY - y) / len
      // Dense right under the source, tapering as the run dilutes.
      const fall = Math.pow(saturate(1 - t), 0.7) * smoothstep(0, 0.06, t)
      out[y * w + x] = Math.max(out[y * w + x], amp * fall)
    }
  }
  // Wander sideways a little so the trails are not perfectly plumb.
  const wanderX = noise.fbm(w, h, 4, 4, 3, 0.5, o.salt + 7)
  const wandered = field(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      wandered[i] = bilinearWrap(out, w, h, x + (wanderX[i] - 0.5) * w * 0.012, y)
    }
  }
  return boxBlur(wandered, w, h, Math.max(1, Math.round(w / 340)), 1)
}

export interface ChipOptions {
  /** Blotch scale. */
  fx: number
  fy: number
  /** Fraction of the surface that has lost its coating. */
  coverage: number
  /** 0 = soft fade, 1 = hard flake edge. */
  hardness: number
  salt: number
  /** Bias chipping towards exposed geometry. */
  exposure?: Field
  exposureWeight?: number
}

/**
 * Paint chipping / spalling. Coatings fail at high points and edges first, so
 * the blotch field is biased by an exposure mask before it is thresholded into
 * hard-edged flakes.
 */
export function chipMask(w: number, h: number, noise: Noise, o: ChipOptions): Field {
  const base = noise.fbm(w, h, o.fx, o.fy, 5, 0.55, o.salt)
  const detail = noise.fbm(w, h, o.fx * 6, o.fy * 6, 3, 0.5, o.salt + 1)
  const out = field(w, h)
  const ew = o.exposureWeight ?? 0.55
  for (let i = 0; i < out.length; i++) {
    let v = base[i] * 0.72 + detail[i] * 0.28
    if (o.exposure) v = v * (1 - ew) + o.exposure[i] * ew
    out[i] = v
  }
  // Pick the threshold from the actual distribution so `coverage` means what
  // it says regardless of how the noise happened to land.
  const thr = quantile(out, 1 - o.coverage)
  const soft = 0.16 * (1 - o.hardness) + 0.008
  for (let i = 0; i < out.length; i++) out[i] = smoothstep(thr, thr + soft, out[i])
  return out
}

/** Threshold value below which `q` of the field lies. */
export function quantile(f: Field, q: number): number {
  const bins = new Uint32Array(256)
  for (let i = 0; i < f.length; i++) bins[clamp((f[i] * 255) | 0, 0, 255)]++
  const target = f.length * saturate(q)
  let acc = 0
  for (let b = 0; b < 256; b++) {
    acc += bins[b]
    if (acc >= target) return b / 255
  }
  return 1
}

export interface RustOptions {
  fx: number
  fy: number
  coverage: number
  salt: number
  /** Rust weeps downwards from where it starts. */
  weep: number
}

/**
 * Rust blooms: broad patches with a hard leading edge, a halo of staining
 * around them, and pitting inside. Real rust is never a uniform wash.
 */
export function rustBlooms(w: number, h: number, noise: Noise, o: RustOptions): { core: Field; halo: Field; pits: Field } {
  const wx = noise.fbm(w, h, o.fx, o.fy, 3, 0.5, o.salt + 11)
  const wy = noise.fbm(w, h, o.fx, o.fy, 3, 0.5, o.salt + 12)
  const raw = noise.fbm(w, h, o.fx, o.fy, 5, 0.58, o.salt)
  const warped = field(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      warped[i] = bilinearWrap(raw, w, h, x + (wx[i] - 0.5) * w * 0.09, y + (wy[i] - 0.5) * h * 0.09)
    }
  }
  if (o.weep > 0) {
    // Smear downwards: rust stains the metal below the bloom.
    const smear = field(w, h)
    const steps = Math.max(1, Math.round(h * o.weep))
    for (let x = 0; x < w; x++) {
      let carry = 0
      for (let y = h - 1; y >= 0; y--) {
        const v = warped[y * w + x]
        carry = Math.max(v, carry * (1 - 1 / steps))
        smear[y * w + x] = carry
      }
      // Wrap the carry once more so the seam matches.
      for (let y = h - 1; y >= 0; y--) {
        const i = y * w + x
        carry = Math.max(warped[i], carry * (1 - 1 / steps))
        smear[i] = Math.max(smear[i], carry)
      }
    }
    for (let i = 0; i < warped.length; i++) warped[i] = warped[i] * 0.65 + smear[i] * 0.35
  }
  const thrCore = quantile(warped, 1 - o.coverage)
  const thrHalo = quantile(warped, 1 - Math.min(0.98, o.coverage * 2.1))
  const core = field(w, h)
  const halo = field(w, h)
  for (let i = 0; i < core.length; i++) {
    core[i] = smoothstep(thrCore, thrCore + 0.035, warped[i])
    halo[i] = smoothstep(thrHalo, thrHalo + 0.22, warped[i])
  }
  const cell = noise.worley(w, h, Math.round(o.fx * 9), Math.round(o.fy * 9), o.salt + 3, 1)
  const pits = field(w, h)
  for (let i = 0; i < pits.length; i++) pits[i] = saturate(1 - cell.f1[i] * 2.6) * core[i]
  return { core, halo, pits }
}

/** Impact craters with a raised lip — bullet pocks in masonry and plaster. */
export function craters(w: number, h: number, noise: Noise, count: number, radiusPx: number, salt = 17): Field {
  const out = field(w, h)
  const rnd = noise.rand(salt)
  for (let c = 0; c < count; c++) {
    const cx = rnd.next() * w
    const cy = rnd.next() * h
    const r = radiusPx * rnd.range(0.55, 1.5)
    const depth = rnd.range(0.4, 1)
    const x0 = Math.floor(cx - r * 2)
    const x1 = Math.ceil(cx + r * 2)
    const y0 = Math.floor(cy - r * 2)
    const y1 = Math.ceil(cy + r * 2)
    for (let y = y0; y <= y1; y++) {
      const wy = ((y % h) + h) % h
      for (let x = x0; x <= x1; x++) {
        const wx = ((x % w) + w) % w
        const dx = x - cx
        const dy = y - cy
        const d = Math.sqrt(dx * dx + dy * dy) / r
        if (d > 2) continue
        // Bowl inside, spall lip just outside.
        const bowl = -depth * Math.exp(-d * d * 2.2)
        const lip = depth * 0.35 * Math.exp(-(d - 1.15) * (d - 1.15) * 6)
        const i = wy * w + wx
        out[i] = Math.min(out[i], bowl) + lip
      }
    }
  }
  return out
}

/**
 * Alpha-tested leaf cluster. Cards are rasterised as rotated ellipses with a
 * midrib crease so the normal map catches light per leaf rather than reading
 * as a flat green sheet.
 */
export function leafCluster(
  w: number,
  h: number,
  noise: Noise,
  count: number,
  palette: readonly (readonly [number, number, number])[],
): { alpha: Field; height: Field; color: ColorField; shade: Field } {
  const alpha = field(w, h)
  const height = field(w, h)
  const shade = field(w, h, 0.5)
  const color = colorField(w, h)
  const rnd = noise.rand(31)
  for (let c = 0; c < count; c++) {
    const cx = rnd.next() * w
    const cy = rnd.next() * h
    const len = rnd.range(0.075, 0.16) * w
    const wid = len * rnd.range(0.3, 0.5)
    const ang = rnd.next() * Math.PI * 2
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const tone = rnd.next()
    const col = palette[Math.floor(rnd.next() * palette.length)]
    const depth = rnd.next()
    const r = Math.ceil(len + 2)
    for (let y = -r; y <= r; y++) {
      const wy = (((cy + y) | 0) % h + h) % h
      for (let x = -r; x <= r; x++) {
        const lx = (x * ca + y * sa) / len
        const ly = (-x * sa + y * ca) / wid
        // Teardrop: wider at the base, pointed at the tip.
        const taper = 1 - saturate((lx + 1) * 0.5) * 0.55
        const d = lx * lx + (ly * ly) / (taper * taper)
        if (d > 1) continue
        const wx = (((cx + x) | 0) % w + w) % w
        const i = wy * w + wx
        if (depth < height[i] && alpha[i] > 0.5) continue
        alpha[i] = 1
        height[i] = depth
        // Midrib: a crease down the leaf's long axis.
        const rib = 1 - Math.exp(-ly * ly * 26)
        shade[i] = 0.35 + 0.65 * rib * (0.7 + 0.3 * tone)
        const j = i * 3
        color[j] = col[0]
        color[j + 1] = col[1]
        color[j + 2] = col[2]
      }
    }
  }
  return { alpha, height, color, shade }
}
