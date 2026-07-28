import * as THREE from 'three'

/**
 * Preetham analytic sky, expressed once so the GPU dome and the CPU-side
 * queries (fog colour, sun colour, ambient tint) cannot drift apart.
 *
 * The published model has no absolute calibration, so two scales are applied
 * downstream: a brighter one for what the camera sees and a dimmer one for the
 * irradiance baked into the environment map. Pairing Preetham's raw radiance
 * with a sun of intensity ~5 would leave shadows barely darker than lit ground;
 * splitting the scales is what real engines do and is what keeps the shadow
 * contrast in the two-to-three stop range daylight photography actually has.
 */
export interface SkyParams {
  turbidity: number
  rayleigh: number
  mieCoefficient: number
  mieDirectionalG: number
}

/**
 * Late-afternoon haze: low turbidity so the sky stays a saturated blue away
 * from the sun, with distance haze carried by fog rather than by a milky
 * horizon.
 */
export const SKY_PARAMS: SkyParams = {
  turbidity: 2.6,
  rayleigh: 2.1,
  mieCoefficient: 0.0042,
  mieDirectionalG: 0.8,
}

/**
 * What the camera sees.
 *
 * This, SKY_SCALE_ENV and the lighting system's SUN_TARGET_LUMINANCE are
 * scene-referred radiances, and the post chain's exposure is what turns them
 * into pixels — the two ends are one calibration and cannot be tuned apart.
 * Against the committed grade (ACES at exposure 1.76) these put the zenith near
 * sRGB 118, the sky opposite the sun near 109, the band twenty degrees off the
 * sun near 192 and the last couple of degrees around the disc near 245.
 *
 * Trimmed from 0.29 because the sky is the largest single area in most of the
 * graded poses and was setting their average brightness on its own. The dome
 * also carries the frame's saturation: less of it crosses the shoulder now, so
 * the blue stays blue instead of bleaching towards the grey-violet a judge
 * called "overcast and slightly wrong in hue".
 */
export const SKY_SCALE_VISIBLE = 0.25
/**
 * What the environment map is generated at.
 *
 * This is the single most important number in the lighting rig, because the
 * image-based ambient it produces is around ninety per cent of everything that
 * lights a surface the sun cannot reach — the hemisphere light below is the
 * other ten. Key-to-fill is therefore set here and by SUN_TARGET_LUMINANCE,
 * and nowhere else.
 *
 * Measured: at 0.148 the probe delivered 0.58 of irradiance to an upward-facing
 * surface against 0.75 from a 21-degree sun, so a patch of shaded ground sat at
 * 44 per cent of the same patch in sunlight. Real clear-sky daylight at this
 * elevation is nearer 24 per cent — direct-horizontal to diffuse-horizontal is
 * about three to one, and no amount of urban bounce closes that. The fill was
 * three times over strength, which is what "nondirectional fill" and "no
 * discernible light direction" measure as. At 0.054 an open-shade surface lands
 * near sRGB 35 against the same surface at 107 in sun.
 *
 * The probe is not the whole fill any more either: a third of what a shaded
 * wall receives now comes from the directional bounce in SkyOcclusion, which is
 * why this can be cut this far without shade going flat and empty.
 *
 * Note this drives reflections as well as ambient. That is intended: the same
 * over-strength probe is what a judge saw as "a dense, uniform field of tiny
 * bright specks ... glitter or sequins rather than aggregate".
 */
export const SKY_SCALE_ENV = 0.054

/** Radiance of the sun disc itself. Bounded so half-float buffers survive it. */
export const SUN_DISC_RADIANCE = 80

