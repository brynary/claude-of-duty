import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { surfaceOf, type MaterialName } from '../render/MaterialNames'
import type { MaterialService, Surface } from '../core/Types'

/**
 * The modular building kit: real-world dimensions, chamfered primitives, and
 * the batching machinery that turns thousands of authored pieces into a
 * handful of draw calls.
 *
 * Everything here works in metres. Every generated surface carries UVs in
 * metres too (1 uv unit = 1 m) so a single material tiling setting reads at a
 * consistent texel density across the whole map.
 */

// --- Kit dimensions --------------------------------------------------------
/** Floor-to-floor height of a residential storey. */
export const STOREY = 3.2
export const DOOR_H = 2.1
export const DOOR_W = 0.98
export const SILL_H = 0.9
export const WINDOW_H = 1.5
export const PARAPET_H = 1.1
/** Rendered masonry wall thickness — thick enough for real window reveals. */
export const WALL_T = 0.34
export const SLAB_T = 0.3
export const KERB_H = 0.13
/**
 * Default chamfer. Sharp 90 degree edges catch no light and read as fake.
 *
 * 4 cm rather than the 2.8 cm this used to be: a chamfer only earns its cost
 * when it is wide enough to hold a specular line at gameplay distance. At 10 m
 * and 1080p, 2.8 cm covers 2.6 px and disappears into the anti-aliasing; 4 cm
 * covers a little under 4 px and reads as a lit arris. `chamferBox` clamps to
 * 85% of the smallest half-extent, so small members are unaffected.
 */
export const CHAMFER = 0.04
/** Chamfer for small members — battens, mullions, boards, slats. */
export const ARRIS = 0.006

export const UP = new THREE.Vector3(0, 1, 0)

/** Materials that should never cast shadows (cost with no visual payoff). */
const NO_CAST = new Set<string>(['glass', 'glassDirty', 'water'])

/**
 * The concrete physics system exposes a cheap oriented-box collider that the
 * `PhysicsService` interface does not declare. Boxy level geometry uses it
 * instead of paying for a trimesh.
 */
export interface StaticPhysics {
  addStaticBox(
    center: THREE.Vector3,
    halfExtents: THREE.Vector3,
    quat: THREE.Quaternion,
    surface: Surface,
    mesh?: THREE.Object3D,
  ): void
  addStatic(mesh: THREE.Mesh, surface: Surface): void
}

// ---------------------------------------------------------------------------
// Triangle soup
// ---------------------------------------------------------------------------

/**
 * Accumulates flat-shaded triangles with metre-scale planar UVs. Faces are
 * auto-oriented against a reference point inside the solid, which removes a
 * whole class of winding bugs when hand-authoring convex primitives.
 */
export class TriSoup {
  private p: number[] = []
  private n: number[] = []
  private t: number[] = []
  private inside = new THREE.Vector3()
  private uvOffset = new THREE.Vector2()

  /** Reference point known to be inside the solid, used to orient faces. */
  setInside(x: number, y: number, z: number): this {
    this.inside.set(x, y, z)
    return this
  }

  /** Shifts generated UVs so identical pieces do not repeat pixel for pixel. */
  setUvOffset(u: number, v: number): this {
    this.uvOffset.set(u, v)
    return this
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, orient = true): void {
    _ab.subVectors(b, a)
    _ac.subVectors(c, a)
    _nrm.crossVectors(_ab, _ac)
    const len = _nrm.length()
    if (len < 1e-9) return
    _nrm.multiplyScalar(1 / len)
    let v1 = b
    let v2 = c
    if (orient) {
      _cen.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(this.inside)
      if (_nrm.dot(_cen) < 0) {
        v1 = c
        v2 = b
        _nrm.negate()
      }
    }
    this.vert(a, _nrm)
    this.vert(v1, _nrm)
    this.vert(v2, _nrm)
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, orient = true): void {
    this.tri(a, b, c, orient)
    this.tri(a, c, d, orient)
  }

  /** Emits both windings so thin sheets are visible from either side. */
  quadTwoSided(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    this.tri(a, b, c, false)
    this.tri(a, c, d, false)
    this.tri(a, d, c, false)
    this.tri(a, c, b, false)
  }

