import * as THREE from 'three'
import type { GameContext, System, LevelService } from '../core/Types'
import { Rand } from '../core/Rand'

/**
 * Builds the playable space: terrain, buildings, props, cover and foliage,
 * and registers all of it with physics.
 *
 * STUB — replaced by the level pass.
 */
export class LevelSystem implements System, LevelService {
  readonly name = 'level'

  spawnPoints: THREE.Vector3[] = []
  playerSpawn = new THREE.Vector3(4, 1.7, 12)
  playerSpawnYaw = Math.PI
  bounds = new THREE.Box3(new THREE.Vector3(-40, -2, -40), new THREE.Vector3(40, 30, 40))

  private root = new THREE.Group()

  init(ctx: GameContext): void {
    const { scene, services } = ctx
    const mats = services.materials!
    const physics = services.physics!
    const rng = new Rand(ctx.config.seed)

    this.root.name = 'level'
    scene.add(this.root)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160, 1, 1),
      mats.get('asphalt'),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.root.add(ground)
    physics.addStatic(ground, 'concrete')

    // Placeholder blockout so the harness has something to frame.
    const box = new THREE.BoxGeometry(1, 1, 1)
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(box, mats.get('concrete'))
      m.scale.set(rng.range(2, 6), rng.range(2, 8), rng.range(2, 6))
      m.position.set(rng.range(-30, 30), m.scale.y / 2, rng.range(-30, 30))
      m.castShadow = true
      m.receiveShadow = true
      this.root.add(m)
      physics.addStatic(m, 'concrete')
      this.spawnPoints.push(new THREE.Vector3(m.position.x + 3, 0, m.position.z + 3))
    }

    services.level = this
  }

  isIndoors(_point: THREE.Vector3): boolean {
    return false
  }

  dispose(): void {
    this.root.removeFromParent()
  }
}
