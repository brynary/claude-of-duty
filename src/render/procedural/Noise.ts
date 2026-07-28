import { Rand } from '../../core/Rand'

/**
 * Seeded, **tileable** procedural noise.
 *
 * Every generator here wraps exactly at the texture edge. A lattice of integer
 * frequency `fx x fy` is sampled over the [0,1) domain, so texel `w` lands back
 * on texel `0` with the identical value — no seam. Seamed noise is the single
 * most obvious tell of hand-rolled procedural texturing, so nothing in this
 * file is allowed to be non-tileable.
 *
 * Frequencies are separable (`fx`, `fy`) because most real surfaces are
 * anisotropic: wood fibres, brushed metal, sand ripples and woven cloth all
 * need far more detail along one axis than the other.
 *
 * All randomness comes from `core/Rand`, keyed by a hash of
 * (seed, fx, fy, salt), so lattices are identical no matter what order the
 * material library happens to build them in.
 */

interface AxisTable {
  /** Lattice index of the cell the texel falls in. */
  i0: Int32Array
  /** Lattice index of the next cell, wrapped. */
  i1: Int32Array
  /** Raw fractional position inside the cell. */
  f: Float32Array
  /** Quintic-smoothed fraction, for C2-continuous interpolation. */
  s: Float32Array
}

const AXIS_CACHE = new Map<string, AxisTable>()

/**
 * Precomputes per-texel lattice indices for one axis. Hoisting this out of the
 * inner loop turns noise evaluation into pure array reads and lerps, which is
 * what keeps the whole library inside its init budget.
 */
function axisTable(n: number, freq: number): AxisTable {
  const key = `${n}:${freq}`
  const hit = AXIS_CACHE.get(key)
  if (hit) return hit
  const i0 = new Int32Array(n)
  const i1 = new Int32Array(n)
  const f = new Float32Array(n)
  const s = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    // p / n (not (p + 0.5) / n) so the last texel interpolates back to texel 0.
    const g = (p / n) * freq
    let c = Math.floor(g)
    const frac = g - c
    c = ((c % freq) + freq) % freq
    i0[p] = c
    i1[p] = c + 1 === freq ? 0 : c + 1
    f[p] = frac
    s[p] = frac * frac * frac * (frac * (frac * 6 - 15) + 10)
  }
  const table = { i0, i1, f, s }
  AXIS_CACHE.set(key, table)
  return table
}

/** 8-way gradient set; cheaper and less axis-biased than full random angles. */
const GRAD_X = new Float32Array([1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071])
const GRAD_Y = new Float32Array([0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071])

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: Float32Array
  /** Distance to the second nearest — `f2 - f1` gives clean cell borders. */
  f2: Float32Array
  /** Stable per-cell random value for the owning cell of each texel. */
  id: Float32Array
}

export class Noise {
  private readonly seed: number
  private readonly valueCache = new Map<string, Float32Array>()
  private readonly gradCache = new Map<string, Uint8Array>()
  private readonly cellCache = new Map<string, Float32Array>()

  constructor(seed: number) {
    this.seed = seed >>> 0
  }

  /** Order-independent seed derivation, so lattice creation order cannot matter. */
  private derive(fx: number, fy: number, salt: number): number {
    let h = this.seed >>> 0
    h = (Math.imul(h ^ (fx | 0), 0x9e3779b1) ^ (h >>> 13)) >>> 0
    h = (Math.imul(h ^ (fy | 0), 0x85ebca6b) ^ (h >>> 11)) >>> 0
    h = (Math.imul(h ^ ((salt | 0) + 0x1234567), 0xc2b2ae35) ^ (h >>> 15)) >>> 0
    return h >>> 0
  }

  /** A `Rand` bound to this noise field, for generators that need scattered features. */
  rand(salt: number): Rand {
    return new Rand(this.derive(7919, 104729, salt))
  }

  private valueLattice(fx: number, fy: number, salt: number): Float32Array {
    const key = `${fx}:${fy}:${salt}`
    const hit = this.valueCache.get(key)
    if (hit) return hit
    const r = new Rand(this.derive(fx, fy, salt))
    const out = new Float32Array(fx * fy)
    for (let i = 0; i < out.length; i++) out[i] = r.next()
    this.valueCache.set(key, out)
    return out
  }

