import * as THREE from 'three'
import type { GameContext, System, LightingService } from '../core/Types'

/**
 * Sun, sky, image-based ambient and the shadow cascade.
 *
 * STUB — replaced by the lighting pass.
 */
export class LightingSystem implements System, LightingService {
  readonly name = 'lighting'

  sun = new THREE.DirectionalLight(0xffe9c4, 3.2)
  sunDirection = new THREE.Vector3(-0.4, -0.72, -0.56).normalize()
  environment: THREE.Texture | null = null

  private hemi = new THREE.HemisphereLight(0x9fc0ea, 0x60584a, 0.9)

  init(ctx: GameContext): void {
    const { scene, config } = ctx

    this.sun.position.set(60, 95, 70)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.setScalar(config.shadowMapSize)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 320
    const extent = 70
    this.sun.shadow.camera.left = -extent
    this.sun.shadow.camera.right = extent
    this.sun.shadow.camera.top = extent
    this.sun.shadow.camera.bottom = -extent
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    scene.add(this.sun)
    scene.add(this.sun.target)
    scene.add(this.hemi)

    scene.background = new THREE.Color(0x8fb2d9)
    scene.fog = new THREE.FogExp2(0xb9c9d8, 0.0075)

    ctx.services.lighting = this
  }

  setTimeOfDay(_t: number): void {
    // Replaced by the lighting pass.
  }

  dispose(): void {
    this.sun.dispose()
    this.hemi.dispose()
  }
}
