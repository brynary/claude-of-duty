import * as THREE from 'three'
import type { GameContext, System, MaterialService } from '../core/Types'
import { MATERIAL_NAMES, surfaceOf, type MaterialName } from './MaterialNames'
import { bakeSurface, type BakedMaps } from './procedural/Bake'
import { Noise } from './procedural/Noise'
import { RECIPES, type MaterialSpec } from './procedural/Recipes'
import { applyTriplanar } from './procedural/Triplanar'

/**
 * Procedural PBR material library.
 *
 * There are no image files and no network access, so every texel in the game
 * is generated here at startup: tileable noise and structural patterns are
 * composed into a height field, a linear-RGB albedo, roughness and metalness,
 * then baked into three textures per material — sRGB albedo, a tangent-space
 * normal derived by Sobel from the height, and an ORM pack (occlusion,
 * roughness, metalness) that three.js reads natively from R/G/B.
 *
 * Architectural surfaces are projected triplanar in world space rather than
 * through mesh UVs, so texel density is correct in metres no matter how the
 * level was built, and a large-scale world-space variation field breaks up the
 * tile repeat that otherwise gives procedural texturing away.
 *
 * Everything is generated once during `init` and cached for the lifetime of the
 * process; nothing in this system allocates or samples noise per frame.
 */
export class MaterialSystem implements System, MaterialService {
  readonly name = 'materials'

  private readonly cache = new Map<string, THREE.Material>()
  private readonly instancedCache = new Map<string, THREE.Material>()
  private readonly maps = new Map<string, BakedMaps>()
  private readonly textures: THREE.Texture[] = []
  private anisotropy = 8
  private seed = 1337
  private resolutionScale = 1
  /** Textures whose offsets are scrolled to animate water. */
  private waterMaps: BakedMaps | null = null

  init(ctx: GameContext): void {
    ctx.services.materials = this
    this.seed = ctx.config.seed
    this.anisotropy = Math.min(ctx.config.anisotropy, ctx.renderer.capabilities.getMaxAnisotropy())
    this.resolutionScale = ctx.config.quality === 'low' ? 0.5 : 1

    const started = performance.now()
    for (const name of MATERIAL_NAMES) this.cache.set(name, this.build(name))
    const ms = performance.now() - started
    console.info(`[materials] baked ${MATERIAL_NAMES.length} materials in ${ms.toFixed(0)}ms`)
  }

  /**
   * Water is the only surface that moves. Driven from `ctx.elapsed` rather than
   * accumulated `dt` so a frozen capture always lands on the same frame.
   */
  update(_dt: number, ctx: GameContext): void {
    const w = this.waterMaps
    if (!w) return
    const t = ctx.elapsed
    w.normalMap.offset.set(t * 0.021, t * 0.013)
    w.ormMap.offset.set(t * -0.011, t * 0.017)
    w.map.offset.set(t * 0.006, t * 0.004)
  }

  get(name: string): THREE.Material {
    const hit = this.cache.get(name)
    if (hit) return hit
    // An unknown name must not take the whole frame down; fall back to the
    // most neutral surface in the library and say so once.
    console.warn(`[materials] unknown material "${name}", falling back to concrete`)
    const fallback = this.cache.get('concrete') ?? this.build('concrete')
    this.cache.set(name, fallback)
    return fallback
  }

  /**
   * A material for `InstancedMesh` use. Functionally identical to `get`, but a
   * separate instance so a system that tweaks colour or side on its instanced
   * batch cannot disturb the static world geometry sharing the same surface.
   * The GPU textures are shared, so this costs nothing but a uniform block.
   */
  getInstanced(name: string): THREE.Material {
    const hit = this.instancedCache.get(name)
    if (hit) return hit
    const key = (MATERIAL_NAMES as string[]).includes(name) ? (name as MaterialName) : 'concrete'
    const mat = this.build(key)
    this.instancedCache.set(name, mat)
    return mat
  }

  names(): string[] {
    return [...MATERIAL_NAMES]
  }

  /** The physical surface this material behaves as, for impacts and footsteps. */
  surfaceFor(name: string): ReturnType<typeof surfaceOf> {
    return (MATERIAL_NAMES as string[]).includes(name) ? surfaceOf(name as MaterialName) : 'concrete'
  }

  // --- Construction --------------------------------------------------------

  private build(name: MaterialName): THREE.Material {
    const spec = RECIPES[name]
    const maps = this.bake(name, spec)
    const mat = spec.physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial()
    mat.name = name

    mat.map = maps.map
    mat.normalMap = maps.normalMap
    // One ORM texture serves all three: three.js reads occlusion from R,
    // roughness from G and metalness from B, which is exactly how it is packed.
    mat.roughnessMap = maps.ormMap
    mat.metalnessMap = maps.ormMap
    mat.aoMap = maps.ormMap
    // The map channels are multipliers, so the scalar factors must be 1 or the
    // whole authored range is scaled away.
    mat.roughness = 1
    mat.metalness = 1
    const ns = spec.normalScale ?? 1
    mat.normalScale.set(ns, ns)
    mat.aoMapIntensity = spec.aoIntensity ?? 1
    mat.envMapIntensity = 1
    mat.userData.surface = surfaceOf(name)
    mat.userData.materialName = name

    if (spec.params) mat.setValues(spec.params)

    if (spec.triplanar) {
      applyTriplanar(mat, {
        ...spec.triplanar,
        scale: 1 / spec.worldSize,
        offset: this.projectionOffset(name),
      })
    }
    return mat
  }

  /** Textures are baked once per material name and shared by every variant. */
  private bake(name: MaterialName, spec: MaterialSpec): BakedMaps {
    const cached = this.maps.get(name)
    if (cached) return cached

    const size = Math.max(64, Math.round((spec.size * this.resolutionScale) / 64) * 64)
    // Order-independent per-material seeding: the library produces byte-identical
    // textures whatever order materials happen to be requested in.
    const noise = new Noise(hashName(this.seed, name))
    const built = spec.build(noise, size)
    const maps = bakeSurface(built, this.anisotropy)

    const repeat = spec.repeat ?? [1, 1]
    for (const tex of [maps.map, maps.normalMap, maps.ormMap]) {
      tex.repeat.set(repeat[0], repeat[1])
      this.textures.push(tex)
    }
    this.maps.set(name, maps)
    if (name === 'water') this.waterMaps = maps
    return maps
  }

  /**
   * A per-material world-space offset for the triplanar projection. Without it
   * every material's tile grid would start at the world origin and line up,
   * which reads as a grid even when each individual texture is seamless.
   */
  private projectionOffset(name: MaterialName): THREE.Vector3 {
    const h = hashName(this.seed ^ 0x5bf03635, name)
    return new THREE.Vector3(
      ((h & 0x3ff) / 1024) * 64,
      (((h >>> 10) & 0x3ff) / 1024) * 64,
      (((h >>> 20) & 0x3ff) / 1024) * 64,
    )
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    for (const m of this.instancedCache.values()) m.dispose()
    for (const t of this.textures) t.dispose()
    this.cache.clear()
    this.instancedCache.clear()
    this.maps.clear()
    this.textures.length = 0
    this.waterMaps = null
  }
}

/** Stable string hash mixed with the run seed. */
function hashName(seed: number, name: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0
  }
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0
  return (h ^ (h >>> 13)) >>> 0
}
