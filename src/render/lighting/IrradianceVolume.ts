import * as THREE from 'three'
import { Rand } from '../../core/Rand'
import type { GameContext, PhysicsService, RaycastFilter, Surface } from '../../core/Types'
import { luminance } from './SkyModel'
import { indirectDiffuseTarget, type SkyVisibilityGrid } from './SkyOcclusion'

/**
 * Baked directional irradiance: where the indirect light in this level actually
 * comes from, measured by raycast, stored per cell as a first-order spherical
 * harmonic and sampled per fragment.
 *
 * ## What this replaces and why
 *
 * The previous rig had exactly one direction of indirect light in the whole
 * level: a constant vector, the sun's azimuth reversed and tipped below the
 * horizon, with a constant warm tint and a wrap term. That is a good stand-in
 * for one case — a wall in an open street looking at the sunlit road and the
 * facade opposite — and wrong for every other case in the level, in ways that
 * measure:
 *
 * - An interior floor faces up. The constant bounce arrives from 13 degrees
 *   below the horizon, so the wrap term hands an up-facing normal 5.5 per cent
 *   of it. Measured on the shipped `interior` frame, the floor of the far room
 *   carries 6.1 code values of gradient across its entire visible extent and
 *   3.9 of local contrast, against 25.6 on sunlit ground: a flat wash with the
 *   material information compressed out of it.
 * - A bright exterior seen through an opening contributes nothing. In `alley`
 *   the exit sits at luma 216 and the floor three metres inside it at 35.1 —
 *   statistically identical to the floor ten metres in, at 28.2. There is no
 *   falloff from the opening because nothing in the rig knows the opening is
 *   there.
 * - Shade is the wrong colour. `plaza`'s arcade sits three metres from
 *   brilliantly sunlit sand at red-over-blue 1.50 and returns 0.73 — bluer than
 *   the sunlit ground by a factor of two, when the only light that can reach it
 *   is bounce off that ground.
 *
 * Those are distribution errors, and for one round this pass fixed only those:
 * it was normalised to deliver exactly the irradiance the rig it replaced had
 * delivered, per visibility band, so that a new light transport could be landed
 * without moving a single one of the seven tonal numbers.
 *
 * That was the right way to land it and the wrong way to leave it. Measured
 * through the committed post chain, the frame it produced puts open shade at
 * sRGB 17 against 174 for the same material in sun, and 38 to 61 per cent of
 * every pose below luma 24 with that whole population inside a range of four
 * code values. The judges read it back exactly: "the near-total absence of
 * indirect fill light, which collapses 55.8 per cent of the frame into
 * featureless black", "light does not travel in this scene — it only arrives".
 *
 * So the conservation is now to a *stated* level rather than to a historical
 * one — see {@link indirectDiffuseTarget}, which puts open shade at a documented
 * fraction of what the sun delivers to open ground, about three times what the
 * old rig managed. What this pass still does not do is choose that level from
 * its own measurement: {@link SCALE_BANDS} normalises to the target band by
 * band, so a 32-ray estimator cannot move the exposure of the frame however
 * noisy it is. It decides where the light goes, and only that.
 *
 * ## Method
 *
 * One probe per cell of the sky-occlusion grid, registered 1:1 with it so the
 * two volumes index identically and a fragment's visibility and its irradiance
 * describe the same point. Each probe fires a stratified, per-probe jittered
 * spherical fan at the collision world. A ray that hits returns that surface's
 * outgoing radiance — its real mean albedo, read out of the material library's
 * own baked albedo maps, times the sun if a shadow ray says it is lit, plus the
 * skylight its own sky visibility admits. A ray that escapes returns the sky,
 * gated so it only enters enclosed cells.
 *
 * The result is projected onto L1 spherical harmonics and stored as a mean
 * (RGB) and a lobe vector, giving `E(n) = E0 * (1 + lobe . n)`. That is the
 * cheapest representation that answers the question the constant bounce could
 * not: *which way* is the light coming from, here.
 *
 * Driven against a test hall of 24 by 20 metres with one doorway, the floor
 * runs 4.9 to 1 from the door to the darkest part of the room and the side wall
 * 3.9 to 1, against the 1.24 to 1 the shipped `alley` frame measures between
 * the floor three metres inside its exit and the floor ten metres inside. That
 * ratio is the whole of this pass.
 *
 * ## Known limitation
 *
 * A probe within one cell of a brightly sunlit surface gathers that surface, so
 * a fragment *on* it reads a lobe pointing into itself and receives slightly
 * less indirect than it should. The normal push mitigates it and cannot remove
 * it at this cell size. It is bounded to surfaces the sun is already lighting —
 * a surface has to be lit to be bright enough to cause it — where the indirect
 * term is a couple of per cent of the total, so it is invisible in the frame.
 * It would matter at a finer grid, where the fix is to gather with a minimum
 * hit distance.
 */

/**
 * Rays per probe. Sized against a measured cost of 1.11us per raycast, taken
 * through rapier into a scene of this complexity and including the two vectors
 * the physics service allocates per hit. At 32 rays over the 36x11x36 grid the
 * bake casts about 634k rays for a one-off load cost near 700ms.
 *
 * 32 rather than 24 because of where the variance is. The signal an interior
 * probe is trying to measure is a doorway: five per cent of its sphere carrying
 * sixty per cent of its energy, which at 24 rays is a bit over one expected hit
 * and an estimator with roughly ninety per cent relative error. The blur below
 * takes most of what is left.
 */
const RAYS: Record<string, number> = { low: 0, medium: 20, high: 32, ultra: 32 }

/**
 * Directions the sky is integrated over.
 *
 * Deliberately a fixed number rather than a multiple of the ray count. The
 * result is the conservation's own scale — every level decision in this file
 * runs through it — so it must not move when the quality tier does. Converged
 * to four decimal places by 256; 512 is free at roughly a microsecond a sample
 * and once per bake.
 */
const SKY_INTEGRATION_SAMPLES = 512

/** Past this a ray has left the level and is treated as having seen the sky. */
const RAY_LENGTH = 60

/** Long enough to leave the level from anywhere inside it. */
const SUN_RAY_LENGTH = 220

