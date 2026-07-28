import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

/**
 * Camera motion blur reconstructed from depth.
 *
 * Each pixel's world position is recovered from the depth buffer, projected
 * through last frame's view-projection, and the resulting screen-space delta
 * is used as the blur direction. That gives correct parallax — near geometry
 * smears further than the skyline during a turn — without a velocity buffer or
 * a second pass over the scene.
 *
 * Only world geometry is blurred: this runs before the viewmodel is drawn, so
 * the weapon stays locked and sharp the way it does in a shipped shooter.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform mat4 inverseViewProjection;
uniform mat4 previousViewProjection;
uniform float blurScale;
uniform float maxBlur;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = inverseViewProjection * clip;
  world /= world.w;

  vec4 previous = previousViewProjection * world;
  vec2 previousUv = (previous.xy / previous.w) * 0.5 + 0.5;

  vec2 velocity = (uv - previousUv) * blurScale;
  float speed = length(velocity);
  if (speed < 3e-4) {
    outputColor = inputColor;
    return;
  }
  velocity *= min(1.0, maxBlur / speed);

  vec4 sum = inputColor;
  for (int i = 1; i < SAMPLES; ++i) {
    float t = float(i) / float(SAMPLES - 1) - 0.5;
    sum += texture2D(inputBuffer, clamp(uv + velocity * t, vec2(0.0), vec2(1.0)));
  }
  outputColor = sum / float(SAMPLES);
}
`

export interface MotionBlurEffectOptions {
  samples?: number
  /** Shutter angle, as a fraction of a frame. 0.5 is a 180 degree shutter. */
  shutter?: number
  /** Hard cap on the smear, in UV units. Keeps fast turns from going to mush. */
  maxBlur?: number
}

export class MotionBlurEffect extends Effect {
  private readonly currentViewProjection = new THREE.Matrix4()
  private readonly previousViewProjection = new THREE.Matrix4()
  private readonly inverseViewProjection = new THREE.Matrix4()
  private readonly shutter: number
  private primed = false

  constructor({ samples = 9, shutter = 0.5, maxBlur = 0.012 }: MotionBlurEffectOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['inverseViewProjection', new THREE.Uniform(new THREE.Matrix4())],
      ['previousViewProjection', new THREE.Uniform(new THREE.Matrix4())],
      ['blurScale', new THREE.Uniform(0)],
      ['maxBlur', new THREE.Uniform(maxBlur)],
    ])

    super('MotionBlurEffect', FRAGMENT_SHADER, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      defines: new Map([['SAMPLES', Math.max(3, Math.round(samples)).toFixed(0)]]),
      uniforms,
    })

    this.shutter = shutter
  }

  /**
   * Call once per frame with the camera as it was actually rendered. `dt` is
   * used to normalise the smear so the blur length is the same at 30fps and
   * 144fps rather than scaling with the frame time.
   */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    this.previousViewProjection.copy(this.currentViewProjection)
    this.currentViewProjection
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse)
    this.inverseViewProjection.copy(this.currentViewProjection).invert()

    if (!this.primed) {
      this.previousViewProjection.copy(this.currentViewProjection)
      this.primed = true
    }

    const uniforms = this.uniforms
    ;(uniforms.get('inverseViewProjection')!.value as THREE.Matrix4).copy(this.inverseViewProjection)
    ;(uniforms.get('previousViewProjection')!.value as THREE.Matrix4).copy(this.previousViewProjection)

    const frameRatio = dt > 1e-5 ? Math.min(1 / 60 / dt, 2) : 0
    uniforms.get('blurScale')!.value = this.shutter * frameRatio
  }

  /** Drops the history so the next frame cannot smear across a teleport. */
  reset(): void {
    this.primed = false
  }
}