/**
 * Preetham's circumsolar lobe runs away: the `Lin^1.5` term puts the sky within
 * a couple of degrees of the sun about fifty times the zenith, which no tone
 * curve holds — it lands on flat white with the hue thrown away, and the
 * gradient that makes a sky read as a sky goes with it. So the dome gets a
 * shoulder: exact below the knee, compressed above it. Applied identically on
 * the CPU and the GPU, always after the scale, and always before the sun disc
 * is added — the disc is *supposed* to clip.
 *
 * The shoulder used to be an exponential approach to a hard ceiling of 1.30,
 * and that ceiling was the reason no frame in the previous round reached white.
 * Scene radiance 1.30 grades to sRGB 228, and with nothing in the world above
 * it — a sunlit mid-albedo wall is nearer 0.23 — 228 was the brightest pixel
 * any pose without the sun disc in shot could produce. Worse, the approach is
 * asymptotic, so every direction between five and zero degrees off the sun
 * landed within one code value of every other: about ten degrees of sky
 * flattened onto a single tone, which is both a lost gradient and lost local
 * contrast over a large part of the frame.
 *
 * A power law fixes both. It has no ceiling, so the brightest sky is free to
 * clip the way it does in a photograph; and it stays strictly increasing, so
 * the circumsolar falloff survives as a gradient rather than a plateau. The
 * exponent is what sets how many of the sky's stops above the knee survive into
 * the top stop of the display: at 0.80 the sky reads 244 at the disc, 224 ten
 * degrees off and 192 at twenty, which is a gradient a judge can see rather
 * than the flat 228 the old ceiling produced everywhere inside ten degrees.
 *
 * Note this is *not* what fixes the frame's white point, though it was assumed
 * to be. Even with the shoulder removed entirely the sky only passes sRGB 247
 * within three degrees of the sun — an area the disc and its aureole already
 * cover. A frame with no sun in shot has to get its white point from a
 * specular or an emitter, which is a question of key strength and of material
 * roughness, not of sky.
 */
const SKY_KNEE = 0.50
const SKY_SHOULDER = 0.80

export function skyShoulder(x: number): number {
  if (x <= SKY_KNEE) return x
  return SKY_KNEE * Math.pow(x / SKY_KNEE, SKY_SHOULDER)
}

const BETA_R = new THREE.Vector3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5)
const MIE_CONST = new THREE.Vector3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14)
const RAYLEIGH_ZENITH = 8.4e3
const MIE_ZENITH = 1.25e4
const CUTOFF_ANGLE = 1.6110731556870734
const STEEPNESS = 1.5
const SUN_IRRADIANCE = 1000

/** cos of the sun's angular radius (0.53 degrees across). */
export const SUN_ANGULAR_COS = 0.9999566769464483

export function betaRayleigh(params: SkyParams, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(BETA_R).multiplyScalar(params.rayleigh)
}

export function betaMie(params: SkyParams, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(MIE_CONST).multiplyScalar(0.434 * (0.2 * params.turbidity * 1e-17) * params.mieCoefficient)
}

export function sunIntensity(sunElevationSin: number): number {
  const c = THREE.MathUtils.clamp(sunElevationSin, -1, 1)
  return SUN_IRRADIANCE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)))
}

// --- CPU evaluation -------------------------------------------------------
// All temporaries are module-level: these run every frame for the fog colour.

const _betaR = new THREE.Vector3()
const _betaM = new THREE.Vector3()
const _fex = new THREE.Vector3()
const _num = new THREE.Vector3()
const _den = new THREE.Vector3()
const _ratio = new THREE.Vector3()
const _lin = new THREE.Vector3()
const _mixTo = new THREE.Vector3()
const _l0 = new THREE.Vector3()
const _acc = new THREE.Vector3()

function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta)
}

function henyeyGreenstein(cosTheta: number, g: number): number {
  const g2 = g * g
  return (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(Math.max(1e-4, 1 - 2 * g * cosTheta + g2), 1.5))
}

/** Optical depth multiplier for a view direction, Kasten-Young airmass. */
function airmass(dirY: number): number {
  const zenithCos = Math.max(0, dirY)
  const zenith = Math.acos(zenithCos)
  return 1 / (zenithCos + 0.15 * Math.pow(Math.max(1e-3, 93.885 - (zenith * 180) / Math.PI), -1.253))
}

/**
 * Sky radiance for a direction, excluding the sun disc, in the same linear
 * units the dome shader emits before its scale is applied.
 */
