import * as THREE from 'three'
import { SPRITE } from './FxTextures'
import type { Particles } from './Particles'
import type { GameContext } from '../core/Types'
import type { Rand } from '../core/Rand'

/**
 * Ejected brass.
 *
 * Cases are simulated with a small dedicated integrator rather than rapier
 * bodies: a spent case is 12 grams and lives for four seconds, so a full rigid
 * body per round is pure overhead. Gravity, spin and a swept raycast against
 * the world give the bounce and the metallic ring; everything else is pooled
 * into a single instanced draw.
 *
 * Cases ejected from the viewmodel are promoted into world space on the way
 * out, so they fall behind the player instead of riding the camera.
 */

interface Shell {
  active: boolean
  born: number
  restUntil: number
  bounces: number
  position: THREE.Vector3
  velocity: THREE.Vector3
  spin: THREE.Vector3
  quat: THREE.Quaternion
  scale: number
  asleep: boolean
}

const GRAVITY = -19.6

export class Shells {
  private readonly mesh: THREE.InstancedMesh
  private readonly material: THREE.MeshStandardMaterial
  private readonly shells: Shell[] = []
  private head = 0

  private readonly m4 = new THREE.Matrix4()
  private readonly scaleVec = new THREE.Vector3()
  private readonly step = new THREE.Vector3()
  private readonly dirNorm = new THREE.Vector3()
  private readonly spinQuat = new THREE.Quaternion()
  private readonly spinAxis = new THREE.Vector3()
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  private readonly worldPos = new THREE.Vector3()
  private readonly worldVel = new THREE.Vector3()
  private readonly euler = new THREE.Euler()

  private readonly lifetime = 9

  constructor(
    scene: THREE.Scene,
    count: number,
    private readonly particles: Particles,
    private readonly rand: Rand,
  ) {
    // 5.56 x 45 case: 45 mm long, 9.6 mm at the rim.
    const geo = new THREE.CylinderGeometry(0.0044, 0.0048, 0.045, 12, 3, false)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      // Neck the mouth in slightly so the silhouette is not a plain tube.
      if (y > 0.014) {
        const k = 0.86
        pos.setXYZ(i, pos.getX(i) * k, y, pos.getZ(i) * k)
      } else if (y < -0.019) {
        const k = 1.12
        pos.setXYZ(i, pos.getX(i) * k, y, pos.getZ(i) * k)
      }
    }
    geo.computeVertexNormals()

    this.material = new THREE.MeshStandardMaterial({
      color: 0xc79a44,
      metalness: 1.0,
      roughness: 0.31,
      envMapIntensity: 1.35,
    })
    this.material.name = 'fx-brass'

    this.mesh = new THREE.InstancedMesh(geo, this.material, Math.max(8, count))
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.name = 'fx-shells'
    scene.add(this.mesh)

    for (let i = 0; i < this.mesh.count; i++) {
      this.shells.push({
        active: false, born: 0, restUntil: 0, bounces: 0,
        position: new THREE.Vector3(), velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(), quat: new THREE.Quaternion(),
        scale: 1, asleep: false,
      })
      this.mesh.setMatrixAt(i, this.hidden)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  eject(ctx: GameContext, position: THREE.Vector3, velocity: THREE.Vector3, inViewmodelScene: boolean, time: number): void {
    // Viewmodel-space ejections arrive within arm's reach of the origin.
    if (inViewmodelScene && position.length() < 3.5) {
      this.worldPos.copy(position).applyMatrix4(ctx.viewmodelCamera.matrixWorld)
      this.worldVel.copy(velocity).transformDirection(ctx.viewmodelCamera.matrixWorld).multiplyScalar(velocity.length())
    } else {
      this.worldPos.copy(position)
      this.worldVel.copy(velocity)
    }

    const s = this.shells[this.head]
    this.head = (this.head + 1) % this.shells.length
    const r = this.rand

    s.active = true
    s.asleep = false
    s.born = time
    s.restUntil = 0
    s.bounces = 0
    s.position.copy(this.worldPos)
    s.velocity.copy(this.worldVel)
    if (s.velocity.lengthSq() < 0.04) s.velocity.set(r.range(1.6, 3.4), r.range(1.2, 2.4), r.spread(0.6))
    // Inherit the shooter's motion so cases do not hang in mid-air when moving.
    const player = ctx.services.player
    if (player) s.velocity.addScaledVector(player.velocity, 0.75)
    s.spin.set(r.spread(34), r.spread(20), r.spread(34))
    this.euler.set(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28))
    s.quat.setFromEuler(this.euler)
    s.scale = 1
  }

