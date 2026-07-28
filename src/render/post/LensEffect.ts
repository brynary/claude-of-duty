import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

/**
 * Everything that happens between the sensor and the eye: lateral chromatic
 * aberration, a contrast-adaptive sharpen, film grain and the vignette — plus
 * the red damage pulse, which is really just a second, angrier vignette.
 *
 * These are merged into one shader on purpose. Each is a couple of
 * instructions; run as separate passes they would cost four full-screen
 * round-trips of a half-float buffer for no benefit.
 *
 * Input arrives display-referred from the grade, so every constant here is in
 * the space it is judged in — 0.024 of grain really is about six levels out of
 * 255. The single conversion back to linear happens on the last line, because
 * three re-encodes when this pass writes to the canvas.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform float aberration;
uniform float vignetteDarkness;
uniform float vignetteOffset;
uniform float grainAmount;
uniform float grainTime;
uniform float sharpenAmount;
uniform float damageFlash;
uniform vec3 damageColor;

vec3 lensFetch(const in vec2 uv) {
  return texture2D(inputBuffer, uv).rgb;
}

float lensHash(const in vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 lensToLinear(const in vec3 c) {
  vec3 v = clamp(c, 0.0, 1.0);
  return mix(pow((v + 0.055) / 1.055, vec3(2.4)), v / 12.92, step(v, vec3(0.04045)));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 centered = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float radius = length(centered) / (0.5 * sqrt(aspect * aspect + 1.0));

  // Lateral aberration only: nothing in the middle of the frame, a pixel or so
  // of red/blue split in the extreme corners. More than that stops reading as
  // a lens and starts reading as a broken shader.
  vec2 fringe = (uv - 0.5) * aberration * radius * radius * radius;
  vec3 color = vec3(lensFetch(uv + fringe).r, inputColor.g, lensFetch(uv - fringe).b);

  // Contrast-adaptive sharpen, clamped to the local neighbourhood so edges
  // gain definition without haloing.
  vec3 n0 = lensFetch(uv + vec2(texelSize.x, 0.0));
  vec3 n1 = lensFetch(uv - vec2(texelSize.x, 0.0));
  vec3 n2 = lensFetch(uv + vec2(0.0, texelSize.y));
  vec3 n3 = lensFetch(uv - vec2(0.0, texelSize.y));
  vec3 blurred = (n0 + n1 + n2 + n3) * 0.25;
  vec3 lo = min(min(n0, n1), min(n2, n3));
  vec3 hi = max(max(n0, n1), max(n2, n3));
  color = clamp(color + (color - blurred) * sharpenAmount, min(color, lo), max(color, hi));

  // Grain scales with darkness: shadows are where a sensor is actually noisy,
  // and it leaves the highlights clean.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float grain = lensHash(uv * vec2(aspect * 940.0, 940.0) + grainTime) - 0.5;
  color += grain * grainAmount * mix(1.4, 0.3, smoothstep(0.06, 0.6, luma));

  color *= 1.0 - vignetteDarkness * smoothstep(vignetteOffset, 1.0, radius);

  float pulse = damageFlash * mix(0.22, 1.0, smoothstep(0.1, 0.95, radius));
  color = mix(color, damageColor, clamp(pulse, 0.0, 1.0));

  outputColor = vec4(lensToLinear(color), inputColor.a);
}
`

export interface LensEffectOptions {
  aberration?: number
  vignetteDarkness?: number
  vignetteOffset?: number
  grainAmount?: number
  sharpenAmount?: number
}

export class LensEffect extends Effect {
  constructor({
    aberration = 0.0012,
    vignetteDarkness = 0.28,
    vignetteOffset = 0.45,
    grainAmount = 0.024,
    sharpenAmount = 0.25,
  }: LensEffectOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['aberration', new THREE.Uniform(aberration)],
      ['vignetteDarkness', new THREE.Uniform(vignetteDarkness)],
      ['vignetteOffset', new THREE.Uniform(vignetteOffset)],
      ['grainAmount', new THREE.Uniform(grainAmount)],
      ['grainTime', new THREE.Uniform(0)],
      ['sharpenAmount', new THREE.Uniform(sharpenAmount)],
      ['damageFlash', new THREE.Uniform(0)],
      ['damageColor', new THREE.Uniform(new THREE.Color(0.46, 0.03, 0.02))],
    ])

    super('LensEffect', FRAGMENT_SHADER, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms,
    })
  }

  /** 0..1. Drives the red pulse and how far it creeps in from the edges. */
  set damageFlash(value: number) {
    this.uniforms.get('damageFlash')!.value = value
  }

  get damageFlash(): number {
    return this.uniforms.get('damageFlash')!.value as number
  }

  /** Seeded from simulation time so a frozen frame grains identically. */
  set grainTime(value: number) {
    this.uniforms.get('grainTime')!.value = value
  }

  set grainAmount(value: number) {
    this.uniforms.get('grainAmount')!.value = value
  }

  set aberration(value: number) {
    this.uniforms.get('aberration')!.value = value
  }

  set sharpenAmount(value: number) {
    this.uniforms.get('sharpenAmount')!.value = value
  }
}
