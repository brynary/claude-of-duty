import * as THREE from 'three'
import { SPRITE } from './FxTextures'
import type { Particles } from './Particles'
import type { FxLightPool } from './FxLights'
import type { GameContext } from '../core/Types'
import type { Rand } from '../core/Rand'

/**
 * Muzzle flash.
 *
 * Four layers fired together and gone in two or three frames: a hot white core,
 * an orange bloom, a radial star flare, and propellant smoke. Every parameter
 * is re-rolled per shot — a flash that repeats identically reads as a decal
 * stuck to the barrel.
 *
 * The flash also drives a real point light, so the walls beside the player
 * actually brighten when the gun goes off. That single detail is most of what
 * separates a convincing weapon from a glowing sprite.
 */

export class MuzzleFlash {
  private readonly origin = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly up = new THREE.Vector3()
  private readonly worldOrigin = new THREE.Vector3()
  private readonly worldForward = new THREE.Vector3()
  private readonly worldRight = new THREE.Vector3()
  private readonly worldUp = new THREE.Vector3()
  private readonly camForward = new THREE.Vector3()
  private readonly world = new THREE.Matrix4()
  private readonly dir = new THREE.Vector3()
  private readonly colour = new THREE.Color()

  constructor(
    private readonly worldParticles: Particles,
    private readonly viewParticles: Particles,
    private readonly worldLights: FxLightPool,
    private readonly viewLights: FxLightPool,
    private readonly rand: Rand,
  ) {}

