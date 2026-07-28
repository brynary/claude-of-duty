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
 *
 * **Energy budget.** Bloom keys off scene luminance above 1.6, and the sun is
 * 2.1. The layers are authored so the summed core sits a little over the bloom
 * threshold and rolls off warm through the tonemapper, rather than clipping to
 * flat white with a wide halo — a flash that erases the soldier holding it is
 * worse than no flash. The light is 5cd at 6.5m to match the intensity the AI
 * muzzle lights already use, so the player's gun and an enemy's read alike.
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
  private readonly lightPos = new THREE.Vector3()
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

    // 1. Hot core, one to two frames. Small and only just over the bloom
    //    threshold: this is the part that must not become a white disc.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.035 * flashScale)
      p.life = 0.035
      p.sizeStart = 0.075 * flashScale
      p.sizeEnd = 0.105 * flashScale
      p.drag = 6
      p.colorStart.setRGB(3.2, 2.4, 1.3)
      p.colorEnd.setRGB(1.4, 0.85, 0.32)
      p.alphaStart = 1
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.tile = SPRITE.core
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 2. Orange bloom, slightly longer and larger. Carries the hue that has to
    //    survive the tonemapper, so it stays well under the core in luminance.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.075 * flashScale)
      p.life = 0.055
      p.sizeStart = 0.13 * flashScale
      p.sizeEnd = 0.22 * flashScale
      p.drag = 8
      p.colorStart.setRGB(1.75, 0.78, 0.22)
      p.colorEnd.setRGB(0.55, 0.15, 0.02)
      p.alphaStart = 0.9
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(6)
      p.tile = SPRITE.puff
      p.soft = 0
      P.emit('spriteAdd', time)
    }

    // 3. Radial star flare — the shape the eye actually registers, and the
    //    reason the flash reads as directional rather than as a cotton ball.
    {
      const p = P.params
      p.position.copy(origin).addScaledVector(forward, 0.05 * flashScale)
      p.life = 0.045
      p.sizeStart = 0.23 * flashScale * r.range(0.8, 1.35)
      p.sizeEnd = p.sizeStart * 1.25
      p.drag = 8
      p.colorStart.setRGB(1.9, 1.25, 0.55)
      p.colorEnd.setRGB(0.6, 0.22, 0.05)
      p.alphaStart = 0.85
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
      p.sizeStart = r.range(0.007, 0.015) * flashScale
      p.sizeEnd = 0.002
      p.drag = 4
      p.gravity = 0.5
      p.colorStart.setRGB(2.4, 1.4, 0.5)
      p.colorEnd.setRGB(0.7, 0.15, 0.02)
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
      // Kept small: this card is born 60cm from the player's own lens, and at
      // half a metre a puff of any size is a screen-wide grey veil.
      p.sizeStart = r.range(0.07, 0.12) * flashScale
      p.sizeEnd = r.range(0.28, 0.5) * flashScale
      p.drag = 3.4
      p.gravity = -0.05
      p.turbulence = 0.22
      p.colorStart.setHex(0xc4beb2, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x7f7a73, THREE.SRGBColorSpace)
      p.alphaStart = 0.24
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(1.4)
      p.tile = r.int(0, 3)
      p.frames = 16
      p.erode = 0.6
      p.soft = 0.4
      this.worldParticles.emit('smoke', time)
    }

    // 6. The light, pushed clear of the muzzle so the shooter's own hands and
    //    chest are not sitting 20cm from a point source. Matched to the AI
    //    muzzle lights (5cd, 6.5m) so every gun in frame flashes alike.
    this.colour.setRGB(1.0, 0.72, 0.42)
    this.lightPos.copy(this.worldOrigin).addScaledVector(this.worldForward, 0.35)
    this.worldLights.flash(this.lightPos, this.colour, 5 * scale, 6.5 * scale, 0.06, time, 2.6)
    if (inViewmodelScene) {
      this.viewLights.flash(this.origin, this.colour, 1.6 * scale, 1.4 * scale, 0.06, time, 2.6)
    }
  }
}
