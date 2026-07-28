import * as THREE from 'three'
import { aoFromHeight, clamp, encodeSrgb, heightToNormalRGBA, saturate, type ColorField, type Field } from './Fields'

/**
 * The finished description of one surface, before it becomes GPU textures.
 * Recipes fill this in; `bakeSurface` turns it into the three maps every
 * material in the library uses.
 */
export interface SurfaceBuild {
  size: number
  /** Relief, 0..1. Drives the normal map and the derived ambient occlusion. */
  height: Field
  /** Linear RGB reflectance. */
  albedo: ColorField
  rough: Field
  metal: Field
  /** Optional coverage for alpha-tested materials (foliage, chainlink). */
  alpha?: Field
  /** Extra occlusion multiplied on top of the height-derived AO. */
  ao?: Field
  normalStrength: number
  aoStrength?: number
  /** Scales the AO sampling radii; small for fine grain, large for big forms. */
  aoScale?: number
  /** How much of the baked AO is multiplied into the albedo. */
  aoInAlbedo?: number
}

export interface BakedMaps {
  /** sRGB albedo, alpha carries coverage. */
  map: THREE.DataTexture
  /** Tangent-space normal, OpenGL convention. */
  normalMap: THREE.DataTexture
  /** R = ambient occlusion, G = roughness, B = metalness. */
  ormMap: THREE.DataTexture
}

function makeTexture(data: Uint8Array, size: number, srgb: boolean, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = anisotropy
  // DataTexture is not flipped, so row 0 is v = 0. Every generator in this
  // library assumes that, which is what keeps the normal map's green channel
  // pointing the right way.
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

/**
 * Bakes a surface description into albedo / normal / ORM textures.
 *
 * Albedo is clamped into the range real materials actually occupy. Nothing in
 * the physical world reflects less than about 3% or more than about 88%, and
 * pinning pure black or pure white into a PBR albedo is the fastest way to
 * make a render look like a tech demo.
 */
export function bakeSurface(b: SurfaceBuild, anisotropy: number): BakedMaps {
  const n = b.size * b.size
  const ao = aoFromHeight(b.height, b.size, b.size, b.aoStrength ?? 1, b.aoScale ?? 1)
  if (b.ao) for (let i = 0; i < n; i++) ao[i] = clamp(ao[i] * b.ao[i], 0.05, 1)

  const albedoBytes = new Uint8Array(n * 4)
  const ormBytes = new Uint8Array(n * 4)
  const aoTint = b.aoInAlbedo ?? 0.35

  for (let i = 0; i < n; i++) {
    const shade = 1 + (ao[i] - 1) * aoTint
    const j = i * 3
    const o = i * 4
    albedoBytes[o] = encodeSrgb(clamp(b.albedo[j] * shade, 0.028, 0.88))
    albedoBytes[o + 1] = encodeSrgb(clamp(b.albedo[j + 1] * shade, 0.028, 0.88))
    albedoBytes[o + 2] = encodeSrgb(clamp(b.albedo[j + 2] * shade, 0.028, 0.88))
    albedoBytes[o + 3] = b.alpha ? (saturate(b.alpha[i]) * 255) | 0 : 255
    ormBytes[o] = (ao[i] * 255) | 0
    // Roughness floor: a perfectly smooth microfacet surface aliases badly and
    // reads as glass no matter what the albedo says.
    ormBytes[o + 1] = (clamp(b.rough[i], 0.035, 1) * 255) | 0
    ormBytes[o + 2] = (saturate(b.metal[i]) * 255) | 0
    ormBytes[o + 3] = 255
  }

  const normalBytes = heightToNormalRGBA(b.height, b.size, b.size, b.normalStrength)

  return {
    map: makeTexture(albedoBytes, b.size, true, anisotropy),
    normalMap: makeTexture(normalBytes, b.size, false, anisotropy),
    ormMap: makeTexture(ormBytes, b.size, false, anisotropy),
  }
}
