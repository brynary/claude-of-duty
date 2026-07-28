import type * as THREE from 'three'
import type { GameContext, System, AudioService, PlayOptions } from '../core/Types'

/**
 * WebAudio mix: procedurally synthesised weapon and impact sounds, positional
 * panning, distance attenuation, convolution reverb and dynamic ducking.
 *
 * STUB — replaced by the audio pass.
 */
export class AudioSystem implements System, AudioService {
  readonly name = 'audio'

  init(ctx: GameContext): void {
    ctx.services.audio = this
  }

  play(_id: string, _position?: THREE.Vector3, _opts?: PlayOptions): void {}
  play2D(_id: string, _opts?: PlayOptions): void {}
  setListener(_p: THREE.Vector3, _f: THREE.Vector3, _u: THREE.Vector3): void {}
  duck(_amount: number, _seconds: number): void {}
  setReverbZone(_zone: 'outdoor' | 'indoor' | 'tunnel' | 'hall'): void {}
}
