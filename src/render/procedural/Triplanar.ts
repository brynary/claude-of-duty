import * as THREE from 'three'

/**
 * World-space triplanar projection for architectural materials.
 *
 * Four problems this solves at once:
 *
 * 1. **Texel density is correct by construction.** The projection is driven by
 *    world position in metres, so a wall is textured at the same scale whether
 *    the level built it from a 12 m box or a 2 m one, and whatever its UVs say.
 *    Stretched textures on stretched boxes are the classic engine-demo tell.
 * 2. **Tiling repetition is broken up.** A world-space value-noise field
 *    modulates albedo and roughness at a much larger scale than the texture
 *    tile, so the eye never locks onto the repeat.
 * 3. **Apparent texel density is multiplied.** A second, rotated, non-integer
 *    octave of the normal map is added on top of the base projection. It costs
 *    three texture fetches and buys detail an order of magnitude finer than the
 *    baked tile, and it self-limits: once the detail octave mips out to flat it
 *    contributes nothing, so it never aliases in the distance.
 * 4. **Surfaces accumulate history.** Dust settles on upward faces, grime
 *    collects in every baked cavity, and splash-back darkens the bottom of
 *    every vertical surface where it meets the ground. All three are driven
 *    from data the projection already has — the world normal, the baked
 *    occlusion channel and the world height — so nothing has to be authored
 *    per surface.
 *
 * The normal maps are combined with the standard "whiteout" triplanar blend and
 * the result is handed to the shader in view space, which is where three.js
 * expects `normal` to live by the time lighting runs.
 */
export interface TriplanarOptions {
  /** Texture tiles per metre. 0.5 = one tile every two metres. */
  scale: number
  /** Blend exponent between the three planes. Higher = crisper on box faces. */
  sharpness?: number
  /** World offset so different materials do not share a projection origin. */
  offset?: THREE.Vector3
  /** Cycles per metre of the large-scale variation field. */
  macroScale?: number
  /** Albedo swing of the macro field, +/- fraction. */
  macroAlbedo?: number
  /** Roughness swing of the macro field, +/- fraction. */
  macroRough?: number
  /** Linear RGB of settled dust. */
  dustColor?: THREE.Color
  /** How strongly dust covers upward faces, 0..1. */
  dustAmount?: number
  /** Roughness that dust drags the surface towards. */
  dustRough?: number
  /** Frequency multiplier of the detail normal octave. */
  detailScale?: number
  /** Strength of the detail normal octave. 0 disables the extra fetches' effect. */
  detailNormal?: number
  /** Linear RGB of grime — used in cavities and at the foot of walls. */
  grimeColor?: THREE.Color
  /** How strongly baked cavities fill with grime, 0..1. */
  cavityDirt?: number
  /** Splash-back strength at the bottom of vertical faces, 0..1. */
  grimeAmount?: number
  /** Metres over which splash-back fades out going up. */
  grimeHeight?: number
  /** World Y that splash-back is measured from. */
  grimeBase?: number
}

const FRAGMENT_HELPERS = /* glsl */ `
varying vec3 vTriWorldPos;
varying vec3 vTriWorldNormal;
uniform float uTriScale;
uniform float uTriSharp;
uniform vec3 uTriOffset;
uniform float uMacroScale;
uniform float uMacroAlbedo;
uniform float uMacroRough;
uniform vec3 uDustColor;
uniform float uDustAmount;
uniform float uDustRough;
uniform float uDetailScale;
uniform float uDetailNormal;
uniform vec3 uGrimeColor;
uniform float uCavityDirt;
uniform float uGrimeAmount;
uniform float uGrimeHeight;
uniform float uGrimeBase;

float triHash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}

float triValueNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float n000 = triHash13( i );
	float n100 = triHash13( i + vec3( 1.0, 0.0, 0.0 ) );
	float n010 = triHash13( i + vec3( 0.0, 1.0, 0.0 ) );
	float n110 = triHash13( i + vec3( 1.0, 1.0, 0.0 ) );
	float n001 = triHash13( i + vec3( 0.0, 0.0, 1.0 ) );
	float n101 = triHash13( i + vec3( 1.0, 0.0, 1.0 ) );
	float n011 = triHash13( i + vec3( 0.0, 1.0, 1.0 ) );
	float n111 = triHash13( i + vec3( 1.0, 1.0, 1.0 ) );
	float x00 = mix( n000, n100, f.x );
	float x10 = mix( n010, n110, f.x );
	float x01 = mix( n001, n101, f.x );
	float x11 = mix( n011, n111, f.x );
	return mix( mix( x00, x10, f.y ), mix( x01, x11, f.y ), f.z );
}

// 45 degrees. The detail octave is rotated so that on structural materials —
// brick courses, ashlar, plank runs — its miniature copy of the pattern crosses
// the real one instead of ghosting a scaled duplicate on top of it.
vec2 triRot45( vec2 v ) {
	return vec2( v.x - v.y, v.x + v.y ) * 0.70710678;
}
`

