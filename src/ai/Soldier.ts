import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { PhysicsSystem } from '../physics/Physics'
import { GROUP } from '../physics/Physics'
import type { Damageable, GameContext, HitInfo, Team } from '../core/Types'
import type { Rand } from '../core/Rand'
import { BIND, type BoneName, type SoldierAsset, type SoldierRig, createSoldierRig } from './SoldierMesh'
import { Ragdoll } from './Ragdoll'

export type Stance = 'stand' | 'crouch' | 'prone'
export type HitRegion = 'head' | 'chest' | 'stomach' | 'arm' | 'leg'

const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

/** Damage multiplier per body region. A head hit ends a soldier outright. */
const REGION_MULT: Record<HitRegion, number> = {
  head: 4.6, chest: 1.15, stomach: 1.0, arm: 0.68, leg: 0.62,
}

interface HitboxDef {
  region: HitRegion
  from: BoneName
  to: BoneName
  /** Extends the segment past `to` along its own direction. */
  extend: number
  radius: number
  /** The head is a ball so it cannot swallow upper-chest hits. */
  ball?: boolean
}

const HITBOXES: HitboxDef[] = [
  { region: 'head', from: 'head', to: 'head', extend: 0, radius: 0.125, ball: true },
  { region: 'chest', from: 'spine02', to: 'chest', extend: 0.1, radius: 0.175 },
  { region: 'stomach', from: 'pelvis', to: 'spine02', extend: 0, radius: 0.155 },
  { region: 'arm', from: 'upperArmL', to: 'handL', extend: 0, radius: 0.075 },
  { region: 'arm', from: 'upperArmR', to: 'handR', extend: 0, radius: 0.075 },
  { region: 'leg', from: 'thighL', to: 'footL', extend: 0, radius: 0.1 },
  { region: 'leg', from: 'thighR', to: 'footR', extend: 0, radius: 0.1 },
]

interface Hitbox {
  def: HitboxDef
  collider: RAPIER.Collider
  a: THREE.Vector3
  b: THREE.Vector3
}

/** Everything a soldier needs from the rest of the game, passed in once. */
export interface SoldierWorld {
  ctx: GameContext
  physics: PhysicsSystem
  rng: Rand
}

interface FootState {
  plant: THREE.Vector3
  liftoff: THREE.Vector3
  next: THREE.Vector3
  pos: THREE.Vector3
  yaw: number
  nextYaw: number
  grounded: boolean
}

let nextSoldierId = 5000

export class Soldier implements Damageable {
  readonly id = nextSoldierId++
  readonly team: Team = 'enemy'
  health = 100
  maxHealth = 100
  alive = true
  position = new THREE.Vector3()

  readonly rig: SoldierRig
  readonly world: SoldierWorld

  /** Horizontal facing, radians. The model looks down +Z at yaw 0. */
  yaw = 0
  /** Where the upper body points; drives the spine twist and the weapon. */
  aimTarget = new THREE.Vector3()
  /** 0 = relaxed carry, 1 = weapon up and tracking. */
  aimWeight = 0
  stance: Stance = 'stand'

  velocity = new THREE.Vector3()
  moveDir = new THREE.Vector3()
  moveSpeed = 0
  /** Set by behaviour when the soldier must face somewhere other than travel. */
  faceTarget: THREE.Vector3 | null = null

  leanTarget = 0
  private lean = 0

  /** Rising on fire, decaying with a spring; pushed through arms and spine. */
  private recoil = 0
  private recoilVel = 0
  private flinch = new THREE.Vector3()
  private flinchDecay = 0

  reloadT = -1
  private muzzleFlashT = 0

  private groundY = 0
  private speedNorm = 0
  private phase = 0
  private cycleTime = 0.9
  private stanceFrac = 0.62
  private stepLength = 0.6
  private feet: [FootState, FootState]
  private idleTimer = 0
  private bobPhase = 0
  private stanceBlend = 0
  private proneBlend = 0

  private body: RAPIER.RigidBody | null = null
  private hitboxes: Hitbox[] = []
  ragdoll: Ragdoll | null = null
  /** Seconds since death; drives corpse fade-out. */
  deadTime = 0

  private flash: THREE.Mesh
  /** World-space muzzle position, refreshed every frame for shooting and FX. */
  readonly muzzleWorld = new THREE.Vector3()
  readonly muzzleDir = new THREE.Vector3(0, 0, 1)
  readonly eye = new THREE.Vector3()

  // --- hoisted scratch; nothing in update() may allocate --------------------
  private vA = new THREE.Vector3()
  private vB = new THREE.Vector3()
  private vC = new THREE.Vector3()
  private vD = new THREE.Vector3()
  private vE = new THREE.Vector3()
  private vHip = new THREE.Vector3()
  private vKnee = new THREE.Vector3()
  private ikTarget = new THREE.Vector3()
  private ikPole = new THREE.Vector3()
  private qA = new THREE.Quaternion()
  private qB = new THREE.Quaternion()
  private eA = new THREE.Euler(0, 0, 0, 'YXZ')
  private rifleBasePos = new THREE.Vector3()
  // aimBone runs inside the IK solver, so it gets scratch nobody else touches.
  private aV1 = new THREE.Vector3()
  private aV2 = new THREE.Vector3()
  private aV3 = new THREE.Vector3()
  private aV4 = new THREE.Vector3()
  private aQ1 = new THREE.Quaternion()
  private aQ2 = new THREE.Quaternion()
  private aQ3 = new THREE.Quaternion()

