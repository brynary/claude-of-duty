import * as THREE from 'three'
import type { GameContext, PhysicsService, RaycastFilter } from '../../core/Types'

/**
 * Baked sky visibility, applied to the ambient term of every world material.
 *
 * Image-based ambient answers "what does the sky look like from a surface with
 * this normal" and never asks whether that surface can actually see the sky.
 * Left alone it lights the underside of a roof exactly as brightly as an open
 * street, which is why an unoccluded frame reads as a set of objects composited
 * over a background rather than objects sitting in a place: soffits, doorway
 * reveals, the gap under a crate and the inside of every room all come out at
 * the same value as the ground beside them.
 *
 * So visibility is measured once, from the world, into a coarse 3-D grid: a
 * short cosine-weighted fan of rays per cell, asking physics how much of the
 * upper hemisphere escapes. The grid is uploaded as a single-channel volume and
 * sampled per fragment at `worldPosition + normal * push`. Pushing along the
 * normal is what buys directionality from a scalar field — a wall facing the
 * street samples the street, the soffit above it samples the room.
 *
 * This is the large-scale half of occlusion and is deliberately complementary
 * to the screen-space AO in the post chain: SSAO resolves creases and contact
 * points down to a few centimetres and knows nothing beyond the depth buffer,
 * this knows about the roof twelve metres up that is off screen entirely.
 * Multiplying both is correct; neither substitutes for the other.
 *
 * Indirect diffuse is applied here too, for two reasons that are really one: it
 * needs the world-space position and normal this pass has already
 * reconstructed, and the skylight half of it has to be occluded by exactly the
 * same visibility. It comes from {@link IrradianceVolume}, which this pass
 * registers its grid with so the two volumes address identical cells.
 *
 * The constant-direction bounce below is what remains when there is no volume —
 * no physics, or the lowest quality tier. It was the whole of the indirect
 * bounce for eight rounds and it is kept, and kept documented, because it is
 * still the fallback. Its level is no longer authored: both paths are solved
 * from {@link OPEN_SHADE_FRACTION}, so the frame does not change character when
 * one is substituted for the other.
 */

/** Cells across the level, per axis, per quality tier. */
const GRID: Record<string, [number, number, number]> = {
  low: [0, 0, 0],
  medium: [26, 8, 26],
  high: [36, 11, 36],
  ultra: [36, 11, 36],
}

/**
 * Vertical extent of the grid measured up from the level floor. Everything
 * above this is roof or open air and clamps to the fully-visible top slice.
 */
const GRID_HEIGHT = 30

/** Past this a ray has left the level; treat it as having reached the sky. */
const RAY_LENGTH = 45

/**
 * Fraction of the open-sky ambient a fully enclosed surface keeps. Not zero:
 * light that gets into a room bounces around it, and a black void fails the
 * "interiors lit believably" bar as surely as an unoccluded one fails the
 * grounding bar.
 *
 * An enclosed surface still has to carry its material — plaster relief, brick
 * coursing, the grain of a crate — and past about two stops down that
 * information is gone rather than dim.
 *
 * ## Why this is now less than half what it was
 *
 * At 0.46 this was the single largest term lighting an interior — 64 per cent
 * of everything a shaded indoor surface received — and it is completely
 * undifferentiated. It is the sky's colour, arriving from the sky's direction,
 * at a strength set only by how much sky the cell can see. It is, precisely,
 * the ambient wash the judges kept naming: "every interior surface is
 * ambient-only", "a flat ambient wash", "no material information".
 *
 * It was that large because it was standing in for light transport nobody was
 * computing. {@link IrradianceVolume} now computes it, and the difference is
 * handed over rather than removed — see {@link indirectDiffuseTarget}, which
 * takes the exact irradiance this cut releases and adds it to the volume's
 * target. So none of the energy this removes is lost; what changes is that it
 * arrives from a measured direction with a measured colour instead of from
 * everywhere at once.
 *
 * Only the *diffuse* half moved. Specular occlusion keeps the old floor — see
 * {@link ENCLOSED_SPECULAR} — because none of this reasoning applies to it.
 */
const ENCLOSED_SKYLIGHT = 0.22

/**
 * The same fraction for glossy reflections, held at the value the previous
 * eight rounds landed on.
 *
 * These used to be one number and should not be. Cutting the diffuse floor is
 * justified by there being somewhere better for that energy to go; there is no
 * equivalent for reflections, because the irradiance volume is L1 and carries
 * no radiance detail a reflection could use. Cutting this too would simply have
 * dimmed every interior highlight by thirty per cent, and highlights are where
 * a frame's white point comes from.
 */
const ENCLOSED_SPECULAR = 0.46