  triTwoSided(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    this.tri(a, b, c, false)
    this.tri(a, c, b, false)
  }

  private vert(v: THREE.Vector3, n: THREE.Vector3): void {
    this.p.push(v.x, v.y, v.z)
    this.n.push(n.x, n.y, n.z)
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    let u: number
    let w: number
    if (ax >= ay && ax >= az) {
      u = v.z
      w = v.y
    } else if (ay >= az) {
      u = v.x
      w = v.z
    } else {
      u = v.x
      w = v.y
    }
    this.t.push(u + this.uvOffset.x, w + this.uvOffset.y)
  }

  get triangleCount(): number {
    return this.p.length / 9
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2))
    return g
  }
}

const _ab = new THREE.Vector3()
const _ac = new THREE.Vector3()
const _nrm = new THREE.Vector3()
const _cen = new THREE.Vector3()

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function v3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z)
}

/**
 * A box with every edge chamfered. This is the single most important primitive
 * in the kit: a chamfer catches a sliver of specular along every silhouette,
 * which is what separates authored architecture from a grey blockout.
 */
export function chamferBox(w: number, h: number, d: number, c = CHAMFER): THREE.BufferGeometry {
  const hw = w / 2
  const hh = h / 2
  const hd = d / 2
  const cc = Math.max(0.0008, Math.min(c, hw * 0.85, hh * 0.85, hd * 0.85))
  const s = new TriSoup()
  const vx = (sx: number, sy: number, sz: number) => v3(sx * hw, sy * (hh - cc), sz * (hd - cc))
  const vy = (sx: number, sy: number, sz: number) => v3(sx * (hw - cc), sy * hh, sz * (hd - cc))
  const vz = (sx: number, sy: number, sz: number) => v3(sx * (hw - cc), sy * (hh - cc), sz * hd)
  const S = [-1, 1]
  for (const sx of S) s.quad(vx(sx, -1, -1), vx(sx, -1, 1), vx(sx, 1, 1), vx(sx, 1, -1))
  for (const sy of S) s.quad(vy(-1, sy, -1), vy(-1, sy, 1), vy(1, sy, 1), vy(1, sy, -1))
  for (const sz of S) s.quad(vz(-1, -1, sz), vz(1, -1, sz), vz(1, 1, sz), vz(-1, 1, sz))
  for (const sx of S) for (const sy of S) s.quad(vx(sx, sy, -1), vx(sx, sy, 1), vy(sx, sy, 1), vy(sx, sy, -1))
  for (const sy of S) for (const sz of S) s.quad(vy(-1, sy, sz), vy(1, sy, sz), vz(1, sy, sz), vz(-1, sy, sz))
  for (const sz of S) for (const sx of S) s.quad(vz(sx, -1, sz), vz(sx, 1, sz), vx(sx, 1, sz), vx(sx, -1, sz))
  for (const sx of S) for (const sy of S) for (const sz of S) s.tri(vx(sx, sy, sz), vy(sx, sy, sz), vz(sx, sy, sz))
  return s.toGeometry()
}

/** 12-triangle box, for pieces too small or too hidden to justify a chamfer. */
export function plainBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const hw = w / 2
  const hh = h / 2
  const hd = d / 2
  const s = new TriSoup()
  const p = (sx: number, sy: number, sz: number) => v3(sx * hw, sy * hh, sz * hd)
  const S = [-1, 1]
  for (const sx of S) s.quad(p(sx, -1, -1), p(sx, -1, 1), p(sx, 1, 1), p(sx, 1, -1))
  for (const sy of S) s.quad(p(-1, sy, -1), p(-1, sy, 1), p(1, sy, 1), p(1, sy, -1))
  for (const sz of S) s.quad(p(-1, -1, sz), p(1, -1, sz), p(1, 1, sz), p(-1, 1, sz))
  return s.toGeometry()
}

/**
 * A right-triangular prism rising along +Z. Used for sand drift, roof pitches,
 * rubble wedges and ramps.
 */
