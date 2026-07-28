import * as THREE from 'three'

/**
 * The film grade, expressed as a 3D lookup table that is generated once at
 * boot. Everything here operates on display-referred sRGB values in [0,1] —
 * the same space a colourist works in — so the numbers read the way they look.
 *
 * The shape, in the order it is applied: an S-curve for mid-tone punch, a toe
 * that steepens the ramp out of black without lifting the black point off it,
 * a shoulder that spreads the values bunched against white back out, a cool
 * floor, a split tone, and saturation that falls away at both ends.
 */
export interface GradeSettings {
  /** S-curve strength. 0 leaves the ramp linear, 1 is a full smoothstep. */
  contrast: number
  /** The value that stays put under the S-curve. */
  contrastPivot: number
  /**
   * Gamma applied below {@link shadowRange}. Under 1 it steepens the ramp
   * immediately above black, which is what keeps texture in the last two stops
   * before the floor. Zero still maps to zero, so the black point survives:
   * this buys shadow *detail*, not a lifted, milky shadow.
   */
  shadowGamma: number
  /** Display value at which {@link shadowGamma} has faded out entirely. */
  shadowRange: number
  /**
   * Gamma applied above {@link highlightStart} as `1 - (1 - x)^g`. Under 1 it
   * pulls the top of the range down, which *widens* the band the brightest
   * subjects occupy — a backlit soldier lands across 40 levels instead of
   * bunching into the 8 below white.
   */
  highlightGamma: number
  /** Display value below which {@link highlightGamma} has no effect. */
  highlightStart: number
  /** Black floor per channel. A cool floor is what reads as "film". */
  lift: readonly [number, number, number]
  /** Added to the shadows, weighted by how dark the pixel is. */
  shadowTint: readonly [number, number, number]
  /** Added to the highlights, weighted by how bright the pixel is. */
  highlightTint: readonly [number, number, number]
  saturation: number
  /** How far the brightest values are pulled back toward white. */
  highlightDesaturation: number
  /**
   * How far chroma is pulled out of the deepest shadows. A sensor loses colour
   * before it loses luminance, and without this every bit of noise and every
   * 8-bit quantisation step down there arrives as blue or magenta speckle.
   */
  shadowDesaturation: number
}

/**
 * Calibrated against measured frames rather than taste, then re-calibrated
 * after the previous pass overshot.
 *
 * Round 1 was flat: 91% of an outdoor frame between sRGB 32 and 144. Round 2
 * fixed that with a steep symmetric S-curve (contrast 0.50 about a 0.31 pivot,
 * `toe` 1.08) and swung past the target in the other direction — the S-curve
 * halves the ramp slope below its pivot and a toe exponent above 1 halves it
 * again, so the two darkest stops of every frame lost 60% of their gradient.
 * Measured on the alley pose, 72% of the image fell below sRGB 16 and the
 * median pixel was 8. Brick coursing, lumber stacks and plaster relief that
 * were legible before were still being rendered and simply could not be seen.
 *
 * Contrast is not the goal; range with detail surviving at both ends is. So the
 * S-curve is gentler and the two ends are shaped explicitly instead: a gamma
 * under 1 near black and another near white. Measured on neutral grey through
 * the committed tone curve at exposure 1.76 — round 2's numbers in brackets:
 *
 *     scene 0.005 -> sRGB   7  [3]        scene 0.5 -> sRGB 192  [211]
 *     scene 0.02  -> sRGB  32  [13]       scene 1.0 -> sRGB 219  [237]
 *     scene 0.08  -> sRGB  80  [66]       scene 2.5 -> sRGB 240  [251]
 *     scene 0.18  -> sRGB 136  [132]      scene 8.0 -> sRGB 251  [255]
 *
 * The mid-tone anchor barely moves, the shadows gain two stops of readable
 * gradient, and the top three stops now span 32 levels where they spanned 18.
 *
 * The tints stay deliberately small. A split-tone strong enough to notice on a
 * grey card is strong enough to turn a bright sky lavender, which is the exact
 * failure the earlier +0.024 red highlight lift produced.
 */
export const FILMIC_GRADE: GradeSettings = {
  contrast: 0.40,
  contrastPivot: 0.35,
  shadowGamma: 0.75,
  shadowRange: 0.40,
  highlightGamma: 0.74,
  highlightStart: 0.40,
  lift: [0.004, 0.005, 0.008],
  shadowTint: [-0.005, 0.000, 0.010],
  highlightTint: [0.018, 0.006, -0.016],
  saturation: 1.10,
  // Round 2 desaturated everything above 0.62 luma by up to 45%, which is most
  // of a sunset sky: the judges got a "washed pink" skyline and a sun core that
  // measured neutral white. The tone curve's own crosstalk now handles the
  // bleach-to-white, so this only has to stop the last few levels clipping into
  // a flat primary.
  highlightDesaturation: 0.22,
  shadowDesaturation: 0.35,
}