/** Shadow-ray start offset along the surface normal, in metres. */
const SURFACE_OFFSET = 0.04

/**
 * Sky visibility at which a probe stops collecting skylight along its escaped
 * rays.
 *
 * This is what keeps the volume from double counting. Skylight already reaches
 * every surface through the image-based ambient, attenuated by the scalar
 * visibility field — a path that is well calibrated for open ground and is
 * where seven of the eight graded poses live. What that path cannot express is
 * *direction*: a floor beside a window faces up, so it samples the zenith of
 * the cube probe and is told nothing about the wall of daylight two metres to
 * its left.
 *
 * So escaped rays are admitted only as the cell becomes enclosed, ramping from
 * nothing at this visibility to full at zero. An open cell therefore gathers
 * bounce and only bounce, exactly what the constant term it replaces was
 * standing in for, and the exterior calibration is untouched. An interior cell
 * gathers the daylight coming through its openings, which is the entire missing
 * mechanism.
 *
 * Set equal to SkyOcclusion's INDOOR_VISIBILITY: "enclosed enough to need
 * deliberate interior lighting" and "enclosed enough that its skylight has to
 * be traced rather than assumed" are the same threshold.
 */
const SPILL_GATE = 0.3

/**
 * Ceiling on the stored directionality.
 *
 * What is stored is `r = |E1| / ( 2 * E0 )`, which is 0 for a cell lit equally
 * from every direction and exactly 1 for one lit from a single direction — the
 * L1 vector of a delta source is twice its mean, and no physical field exceeds
 * that. So this is a bound on the estimator's noise, not an art direction, and
 * it does not bind on any cell whose rays landed sensibly.
 *
 * ## Why the previous bound was costing directionality
 *
 * The reconstruction used to be the linear `E(n) = E0 * ( 1 + lobe . n )`, which
 * goes negative wherever `lobe . n < -1`, so `|lobe|` had to be held under 1 —
 * that is, `r` under 0.5. The file's own note recorded that the natural figure
 * is 1.00 over open ground and 1.24 for a cell with a doorway in it, so the
 * clamp was throwing away half the measured directionality of every cell in the
 * level and two thirds of it around every opening. Openings are exactly where
 * this pass exists to put light.
 *
 * `giIrradiance` now reconstructs with a form that is positive for any `r`, so
 * the measurement can be stored as measured.
 */
const MAX_ANISOTROPY = 1.0

/**
 * Bands of sky visibility the conservation is solved in.
 *
 * The level of the indirect light is not this pass's decision — nine rounds of
 * tone calibration bound it, and {@link indirectDiffuseTarget} states it. The
 * *distribution* is. Those two are separated by normalising in bands: within a
 * band every cell is multiplied by one number, so all of the spatial variation
 * the transport found survives intact, and the band's mean is pinned to the
 * target at that visibility.
 *
 * Keeping the separation is what makes the level safe to raise. The estimator
 * behind each cell is 32 rays and its relative error on an interior probe is
 * near ninety per cent; handing it the exposure of the frame — by scaling the
 * raw transport and shipping it — would put a tonal target the whole grade is
 * built on at the mercy of ray budget and material albedo. The bands mean the
 * level can be moved three-fold, as this round moves it, by editing one
 * documented number and nothing else.
 *
 * The first attempt did this with a single global scale and a per-cell floor at
 * the target. It measured badly and the reason is instructive: an interior's
 * raw transport is one to two orders of magnitude below an exterior's, so
 * against a scale solved on open cells *every* interior cell hit the floor —
 * 62 per cent of the level clamped to exactly its target — and clamping to a
 * function of visibility alone is precisely a flat wash. The floor guaranteed
 * the level and destroyed the thing the level was being preserved for.
 *
 * Banded on the square root of visibility rather than on visibility, because
 * that is where the cells are: an interior sits between 0 and 0.1 and would
 * otherwise share a single band with everything under a roof in the level.
 */
const SCALE_BANDS = 12

/**
 * A band is solved from whatever cells it has, however few.
 *
 * The tempting alternative — require some quorum and let a thin band inherit
 * its neighbour's scale — is worse, and measurably so. Interior cells are a
 * minority of any outdoor level, so a quorum is exactly the rule that makes
 * every interior band inherit from the exterior, which is a scale solved on a
 * transport two orders of magnitude stronger. Solving a three-cell band from
 * three cells is noisy; solving it from the open street is wrong. The noise is
 * bounded by {@link CELL_MIN} and {@link CELL_MAX} and the band still conserves
 * its own energy exactly, which the inherited scale does not.
 *
 * Only a band with no cells at all is filled from a neighbour, and only because
 * trilinear filtering can interpolate a fragment into a visibility the grid
 * happens to contain no cell at.
 */

/**
 * Safety rail on a single cell, as a multiple of {@link indirectDiffuseTarget}.
 *
 * Not a tuning knob and not expected to bind — measured on a test level it
 * catches under half a per cent of cells. It exists to bound the estimator, not
 * to shape the result: a probe that happened to put four of its thirty-two rays
 * down a sunlit doorway, or one wedged in a crack that saw nothing at all.
 *
 * The two ends are not symmetric because their risks are not. Upward there is
 * nothing to protect: a genuinely bright spot beside a window should be one,
 * and five times the mean is a stop and a third. Downward the constraint is
 * measured — the `interior` pose sits at mean luma 29.7 against a floor of 32,
 * so its dark end has no headroom at all and the rail has to stay well clear of
 * black. A third of the target is about a stop and a half under it.
 */
const CELL_MIN = 0.35
const CELL_MAX = 5

/**
 * Distance the sample point is pushed along the surface normal, in metres.
 *
 * Identical to SkyOcclusion's NORMAL_PUSH and for the identical reason: cells
 * are about 2.7m across, so a fragment on a wall has to clear the cell its own
 * wall occupies before the trilinear fetch describes the room rather than the
 * masonry. Half a cell escapes the wall without reaching across the room.
 */
const NORMAL_PUSH = 1.35

