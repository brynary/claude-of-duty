import type * as THREE from 'three'
import type { GameContext, System, FxService, Surface } from '../core/Types'

/**
 * All transient visual effects: impacts, decals, tracers, muzzle flash, shell
 * ejection, explosions, blood and smoke.
 *
 * STUB — replaced by the VFX pass.
 */
export class FxSystem implements System, FxService {
  readonly name = 'fx'

  init(ctx: GameContext): void {
    ctx.services.fx = this
  }

  impact(_point: THREE.Vector3, _normal: THREE.Vector3, _surface: Surface): void {}
  bulletTracer(_from: THREE.Vector3, _to: THREE.Vector3, _speed?: number): void {}
  muzzleFlash(_matrix: THREE.Matrix4, _scale: number, _inViewmodelScene: boolean): void {}
  ejectShell(_position: THREE.Vector3, _velocity: THREE.Vector3, _inViewmodelScene: boolean): void {}
  explosion(_point: THREE.Vector3, _radius: number): void {}
  blood(_point: THREE.Vector3, _normal: THREE.Vector3, _amount: number): void {}
  smokePuff(_point: THREE.Vector3, _radius: number): void {}

  update(_dt: number, _ctx: GameContext): void {}
}