export function rampPrism(w: number, h: number, d: number): THREE.BufferGeometry {
  const hw = w / 2
  const hd = d / 2
  const s = new TriSoup().setInside(0, h * 0.25, hd * 0.4)
  const a0 = v3(-hw, 0, -hd)
  const a1 = v3(hw, 0, -hd)
  const b0 = v3(-hw, 0, hd)
  const b1 = v3(hw, 0, hd)
  const c0 = v3(-hw, h, hd)
  const c1 = v3(hw, h, hd)
  s.quad(a0, a1, b1, b0) // base
  s.quad(a0, a1, c1, c0) // slope
  s.quad(b0, b1, c1, c0) // vertical back
  s.tri(a0, b0, c0) // -X side
  s.tri(a1, b1, c1) // +X side
  return s.toGeometry()
}

/** Cylinder with metre-scale UVs, non-indexed and ready to merge. */
export function cylinderGeom(rTop: number, rBot: number, h: number, seg = 12, capped = true): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !capped).toNonIndexed()
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  const circ = Math.PI * (rTop + rBot)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h)
  uv.needsUpdate = true
  return normalizeGeom(g)
}

export function sphereGeom(r: number, wSeg = 12, hSeg = 8, phiLength = Math.PI * 2, thetaLength = Math.PI): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg, 0, phiLength, 0, thetaLength).toNonIndexed()
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r)
  uv.needsUpdate = true
  return normalizeGeom(g)
}

/** A tube following a sagging catenary between two points — cables, wires. */
export function catenary(
  from: THREE.Vector3,
  to: THREE.Vector3,
  sag: number,
  radius: number,
  segs = 10,
  radial = 4,
): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const p = new THREE.Vector3().lerpVectors(from, to, t)
    p.y -= Math.sin(Math.PI * t) * sag
    pts.push(p)
  }
  const curve = new THREE.CatmullRomCurve3(pts)
  const g = new THREE.TubeGeometry(curve, segs, radius, radial, false).toNonIndexed()
  return normalizeGeom(g)
}

/**
 * A sagging fabric quad — awnings, laundry, tarps and banners.
 *
 * Both displacement terms used to be applied along world Y, which is correct
 * for an awning and *in the plane of the sheet* for anything that hangs. Every
 * back cloth, banner, laundry line and curtain in the district was therefore a
 * dead-flat rectangle carrying nothing but its albedo — the "large flat
 * polygon, no relief, reads like a paper cutout" the critique kept naming, and
 * the biggest single one sits in the middle of the plaza pose.
 *
 * Gravity still pulls along Y. The folds and the ripple now displace along the
 * sheet's own normal, tapering to nothing at the fixed edge (v = 0) and opening
 * out at the free edge, which is how cloth pegged along one edge actually
 * hangs. A near-horizontal sheet has a vertical normal, so awnings keep exactly
 * the behaviour they had.
 */
export function clothQuad(
  c00: THREE.Vector3,
  c10: THREE.Vector3,
  c11: THREE.Vector3,
  c01: THREE.Vector3,
  sag: number,
  ripple = 0.035,
  segU = 6,
  segV = 4,
  phase = 0,
): THREE.BufferGeometry {
  const s = new TriSoup()
  _ab.subVectors(c10, c00)
  _ac.subVectors(c01, c00)
  const nrm = new THREE.Vector3().crossVectors(_ab, _ac)
  if (nrm.lengthSq() < 1e-12) nrm.set(0, 1, 0)
  else nrm.normalize()
  const span = _ab.length()
  /** 0 for a sheet lying flat, 1 for one hanging vertically. */
  const hang = 1 - Math.min(1, Math.abs(nrm.y))
  const foldAmp = (ripple * 1.5 + span * 0.03) * hang
  // Folds have to be resolvable by the mesh, so the span is divided into folds
  // first and the tessellation is raised to carry them. The threshold keeps
  // that cost off the sheets that do not need it: a pitched awning's normal is
  // nearly vertical, and a bunting pennant is too small to fold.
  const folds = Math.min(5, Math.max(2, Math.round(span / 0.7)))
  const doFold = foldAmp > 0.025 && span > 0.5
  const amp = doFold ? foldAmp : 0
  const su = doFold ? Math.max(segU, folds * 3) : segU
  const at = (u: number, v: number): THREE.Vector3 => {
    const a = new THREE.Vector3().lerpVectors(c00, c10, u)
    const b = new THREE.Vector3().lerpVectors(c01, c11, u)
    const p = a.lerp(b, v)
    p.y -= Math.sin(Math.PI * u) * Math.sin(Math.PI * v * 0.5 + 0.35) * sag
    const fold = Math.sin(u * folds * Math.PI * 2 + phase * 0.7) * (0.28 + 0.72 * v) * amp
    const rip = Math.sin(u * 11.3 + phase) * Math.sin(v * 7.1 + phase * 1.7) * ripple
    p.addScaledVector(nrm, fold + rip)
    return p
  }
  for (let i = 0; i < su; i++) {
    for (let j = 0; j < segV; j++) {
      const u0 = i / su
      const u1 = (i + 1) / su
      const v0 = j / segV
      const v1 = (j + 1) / segV
      s.quadTwoSided(at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1))
    }
  }
  return s.toGeometry()
}