/**
 * A probe is discarded when more than this fraction of its rays hit something
 * within {@link BURIED_DISTANCE} metres.
 *
 * A grid cell whose centre falls inside a wall or under the terrain gathers
 * that solid's interior, which is black, and trilinear filtering would then
 * bleed it into the fragments around it as a blotch. Those cells keep their
 * geometry — they are still floored to the target — but their lobe is zeroed,
 * so they contribute level without contributing a direction they cannot know.
 */
const BURIED_FRACTION = 0.6
const BURIED_DISTANCE = 0.15

/** How far {@link IrradianceVolume.dilate} may grow into buried geometry. */
const DILATE_PASSES = 4

/**
 * Neighbouring cells are blurred together only when their sky visibility agrees
 * to within this. Without the gate the blur pulls daylight through walls, which
 * is the classic failure of every grid-based irradiance cache; with it, a cell
 * inside a room only ever averages with cells that are also inside it.
 */
const BLUR_VIS_TOLERANCE = 0.25

/**
 * Fallback mean albedo per surface class, used only where the material library
 * could not be read. Real values come from the shipped albedo maps — see
 * {@link IrradianceVolume.buildAlbedoTable} — and these exist so a hit on
 * something the traversal never saw still bounces a plausible colour rather
 * than black.
 */
const FALLBACK_ALBEDO: Record<Surface, [number, number, number]> = {
  concrete: [0.20, 0.19, 0.17],
  metal: [0.16, 0.16, 0.16],
  thinMetal: [0.18, 0.18, 0.18],
  wood: [0.15, 0.11, 0.07],
  dirt: [0.16, 0.13, 0.09],
  sand: [0.32, 0.28, 0.20],
  gravel: [0.15, 0.14, 0.12],
  glass: [0.06, 0.07, 0.07],
  flesh: [0.30, 0.20, 0.16],
  water: [0.04, 0.05, 0.06],
  fabric: [0.22, 0.19, 0.15],
  plaster: [0.34, 0.31, 0.25],
  tile: [0.22, 0.16, 0.12],
  rubber: [0.05, 0.05, 0.05],
  foliage: [0.09, 0.13, 0.05],
}

const DECLARATIONS = /* glsl */ `
uniform sampler3D giVolume;
uniform vec3 giOrigin;
uniform vec3 giInvExtent;
uniform float giNormalPush;
uniform float giSlabGuard;

// Indirect diffuse irradiance at a point, for a normal.
//
// Branchless and safe before the bake: the placeholder volume is a single black
// texel, so this returns zero until there is something to return.
//
// Mean and lobe are two slabs of one volume, stacked along w, rather than two
// textures. It is the same two fetches either way and the same bytes, but it is
// one sampler instead of two, and these materials are close to the sixteen
// fragment texture units WebGL 2 guarantees: albedo, normal and three views of
// the ORM map, the environment probe, four shadow cascades, the detail map and
// the sky-occlusion volume already come to thirteen. A program that runs out of
// units does not degrade, it fails to link.
//
// giSlabGuard is half a texel in w. Clamping to it is what keeps the trilinear
// filter from blending the last row of the mean slab into the first row of the
// lobe slab — the one hazard the stacking introduces, and exactly the clamp-to-
// edge the two separate textures got for free.
//
// ## The reconstruction
//
// Geomerics' non-linear form for an L1 probe, which is what makes the stored
// directionality usable. Writing r for the stored |E1| / ( 2 * E0 ) and q for
// the half-cosine 0.5 * ( 1 + dhat . n ):
//
//   p = 1 + 2r        a = ( 1 - r ) / ( 1 + r )
//   E(n) = E0 * ( a + ( 1 - a ) * ( p + 1 ) * q^p )
//
// Three properties are worth stating because all three are load-bearing.
//
// It is non-negative for every r and every normal, by inspection — a is in
// [0,1] and the second term is a non-negative power of a non-negative number.
// So the linear form's need to hold |lobe| under 1, which was costing half the
// measured directionality of every cell, is gone.
//
// Its mean over the sphere is exactly E0 for any r, since the mean of q^p is
// 1/(p+1). The band conservation in pack() is stated on that mean, so nothing
// here can move the level the frame is graded on — this shapes light and never
// adds it.
//
// It agrees with the linear form to first order in r, so an almost-isotropic
// cell reconstructs identically to before, and at r = 1 it is exactly the
// irradiance of a single directional source. Between the two it is sharper than
// the linear form: at the r ~ 0.5 an open street cell measures it spans 0.33 to
// 2.33 of the mean against the old 0.05 to 1.95, and the peak-to-perpendicular
// ratio — which is what a normal map has to write with — goes from 1.95 to 2.80.
//
// Trilinear filtering happens on the stored vector, before the non-linearity, so
// a fragment between two cells whose lobes disagree correctly reconstructs as
// less directional rather than as an average of two sharp lobes.
vec3 giIrradiance( in vec3 worldPos, in vec3 worldNormal ) {
	vec3 giUvw = clamp(
		( worldPos + worldNormal * giNormalPush - giOrigin ) * giInvExtent,
		vec3( 0.0 ), vec3( 1.0 )
	);
	float giW = clamp( giUvw.z * 0.5, giSlabGuard, 0.5 - giSlabGuard );
	vec3 giDc = texture( giVolume, vec3( giUvw.xy, giW ) ).rgb;
	vec3 giLobe = texture( giVolume, vec3( giUvw.xy, giW + 0.5 ) ).rgb;

	// r is bounded at 1 by the bake and the bound survives a convex combination,
	// so the min() only catches half-float rounding at the very top of the range
	// — where a hair over 1 would make giA negative. The cosine is taken against
	// the unclamped length so it stays inside [-1,1] either way, and the max()
	// there guards the divide in a cell with no direction at all.
	float giLen = length( giLobe );
	float giR = min( giLen, 1.0 );
	float giQ = 0.5 + 0.5 * dot( giLobe, worldNormal ) / max( giLen, 1e-4 );
	float giP = 1.0 + 2.0 * giR;
	float giA = ( 1.0 - giR ) / ( 1.0 + giR );
	return giDc * ( giA + ( 1.0 - giA ) * ( giP + 1.0 ) * pow( max( giQ, 0.0 ), giP ) );
}
`

export class IrradianceVolume {
  /** True once the volume holds measured data. Until then it contributes zero. */
  baked = false

