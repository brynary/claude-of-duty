import * as THREE from 'three'

/**
 * World-space triplanar projection for architectural materials.
 *
 * Five problems this solves at once:
 *
 * 1. **Texel density is correct by construction.** The projection is driven by
 *    world position in metres, so a wall is textured at the same scale whether
 *    the level built it from a 12 m box or a 2 m one, and whatever its UVs say.
 *    Stretched textures on stretched boxes are the classic engine-demo tell.
 * 2. **Surfaces have real depth.** The baked height field rides in the alpha
 *    channel of the normal map and is parallax-marched per pixel, so mortar
 *    goes *behind* brick and joints go *under* setts. A normal map alone only
 *    encodes slope; at the grazing angles that dominate a first-person frame —
 *    a wall running away down an alley, paving under your feet — slope shading
 *    collapses and the surface reads as a photograph of relief rather than
 *    relief. This is the difference.
 * 3. **Apparent texel density is multiplied.** A shared micro-detail texture is
 *    projected at a fixed world frequency on top of every material, adding
 *    grain, gloss breakup and pore cavities an order of magnitude finer than
 *    any material's own bake. It mips out to flat in the distance, so it costs
 *    nothing where it cannot be seen and never aliases.
 * 4. **Light describes the surface.** Roughness is broken up at three separate
 *    scales — metres, decimetres, millimetres — and the baked occlusion is fed
 *    back into the *direct* lighting term as micro-shadowing, not just the
 *    ambient. Occlusion applied only to indirect light is invisible under a
 *    strong sun, which is exactly when a player is looking at a wall.
 * 5. **Surfaces accumulate history.** Dust settles on upward faces, grime
 *    collects in every cavity, and splash-back darkens the bottom of every
 *    vertical surface where it meets the ground. All three are driven from data
 *    the projection already has — the world normal, the occlusion channel and
 *    the world height — so nothing has to be authored per surface.
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
  /** Cycles per metre of the mid-scale roughness field. */
  mesoScale?: number
  /** Roughness swing of the mid-scale field, +/- fraction. */
  mesoRough?: number
  /** Linear RGB of settled dust. */
  dustColor?: THREE.Color
  /** How strongly dust covers upward faces, 0..1. */
  dustAmount?: number
  /** Roughness that dust drags the surface towards. */
  dustRough?: number
  /** Tiles per metre of the shared micro-detail texture. */
  detailFreq?: number
  /** Strength of the micro-detail normal. 0 disables its contribution. */
  detailNormal?: number
  /** Roughness swing contributed by the micro-detail, absolute. */
  detailRough?: number
  /** How much the micro-detail's pore cavities collect grime, 0..1. */
  detailCavity?: number
  /** Peak-to-trough depth of the relief, in metres. 0 disables parallax. */
  parallax?: number
  /** Metres at which parallax starts and finishes fading out. */
  parallaxFade?: [number, number]
  /** How strongly baked occlusion shadows *direct* light, 0..1. */
  microShadow?: number
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
uniform sampler2D uDetailMap;
uniform float uTriScale;
uniform float uTriSharp;
uniform vec3 uTriOffset;
uniform float uMacroScale;
uniform float uMacroAlbedo;
uniform float uMacroRough;
uniform float uMesoScale;
uniform float uMesoRough;
uniform vec3 uDustColor;
uniform float uDustAmount;
uniform float uDustRough;
uniform float uDetailFreq;
uniform float uDetailNormal;
uniform float uDetailRough;
uniform float uDetailCavity;
uniform float uParallax;
uniform vec2 uParallaxFade;
uniform float uMicroShadow;
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
`

// The height field lives in the normal map's alpha, with 1 at the highest point
// on the surface, so depth below the reference plane is 1 - alpha.
const MAP_FRAGMENT = /* glsl */ `
	vec3 triWorld = vTriWorldPos + uTriOffset;
	vec3 triN = normalize( vTriWorldNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
	vec3 triBlend = pow( abs( triN ), vec3( uTriSharp ) );
	triBlend /= max( triBlend.x + triBlend.y + triBlend.z, 0.0001 );
	vec3 triP = triWorld * uTriScale;
	vec2 triUvX = triP.zy;
	vec2 triUvY = triP.xz;
	vec2 triUvZ = triP.xy;

	// --- Parallax occlusion, on the dominant plane -------------------------
	// Only the plane the surface most faces is marched. On the box-like
	// geometry this projection exists to serve, that plane carries almost all
	// of the blend weight, so marching the other two would triple the cost to
	// correct an error that is already multiplied by ~0.02.
	vec3 triToEye = cameraPosition - vTriWorldPos;
	float triViewDist = length( triToEye );
	vec3 triV = triToEye / max( triViewDist, 0.0001 );
	if ( uParallax > 0.0 ) {
		float triFade = 1.0 - smoothstep( uParallaxFade.x, uParallaxFade.y, triViewDist );
		if ( triFade > 0.0 ) {
			vec3 triA = abs( triN );
			vec2 triBaseUv;
			vec3 triVt;
			float triAxis;
			if ( triA.x >= triA.y && triA.x >= triA.z ) {
				triBaseUv = triUvX;
				triVt = vec3( triV.z, triV.y, triV.x * sign( triN.x ) );
				triAxis = 0.0;
			} else if ( triA.y >= triA.z ) {
				triBaseUv = triUvY;
				triVt = vec3( triV.x, triV.z, triV.y * sign( triN.y ) );
				triAxis = 1.0;
			} else {
				triBaseUv = triUvZ;
				triVt = vec3( triV.x, triV.y, triV.z * sign( triN.z ) );
				triAxis = 2.0;
			}
			// Offset limiting: dividing by the true cosine is correct but blows
			// up to a screen-wide smear at the horizon, so the denominator is
			// floored. Depth is authored in metres and converted to tile units.
			float triDepth = uParallax * uTriScale * triFade;
			vec2 triSweep = ( triVt.xy / max( triVt.z, 0.32 ) ) * triDepth;
			float triSteps = mix( 14.0, 6.0, clamp( triVt.z, 0.0, 1.0 ) );
			float triLayer = 1.0 / triSteps;
			vec2 triStepUv = triSweep * triLayer;
			float triCurLayer = 0.0;
			vec2 triCurUv = triBaseUv;
			float triCurDepth = 1.0 - texture2D( normalMap, triCurUv ).a;
			for ( int i = 0; i < 14; i ++ ) {
				if ( triCurLayer >= triCurDepth ) break;
				triCurUv -= triStepUv;
				triCurLayer += triLayer;
				triCurDepth = 1.0 - texture2D( normalMap, triCurUv ).a;
			}
			// One linear solve between the last two layers. Without it the
			// silhouette of every joint is quantised into visible stair steps.
			vec2 triPrevUv = triCurUv + triStepUv;
			float triAfter = triCurDepth - triCurLayer;
			float triBefore = ( 1.0 - texture2D( normalMap, triPrevUv ).a ) - ( triCurLayer - triLayer );
			float triW = clamp( triAfter / max( triAfter - triBefore, 0.0001 ), 0.0, 1.0 );
			vec2 triOff = mix( triCurUv, triPrevUv, triW ) - triBaseUv;
			if ( triAxis < 0.5 ) triUvX += triOff;
			else if ( triAxis < 1.5 ) triUvY += triOff;
			else triUvZ += triOff;
		}
	}

	vec4 triAlbedo = texture2D( map, triUvX ) * triBlend.x
		+ texture2D( map, triUvY ) * triBlend.y
		+ texture2D( map, triUvZ ) * triBlend.z;
	vec4 triOrm = texture2D( roughnessMap, triUvX ) * triBlend.x
		+ texture2D( roughnessMap, triUvY ) * triBlend.y
		+ texture2D( roughnessMap, triUvZ ) * triBlend.z;

	// --- Shared micro-detail ------------------------------------------------
	// Projected at an absolute world frequency rather than a multiple of the
	// material's own tile, so grit is the same physical size on a 0.9 m brick
	// tile and a 3.5 m dirt tile, and never lines up with either.
	vec3 triDp = ( triWorld + uTriOffset.yzx ) * uDetailFreq;
	vec4 triDetX = texture2D( uDetailMap, triDp.zy );
	vec4 triDetY = texture2D( uDetailMap, triDp.xz );
	vec4 triDetZ = texture2D( uDetailMap, triDp.xy );
	vec2 triDetBA = triDetX.ba * triBlend.x + triDetY.ba * triBlend.y + triDetZ.ba * triBlend.z;

	float triMacro = triValueNoise( triWorld * uMacroScale ) * 0.62
		+ triValueNoise( triWorld * uMacroScale * 2.7 + 19.3 ) * 0.38;
	float triMeso = triValueNoise( triWorld * uMesoScale + 7.13 );

	// Value *and* temperature drift. Weathering shifts hue as well as
	// brightness, and a slight warm/cool split is what stops a large wall
	// reading as one flat sample of paint.
	triAlbedo.rgb *= mix(
		( 1.0 - uMacroAlbedo ) * vec3( 0.97, 1.0, 1.05 ),
		( 1.0 + uMacroAlbedo ) * vec3( 1.05, 1.0, 0.94 ),
		triMacro );

	// Grime in every cavity. The baked occlusion channel already knows where
	// the surface dips below its neighbourhood, and the detail map's pore mask
	// knows where it dips below that; squaring the pair gives a tight crease
	// mask for free. Unlike an AO term this darkens albedo, so it still reads
	// under full sun where ambient occlusion contributes nothing.
	float triCav = max( 1.0 - triOrm.r, triDetBA.y * uDetailCavity );
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
	// Three decades of gloss variation. One is a pattern, two is a texture,
	// three is a surface: metres of weathering drift, decimetres of wet/dry
	// patchiness, millimetres of grain.
	float roughnessFactor = roughness * triOrm.g;
	roughnessFactor *= mix( 1.0 - uMacroRough, 1.0 + uMacroRough, triMacro );
	roughnessFactor *= mix( 1.0 - uMesoRough, 1.0 + uMesoRough, triMeso );
	roughnessFactor += ( triDetBA.x - 0.5 ) * uDetailRough;
	roughnessFactor = mix( roughnessFactor, 0.95, triFilth );
	roughnessFactor = mix( roughnessFactor, uDustRough, triDust );
	roughnessFactor = clamp( roughnessFactor, 0.06, 1.0 );
`

const METALNESS_FRAGMENT = /* glsl */ `
	float metalnessFactor = metalness * triOrm.b * ( 1.0 - triDust ) * ( 1.0 - triFilth );
`

const NORMAL_FRAGMENT = /* glsl */ `
	vec3 triTnX = texture2D( normalMap, triUvX ).xyz * 2.0 - 1.0;
	vec3 triTnY = texture2D( normalMap, triUvY ).xyz * 2.0 - 1.0;
	vec3 triTnZ = texture2D( normalMap, triUvZ ).xyz * 2.0 - 1.0;
	// UDN-style detail blend: only the tangential components are summed, so the
	// micro-detail adds slope without ever cancelling the base normal out. The
	// branch is on a uniform, so it is coherent across the whole draw and the
	// materials that opt out pay nothing.
	if ( uDetailNormal > 0.0 ) {
		triTnX.xy += ( triDetX.xy * 2.0 - 1.0 ) * uDetailNormal;
		triTnY.xy += ( triDetY.xy * 2.0 - 1.0 ) * uDetailNormal;
		triTnZ.xy += ( triDetZ.xy * 2.0 - 1.0 ) * uDetailNormal;
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

// Runs after the lighting loops, so `reflectedLight` is fully accumulated.
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
	#if NUM_DIR_LIGHTS > 0
		// Micro-shadowing (Chan, "Material Advances in Call of Duty: WWII").
		// Occlusion applied only to the ambient term is invisible the moment a
		// surface is in direct sun, which is precisely when a player is close
		// enough to read its relief. Treating the baked occlusion as a cone
		// aperture and testing the sun against it puts the mortar joints, the
		// pitting and the pores back into the lit half of the frame.
		//
		// Floored well above zero: this is here to describe surfaces, not to
		// manufacture more black. A crevice reading 55% of its neighbour is
		// legible; one reading 5% is a hole.
		float triNdl = dot( normal, directionalLights[ 0 ].direction );
		float triAperture = 2.0 * ambientOcclusion * ambientOcclusion;
		float triMicro = mix( 1.0, max( saturate( triNdl + triAperture - 1.0 ), 0.45 ), uMicroShadow );
		reflectedLight.directDiffuse *= triMicro;
		reflectedLight.directSpecular *= triMicro;
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

const CACHE_KEY = 'cod-triplanar-v3'

/** True once `applyTriplanar` has patched this material. */
export function isTriplanar(material: THREE.Material): boolean {
  return material.userData.triplanar === true
}

export function applyTriplanar(
  material: THREE.MeshStandardMaterial,
  detailMap: THREE.Texture,
  options: TriplanarOptions,
): void {
  const offset = options.offset ?? new THREE.Vector3()
  const dust = options.dustColor ?? new THREE.Color(0.26, 0.22, 0.17)
  const grime = options.grimeColor ?? new THREE.Color(0.05, 0.044, 0.035)
  const fade = options.parallaxFade ?? [9, 22]
  const uniforms = {
    uDetailMap: { value: detailMap },
    uTriScale: { value: options.scale },
    uTriSharp: { value: options.sharpness ?? 6 },
    uTriOffset: { value: offset },
    uMacroScale: { value: options.macroScale ?? 0.055 },
    uMacroAlbedo: { value: options.macroAlbedo ?? 0.16 },
    uMacroRough: { value: options.macroRough ?? 0.14 },
    uMesoScale: { value: options.mesoScale ?? 0.85 },
    uMesoRough: { value: options.mesoRough ?? 0.16 },
    uDustColor: { value: dust },
    uDustAmount: { value: options.dustAmount ?? 0 },
    uDustRough: { value: options.dustRough ?? 0.94 },
    uDetailFreq: { value: options.detailFreq ?? 1.6 },
    uDetailNormal: { value: options.detailNormal ?? 0 },
    uDetailRough: { value: options.detailRough ?? 0.22 },
    uDetailCavity: { value: options.detailCavity ?? 0.5 },
    uParallax: { value: options.parallax ?? 0 },
    uParallaxFade: { value: new THREE.Vector2(fade[0], fade[1]) },
    uMicroShadow: { value: options.microShadow ?? 0.85 },
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
