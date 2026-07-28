import { field, heightToNormalRGBA, saturate, type Field } from './Fields'
import { Noise } from './Noise'

/**
 * The shared micro-detail surface.
 *
 * Every architectural material in the library is projected at somewhere between
 * 250 and 850 texels per metre. That is enough to describe a brick and its
 * mortar, and nowhere near enough to describe the grit on the face of the brick
 * — which is the scale a player is actually looking at when they walk up to a
 * wall. Baking every material at the resolution that would cover it is not an
 * option: it is sixteen times the memory and the bake time for detail that is
 * identical on every surface anyway.
 *
 * So it is generated once, here, and every triplanar material samples it at a
 * high world-space frequency on top of its own maps. One 256-square texture
 * multiplies the apparent texel density of the entire world.
 *
 * The channels are:
 *
 * - **RG** — tangent-space normal of a fine sandblast/pore grain. Added to the
 *   base normal's tangential components, so it never fights the structure the
 *   material already has.
 * - **B** — roughness breakup around 0.5. Real surfaces vary in gloss at
 *   centimetre scale and this is most of what stops PBR reading as plastic.
 * - **A** — a tight cavity mask, for grime that collects in the pores.
 *
 * This previously did not exist: the detail octave re-sampled the material's
 * *own* normal map at a rotated, scaled UV. On a structural pattern that means
 * a miniature copy of the brick courses or the cobble joints laid diagonally
 * across the real ones, which is exactly the diagonal hatching that was
 * visible across the plaza paving.
 */
export function buildDetailNormal(seed: number, size = 256): Uint8Array {
  const n = new Noise(seed)
  // Three decades of grain. The coarsest carries centimetre-scale swell, the
  // finest is at the Nyquist limit of the texture and mips away to nothing —
  // which is the behaviour we want, since it means no shimmer at distance.
  const swell = n.fbmPerlin(size, size, 7, 7, 4, 0.55, 1)
  const pore = n.worley(size, size, 30, 30, 2, 1)
  const grit = n.fbm(size, size, 60, 60, 4, 0.5, 3)
  const scratch = n.ridged(size, size, 40, 40, 3, 0.5, 4)

  const height: Field = field(size, size)
  for (let i = 0; i < height.length; i++) {
    const pit = saturate(1 - pore.f1[i] * 3.4) * (pore.id[i] > 0.42 ? 1 : 0.3)
    height[i] = saturate(
      0.5 + (swell[i] - 0.5) * 0.55 + (grit[i] - 0.5) * 0.5 - pit * 0.34 - saturate(scratch[i] - 0.72) * 0.5,
    )
  }

  const out = heightToNormalRGBA(height, size, size, 1.9)
  // Repack: keep the normal in RG, replace the (unused, always-positive) blue
  // with roughness breakup and the height alpha with a cavity mask.
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const rough = saturate(0.5 + (grit[i] - 0.5) * 1.35 + (swell[i] - 0.5) * 0.7)
    const cavity = saturate(1 - height[i] * 1.7)
    out[o + 2] = (rough * 255) | 0
    out[o + 3] = (cavity * 255) | 0
  }
  return out
}
