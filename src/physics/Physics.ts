import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type {
  GameContext, System, PhysicsService, RaycastHit, RaycastFilter,
  DynamicBodyOptions, DynamicBodyHandle, Surface, Damageable,
} from '../core/Types'

/** Collision groups, packed as rapier's 16-bit membership / 16-bit filter. */
export const GROUP = {
  WORLD: 0x0001,
  PLAYER: 0x0002,
  CHARACTER: 0x0004,
  DEBRIS: 0x0008,
  PROJECTILE: 0x0010,
} as const

function groups(membership: number, filter: number): number {
  return (membership << 16) | filter
}

interface BodyRecord {
  id: number
  body: RAPIER.RigidBody
  mesh: THREE.Object3D
  surface: Surface
}

/**
 * Rapier-backed collision and rigid body simulation.
 *
 * Static level geometry becomes trimesh colliders; debris, ragdoll segments and
 * kicked props are convex/box dynamic bodies. Character hitboxes are registered
 * as sensors so ballistics can resolve a body region without the character
 * controller pushing them around.
 */
export class PhysicsSystem implements System, PhysicsService {
  readonly name = 'physics'

  world!: RAPIER.World
  rapier = RAPIER

  private bodies = new Map<number, BodyRecord>()
  private colliderSurface = new Map<number, Surface>()
  private colliderMesh = new Map<number, THREE.Object3D>()
  private colliderEntity = new Map<number, Damageable>()
  private nextId = 1
  private accumulator = 0
  private readonly step = 1 / 120

  private tmpVec = new THREE.Vector3()
  private tmpQuat = new THREE.Quaternion()
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

  async init(ctx: GameContext): Promise<void> {
    await RAPIER.init()
    this.world = new RAPIER.World({ x: 0, y: -19.6, z: 0 })
    // Twice-real gravity: FPS jump arcs read as floaty at true 9.8 because the
    // camera is close to the action and the jump height is small.
    this.world.integrationParameters.numSolverIterations = 8
    ctx.services.physics = this
  }

  update(dt: number, _ctx: GameContext): void {
    if (dt <= 0) return
    this.accumulator += dt
    // Cap catch-up so a hitch cannot spiral into a death loop of substeps.
    let steps = 0
    while (this.accumulator >= this.step && steps < 8) {
      this.world.step()
      this.accumulator -= this.step
      steps++
    }
    if (steps === 8) this.accumulator = 0

    for (const rec of this.bodies.values()) {
      if (rec.body.isFixed() || rec.body.isSleeping()) continue
      const t = rec.body.translation()
      const r = rec.body.rotation()
      rec.mesh.position.set(t.x, t.y, t.z)
      rec.mesh.quaternion.set(r.x, r.y, r.z, r.w)
    }
  }

  // --- Static world -------------------------------------------------------

  addStatic(mesh: THREE.Mesh, surface: Surface): void {
    mesh.updateWorldMatrix(true, false)
    const geom = mesh.geometry
    const pos = geom.getAttribute('position')
    if (!pos) return

    // Bake the world transform into the collider vertices so a single fixed
    // body at the origin can host arbitrarily transformed level pieces.
    const vertices = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      this.tmpVec.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      vertices[i * 3] = this.tmpVec.x
      vertices[i * 3 + 1] = this.tmpVec.y
      vertices[i * 3 + 2] = this.tmpVec.z
    }

