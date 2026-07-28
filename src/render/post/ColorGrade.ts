import * as THREE from 'three'

/**
 * The film grade, expressed as a 3D lookup table that is generated once at
 * boot. Everything here operates on display-referred sRGB values in [0,1] —
 * the same space a colourist works in — so the numbers read the way they look.
 *
 * The look: a steep-ish toe that is then lifted off pure black, a cool cast in
 * the shadows, warmth in the highlights, a gentle S-curve for contrast and a
 * film-like path to white in the brightest values.
 */
export interface GradeSettings {
  /** S-curve strength. 0 leaves the ramp linear, 1 is a full smoothstep. */
  contrast: number
  /** The value that stays put under the S-curve. */
  contrastPivot: number
  /** Above 1 crushes the toe before the black floor is lifted. */
  toe: number
  /** Black floor per channel. A cool floor is what reads as "film". */
  lift: readonly [number, number, number]
  /** Added to the shadows, weighted by how dark the pixel is. */
  shadowTint: readonly [number, number, number]
  /** Added to the highlights, weighted by how bright the pixel is. */
  highlightTint: readonly [number, number, number]
  saturation: number
  /** How far the brightest values are pulled back toward white. */
  highlightDesaturation: number
}

/**
 * Tuned against the reference: strong enough to read as a deliberate grade,
 * restrained enough that the frame stays clean. Every number here is small on
 * purpose — the failure mode of a procedural grade is looking like a filter.
 */
export const FILMIC_GRADE: GradeSettings = {
  contrast: 0.26,
  contrastPivot: 0.45,
  toe: 1.06,
  lift: [0.018, 0.023, 0.032],
  shadowTint: [-0.006, 0.002, 0.013],
  highlightTint: [0.024, 0.009, -0.018],
  saturation: 1.07,
  highlightDesaturation: 0.42,
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

/** Applies the grade to one display-space colour. Mutates and returns `out`. */
function gradeColor(r: number, g: number, b: number, s: GradeSettings, out: number[]): number[] {
  out[0] = sCurve(r, s.contrast, s.contrastPivot)
  out[1] = sCurve(g, s.contrast, s.contrastPivot)
  out[2] = sCurve(b, s.contrast, s.contrastPivot)

  // Crushed toe, then a lifted floor. Doing it in this order keeps the deep
  // shadows dense while still never reaching pure black.
  for (let i = 0; i < 3; i++) {
    const lift = s.lift[i]
    out[i] = lift + (1 - lift) * Math.pow(clamp01(out[i]), s.toe)
  }

  const luma = out[0] * REC709[0] + out[1] * REC709[1] + out[2] * REC709[2]
  const shadowWeight = 1 - smoothstep(0.0, 0.55, luma)
  const highlightWeight = smoothstep(0.42, 1.0, luma)
  for (let i = 0; i < 3; i++) {
    out[i] += s.shadowTint[i] * shadowWeight + s.highlightTint[i] * highlightWeight
  }

  // Saturation, backing off in the highlights so bright colour rolls to white
  // instead of clipping into a flat primary.
  const luma2 = out[0] * REC709[0] + out[1] * REC709[1] + out[2] * REC709[2]
  const sat = s.saturation * (1 - s.highlightDesaturation * smoothstep(0.62, 1.0, luma2))
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
 * Bakes {@link gradeColor} into a `size^3` RGBA8 volume. 33 is the size every
 * .cube LUT in the industry uses; hardware trilinear filtering across it is
 * indistinguishable from evaluating the curve per pixel and costs one fetch.
 */
export function createGradeLut(size = 33, settings: GradeSettings = FILMIC_GRADE): GradeLut {
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