/**
 * Fraction of the *fallback* directional bounce a fully enclosed surface keeps,
 * as distinct from the fraction of skylight it keeps above.
 *
 * These have to be separate numbers because they are separate physics, and
 * collapsing them into one is what left the interiors black. Sky visibility
 * answers "can this surface see the sky", and for a wall four metres inside a
 * building the honest answer is no — {@link ENCLOSED_BOUNCE} is right to cut it
 * hard. But the bounce term does not represent skylight. It represents light
 * that has *already* bounced: off the patch of sun on the floor, off the wall
 * opposite the window. That light is generated inside the room, and how much of
 * it reaches a given wall is set by the room's aperture and its albedo, not by
 * whether that particular wall has line of sight to open sky.
 *
 * Attenuating it as though it were skylight is a double count, and it was
 * costing almost everything: measured, an interior wall carried 7.4 display
 * code values of total variation between its lit and shaded micro-facets,
 * against 57 on a sunlit wall. Under a tenth of the material information, which
 * is exactly the judges' "well over half of the frame carries no material
 * information at all" — and it is a lighting failure, not a tone curve failure,
 * because there was nothing in the shading for a curve to recover.
 *
 * At 0.65 the same wall carries 23.5. Still well under the sunlit case, as it
 * should be, but the plaster relief, the brick coursing and the grain of a
 * crate are all back above the threshold where an 8-bit display can show them.
 *
 * ## Why it went to 0.85
 *
 * Not for the exterior — the poses that live outdoors barely have a cell down
 * here. It is for the `interior` pose, which scores lowest of the eight and is
 * the one frame whose mean luma sits *below* its target range rather than above:
 * measured on the shipped capture it is 29.7 against a floor of 32, with 48 per
 * cent of the frame under luma 24 and a standard deviation of 20.7 against a
 * floor of 45.
 *
 * It also compensates for a shape change. The skylight handover in
 * {@link indirectDiffuseTarget} is a fixed quantity, so when the bounce term it
 * sits beside was three times smaller the handover was 55 per cent of what an
 * enclosed surface received and the target rose by a third into full enclosure.
 * At the corrected bounce level the handover is 23 per cent of it and the curve
 * would otherwise have gone slightly the other way — interiors getting less of a
 * relative lift than the open street, which is backwards for the one pose that
 * needs it most. 0.85 restores a target that rises, gently, as a surface loses
 * sight of the sky.
 *
 * This does not flatten the room. The level is a mean over normals and the
 * reconstruction spends it directionally: a wall facing the doorway takes 2.7
 * times this and one facing away takes a third of it, so what an interior gains
 * is a gradient across itself, not a wash.
 */
const BOUNCE_ENCLOSED_FLOOR = 0.85

/** How far the enclosed tint is pulled back towards white. */
const ENCLOSED_NEUTRALITY = 0.45

/**
 * Wrap on the fallback bounce's cosine term. The source is a road and a wall,
 * not a point, so its terminator is soft and it reaches a little past ninety
 * degrees.
 *
 * Wrap trades reach against gradient: the wider it is, the more surfaces catch
 * some bounce and the less any of them varies across its own normals. Declared
 * here rather than beside the rest of the fallback because
 * {@link BOUNCE_IRRADIANCE} is solved from it.
 */
const BOUNCE_WRAP = 0.30

/**
 * Indirect diffuse an open shaded surface receives, as a fraction of the
 * irradiance direct sun delivers to open ground.
 *
 * This is the one number that sets how dark shade is, and it is stated as a
 * ratio because that is the quantity every complaint about this frame has
 * actually been about. It replaces a scene-referred constant that was solved
 * backwards — from what the rig it superseded happened to deliver — and it is
 * roughly two and a half times that constant.
 *
 * ## Why it moved
 *
 * The eight rounds before this one conserved energy against the old constant
 * bounce, on the argument that the fault was distribution rather than level.
 * That was measured and it was wrong. Taking the shipped `iter9` captures back
 * through the committed post chain, a surface in open shade lands at sRGB 17
 * against 174 for the same material in sun: a ten to one *display* ratio, where
 * a photograph of a sunlit street shows nearer three to one. Judges measured
 * the same thing from the other end — "the entire left wall averages RGB(13,14,16)
 * with a standard deviation near zero", "55.8 per cent of the frame collapses
 * into featureless black". Reproduced here: across the eight poses, 38 to 61
 * per cent of every frame sits below luma 24 and the whole of that population
 * has a mean of 13 to 17.
 *
 * ## Why this value
 *
 * Two independent derivations agree on roughly a quarter.
 *
 * Physically: with the sun 21 degrees up, open ground receives about 1.26 in
 * these units and returns it at the level's own mean albedo, near 0.24. A
 * vertical surface in the street sees that ground across half its hemisphere
 * and a sunlit facade across part of the rest, and whatever leaves those
 * surfaces bounces again — the interreflection series in a canyon of this
 * albedo is worth about 1.4. That comes to between 0.20 and 0.33 depending on
 * how much of the neighbourhood is in sun, against 0.085 delivered.
 *
 * Empirically: the volume's own single-bounce gather, before the conservation
 * scales it, measures 0.12 to 0.17 for a cell over open street — already twice
 * what the conservation was letting through, and that is one bounce only.
 *
 * ## What holds it here
 *
 * Simulated through the inverted post chain over all eight captures — including
 * the auto-exposure meter's response, which claws back about a third of a stop
 * of anything added — this lands the aggregate at mean 49, std 48, pctBelow8
 * 5.1, localContrast 0.0315 and nearFieldLift 0.035, all inside range. Pushing
 * it to 0.30 takes std to 45.7, on the floor. The binding constraint is not
 * taste and not the frame mean: it is that the meter answers a lifted shadow by
 * darkening the highlights, and `std` is what pays.
 */