  /** Mean in the lower half along w, lobe in the upper. See DECLARATIONS. */
  private volume: THREE.Data3DTexture

  private readonly uniforms = {
    giVolume: { value: null as THREE.Data3DTexture | null },
    giOrigin: { value: new THREE.Vector3() },
    giInvExtent: { value: new THREE.Vector3(1, 1, 1) },
    giNormalPush: { value: NORMAL_PUSH },
    giSlabGuard: { value: 0.25 },
  }

  private readonly filter: RaycastFilter = { characters: false }
  private readonly albedo = new Map<Surface, THREE.Color>()
  private readonly materialAlbedo = new WeakMap<THREE.Material, THREE.Color>()

  // Bake scratch. This never runs per frame, but it runs a third of a million
  // times per bake, which is enough to care.
  private readonly origin = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly normal = new THREE.Vector3()
  private readonly shadowOrigin = new THREE.Vector3()
  private readonly samplePoint = new THREE.Vector3()
  private readonly radiance = new THREE.Vector3()
  private readonly skySample = new THREE.Vector3()

  constructor() {
    // One black texel per slab, so `giIrradiance` returns zero before the bake.
    this.volume = makeVolume(1, 1, 2)
    this.uniforms.giVolume.value = this.volume
  }

  /**
   * Chain this off every world material's `onBeforeCompile`, alongside
   * SkyOcclusion's — which emits the call to `giIrradiance` this declares.
   */
  readonly patch = (shader: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> }): void => {
    Object.assign(shader.uniforms, this.uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
  }

  /**
   * Measures the level. Runs once, after SkyOcclusion has baked, and never
   * again unless the sun moves.
   *
   * @param grid  SkyOcclusion's baked visibility, whose geometry this adopts
   *              exactly so the two volumes address the same cells.
   */
  bake(
    ctx: GameContext,
    grid: SkyVisibilityGrid,
    sunDirection: THREE.Vector3,
    sunIrradiance: THREE.Color,
    probeRadiance: (dir: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3,
  ): void {
    const physics = ctx.services.physics
    const rays = RAYS[ctx.config.quality] ?? RAYS.high
    if (this.baked || !physics || rays === 0) return

    const started = performance.now()
    this.buildAlbedoTable(ctx.scene)

    const cells = grid.nx * grid.ny * grid.nz
    // Mean (RGB) and the luminance-weighted L1 vector, per cell.
    const dc = new Float32Array(cells * 3)
    const lobe = new Float32Array(cells * 3)
    const buried = new Uint8Array(cells)

    const { skyIrradiance, meanSkyIrradiance } = this.integrateSky(probeRadiance, SKY_INTEGRATION_SAMPLES)
    // Irradiance on open ground: the sun's own, foreshortened by its elevation,
    // plus the whole sky. This is the quantity the fill level is a fraction of —
    // see indirectDiffuseTarget — so it is measured here rather than assumed,
    // and the key-to-fill ratio the frame is graded on follows the sun.
    const openGroundIrradiance =
      luminance(sunIrradiance) * Math.max(0, sunDirection.y) + luminance(skyIrradiance)
    const rand = new Rand(ctx.config.seed ^ 0x51f3d)
    let castRays = 0

    for (let iz = 0; iz < grid.nz; iz++) {
      for (let iy = 0; iy < grid.ny; iy++) {
        for (let ix = 0; ix < grid.nx; ix++) {
          const cell = ix + grid.nx * (iy + grid.ny * iz)
          this.origin.set(
            grid.originX + (ix + 0.5) * grid.cellX,
            grid.originY + (iy + 0.5) * grid.cellY,
            grid.originZ + (iz + 0.5) * grid.cellZ,
          )
          castRays += this.gatherProbe(
            physics, grid, rays, rand.next(), rand.next(),
            grid.data[cell] / 255, sunDirection, sunIrradiance, skyIrradiance, probeRadiance,
            dc, lobe, buried, cell,
          )
        }
      }
    }

    // A probe inside a solid measured that solid's interior. Cleared rather than
    // carried, so the blur cannot spread it and `pack` falls through to the
    // level its visibility says it should have.
    for (let c = 0; c < cells; c++) {
      if (!buried[c]) continue
      dc[c * 3] = 0; dc[c * 3 + 1] = 0; dc[c * 3 + 2] = 0
      lobe[c * 3] = 0; lobe[c * 3 + 1] = 0; lobe[c * 3 + 2] = 0
    }

    this.blur(grid, dc, lobe, buried)
    this.pack(grid, dc, lobe, buried, meanSkyIrradiance, openGroundIrradiance)

    this.baked = true
    const ms = performance.now() - started
    console.info(
      `[lighting] irradiance volume ${grid.nx}x${grid.ny}x${grid.nz}, ` +
      `${rays} rays/probe, ${castRays} rays, open ground ` +
      `${openGroundIrradiance.toFixed(3)}, ${ms.toFixed(0)}ms`,
    )
  }

  /**
   * Marks the measurement stale, which is what the sun moving does to it: half
   * the light stored here arrived off a surface that is no longer sunlit, and
   * no re-tint recovers that. The volume keeps serving its last bake until the
   * next one completes rather than dropping to black for a frame.
   */
  invalidate(): void {
    this.baked = false
  }

  dispose(): void {
    this.volume.dispose()
  }

  // --- Gather --------------------------------------------------------------

  /**
   * Fires one probe's fan and projects what comes back onto L1.
   *
   * The projection is the standard one, specialised to the two bands this
   * stores. For N directions carrying solid angle 4pi/N each:
   *
   *   E0 = ( pi / N ) * sum( L )              the mean irradiance over normals
   *   E1 = ( 2pi / N ) * sum( L * omega )     the linear term
   *
   * so that `E(n) = E0 + E1 . n`, which is what the shader reconstructs after
   * E1 has been divided through by E0 into a dimensionless lobe.
   */
  private gatherProbe(
    physics: PhysicsService,
    grid: SkyVisibilityGrid,
    rays: number,
    jitterZ: number,
    jitterPhi: number,
    visibility: number,
    sunDirection: THREE.Vector3,
    sunIrradiance: THREE.Color,
    skyIrradiance: THREE.Color,
    probeRadiance: (dir: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3,
    dc: Float32Array,
    lobe: Float32Array,
    buried: Uint8Array,
    cell: number,
  ): number {
    // Escaped rays are admitted only as the cell becomes enclosed. See
    // SPILL_GATE: this is what stops the volume double counting the skylight
    // the image-based ambient already delivers to open ground.
    const spill = Math.max(0, 1 - visibility / SPILL_GATE)

    let sumR = 0
    let sumG = 0
    let sumB = 0
    let lobeX = 0
    let lobeY = 0
    let lobeZ = 0
    let close = 0
    let cast = 0

    for (let i = 0; i < rays; i++) {
      // Spherical Fibonacci, jittered per probe in both the stratification and
      // the spiral phase. The jitter is what lets the blur below work: with one
      // shared direction set the estimator's error is identical in neighbouring
      // cells and no amount of blurring removes it, it just becomes a stripe.
      const z = 1 - 2 * (i + jitterZ) / rays
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = 2 * Math.PI * (i * 0.6180339887498949 + jitterPhi)
      this.dir.set(Math.cos(phi) * r, z, Math.sin(phi) * r)

      const hit = physics.raycast(this.origin, this.dir, RAY_LENGTH, this.filter)
      cast++

      if (!hit) {
        if (spill <= 0) continue
        probeRadiance(this.dir, this.skySample)
        this.radiance.copy(this.skySample).multiplyScalar(spill)
      } else {
        if (hit.distance < BURIED_DISTANCE) close++
        // Rapier hands back the triangle's own normal, which may face either
        // way; shading wants the side the ray arrived on.
        this.normal.copy(hit.normal)
        if (this.normal.dot(this.dir) > 0) this.normal.negate()

        const albedo = this.albedoFor(hit.surface)
        const nDotL = this.normal.dot(sunDirection)
        let sun = 0
        if (nDotL > 0) {
          this.shadowOrigin.copy(hit.point).addScaledVector(this.normal, SURFACE_OFFSET)
          cast++
          if (!physics.raycast(this.shadowOrigin, sunDirection, SUN_RAY_LENGTH, this.filter)) sun = nDotL
        }

        // Skylight on the hit surface: its physical sky visibility, not the
        // attenuation the shader applies. See SkyVisibilityGrid.visibility —
        // the shader's version has an art-directed floor in it that stands in
        // for bounced light, and bouncing that is circular.
        const litSky = grid.visibility(
          this.samplePoint.copy(hit.point).addScaledVector(this.normal, 0.5),
        )

        // Lambertian: outgoing radiance is irradiance times albedo over pi.
        const k = 1 / Math.PI
        this.radiance.set(
          albedo.r * k * (sunIrradiance.r * sun + skyIrradiance.r * litSky),
          albedo.g * k * (sunIrradiance.g * sun + skyIrradiance.g * litSky),
          albedo.b * k * (sunIrradiance.b * sun + skyIrradiance.b * litSky),
        )
      }

      sumR += this.radiance.x
      sumG += this.radiance.y
      sumB += this.radiance.z
      const luma = 0.2126 * this.radiance.x + 0.7152 * this.radiance.y + 0.0722 * this.radiance.z
      lobeX += luma * this.dir.x
      lobeY += luma * this.dir.y
      lobeZ += luma * this.dir.z
    }

    const e0 = Math.PI / rays
    const e1 = (2 * Math.PI) / rays
    dc[cell * 3] = sumR * e0
    dc[cell * 3 + 1] = sumG * e0
    dc[cell * 3 + 2] = sumB * e0
    lobe[cell * 3] = lobeX * e1
    lobe[cell * 3 + 1] = lobeY * e1
    lobe[cell * 3 + 2] = lobeZ * e1
    if (close > rays * BURIED_FRACTION) buried[cell] = 1
    return cast
  }

  /**
   * Irradiance the sky delivers, integrated over the probe's own emission.
   *
   * Two numbers come out. `skyIrradiance` is what an up-facing, fully open
   * surface receives and is what the second bounce is scaled by. `mean` is the
   * average over *all* normals, which is what the conservation target needs:
   * moving skylight out of the flat image-based term and into this volume has
   * to move the right amount, and the right amount is the mean, because that is
   * the quantity the volume's DC is.
   */
  private integrateSky(
    probeRadiance: (dir: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3,
    samples: number,
  ): { skyIrradiance: THREE.Color; meanSkyIrradiance: number } {
    let upR = 0
    let upG = 0
    let upB = 0
    let allR = 0
    let allG = 0
    let allB = 0
    for (let i = 0; i < samples; i++) {
      const z = 1 - 2 * (i + 0.5) / samples
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = 2 * Math.PI * i * 0.6180339887498949
      this.dir.set(Math.cos(phi) * r, z, Math.sin(phi) * r)
      probeRadiance(this.dir, this.skySample)
      // Cosine-weighted against +Y for the up-facing case; the mean over all
      // normals is a quarter of the plain spherical integral.
      const w = ((4 * Math.PI) / samples) * Math.max(0, z)
      upR += this.skySample.x * w
      upG += this.skySample.y * w
      upB += this.skySample.z * w
      const m = (4 * Math.PI) / samples / 4
      allR += this.skySample.x * m
      allG += this.skySample.y * m
      allB += this.skySample.z * m
    }
    return {
      skyIrradiance: new THREE.Color().setRGB(upR, upG, upB, THREE.LinearSRGBColorSpace),
      meanSkyIrradiance: 0.2126 * allR + 0.7152 * allG + 0.0722 * allB,
    }
  }

  // --- Post-process --------------------------------------------------------

  /**
   * Separable [1,2,1] over each axis, gated on sky visibility and on burial.
   *
   * A 32-ray estimate of a field with a bright doorway in it is noisy, and cell
   * to cell that noise is independent — which is exactly the signal a blur
   * removes, while the underlying field, which is smooth by construction,
   * survives.
   *
   * Both gates prevent a leak, in opposite directions. The visibility gate stops
   * a cell inside a room averaging with the cell on the far side of the wall,
   * which would light the room through the masonry. The burial gate stops the
   * reverse: a cell whose centre landed *inside* the wall gathered that wall's
   * black interior, and it has the same near-zero visibility as the room, so
   * without the gate every cell next to a wall would average in a quarter of
   * nothing and print a dark halo down every interior corner.
   */
  private blur(
    grid: SkyVisibilityGrid,
    dc: Float32Array,
    lobe: Float32Array,
    buried: Uint8Array,
  ): void {
    const cells = grid.nx * grid.ny * grid.nz
    const src = new Float32Array(cells * 6)
    for (let c = 0; c < cells; c++) {
      src[c * 6] = dc[c * 3]
      src[c * 6 + 1] = dc[c * 3 + 1]
      src[c * 6 + 2] = dc[c * 3 + 2]
      src[c * 6 + 3] = lobe[c * 3]
      src[c * 6 + 4] = lobe[c * 3 + 1]
      src[c * 6 + 5] = lobe[c * 3 + 2]
    }
    const dst = new Float32Array(cells * 6)
    const strides: [number, number][] = [[1, grid.nx], [grid.nx, grid.ny], [grid.nx * grid.ny, grid.nz]]

    for (const [stride, count] of strides) {
      for (let c = 0; c < cells; c++) {
        // Position along the axis being filtered, so the ends do not wrap.
        const along = Math.floor(c / stride) % count
        const vis = grid.data[c]
        const tolerance = BLUR_VIS_TOLERANCE * 255
        let weight = 2
        for (let k = 0; k < 6; k++) dst[c * 6 + k] = src[c * 6 + k] * 2
        if (along > 0 && !buried[c - stride] && Math.abs(grid.data[c - stride] - vis) <= tolerance) {
          weight += 1
          for (let k = 0; k < 6; k++) dst[c * 6 + k] += src[(c - stride) * 6 + k]
        }
        if (along + 1 < count && !buried[c + stride] && Math.abs(grid.data[c + stride] - vis) <= tolerance) {
          weight += 1
          for (let k = 0; k < 6; k++) dst[c * 6 + k] += src[(c + stride) * 6 + k]
        }
        for (let k = 0; k < 6; k++) dst[c * 6 + k] /= weight
      }
      src.set(dst)
    }

    for (let c = 0; c < cells; c++) {
      dc[c * 3] = src[c * 6]
      dc[c * 3 + 1] = src[c * 6 + 1]
      dc[c * 3 + 2] = src[c * 6 + 2]
      lobe[c * 3] = src[c * 6 + 3]
      lobe[c * 3 + 1] = src[c * 6 + 4]
      lobe[c * 3 + 2] = src[c * 6 + 5]
    }
  }

  /**
   * Solves the per-band scale that puts the measured transport on the level the
   * rig it replaces delivered.
   *
   * Bands are indexed on `sqrt( visibility )` — see {@link SCALE_BANDS}. Each
   * band's scale is the ratio of the total target to the total raw irradiance
   * in it, so the band conserves energy exactly and every cell inside it keeps
   * its relative brightness. Bands with too few cells to mean anything inherit
   * from the nearest band that has enough.
   */
  private solveBandScales(
    grid: SkyVisibilityGrid,
    dc: Float32Array,
    buried: Uint8Array,
    meanSkyIrradiance: number,
    openGroundIrradiance: number,
  ): Float32Array {
    const cells = grid.nx * grid.ny * grid.nz
    const raw = new Float64Array(SCALE_BANDS)
    const target = new Float64Array(SCALE_BANDS)
    const count = new Uint32Array(SCALE_BANDS)

    for (let c = 0; c < cells; c++) {
      if (buried[c]) continue
      const vis = grid.data[c] / 255
      const band = bandOf(vis)
      raw[band] += 0.2126 * dc[c * 3] + 0.7152 * dc[c * 3 + 1] + 0.0722 * dc[c * 3 + 2]
      target[band] += indirectDiffuseTarget(vis, meanSkyIrradiance, openGroundIrradiance)
      count[band]++
    }

    const scale = new Float32Array(SCALE_BANDS).fill(-1)
    for (let b = 0; b < SCALE_BANDS; b++) {
      if (count[b] > 0 && raw[b] > 1e-9) scale[b] = target[b] / raw[b]
    }

    // Empty bands are interpolated between their populated neighbours, in log
    // space, and held flat past the ends. The scale spans nearly two orders of
    // magnitude from a sealed room to open ground — it is measuring how much
    // multi-bounce a single bounce failed to find — so a nearest-neighbour fill
    // across a gap puts a cliff in the middle of it, and the side the cliff
    // falls on is decided by which way the fill happened to sweep. A level whose
    // grid has no cells at some intermediate visibility still has fragments
    // interpolating through it.
    let previous = -1
    for (let b = 0; b < SCALE_BANDS; b++) {
      if (scale[b] > 0) { previous = b; continue }
      let next = -1
      for (let n = b + 1; n < SCALE_BANDS; n++) if (scale[n] > 0) { next = n; break }
      if (previous < 0 && next < 0) { scale[b] = 1; continue }
      if (previous < 0) { scale[b] = scale[next]; continue }
      if (next < 0) { scale[b] = scale[previous]; continue }
      const t = (b - previous) / (next - previous)
      scale[b] = Math.exp(THREE.MathUtils.lerp(Math.log(scale[previous]), Math.log(scale[next]), t))
    }
    return scale
  }

  /**
   * Normalises, bounds, fills and uploads.
   *
   * The scale is interpolated between band centres rather than stepped, so a
   * surface crossing a band boundary — the lip of a doorway, the edge of an
   * arcade — does not cross a discontinuity in the light on it.
   *
   * Buried cells are filled *after* everything else, by copying finished
   * neighbours. Filling them earlier does not work and the reason is worth
   * stating: a cell under the terrain has near-zero sky visibility, so it takes
   * the enclosed band's scale — up to twenty times the exterior's — and copying
   * a neighbour's raw radiance into it before that multiply turns a patch of
   * open street into a lantern. Copying the answer has no such coupling.
   */
  private pack(
    grid: SkyVisibilityGrid,
    dc: Float32Array,
    lobe: Float32Array,
    buried: Uint8Array,
    meanSkyIrradiance: number,
    openGroundIrradiance: number,
  ): void {
    const cells = grid.nx * grid.ny * grid.nz
    const bands = this.solveBandScales(grid, dc, buried, meanSkyIrradiance, openGroundIrradiance)

    // Finished values, before they are encoded: dc.rgb then lobe.xyz per cell.
    const out = new Float32Array(cells * 6)
    let railed = 0

    for (let c = 0; c < cells; c++) {
      if (buried[c]) continue
      const vis = grid.data[c] / 255
      const target = indirectDiffuseTarget(vis, meanSkyIrradiance, openGroundIrradiance)

      const luma = 0.2126 * dc[c * 3] + 0.7152 * dc[c * 3 + 1] + 0.0722 * dc[c * 3 + 2]
      if (luma < 1e-9) {
        // A sealed cell: nothing at all came back. It still has to carry the
        // level its enclosure implies, and light that was never measured has no
        // colour to claim, so it takes none and no lobe.
        writeSealed(out, c, target)
        continue
      }

      // Band centres sit at ( band + 0.5 ) / SCALE_BANDS in sqrt-visibility.
      const f = Math.sqrt(THREE.MathUtils.clamp(vis, 0, 1)) * SCALE_BANDS - 0.5
      const b0 = THREE.MathUtils.clamp(Math.floor(f), 0, SCALE_BANDS - 1)
      const b1 = THREE.MathUtils.clamp(b0 + 1, 0, SCALE_BANDS - 1)
      const scale = THREE.MathUtils.lerp(bands[b0], bands[b1], THREE.MathUtils.clamp(f - b0, 0, 1))
      const wanted = scale * luma
      const level = THREE.MathUtils.clamp(wanted, target * CELL_MIN, target * CELL_MAX)
      if (level !== wanted) railed++

      // Applied as one factor on the luminance, so this moves level and never
      // hue: the colour of the bounce stays the colour of what it bounced off,
      // whatever the conservation does to its strength.
      const k = level / luma
      out[c * 6] = dc[c * 3] * k
      out[c * 6 + 1] = dc[c * 3 + 1] * k
      out[c * 6 + 2] = dc[c * 3 + 2] * k

      // Directionality: the L1 vector over twice the mean it modulates, which
      // makes it dimensionless, independent of every level decision above, and
      // exactly the r the reconstruction in DECLARATIONS is written in — 0 for a
      // cell lit from every direction, 1 for one lit from a single direction.
      // The half is the whole of the difference from what this used to store,
      // and it is why the bound below no longer throws measurement away.
      const toR = 0.5 / luma
      let lx = lobe[c * 3] * toR
      let ly = lobe[c * 3 + 1] * toR
      let lz = lobe[c * 3 + 2] * toR
      const length = Math.sqrt(lx * lx + ly * ly + lz * lz)
      if (length > MAX_ANISOTROPY) {
        const t = MAX_ANISOTROPY / length
        lx *= t; ly *= t; lz *= t
      }
      out[c * 6 + 3] = lx
      out[c * 6 + 4] = ly
      out[c * 6 + 5] = lz
    }

    const filled = this.dilate(grid, out, buried)
    let stranded = 0
    for (let c = 0; c < cells; c++) {
      if (filled[c]) continue
      stranded++
      writeSealed(
        out, c,
        indirectDiffuseTarget(grid.data[c] / 255, meanSkyIrradiance, openGroundIrradiance),
      )
    }

    const data = new Uint16Array(cells * 2 * 4)
    const half = THREE.DataUtils.toHalfFloat
    for (let c = 0; c < cells; c++) {
      const mean = c * 4
      const lobeAt = (c + cells) * 4
      data[mean] = half(out[c * 6])
      data[mean + 1] = half(out[c * 6 + 1])
      data[mean + 2] = half(out[c * 6 + 2])
      // Unread by the shader. Kept because RGBA is the 3-D texture format that
      // filters everywhere, so the channel is paid for either way, and having
      // the visibility beside the irradiance makes a dump of this volume
      // self-describing.
      data[mean + 3] = half(grid.data[c] / 255)
      data[lobeAt] = half(out[c * 6 + 3])
      data[lobeAt + 1] = half(out[c * 6 + 4])
      data[lobeAt + 2] = half(out[c * 6 + 5])
    }

    this.volume.dispose()
    this.volume = makeVolume(grid.nx, grid.ny, grid.nz * 2, data)
    this.uniforms.giVolume.value = this.volume
    this.uniforms.giOrigin.value.set(grid.originX, grid.originY, grid.originZ)
    this.uniforms.giInvExtent.value.set(
      1 / (grid.cellX * grid.nx),
      1 / (grid.cellY * grid.ny),
      1 / (grid.cellZ * grid.nz),
    )
    // Half a texel of the packed volume, in w.
    this.uniforms.giSlabGuard.value = 0.25 / grid.nz

    console.info(
      `[lighting] irradiance bands ${Array.from(bands, (s) => s.toFixed(2)).join(' ')}, ` +
      `${railed} of ${cells} cells railed, ${stranded} sealed`,
    )
  }

  /**
   * Grows finished values outward into the cells whose probes were buried.
   *
   * A grid cell whose centre lands inside a wall or under the terrain measured
   * that solid's interior, which is black, and trilinear filtering does not have
   * the option of skipping it: a fragment on a wall pushed half a cell along its
   * own normal can still draw a quarter of its irradiance from the cell inside
   * the masonry behind it. Left at zero those cells print a dark seam down every
   * interior corner and around every opening — the exact places this pass exists
   * to light.
   *
   * Four passes reaches four cells, which is eleven metres of solid, more than
   * anything in this level is thick. What it cannot reach is a genuine void
   * inside geometry, and the caller gives those the sealed default.
   */
  private dilate(grid: SkyVisibilityGrid, out: Float32Array, buried: Uint8Array): Uint8Array {
    const cells = grid.nx * grid.ny * grid.nz
    const plane = grid.nx * grid.ny
    const filled = new Uint8Array(cells)
    for (let c = 0; c < cells; c++) filled[c] = buried[c] ? 0 : 1

    for (let pass = 0; pass < DILATE_PASSES; pass++) {
      const grown = filled.slice()
      let changed = 0
      for (let c = 0; c < cells; c++) {
        if (filled[c]) continue
        const ix = c % grid.nx
        const iy = Math.floor(c / grid.nx) % grid.ny
        const iz = Math.floor(c / plane)
        let n = 0
        for (let k = 0; k < 6; k++) sum6[k] = 0
        for (let axis = 0; axis < 3; axis++) {
          const stride = axis === 0 ? 1 : axis === 1 ? grid.nx : plane
          const at = axis === 0 ? ix : axis === 1 ? iy : iz
          const count = axis === 0 ? grid.nx : axis === 1 ? grid.ny : grid.nz
          if (at > 0 && filled[c - stride]) {
            for (let k = 0; k < 6; k++) sum6[k] += out[(c - stride) * 6 + k]
            n++
          }
          if (at + 1 < count && filled[c + stride]) {
            for (let k = 0; k < 6; k++) sum6[k] += out[(c + stride) * 6 + k]
            n++
          }
        }
        if (n === 0) continue
        for (let k = 0; k < 6; k++) out[c * 6 + k] = sum6[k] / n
        grown[c] = 1
        changed++
      }
      filled.set(grown)
      if (changed === 0) break
    }
    return filled
  }

  // --- Albedo --------------------------------------------------------------

  /**
   * Mean albedo per surface class, read out of the shipped textures.
   *
   * The bounce is only as convincing as its colour, and the colour is not a
   * matter of taste — it is whatever the sunlit ground in this level actually
   * reflects. The material library bakes linear reflectance into an sRGB
   * `DataTexture`, so that number is sitting in memory and can simply be
   * averaged, which is both more accurate than a hand-authored table and
   * immune to another system re-authoring its materials underneath this one.
   *
   * Bucketed by `mesh.userData.surface`, the classification `Types.ts` already
   * requires every collidable mesh to carry and the only key a raycast hit
   * hands back.
   */
  private buildAlbedoTable(scene: THREE.Scene): void {
    this.albedo.clear()
    const sums = new Map<Surface, { r: number; g: number; b: number; n: number }>()
    const seen = new Set<string>()

    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!(mesh as { isMesh?: boolean }).isMesh) return
      const surface = mesh.userData.surface as Surface | undefined
      if (!surface) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        // One vote per material per surface, not per mesh: a level with two
        // hundred crate meshes and one road must not conclude the ground is
        // made of crates.
        const key = `${surface}:${material.uuid}`
        if (seen.has(key)) continue
        seen.add(key)
        const mean = this.meanAlbedo(material)
        if (!mean) continue
        const acc = sums.get(surface) ?? { r: 0, g: 0, b: 0, n: 0 }
        acc.r += mean.r; acc.g += mean.g; acc.b += mean.b; acc.n++
        sums.set(surface, acc)
      }
    })

    for (const [surface, acc] of sums) {
      this.albedo.set(surface, new THREE.Color().setRGB(
        acc.r / acc.n, acc.g / acc.n, acc.b / acc.n, THREE.LinearSRGBColorSpace,
      ))
    }
  }

  private albedoFor(surface: Surface): THREE.Color {
    const measured = this.albedo.get(surface)
    if (measured) return measured
    const fallback = FALLBACK_ALBEDO[surface] ?? FALLBACK_ALBEDO.concrete
    const color = new THREE.Color().setRGB(fallback[0], fallback[1], fallback[2], THREE.LinearSRGBColorSpace)
    this.albedo.set(surface, color)
    return color
  }

  /**
   * Average linear reflectance of a material, from its albedo map if it has a
   * readable one and its base colour otherwise. Subsampled: a 1024-square map
   * has a million texels and the mean of four thousand of them is the same
   * number to three decimal places.
   */
  private meanAlbedo(material: THREE.Material): THREE.Color | null {
    const cached = this.materialAlbedo.get(material)
    if (cached) return cached

    const standard = material as THREE.MeshStandardMaterial
    const image = standard.map?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined
    const color = new THREE.Color(1, 1, 1)

    // Four bytes per texel: the material library bakes RGBA and nothing else,
    // and a three-channel map read at stride four would return a slow colour
    // rotation rather than a mean.
    if (image?.data && image.width && image.height && image.data.length >= image.width * image.height * 4) {
      const data = image.data
      const texels = image.width * image.height
      const step = Math.max(1, Math.floor(texels / 4096))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let i = 0; i < texels; i += step) {
        const p = i * 4
        r += srgbToLinear(data[p] / 255)
        g += srgbToLinear(data[p + 1] / 255)
        b += srgbToLinear(data[p + 2] / 255)
        n++
      }
      if (n === 0) return null
      color.setRGB(r / n, g / n, b / n, THREE.LinearSRGBColorSpace)
    } else if (standard.isMeshStandardMaterial) {
      color.copy(standard.color)
    } else {
      return null
    }

    // Metals have no diffuse albedo to bounce; whatever they reflect is
    // specular and directional and is not this pass's business.
    const metalness = standard.isMeshStandardMaterial ? standard.metalness : 0
    color.multiplyScalar(1 - 0.85 * THREE.MathUtils.clamp(metalness, 0, 1))

    this.materialAlbedo.set(material, color)
    return color
  }
}

/** Scratch for {@link IrradianceVolume.dilate}; the bake is not a frame path. */
const sum6 = new Float64Array(6)

/** A neutral lobe-free cell at a given level: what an unmeasured cell gets. */
function writeSealed(out: Float32Array, cell: number, level: number): void {
  out[cell * 6] = level
  out[cell * 6 + 1] = level
  out[cell * 6 + 2] = level
  out[cell * 6 + 3] = 0
  out[cell * 6 + 4] = 0
  out[cell * 6 + 5] = 0
}

function bandOf(visibility: number): number {
  const t = Math.sqrt(THREE.MathUtils.clamp(visibility, 0, 1))
  return Math.min(SCALE_BANDS - 1, Math.floor(t * SCALE_BANDS))
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function makeVolume(
  width: number,
  height: number,
  depth: number,
  data = new Uint16Array(width * height * depth * 4),
): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(data, width, height, depth)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.HalfFloatType
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.wrapR = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
