import * as THREE from 'three'
import { DECAL, type FxTextureSet } from './FxTextures'
import type { Surface } from '../core/Types'

/**
 * Projected surface decals: bullet holes, blood and scorch marks.
 *
 * One `InstancedMesh` of unit quads carries every decal. Each instance is
 * oriented so its +Z faces along the surface normal and pushed a fraction of a
 * millimetre off the surface; a negative polygon offset finishes the job so
 * decals never z-fight even at grazing angles.
 *
 * The material is a real `MeshStandardMaterial` with the atlas normal map, so a
 * bullet hole is lit and shadowed exactly like the wall it sits on — a flat
 * unlit sticker reads as fake instantly. Per-instance tile selection, tint and
 * fade are injected into the standard shader.
 */

export type DecalKind = keyof typeof DECAL

interface Slot {
  /** Simulation time at which the decal was placed. */
  born: number
  /** Seconds before the decal starts fading. */
  hold: number
  fade: number
  /** Live decals are recycled oldest-first once the budget is exhausted. */
  active: boolean
  opacity: number
}

/** How far ahead of the ring head decals begin fading out. */
const RETIRE_LOOKAHEAD = 10

const HOLE_BY_SURFACE: Record<Surface, DecalKind[]> = {
  concrete: ['holeConcreteA', 'holeConcreteB'],
  plaster: ['holePlaster', 'holeConcreteB'],
  tile: ['holeConcreteB', 'holePlaster'],
  metal: ['holeMetal'],
  thinMetal: ['holeMetal'],
  wood: ['holeWood'],
  glass: ['holeGlass'],
  dirt: ['holeDirt'],
  sand: ['holeDirt', 'dustSplat'],
  gravel: ['holeDirt', 'holeConcreteA'],
  flesh: ['bloodA', 'bloodB'],
  water: ['waterRing'],
  fabric: ['holeDirt'],
  rubber: ['holeMetal'],
  foliage: ['holeFoliage'],
}

export class Decals {
  private readonly mesh: THREE.InstancedMesh
  private readonly material: THREE.MeshStandardMaterial
  private readonly tile: THREE.InstancedBufferAttribute
  private readonly tint: THREE.InstancedBufferAttribute
  private readonly slots: Slot[] = []
  private readonly capacity: number
  private head = 0
  private tintDirty = false

  private readonly m4 = new THREE.Matrix4()
  private readonly quat = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3()
  private readonly pos = new THREE.Vector3()
  private readonly zAxis = new THREE.Vector3(0, 0, 1)
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly tangent = new THREE.Vector3()
  private readonly bitangent = new THREE.Vector3()
  private readonly basis = new THREE.Matrix4()

