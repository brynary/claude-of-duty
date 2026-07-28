/**
 * Scalar/colour field arithmetic for the procedural texture pipeline.
 *
 * A "field" is just a `Float32Array` of `w * h` values, and a colour field is
 * `w * h * 3` linear RGB. Every operator here wraps at the edges so a tileable
 * input stays tileable after blurring, warping or edge detection.
 */

export type Field = Float32Array
/** Interleaved linear RGB, three floats per texel. */
export type ColorField = Float32Array

export function field(w: number, h: number, fill = 0): Field {
  const f = new Float32Array(w * h)
  if (fill !== 0) f.fill(fill)
  return f
}

export function colorField(w: number, h: number): ColorField {
  return new Float32Array(w * h * 3)
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const saturate = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1
  const t = saturate((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** sRGB hex (what a colour picker shows) to linear RGB, the space we author in. */
export function linearFromHex(hex: number): [number, number, number] {
  const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return [dec(((hex >> 16) & 255) / 255), dec(((hex >> 8) & 255) / 255), dec((hex & 255) / 255)]
}

const SRGB_LUT = (() => {
  const lut = new Uint8Array(4096)
  for (let i = 0; i < 4096; i++) {
    const l = i / 4095
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
    lut[i] = Math.round(saturate(s) * 255)
  }
  return lut
})()

/** Linear reflectance to an sRGB byte, via LUT because this runs per texel. */
export function encodeSrgb(linear: number): number {
  return SRGB_LUT[(saturate(linear) * 4095) | 0]
}

// --- Field operators ------------------------------------------------------

/** Remaps `[lo, hi]` onto `[0, 1]`, clamping outside. Sharpens flat noise. */
export function remap(f: Field, lo: number, hi: number): Field {
  const inv = 1 / (hi - lo || 1e-6)
  for (let i = 0; i < f.length; i++) f[i] = saturate((f[i] - lo) * inv)
  return f
}

/** Stretches the field to fill `[0, 1]` using its own extremes. */
export function normalize01(f: Field): Field {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo) lo = f[i]
    if (f[i] > hi) hi = f[i]
  }
  return remap(f, lo, hi)
}

export function contrast(f: Field, amount: number, pivot = 0.5): Field {
  for (let i = 0; i < f.length; i++) f[i] = saturate((f[i] - pivot) * amount + pivot)
  return f
}

export function powField(f: Field, e: number): Field {
  for (let i = 0; i < f.length; i++) f[i] = Math.pow(saturate(f[i]), e)
  return f
}

export function smoothstepField(f: Field, e0: number, e1: number): Field {
  for (let i = 0; i < f.length; i++) f[i] = smoothstep(e0, e1, f[i])
  return f
}

export function copyField(f: Field): Field {
  return new Float32Array(f)
}

// --- Filtering ------------------------------------------------------------

/** Separable wrapped box blur. Two passes approximate a Gaussian closely enough. */
export function boxBlur(src: Field, w: number, h: number, radius: number, passes = 2): Field {
  if (radius < 1) return copyField(src)
  let a = copyField(src)
  let b = field(w, h)
  const r = Math.min(Math.floor(radius), Math.floor(Math.min(w, h) / 2) - 1)
  const inv = 1 / (r * 2 + 1)
  for (let p = 0; p < passes; p++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let k = -r; k <= r; k++) sum += a[row + (((k % w) + w) % w)]
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * inv
        const add = a[row + (((x + r + 1) % w) + w) % w]
        const sub = a[row + (((x - r) % w) + w) % w]
        sum += add - sub
      }
    }
    // Vertical.
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += b[(((k % h) + h) % h) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * inv
        const add = b[((((y + r + 1) % h) + h) % h) * w + x]
        const sub = b[((((y - r) % h) + h) % h) * w + x]
        sum += add - sub
      }
    }
  }
  b = a
  return b
}

export function bilinearWrap(src: Field, w: number, h: number, x: number, y: number): number {
  let x0 = Math.floor(x)
  let y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  x0 = ((x0 % w) + w) % w
  y0 = ((y0 % h) + h) % h
  const x1 = x0 + 1 === w ? 0 : x0 + 1
  const y1 = y0 + 1 === h ? 0 : y0 + 1
  const r0 = y0 * w
  const r1 = y1 * w
  const a = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * tx
  const b = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * tx
  return a + (b - a) * ty
}

// --- Derived maps ---------------------------------------------------------

/**
 * Sobel height-to-normal. Writes an RGBA tangent-space normal map in the
 * OpenGL convention (green = +V), which is what three.js expects.
 *
 * `strength` is resolution independent: it is scaled by `size / 256` so a
 * recipe looks the same whether it bakes at 256 or 512.
 */