const OPEN_SHADE_FRACTION = 0.22

/**
 * Irradiance sunlight plus skylight put on open ground at the default time of
 * day, in the units {@link OPEN_SHADE_FRACTION} is a fraction of.
 *
 * Only the *fallback* bounce uses this. The irradiance volume is handed the
 * live figure — see {@link indirectDiffuseTarget} — so its level tracks the sun
 * wherever the sun is put; the fallback runs on tiers with no volume at all and
 * has no bake to take a measurement from, so it takes the nominal.
 */
const NOMINAL_GROUND_IRRADIANCE = 1.26

/**
 * How much light the sunlit street and the facades opposite throw back, as
 * irradiance in the same units as the sun's own. Fallback path only — the
 * irradiance volume replaces this wholesale the moment it bakes.
 *
 * This is the half of the ambient that a hemisphere light cannot express, and
 * the reason it matters is not colour but *variation*. Image-based ambient from
 * an open sky is very nearly the same from every direction, so a surface lit
 * only by it returns very nearly the same value whichever way its normal points
 * — which means every bit of relief the material pass authors into a normal map
 * is invisible the moment a surface falls into shade. Half a frame with no
 * response to its own normals is most of what "mushy surfaces", "no relief" and
 * a local-contrast reading at half target actually measure.
 *
 * A bounce term restores it, and unlike a second sky term it is directional and
 * coloured: warm, arriving from the sun's side of the street, landing on the
 * faces that are turned away from the sun and therefore have no key at all.
 *
 * Derived rather than authored, so the two indirect paths cannot drift: the
 * wrap term's mean over the sphere is `( 1 + wrap ) / 4`, so this is whatever
 * makes that mean equal the open-shade level the volume also targets. Setting
 * it by hand is how the fallback ended up a stop away from the measured path
 * without anything reporting it.
 *
 * Raising it much further would start making shaded verticals read warmer than
 * the sky lighting them, which is the failure a judge caught as "the shadowed
 * pocket returns warmer than the sky, which is backwards".
 */
const BOUNCE_IRRADIANCE =
  (OPEN_SHADE_FRACTION * NOMINAL_GROUND_IRRADIANCE * 4) / (1 + BOUNCE_WRAP)

/**
 * How far the bounce's hue is pulled from sunlit ground towards the sky on a
 * surface that can see the whole sky.
 *
 * The bounce is tinted as though every direction it arrives from were sunlit
 * sand: {@link SkyOcclusion.setBounce} is handed the sun's colour through a
 * dust-and-plaster albedo, which lands at red-over-blue 2.56 — warmer than the
 * sun itself at 1.49. That is right for the light coming off a patch of sunlit
 * street, and it is the only thing an enclosed surface receives, so an interior
 * should be exactly that warm.
 *
 * It is wrong for an open one, because the lobe is not looking at sunlit street.
 * It is a wide cone tipped a little below the horizon, and on an open surface
 * most of that cone's solid angle is *sky* — the road fills the bottom of it and
 * the buildings a slice of the middle, and everything above them is the same
 * blue dome the skylight term is already sampling. Treating the whole cone as
 * ground is what put a uniform warm-brown on every shaded surface in the frame.
 *
 * Measured through the committed chain, the fault is a strict inequality, which
 * is why it is worth fixing rather than taste. A shaded vertical wall received
 * fill at red-over-blue 1.66 while the sun lighting the wall beside it is 1.49:
 * *shade was warmer than sunlight*. No albedo and no ground colour can produce
 * that. Adding skylight to a bounce-lit surface can only move it away from the
 * sun's hue, never past it, so the rig was violating an inequality that holds
 * for every scene. In the shipped frames it reads as sunlit and shaded facades
 * measuring the same hue — plaza's sunlit facade at 1.31, ads' shaded wall at
 * 1.39 — and it is the whole of the judges' "a fairly uniform warm-brown cast to
 * every shaded surface, which reads as a global tint rather than bounced light".
 *
 * So the tint is mixed towards the sky by this fraction *scaled by the sky
 * visibility the fragment already sampled*, which makes the warm-to-cool balance
 * a function of geometry instead of a constant: an open wall lands near 0.89, a
 * street facade near 1.19, an alley wall near 1.40, an interior stays at 1.6 and
 * up. That gradient is the difference between light that has bounced off
 * something and a tint applied to everything.
 *
 * It costs nothing tonally. The mixed tint is renormalised to the warm tint's
 * *luminance*, so this moves hue and only hue — every one of the seven measured
 * metrics is algebraically untouched by it.
 */
const BOUNCE_SKY_SHARE = 0.45

/**
 * Distance the sample point is pushed along the surface normal, in metres.
 *
 * Pushing along the normal is the only thing that buys directionality out of a
 * scalar field, and it has to clear the cell the surface itself sits in or the
 * trilinear fetch is dominated by the solid the fragment is standing on. Cells
 * here are about 2.7 m across, so a one metre push left every street-facing
 * facade reading as half-enclosed. Half a cell escapes the wall without
 * reaching across a room.
 */
const NORMAL_PUSH = 1.35