  private gradLattice(fx: number, fy: number, salt: number): Uint8Array {
    const key = `${fx}:${fy}:${salt}`
    const hit = this.gradCache.get(key)
    if (hit) return hit
    const r = new Rand(this.derive(fx, fy, salt ^ 0x5f5f))
    const out = new Uint8Array(fx * fy)
    for (let i = 0; i < out.length; i++) out[i] = r.int(0, 7)
    this.gradCache.set(key, out)
    return out
  }

  /** Feature points for cellular noise: `[jx, jy, id]` per cell. */
  private cellLattice(fx: number, fy: number, salt: number): Float32Array {
    const key = `${fx}:${fy}:${salt}`
    const hit = this.cellCache.get(key)
    if (hit) return hit
    const r = new Rand(this.derive(fx, fy, salt ^ 0x1b1b))
    const out = new Float32Array(fx * fy * 3)
    for (let i = 0; i < fx * fy; i++) {
      out[i * 3] = r.next()
      out[i * 3 + 1] = r.next()
      out[i * 3 + 2] = r.next()
    }
    this.cellCache.set(key, out)
    return out
  }

  // --- Accumulating fills -------------------------------------------------

  /** Adds tileable value noise in `[0, amp]` into `out`. */
  fillValue(out: Float32Array, w: number, h: number, fx: number, fy: number, salt: number, amp: number): void {
    const lat = this.valueLattice(fx, fy, salt)
    const ax = axisTable(w, fx)
    const ay = axisTable(h, fy)
    const ax0 = ax.i0
    const ax1 = ax.i1
    const axs = ax.s
    for (let y = 0; y < h; y++) {
      const r0 = ay.i0[y] * fx
      const r1 = ay.i1[y] * fx
      const ty = ay.s[y]
      const row = y * w
      for (let x = 0; x < w; x++) {
        const a = ax0[x]
        const b = ax1[x]
        const tx = axs[x]
        const v00 = lat[r0 + a]
        const v10 = lat[r0 + b]
        const v01 = lat[r1 + a]
        const v11 = lat[r1 + b]
        const lo = v00 + (v10 - v00) * tx
        const hi = v01 + (v11 - v01) * tx
        out[row + x] += (lo + (hi - lo) * ty) * amp
      }
    }
  }

  /** Adds tileable Perlin gradient noise in roughly `[-amp, amp]` into `out`. */
  fillPerlin(out: Float32Array, w: number, h: number, fx: number, fy: number, salt: number, amp: number): void {
    const lat = this.gradLattice(fx, fy, salt)
    const ax = axisTable(w, fx)
    const ay = axisTable(h, fy)
    const k = amp * 1.4142
    for (let y = 0; y < h; y++) {
      const r0 = ay.i0[y] * fx
      const r1 = ay.i1[y] * fx
      const fy0 = ay.f[y]
      const fy1 = fy0 - 1
      const ty = ay.s[y]
      const row = y * w
      for (let x = 0; x < w; x++) {
        const a = ax.i0[x]
        const b = ax.i1[x]
        const fx0 = ax.f[x]
        const fx1 = fx0 - 1
        const tx = ax.s[x]
        const g00 = lat[r0 + a]
        const g10 = lat[r0 + b]
        const g01 = lat[r1 + a]
        const g11 = lat[r1 + b]
        const d00 = GRAD_X[g00] * fx0 + GRAD_Y[g00] * fy0
        const d10 = GRAD_X[g10] * fx1 + GRAD_Y[g10] * fy0
        const d01 = GRAD_X[g01] * fx0 + GRAD_Y[g01] * fy1
        const d11 = GRAD_X[g11] * fx1 + GRAD_Y[g11] * fy1
        const lo = d00 + (d10 - d00) * tx
        const hi = d01 + (d11 - d01) * tx
        out[row + x] += (lo + (hi - lo) * ty) * k
      }
    }
  }

