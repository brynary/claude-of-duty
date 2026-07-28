import * as THREE from 'three'
import type { GameContext, System, PlayerService } from '../core/Types'
import { applyPose } from '../core/Poses'

/**
 * Character controller and camera rig: ground movement, sprint, crouch, slide,
 * mantle, jump, head bob, view sway and recoil accumulation.
 *
 * STUB — replaced by the movement pass.
 */
export class PlayerSystem implements System, PlayerService {
  readonly name = 'player'

  position = new THREE.Vector3()
  velocity = new THREE.Vector3()
  eye = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = true
  isSprinting = false
  isCrouching = false
  isSliding = false
  health = 100
  speedFraction = 0

  private posed = false

  init(ctx: GameContext): void {
    const level = ctx.services.level!
    this.position.copy(level.playerSpawn)
    this.yaw = level.playerSpawnYaw
    this.eye.copy(this.position)
    ctx.services.player = this

    if (ctx.config.pose) {
      const pose = applyPose(ctx.camera, ctx.config.pose)
      if (pose) {
        this.posed = true
        this.position.set(...pose.position)
        this.eye.copy(this.position)
        this.yaw = THREE.MathUtils.degToRad(pose.yaw)
        this.pitch = THREE.MathUtils.degToRad(pose.pitch)
      }
    }
  }

  update(dt: number, ctx: GameContext): void {
    const { input, camera, config } = ctx

    if (!this.posed) {
      this.yaw -= input.mouseDX * config.sensitivity
      this.pitch -= input.mouseDY * config.sensitivity
      this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01)

      const forward = input.axis('KeyS', 'KeyW')
      const strafe = input.axis('KeyA', 'KeyD')
      this.isSprinting = input.isDown('ShiftLeft') && forward > 0
      const speed = this.isSprinting ? 7.2 : 4.6

      const dir = new THREE.Vector3(strafe, 0, -forward)
      if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw)
      this.velocity.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-16 * dt))
      this.position.addScaledVector(this.velocity, dt)
      this.position.y = 1.7
      this.speedFraction = this.velocity.length() / 7.2
      this.eye.copy(this.position)
    }

    camera.position.copy(this.eye)
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    ctx.viewmodelCamera.quaternion.copy(camera.quaternion)
    ctx.viewmodelCamera.position.copy(camera.position)
  }
}