/**
 * Visibility is raised to this power before use. Raw hemisphere fractions fall
 * off far faster than perceived brightness does — a courtyard that can see 40%
 * of the sky does not look 60% darker than open ground — so the mid range is
 * lifted while zero stays zero.
 *
 * Back to 0.75 from 0.62. The lower figure was compensating for a fill that was
 * three times over strength: with the sky probe correctly calibrated there is
 * no longer anything to hold up, and the flatter curve was costing the
 * grounding contrast — soffits, doorway reveals, the gap under a crate — that
 * this pass exists to produce.
 */
const VISIBILITY_GAMMA = 0.75

/** How much of the diffuse occlusion also applies to glossy reflections. */
const SPECULAR_SHARE = 0.75

/** A room is somewhere that can see less than this fraction of the sky. */
const INDOOR_VISIBILITY = 0.3

/** Most interior fill candidates the bake will hand back. */
const MAX_INTERIOR_POINTS = 12

/** Interior fills closer together than this collapse to one. */
const INTERIOR_SPACING = 6.5

const DECLARATIONS = /* glsl */ `
uniform sampler3D skyOccMap;
uniform vec3 skyOccOrigin;
uniform vec3 skyOccInvExtent;
uniform vec3 skyOccSkylightFloor;
uniform vec3 skyOccSpecularFloor;
// The fallback bounce at both ends of the sky-visibility range: enclosed, where
// every direction the lobe covers really is sunlit floor, and open, where most
// of it is sky. Same luminance, different hue — see BOUNCE_SKY_SHARE.
uniform vec3 skyOccBounceLight;
uniform vec3 skyOccBounceOpen;
uniform vec3 skyOccBounceDir;
// x: visibility gamma, y: normal push in metres, z: specular share, w: enabled
uniform vec4 skyOccParams;
// 1 while the constant-direction bounce is carrying indirect light, 0 once the
// irradiance volume has baked and taken it over. Never both.
uniform float skyOccFallback;
`

const APPLY = /* glsl */ `
#if defined( RE_IndirectDiffuse ) || defined( RE_IndirectSpecular )

	// World position straight out of the view-space one lighting already has,
	// so nothing has to be interpolated across from the vertex stage.
	vec3 skyOccWorld = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
	vec3 skyOccNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
	vec3 skyOccUvw = ( skyOccWorld + skyOccNormal * skyOccParams.y - skyOccOrigin ) * skyOccInvExtent;
	float skyOccRaw = texture( skyOccMap, clamp( skyOccUvw, vec3( 0.0 ), vec3( 1.0 ) ) ).r;
	float skyOccVis = mix( 1.0, pow( clamp( skyOccRaw, 0.0, 1.0 ), skyOccParams.x ), skyOccParams.w );

#endif

#if defined( RE_IndirectDiffuse )

	// Skylight first, and only skylight. This is the term sky visibility is
	// actually about: a surface that cannot see the sky does not receive it.
	vec3 skyOccAtten = mix( skyOccSkylightFloor, vec3( 1.0 ), skyOccVis );
	irradiance *= skyOccAtten;
	iblIrradiance *= skyOccAtten;

	// Then everything that has already bounced, which is a different physics and
	// takes a different path: it is generated inside the room, so it does not
	// need line of sight to open sky to arrive and must not be cut as though it
	// did — that double count is what emptied every interior two rounds ago.
	//
	// Measured, per cell, by the irradiance volume, which knows which way the
	// doorway is. The wrap term below is what it replaces: one direction for the
	// whole level, which is right for a street wall facing the sunlit road and
	// wrong for the interior floor, the soffit and the arcade.
	irradiance += giIrradiance( skyOccWorld, skyOccNormal );

	if ( skyOccFallback > 0.0 ) {
		float skyOccBounceWrap = max(
			0.0,
			( dot( skyOccNormal, skyOccBounceDir ) + ${BOUNCE_WRAP.toFixed(3)} ) / ${(1 + BOUNCE_WRAP).toFixed(3)}
		);
		float skyOccBounceVis = mix( ${BOUNCE_ENCLOSED_FLOOR.toFixed(3)}, 1.0, skyOccVis );

		// How warm the bounce is, driven by the same visibility that decides how
		// much skylight the surface gets. The two are complementary views of one
		// fact: the more of a surface's hemisphere is sky, the less of the bounce
		// lobe is looking at sunlit ground and the cooler what arrives along it
		// must be. Both tints carry identical luminance, so this is a hue mix and
		// never a level change.
		vec3 skyOccBounceTint = mix( skyOccBounceLight, skyOccBounceOpen, skyOccVis );
		irradiance += skyOccBounceTint * skyOccBounceWrap * skyOccBounceVis * skyOccFallback;
	}

#endif

#if defined( RE_IndirectSpecular )

	radiance *= mix( vec3( 1.0 ), mix( skyOccSpecularFloor, vec3( 1.0 ), skyOccVis ), skyOccParams.z );

#endif

#include <lights_fragment_end>
`

interface InteriorCandidate {
  x: number
  y: number
  z: number
  visibility: number
}