  constructor(world: SoldierWorld, asset: SoldierAsset, flashGeometry: THREE.BufferGeometry, flashMaterial: THREE.Material) {
    this.world = world
    this.rig = createSoldierRig(asset)
    this.rifleBasePos.copy(this.rig.rifle.position)

    this.flash = new THREE.Mesh(flashGeometry, flashMaterial)
    this.flash.visible = false
    this.flash.frustumCulled = false
    this.flash.castShadow = false
    this.flash.receiveShadow = false
    this.rig.muzzle.add(this.flash)

    const mk = (): FootState => ({
      plant: new THREE.Vector3(),
      liftoff: new THREE.Vector3(),
      next: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      yaw: 0,
      nextYaw: 0,
      grounded: true,
    })
    this.feet = [mk(), mk()]
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  spawn(at: THREE.Vector3, yaw: number, scene: THREE.Object3D): void {
    this.position.copy(at)
    this.yaw = yaw
    this.groundY = at.y
    this.rig.root.position.copy(at)
    this.rig.root.rotation.set(0, yaw, 0)
    this.resetFeet()
    scene.add(this.rig.root)
    this.createHitboxes()
    this.rig.root.updateMatrixWorld(true)
  }

  private createHitboxes(): void {
    const { physics } = this.world
    // The carrier body never moves; the colliders carry world transforms
    // directly, which keeps hitbox placement exact instead of one body-move
    // behind the animation.
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0)
    this.body = physics.world.createRigidBody(desc)
    for (const def of HITBOXES) {
      const cd = (def.ball ? RAPIER.ColliderDesc.ball(def.radius) : RAPIER.ColliderDesc.capsule(0.1, def.radius))
        .setSensor(true)
        // CHARACTER membership keeps hitboxes out of world-only raycasts, which
        // is how AI line-of-sight ignores bodies while bullets do not.
        .setCollisionGroups((GROUP.CHARACTER << 16) | 0xffff)
      const collider = physics.world.createCollider(cd, this.body)
      physics.registerHitbox(collider, this, 'flesh')
      this.hitboxes.push({ def, collider, a: new THREE.Vector3(), b: new THREE.Vector3() })
    }
  }

  private destroyHitboxes(): void {
    const { physics } = this.world
    for (const hb of this.hitboxes) physics.unregisterHitbox(hb.collider)
    this.hitboxes.length = 0
    if (this.body) {
      physics.world.removeRigidBody(this.body)
      this.body = null
    }
  }

  dispose(): void {
    this.destroyHitboxes()
    this.ragdoll?.dispose()
    this.ragdoll = null
    this.rig.root.removeFromParent()
    if (this.fadeMats) {
      for (const m of this.fadeMats) m.dispose()
      this.fadeMats = null
    }
  }

  private fadeMats: THREE.Material[] | null = null