  update(ctx: GameContext, time: number, dt: number): void {
    if (dt <= 0) {
      return
    }
    const physics = ctx.services.physics
    let dirty = false

    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i]
      if (!s.active) continue

      const age = time - s.born
      if (age > this.lifetime) {
        s.active = false
        this.mesh.setMatrixAt(i, this.hidden)
        dirty = true
        continue
      }

      if (!s.asleep) {
        s.velocity.y += GRAVITY * dt
        this.step.copy(s.velocity).multiplyScalar(dt)
        const travel = this.step.length()

        if (physics && travel > 1e-4) {
          this.dirNorm.copy(this.step).multiplyScalar(1 / travel)
          const hit = physics.raycast(s.position, this.dirNorm, travel + 0.012, { characters: false })
          // A zero-length hit means the case spawned inside geometry; nudge it
          // clear rather than pinning it to the spawn point forever.
          if (hit && hit.distance < 1e-4) {
            s.position.addScaledVector(hit.normal, 0.02).add(this.step)
          } else if (hit) {
            const speed = s.velocity.length()
            s.position.copy(hit.point).addScaledVector(hit.normal, 0.008)
            // Reflect, lose most of the energy, and scrub tangential speed.
            const vn = s.velocity.dot(hit.normal)
            s.velocity.addScaledVector(hit.normal, -2 * vn)
            s.velocity.multiplyScalar(0.34)
            s.spin.multiplyScalar(0.55)
            s.bounces++
            if (speed > 1.1 && s.bounces <= 3) {
              ctx.services.audio?.play('shell', s.position, { maxDistance: 26, pitch: this.rand.range(0.88, 1.16) })
              if (s.bounces === 1 && speed > 2.4) this.tick(s.position, hit.normal, time)
            }
            if (s.velocity.lengthSq() < 0.24 || s.bounces > 4) {
              s.asleep = true
              s.velocity.set(0, 0, 0)
              s.spin.set(0, 0, 0)
              // Lie flat on the surface it landed on.
              this.spinAxis.set(0, 1, 0).cross(hit.normal)
              if (this.spinAxis.lengthSq() < 1e-8) this.spinAxis.set(1, 0, 0)
              s.quat.setFromAxisAngle(this.spinAxis.normalize(), Math.PI * 0.5)
            }
          } else {
            s.position.add(this.step)
          }
        } else {
          s.position.add(this.step)
          if (s.position.y < -8) s.active = false
        }

        const spinLen = s.spin.length()
        if (spinLen > 1e-4) {
          this.spinAxis.copy(s.spin).multiplyScalar(1 / spinLen)
          this.spinQuat.setFromAxisAngle(this.spinAxis, spinLen * dt)
          s.quat.premultiply(this.spinQuat)
        }
      }

      // Fade out by shrinking rather than popping.
      const remaining = this.lifetime - age
      s.scale = remaining < 1.2 ? Math.max(0, remaining / 1.2) : 1
      this.scaleVec.setScalar(s.scale)
      this.m4.compose(s.position, s.quat, this.scaleVec)
      this.mesh.setMatrixAt(i, this.m4)
      dirty = true
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true
  }

  /** A spark and a puff of dust where hot brass hits the ground. */
  private tick(point: THREE.Vector3, normal: THREE.Vector3, time: number): void {
    const r = this.rand
    for (let i = 0; i < 2; i++) {
      const p = this.particles.params
      p.position.copy(point)
      p.velocity.copy(normal).multiplyScalar(r.range(0.4, 1.2))
      p.velocity.x += r.spread(0.5)
      p.velocity.z += r.spread(0.5)
      p.life = r.range(0.25, 0.5)
      p.sizeStart = r.range(0.02, 0.05)
      p.sizeEnd = r.range(0.09, 0.16)
      p.drag = 4
      p.gravity = 0.1
      p.colorStart.setHex(0xb3ac9c, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x86806f, THREE.SRGBColorSpace)
      p.alphaStart = 0.24
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.tile = SPRITE.puff
      p.soft = 0.25
      this.particles.emit('sprite', time)
    }
  }

  setEnvironment(env: THREE.Texture | null): void {
    this.material.envMap = env
    this.material.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}