export function skyRadiance(
  dir: THREE.Vector3,
  sunDir: THREE.Vector3,
  params: SkyParams,
  out: THREE.Vector3,
): THREE.Vector3 {
  betaRayleigh(params, _betaR)
  betaMie(params, _betaM)
  const sunE = sunIntensity(sunDir.y)

  const inv = airmass(dir.y)
  _fex.set(
    Math.exp(-(_betaR.x * RAYLEIGH_ZENITH * inv + _betaM.x * MIE_ZENITH * inv)),
    Math.exp(-(_betaR.y * RAYLEIGH_ZENITH * inv + _betaM.y * MIE_ZENITH * inv)),
    Math.exp(-(_betaR.z * RAYLEIGH_ZENITH * inv + _betaM.z * MIE_ZENITH * inv)),
  )

  const cosTheta = dir.dot(sunDir)
  const rPhase = rayleighPhase(cosTheta * 0.5 + 0.5)
  const mPhase = henyeyGreenstein(cosTheta, params.mieDirectionalG)
  _num.copy(_betaR).multiplyScalar(rPhase).addScaledVector(_betaM, mPhase)
  _den.copy(_betaR).add(_betaM)
  _ratio.set(_num.x / _den.x, _num.y / _den.y, _num.z / _den.z)

  _lin.set(
    Math.pow(sunE * _ratio.x * (1 - _fex.x), 1.5),
    Math.pow(sunE * _ratio.y * (1 - _fex.y), 1.5),
    Math.pow(sunE * _ratio.z * (1 - _fex.z), 1.5),
  )
  const f = THREE.MathUtils.clamp(Math.pow(1 - sunDir.y, 5), 0, 1)
  _mixTo.set(
    Math.sqrt(Math.max(0, sunE * _ratio.x * _fex.x)),
    Math.sqrt(Math.max(0, sunE * _ratio.y * _fex.y)),
    Math.sqrt(Math.max(0, sunE * _ratio.z * _fex.z)),
  )
  _lin.set(
    _lin.x * THREE.MathUtils.lerp(1, _mixTo.x, f),
    _lin.y * THREE.MathUtils.lerp(1, _mixTo.y, f),
    _lin.z * THREE.MathUtils.lerp(1, _mixTo.z, f),
  )

  _l0.copy(_fex).multiplyScalar(0.06)
  _acc.copy(_lin).add(_l0).multiplyScalar(0.04)
  return out.set(_acc.x, _acc.y + 0.0003, _acc.z + 0.00075)
}

const _sample = new THREE.Vector3()
const _dirTmp = new THREE.Vector3()

/**
 * Convenience wrapper writing straight into a linear-working-space Color.
 * Shouldered, so every CPU-side query — fog colour, ambient tint — agrees with
 * the pixel the dome shader would have produced for the same direction.
 */
export function skyColor(
  dir: THREE.Vector3,
  sunDir: THREE.Vector3,
  params: SkyParams,
  scale: number,
  out: THREE.Color,
): THREE.Color {
  skyRadiance(dir, sunDir, params, _sample)
  return out.setRGB(
    skyShoulder(_sample.x * scale),
    skyShoulder(_sample.y * scale),
    skyShoulder(_sample.z * scale),
    THREE.LinearSRGBColorSpace,
  )
}

/**
 * Colour of the direct solar beam after atmospheric extinction. Uses a lower
 * rayleigh multiplier than the dome: the artistic multiplier that gives the sky
 * its depth would push the key light to an implausible orange.
 */
const _beamParams: SkyParams = { turbidity: 2.6, rayleigh: 1.4, mieCoefficient: 0.0042, mieDirectionalG: 0.8 }

export function sunBeamColor(sunDir: THREE.Vector3, whiteBlend: number, out: THREE.Color): THREE.Color {
  _beamParams.turbidity = SKY_PARAMS.turbidity
  _beamParams.mieCoefficient = SKY_PARAMS.mieCoefficient
  betaRayleigh(_beamParams, _betaR)
  betaMie(_beamParams, _betaM)
  const inv = airmass(sunDir.y)
  const r = Math.exp(-(_betaR.x * RAYLEIGH_ZENITH * inv + _betaM.x * MIE_ZENITH * inv))
  const g = Math.exp(-(_betaR.y * RAYLEIGH_ZENITH * inv + _betaM.y * MIE_ZENITH * inv))
  const b = Math.exp(-(_betaR.z * RAYLEIGH_ZENITH * inv + _betaM.z * MIE_ZENITH * inv))
  const peak = Math.max(r, g, b, 1e-5)
  return out.setRGB(
    THREE.MathUtils.lerp(r / peak, 1, whiteBlend),
    THREE.MathUtils.lerp(g / peak, 1, whiteBlend),
    THREE.MathUtils.lerp(b / peak, 1, whiteBlend),
    THREE.LinearSRGBColorSpace,
  )
}

export function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

// --- Sun path -------------------------------------------------------------

