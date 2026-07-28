import * as THREE from 'three'
import { BlendFunction, Effect } from 'postprocessing'
import { createGradeLut, FILMIC_GRADE, type GradeLut, type GradeSettings } from './ColorGrade'

export type ToneMapOperator = 'filmic' | 'agx' | 'aces' | 'neutral'

/**
 * Exposure, tone mapping and the colour grade, in one pass.
 *
 * Keeping them together matters: the LUT is authored in display space, so it
 * has to be applied immediately after the tone curve has mapped scene
 * radiance into [0,1] and before anything else touches the pixel. Splitting
 * this across effects means round-tripping the colour space twice.
 *
 * `filmic` is the default: the ACES curve, which has the range this scene
 * wants, driven from the brightest channel so hue survives it. Per-channel ACES
 * rolls each primary on its own, and on a sunset frame that measured as a sun
 * core at RGB 0.987/0.972/0.960 — neutral white in the middle of an amber sky.
 * AgX would also have fixed the hue but its log encoding spans 16.5 stops
 * against this scene's five, and it lands correspondingly flat; both are kept
 * behind `?tonemap=` for comparison.
 *
 * Output is display-referred and sRGB-encoded rather than linear. Everything
 * downstream — SMAA, temporal accumulation, grain, vignette — behaves better
 * in a perceptual space, and the last pass converts back exactly once.
 */
const TONE_MAP_FUNCTIONS = /* glsl */ `
vec3 agxContrast(const in vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 toneMapAgx(const in vec3 linearColor) {
  const mat3 agxInset = mat3(
    0.856627153315983, 0.137318972929847, 0.11189821299995,
    0.0951212405381588, 0.761241990602591, 0.0767994186031903,
    0.0482516061458583, 0.101439036467562, 0.811302368396859
  );
  const mat3 agxOutset = mat3(
    1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
    -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
    -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
  );
  const mat3 srgbToRec2020 = mat3(
    0.6274, 0.0691, 0.0164,
    0.3293, 0.9195, 0.0880,
    0.0433, 0.0113, 0.8956
  );
  const mat3 rec2020ToSrgb = mat3(
    1.6605, -0.1246, -0.0182,
    -0.5876, 1.1329, -0.1006,
    -0.0728, -0.0083, 1.1187
  );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;

  vec3 c = agxInset * (srgbToRec2020 * linearColor);
  c = clamp((log2(max(c, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  c = agxOutset * agxContrast(c);
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  return clamp(rec2020ToSrgb * c, 0.0, 1.0);
}

float acesCurve(const in float v) {
  float a = v * (v + 0.0245786) - 0.000090537;
  float b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFit(const in vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/**
 * How fast a bright colour bleaches toward white, as an exponent on the
 * tone-mapped peak. Higher holds hue for longer. At 3.5, scene radiance below
 * about 0.7 keeps essentially all of its chroma, a horizon sky at 1.3 lands on
 * sRGB 232,211,191 rather than paper white, and only a genuine emitter — the
 * sun disc, a muzzle flash core — bleaches to flat white the way it should.
 */
const float HIGHLIGHT_CROSSTALK = 3.5;

/**
 * The ACES curve applied to the brightest channel, with the colour rescaled
 * around it so hue and saturation ride through unchanged, then a deliberate
 * bleed to white on top.
 *
 * This is the "highlight hue path" an ACES variant needs. Per-channel ACES
 * shears saturated highlights because each primary crosses the shoulder at a
 * different scene value; driving one scalar curve from the peak cannot do that.
 * Film does eventually desaturate as it bleaches, which is what the crosstalk
 * term restores — smoothly and under one knob, rather than as a side effect of
 * where the shoulder happens to sit.
 *
 * On neutrals this is identical to {@link toneMapAces}: both ACES matrices are
 * row-normalised, so grey passes through them untouched and the exposure
 * calibration is shared between the two operators.
 */
vec3 toneMapFilmic(const in vec3 linearColor) {
  float peak = max(max(linearColor.r, linearColor.g), max(linearColor.b, 1e-5));
  vec3 ratio = linearColor / peak;
  float mapped = acesCurve(peak);
  ratio = mix(ratio, vec3(1.0), pow(clamp(mapped, 0.0, 1.0), HIGHLIGHT_CROSSTALK));
  return clamp(ratio * mapped, 0.0, 1.0);
}

// Stephen Hill's fit of the ACES RRT+ODT. Note there is no 1/0.6 pre-scale
// here: that is Unreal's convention for matching its own exposure, and baking
// it in silently brightened every mid-tone by a full stop while pretending the
// exposure knob was at 1.0. Exposure is exposure; the curve is the curve.
vec3 toneMapAces(const in vec3 linearColor) {
  const mat3 acesIn = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 acesOut = mat3(
    1.60475, -0.10208, -0.00327,
    -0.53108, 1.10813, -0.07276,
    -0.07367, -0.00605, 1.07602
  );
  return clamp(acesOut * acesFit(acesIn * linearColor), 0.0, 1.0);
}

vec3 toneMapNeutral(const in vec3 linearColor) {
  const float startCompression = 0.76;
  const float desaturation = 0.15;
  vec3 c = linearColor;
  float lo = min(c.r, min(c.g, c.b));
  float shift = lo < 0.08 ? lo - 6.25 * lo * lo : 0.04;
  c -= shift;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) return clamp(c, 0.0, 1.0);
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(c, vec3(newPeak), g), 0.0, 1.0);
}
`