  /**
   * Corpse fade-out. Materials are shared between every soldier, so the first
   * call swaps in per-corpse clones; they are disposed with the soldier.
   */
  setFade(alpha: number): void {
    if (!this.fadeMats) {
      const src = this.rig.mesh.material
      const list = Array.isArray(src) ? src : [src]
      this.fadeMats = list.map((m) => {
        const c = m.clone()
        c.transparent = true
        return c
      })
      this.rig.mesh.material = this.fadeMats
      this.rig.mesh.castShadow = false
      this.flash.visible = false
    }
    for (const m of this.fadeMats) m.opacity = alpha
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /** Classifies a world-space impact against the current bone pose. */
  regionAt(point: THREE.Vector3): HitRegion {
    let best: HitRegion = 'chest'
    let bestD = Infinity
    for (const hb of this.hitboxes) {
      const d = segmentDistance(point, hb.a, hb.b) - hb.def.radius
      // Heads are small and matter, so give them a bias toward winning ties.
      const biased = hb.def.region === 'head' ? d - 0.04 : d
      if (biased < bestD) {
        bestD = biased
        best = hb.def.region
      }
    }
    return best
  }

  applyDamage(amount: number, hit: HitInfo): void {
    if (!this.alive) return
    const region = hit.region ?? this.regionAt(hit.point)
    const dealt = amount * REGION_MULT[region]
    this.health -= dealt

    const { ctx } = this.world
    ctx.events.emit('damage:dealt', { target: this, amount: dealt, hit })
    ctx.services.fx?.blood(hit.point, hit.normal, region === 'head' ? 1.6 : 1)

    // A flinch is stored in body-local space so it can be layered over whatever
    // locomotion is running without fighting it.
    const local = this.vA.copy(hit.direction).setY(0).normalize()
    const c = Math.cos(-this.yaw)
    const s = Math.sin(-this.yaw)
    this.flinch.set(local.x * c - local.z * s, 0, local.x * s + local.z * c)
    this.flinch.multiplyScalar(Math.min(1, dealt / 45))
    this.flinchDecay = 1

    if (this.health <= 0) {
      this.health = 0
      this.die(hit, region === 'head')
    }
  }

  private die(hit: HitInfo, headshot: boolean): void {
    this.alive = false
    this.deadTime = 0
    const { ctx, physics } = this.world
    this.destroyHitboxes()

    this.ragdoll = new Ragdoll(physics, this.rig)
    this.ragdoll.build(hit.point, this.vA.copy(hit.direction).multiplyScalar(Math.min(38, 9 + hit.distance * 0.1)))

    ctx.entities.delete(this.id)
    ctx.events.emit('entity:killed', {
      entity: this,
      byPlayer: true,
      weapon: ctx.services.weapons?.currentName ?? 'rifle',
      headshot,
    })
    ctx.services.fx?.blood(hit.point, hit.normal, 2.2)
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private probeMove(dt: number): void {
    const accel = this.moveSpeed > 0.1 ? 12 : 16
    this.vA.copy(this.moveDir).multiplyScalar(this.moveSpeed)
    this.velocity.lerp(this.vA, 1 - Math.exp(-accel * dt))
    this.velocity.y = 0

    const speed = this.velocity.length()
    if (speed > 1e-4) {
      const { physics } = this.world
      // Two slide passes: one to peel off the first wall, one for the corner it
      // pushes into. More than that and a soldier is stuck anyway.
      for (let pass = 0; pass < 2; pass++) {
        const len = this.velocity.length()
        if (len < 1e-4) break
        this.vB.copy(this.velocity).divideScalar(len)
        this.vC.set(this.position.x, this.groundY + 0.95, this.position.z)
        const reach = 0.42 + len * dt
        const hit = physics.raycast(this.vC, this.vB, reach, { characters: false })
        if (!hit) break
        const into = this.velocity.dot(hit.normal)
        if (into >= 0) break
        this.velocity.addScaledVector(hit.normal, -into * 1.02)
      }
      this.position.addScaledVector(this.velocity, dt)
    }

    // Ground snap. Starting the ray above the head keeps a soldier standing on
    // top of debris rather than sinking through it.
    this.vC.set(this.position.x, this.position.y + 1.2, this.position.z)
    const ground = this.world.physics.raycast(this.vC, DOWN, 4.0, { characters: false })
    const target = ground ? ground.point.y : this.groundY
    this.groundY += (target - this.groundY) * Math.min(1, dt * 18)
    this.position.y = this.groundY
  }

  private updateFacing(dt: number): void {
    let desired = this.yaw
    if (this.faceTarget) {
      this.vA.copy(this.faceTarget).sub(this.position)
      if (this.vA.lengthSq() > 1e-4) desired = Math.atan2(this.vA.x, this.vA.z)
    } else if (this.velocity.lengthSq() > 0.25) {
      desired = Math.atan2(this.velocity.x, this.velocity.z)
    }
    let delta = desired - this.yaw
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const rate = this.aimWeight > 0.5 ? 7.5 : 5.0
    this.yaw += delta * Math.min(1, rate * dt)
  }

  // -------------------------------------------------------------------------
  // Gait
  // -------------------------------------------------------------------------

  private groundAt(x: number, z: number, fallback: number): number {
    this.vE.set(x, fallback + 1.1, z)
    const hit = this.world.physics.raycast(this.vE, DOWN, 3.0, { characters: false })
    return hit ? hit.point.y : fallback
  }

  private lateral(i: number): number {
    const base = 0.11 + this.stanceBlend * 0.045
    return i === 0 ? base : -base
  }

  private resetFeet(): void {
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]
      const lat = this.lateral(i)
      const c = Math.cos(this.yaw)
      const s = Math.sin(this.yaw)
      const stagger = i === 0 ? 0.05 : -0.05
      const x = this.position.x + lat * c + stagger * s
      const z = this.position.z - lat * s + stagger * c
      const y = this.groundAt(x, z, this.groundY)
      f.plant.set(x, y, z)
      f.liftoff.copy(f.plant)
      f.next.copy(f.plant)
      f.pos.copy(f.plant)
      f.yaw = this.yaw
      f.nextYaw = this.yaw
      f.grounded = true
    }
    this.phase = 0
  }

  /** Where foot `i` should touch down given the body's projected motion. */
  private predictPlant(i: number, lead: number, out: THREE.Vector3): void {
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    const lat = this.lateral(i)
    const fwd = this.stepLength * 0.5
    const px = this.position.x + this.velocity.x * lead + lat * c + fwd * s
    const pz = this.position.z + this.velocity.z * lead - lat * s + fwd * c
    out.set(px, this.groundAt(px, pz, this.groundY), pz)
  }

