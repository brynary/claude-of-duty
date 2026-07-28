import type { GameContext, System, AiService, Damageable } from '../core/Types'
import type * as THREE from 'three'

/**
 * Enemy soldiers: navigation, cover selection, combat states, animation,
 * hit reactions and ragdoll death.
 *
 * STUB — replaced by the AI pass.
 */
export class AiSystem implements System, AiService {
  readonly name = 'ai'

  enemies: Damageable[] = []

  init(ctx: GameContext): void {
    ctx.services.ai = this
  }

  spawnWave(_count: number): void {}
  notifyNoise(_position: THREE.Vector3, _radius: number): void {}

  update(_dt: number, _ctx: GameContext): void {}
}
