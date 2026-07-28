import * as THREE from 'three'
import { Rand } from '../core/Rand'
import type { DynamicBodyHandle, GameContext, PhysicsService, Surface } from '../core/Types'

/**
 * Pooled rigid-body debris.
 *
 * Impacts and explosions hand their impulse to real physics chunks so the
 * fragments bounce off the same geometry the player is standing on. The pool is
 * small and strictly recycled — dozens of live rapier bodies is the point at
 * which physics starts costing more than it returns visually.
 */

interface Chunk {
  mesh: THREE.Mesh
  handle: DynamicBodyHandle | null
  born: number
  active: boolean
}

/** Minimal view of the concrete physics body, reached via duck typing. */
interface BodyLike {
  applyImpulse(v: { x: number; y: number; z: number }, wake: boolean): void
  applyTorqueImpulse(v: { x: number; y: number; z: number }, wake: boolean): void
  mass(): number
}

interface PhysicsWithBodies extends PhysicsService {
  getBody?(handle: DynamicBodyHandle): BodyLike | null
}

const SURFACE_TINT: Partial<Record<Surface, number>> = {
  concrete: 0x9a958a,
  plaster: 0xcbc4b4,
  tile: 0xa89f92,
  wood: 0x7d5c38,
  metal: 0x6e6f72,
  thinMetal: 0x7b7d80,
  glass: 0xbcd6de,
  dirt: 0x5c4a34,
  sand: 0xbaa681,
  gravel: 0x847c70,
  rubber: 0x2b2b2d,
  foliage: 0x4a6330,
}

export class Debris {
  private readonly chunks: Chunk[] = []
  private readonly root = new THREE.Group()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials = new Map<Surface, THREE.MeshStandardMaterial>()
  private head = 0
  private readonly lifetime = 14

  private readonly tmp = new THREE.Vector3()
  private readonly rand: Rand

  constructor(scene: THREE.Scene, count: number, seed = 1337, seedGeometryCount = 4) {
    this.rand = new Rand(seed ^ 0x3c1d77)
    this.root.name = 'fx-debris'
    scene.add(this.root)

    // A handful of irregular chunk shapes reads far better than one cube.
    for (let g = 0; g < seedGeometryCount; g++) {
      const geo = new THREE.IcosahedronGeometry(0.5, 0)
      const pos = geo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        const s = 0.55 + ((i * 37 + g * 13) % 11) / 11 * 0.8
        pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.72, pos.getZ(i) * s)
      }
      geo.computeVertexNormals()
      geo.computeBoundingBox()
      this.geometries.push(geo)
    }

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geometries[i % this.geometries.length], this.material('concrete'))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.visible = false
      mesh.frustumCulled = true
      this.root.add(mesh)
      this.chunks.push({ mesh, handle: null, born: 0, active: false })
    }
  }

  private material(surface: Surface): THREE.MeshStandardMaterial {
    let m = this.materials.get(surface)
    if (m) return m
    const hex = SURFACE_TINT[surface] ?? 0x8b877e
    const metal = surface === 'metal' || surface === 'thinMetal'
    m = new THREE.MeshStandardMaterial({
      color: hex,
      roughness: surface === 'glass' ? 0.12 : metal ? 0.45 : 0.92,
      metalness: metal ? 0.85 : 0.0,
      transparent: surface === 'glass',
      opacity: surface === 'glass' ? 0.55 : 1,
      flatShading: true,
    })
    m.name = `fx-debris-${surface}`
    this.materials.set(surface, m)
    return m
  }

  /**
   * Spawns one chunk at `point` with an initial impulse along `impulse`.
   * Returns false when physics is unavailable, so callers can fall back to
   * pure particle debris.
   */
  spawn(
    ctx: GameContext,
    point: THREE.Vector3,
    impulse: THREE.Vector3,
    size: number,
    surface: Surface,
    time: number,
  ): boolean {
    const physics = ctx.services.physics as PhysicsWithBodies | undefined
    if (!physics) return false

    const chunk = this.chunks[this.head]
    this.head = (this.head + 1) % this.chunks.length
    this.retire(chunk, physics)

    chunk.mesh.geometry = this.geometries[this.head % this.geometries.length]
    chunk.mesh.material = this.material(surface)
    chunk.mesh.userData.surface = surface
    chunk.mesh.scale.setScalar(size)
    chunk.mesh.position.copy(point)
    const q = this.rand
    chunk.mesh.quaternion.set(q.spread(1), q.spread(1), q.spread(1), q.range(0.2, 1)).normalize()
    chunk.mesh.visible = true
    chunk.mesh.updateMatrixWorld(true)

    const mass = Math.max(0.02, size * size * size * 1800)
    chunk.handle = physics.addDynamic(chunk.mesh, {
      mass,
      shape: 'convex',
      restitution: surface === 'glass' ? 0.1 : 0.28,
      friction: 0.8,
      linearDamping: 0.05,
      angularDamping: 0.25,
    })
    chunk.born = time
    chunk.active = true

    const body = physics.getBody?.(chunk.handle) ?? null
    if (body) {
      const m = body.mass() || mass
      this.tmp.copy(impulse).multiplyScalar(m)
      body.applyImpulse({ x: this.tmp.x, y: this.tmp.y, z: this.tmp.z }, true)
      body.applyTorqueImpulse(
        { x: this.tmp.z * 0.02 * size, y: this.tmp.x * 0.02 * size, z: this.tmp.y * 0.02 * size },
        true,
      )
    } else {
      // No direct body access: a tight radial impulse still kicks the chunk.
      physics.applyRadialImpulse(this.tmp.copy(point).addScaledVector(impulse, -0.05), 0.12, impulse.length() * mass)
    }
    return true
  }

  private retire(chunk: Chunk, physics: PhysicsService): void {
    if (!chunk.active) return
    if (chunk.handle) physics.removeBody(chunk.handle)
    chunk.handle = null
    chunk.active = false
    chunk.mesh.visible = false
  }

  update(ctx: GameContext, time: number): void {
    const physics = ctx.services.physics
    if (!physics) return
    for (const c of this.chunks) {
      if (!c.active) continue
      const age = time - c.born
      if (age > this.lifetime) {
        this.retire(c, physics)
      } else if (age > this.lifetime - 1.5) {
        // Sink into the ground rather than blinking out.
        c.mesh.scale.multiplyScalar(0.97)
      }
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials.values()) m.dispose()
    this.root.removeFromParent()
  }
}