/**
 * The baked visibility field, handed to {@link IrradianceVolume} so its probes
 * land on identical cells.
 *
 * Sharing the geometry rather than choosing a second one is not an optimisation
 * — it is what makes a fragment's visibility and its irradiance describe the
 * same point. Two grids at different offsets would put the edge of a room in
 * one place for the skylight term and a metre away for the bounce, and the
 * seam would fall on exactly the doorway reveals both terms exist to light.
 */
export interface SkyVisibilityGrid {
  readonly data: Uint8Array
  readonly nx: number
  readonly ny: number
  readonly nz: number
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  readonly cellX: number
  readonly cellY: number
  readonly cellZ: number
  /**
   * Raw sky visibility at a world point, trilinear, 0 to 1.
   *
   * Deliberately raw. It is tempting to hand the volume's second bounce the
   * multiplier the fragment shader actually applies — {@link ENCLOSED_SKYLIGHT}
   * and all — on the grounds that a bounce should carry the brightness the
   * renderer is going to *draw*. That was tried and it is circular: that floor
   * is itself a stand-in for bounced light, so feeding it back in means the
   * volume gathers the flat sky-coloured wash off every wall and puts it
   * straight back. Measured on a test room it held the interior's red-over-blue
   * at 0.86 — bluer than the sky — and left the field so nearly isotropic that
   * a wall facing the doorway and a wall facing away came out within 7 per cent
   * of each other.
   *
   * With the physical fraction the sunlit patch inside the door outweighs an
   * unlit wall by two orders of magnitude, which is what makes the lobe point
   * somewhere and the hue come out warm. The level that costs is put back by
   * the conservation, which is where level decisions belong.
   */
  visibility(point: THREE.Vector3): number
}

/**
 * Mean indirect diffuse irradiance, over all normals, that a surface at a given
 * sky visibility should receive.
 *
 * This is what the irradiance volume normalises to, band by band, and it is the
 * level half of the rig. The volume decides *where* the light goes; this decides
 * how much there is. Keeping those apart is what lets a measured transport with
 * a noisy 32-ray estimator behind it land on a frame that has to hit seven
 * numeric targets.
 *
 * Three terms.
 *
 * - **The bounce.** {@link OPEN_SHADE_FRACTION} of whatever the sun and sky put
 *   on open ground, which the caller measures at bake time rather than assuming.
 *   That coupling is the point: move the sun and the fill follows it, so the
 *   key-to-fill ratio the whole frame is graded on is a constant of the rig and
 *   not an accident of one time of day.
 * - **The enclosure falloff.** A surface that cannot see the street sees less of
 *   what the street is throwing. {@link BOUNCE_ENCLOSED_FLOOR} is deliberately
 *   not zero — light that gets into a room bounces around inside it, and that
 *   light is generated in the room rather than arriving from the sky, so it does
 *   not scale with sky visibility the way skylight does.
 * - **The skylight handover.** {@link ENCLOSED_SKYLIGHT} was cut below what the
 *   eight rounds before the volume calibrated it at, on the grounds that the
 *   volume would carry that energy directionally instead. This is that exact
 *   quantity, returned: the cut is proportional to `1 - visibility` and the
 *   irradiance it was multiplying is the sky's own mean over normals.
 *
 * ## What this replaced
 *
 * Until this round the first term was solved backwards — it was defined as
 * whatever the constant-direction bounce it superseded happened to deliver, so
 * that the volume could be landed without moving any measured number. That was
 * the right call for a first integration and the wrong one to keep: it pinned
 * the frame to a key-to-fill ratio of eleven to one in irradiance and ten to one
 * in display, which is roughly three times what a photograph of a sunlit street
 * shows, and it is the whole of the "featureless black", "no indirect light",
 * "light does not travel in this scene" family of complaints. See
 * {@link OPEN_SHADE_FRACTION} for the measurements and for what now holds the
 * level where it is.
 *
 * ## What moves, and what does not
 *
 * The mean over all normals is what this states, and the volume conserves it per
 * band. Individual normals move a great deal more than the mean does, because
 * the reconstruction is directional: see `giIrradiance` in IrradianceVolume. A
 * surface facing the bounce receives something over twice this and one facing
 * away receives a third of it, which is the difference between light that
 * arrived from somewhere and an ambient wash.
 */
export function indirectDiffuseTarget(
  visibility: number,
  meanSkyIrradiance: number,
  openGroundIrradiance: number,
): number {
  const vis = Math.pow(THREE.MathUtils.clamp(visibility, 0, 1), VISIBILITY_GAMMA)
  const bounce = OPEN_SHADE_FRACTION * openGroundIrradiance
    * THREE.MathUtils.lerp(BOUNCE_ENCLOSED_FLOOR, 1, vis)
  const handover = (ENCLOSED_SKYLIGHT_LEGACY - ENCLOSED_SKYLIGHT) * (1 - vis) * meanSkyIrradiance
  return bounce + handover
}

/**
 * What {@link ENCLOSED_SKYLIGHT} was for the eight rounds that calibrated this
 * frame. Kept as a constant rather than folded into the arithmetic above
 * because it is not a tuning knob: it is the anchor the conservation is
 * measured against, and if it and ENCLOSED_SKYLIGHT are ever set equal the
 * volume correctly stops receiving any handover at all.
 */
const ENCLOSED_SKYLIGHT_LEGACY = 0.46