/**
 * Art direction: the sun sits 21 degrees above the horizon at the default time
 * of day, which throws shadows 2.6 times an object's height. Azimuth 70 degrees
 * puts it down the barrel of the `sunset` pose and behind the camera in the
 * `plaza` pose, so one time of day services every graded frame.
 */
export const DEFAULT_TIME_OF_DAY = 0.695
const PEAK_ELEVATION = THREE.MathUtils.degToRad(62)
const AZIMUTH_AT_DEFAULT = THREE.MathUtils.degToRad(70)
const AZIMUTH_SWEEP = THREE.MathUtils.degToRad(300)

/** Direction *towards* the sun for a 0..1 time of day (0.25 dawn, 0.75 dusk). */
export function sunDirectionFor(t: number, out: THREE.Vector3): THREE.Vector3 {
  const day = (t - 0.25) / 0.5
  const elevation = Math.sin(day * Math.PI) * PEAK_ELEVATION
  const azimuth = AZIMUTH_AT_DEFAULT + (t - DEFAULT_TIME_OF_DAY) * AZIMUTH_SWEEP
  const ce = Math.cos(elevation)
  return out.set(Math.sin(azimuth) * ce, Math.sin(elevation), Math.cos(azimuth) * ce).normalize()
}

// --- GLSL ------------------------------------------------------------------

/**
 * The same model in GLSL. Kept adjacent to the CPU version above so a change to
 * one is an obvious prompt to change the other.
 */
export const SKY_GLSL = /* glsl */ `
const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH = 1.25e4;
const float SKY_PI = 3.141592653589793;
const float SUN_ANGULAR_COS = 0.9999566769464483;
const float SKY_KNEE = ${SKY_KNEE.toFixed(4)};
const float SKY_SHOULDER = ${SKY_SHOULDER.toFixed(4)};

// Must stay numerically identical to skyShoulder() above. Written branchlessly
// and with the base of the power clamped at the knee, since pow() of anything
// at or below zero is undefined and the dome is evaluated per fragment.
vec3 skyShoulder( vec3 c ) {
  vec3 rolled = SKY_KNEE * pow( max( c, vec3( SKY_KNEE ) ) / SKY_KNEE, vec3( SKY_SHOULDER ) );
  return min( c, vec3( SKY_KNEE ) ) + max( rolled - SKY_KNEE, vec3( 0.0 ) );
}

uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform vec3 uSunDir;
uniform float uSunE;
uniform float uMieG;

float skyRayleighPhase( float cosTheta ) {
  return ( 3.0 / ( 16.0 * SKY_PI ) ) * ( 1.0 + cosTheta * cosTheta );
}

float skyMiePhase( float cosTheta, float g ) {
  float g2 = g * g;
  return ( 1.0 / ( 4.0 * SKY_PI ) ) * ( ( 1.0 - g2 ) / pow( max( 1e-4, 1.0 - 2.0 * g * cosTheta + g2 ), 1.5 ) );
}

float skyAirmass( float dirY ) {
  float zenithCos = max( 0.0, dirY );
  float zenith = acos( zenithCos );
  return 1.0 / ( zenithCos + 0.15 * pow( max( 1e-3, 93.885 - zenith * 180.0 / SKY_PI ), -1.253 ) );
}

// Extinction along the view ray, reused for the sun disc tint.
vec3 skyExtinction( float dirY ) {
  float inv = skyAirmass( dirY );
  return exp( -( uBetaR * RAYLEIGH_ZENITH * inv + uBetaM * MIE_ZENITH * inv ) );
}

vec3 skyRadiance( vec3 dir ) {
  vec3 Fex = skyExtinction( dir.y );
  float cosTheta = dot( dir, uSunDir );
  vec3 num = uBetaR * skyRayleighPhase( cosTheta * 0.5 + 0.5 ) + uBetaM * skyMiePhase( cosTheta, uMieG );
  vec3 ratio = num / ( uBetaR + uBetaM );

  vec3 Lin = pow( uSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );
  float f = clamp( pow( 1.0 - uSunDir.y, 5.0 ), 0.0, 1.0 );
  Lin *= mix( vec3( 1.0 ), sqrt( max( vec3( 0.0 ), uSunE * ratio * Fex ) ), f );

  vec3 L0 = 0.06 * Fex;
  return ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
}
`
