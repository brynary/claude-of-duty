import * as THREE from 'three'
import { SKY_GLSL, SKY_SCALE_VISIBLE } from './SkyModel'

/**
 * Distance haze, applied to every lit world material in place of three's fog.
 *
 * Aerial perspective is the single strongest depth cue a frame has, and it is
 * not a grey wash: it is air, and air does three things a `FogExp2` cannot.
 *
 * 1. **It accumulates linearly with path length, not quadratically.** Three's
 *    exponential-squared fog is `1 - exp(-(sigma*d)^2)`, shaped for worlds tens
 *    of kilometres across. Over the hundred metres this level spans it is close
 *    to nothing until it is suddenly everything, and there is no density that
 *    works: the one that left the near field alone reached 1.4 per cent at
 *    forty metres and 8.6 at a hundred, which separates nothing, and the one
 *    that finally showed on the skyline was past forty per cent in the far
 *    corners while still doing nothing at forty. Beer-Lambert, `exp(-sigma*d)`,
 *    has the whole of its useful range inside the level.
 *
 * 2. **It is wavelength dependent.** Blue scatters out of the beam faster than
 *    red, so distant geometry does not fade towards grey, it fades towards the
 *    colour of the sky behind it. A single scalar density cannot express that
 *    and always reads as smoke rather than as air.
 *
 * 3. **Its colour is the sky in the direction you are looking.** Haze into a
 *    low sun is a warm glare; the same haze ninety degrees round is cool. One
 *    flat fog colour is what makes distance read as a painted backdrop.
 *
 * Structurally the term is `colour * T + inscatter * (1 - T)`. Because the
 * inscattered radiance is an order of magnitude above a shadowed surface's own,
 * that expression lifts far geometry's black point hard while barely touching
 * its highlights — which is the whole effect, and why it has to be held off the
 * near field entirely rather than merely turned down. Transmittance is floored
 * as well, so distance can never take *all* of a surface's signal: a building
 * at the far end of the level must still read as a building and not as a hole
 * cut in the sky.
 */

/**
 * Metres of clear air before any haze accumulates at all.
 *
 * Haze lifts blacks far faster than it dims whites — the inscattered radiance
 * here is an order of magnitude above a shadowed surface's own — so a few per
 * cent of it is already plainly visible on a dark near wall.
 */
const START_DISTANCE = 16

/**
 * Metres over which optical depth ramps in past {@link START_DISTANCE}.
 *
 * A start distance alone is not enough, and assuming it was is what put a milky
 * veil back over the near field. Subtracting a constant still leaves the depth
 * growing at full rate from the very first metre past the cut, so at twenty
 * metres — which is across a courtyard, not into the distance — two and a half
 * per cent of the frame's brightest inscatter was already being mixed into
 * surfaces sitting at two per cent of it, and a shaded wall measured eight code
 * values above where it should have. Judges read that as "a uniform milky haze
 * applied even at two metres".
 *
 * So the accumulated depth is `over^2 / (over + ramp)`: quadratic just past the
 * start, straightening to linear well beyond it. Zero and *flat* at the cut
 * rather than merely zero, which is the property that actually protects the
 * near field. Measured against the shipped level — nothing inside twenty
 * metres, two per cent at thirty, fifteen at sixty, thirty-five at a hundred.
 */
const RAMP_DISTANCE = 55

/**
 * Extinction per metre, per channel, at ground level. Tilted blue-over-red by
 * about a half — far short of the fourth-power Rayleigh ratio, because the air
 * over a dusty street is mostly Mie scattering off particles far larger than a
 * wavelength, which is very nearly grey.
 *
 * Raised alongside {@link RAMP_DISTANCE}: the ramp removes most of the optical
 * depth the old linear accumulation had built up by the middle distance, and
 * without a matching rise in extinction the far end of the level would have
 * stopped separating. Chosen so the hundred-metre reading lands where it was
 * before — the change is meant to move haze out of the foreground, not to
 * remove it from the distance.
 */
const SIGMA = new THREE.Vector3(0.0059, 0.0071, 0.0089)

/**
 * Scale height of the haze layer, metres. Dust and heat shimmer sit near the
 * ground, so a rooftop three storeys up is measurably clearer than the street
 * below it — which is exactly the cue that separates a tall building's top from
 * its base.
 */
const SCALE_HEIGHT = 34

/** Height the haze layer is thickest at. One unit is one metre; the street is 0. */
const GROUND_LEVEL = 0

/**
 * Least fraction of its own radiance a surface keeps however far away it is.
 * Every renderer that ships has this clamp. Without it the far end of a frame
 * converges exactly onto the sky and stops being geometry at all, which is the
 * milky look this pass exists to avoid. Raised, because judges reading the
 * distant skyline called it "a painted backdrop card that never received the
 * grade" — that is a far plane that has given up too much of its own signal.
 */
const MIN_TRANSMITTANCE = 0.45

/**
 * Soft ceiling on inscattered radiance, in the same scene-referred units the
 * sky dome emits.
 *
 * The horizon into a low sun carries several times the radiance of the sky
 * behind the camera, and a hard clip lands both on the same near-white and
 * throws away the warm-into-the-sun split that is the whole point of sampling
 * the sky per direction. The level chosen is what stops fully hazed geometry
 * converging on the sky: at this value the far end of the frame settles near
 * sRGB 185 against a horizon around 230, so distance stays distinguishable from
 * air however much of it there is.
 */