const MAP_FRAGMENT = /* glsl */ `
	vec3 triWorld = vTriWorldPos + uTriOffset;
	vec3 triN = normalize( vTriWorldNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
	vec3 triBlend = pow( abs( triN ), vec3( uTriSharp ) );
	triBlend /= max( triBlend.x + triBlend.y + triBlend.z, 0.0001 );
	vec3 triP = triWorld * uTriScale;
	vec2 triUvX = triP.zy;
	vec2 triUvY = triP.xz;
	vec2 triUvZ = triP.xy;
	vec3 triD = triP * uDetailScale;
	vec2 triDvX = triRot45( triD.zy ) + 0.317;
	vec2 triDvY = triRot45( triD.xz ) + 0.613;
	vec2 triDvZ = triRot45( triD.xy ) + 0.829;

	vec4 triAlbedo = texture2D( map, triUvX ) * triBlend.x
		+ texture2D( map, triUvY ) * triBlend.y
		+ texture2D( map, triUvZ ) * triBlend.z;
	vec4 triOrm = texture2D( roughnessMap, triUvX ) * triBlend.x
		+ texture2D( roughnessMap, triUvY ) * triBlend.y
		+ texture2D( roughnessMap, triUvZ ) * triBlend.z;

	float triMacro = triValueNoise( triWorld * uMacroScale ) * 0.62
		+ triValueNoise( triWorld * uMacroScale * 2.7 + 19.3 ) * 0.38;

	// Value *and* temperature drift. Weathering shifts hue as well as
	// brightness, and a slight warm/cool split is what stops a large wall
	// reading as one flat sample of paint.
	triAlbedo.rgb *= mix(
		( 1.0 - uMacroAlbedo ) * vec3( 0.97, 1.0, 1.05 ),
		( 1.0 + uMacroAlbedo ) * vec3( 1.05, 1.0, 0.94 ),
		triMacro );

	// Grime in every cavity. The baked occlusion channel already knows where
	// the surface dips below its neighbourhood, so squaring it gives a tight
	// crease mask for free. Unlike an AO term this darkens albedo, so it still
	// reads under full sun where ambient occlusion contributes nothing.
	float triCav = 1.0 - triOrm.r;
	float triCavity = clamp( triCav * triCav * uCavityDirt * ( 0.5 + 1.0 * triMacro ), 0.0, 0.85 );
	triAlbedo.rgb = mix( triAlbedo.rgb, uGrimeColor * ( 0.55 + 0.8 * triMacro ), triCavity );

	// Splash-back: rain throws dirt up the bottom half-metre of everything
	// vertical. Only ever on side faces, and the band edge wanders with a
	// world-space noise so it never reads as a painted stripe.
	float triSide = 1.0 - abs( triN.y );
	float triEdge = 0.42 + 0.72 * triValueNoise( vec3( vTriWorldPos.xz * 1.35, 0.0 ) );
	float triFoot = 1.0 - smoothstep( 0.0, max( 0.02, uGrimeHeight * triEdge ),
		max( vTriWorldPos.y - uGrimeBase, 0.0 ) );
	float triBaseGrime = clamp( uGrimeAmount * triSide * triFoot * triFoot * ( 0.55 + 0.8 * triMacro ), 0.0, 0.8 );
	triAlbedo.rgb = mix( triAlbedo.rgb, uGrimeColor * ( 0.45 + 0.6 * triMacro ), triBaseGrime );

	float triUp = clamp( triN.y, 0.0, 1.0 );
	float triDust = clamp(
		uDustAmount * pow( triUp, 1.6 ) * ( 0.45 + 0.75 * ( 1.0 - triOrm.r ) ) * ( 0.3 + 1.1 * triMacro ),
		0.0, 0.9 );
	triAlbedo.rgb = mix( triAlbedo.rgb, uDustColor * ( 0.7 + 0.6 * triMacro ), triDust );

	float triFilth = max( triCavity * 0.75, triBaseGrime );

	diffuseColor *= triAlbedo;
`

const ROUGHNESS_FRAGMENT = /* glsl */ `
	float roughnessFactor = roughness * triOrm.g;
	roughnessFactor *= mix( 1.0 - uMacroRough, 1.0 + uMacroRough, triMacro );
	roughnessFactor = mix( roughnessFactor, 0.95, triFilth );
	roughnessFactor = mix( roughnessFactor, uDustRough, triDust );
	roughnessFactor = clamp( roughnessFactor, 0.04, 1.0 );
`

const METALNESS_FRAGMENT = /* glsl */ `
	float metalnessFactor = metalness * triOrm.b * ( 1.0 - triDust ) * ( 1.0 - triFilth );
`