  /**
   * `forwardHint` short-circuits the barrel-axis guess; pass it whenever the
   * shot direction is already known.
   */
  fire(
    ctx: GameContext,
    matrix: THREE.Matrix4,
    scale: number,
    inViewmodelScene: boolean,
    time: number,
    forwardHint?: THREE.Vector3,
  ): void {
    const r = this.rand
    this.origin.setFromMatrixPosition(matrix)

    // The muzzle's forward axis convention is not fixed by the interface, so
    // resolve it: the barrel always points away from the shooter.
    this.forward.set(matrix.elements[8], matrix.elements[9], matrix.elements[10]).normalize()
    this.right.set(matrix.elements[0], matrix.elements[1], matrix.elements[2]).normalize()
    this.up.set(matrix.elements[4], matrix.elements[5], matrix.elements[6]).normalize()
    this.forward.negate()

    ctx.camera.getWorldDirection(this.camForward)

    // Viewmodel-space matrices arrive close to the origin; promote to world.
    const local = inViewmodelScene && this.origin.length() < 3.5
    if (local) {
      this.world.multiplyMatrices(ctx.viewmodelCamera.matrixWorld, matrix)
      this.worldOrigin.setFromMatrixPosition(this.world)
      this.worldForward.set(this.world.elements[8], this.world.elements[9], this.world.elements[10]).normalize().negate()
      if (this.worldForward.dot(this.camForward) < 0) this.worldForward.negate()
      // In viewmodel space the camera looks down -Z, so the barrel must too.
      if (this.forward.z > 0) this.forward.negate()
      this.worldRight.set(this.world.elements[0], this.world.elements[1], this.world.elements[2]).normalize()
      this.worldUp.set(this.world.elements[4], this.world.elements[5], this.world.elements[6]).normalize()
      // If the viewmodel scene turns out not to be camera-relative, the promoted
      // position lands nowhere near the player. Put the world half of the effect
      // just in front of the camera instead of at the far side of the level.
      if (this.worldOrigin.distanceToSquared(ctx.camera.position) > 16) {
        this.worldOrigin.copy(ctx.camera.position).addScaledVector(this.camForward, 0.55)
        this.worldForward.copy(this.camForward)
        this.worldRight.copy(this.camForward).cross(ctx.camera.up).normalize()
        this.worldUp.copy(this.worldRight).cross(this.camForward).normalize()
      }
    } else {
      this.worldOrigin.copy(this.origin)
      this.worldForward.copy(this.forward)
      if (forwardHint) {
        this.worldForward.copy(forwardHint).normalize()
      } else {
        // Otherwise assume a world-space muzzle belongs to someone shooting at
        // the player, and point the barrel that way.
        this.dir.copy(ctx.camera.position).sub(this.worldOrigin)
        if (this.worldForward.dot(this.dir) < 0) this.worldForward.negate()
      }
      this.forward.copy(this.worldForward)
      this.worldRight.copy(this.right)
      this.worldUp.copy(this.up)
    }

    const P = inViewmodelScene ? this.viewParticles : this.worldParticles
    const flashScale = scale * r.range(0.86, 1.22)
    const origin = inViewmodelScene ? this.origin : this.worldOrigin
    const forward = inViewmodelScene ? this.forward : this.worldForward

    // 1. Hot white core, one to two frames.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.035 * flashScale)
      p.life = 0.035
      p.sizeStart = 0.115 * flashScale
      p.sizeEnd = 0.16 * flashScale
      p.drag = 6
      p.colorStart.setRGB(6.5, 5.4, 3.6)
      p.colorEnd.setRGB(3.0, 1.7, 0.6)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.tile = SPRITE.core
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 2. Orange bloom, slightly longer and larger.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.075 * flashScale)
      p.life = 0.055
      p.sizeStart = 0.2 * flashScale
      p.sizeEnd = 0.34 * flashScale
      p.drag = 8
      p.colorStart.setRGB(4.2, 1.9, 0.55)
      p.colorEnd.setRGB(1.2, 0.34, 0.05)
      p.alphaStart = 0.95
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(6)
      p.tile = SPRITE.puff
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 3. Radial star flare — the shape the eye actually registers.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.05 * flashScale)
      p.life = 0.045
      p.sizeStart = 0.34 * flashScale * r.range(0.8, 1.35)
      p.sizeEnd = p.sizeStart * 1.25
      p.drag = 8
      p.colorStart.setRGB(5.2, 3.4, 1.5)
      p.colorEnd.setRGB(1.6, 0.6, 0.15)
      p.alphaStart = 0.9
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(2)
      p.tile = SPRITE.star
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 4. Burning propellant thrown forward out of the barrel.
    const sparkCount = r.int(4, 9)
    for (let i = 0; i < sparkCount; i++) {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.05 * flashScale)
      this.dir.copy(forward)
        .addScaledVector(this.right, r.spread(0.34))
        .addScaledVector(this.up, r.spread(0.34))
        .normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(4, 14))
      p.life = r.range(0.08, 0.22)
      p.sizeStart = r.range(0.008, 0.018) * flashScale
      p.sizeEnd = 0.002
      p.drag = 4
      p.gravity = 0.5
      p.colorStart.setRGB(4.5, 2.6, 0.9)
      p.colorEnd.setRGB(1.2, 0.25, 0.03)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.stretch = 0.05
      p.tile = SPRITE.streak
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 5. Propellant smoke always lives in world space so it hangs where it was
    //    made instead of riding the camera.
    const smokeCount = 2 + (r.bool(0.4) ? 1 : 0)
    for (let i = 0; i < smokeCount; i++) {
      const p = this.worldParticles.params
      p.position.copy(this.worldOrigin).addScaledVector(this.worldForward, r.range(0.04, 0.3) * flashScale)
      this.dir.copy(this.worldForward)
        .addScaledVector(this.worldRight, r.spread(0.5))
        .addScaledVector(this.worldUp, r.spread(0.5))
        .normalize()
      p.velocity.copy(this.dir).multiplyScalar(r.range(0.8, 2.6))
      p.velocity.y += 0.3
      p.life = r.range(0.7, 1.5)
      p.sizeStart = r.range(0.09, 0.16) * flashScale
      p.sizeEnd = r.range(0.5, 0.95) * flashScale
      p.drag = 3.4
      p.gravity = -0.05
      p.turbulence = 0.22
      p.colorStart.setHex(0xa9a49a, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x6c6862, THREE.SRGBColorSpace)
      p.alphaStart = 0.3
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(1.4)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.6
      p.soft = 0.4
      this.worldParticles.emit('smoke', time)
    }

    // 6. The light. Warm, short, and bright enough to matter indoors.
    this.colour.setRGB(1.0, 0.72, 0.42)
    const peak = 26 * scale
    this.worldLights.flash(this.worldOrigin, this.colour, peak, 11 * scale, 0.07, time, 2.6)
    if (inViewmodelScene) {
      this.viewLights.flash(this.origin, this.colour, 4.5 * scale, 1.6 * scale, 0.07, time, 2.6)
    }
  }
}