/**
 * A shallow conical chip driven into a surface. Bullet damage modelled as real
 * recessed geometry rather than a decal, so it shades correctly at any angle.
 */
export function impactChip(radius: number, depth: number, seg = 6): THREE.BufferGeometry {
  const s = new TriSoup()
  const tip = v3(0, 0, -depth)
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    const r0 = radius * (0.75 + 0.25 * Math.sin(a0 * 3))
    const r1 = radius * (0.75 + 0.25 * Math.sin(a1 * 3))
    s.tri(v3(Math.cos(a0) * r0, Math.sin(a0) * r0, 0), v3(Math.cos(a1) * r1, Math.sin(a1) * r1, 0), tip, false)
  }
  return s.toGeometry()
}

/**
 * A single flat rectangle in the XY plane, one winding, two triangles.
 *
 * `plate` and `decalQuad` both give a sheet the eye has to look through
 * *twice*: a plate has a front and a back face, a decal is wound both ways.
 * That is free on an opaque prop and wrong on a blended one — a pane of glass
 * built as a plate composites its own alpha over itself and turns a 0.86 pane
 * into a 0.98 one, which is precisely how a dirty window ends up reading as a
 * sheet of painted board. The materials this is for are already `DoubleSide`,
 * so the second winding buys nothing anyway.
 */
export function planeQuad(w: number, h: number): THREE.BufferGeometry {
  const s = new TriSoup()
  // Wound so the normal is -Z, which is the outward direction every wall in
  // the kit is authored against.
  s.quad(v3(-w / 2, -h / 2, 0), v3(-w / 2, h / 2, 0), v3(w / 2, h / 2, 0), v3(w / 2, -h / 2, 0), false)
  return s.toGeometry()
}