  constructor(scene: THREE.Scene, budget: number, textures: FxTextureSet) {
    this.capacity = Math.max(32, Math.floor(budget))

    this.material = new THREE.MeshStandardMaterial({
      map: textures.decalAlbedo,
      normalMap: textures.decalNormal,
      normalScale: new THREE.Vector2(1.15, 1.15),
      transparent: true,
      depthWrite: false,
      roughness: 0.94,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -16,
      side: THREE.FrontSide,
      alphaTest: 0.0,
    })
    this.material.name = 'fx-decal'
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec4 aTile;
           attribute vec4 aTint;
           varying vec4 vDecalTint;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           vec2 decalUv = uv * aTile.zw + aTile.xy;
           #ifdef USE_MAP
             vMapUv = decalUv;
           #endif
           #ifdef USE_NORMALMAP
             vNormalMapUv = decalUv;
           #endif
           vDecalTint = aTint;`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n varying vec4 vDecalTint;`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           diffuseColor.rgb *= vDecalTint.rgb;
           diffuseColor.a *= vDecalTint.a;
           if (diffuseColor.a < 0.004) discard;`,
        )
    }

    const quad = new THREE.PlaneGeometry(1, 1)
    this.mesh = new THREE.InstancedMesh(quad, this.material, this.capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = 2
    this.mesh.name = 'fx-decals'

    const tileData = new Float32Array(this.capacity * 4)
    const tintData = new Float32Array(this.capacity * 4)
    for (let i = 0; i < this.capacity; i++) {
      tileData[i * 4 + 2] = 0.25
      tileData[i * 4 + 3] = 0.25
      tintData[i * 4] = 1
      tintData[i * 4 + 1] = 1
      tintData[i * 4 + 2] = 1
      tintData[i * 4 + 3] = 0
      this.slots.push({ born: 0, hold: 0, fade: 1, active: false, opacity: 0 })
      this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0))
    }
    this.tile = new THREE.InstancedBufferAttribute(tileData, 4)
    this.tint = new THREE.InstancedBufferAttribute(tintData, 4)
    this.tile.setUsage(THREE.DynamicDrawUsage)
    this.tint.setUsage(THREE.DynamicDrawUsage)
    quad.setAttribute('aTile', this.tile)
    quad.setAttribute('aTint', this.tint)
    this.mesh.instanceMatrix.needsUpdate = true

    scene.add(this.mesh)
  }

  /** Picks the bullet-hole variant that belongs to a surface. */
  holeKindFor(surface: Surface, pick: number): DecalKind {
    const list = HOLE_BY_SURFACE[surface] ?? HOLE_BY_SURFACE.concrete
    return list[Math.floor(pick * list.length) % list.length]
  }

  /**
   * Places a decal. `roll` rotates it around the surface normal; `hold` and
   * `fade` control how long it stays crisp and how long it takes to vanish.
   */
  spawn(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    kind: DecalKind,
    size: number,
    roll: number,
    time: number,
    opacity = 1,
    tintR = 1,
    tintG = 1,
    tintB = 1,
    hold = 24,
    fade = 6,
  ): void {
    const i = this.head
    this.head = (this.head + 1) % this.capacity

    // Start retiring the decals the ring is about to reach, so nothing ever
    // blinks out of existence in front of the player.
    for (let k = 1; k <= RETIRE_LOOKAHEAD; k++) {
      const s = this.slots[(this.head + k) % this.capacity]
      if (!s.active) continue
      const elapsed = time - s.born
      if (elapsed < s.hold) {
        s.hold = elapsed
        s.fade = Math.min(s.fade, 1.6)
        s.born = time - elapsed
      }
    }

    // Build an orthonormal basis with +Z along the normal, rolled in-plane.
    const up = Math.abs(normal.y) > 0.95 ? this.zAxis : this.up
    this.tangent.copy(up).cross(normal)
    if (this.tangent.lengthSq() < 1e-8) this.tangent.set(1, 0, 0)
    this.tangent.normalize()
    this.bitangent.copy(normal).cross(this.tangent).normalize()
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const tx = this.tangent.x * cr + this.bitangent.x * sr
    const ty = this.tangent.y * cr + this.bitangent.y * sr
    const tz = this.tangent.z * cr + this.bitangent.z * sr
    this.tangent.set(tx, ty, tz)
    this.bitangent.copy(normal).cross(this.tangent).normalize()
    this.basis.makeBasis(this.tangent, this.bitangent, normal)
    this.quat.setFromRotationMatrix(this.basis)

    // Lift off the surface so the quad is never coplanar with the wall.
    this.pos.copy(normal).multiplyScalar(0.008).add(point)
    this.scale.set(size, size, size)
    this.m4.compose(this.pos, this.quat, this.scale)
    this.mesh.setMatrixAt(i, this.m4)
    this.mesh.instanceMatrix.needsUpdate = true

    const tileIndex = DECAL[kind]
    const col = tileIndex % 4
    const row = (tileIndex / 4) | 0
    const td = this.tile.array as Float32Array
    td[i * 4] = col * 0.25
    // Canvas row 0 sits at v = 0.75..1 because the texture is flipped.
    td[i * 4 + 1] = 1 - (row + 1) * 0.25
    td[i * 4 + 2] = 0.25
    td[i * 4 + 3] = 0.25
    this.tile.needsUpdate = true

    const nd = this.tint.array as Float32Array
    nd[i * 4] = tintR
    nd[i * 4 + 1] = tintG
    nd[i * 4 + 2] = tintB
    nd[i * 4 + 3] = opacity
    this.tint.needsUpdate = true

    const slot = this.slots[i]
    slot.born = time
    slot.hold = hold
    slot.fade = fade
    slot.active = true
    slot.opacity = opacity
  }

  update(time: number): void {
    const nd = this.tint.array as Float32Array
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i]
      if (!s.active) continue
      const age = time - s.born
      if (age <= s.hold) continue
      const k = 1 - (age - s.hold) / s.fade
      if (k <= 0) {
        s.active = false
        nd[i * 4 + 3] = 0
        this.mesh.setMatrixAt(i, this.m4.makeScale(0, 0, 0))
        this.mesh.instanceMatrix.needsUpdate = true
        this.tintDirty = true
        continue
      }
      nd[i * 4 + 3] = s.opacity * k
      this.tintDirty = true
    }
    if (this.tintDirty) {
      this.tint.needsUpdate = true
      this.tintDirty = false
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}