export function heightToNormalRGBA(h: Field, w: number, ht: number, strength: number): Uint8Array {
  const out = new Uint8Array(w * ht * 4)
  const k = strength * (w / 256)
  for (let y = 0; y < ht; y++) {
    const ym = ((y - 1 + ht) % ht) * w
    const yp = ((y + 1) % ht) * w
    const yc = y * w
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w
      const xp = (x + 1) % w
      const gx =
        h[ym + xp] + 2 * h[yc + xp] + h[yp + xp] - (h[ym + xm] + 2 * h[yc + xm] + h[yp + xm])
      const gy =
        h[yp + xm] + 2 * h[yp + x] + h[yp + xp] - (h[ym + xm] + 2 * h[ym + x] + h[ym + xp])
      let nx = -gx * 0.25 * k
      let ny = -gy * 0.25 * k
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      nx *= inv
      ny *= inv
      const nz = inv
      const o = (yc + x) * 4
      out[o] = ((nx * 0.5 + 0.5) * 255) | 0
      out[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0
      out[o + 2] = ((nz * 0.5 + 0.5) * 255) | 0
      out[o + 3] = 255
    }
  }
  return out
}

/**
 * Multi-scale ambient occlusion from a height field. Each scale compares the
 * height against a blurred version of itself: anything sitting below its local
 * neighbourhood is occluded. Cheap, stable, and closer to a real AO bake than
 * a single cavity pass because it captures both tight creases and broad dishes.
 */
export function aoFromHeight(h: Field, w: number, ht: number, strength = 1, scale = 1): Field {
  const radii = [2, 5, 12, 26]
  const weights = [0.4, 0.3, 0.2, 0.1]
  const ao = field(w, ht, 1)
  const px = Math.max(1, w / 256) * scale
  for (let s = 0; s < radii.length; s++) {
    const r = Math.max(1, Math.round(radii[s] * px))
    if (r >= Math.min(w, ht) / 2) continue
    const blurred = boxBlur(h, w, ht, r, 2)
    const k = weights[s] * strength * 2.2
    for (let i = 0; i < ao.length; i++) {
      const d = blurred[i] - h[i]
      if (d > 0) ao[i] -= d * k
    }
  }
  for (let i = 0; i < ao.length; i++) ao[i] = clamp(ao[i], 0.06, 1)
  return ao
}

/**
 * Curvature: positive on ridges and exposed corners, negative in crevices.
 * Edge wear keys off the positive lobe, grime off the negative one — that pair
 * of masks is most of what makes a surface look like it has a history.
 */
export function curvature(h: Field, w: number, ht: number, radius = 4): Field {
  const blurred = boxBlur(h, w, ht, Math.max(1, Math.round(radius * (w / 256))), 2)
  const out = field(w, ht)
  for (let i = 0; i < out.length; i++) out[i] = h[i] - blurred[i]
  return out
}

/** Positive-only curvature, normalised — "how exposed is this texel". */
export function convexMask(h: Field, w: number, ht: number, radius = 4, gain = 12): Field {
  const c = curvature(h, w, ht, radius)
  for (let i = 0; i < c.length; i++) c[i] = saturate(c[i] * gain)
  return c
}

// --- Colour field operators ----------------------------------------------

export function fillColor(c: ColorField, rgb: readonly [number, number, number]): ColorField {
  for (let i = 0; i < c.length; i += 3) {
    c[i] = rgb[0]
    c[i + 1] = rgb[1]
    c[i + 2] = rgb[2]
  }
  return c
}

/** Blends a flat colour over the field using a per-texel mask. */
export function mixColor(c: ColorField, rgb: readonly [number, number, number], mask: Field, amount = 1): ColorField {
  const n = mask.length
  for (let p = 0; p < n; p++) {
    const t = mask[p] * amount
    if (t <= 0) continue
    const i = p * 3
    c[i] += (rgb[0] - c[i]) * t
    c[i + 1] += (rgb[1] - c[i + 1]) * t
    c[i + 2] += (rgb[2] - c[i + 2]) * t
  }
  return c
}

/** Per-texel multiply, used for AO bake-in and value breakup. */
export function modulateColor(c: ColorField, f: Field, amount = 1): ColorField {
  const n = f.length
  for (let p = 0; p < n; p++) {
    const m = 1 + (f[p] - 1) * amount
    const i = p * 3
    c[i] *= m
    c[i + 1] *= m
    c[i + 2] *= m
  }
  return c
}

/** Adds an achromatic value offset — cheap tonal breakup without hue shift. */
export function offsetColor(c: ColorField, f: Field, amount: number, bias = 0.5): ColorField {
  const n = f.length
  for (let p = 0; p < n; p++) {
    const d = (f[p] - bias) * amount
    const i = p * 3
    c[i] += d
    c[i + 1] += d
    c[i + 2] += d
  }
  return c
}