  private updateGait(dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    this.speedNorm = Math.min(1, speed / 5.6)

    if (speed < 0.22) {
      // Idle: hold the feet, but shuffle one across if the body has turned or
      // drifted away from it. That shuffle is what stops a rotating soldier
      // from pivoting on skis.
      this.idleTimer += dt
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i]
        const c = Math.cos(this.yaw)
        const s = Math.sin(this.yaw)
        const lat = this.lateral(i)
        const ix = this.position.x + lat * c
        const iz = this.position.z - lat * s
        const off = Math.hypot(f.plant.x - ix, f.plant.z - iz)
        if (off > 0.34 && this.idleTimer > 0.22) {
          f.plant.set(ix, this.groundAt(ix, iz, this.groundY), iz)
          f.yaw = this.yaw
          this.idleTimer = 0
        }
        f.pos.lerp(f.plant, 1 - Math.exp(-14 * dt))
        f.yaw += angleDelta(f.yaw, this.yaw) * Math.min(1, dt * 6)
        f.grounded = true
      }
      this.phase = 0
      return
    }

    this.idleTimer = 0
    this.stepLength = THREE.MathUtils.clamp(0.44 + speed * 0.185, 0.44, 1.32) * (1 - this.stanceBlend * 0.3)
    this.cycleTime = THREE.MathUtils.clamp((2 * this.stepLength) / Math.max(speed, 0.3), 0.42, 1.35)
    this.stanceFrac = THREE.MathUtils.lerp(0.63, 0.38, this.speedNorm)

    const prev = this.phase
    this.phase = (this.phase + dt / this.cycleTime) % 1

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]
      const p = (this.phase + i * 0.5) % 1
      const pPrev = (prev + i * 0.5) % 1
      const wrapped = p < pPrev

      if (wrapped) {
        // Swing finished: the predicted landing becomes the new plant.
        f.plant.copy(f.next)
        f.yaw = f.nextYaw
        f.grounded = true
      }
      if (pPrev < this.stanceFrac && p >= this.stanceFrac) {
        // Leaving stance: commit to a landing spot one swing ahead.
        f.liftoff.copy(f.plant)
        this.predictPlant(i, (1 - this.stanceFrac) * this.cycleTime, f.next)
        f.nextYaw = this.yaw
        f.grounded = false
      }

      if (p < this.stanceFrac) {
        f.pos.copy(f.plant)
        // Late stance is a heel raise: the ankle lifts while the toe stays put.
        // Without it the foot stays rigidly flat and the walk reads as a
        // mannequin sliding on rails even though the contact point is correct.
        const t = p / this.stanceFrac
        if (t > 0.68) {
          const roll = (t - 0.68) / 0.32
          f.pos.y += roll * roll * (0.03 + this.speedNorm * 0.055)
        }
        f.grounded = true
      } else {
        const s = (p - this.stanceFrac) / (1 - this.stanceFrac)
        // Ease out of the plant and into the landing so the foot does not snap.
        const e = s * s * (3 - 2 * s)
        f.pos.lerpVectors(f.liftoff, f.next, e)
        const lift = 0.055 + this.speedNorm * 0.13
        f.pos.y += Math.sin(Math.PI * s) * lift
        f.yaw = f.liftoff === f.next ? this.yaw : lerpAngle(f.yaw, f.nextYaw, e)
        f.grounded = false
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bone posing
  // -------------------------------------------------------------------------

  /**
   * Rotates `bone` so the segment toward its child points along `worldDir`.
   * `twistRef` fixes the roll about that axis — without it a knee or elbow can
   * end up pointing sideways.
   */
  private aimBone(bone: THREE.Bone, childName: BoneName, worldDir: THREE.Vector3, twistRef: THREE.Vector3 | null): void {
    const parent = bone.parent
    if (!parent) return
    this.aQ1.setFromRotationMatrix(parent.matrixWorld)
    this.aQ2.copy(this.aQ1).invert()

    const def = BIND[childName]
    const pp = BIND[def.parent!].p
    // Bind direction of this bone, expressed in its parent's space.
    this.aV1.set(def.p[0] - pp[0], def.p[1] - pp[1], def.p[2] - pp[2]).normalize()
    this.aV2.copy(worldDir).normalize().applyQuaternion(this.aQ2)
    this.aQ3.setFromUnitVectors(this.aV1, this.aV2)

    if (twistRef) {
      // setFromUnitVectors leaves roll undefined, so pin it: carry a bind-space
      // reference axis through the swing and rotate it onto the desired plane.
      this.aV3.set(0, 0, 1).addScaledVector(this.aV1, -this.aV1.z)
      if (this.aV3.lengthSq() < 1e-6) this.aV3.set(1, 0, 0).addScaledVector(this.aV1, -this.aV1.x)
      this.aV3.normalize().applyQuaternion(this.aQ3)

      this.aV4.copy(twistRef).applyQuaternion(this.aQ2)
      this.aV4.addScaledVector(this.aV2, -this.aV4.dot(this.aV2))
      if (this.aV4.lengthSq() > 1e-6) {
        this.aV4.normalize()
        const cos = THREE.MathUtils.clamp(this.aV3.dot(this.aV4), -1, 1)
        this.aV3.cross(this.aV4)
        const sign = this.aV2.dot(this.aV3) < 0 ? -1 : 1
        this.aQ1.setFromAxisAngle(this.aV2, Math.acos(cos) * sign)
        this.aQ3.premultiply(this.aQ1)
      }
    }
    bone.quaternion.copy(this.aQ3)
  }

  /**
   * Analytic two-bone IK. `pole` decides which way the joint bends; without it
   * knees invert and elbows fold into the ribs.
   */
  private solveTwoBone(rootName: BoneName, midName: BoneName, tipName: BoneName): void {
    const rootBone = this.rig.bones[rootName]
    const midBone = this.rig.bones[midName]
    const l1 = boneLen(midName)
    const l2 = boneLen(tipName)

    this.vHip.setFromMatrixPosition(rootBone.matrixWorld)
    this.vA.copy(this.ikTarget).sub(this.vHip)
    let dist = this.vA.length()
    const maxReach = (l1 + l2) * 0.996
    if (dist > maxReach) dist = maxReach
    if (dist < 1e-3) dist = 1e-3
    this.vA.normalize()

    const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1)
    const a = Math.acos(cosA)

    // Bend plane: the component of the pole perpendicular to the limb axis.
    this.vB.copy(this.ikPole)
    this.vB.addScaledVector(this.vA, -this.vB.dot(this.vA))
    if (this.vB.lengthSq() < 1e-6) {
      this.vB.set(0, 0, 1).addScaledVector(this.vA, -this.vA.z)
      if (this.vB.lengthSq() < 1e-6) this.vB.set(1, 0, 0)
    }
    this.vB.normalize()

    this.vKnee.copy(this.vHip)
      .addScaledVector(this.vA, l1 * Math.cos(a))
      .addScaledVector(this.vB, l1 * Math.sin(a))

    this.vC.copy(this.vKnee).sub(this.vHip)
    this.aimBone(rootBone, midName, this.vC, this.vB)
    rootBone.updateMatrixWorld(true)

    this.vC.copy(this.vHip).addScaledVector(this.vA, dist).sub(this.vKnee)
    this.aimBone(midBone, tipName, this.vC, this.vB)
    midBone.updateMatrixWorld(true)
  }

  private poseSpine(dt: number): void {
    const b = this.rig.bones

    // Aim offset: how far the upper body must twist off the hips to look at the
    // target. Legs are free to point elsewhere entirely.
    this.vA.copy(this.aimTarget).sub(this.eye)
    const flat = Math.hypot(this.vA.x, this.vA.z) || 1e-3
    const aimYaw = angleDelta(this.yaw, Math.atan2(this.vA.x, this.vA.z))
    const aimPitch = Math.atan2(this.vA.y, flat)
    const w = this.aimWeight
    const twist = THREE.MathUtils.clamp(aimYaw, -0.95, 0.95) * w
    const pitch = THREE.MathUtils.clamp(aimPitch, -0.7, 0.55) * w

    // Locomotion layer.
    const gait = this.phase * Math.PI * 2
    const swing = this.speedNorm
    const hipSway = Math.sin(gait) * 0.16 * swing
    const hipRoll = Math.sin(gait + Math.PI / 2) * 0.07 * swing
    const shoulderCounter = -hipSway * 0.85
    this.bobPhase += dt
    const breathe = Math.sin(this.bobPhase * 1.6) * 0.012 * (1 - swing)

    const flinchX = this.flinch.z * this.flinchDecay
    const flinchZ = this.flinch.x * this.flinchDecay

    const leanRad = this.lean * 0.42

    // Pelvis: counter-rotates against the shoulders and drops in crouch.
    this.eA.set(0.04 * swing + this.stanceBlend * 0.16, hipSway, hipRoll)
    b.pelvis.quaternion.setFromEuler(this.eA)
    b.pelvis.position.set(
      BIND.pelvis.p[0],
      BIND.pelvis.p[1] - this.stanceBlend * 0.3 - Math.abs(Math.sin(gait)) * 0.022 * swing + breathe,
      BIND.pelvis.p[2],
    )

    // Positive X pitches a bone's forward axis down, so aim pitch is negated
    // while the running lean and the recoil kick are not. The three spine
    // fractions sum to one so the weapon lands exactly on the aim line.
    this.eA.set(-pitch * 0.2 + 0.05 * swing - flinchX * 0.22, twist * 0.22 + shoulderCounter * 0.4, leanRad * 0.35 - flinchZ * 0.2)
    b.spine01.quaternion.setFromEuler(this.eA)

    this.eA.set(-pitch * 0.3 + this.stanceBlend * 0.1 - flinchX * 0.3, twist * 0.3 + shoulderCounter * 0.35, leanRad * 0.4 - flinchZ * 0.28)
    b.spine02.quaternion.setFromEuler(this.eA)

    this.eA.set(
      -pitch * 0.5 - this.recoil * 0.11 + this.stanceBlend * 0.06 - flinchX * 0.38,
      twist * 0.48 + shoulderCounter * 0.25,
      leanRad * 0.3 - flinchZ * 0.34 - this.recoil * 0.02,
    )
    b.chest.quaternion.setFromEuler(this.eA)

    // Head tracks the target more tightly than the torso and settles faster.
    const headYaw = THREE.MathUtils.clamp(aimYaw - twist, -0.7, 0.7)
    const headPitch = THREE.MathUtils.clamp(aimPitch - pitch, -0.5, 0.45)
    this.eA.set(-headPitch * 0.4 + this.recoil * 0.05, headYaw * 0.4, -leanRad * 0.15)
    b.neck.quaternion.setFromEuler(this.eA)
    this.eA.set(-headPitch * 0.6 - flinchX * 0.4, headYaw * 0.6, flinchZ * 0.3)
    b.head.quaternion.setFromEuler(this.eA)
  }

  private poseArms(): void {
    const b = this.rig.bones
    // The right arm is the weapon's parent, so it stays close to bind and only
    // takes the additive layers. Everything else is aim offset from the chest.
    const carry = (1 - this.aimWeight) * 0.35
    this.eA.set(carry * 0.5, 0, 0)
    b.clavicleR.quaternion.setFromEuler(this.eA)
    this.eA.set(carry * 0.22 - this.recoil * 0.06, 0, 0)
    b.upperArmR.quaternion.setFromEuler(this.eA)
    // The bind pose holds the weapon at a low ready, angled down and slightly
    // inboard. Shouldering it cancels exactly that offset at the wrist, so the
    // barrel ends up on the aim line the spine is pointing along.
    this.eA.set(
      RIFLE_PITCH_OFFSET * this.aimWeight - this.recoil * 0.16,
      RIFLE_YAW_OFFSET * this.aimWeight,
      this.reloadT >= 0 ? reloadCant(this.reloadT) : 0,
    )
    b.handR.quaternion.setFromEuler(this.eA)

    // Recoil also shoves the weapon straight back into the shoulder.
    this.rig.rifle.position.copy(this.rifleBasePos)
    this.rig.rifle.position.z -= this.recoil * 0.035

    this.eA.set(carry * 0.35, 0, 0)
    b.clavicleL.quaternion.setFromEuler(this.eA)
  }

  /** Support hand IK: the left hand follows the weapon, including in reload. */
  private poseSupportHand(): void {
    const b = this.rig.bones
    if (this.reloadT >= 0) {
      reloadHandTarget(this.rig, this.reloadT, this.ikTarget)
    } else {
      this.rig.foregrip.getWorldPosition(this.ikTarget)
    }
    // Elbow drops and swings out, never up through the optic.
    this.ikPole.set(Math.sin(this.yaw + Math.PI / 2) * 0.85, -1, Math.cos(this.yaw + Math.PI / 2) * 0.85).normalize()
    this.solveTwoBone('upperArmL', 'lowerArmL', 'handL')
    this.eA.set(0.25, 0, 0)
    b.handL.quaternion.setFromEuler(this.eA)
  }

  private poseLegs(): void {
    const b = this.rig.bones
    if (this.proneBlend > 0.5) {
      this.eA.set(0.15, 0, 0.18)
      b.thighL.quaternion.setFromEuler(this.eA)
      this.eA.set(0.15, 0, -0.18)
      b.thighR.quaternion.setFromEuler(this.eA)
      this.eA.set(-0.35, 0, 0)
      b.shinL.quaternion.setFromEuler(this.eA)
      b.shinR.quaternion.setFromEuler(this.eA)
      this.eA.set(0.5, 0, 0)
      b.footL.quaternion.setFromEuler(this.eA)
      b.footR.quaternion.setFromEuler(this.eA)
      return
    }

    // Knees lead forward, biased outward so the stance is not knock-kneed.
    const fwdX = Math.sin(this.yaw)
    const fwdZ = Math.cos(this.yaw)
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]
      const side = i === 0 ? 1 : -1
      this.ikPole.set(fwdX + fwdZ * 0.22 * side, 0.12 + this.stanceBlend * 0.35, fwdZ - fwdX * 0.22 * side).normalize()
      // Ankle sits above the sole contact point.
      this.ikTarget.set(f.pos.x, f.pos.y + 0.075, f.pos.z)
      this.solveTwoBone(i === 0 ? 'thighL' : 'thighR', i === 0 ? 'shinL' : 'shinR', i === 0 ? 'footL' : 'footR')

      // Foot roll: heel strike, flat, toe-off.
      const p = (this.phase + i * 0.5) % 1
      const pitch = footPitch(p, this.stanceFrac, this.speedNorm)
      const cos = Math.cos(pitch)
      this.vC.set(Math.sin(f.yaw) * cos, Math.sin(pitch), Math.cos(f.yaw) * cos)
      const footBone = i === 0 ? b.footL : b.footR
      this.vD.set(0, 1, 0)
      this.aimBone(footBone, i === 0 ? 'toeL' : 'toeR', this.vC, this.vD)
      footBone.updateMatrixWorld(true)
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.alive) {
      this.deadTime += dt
      this.ragdoll?.update(dt)
      return
    }

    // Stance blends so crouching and standing are not a pop.
    const wantCrouch = this.stance === 'crouch' ? 1 : 0
    const wantProne = this.stance === 'prone' ? 1 : 0
    this.stanceBlend += (wantCrouch - this.stanceBlend) * Math.min(1, dt * 6)
    const proneWas = this.proneBlend
    this.proneBlend += (wantProne - this.proneBlend) * Math.min(1, dt * 4)
    if (proneWas > 0.5 && this.proneBlend <= 0.5) this.resetFeet()

    this.probeMove(dt)
    this.updateFacing(dt)
    this.updateGait(dt)

    // Recoil decays as a critically damped spring; a linear falloff reads limp.
    this.recoilVel += (-this.recoil * 260 - this.recoilVel * 26) * dt
    this.recoil = Math.max(0, this.recoil + this.recoilVel * dt)
    this.flinchDecay = Math.max(0, this.flinchDecay - dt * 3.2)
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 5)
    if (this.reloadT >= 0) {
      this.reloadT += dt / RELOAD_SECONDS
      if (this.reloadT >= 1) this.reloadT = -1
    }
    if (this.muzzleFlashT > 0) {
      this.muzzleFlashT -= dt
      if (this.muzzleFlashT <= 0) this.flash.visible = false
    }

    // Root transform. Prone pitches the whole rig and slides it forward so the
    // torso ends up over the soldier's map position rather than behind it.
    const pitch = -1.3 * this.proneBlend
    this.qA.setFromAxisAngle(UP, this.yaw)
    this.qB.setFromAxisAngle(RIGHT, pitch)
    this.rig.root.quaternion.copy(this.qA).multiply(this.qB)
    const slide = 0.96 * this.proneBlend
    this.rig.root.position.set(
      this.position.x + Math.sin(this.yaw) * slide + Math.sin(this.yaw + Math.PI / 2) * this.lean * 0.16,
      this.groundY - 0.05 * this.proneBlend,
      this.position.z + Math.cos(this.yaw) * slide + Math.cos(this.yaw + Math.PI / 2) * this.lean * 0.16,
    )

    this.eye.set(this.position.x, this.groundY + eyeHeight(this.stanceBlend, this.proneBlend), this.position.z)

    this.poseSpine(dt)
    this.poseArms()
    this.rig.root.updateMatrixWorld(true)
    this.poseLegs()
    this.poseSupportHand()
    this.rig.root.updateMatrixWorld(true)

    this.rig.muzzle.getWorldPosition(this.muzzleWorld)
    this.rig.muzzle.getWorldQuaternion(this.qA)
    this.muzzleDir.set(0, 0, 1).applyQuaternion(this.qA)

    this.syncHitboxes()
  }

  private syncHitboxes(): void {
    if (!this.body) return
    const b = this.rig.bones
    for (const hb of this.hitboxes) {
      const from = b[hb.def.from]
      const to = b[hb.def.to]
      hb.a.setFromMatrixPosition(from.matrixWorld)
      hb.b.setFromMatrixPosition(to.matrixWorld)
      if (hb.def.ball) {
        // Sit the ball on the skull rather than the base of the head bone.
        this.vA.set(0, 0.06, 0).applyQuaternion(this.qB.setFromRotationMatrix(to.matrixWorld))
        hb.a.add(this.vA)
        hb.b.copy(hb.a)
        hb.collider.setTranslationWrtParent({ x: hb.a.x, y: hb.a.y, z: hb.a.z })
        continue
      }
      if (hb.def.extend > 0) {
        this.vA.copy(hb.b).sub(hb.a)
        if (this.vA.lengthSq() > 1e-6) hb.b.addScaledVector(this.vA.normalize(), hb.def.extend)
      }
      this.vA.copy(hb.b).sub(hb.a)
      const len = this.vA.length()
      // Rapier capsules add a hemisphere at each end, so the cylindrical part
      // has to shrink by the radius for the collider to match the bone segment.
      const half = Math.max(0.02, len * 0.5 - hb.def.radius)
      this.vB.copy(hb.a).add(hb.b).multiplyScalar(0.5)
      hb.collider.setTranslationWrtParent({ x: this.vB.x, y: this.vB.y, z: this.vB.z })
      if (len > 1e-5) {
        this.qA.setFromUnitVectors(UP, this.vA.divideScalar(len))
        hb.collider.setRotationWrtParent({ x: this.qA.x, y: this.qA.y, z: this.qA.z, w: this.qA.w })
      }
      hb.collider.setHalfHeight(half)
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Kicks the recoil spring and lights the muzzle for a couple of frames. */
  fireVisuals(): void {
    this.recoilVel += 9.5
    this.recoil = Math.min(1, this.recoil + 0.35)
    this.muzzleFlashT = 0.055
    this.flash.visible = true
    this.flash.rotation.z = (this.flash.rotation.z + 1.7) % Math.PI
    const s = 0.85 + ((this.id * 37) % 30) / 100
    this.flash.scale.setScalar(s)
  }

  /** Holds the flash on for the frozen capture frame. */
  forceFlash(): void {
    this.muzzleFlashT = 1
    this.flash.visible = true
    // A soldier who has not fired yet still carries the identity transform, so
    // without this every flash in a capture is the same star at the same roll
    // and reads as a stamp. Derive both from the id rather than the shot count:
    // the frozen frame has to look like three separate weapons firing.
    this.flash.rotation.z = ((this.id * 0.79) % 1) * Math.PI
    this.flash.scale.setScalar(0.88 + ((this.id * 37) % 27) / 100)
    this.recoil = Math.max(this.recoil, 0.7)
  }

  startReload(): void {
    if (this.reloadT < 0) this.reloadT = 0
  }

  get isReloading(): boolean {
    return this.reloadT >= 0
  }

  get isFlashing(): boolean {
    return this.muzzleFlashT > 0
  }

  /** Chest-height point used for line of sight tests against this soldier. */
  chest(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.groundY + 1.32 - this.stanceBlend * 0.35 - this.proneBlend * 1.0, this.position.z)
  }
}