/** An irregular flat quad hugging a wall — soot, water staining, torn posters. */
export function decalQuad(w: number, h: number, jitter = 0.12, seed = 1): THREE.BufferGeometry {
  const s = new TriSoup()
  const r = (i: number) => {
    const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  const a = v3(-w / 2 + r(1) * jitter * w, -h / 2 + r(2) * jitter * h, 0)
  const b = v3(w / 2 + r(3) * jitter * w, -h / 2 + r(4) * jitter * h, 0)
  const c = v3(w / 2 + r(5) * jitter * w, h / 2 + r(6) * jitter * h, 0)
  const d = v3(-w / 2 + r(7) * jitter * w, h / 2 + r(8) * jitter * h, 0)
  s.quadTwoSided(a, b, c, d)
  return s.toGeometry()
}

/**
 * An irregular patch that follows the ground it lies on, in world space.
 *
 * A flat quad tilted onto uneven paving is the loudest decal artefact there is:
 * one corner buries, the opposite corner lifts, and the whole thing reads as a
 * card someone dropped on the scene. Sampling the drawn surface at every vertex
 * keeps a puddle or a stain welded to the stones under it, and tapering the
 * lift to almost nothing at the rim means the edge never shows a lit sliver.
 *
 * Returns geometry already in world coordinates — add it with no transform.
 */
export function groundPatch(
  cx: number, cz: number, rx: number, rz: number, seed: number,
  height: (x: number, z: number) => number,
  lift = 0.014, rings = 2, segs = 14,
): THREE.BufferGeometry {
  const s = new TriSoup()
  s.setInside(cx, height(cx, cz) - 1.5, cz)
  // Two octaves of wobble so the outline is lobed rather than an ellipse.
  const edge = (i: number): number => {
    const a = (i / segs) * Math.PI * 2
    return 1
      + 0.26 * Math.sin(a * 3 + seed * 1.7)
      + 0.13 * Math.sin(a * 5 - seed * 0.9)
      + 0.07 * Math.sin(a * 8 + seed * 2.3)
  }
  const pt = (i: number, ring: number): THREE.Vector3 => {
    const a = (i / segs) * Math.PI * 2
    const t = ring / rings
    const e = edge(i % segs) * t
    const x = cx + Math.cos(a) * rx * e
    const z = cz + Math.sin(a) * rz * e
    // Lift tapers to nothing at the rim so the patch feathers into the surface.
    return new THREE.Vector3(x, height(x, z) + lift * (1 - t * t * 0.94), z)
  }
  const centre = new THREE.Vector3(cx, height(cx, cz) + lift, cz)
  for (let i = 0; i < segs; i++) {
    s.tri(centre, pt(i, 1), pt(i + 1, 1))
    for (let r = 1; r < rings; r++) {
      s.quad(pt(i, r), pt(i + 1, r), pt(i + 1, r + 1), pt(i, r + 1))
    }
  }
  return s.toGeometry()
}

/**
 * Rotates and shifts a geometry's UVs in place.
 *
 * Instanced props share one geometry, so they also share one set of UVs: every
 * copy of a crate shows the *same* knot in the same place, which is the single
 * loudest tell that a prop was stamped out procedurally. Baking a different
 * offset and grain direction into each variant geometry fixes it without
 * needing a per-instance attribute the material system does not expose.
 */
export function shiftUv(g: THREE.BufferGeometry, du: number, dv: number, quarterTurns = 0): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return g
  const t = ((quarterTurns % 4) + 4) % 4
  for (let i = 0; i < uv.count; i++) {
    let u = uv.getX(i)
    let v = uv.getY(i)
    for (let k = 0; k < t; k++) {
      const nu = -v
      v = u
      u = nu
    }
    uv.setXY(i, u + du, v + dv)
  }
  uv.needsUpdate = true
  return g
}

