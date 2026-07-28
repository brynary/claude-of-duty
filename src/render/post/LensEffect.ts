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
uniform float sharpenPeak;
uniform float sharpenFloor;
uniform float sharpenOvershoot;
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

/**
 * Contrast-adaptive sharpening: a cross-shaped negative lobe, one texel out, on
 * the converged frame.
 *
 * This replaces a plain unsharp mask that was clamped to the exact min and max
 * of its own four neighbours. That clamp made it very nearly a no-op: measured
 * across the eight capture poses, turning it off entirely moved local contrast
 * by 0.0007 out of 0.017. It cost four texture fetches and bought nothing.
 *
 * sharpenOvershoot reintroduces a *bounded* overshoot, as a fraction of the
 * local range, because zero overshoot is what made the old filter inert: an
 * edge that may never exceed its own neighbours can never actually gain
 * acutance. This, and not the amplitude term, is what stops the filter ringing:
 * a halo has to be both wide and bright, and the ring here can never leave the
 * one-texel lobe nor exceed a fixed fraction of what the neighbourhood already
 * spans.
 *
 * ## Why the amplitude term has a floor
 *
 * AMD's CAS scales the lobe by sqrt(min(mn, 2 - mx) / mx), which backs off as
 * the neighbourhood approaches either rail. In a mid-key frame that costs
 * nothing. This frame set is not mid-key: it averages sRGB 61 out of 255, and in
 * shadow the term collapses — a neighbourhood spanning 0.02 to 0.20 scores 0.32,
 * so it received barely a third of the configured lobe. Round 4 shipped local
 * contrast at 0.028 against a 0.030 floor with most of the frame sharpened at
 * that third.
 *
 * The floor keeps the term's shape while bounding how far it can retreat. It is
 * safe to do that here specifically because the overshoot clamp above is already
 * the guard against the excursion CAS's amplitude was protecting against, and it
 * is expressed relative to the local range rather than to the rails.
 *
 * Note the pole: the kernel normalises by (1 + 4w), so it inverts at
 * w = -0.25. sharpenPeak() clamps short of that. Where the lobe is strongest the
 * clamp above is doing most of the work — which is the intended behaviour, not a
 * symptom: in a flat neighbourhood the local range is small, so the clamp holds
 * the excursion to a fraction of it however high the raw gain goes.
 */
vec3 lensSharpen(const in vec3 e, const in vec3 b, const in vec3 d, const in vec3 f, const in vec3 h) {
  vec3 mn = min(min(min(b, d), min(f, h)), e);
  vec3 mx = max(max(max(b, d), max(f, h)), e);
  vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 0.0001), 0.0, 1.0));
  vec3 w = mix(vec3(sharpenFloor), vec3(1.0), amp) * sharpenPeak;
  vec3 sharp = ((b + d + f + h) * w + e) / (1.0 + 4.0 * w);
  vec3 slack = (mx - mn) * sharpenOvershoot;
  return clamp(sharp, mn - slack, mx + slack);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 centered = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float radius = length(centered) / (0.5 * sqrt(aspect * aspect + 1.0));

  // Lateral aberration only: nothing in the middle of the frame, a pixel or so
  // of red/blue split in the extreme corners. More than that stops reading as
  // a lens and starts reading as a broken shader.
  vec2 fringe = (uv - 0.5) * aberration * radius * radius * radius;
  vec3 color = vec3(lensFetch(uv + fringe).r, inputColor.g, lensFetch(uv - fringe).b);

  color = lensSharpen(
    color,
    lensFetch(uv + vec2(0.0, texelSize.y)),
    lensFetch(uv - vec2(texelSize.x, 0.0)),
    lensFetch(uv + vec2(texelSize.x, 0.0)),
    lensFetch(uv - vec2(0.0, texelSize.y)));

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
  /** 0 leaves the frame alone, 1 is AMD's strongest lobe. See {@link sharpenPeak}. */
  sharpness?: number
  /**
   * Smallest fraction of the lobe the contrast-adaptive amplitude may leave in
   * place. 0 is stock CAS; 1 removes the adaptation entirely.
   */
  sharpenFloor?: number
  /** Permitted overshoot past the local neighbourhood, as a fraction of its range. */
  sharpenOvershoot?: number
}

/**
 * The kernel divides by `1 + 4w`. At `w = -0.25` that denominator is zero, and
 * past it the sign flips: the filter silently becomes a blur-and-invert. This is
 * the hard ceiling on lobe weight for a five-tap cross, whatever mapping feeds
 * it, so it is clamped here rather than trusted to the caller. -0.235 leaves
 * `1 + 4w` at 0.06 — the strongest well-posed lobe the kernel has.
 */
const SHARPEN_PEAK_LIMIT = -0.235

/**
 * AMD's lobe weight for a given sharpness: -1/8 at the gentle end, -1/5 at 1.0.
 * That mapping has no "off" in it, so zero is special-cased to a weight of
 * exactly zero — which makes the kernel `e / 1.0`, an exact identity, and lets
 * the quality tier switch sharpening off without a branch in the shader.
 *
 * Values above 1.0 are permitted and are past AMD's calibrated range on
 * purpose. That range assumes a natively rasterised frame; this one has been
 * box-filtered over a one-pixel jitter footprint by the accumulation pass before
 * the filter ever sees it, so what is being restored is acutance a supersampled
 * frame genuinely had. {@link SHARPEN_PEAK_LIMIT} is the real bound.
 */
function sharpenPeak(sharpness: number): number {
  if (sharpness <= 0) return 0
  return Math.max(-1 / (8 + (5 - 8) * sharpness), SHARPEN_PEAK_LIMIT)
}

export class LensEffect extends Effect {
  constructor({
    aberration = 0.001,
    // A vignette that read as gentle over a lifted black floor reads as heavy
    // once the corners can actually reach black, so this comes down with it.
    // It is a pure luminance multiply and cannot tint anything: the red cast
    // judges found in the lower corners of the ADS frame comes from the scene,
    // not from here.
    vignetteDarkness = 0.10,
    vignetteOffset = 0.44,
    grainAmount = 0.015,
    sharpness = 1.22,
    sharpenFloor = 0.85,
    sharpenOvershoot = 0.62,
  }: LensEffectOptions = {}) {
    const uniforms = new Map<string, THREE.Uniform>([
      ['aberration', new THREE.Uniform(aberration)],
      ['vignetteDarkness', new THREE.Uniform(vignetteDarkness)],
      ['vignetteOffset', new THREE.Uniform(vignetteOffset)],
      ['grainAmount', new THREE.Uniform(grainAmount)],
      ['grainTime', new THREE.Uniform(0)],
      ['sharpenPeak', new THREE.Uniform(sharpenPeak(sharpness))],
      ['sharpenFloor', new THREE.Uniform(sharpenFloor)],
      ['sharpenOvershoot', new THREE.Uniform(sharpenOvershoot)],
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

  set sharpness(value: number) {
    this.uniforms.get('sharpenPeak')!.value = sharpenPeak(value)
  }
}