const RIGHT = new THREE.Vector3(1, 0, 0)
const RELOAD_SECONDS = 2.5
/** Wrist rotation that takes the bind weapon axis onto the body's forward axis. */
const RIFLE_PITCH_OFFSET = -0.1772
const RIFLE_YAW_OFFSET = -0.0691

function eyeHeight(crouch: number, prone: number): number {
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(1.62, 1.22, crouch), 0.36, prone)
}

/** Cached bind lengths so IK does not recompute square roots every frame. */
const BONE_LEN = new Map<BoneName, number>()
function boneLen(name: BoneName): number {
  let v = BONE_LEN.get(name)
  if (v === undefined) {
    const def = BIND[name]
    const p = BIND[def.parent!].p
    v = Math.hypot(def.p[0] - p[0], def.p[1] - p[1], def.p[2] - p[2])
    BONE_LEN.set(name, v)
  }
  return v
}

function angleDelta(from: number, to: number): number {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t
}

function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const denom = abx * abx + aby * aby + abz * abz
  let t = denom > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / denom : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t)
}

/**
 * Heel strike, roll through flat, drive off the toe. Scaled down to nothing as
 * the soldier stops, so a standing soldier is not frozen mid-toe-off.
 */
function footPitch(p: number, stanceFrac: number, speedNorm: number): number {
  const stride = Math.min(1, speedNorm * 5)
  if (stride <= 0.001) return 0
  let a: number
  if (p < stanceFrac) {
    const s = p / stanceFrac
    a = s < 0.22 ? THREE.MathUtils.lerp(0.16 * speedNorm, 0, s / 0.22)
      : s < 0.7 ? 0
        : THREE.MathUtils.lerp(0, -0.5 - 0.15 * speedNorm, (s - 0.7) / 0.3)
  } else {
    const s = (p - stanceFrac) / (1 - stanceFrac)
    a = s < 0.4 ? THREE.MathUtils.lerp(-0.5 - 0.15 * speedNorm, 0.1, s / 0.4)
      : THREE.MathUtils.lerp(0.1, 0.16 * speedNorm, (s - 0.4) / 0.6)
  }
  return a * stride
}