/** Strips any extra attributes and de-indexes so everything merges cleanly. */
export function normalizeGeom(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g
  for (const key of Object.keys(out.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') out.deleteAttribute(key)
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  if (!out.getAttribute('uv')) {
    const count = out.getAttribute('position').count
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
  }
  out.clearGroups()
  return out
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface ColliderSpec {
  c: THREE.Vector3
  h: THREE.Vector3
  q: THREE.Quaternion
  s: Surface
}

export interface MergeOptions {
  cast?: boolean
  receive?: boolean
  name?: string
  /** Per-material shadow overrides. */
  noCast?: Iterable<MaterialName>
}

/**
 * Collects authored geometry under a transform stack, then merges it down to
 * one mesh per material and registers the accumulated box colliders.
 *
 * One Builder per building or per prop cluster keeps frustum culling useful
 * while still holding the draw-call count to a few dozen for the whole map.
 */
export class Builder {
  private groups = new Map<MaterialName, THREE.BufferGeometry[]>()
  private colliders: ColliderSpec[] = []
  private cur = new THREE.Matrix4()
  private stack: THREE.Matrix4[] = []
  private tmpM = new THREE.Matrix4()
  /** Second scratch matrix: `geom()` must not alias the matrix handed to it. */
  private tmpM2 = new THREE.Matrix4()
  private tmpQ = new THREE.Quaternion()
  private tmpP = new THREE.Vector3()
  private tmpS = new THREE.Vector3()

  /** Pushes a translation + yaw onto the transform stack. */
  push(x = 0, y = 0, z = 0, yaw = 0): this {
    this.stack.push(this.cur.clone())
    this.tmpQ.setFromAxisAngle(UP, yaw)
    this.tmpM.compose(this.tmpP.set(x, y, z), this.tmpQ, this.tmpS.set(1, 1, 1))
    this.cur.multiply(this.tmpM)
    return this
  }

  pushMatrix(m: THREE.Matrix4): this {
    this.stack.push(this.cur.clone())
    this.cur.multiply(m)
    return this
  }

  pop(): this {
    const m = this.stack.pop()
    if (m) this.cur.copy(m)
    return this
  }

  /** Current local-to-world matrix, for callers that need world positions. */
  get matrix(): THREE.Matrix4 {
    return this.cur
  }

  localToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(this.cur)
  }

  /** Adds pre-built geometry, optionally with an extra local transform. */
  geom(name: MaterialName, g: THREE.BufferGeometry, local?: THREE.Matrix4): void {
    const copy = g.clone()
    if (local) {
      this.tmpM2.copy(this.cur).multiply(local)
      copy.applyMatrix4(this.tmpM2)
    } else {
      copy.applyMatrix4(this.cur)
    }
    let list = this.groups.get(name)
    if (!list) {
      list = []
      this.groups.set(name, list)
    }
    list.push(copy)
  }

  /** Visual-only chamfered box at a local position. */
  box(
    name: MaterialName,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    yaw = 0, chamfer = CHAMFER,
  ): void {
    this.tmpQ.setFromAxisAngle(UP, yaw)
    this.tmpM.compose(this.tmpP.set(x, y, z), this.tmpQ, this.tmpS.set(1, 1, 1))
    this.geom(name, chamferBox(w, h, d, chamfer), this.tmpM)
  }

  /**
   * 12-triangle box for small detail (battens, mullions, slats). A chamfer on
   * a 4 cm member is invisible and costs nearly four times the geometry.
   */
  plate(
    name: MaterialName,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    yaw = 0,
  ): void {
    this.tmpQ.setFromAxisAngle(UP, yaw)
    this.tmpM.compose(this.tmpP.set(x, y, z), this.tmpQ, this.tmpS.set(1, 1, 1))
    this.geom(name, plainBox(w, h, d), this.tmpM)
  }

  /**
   * A thin member with a chamfer scaled to its own thickness — boards, slats,
   * copings, counter tops, treads.
   *
   * `plate` is cheaper but leaves a razor arris, and on anything the player
   * walks past at a metre (crate boards, a stall counter, a step nosing) that
   * arris is exactly what makes the prop read as untextured blockout. The
   * chamfer here is a fifth of the smallest dimension, capped at `ARRIS`, so a
   * 2 cm board gets 4 mm and a 12 cm coping gets the full 6 mm.
   */
  slab(
    name: MaterialName,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    yaw = 0,
  ): void {
    const c = Math.min(ARRIS, Math.min(w, h, d) * 0.2)
    this.tmpQ.setFromAxisAngle(UP, yaw)
    this.tmpM.compose(this.tmpP.set(x, y, z), this.tmpQ, this.tmpS.set(1, 1, 1))
    this.geom(name, chamferBox(w, h, d, c), this.tmpM)
  }

  /** Chamfered box plus a matching oriented box collider. */
  solid(
    name: MaterialName,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    yaw = 0, chamfer = CHAMFER, surface?: Surface,
  ): void {
    this.box(name, w, h, d, x, y, z, yaw, chamfer)
    this.collide(w, h, d, x, y, z, yaw, surface ?? surfaceOf(name))
  }

  /** Collision-only oriented box. */
  collide(
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    yaw: number, surface: Surface,
  ): void {
    this.tmpQ.setFromAxisAngle(UP, yaw)
    this.tmpM.compose(this.tmpP.set(x, y, z), this.tmpQ, this.tmpS.set(1, 1, 1))
    this.tmpM.premultiply(this.cur)
    const c = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    this.tmpM.decompose(c, q, s)
    this.colliders.push({
      c,
      h: new THREE.Vector3(Math.abs(w * s.x) / 2, Math.abs(h * s.y) / 2, Math.abs(d * s.z) / 2),
      q,
      s: surface,
    })
  }

  /** Collider with an arbitrary local rotation — ramps, stair flights, lean-tos. */
  collideLocal(w: number, h: number, d: number, local: THREE.Matrix4, surface: Surface): void {
    this.tmpM2.copy(this.cur).multiply(local)
    const c = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    this.tmpM2.decompose(c, q, s)
    this.colliders.push({
      c,
      h: new THREE.Vector3(Math.abs(w * s.x) / 2, Math.abs(h * s.y) / 2, Math.abs(d * s.z) / 2),
      q,
      s: surface,
    })
  }

  get colliderCount(): number {
    return this.colliders.length
  }

  get isEmpty(): boolean {
    return this.groups.size === 0
  }

  /** Merges to one mesh per material, parents them, and registers collision. */
  merge(
    parent: THREE.Object3D,
    mats: MaterialService,
    physics: StaticPhysics | null,
    opts: MergeOptions = {},
  ): THREE.Mesh[] {
    if (this.stack.length > 0) {
      // An unbalanced push silently offsets everything authored after it, and
      // the symptom (geometry drifting hundreds of metres) is hard to trace.
      console.warn(`[level] ${opts.name ?? 'builder'} left ${this.stack.length} unmatched push()`)
      this.stack.length = 0
      this.cur.identity()
    }
    const cast = opts.cast ?? true
    const receive = opts.receive ?? true
    const noCast = new Set<string>(opts.noCast ? [...opts.noCast] : [])
    const out: THREE.Mesh[] = []
    for (const [name, list] of this.groups) {
      if (list.length === 0) continue
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false)
      if (!merged) continue
      merged.computeBoundingSphere()
      merged.computeBoundingBox()
      const mesh = new THREE.Mesh(merged, mats.get(name))
      mesh.name = `${opts.name ?? 'kit'}:${name}`
      mesh.castShadow = cast && !NO_CAST.has(name) && !noCast.has(name)
      mesh.receiveShadow = receive
      mesh.matrixAutoUpdate = false
      mesh.userData.surface = surfaceOf(name)
      parent.add(mesh)
      out.push(mesh)
      if (list.length > 1) for (const g of list) g.dispose()
    }
    this.groups.clear()
    if (physics) {
      for (const col of this.colliders) physics.addStaticBox(col.c, col.h, col.q, col.s)
    }
    this.colliders.length = 0
    return out
  }
}

// ---------------------------------------------------------------------------
// Instanced props
// ---------------------------------------------------------------------------

interface InstanceKind {
  geom: THREE.BufferGeometry
  mat: MaterialName
  cast: boolean
  receive: boolean
  matrices: THREE.Matrix4[]
}

/**
 * One InstancedMesh per prop kind. Prop density is what sells an environment,
 * and instancing is the only way to get hundreds of them without a draw-call
 * blowout.
 */
export class InstanceFarm {
  private kinds = new Map<string, InstanceKind>()
  private variants = new Map<string, string[]>()

  define(key: string, geom: THREE.BufferGeometry, mat: MaterialName, cast = true, receive = true): void {
    if (this.kinds.has(key)) return
    this.kinds.set(key, { geom: normalizeGeom(geom), mat, cast, receive, matrices: [] })
  }

  /**
   * Registers several interchangeable geometries under one logical key. Every
   * `place` on that key deterministically picks a variant from the instance's
   * world position, so a row of crates never repeats grain, proportion or wear
   * while call sites stay unaware that variants exist.
   */
  defineVariants(key: string, geoms: THREE.BufferGeometry[], mat: MaterialName, cast = true, receive = true): void {
    if (this.variants.has(key)) return
    const keys: string[] = []
    for (let i = 0; i < geoms.length; i++) {
      const sub = `${key}#${i}`
      this.define(sub, geoms[i], mat, cast, receive)
      keys.push(sub)
    }
    this.variants.set(key, keys)
  }

  has(key: string): boolean {
    return this.kinds.has(key) || this.variants.has(key)
  }

  add(key: string, m: THREE.Matrix4): void {
    const vs = this.variants.get(key)
    if (vs) {
      const e = m.elements
      const h = hash2(e[12] * 1.37 + e[13] * 0.61, e[14] * 1.13 - e[12] * 0.29)
      key = vs[Math.min(vs.length - 1, Math.floor(h * vs.length))]
    }
    const k = this.kinds.get(key)
    if (k) k.matrices.push(m.clone())
  }

  /** Convenience placement: position, yaw, uniform-ish scale, optional tilt. */
  place(key: string, x: number, y: number, z: number, yaw = 0, scale = 1, tiltX = 0, tiltZ = 0): void {
    const e = new THREE.Euler(tiltX, yaw, tiltZ, 'YXZ')
    _q.setFromEuler(e)
    _m.compose(_p.set(x, y, z), _q, _s.set(scale, scale, scale))
    this.add(key, _m)
  }

  placeScaled(key: string, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tiltX = 0, tiltZ = 0): void {
    const e = new THREE.Euler(tiltX, yaw, tiltZ, 'YXZ')
    _q.setFromEuler(e)
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz))
    this.add(key, _m)
  }

  get instanceCount(): number {
    let n = 0
    for (const k of this.kinds.values()) n += k.matrices.length
    return n
  }

  build(parent: THREE.Object3D, mats: MaterialService, namePrefix = 'inst'): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = []
    for (const [key, k] of this.kinds) {
      if (k.matrices.length === 0) continue
      const im = new THREE.InstancedMesh(k.geom, mats.get(k.mat), k.matrices.length)
      for (let i = 0; i < k.matrices.length; i++) im.setMatrixAt(i, k.matrices[i])
      im.instanceMatrix.needsUpdate = true
      im.castShadow = k.cast && !NO_CAST.has(k.mat)
      im.receiveShadow = k.receive
      im.name = `${namePrefix}:${key}`
      im.userData.surface = surfaceOf(k.mat)
      im.computeBoundingSphere()
      im.frustumCulled = true
      parent.add(im)
      out.push(im)
    }
    return out
  }
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Deterministic value hash in [0,1) — used for terrain and scatter noise. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(Math.round(x * 8192) ^ 0x1f123bb5, 0x27d4eb2d)
  h = Math.imul(h ^ (Math.round(y * 8192) + 0x9e3779b9), 0x85ebca6b)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smooth 2D value noise in [-1, 1]. */