const COLOR_SPACE_FUNCTIONS = /* glsl */ `
vec3 gradeEncode(const in vec3 c) {
  vec3 v = max(c, vec3(0.0));
  return mix(1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, v * 12.92, step(v, vec3(0.0031308)));
}
`

function buildFragmentShader(operator: ToneMapOperator): string {
  const call =
    operator === 'agx' ? 'toneMapAgx(scene)'
      : operator === 'neutral' ? 'toneMapNeutral(scene)'
        : operator === 'aces' ? 'toneMapAces(scene)'
          : 'toneMapFilmic(scene)'

  return /* glsl */ `
uniform mediump sampler3D lut;
uniform float exposure;
uniform float lutScale;
uniform float lutOffset;
uniform float lutStrength;

${TONE_MAP_FUNCTIONS}
${COLOR_SPACE_FUNCTIONS}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 scene = max(inputColor.rgb, vec3(0.0)) * exposure;
  vec3 display = gradeEncode(${call});
  vec3 graded = texture(lut, display * lutScale + lutOffset).rgb;
  outputColor = vec4(mix(display, graded, lutStrength), inputColor.a);
}
`
}

export interface GradeEffectOptions {
  operator?: ToneMapOperator
  exposure?: number
  /** 0 disables the LUT and leaves the raw tone curve. */
  lutStrength?: number
  lutSize?: number
  grade?: GradeSettings
}

export class GradeEffect extends Effect {
  private readonly lut: GradeLut

  constructor({
    operator = 'filmic',
    exposure = 1,
    lutStrength = 1,
    lutSize = 41,
    grade = FILMIC_GRADE,
  }: GradeEffectOptions = {}) {
    const lut = createGradeLut(lutSize, grade)
    const uniforms = new Map<string, THREE.Uniform>([
      ['lut', new THREE.Uniform(lut.texture)],
      ['exposure', new THREE.Uniform(exposure)],
      ['lutScale', new THREE.Uniform(lut.scale)],
      ['lutOffset', new THREE.Uniform(lut.offset)],
      ['lutStrength', new THREE.Uniform(lutStrength)],
    ])

    super('GradeEffect', buildFragmentShader(operator), {
      blendFunction: BlendFunction.SRC,
      uniforms,
    })

    this.lut = lut
  }

  get exposure(): number {
    return this.uniforms.get('exposure')!.value as number
  }

  set exposure(value: number) {
    this.uniforms.get('exposure')!.value = value
  }

  get lutStrength(): number {
    return this.uniforms.get('lutStrength')!.value as number
  }

  set lutStrength(value: number) {
    this.uniforms.get('lutStrength')!.value = value
  }

  dispose(): void {
    this.lut.texture.dispose()
    super.dispose()
  }
}