    let indices: Uint32Array
    if (geom.index) {
      indices = new Uint32Array(geom.index.array)
    } else {
      indices = new Uint32Array(pos.count)
      for (let i = 0; i < pos.count; i++) indices[i] = i
    }

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    const body = this.world.createRigidBody(bodyDesc)
    const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices)
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff))
      .setFriction(0.9)
      .setRestitution(0.02)
    const collider = this.world.createCollider(colliderDesc, body)

    this.colliderSurface.set(collider.handle, surface)
    this.colliderMesh.set(collider.handle, mesh)
    mesh.userData.surface = surface
  }

  /** Cheaper alternative for boxy props: an oriented box collider. */
  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, quat: THREE.Quaternion, surface: Surface, mesh?: THREE.Object3D): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
    )
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setCollisionGroups(groups(GROUP.WORLD, 0xffff))
        .setFriction(0.9),
      body,
    )
    this.colliderSurface.set(collider.handle, surface)
    if (mesh) this.colliderMesh.set(collider.handle, mesh)
  }

  // --- Dynamic bodies -----------------------------------------------------

  addDynamic(mesh: THREE.Mesh, opts: DynamicBodyOptions): DynamicBodyHandle {
    mesh.updateWorldMatrix(true, false)
    mesh.matrixWorld.decompose(this.tmpVec, this.tmpQuat, new THREE.Vector3())

    let desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.tmpVec.x, this.tmpVec.y, this.tmpVec.z)
      .setRotation({ x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w })
      .setLinearDamping(opts.linearDamping ?? 0.05)
      .setAngularDamping(opts.angularDamping ?? 0.35)
    if (opts.ccd) desc = desc.setCcdEnabled(true)

    const body = this.world.createRigidBody(desc)

    mesh.geometry.computeBoundingBox()
    const bb = mesh.geometry.boundingBox!
    const size = bb.getSize(new THREE.Vector3()).multiply(mesh.scale)
    const half = size.multiplyScalar(0.5)

    let colliderDesc: RAPIER.ColliderDesc
    switch (opts.shape) {
      case 'sphere':
        colliderDesc = RAPIER.ColliderDesc.ball(Math.max(half.x, half.y, half.z))
        break
      case 'capsule':
        colliderDesc = RAPIER.ColliderDesc.capsule(Math.max(half.y - half.x, 0.01), half.x)
        break
      case 'convex': {
        const pos = mesh.geometry.getAttribute('position')
        const pts = new Float32Array(pos.count * 3)
        for (let i = 0; i < pos.count; i++) {
          pts[i * 3] = pos.getX(i) * mesh.scale.x
          pts[i * 3 + 1] = pos.getY(i) * mesh.scale.y
          pts[i * 3 + 2] = pos.getZ(i) * mesh.scale.z
        }
        colliderDesc = RAPIER.ColliderDesc.convexHull(pts) ?? RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        break
      }
      default:
        colliderDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
    }

    const volume = Math.max(size.x * size.y * size.z, 1e-4)
    colliderDesc = colliderDesc
      .setDensity(opts.mass / volume)
      .setRestitution(opts.restitution ?? 0.2)
      .setFriction(opts.friction ?? 0.7)
      .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.WORLD | GROUP.DEBRIS | GROUP.CHARACTER))

    const collider = this.world.createCollider(colliderDesc, body)
    this.colliderSurface.set(collider.handle, (mesh.userData.surface as Surface) ?? 'metal')
    this.colliderMesh.set(collider.handle, mesh)

    const id = this.nextId++
    this.bodies.set(id, { id, body, mesh, surface: (mesh.userData.surface as Surface) ?? 'metal' })
    return { _id: id }
  }

  getBody(handle: DynamicBodyHandle): RAPIER.RigidBody | null {
    return this.bodies.get(handle._id)?.body ?? null
  }

  removeBody(handle: DynamicBodyHandle): void {
    const rec = this.bodies.get(handle._id)
    if (!rec) return
    this.world.removeRigidBody(rec.body)
    this.bodies.delete(handle._id)
  }

  /** Associates a collider with a damageable so ballistics can resolve hits. */
  registerHitbox(collider: RAPIER.Collider, entity: Damageable, surface: Surface = 'flesh'): void {
    this.colliderEntity.set(collider.handle, entity)
    this.colliderSurface.set(collider.handle, surface)
  }

  unregisterHitbox(collider: RAPIER.Collider): void {
    this.colliderEntity.delete(collider.handle)
    this.colliderSurface.delete(collider.handle)
  }

  // --- Queries ------------------------------------------------------------

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, filter?: RaycastFilter): RaycastHit | null {
    this.ray.origin.x = origin.x
    this.ray.origin.y = origin.y
    this.ray.origin.z = origin.z
    this.ray.dir.x = dir.x
    this.ray.dir.y = dir.y
    this.ray.dir.z = dir.z

    const mask = filter?.characters === false
      ? groups(0xffff, GROUP.WORLD | GROUP.DEBRIS)
      : groups(0xffff, 0xffff)

    const hit = this.world.castRayAndGetNormal(this.ray, maxDist, true, undefined, mask)
    if (!hit) return null

    const point = new THREE.Vector3(
      origin.x + dir.x * hit.timeOfImpact,
      origin.y + dir.y * hit.timeOfImpact,
      origin.z + dir.z * hit.timeOfImpact,
    )
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z)
    const handle = hit.collider.handle

    return {
      point,
      normal,
      distance: hit.timeOfImpact,
      surface: this.colliderSurface.get(handle) ?? 'concrete',
      object: this.colliderMesh.get(handle),
      entity: this.colliderEntity.get(handle),
    }
  }

  sphereCast(origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number): RaycastHit | null {
    const shape = new RAPIER.Ball(radius)
    const hit = this.world.castShape(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dir.x, y: dir.y, z: dir.z },
      shape,
      0,
      maxDist,
      true,
      groups(0xffff, GROUP.WORLD | GROUP.DEBRIS),
    )
    if (!hit) return null
    const point = new THREE.Vector3(hit.witness1.x, hit.witness1.y, hit.witness1.z)
    const normal = new THREE.Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z)
    return {
      point,
      normal,
      distance: hit.time_of_impact,
      surface: this.colliderSurface.get(hit.collider.handle) ?? 'concrete',
      object: this.colliderMesh.get(hit.collider.handle),
      entity: this.colliderEntity.get(hit.collider.handle),
    }
  }

  applyRadialImpulse(center: THREE.Vector3, radius: number, strength: number): void {
    const d = new THREE.Vector3()
    for (const rec of this.bodies.values()) {
      if (rec.body.isFixed()) continue
      const t = rec.body.translation()
      d.set(t.x - center.x, t.y - center.y, t.z - center.z)
      const dist = d.length()
      if (dist > radius || dist < 1e-4) continue
      // Linear falloff, biased upward so debris lifts rather than skidding.
      const falloff = 1 - dist / radius
      d.normalize().multiplyScalar(strength * falloff * falloff)
      d.y += strength * falloff * 0.35
      rec.body.applyImpulse({ x: d.x, y: d.y, z: d.z }, true)
      rec.body.applyTorqueImpulse(
        { x: d.z * 0.05, y: d.x * 0.05, z: d.y * 0.05 },
        true,
      )
    }
  }

  /** Number of live dynamic bodies, for the stats overlay. */
  get bodyCount(): number {
    return this.bodies.size
  }

  dispose(): void {
    this.bodies.clear()
    this.world?.free()
  }
}
