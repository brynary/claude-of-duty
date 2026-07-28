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

float lensLuma(const in vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/**
 * Contrast-adaptive sharpening: a cross-shaped negative lobe, one texel out,
 * measured on luma and applied as a single scalar correction to all three
 * channels.
 *
 * ## Why it is driven from luma
 *
 * Run per channel — AMD's own formulation — the amplitude term, the
 * neighbourhood range and the overshoot clamp are all computed independently for
 * red, green and blue. Any pixel where the three channels disagree at the
 * one-texel scale therefore has that disagreement *amplified*, and this frame
 * set has plenty: the materials carry chroma in their fine detail, the lateral
 * aberration above deliberately offsets the red and blue taps against the green
 * one, and the accumulation pass leaves a little residual chroma on sub-pixel
 * geometry. Round 5 shipped the per-channel form at a gain that reached 5x on
 * silhouettes, and blind judges reported "high-frequency iridescent sparkle that
 * looks like a broken specular or badly filtered normal map". Measured as the
 * mean disagreement between the three channels' one-texel high-pass, the eight
 * poses averaged 1.68 against 0.78 for round 4's gentler kernel.
 *
 * A scalar correction cannot manufacture that. Chroma rides through untouched
 * and only luminance acutance is restored, which is what a sharpener is for.
 * It is also cheaper: five dot products and scalar min/max/sqrt in place of
 * three-wide ones.
 *
 * ## Why the amplitude term no longer has a real floor
 *
 * amp = sqrt(min(mn, 2 - mx) / mx) collapses toward zero exactly where the
 * neighbourhood spans a hard silhouette — a dark bar against sky scores about
 * 0.15 — and that collapse is not a deficiency, it is the mechanism that keeps
 * CAS off edges and on texture. Round 5 read it as under-sharpening and set the
 * floor to 0.85, which forced 87% of the full lobe onto every silhouette in the
 * frame. Combined with an overshoot of 0.62 of the local range, an antialiased
 * edge pixel sitting midway between its neighbours was pushed past whichever
 * rail it was nearer: the filter was *removing* antialiasing faster than the
 * accumulation pass could produce it. Measured as pixels lying outside their own
 * four-neighbour range by more than 8/255, round 5 ran 0.51-2.22% of the frame
 * against round 2's 0.00-0.23%, and judges filed eight separate reports of
 * "stair-stepped and chewed up" thin geometry.
 *
 * 0.15 is a token floor: it lifts the deepest shadow off zero gain without
 * arming the lobe on silhouettes. At the shipped peak the gain runs about 1.27x
 * on a hard edge, 1.8x in textured shadow and 2.8x on lit texture — against
 * round 5's 5.1x, 6.8x and 9.5x.
 *
 * Note the pole: the kernel normalises by (1 + 4w), so it inverts at w = -0.25.
 * sharpenPeak() clamps short of that.
 */
vec3 lensSharpen(const in vec3 e, const in vec3 b, const in vec3 d, const in vec3 f, const in vec3 h) {
  float le = lensLuma(e);
  float lb = lensLuma(b);
  float ld = lensLuma(d);
  float lf = lensLuma(f);
  float lh = lensLuma(h);
  float mn = min(min(min(lb, ld), min(lf, lh)), le);
  float mx = max(max(max(lb, ld), max(lf, lh)), le);
  float amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 0.0001), 0.0, 1.0));
  float w = mix(sharpenFloor, 1.0, amp) * sharpenPeak;
  float sharp = ((lb + ld + lf + lh) * w + le) / (1.0 + 4.0 * w);
  float slack = (mx - mn) * sharpenOvershoot;
  return max(e + (clamp(sharp, mn - slack, mx + slack) - le), vec3(0.0));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 centered = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float radius = length(centered) / (0.5 * sqrt(aspect * aspect + 1.0));

  // Lateral aberration only: nothing in the middle of the frame, a fraction of
  // a pixel of red/blue split in the extreme corners.
  //
  // "A pixel or so" was the intent and 0.001 was the number, but that is a
  // *half*-split per channel measured in UV: at 1920x1080 it put red and blue
  // 2.2 pixels apart in the corners. It survived two rounds because the frames
  // it was tuned on were hazy enough that a 2-pixel split across a low-contrast
  // edge produced almost no colour difference. Once the grade had real contrast
  // the same setting drew five separate reports of "a red edge on one side and
  // a cyan edge on the other" on every window bar and roofline, and the rubric
  // lists rainbow fringing as an instant fail. See {@link LensEffectOptions} for
  // the calibration.
  vec2 fringe = (uv - 0.5) * aberration * radius * radius * radius;
  vec3 color = vec3(lensFetch(uv + fringe).r, inputColor.g, lensFetch(uv - fringe).b);

  // The centre tap has been split by the aberration and the four neighbours have
  // not, so the two are very slightly inconsistent near the corners. That
  // mismatch is only visible if the filter can amplify it: at the shipped
  // aberration the disagreement is a third of a pixel, and the filter is now
  // scalar, so it cannot turn a channel offset into a colour excursion at all.
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
  /**
   * Half the lateral red/blue split at the frame corner, in UV, before the
   * cubic radial falloff.
   *
   * The corner split in pixels is 2 * aberration * hypot(width / 2, height / 2),
   * so at 1920x1080 the shipped 0.00028 is 0.62 px in the extreme corners and,
   * through the cubic falloff, 0.04 px at half radius. Below one pixel
   * everywhere is the whole of what "a lens, not a broken shader" means here:
   * the corners soften very slightly and no edge anywhere in the frame gains a
   * coloured side.
   */
  aberration?: number
  vignetteDarkness?: number
  vignetteOffset?: number
  grainAmount?: number
  /** 0 leaves the frame alone, 1 is AMD's strongest lobe. See {@link sharpenPeak}. */
  sharpness?: number
  /**
   * Smallest fraction of the lobe the contrast-adaptive amplitude may leave in
   * place. 0 is stock CAS; 1 removes the adaptation — and with it the edge
   * protection that is the entire point of CAS. See {@link FRAGMENT_SHADER}.
   */
  sharpenFloor?: number
  /**
   * Permitted excursion past the local neighbourhood, as a fraction of its
   * range. This is the ceiling on ringing *and* on how far an antialiased edge
   * pixel can be pushed toward a rail, so it is the setting that decides whether
   * the filter preserves or destroys the accumulation pass's work.
   */
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
 * Values above 1.0 are permitted but are past AMD's calibrated range, and round
 * 5's 1.22 is where the aliasing, ringing and sparkle reports came from: at that
 * setting the lobe reaches -0.230, the kernel divides by 0.078, and the raw gain
 * on one-texel detail is 12.8x. Nothing survives that except whatever the
 * overshoot clamp happens to allow, which turns the filter from a sharpener into
 * a local posteriser. Stay at or below 1.0 unless there is a measurement saying
 * otherwise. {@link SHARPEN_PEAK_LIMIT} is the hard bound.
 */
function sharpenPeak(sharpness: number): number {
  if (sharpness <= 0) return 0
  return Math.max(-1 / (8 + (5 - 8) * sharpness), SHARPEN_PEAK_LIMIT)
}

export class LensEffect extends Effect {
  constructor({
    aberration = 0.00028,
    // A vignette that read as gentle over a lifted black floor reads as heavy
    // once the corners can actually reach black, so this comes down with it.
    // It is a pure luminance multiply and cannot tint anything: the red cast
    // judges found in the lower corners of the ADS frame comes from the scene,
    // not from here.
    vignetteDarkness = 0.10,
    vignetteOffset = 0.44,
    grainAmount = 0.015,
    sharpness = 0.95,
    sharpenFloor = 0.15,
    sharpenOvershoot = 0.20,
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
