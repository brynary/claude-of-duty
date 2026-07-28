import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { PhysicsSystem } from '../physics/Physics'
import { GROUP } from '../physics/Physics'
import type { BoneName, SoldierRig } from './SoldierMesh'

/**
 * Death ragdoll: a chain of Rapier capsules joined at the skeleton's joints,
 * driving the bones instead of the animation system.
 *
 * The trick that makes this cheap is choosing each body's frame to *be* its
 * bone's world frame at the moment of death. Then reading a body back is a
 * straight copy — no offset bookkeeping — and the capsule shape is expressed
 * once in bone-local space at construction.
 */

interface SegmentDef {
  bone: BoneName
  tip: BoneName
  radius: number
  mass: number
  /** Joint anchor bone, and the parent segment it hangs from. */
  parent: BoneName | null
  joint: BoneName | null
}

const SEGMENTS: SegmentDef[] = [
  { bone: 'pelvis', tip: 'spine02', radius: 0.15, mass: 15, parent: null, joint: null },
  { bone: 'spine02', tip: 'neck', radius: 0.17, mass: 24, parent: 'pelvis', joint: 'spine02' },
  { bone: 'neck', tip: 'head', radius: 0.1, mass: 5.5, parent: 'spine02', joint: 'neck' },
  { bone: 'upperArmL', tip: 'lowerArmL', radius: 0.055, mass: 2.6, parent: 'spine02', joint: 'upperArmL' },
  { bone: 'lowerArmL', tip: 'handL', radius: 0.045, mass: 2.0, parent: 'upperArmL', joint: 'lowerArmL' },
  { bone: 'upperArmR', tip: 'lowerArmR', radius: 0.055, mass: 2.6, parent: 'spine02', joint: 'upperArmR' },
  { bone: 'lowerArmR', tip: 'handR', radius: 0.045, mass: 2.0, parent: 'upperArmR', joint: 'lowerArmR' },
  { bone: 'thighL', tip: 'shinL', radius: 0.085, mass: 9, parent: 'pelvis', joint: 'thighL' },
  { bone: 'shinL', tip: 'footL', radius: 0.06, mass: 4.5, parent: 'thighL', joint: 'shinL' },
  { bone: 'thighR', tip: 'shinR', radius: 0.085, mass: 9, parent: 'pelvis', joint: 'thighR' },
  { bone: 'shinR', tip: 'footR', radius: 0.06, mass: 4.5, parent: 'thighR', joint: 'shinR' },
]

interface Segment {
  def: SegmentDef
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  bone: THREE.Bone
  headWorld: THREE.Vector3
}

const UP = new THREE.Vector3(0, 1, 0)

export class Ragdoll {
  private segments: Segment[] = []
  private joints: RAPIER.ImpulseJoint[] = []
  private built = false

  private vA = new THREE.Vector3()
  private vB = new THREE.Vector3()
  private vC = new THREE.Vector3()
  private qA = new THREE.Quaternion()
  private qB = new THREE.Quaternion()
  private mA = new THREE.Matrix4()
  private mB = new THREE.Matrix4()
  private ONE = new THREE.Vector3(1, 1, 1)

  constructor(private physics: PhysicsSystem, private rig: SoldierRig) {}

  /** @param impulse world-space momentum transferred by the killing round. */
  build(hitPoint: THREE.Vector3, impulse: THREE.Vector3): void {
    if (this.built) return
    this.built = true
    this.rig.root.updateMatrixWorld(true)

    const world = this.physics.world
    const byBone = new Map<BoneName, Segment>()

    for (const def of SEGMENTS) {
      const bone = this.rig.bones[def.bone]
      const tip = this.rig.bones[def.tip]
      this.vA.setFromMatrixPosition(bone.matrixWorld)
      this.vB.setFromMatrixPosition(tip.matrixWorld)
      this.qA.setFromRotationMatrix(bone.matrixWorld)

      const len = Math.max(0.06, this.vA.distanceTo(this.vB))
      // Capsule axis in bone-local space.
      this.vC.copy(this.vB).sub(this.vA).normalize().applyQuaternion(this.qB.copy(this.qA).invert())

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(this.vA.x, this.vA.y, this.vA.z)
          .setRotation({ x: this.qA.x, y: this.qA.y, z: this.qA.z, w: this.qA.w })
          .setLinearDamping(0.22)
          .setAngularDamping(2.2)
          .setCanSleep(true),
      )

      const half = Math.max(0.02, len * 0.5 - def.radius * 0.5)
      this.qB.setFromUnitVectors(UP, this.vC)
      const cd = RAPIER.ColliderDesc.capsule(half, def.radius)
        .setTranslation(this.vC.x * len * 0.5, this.vC.y * len * 0.5, this.vC.z * len * 0.5)
        .setRotation({ x: this.qB.x, y: this.qB.y, z: this.qB.z, w: this.qB.w })
        .setMass(def.mass)
        .setFriction(0.85)
        .setRestitution(0.03)
        // DEBRIS membership colliding only with WORLD: parts pass through each
        // other, which is what stops a jointed chain from exploding itself.
        .setCollisionGroups((GROUP.DEBRIS << 16) | GROUP.WORLD)
        .setSolverGroups((GROUP.DEBRIS << 16) | GROUP.WORLD)
      const collider = world.createCollider(cd, body)
      this.physics.registerHitbox(collider, DEAD_SENTINEL, 'flesh')

      const seg: Segment = { def, body, collider, bone, headWorld: this.vA.clone() }
      this.segments.push(seg)
      byBone.set(def.bone, seg)
    }