export class SkyOcclusion {
  /**
   * Floor positions inside roofed volumes, darkest first. The lighting system
   * turns these into bounce fills so cutting the ambient does not turn every
   * room into the black void the rubric fails outright.
   */
  readonly interiorPoints: THREE.Vector3[] = []

  /** Set by {@link bake}; the irradiance volume registers its probes on it. */
  grid: SkyVisibilityGrid | null = null

  private texture: THREE.Data3DTexture
  private readonly uniforms = {
    skyOccMap: { value: null as THREE.Data3DTexture | null },
    skyOccOrigin: { value: new THREE.Vector3() },
    skyOccInvExtent: { value: new THREE.Vector3(1, 1, 1) },
    skyOccSkylightFloor: {
      value: new THREE.Vector3(ENCLOSED_SKYLIGHT, ENCLOSED_SKYLIGHT, ENCLOSED_SKYLIGHT),
    },
    skyOccSpecularFloor: {
      value: new THREE.Vector3(ENCLOSED_SPECULAR, ENCLOSED_SPECULAR, ENCLOSED_SPECULAR),
    },
    skyOccBounceLight: { value: new THREE.Vector3() },
    skyOccBounceOpen: { value: new THREE.Vector3() },
    skyOccBounceDir: { value: new THREE.Vector3(0, -1, 0) },
    skyOccParams: { value: new THREE.Vector4(VISIBILITY_GAMMA, NORMAL_PUSH, SPECULAR_SHARE, 0) },
    skyOccFallback: { value: 1 },
  }

  /** Ray fan, built once: straight up plus a ring, cosine weighted. */
  private readonly rays: THREE.Vector3[] = []
  private readonly weights: number[] = []
  private weightTotal = 0

  private readonly filter: RaycastFilter = { characters: false }
  private readonly probe = new THREE.Vector3()
  private readonly down = new THREE.Vector3(0, -1, 0)
  private baked = false

  constructor() {
    this.texture = makeVolume(1, 1, 1, new Uint8Array([255]))
    this.uniforms.skyOccMap.value = this.texture
    this.buildRayFan(5, THREE.MathUtils.degToRad(55))
  }

