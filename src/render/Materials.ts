import * as THREE from 'three'
import type { GameContext, System, MaterialService } from '../core/Types'

/**
 * Procedural PBR material library. Every surface in the level is authored here
 * so the whole game shares one consistent albedo/roughness/normal vocabulary.
 *
 * STUB — replaced by the materials pass.
 */
export class MaterialSystem implements System, MaterialService {
  readonly name = 'materials'
  private cache = new Map<string, THREE.Material>()

  init(ctx: GameContext): void {
    ctx.services.materials = this
  }

  get(name: string): THREE.Material {
    let m = this.cache.get(name)
    if (m) return m
    m = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.9, metalness: 0.0 })
    m.name = name
    this.cache.set(name, m)
    return m
  }

  names(): string[] {
    return [...this.cache.keys()]
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    this.cache.clear()
  }
}