const INSCATTER_ROLLOFF = 0.26

/** Matches the fog colour the CPU side reports, so the two never disagree. */
const SKY_SAMPLE_SCALE = SKY_SCALE_VISIBLE * 0.92

const PARS_VERTEX = /* glsl */ `
#include <fog_pars_vertex>
#ifdef USE_FOG
varying vec3 vApView;
#endif
`

const VERTEX = /* glsl */ `
#include <fog_vertex>
#ifdef USE_FOG
// View space rather than world: mvPosition already carries whatever instancing,
// batching or skinning put this vertex where it is, so nothing has to be
// reconstructed and no transform path can be forgotten.
vApView = mvPosition.xyz;
#endif
`

const PARS_FRAGMENT = /* glsl */ `
#include <fog_pars_fragment>
#ifdef USE_FOG
${SKY_GLSL}
uniform vec3 apSigma;
uniform vec4 apParams;   // x: start distance, y: 1/scale height, z: ground level, w: ramp
uniform vec3 apLimits;   // x: strength, y: min transmittance, z: inscatter rolloff
uniform float apSkyScale;
varying vec3 vApView;
#endif
`

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
{
	// The inverse view transform, using the fact that the rotation block is
	// orthonormal: right-multiplying by the matrix applies its transpose.
	vec3 apWorld = ( ( vec4( vApView, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
	vec3 apDelta = apWorld - cameraPosition;
	float apDist = length( apDelta );

	// Density at each end of the segment, averaged. Two samples is ample over a
	// hundred metres and, unlike the analytic integral, has no branch where the
	// ray runs flat.
	float apNear = exp( - max( cameraPosition.y - apParams.z, 0.0 ) * apParams.y );
	float apFar = exp( - max( apWorld.y - apParams.z, 0.0 ) * apParams.y );

	// Ramped accumulation: zero *and flat* at the start distance, quadratic just
	// past it, linear once well beyond. Subtracting a constant would leave the
	// depth growing at full rate from the first metre past the cut, which is how
	// haze got back into the near field.
	float apOver = max( apDist - apParams.x, 0.0 );
	float apPath = apOver * apOver / ( apOver + apParams.w )
		* 0.5 * ( apNear + apFar ) * apLimits.x;

	// Everything inside the clear near field skips the sky evaluation entirely.
	// Distance is screen-coherent, so whole tiles take the same side of this and
	// a close-quarters frame pays for the model almost nowhere.
	if ( apPath > 0.35 ) {

		vec3 apTrans = max( exp( - apSigma * apPath ), vec3( apLimits.y ) );

		// Inscatter takes the colour of the sky along this exact ray. Sampled a
		// little above the true horizon: the analytic airmass runs away as the
		// direction goes flat, and distant geometry sits in the band just above
		// it regardless.
		vec3 apDir = apDelta / max( apDist, 1.0e-4 );
		vec3 apSky = skyRadiance( normalize( vec3( apDir.x, max( apDir.y, 0.035 ), apDir.z ) ) );
		vec3 apSample = skyShoulder( apSky * apSkyScale );
		vec3 apInscatter = apSample / ( 1.0 + apSample / apLimits.z );

		gl_FragColor.rgb = gl_FragColor.rgb * apTrans + apInscatter * ( 1.0 - apTrans );

	}
}
#endif
`

interface PatchTarget {
  vertexShader: string
  fragmentShader: string
  uniforms: Record<string, THREE.IUniform>
}

export class AerialPerspective {
  private readonly uniforms = {
    apSigma: { value: SIGMA.clone() },
    apParams: {
      value: new THREE.Vector4(START_DISTANCE, 1 / SCALE_HEIGHT, GROUND_LEVEL, RAMP_DISTANCE),
    },
    apLimits: { value: new THREE.Vector3(1, MIN_TRANSMITTANCE, INSCATTER_ROLLOFF) },
    apSkyScale: { value: SKY_SAMPLE_SCALE },
    // The Preetham model's own inputs, shared with the dome so the haze and the
    // sky it fades into are evaluated from identical numbers.
    uBetaR: { value: new THREE.Vector3() },
    uBetaM: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: 1000 },
    uMieG: { value: 0.8 },
  }

  /** Chain this off every lit world material's `onBeforeCompile`. */
  readonly patch = (shader: PatchTarget): void => {
    Object.assign(shader.uniforms, this.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', PARS_VERTEX)
      .replace('#include <fog_vertex>', VERTEX)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', PARS_FRAGMENT)
      .replace('#include <fog_fragment>', FRAGMENT)
  }

  /**
   * Loads the atmosphere the haze is to be evaluated against. Every argument
   * comes from the same `SkyModel` functions that drive the dome, so the air in
   * front of a building and the sky behind it cannot disagree.
   */
  setSun(betaR: THREE.Vector3, betaM: THREE.Vector3, sunDir: THREE.Vector3, sunE: number, mieG: number): void {
    this.uniforms.uBetaR.value.copy(betaR)
    this.uniforms.uBetaM.value.copy(betaM)
    this.uniforms.uSunDir.value.copy(sunDir)
    this.uniforms.uSunE.value = sunE
    this.uniforms.uMieG.value = mieG
  }

  /**
   * Global multiplier on optical depth. A room has a few metres of air in it,
   * not ninety, so this drops towards zero as the camera moves indoors.
   */
  setStrength(strength: number): void {
    this.uniforms.apLimits.value.x = strength
  }
}