  // --- Composite fields ---------------------------------------------------

  /** Fractal Brownian motion built from value noise. Result is `0..1`. */
  fbm(w: number, h: number, fx: number, fy: number, octaves: number, gain = 0.5, salt = 0): Float32Array {
    const out = new Float32Array(w * h)
    let ox = fx
    let oy = fy
    let amp = 1
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      this.fillValue(out, w, h, ox, oy, salt * 31 + i, amp)
      norm += amp
      ox *= 2
      oy *= 2
      amp *= gain
    }
    const inv = 1 / norm
    for (let i = 0; i < out.length; i++) out[i] *= inv
    return out
  }

  /** fBm built from gradient noise — smoother, better for large soft blotching. */
  fbmPerlin(w: number, h: number, fx: number, fy: number, octaves: number, gain = 0.5, salt = 0): Float32Array {
    const out = new Float32Array(w * h)
    let ox = fx
    let oy = fy
    let amp = 1
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      this.fillPerlin(out, w, h, ox, oy, salt * 31 + i, amp)
      norm += amp
      ox *= 2
      oy *= 2
      amp *= gain
    }
    const inv = 0.5 / norm
    for (let i = 0; i < out.length; i++) {
      const v = out[i] * inv + 0.5
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    return out
  }

  /**
   * Ridged multifractal. Sharp creases rather than blobs — this is what makes
   * cracked plaster, rock and crumpled fabric read correctly.
   */
  ridged(w: number, h: number, fx: number, fy: number, octaves: number, gain = 0.5, salt = 0): Float32Array {
    const out = new Float32Array(w * h)
    const scratch = new Float32Array(w * h)
    let ox = fx
    let oy = fy
    let amp = 1
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      scratch.fill(0)
      this.fillValue(scratch, w, h, ox, oy, salt * 37 + i + 3, 1)
      for (let p = 0; p < out.length; p++) {
        const r = 1 - Math.abs(scratch[p] * 2 - 1)
        out[p] += r * r * amp
      }
      norm += amp
      ox *= 2
      oy *= 2
      amp *= gain
    }
    const inv = 1 / norm
    for (let i = 0; i < out.length; i++) out[i] *= inv
    return out
  }

  /**
   * Tileable Worley/cellular noise. `jitter` 0 gives a perfect grid, 1 gives
   * fully scattered feature points.
   */
  worley(w: number, h: number, fx: number, fy: number, salt = 0, jitter = 1): WorleyResult {
    const cells = this.cellLattice(fx, fy, salt)
    const f1 = new Float32Array(w * h)
    const f2 = new Float32Array(w * h)
    const id = new Float32Array(w * h)
    const sx = fx / w
    const sy = fy / h
    // Cells are rarely square in texel space; measure distance in cell units of
    // the *shorter* axis so anisotropic grids still produce round features.
    const aspect = fy / fx
    for (let y = 0; y < h; y++) {
      const gy = y * sy
      const cy = Math.floor(gy)
      const row = y * w
      for (let x = 0; x < w; x++) {
        const gx = x * sx
        const cx = Math.floor(gx)
        let best = 1e9
        let second = 1e9
        let bestId = 0
        for (let oy = -1; oy <= 1; oy++) {
          const wy = ((cy + oy) % fy + fy) % fy
          for (let ox = -1; ox <= 1; ox++) {
            const wx = ((cx + ox) % fx + fx) % fx
            const ci = (wy * fx + wx) * 3
            const px = cx + ox + 0.5 + (cells[ci] - 0.5) * jitter
            const py = cy + oy + 0.5 + (cells[ci + 1] - 0.5) * jitter
            const dx = px - gx
            const dy = (py - gy) / aspect
            const d = dx * dx + dy * dy
            if (d < best) {
              second = best
              best = d
              bestId = cells[ci + 2]
            } else if (d < second) {
              second = d
            }
          }
        }
        f1[row + x] = Math.sqrt(best)
        f2[row + x] = Math.sqrt(second)
        id[row + x] = bestId
      }
    }
    return { f1, f2, id }
  }
}
