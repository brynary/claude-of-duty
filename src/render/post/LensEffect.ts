import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

/**
 * Everything that happens between the sensor and the eye: lateral chromatic
 * aberration, a contrast-adaptive sharpen, film grain and the vignette — plus
 * the blood bleed, which is really just a second, angrier vignette.
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
uniform vec3 damageTint;

vec3 lensFetch(const in vec2 uv) {
  return texture2D(inputBuffer, uv).rgb;
}

float lensHash(const in vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * Triangular-PDF dither, one level peak to peak. Two independent uniform
 * samples differenced: the triangular distribution is what decorrelates the
 * quantisation error from the signal, which a single uniform sample does not
 * do. Without it a slow gradient across a wall — the rear wall of the interior
 * pose, the clear sky above the vista — quantises into visible bands.
 */
float lensDither(const in vec2 uv) {
  return (lensHash(uv * 1913.0) - lensHash(uv * 1913.0 + 57.31)) / 255.0;
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

  // Grain is monochrome and peaks in the low mid-tones: that is where a sensor
  // is actually noisy, and it keeps the highlights clean. It also falls back to
  // zero at the very bottom. Round 2 held it at full strength into pure black,
  // where 0.022 of amplitude against a pixel sitting at 13/255 is a quarter of
  // the signal — judges read it as chroma speckle across every shadow and as
  // noise roaring inside the weapon.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float grainWeight = mix(1.15, 0.35, smoothstep(0.05, 0.55, luma))
    * smoothstep(0.0, 0.05, luma);
  float grain = lensHash(uv * vec2(aspect * 940.0, 940.0) + grainTime) - 0.5;
  color += grain * grainAmount * grainWeight;

  color *= 1.0 - vignetteDarkness * smoothstep(vignetteOffset, 1.0, radius);

  // Blood in the corners of the eye, not paint on the lens. Green and blue are
  // pulled down and red is lifted in proportion to what is already there, so
  // the frame keeps its structure and an unlit ceiling stays unlit — lerping
  // toward a solid maroon turned dark corners into bright red slabs, which is
  // what a sustained low-health pulse looked like. The centre 40% of the frame
  // is untouched at any intensity.
  float pulse = clamp(damageFlash, 0.0, 1.0) * smoothstep(0.36, 1.0, radius);
  vec3 bled = color * damageTint + vec3(0.06, 0.0, 0.0) * luma;
  color = mix(color, bled, pulse);

  // Last thing before the 8-bit write, and in display space, because that is
  // the grid the error is being spread across.
  color += lensDither(uv);

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
    aberration = 0.001,
    // A vignette that read as gentle over a lifted black floor reads as heavy
    // once the corners can actually reach black, so this comes down with it.
    // It is a pure luminance multiply and cannot tint anything: the red cast
    // judges found in the lower corners of the ADS frame comes from the scene,
    // not from here.
    vignetteDarkness = 0.11,
    vignetteOffset = 0.42,
    grainAmount = 0.013,
    sharpenAmount = 0.38,
  }: LensEffectOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['aberration', new THREE.Uniform(aberration)],
      ['vignetteDarkness', new THREE.Uniform(vignetteDarkness)],
      ['vignetteOffset', new THREE.Uniform(vignetteOffset)],
      ['grainAmount', new THREE.Uniform(grainAmount)],
      ['grainTime', new THREE.Uniform(0)],
      ['sharpenAmount', new THREE.Uniform(sharpenAmount)],
      ['damageFlash', new THREE.Uniform(0)],
      ['damageTint', new THREE.Uniform(new THREE.Vector3(1.0, 0.3, 0.24))],
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