export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  const top = a + (b - a) * u
  const bot = c + (d - c) * u
  return (top + (bot - top) * v) * 2 - 1
}

/** Signed distance from a point to an axis-aligned rectangle, negative inside. */
export function rectSdf(px: number, pz: number, cx: number, cz: number, hw: number, hd: number): number {
  const dx = Math.abs(px - cx) - hw
  const dz = Math.abs(pz - cz) - hd
  const ox = Math.max(dx, 0)
  const oz = Math.max(dz, 0)
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(dx, dz), 0)
}

/**
 * World offset expressed in the local frame of a `yaw`-rotated object, using
 * the same convention as `THREE.Object3D.rotation.y`: local +X maps to world
 * `(cos yaw, -sin yaw)`.
 */
export function toLocalXZ(px: number, pz: number, cx: number, cz: number, yaw: number, out: THREE.Vector2): THREE.Vector2 {
  const dx = px - cx
  const dz = pz - cz
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  return out.set(dx * c - dz * s, dx * s + dz * c)
}

const _l2 = new THREE.Vector2()

/** As `rectSdf` but for a rectangle rotated about Y by `yaw`. */
export function rotRectSdf(
  px: number, pz: number,
  cx: number, cz: number,
  hw: number, hd: number,
  yaw: number,
): number {
  if (yaw === 0) return rectSdf(px, pz, cx, cz, hw, hd)
  toLocalXZ(px, pz, cx, cz, yaw, _l2)
  return rectSdf(_l2.x, _l2.y, 0, 0, hw, hd)
}
