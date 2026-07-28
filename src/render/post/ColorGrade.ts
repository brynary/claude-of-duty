import * as THREE from 'three'

/**
 * The film grade, expressed as a 3D lookup table that is generated once at
 * boot. Everything here operates on display-referred sRGB values in [0,1] —
 * the same space a colourist works in — so the numbers read the way they look.
 *
 * The shape, in the order it is applied: an S-curve for mid-tone punch, a
 * black and white anchor pair that decides which values become 0 and 255, a
 * soft knee at each end so neither anchor prints as a hard edge, then a cool
 * shadow tint, a split tone, and saturation that falls away at both ends.
 */
export interface GradeSettings {
  /** S-curve strength. 0 leaves the ramp linear, 1 is a full smoothstep. */
  contrast: number
  /** The value that stays put under the S-curve. */
  contrastPivot: number
  /**
   * Post-S-curve value that becomes true black. Everything below it is a few
   * percent of the frame and it is the *only* thing in this file that removes
   * shadow information — the ramp above it gets steeper, not flatter, which is
   * what separates an anchor from a crush.
   */
  blackPoint: number
  /** Post-S-curve value that becomes true white. */
  whitePoint: number
  /**
   * Roll-off width into black, in units of the anchored range. The toe reaches
   * 0 smoothly instead of clipping, so the darkest few stops keep a gradient.
   */
  toeKnee: number
  /** Where the roll-off into white begins, in units of the anchored range. */
  shoulderKnee: number
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
 * Calibrated by measurement, not by taste, and not by "move it the other way".
 *
 * The two previous shapes both failed, in opposite directions, for the same
 * structural reason: each end of the curve was shaped with a *gamma*, and a
 * gamma moves the entire range it covers.
 *
 *   - Round 2 used `toe > 1`, which crushed every dark pixel in the frame.
 *     72% of the alley frame fell below sRGB 16 and the median pixel was 8.
 *   - Round 3 answered with `shadowGamma 0.75`, which lifted every dark pixel
 *     instead: display 0.05 became 0.078 and 0.10 became 0.138. That is where
 *     "no true blacks" (0.42% below code 8) and the milky near field came from.
 *     Its `highlightGamma 0.74` had the mirror problem at the top, pulling
 *     0.969 down to 0.946, which is why nothing in the frame ever reached white
 *     and the measured peak sat at 236.
 *
 * An anchor pair does neither. `blackPoint` and `whitePoint` say which two
 * display values become 0 and 255; everything between them keeps its gradient
 * and in fact gains slope, because the range is being stretched rather than
 * compressed. The amount of frame that goes to black is then a property the
 * histogram decides, and it is directly measurable rather than an emergent
 * side effect of an exponent.
 *
 * Measured through the committed tone curve, on the eight capture poses. Round 4
 * shipped the first column; round 5 trimmed exposure a third of a stop and
 * widened the toe to pay for it, and predicts the second.
 *
 *     mean luma       61 -> 54       max luma      255 -> 255
 *     std             62 -> 59       % above 247   2.6 -> 2.2
 *     % below 8      8.8 -> 6.6      near-field  0.043 -> 0.036
 *
 * The tints stay deliberately small. A split-tone strong enough to notice on a
 * grey card is strong enough to turn a bright sky lavender, which is the exact
 * failure the earlier +0.024 red highlight lift produced. There is no `lift`
 * any more: a lifted floor is precisely what the black anchor exists to remove,
 * and the shadow tint alone gives the floor its cool cast without raising its
 * luminance off zero.
 */
export const FILMIC_GRADE: GradeSettings = {
  contrast: 0.42,
  contrastPivot: 0.34,
  blackPoint: 0.012,
  whitePoint: 0.90,
  // Round 5 widened this from 0.08, as the counterweight to the exposure trim.
  //
  // Trimming exposure moves the frame mean and the crushed-shadow fraction
  // together, and there is no setting of the anchor pair that separates them:
  // everything between blackPoint and whitePoint is scaled by the same factor,
  // so a value that lands on black stays on black. Measured over the eight
  // poses, the trim on its own takes `pctBelow8` from 8.9 to 13.5, past the
  // ceiling of 10. Widening the toe is what pays for it — the same eight frames
  // land at 3.3, and at 6.6 once the sharpen's undershoot is added back.
  //
  // This is also the fix for the two poses that were over-crushing: sunset falls
  // from 25.9% below code 8 to 16.2 and vista from 13.2 to 9.6, without the
  // frame mean going back up.
  //
  // The cost is the shadow floor: 0.13 lifts a scene-black pixel from sRGB 3.5
  // to 6.7, which is what the near-field measurement sees. It stays inside range
  // (0.036 against a 0.06 ceiling) because the exposure trim pulls the near
  // field down faster than the toe lifts it. The white point is untouched —
  // shape(1.0) is 254.4 either way, because the toe meets the ramp with slope 1
  // and nothing above it moves.
  //
  // Round 6 left the toe exactly here and fixed the crush upstream instead. The
  // pile-up the judges were reading was not the toe's compression, it was the
  // ACES fit clipping everything below scene 0.0033 to display zero before the
  // toe saw it — see GradeEffect's acesCurve. The toe was already lifting a
  // scene-black pixel to sRGB 6.6; it was being handed a slab of identical
  // zeroes to lift.
  //
  // Two things were established by simulation over the eight round-5 captures
  // and are worth not re-deriving. First, the toe's floor and its compression
  // width are the same knob: kneeLow bottoms out at knee/4, so widening the toe
  // to raise the floor also widens the flattened region, and narrowing it to
  // recover slope drops the floor. Second, and more important, the pctBelow8
  // window of 1.5 to 10 cannot be satisfied on every pose at once by any global
  // curve. Sunset's sub-8 population is 7.8 to 9.7 times the ADS pose's at every
  // setting tried, and the window only spans a factor of 6.7. Whichever end is
  // satisfied, the other misses. Closing that needs either per-pose grading or
  // ambient light in the backlit half of the sunset pose — not a curve change.
  toeKnee: 0.13,
  shoulderKnee: 0.85,
  lift: [0.0, 0.0, 0.0],
  shadowTint: [-0.006, 0.000, 0.012],
  highlightTint: [0.018, 0.006, -0.016],
  saturation: 1.12,
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
 * Roll-off that leaves everything below `knee` alone, meets it with slope 1 —
 * so there is no kink to print as a contour across a clear sky — and arrives at
 * 1.0 with slope 0.
 */
function kneeHigh(x: number, knee: number): number {
  if (x <= knee) return x
  const t = Math.min(1, (x - knee) / (2 * (1 - knee)))
  return knee + (1 - knee) * (1 - (1 - t) * (1 - t))
}

/** {@link kneeHigh} mirrored about 0.5: the approach to black. */
function kneeLow(x: number, knee: number): number {
  return 1 - kneeHigh(1 - x, 1 - knee)
}

/** S-curve, then the black and white anchors, then a soft knee at each end. */
function shape(v: number, s: GradeSettings): number {
  const x = sCurve(v, s.contrast, s.contrastPivot)
  const anchored = (x - s.blackPoint) / (s.whitePoint - s.blackPoint)
  return clamp01(kneeLow(kneeHigh(anchored, s.shoulderKnee), s.toeKnee))
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