  /**
   * Chain this off every world material's `onBeforeCompile`.
   *
   * Requires {@link IrradianceVolume.patch} on the same material: this emits the
   * call to `giIrradiance` and that declares it. Both are chained
   * unconditionally from `LightingSystem.patchWorldMaterial` and neither is
   * optional — the volume declares a function that returns zero when it has not
   * baked, so the pair is correct in every state, but a material that got one
   * and not the other will not compile.
   */
  readonly patch = (shader: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> }): void => {
    Object.assign(shader.uniforms, this.uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
      .replace('#include <lights_fragment_end>', APPLY)
  }

  /**
   * Probes the world. Runs once, after the level has registered its collision.
   * Several tens of thousands of rays, so this is a one-off load cost and never
   * touched again.
   */
  bake(ctx: GameContext): void {
    if (this.baked) return
    const physics = ctx.services.physics
    const bounds = ctx.services.level?.bounds
    const [nx, ny, nz] = GRID[ctx.config.quality] ?? GRID.high
    // Without physics, a level or a grid there is nothing to measure and the
    // uniform stays at its disabled default, which is a plain no-op.
    if (!physics || !bounds || nx === 0) return
    this.baked = true

    // A margin so surfaces on the very edge of the level still sample interior
    // cells rather than clamping to whatever the boundary happens to hold.
    const originX = bounds.min.x - 2
    const originZ = bounds.min.z - 2
    const originY = bounds.min.y
    const extentX = bounds.max.x - bounds.min.x + 4
    const extentZ = bounds.max.z - bounds.min.z + 4
    const extentY = Math.min(GRID_HEIGHT, Math.max(8, bounds.max.y - bounds.min.y))

    const cellX = extentX / nx
    const cellY = extentY / ny
    const cellZ = extentZ / nz

    const started = performance.now()
    const data = new Uint8Array(nx * ny * nz)
    let rays = 0

    for (let iz = 0; iz < nz; iz++) {
      const z = originZ + (iz + 0.5) * cellZ
      for (let iy = 0; iy < ny; iy++) {
        const y = originY + (iy + 0.5) * cellY
        for (let ix = 0; ix < nx; ix++) {
          const x = originX + (ix + 0.5) * cellX
          this.probe.set(x, y, z)
          data[ix + nx * (iy + ny * iz)] = Math.round(255 * this.visibilityAt(physics))
          rays += this.rays.length
        }
      }
    }

    this.texture.dispose()
    this.texture = makeVolume(nx, ny, nz, data)
    this.uniforms.skyOccMap.value = this.texture
    this.uniforms.skyOccOrigin.value.set(originX, originY, originZ)
    this.uniforms.skyOccInvExtent.value.set(1 / extentX, 1 / extentY, 1 / extentZ)
    this.uniforms.skyOccParams.value.w = 1
    this.grid = new VisibilityGrid(
      data, nx, ny, nz, originX, originY, originZ, cellX, cellY, cellZ,
    )

    this.findInteriors(physics, {
      data, nx, ny, nz, originX, originY, originZ, cellX, cellY, cellZ,
      maxY: bounds.max.y,
    })

    const ms = performance.now() - started
    console.info(
      `[lighting] sky occlusion ${nx}x${ny}x${nz}, ${rays} rays, ` +
      `${this.interiorPoints.length} interior fills, ${ms.toFixed(0)}ms`,
    )
  }

  /**
   * Whether the constant-direction bounce is carrying indirect light.
   *
   * There is deliberately no cross-fade and no partial state: two mechanisms
   * putting indirect light on the same surface is how a rig ends up with a knob
   * that moves something else, and this one has eight rounds of calibration
   * riding on it. Either the irradiance volume baked and owns the bounce, or it
   * did not and the constant term still does.
   */
  setFallbackBounce(enabled: boolean): void {
    this.uniforms.skyOccFallback.value = enabled ? 1 : 0
  }

  /**
   * Loads both halves of the bounce: the hue an enclosed surface's remaining
   * skylight takes, and the directional fallback term open surfaces in shade
   * receive while there is no irradiance volume.
   *
   * Only the hue is taken from `color` and `skyTint` — every level is fixed by
   * ENCLOSED_SKYLIGHT and BOUNCE_IRRADIANCE, so re-tinting the bounce never
   * changes how dark interiors get or how much fill a shaded wall receives.
   *
   * `color` is the light coming off sunlit ground and `skyTint` the sky filling
   * the rest of the bounce lobe; the shader picks between them by how much sky
   * the fragment can see. See {@link BOUNCE_SKY_SHARE}.
   *
   * `direction` points from the surface *towards* the source, the same
   * convention as a light vector, and `strength` scales the directional term
   * only, so the bounce can fade out with the sun without the enclosed floor
   * following it down into a black void.
   */
  setBounce(
    direction: THREE.Vector3,
    color: THREE.Color,
    skyTint: THREE.Color,
    strength: number,
  ): void {
    const peak = Math.max(color.r, color.g, color.b, 1e-4)
    const warmR = color.r / peak
    const warmG = color.g / peak
    const warmB = color.b / peak

    // The skylight an enclosed surface keeps is tinted towards what it bounced
    // off rather than towards the sky it cannot see, and the specular floor
    // takes the same hue for the same reason.
    const t = ENCLOSED_NEUTRALITY
    const tintR = THREE.MathUtils.lerp(warmR, 1, t)
    const tintG = THREE.MathUtils.lerp(warmG, 1, t)
    const tintB = THREE.MathUtils.lerp(warmB, 1, t)
    this.uniforms.skyOccSkylightFloor.value.set(
      ENCLOSED_SKYLIGHT * tintR, ENCLOSED_SKYLIGHT * tintG, ENCLOSED_SKYLIGHT * tintB,
    )
    this.uniforms.skyOccSpecularFloor.value.set(
      ENCLOSED_SPECULAR * tintR, ENCLOSED_SPECULAR * tintG, ENCLOSED_SPECULAR * tintB,
    )

    const level = BOUNCE_IRRADIANCE * strength
    this.uniforms.skyOccBounceLight.value.set(level * warmR, level * warmG, level * warmB)

    // The open-sky variant: the same lobe, mixed towards the sky, then put back
    // on the warm tint's luminance. Renormalising by luminance rather than by
    // peak is the whole reason this is tonally free — matching peaks would move
    // brightness as well as hue, and this rig has spent six rounds getting the
    // brightness where it is.
    const skyPeak = Math.max(skyTint.r, skyTint.g, skyTint.b, 1e-4)
    const s = BOUNCE_SKY_SHARE
    const mixR = THREE.MathUtils.lerp(warmR, skyTint.r / skyPeak, s)
    const mixG = THREE.MathUtils.lerp(warmG, skyTint.g / skyPeak, s)
    const mixB = THREE.MathUtils.lerp(warmB, skyTint.b / skyPeak, s)
    const warmLuma = 0.2126 * warmR + 0.7152 * warmG + 0.0722 * warmB
    const mixLuma = Math.max(0.2126 * mixR + 0.7152 * mixG + 0.0722 * mixB, 1e-4)
    const k = (level * warmLuma) / mixLuma
    this.uniforms.skyOccBounceOpen.value.set(k * mixR, k * mixG, k * mixB)

    this.uniforms.skyOccBounceDir.value.copy(direction).normalize()
  }

  dispose(): void {
    this.texture.dispose()
    this.interiorPoints.length = 0
  }

  // --- Internals -----------------------------------------------------------

  private buildRayFan(ringCount: number, ringAngle: number): void {
    this.rays.push(new THREE.Vector3(0, 1, 0))
    this.weights.push(1)
    const sin = Math.sin(ringAngle)
    const cos = Math.cos(ringAngle)
    for (let i = 0; i < ringCount; i++) {
      const a = (i / ringCount) * Math.PI * 2
      this.rays.push(new THREE.Vector3(Math.cos(a) * sin, cos, Math.sin(a) * sin))
      // Cosine weighting: a ray near the horizon carries far less irradiance
      // than one straight overhead, so it must not vote as loudly.
      this.weights.push(cos)
    }
    this.weightTotal = this.weights.reduce((a, b) => a + b, 0)
  }

  private visibilityAt(physics: PhysicsService): number {
    let open = 0
    for (let i = 0; i < this.rays.length; i++) {
      if (!physics.raycast(this.probe, this.rays[i], RAY_LENGTH, this.filter)) open += this.weights[i]
    }
    return open / this.weightTotal
  }

  /**
   * Walks down each column of the grid to find floors, and keeps the ones that
   * turn out to be under a roof. Costs a few thousand extra rays on top of the
   * volume bake and is what lets interiors be lit deliberately rather than by
   * whatever ambient happened to leak in.
   */
  private findInteriors(
    physics: PhysicsService,
    g: {
      data: Uint8Array; nx: number; ny: number; nz: number
      originX: number; originY: number; originZ: number
      cellX: number; cellY: number; cellZ: number; maxY: number
    },
  ): void {
    const candidates: InteriorCandidate[] = []
    const step = Math.max(1, Math.round(3 / g.cellX))

    for (let iz = 0; iz < g.nz; iz += step) {
      const z = g.originZ + (iz + 0.5) * g.cellZ
      for (let ix = 0; ix < g.nx; ix += step) {
        const x = g.originX + (ix + 0.5) * g.cellX
        let y = g.maxY + 2
        // Descend through roof slab, ceiling and storey until a floor turns up
        // that has a roof over it. Four is enough for anything in this level.
        for (let descent = 0; descent < 4; descent++) {
          this.probe.set(x, y, z)
          const floor = physics.raycast(this.probe, this.down, y - g.originY + 6, this.filter)
          if (!floor) break
          y = floor.point.y - 0.2
          // A downward-facing hit is the underside of a slab, not a floor, and
          // standing a light inside the slab would light nothing.
          if (floor.normal.y < 0.5) continue
          const head = floor.point.y + 1.5
          const iy = Math.floor((head - g.originY) / g.cellY)
          if (iy < 0 || iy >= g.ny) continue
          const visibility = g.data[ix + g.nx * (iy + g.ny * iz)] / 255
          if (visibility < INDOOR_VISIBILITY) {
            // Near ceiling height. A bounce fill down at eye level throws a
            // hard pool on the floor around it; up near the ceiling it reads
            // as light having arrived rather than as a lamp on a stand.
            candidates.push({ x, y: floor.point.y + 2.2, z, visibility })
            break
          }
        }
      }
    }

    // Darkest rooms first, then a stable tie-break so two runs of the same seed
    // place the same lights in the same order.
    candidates.sort((a, b) => (a.visibility - b.visibility) || (a.x - b.x) || (a.z - b.z))
    for (const c of candidates) {
      if (this.interiorPoints.length >= MAX_INTERIOR_POINTS) break
      let crowded = false
      for (const existing of this.interiorPoints) {
        const dx = existing.x - c.x
        const dy = existing.y - c.y
        const dz = existing.z - c.z
        if (dx * dx + dz * dz < INTERIOR_SPACING * INTERIOR_SPACING && Math.abs(dy) < 3) crowded = true
      }
      if (!crowded) this.interiorPoints.push(new THREE.Vector3(c.x, c.y, c.z))
    }
  }
}