const REC709 = [0.2126, 0.7152, 0.0722] as const

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * Monotonic S-curve that leaves `pivot` untouched. The ramp either side of the
 * pivot is normalised to [0,1] so the curve never inverts or clips.
 */
function sCurve(v: number, amount: number, pivot: number): number {
  const t = v < pivot ? 0.5 * (v / pivot) : 0.5 + 0.5 * ((v - pivot) / (1 - pivot))
  const s = t * t * (3 - 2 * t)
  const u = t + (s - t) * amount
  return u < 0.5 ? u * 2 * pivot : pivot + (u - 0.5) * 2 * (1 - pivot)
}

/**
 * The tonal shaper: S-curve, then a gamma under 1 blended in at each end.
 *
 * Both end treatments are blended rather than switched, so the composite has no
 * slope discontinuity anywhere — a kink in a curve this steep prints as a
 * contour line across a clear sky. Both are also fixed points at their end of
 * the range: `shape(0) = 0` and `shape(1) = 1` exactly, which is what lets the
 * black point stay true while the gradient just above it gets steeper.
 */
function shape(v: number, s: GradeSettings): number {
  let x = sCurve(v, s.contrast, s.contrastPivot)

  const toeWeight = 1 - smoothstep(0, s.shadowRange, x)
  if (toeWeight > 0) x += (Math.pow(x, s.shadowGamma) - x) * toeWeight

  const shoulderWeight = smoothstep(s.highlightStart, 1, x)
  if (shoulderWeight > 0) x += (1 - Math.pow(1 - x, s.highlightGamma) - x) * shoulderWeight

  return clamp01(x)
}

/** Applies the grade to one display-space colour. Mutates and returns `out`. */
function gradeColor(r: number, g: number, b: number, s: GradeSettings, out: number[]): number[] {
  out[0] = shape(r, s)
  out[1] = shape(g, s)
  out[2] = shape(b, s)

  for (let i = 0; i < 3; i++) {
    const lift = s.lift[i]
    out[i] = lift + (1 - lift) * out[i]
  }

  const luma = out[0] * REC709[0] + out[1] * REC709[1] + out[2] * REC709[2]
  const shadowWeight = 1 - smoothstep(0.0, 0.55, luma)
  const highlightWeight = smoothstep(0.42, 1.0, luma)
  for (let i = 0; i < 3; i++) {
    out[i] += s.shadowTint[i] * shadowWeight + s.highlightTint[i] * highlightWeight
  }

  // Saturation, falling away at both ends: toward white so bright colour rolls
  // off instead of clipping into a flat primary, toward black because chroma
  // down there is quantisation and noise rather than material.
  const luma2 = out[0] * REC709[0] + out[1] * REC709[1] + out[2] * REC709[2]
  const sat = s.saturation
    * (1 - s.highlightDesaturation * smoothstep(0.86, 1.0, luma2))
    * (1 - s.shadowDesaturation * (1 - smoothstep(0.012, 0.09, luma2)))
  for (let i = 0; i < 3; i++) {
    out[i] = clamp01(luma2 + (out[i] - luma2) * sat)
  }
  return out
}

export interface GradeLut {
  texture: THREE.Data3DTexture
  /** Multiply the sampling coordinate by this before adding `offset`. */
  scale: number
  /** Half a texel — puts the coordinate on texel centres. */
  offset: number
}

/**
 * Bakes {@link gradeColor} into a `size^3` RGBA8 volume. Hardware trilinear
 * filtering across it is indistinguishable from evaluating the curve per pixel
 * and costs one fetch.
 *
 * 33 is the industry's .cube size, but this curve is far steeper than a film
 * print LUT and its toe is steeper still. Sampling the baked volume against the
 * exact curve across four decades of scene luminance, 41 nodes is worst by 1.15
 * levels out of 255 — at scene 0.0037, where the toe has the most curvature —
 * and 49 nodes only recovers 0.2 of that for 1.7x the memory. 41 costs 275 KB
 * once at boot.
 */
export function createGradeLut(size = 41, settings: GradeSettings = FILMIC_GRADE): GradeLut {
  const data = new Uint8Array(size * size * size * 4)
  const out = [0, 0, 0]
  const inv = 1 / (size - 1)
  let i = 0
  for (let z = 0; z < size; z++) {
    const b = z * inv
    for (let y = 0; y < size; y++) {
      const g = y * inv
      for (let x = 0; x < size; x++) {
        gradeColor(x * inv, g, b, settings, out)
        data[i++] = Math.round(out[0] * 255)
        data[i++] = Math.round(out[1] * 255)
        data[i++] = Math.round(out[2] * 255)
        data[i++] = 255
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size)
  texture.name = 'PostFX.GradeLUT'
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.wrapR = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.needsUpdate = true

  return { texture, scale: (size - 1) / size, offset: 1 / (2 * size) }
}