const NORMAL_FRAGMENT = /* glsl */ `
	vec3 triTnX = texture2D( normalMap, triUvX ).xyz * 2.0 - 1.0;
	vec3 triTnY = texture2D( normalMap, triUvY ).xyz * 2.0 - 1.0;
	vec3 triTnZ = texture2D( normalMap, triUvZ ).xyz * 2.0 - 1.0;
	// UDN-style detail blend: only the tangential components are summed, so the
	// detail octave adds slope without ever cancelling the base normal out.
	// The branch is on a uniform, so it is coherent across the whole draw and
	// the three extra fetches cost nothing on materials that opt out.
	if ( uDetailNormal > 0.0 ) {
		triTnX.xy += ( texture2D( normalMap, triDvX ).xy * 2.0 - 1.0 ) * uDetailNormal;
		triTnY.xy += ( texture2D( normalMap, triDvY ).xy * 2.0 - 1.0 ) * uDetailNormal;
		triTnZ.xy += ( texture2D( normalMap, triDvZ ).xy * 2.0 - 1.0 ) * uDetailNormal;
	}
	triTnX.xy *= normalScale;
	triTnY.xy *= normalScale;
	triTnZ.xy *= normalScale;
	triTnX = vec3( triTnX.xy + triN.zy, abs( triTnX.z ) * triN.x );
	triTnY = vec3( triTnY.xy + triN.xz, abs( triTnY.z ) * triN.y );
	triTnZ = vec3( triTnZ.xy + triN.xy, abs( triTnZ.z ) * triN.z );
	vec3 triWorldNormal = normalize(
		triTnX.zyx * triBlend.x + triTnY.xzy * triBlend.y + triTnZ.xyz * triBlend.z );
	normal = normalize( ( viewMatrix * vec4( triWorldNormal, 0.0 ) ).xyz );
`

const AO_FRAGMENT = /* glsl */ `
	float ambientOcclusion = ( triOrm.r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT )
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
`

const VERTEX_HELPERS = /* glsl */ `
varying vec3 vTriWorldPos;
varying vec3 vTriWorldNormal;
`

// Instancing and batching move the vertex without touching `modelMatrix`, so
// the world position has to be rebuilt the same way three does it internally.
const VERTEX_WORLD = /* glsl */ `
	vec4 triWorld4 = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		triWorld4 = batchingMatrix * triWorld4;
	#endif
	#ifdef USE_INSTANCING
		triWorld4 = instanceMatrix * triWorld4;
	#endif
	vTriWorldPos = ( modelMatrix * triWorld4 ).xyz;
`

// `transformedNormal` is already correct for instancing, skinning and
// non-uniform scale; the view rotation is orthonormal so its inverse is its
// transpose.
const VERTEX_NORMAL = /* glsl */ `
	vTriWorldNormal = transpose( mat3( viewMatrix ) ) * normalize( transformedNormal );
`

const CACHE_KEY = 'cod-triplanar-v2'

/** True once `applyTriplanar` has patched this material. */
export function isTriplanar(material: THREE.Material): boolean {
  return material.userData.triplanar === true
}

export function applyTriplanar(material: THREE.MeshStandardMaterial, options: TriplanarOptions): void {
  const offset = options.offset ?? new THREE.Vector3()
  const dust = options.dustColor ?? new THREE.Color(0.26, 0.22, 0.17)
  const grime = options.grimeColor ?? new THREE.Color(0.05, 0.044, 0.035)
  const uniforms = {
    uTriScale: { value: options.scale },
    uTriSharp: { value: options.sharpness ?? 6 },
    uTriOffset: { value: offset },
    uMacroScale: { value: options.macroScale ?? 0.055 },
    uMacroAlbedo: { value: options.macroAlbedo ?? 0.16 },
    uMacroRough: { value: options.macroRough ?? 0.14 },
    uDustColor: { value: dust },
    uDustAmount: { value: options.dustAmount ?? 0 },
    uDustRough: { value: options.dustRough ?? 0.94 },
    uDetailScale: { value: options.detailScale ?? 4.7 },
    uDetailNormal: { value: options.detailNormal ?? 0 },
    uGrimeColor: { value: grime },
    uCavityDirt: { value: options.cavityDirt ?? 0.5 },
    uGrimeAmount: { value: options.grimeAmount ?? 0.55 },
    uGrimeHeight: { value: options.grimeHeight ?? 0.55 },
    uGrimeBase: { value: options.grimeBase ?? 0 },
  }
  material.userData.triplanar = true
  material.userData.triplanarUniforms = uniforms

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HELPERS}`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>\n${VERTEX_NORMAL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_WORLD}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HELPERS}`)
      .replace('#include <map_fragment>', MAP_FRAGMENT)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
      .replace('#include <metalnessmap_fragment>', METALNESS_FRAGMENT)
      .replace('#include <normal_fragment_maps>', NORMAL_FRAGMENT)
      .replace('#include <aomap_fragment>', AO_FRAGMENT)
  }
  // Patched and unpatched materials must not share a compiled program.
  material.customProgramCacheKey = () => CACHE_KEY
}