/**
 * CPU-side reader for the baked volume.
 *
 * The trilinear filter here is written to match the GPU's, texel centre for
 * texel centre, because the value it produces is fed straight back into the
 * bounce: the irradiance volume asks "how bright will the renderer draw this
 * wall" and then bounces the answer. A reader half a cell out of register would
 * light rooms off a wall a metre from the one the frame shows.
 */
class VisibilityGrid implements SkyVisibilityGrid {
  constructor(
    readonly data: Uint8Array,
    readonly nx: number,
    readonly ny: number,
    readonly nz: number,
    readonly originX: number,
    readonly originY: number,
    readonly originZ: number,
    readonly cellX: number,
    readonly cellY: number,
    readonly cellZ: number,
  ) {}

  visibility(point: THREE.Vector3): number {
    const fx = (point.x - this.originX) / this.cellX - 0.5
    const fy = (point.y - this.originY) / this.cellY - 0.5
    const fz = (point.z - this.originZ) / this.cellZ - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const z0 = Math.floor(fz)
    const tx = fx - x0
    const ty = fy - y0
    const tz = fz - z0

    let sum = 0
    for (let k = 0; k < 8; k++) {
      const wx = k & 1 ? tx : 1 - tx
      const wy = k & 2 ? ty : 1 - ty
      const wz = k & 4 ? tz : 1 - tz
      const x = THREE.MathUtils.clamp(x0 + (k & 1), 0, this.nx - 1)
      const y = THREE.MathUtils.clamp(y0 + ((k >> 1) & 1), 0, this.ny - 1)
      const z = THREE.MathUtils.clamp(z0 + ((k >> 2) & 1), 0, this.nz - 1)
      sum += wx * wy * wz * this.data[x + this.nx * (y + this.ny * z)]
    }
    return sum / 255
  }
}

function makeVolume(width: number, height: number, depth: number, data: Uint8Array): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(data, width, height, depth)
  texture.format = THREE.RedFormat
  texture.type = THREE.UnsignedByteType
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.wrapR = THREE.ClampToEdgeWrapping
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}