    for (const seg of this.segments) {
      if (!seg.def.parent || !seg.def.joint) continue
      const parent = byBone.get(seg.def.parent)
      if (!parent) continue
      this.vA.setFromMatrixPosition(this.rig.bones[seg.def.joint].matrixWorld)

      this.qA.setFromRotationMatrix(parent.bone.matrixWorld).invert()
      this.vB.copy(this.vA).sub(parent.headWorld).applyQuaternion(this.qA)
      this.qA.setFromRotationMatrix(seg.bone.matrixWorld).invert()
      this.vC.copy(this.vA).sub(seg.headWorld).applyQuaternion(this.qA)

      const jd = RAPIER.JointData.spherical(
        { x: this.vB.x, y: this.vB.y, z: this.vB.z },
        { x: this.vC.x, y: this.vC.y, z: this.vC.z },
      )
      this.joints.push(world.createImpulseJoint(jd, parent.body, seg.body, true))
    }

    // The killing round pushes at the wound, and a fraction goes into the hips
    // so the whole body is carried rather than spun about one limb.
    let nearest = this.segments[0]
    let bestD = Infinity
    for (const seg of this.segments) {
      const d = hitPoint.distanceTo(seg.headWorld)
      if (d < bestD) { bestD = d; nearest = seg }
    }
    nearest.body.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y + 2, z: impulse.z },
      { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
      true,
    )
    this.segments[0].body.applyImpulse(
      { x: impulse.x * 0.35, y: impulse.y * 0.35 + 8, z: impulse.z * 0.35 },
      true,
    )
    // Legs get a small kick so the soldier folds instead of toppling like a log.
    for (const seg of this.segments) {
      if (seg.def.bone !== 'shinL' && seg.def.bone !== 'shinR') continue
      seg.body.applyImpulse({ x: impulse.x * 0.08, y: -2, z: impulse.z * 0.08 }, true)
    }
  }

  /** Copies simulated transforms back onto the skeleton. */
  update(_dt: number): void {
    if (!this.built) return
    const pelvis = this.segments[0]
    const t = pelvis.body.translation()
    // Keep the mesh's origin near the corpse so frustum culling stays honest.
    this.rig.root.position.set(t.x, t.y, t.z)
    this.rig.root.quaternion.identity()
    this.rig.root.updateMatrixWorld(true)

    for (const seg of this.segments) {
      const bt = seg.body.translation()
      const br = seg.body.rotation()
      this.vA.set(bt.x, bt.y, bt.z)
      this.qA.set(br.x, br.y, br.z, br.w)
      this.mA.compose(this.vA, this.qA, this.ONE)

      const parent = seg.bone.parent
      if (!parent) continue
      this.mB.copy(parent.matrixWorld).invert().multiply(this.mA)
      this.mB.decompose(seg.bone.position, seg.bone.quaternion, seg.bone.scale)
      // Refreshing the subtree here is what lets the next segment read a
      // correct parent world matrix, and carries unsimulated bones along.
      seg.bone.updateMatrixWorld(true)
    }
  }

  dispose(): void {
    if (!this.built) return
    const world = this.physics.world
    for (const j of this.joints) world.removeImpulseJoint(j, false)
    for (const seg of this.segments) {
      this.physics.unregisterHitbox(seg.collider)
      world.removeRigidBody(seg.body)
    }
    this.joints.length = 0
    this.segments.length = 0
    this.built = false
  }
}

/**
 * Corpse colliders are registered only so impacts read as flesh; they are not a
 * live target, so they point at an inert stand-in rather than the dead soldier.
 */
const DEAD_SENTINEL = {
  id: -1,
  team: 'enemy' as const,
  health: 0,
  maxHealth: 0,
  alive: false,
  position: new THREE.Vector3(),
  applyDamage: () => {},
}
