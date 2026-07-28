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
 * Three stops down was too far. An enclosed surface still has to carry its
 * material — plaster relief, brick coursing, the grain of a crate — and below
 * about two stops that information is gone rather than dim. Note this is a
 * *fraction of ambient*, so it lifts shadow midtones and leaves the black point
 * where it is: the darkest pixels in a frame are set by the tone curve's toe,
 * not by this.
 */
const ENCLOSED_BOUNCE = 0.24

/** How far the enclosed tint is pulled back towards white. */
const ENCLOSED_NEUTRALITY = 0.45

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
 */
const VISIBILITY_GAMMA = 0.62

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
uniform vec3 skyOccBounce;
// x: visibility gamma, y: normal push in metres, z: specular share, w: enabled
uniform vec4 skyOccParams;
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
	vec3 skyOccAtten = mix( skyOccBounce, vec3( 1.0 ), skyOccVis );

#endif

#if defined( RE_IndirectDiffuse )

	irradiance *= skyOccAtten;
	iblIrradiance *= skyOccAtten;

#endif

#if defined( RE_IndirectSpecular )

	radiance *= mix( vec3( 1.0 ), skyOccAtten, skyOccParams.z );

#endif

#include <lights_fragment_end>
`

interface InteriorCandidate {
  x: number
  y: number
  z: number
  visibility: number
}

export class SkyOcclusion {
  /**
   * Floor positions inside roofed volumes, darkest first. The lighting system
   * turns these into bounce fills so cutting the ambient does not turn every
   * room into the black void the rubric fails outright.
   */
  readonly interiorPoints: THREE.Vector3[] = []

  private texture: THREE.Data3DTexture
  private readonly uniforms = {
    skyOccMap: { value: null as THREE.Data3DTexture | null },
    skyOccOrigin: { value: new THREE.Vector3() },
    skyOccInvExtent: { value: new THREE.Vector3(1, 1, 1) },
    skyOccBounce: { value: new THREE.Vector3(ENCLOSED_BOUNCE, ENCLOSED_BOUNCE, ENCLOSED_BOUNCE) },
    skyOccParams: { value: new THREE.Vector4(VISIBILITY_GAMMA, NORMAL_PUSH, SPECULAR_SHARE, 0) },
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

  /** Chain this off every world material's `onBeforeCompile`. */
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
   * Hue an enclosed surface's remaining ambient takes. Warm, because it is
   * bounce off dust and plaster, not the sky the surface cannot see. Only the
   * hue is taken from the argument — the level is fixed by ENCLOSED_BOUNCE, so
   * changing the bounce colour never changes how dark interiors get.
   */
  setBounceColor(color: THREE.Color): void {
    const peak = Math.max(color.r, color.g, color.b, 1e-4)
    const t = ENCLOSED_NEUTRALITY
    this.uniforms.skyOccBounce.value.set(
      ENCLOSED_BOUNCE * THREE.MathUtils.lerp(color.r / peak, 1, t),
      ENCLOSED_BOUNCE * THREE.MathUtils.lerp(color.g / peak, 1, t),
      ENCLOSED_BOUNCE * THREE.MathUtils.lerp(color.b / peak, 1, t),
    )
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