/** The weapon cants inboard while the support hand is off the handguard. */
function reloadCant(t: number): number {
  if (t < 0.12) return (t / 0.12) * 0.35
  if (t < 0.8) return 0.35
  return (1 - (t - 0.8) / 0.2) * 0.35
}

const RELOAD_TMP = new THREE.Vector3()

/**
 * Support-hand path for the reload: handguard → magwell → chest pouch →
 * magwell → handguard, with the magazine seat held for a beat.
 */
function reloadHandTarget(rig: SoldierRig, t: number, out: THREE.Vector3): THREE.Vector3 {
  rig.foregrip.getWorldPosition(out)
  rig.magwell.getWorldPosition(RELOAD_TMP)
  const pouch = rig.bones.chest
  if (t < 0.16) {
    out.lerp(RELOAD_TMP, smooth(t / 0.16))
  } else if (t < 0.34) {
    out.copy(RELOAD_TMP)
    // Reach down to the rig for a fresh magazine.
    const s = smooth((t - 0.16) / 0.18)
    RELOAD_TMP.setFromMatrixPosition(pouch.matrixWorld)
    RELOAD_TMP.y -= 0.16
    out.lerp(RELOAD_TMP, s)
  } else if (t < 0.52) {
    RELOAD_TMP.setFromMatrixPosition(pouch.matrixWorld)
    RELOAD_TMP.y -= 0.16
    out.copy(RELOAD_TMP)
    rig.magwell.getWorldPosition(RELOAD_TMP)
    out.lerp(RELOAD_TMP, smooth((t - 0.34) / 0.18))
  } else if (t < 0.72) {
    out.copy(RELOAD_TMP)
  } else {
    out.copy(RELOAD_TMP)
    rig.foregrip.getWorldPosition(RELOAD_TMP)
    out.lerp(RELOAD_TMP, smooth((t - 0.72) / 0.28))
  }
  return out
}

function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}
