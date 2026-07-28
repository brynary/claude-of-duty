import * as THREE from 'three'
import type { MaterialName } from '../render/MaterialNames'
import type { Rand } from '../core/Rand'
import type { Surface } from '../core/Types'
import {
  Builder, CHAMFER, DOOR_H, DOOR_W, PARAPET_H, SILL_H, SLAB_T, STOREY, WALL_T, WINDOW_H,
  chamferBox, cylinderGeom, decalQuad, impactChip, plainBox, sphereGeom, rotRectSdf,
} from './Kit'
import { groundHeight } from './Terrain'

/**
 * The modular architecture kit and the district's building list.
 *
 * Walls are authored as panels with real openings cut through a 0.34 m
 * thickness, so every window and doorway has genuine reveal depth rather than
 * a painted-on rectangle. Everything is chamfered, trimmed and stained.
 */

export type Side = 'n' | 'e' | 's' | 'w'

export type GroundStyle = 'blank' | 'windows' | 'shop' | 'door' | 'shopdoor' | 'arch' | 'garage' | 'ruin'
export type UpperStyle = 'blank' | 'windows' | 'balcony' | 'loggia'

export interface FacadeSpec {
  ground: GroundStyle
  upper: UpperStyle
  /** Bay spacing in metres; window rhythm derives from it. */
  bay?: number
}

/** Interior dividing wall, in the building's local frame. */
export interface PartitionSpec {
  axis: 'x' | 'z'
  /** Offset along the axis perpendicular to the wall. */
  at: number
  from: number
  to: number
  storey: number
  openings?: Opening[]
  mat?: MaterialName
}

export interface BuildingSpec {
  id: string
  cx: number
  cz: number
  w: number
  d: number
  yaw?: number
  storeys: number
  storeyH?: number
  wall: MaterialName
  trim?: MaterialName
  roof?: MaterialName
  parapet?: number
  faces: Partial<Record<Side, FacadeSpec>>
  /** Player-accessible interior: floors, partitions, stairs to the roof. */
  enterable?: boolean
  partitions?: PartitionSpec[]
  /** 0..1 — pockmarks, cracked render, missing parapet sections. */
  damage?: number
  roofClutter?: number
  /** Ground-floor slab sits this far above the plinth top. */
  interiorFloor?: boolean
}

// ---------------------------------------------------------------------------
// Wall panels
// ---------------------------------------------------------------------------

export interface Opening {
  /** Centre distance along the wall from its start. */
  at: number
  width: number
  /** Bottom of the opening above the wall base. */
  sill: number
  height: number
  kind: 'door' | 'window' | 'arch' | 'hole' | 'shop'
  glass?: boolean
  shutters?: boolean
  bars?: boolean
  broken?: boolean
}

export interface WallSpec {
  length: number
  height: number
  thickness: number
  mat: MaterialName
  trim: MaterialName
  openings: Opening[]
  exterior: boolean
  /** Projecting base course height, 0 for none. */
  plinth?: number
  cornice?: boolean
  /** 0..1 — staining, soot and bullet damage. */
  weather?: number
  surface?: Surface
  rng: Rand
  /** Skips collider generation (used for decorative infill). */
  noCollide?: boolean
}

function xform(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1))
}

/**
 * Emits a wall running along +X from 0..length with its exterior face at
 * z = -thickness/2, cut by `openings` and dressed with sills, lintels, jambs,
 * glazing, shutters and weathering.
 */
export function buildWall(b: Builder, s: WallSpec): void {
  const T = s.thickness
  const H = s.height
  const L = s.length
  const rng = s.rng
  const out = -T / 2
  const solid = (x0: number, x1: number, y0: number, y1: number) => {
    const w = x1 - x0
    const h = y1 - y0
    if (w < 0.008 || h < 0.008) return
    if (s.noCollide) b.box(s.mat, w, h, T, (x0 + x1) / 2, (y0 + y1) / 2, 0, 0, CHAMFER)
    else b.solid(s.mat, w, h, T, (x0 + x1) / 2, (y0 + y1) / 2, 0, 0, CHAMFER, s.surface)
  }

  const list = [...s.openings].sort((a, c) => a.at - c.at)
  let cursor = 0
  for (const o of list) {
    const x0 = o.at - o.width / 2
    const x1 = o.at + o.width / 2
    solid(cursor, Math.max(cursor, x0), 0, H)
    cursor = Math.max(cursor, x1)
    const isArch = o.kind === 'arch'
    const top = o.sill + o.height
    const spring = isArch ? top - o.width / 2 : top
    if (o.sill > 0.01) solid(x0, x1, 0, o.sill)
    if (top < H - 0.01) solid(x0, x1, top, H)
    if (isArch) {
      // Spandrel infill stepped to the arc, plus voussoirs on the outer face.
      const r = o.width / 2
      const steps = 7
      for (let i = 0; i < steps; i++) {
        const t1 = (i + 1) / steps
        const y0 = spring + r * (i / steps)
        const y1 = spring + r * t1
        const open = r * Math.sqrt(Math.max(0, 1 - t1 * t1))
        const fill = r - open
        if (fill < 0.01) continue
        solid(o.at - r, o.at - open, y0, y1)
        solid(o.at + open, o.at + r, y0, y1)
      }
      const vous = 9
      for (let i = 0; i < vous; i++) {
        const a = Math.PI * ((i + 0.5) / vous)
        const rr = r + 0.09
        b.geom(s.trim, plainBox(0.2, 0.28, 0.09),
          xform(o.at + Math.cos(a) * rr, spring + Math.sin(a) * rr, out - 0.035, 0, 0, a - Math.PI / 2))
      }
    }

    // --- trim ---------------------------------------------------------
    if (s.exterior && (o.kind === 'window' || o.kind === 'shop')) {
      b.box(s.trim, o.width + 0.34, 0.09, T + 0.2, o.at, o.sill - 0.045, -0.02, 0, 0.02)
      b.box(s.trim, o.width + 0.4, 0.17, T + 0.12, o.at, top + 0.085, 0, 0, 0.03)
    }
    if (s.exterior && (o.kind === 'door' || o.kind === 'shop')) {
      // Threshold stone, worn hollow by traffic.
      b.box('stoneBlock', o.width + 0.24, 0.1, 0.5, o.at, o.sill + 0.02, out - 0.12, 0, 0.03)
    }
    if (o.kind === 'door') {
      const jamb = 0.1
      b.plate(s.trim, jamb, o.height + 0.16, 0.14, o.at - o.width / 2 - jamb / 2 + 0.02, o.sill + o.height / 2, out + 0.09)
      b.plate(s.trim, jamb, o.height + 0.16, 0.14, o.at + o.width / 2 + jamb / 2 - 0.02, o.sill + o.height / 2, out + 0.09)
      b.plate(s.trim, o.width + 0.24, 0.12, 0.14, o.at, o.sill + o.height + 0.06, out + 0.09)
      if (rng.bool(0.55)) {
        // A door, hanging open at an angle.
        const swing = rng.range(0.5, 1.35) * (rng.bool() ? 1 : -1)
        const hinge = o.at - (swing > 0 ? o.width / 2 : -o.width / 2)
        const hw = o.width * 0.94
        const m = xform(hinge, o.sill + o.height / 2, out + 0.1, -swing)
        m.multiply(new THREE.Matrix4().makeTranslation((swing > 0 ? 1 : -1) * hw / 2, 0, 0))
        b.geom('woodPainted', chamferBox(hw, o.height - 0.05, 0.055, 0.012), m)
      }
    }

    // --- glazing ------------------------------------------------------
    if (o.glass !== false && (o.kind === 'window' || o.kind === 'shop')) {
      const inset = out + 0.15
      const gw = o.width - 0.1
      const gh = o.height - 0.1
      const broken = o.broken ?? rng.bool(0.22)
      if (!broken) {
        b.plate('glassDirty', gw, gh, 0.02, o.at, o.sill + o.height / 2, inset)
      } else {
        // Shards clinging to the frame.
        const shards = rng.int(2, 4)
        for (let i = 0; i < shards; i++) {
          const sw = gw * rng.range(0.18, 0.4)
          const sh = gh * rng.range(0.2, 0.45)
          b.geom('glass', plainBox(sw, sh, 0.016),
            xform(o.at + rng.spread(gw / 2 - sw / 2), o.sill + o.height - sh / 2 - rng.range(0, gh * 0.3), inset, 0, 0, rng.spread(0.12)))
        }
      }
      // Frame and mullions.
      const fm: MaterialName = rng.bool(0.6) ? 'woodPainted' : 'metalPainted'
      b.plate(fm, o.width - 0.06, 0.07, 0.07, o.at, o.sill + 0.06, inset)
      b.plate(fm, o.width - 0.06, 0.07, 0.07, o.at, o.sill + o.height - 0.06, inset)
      b.plate(fm, 0.07, o.height - 0.06, 0.07, o.at - o.width / 2 + 0.06, o.sill + o.height / 2, inset)
      b.plate(fm, 0.07, o.height - 0.06, 0.07, o.at + o.width / 2 - 0.06, o.sill + o.height / 2, inset)
      b.plate(fm, 0.05, o.height - 0.1, 0.05, o.at, o.sill + o.height / 2, inset)
      if (o.height > 1.1) b.plate(fm, o.width - 0.1, 0.05, 0.05, o.at, o.sill + o.height * 0.55, inset)
      if (o.bars) {
        for (let i = 0; i < 4; i++) {
          b.geom('rebar', cylinderGeom(0.016, 0.016, o.height - 0.08, 4),
            xform(o.at - o.width / 2 + (o.width * (i + 0.5)) / 4, o.sill + o.height / 2, out + 0.05))
        }
      }
    }
    if (o.shutters && s.exterior) {
      const sw = o.width / 2 - 0.02
      for (const side of [-1, 1]) {
        const open = rng.range(0.15, 1.4)
        const hinge = o.at + side * (o.width / 2 + 0.02)
        const m = xform(hinge, o.sill + o.height / 2, out - 0.06, side * open)
        m.multiply(new THREE.Matrix4().makeTranslation(-side * sw / 2, 0, 0))
        b.geom('woodPainted', chamferBox(sw, o.height - 0.04, 0.04, 0.01), m)
        // Louvre battens read as slats at grazing angles.
        for (let i = 0; i < 3; i++) {
          const mm = m.clone().multiply(new THREE.Matrix4().makeTranslation(0, -o.height / 2 + 0.25 + i * (o.height - 0.5) / 2, -0.032))
          b.geom('woodPainted', plainBox(sw - 0.05, 0.06, 0.03), mm)
        }
      }
    }

    // --- weathering ---------------------------------------------------
    const wet = s.weather ?? 0.6
    if (s.exterior && wet > 0 && o.kind !== 'shop') {
      if (rng.bool(0.85 * wet)) {
        const sh = rng.range(0.7, 1.7)
        b.geom('dirt', decalQuad(o.width * rng.range(0.5, 0.95), sh, 0.22, o.at * 7 + o.sill),
          xform(o.at + rng.spread(0.2), o.sill - 0.1 - sh / 2, out - 0.014))
      }
      if (rng.bool(0.5 * wet)) {
        const sh = rng.range(0.5, 1.1)
        b.geom('plasterDamaged', decalQuad(o.width * rng.range(0.7, 1.2), sh, 0.3, o.at * 3 + 5),
          xform(o.at + rng.spread(0.25), top + 0.25 + sh / 2, out - 0.013))
      }
    }
  }
  solid(cursor, L, 0, H)

  if (s.plinth && s.plinth > 0) {
    b.box(s.trim, L, s.plinth, T + 0.14, L / 2, s.plinth / 2, 0, 0, 0.03)
  }
  if (s.cornice) {
    b.box(s.trim, L + 0.06, 0.16, T + 0.3, L / 2, H - 0.08, 0, 0, 0.035)
    b.box(s.trim, L + 0.06, 0.09, T + 0.16, L / 2, H - 0.24, 0, 0, 0.02)
  }

  // Bullet pocks, chipped render and cracks across the open field of the wall.
  const wet = s.weather ?? 0.6
  if (s.exterior && wet > 0) {
    const pocks = Math.round(L * H * 0.4 * wet)
    for (let i = 0; i < pocks; i++) {
      const px = rng.range(0.3, L - 0.3)
      const py = rng.range(0.25, Math.min(H - 0.3, 3.4))
      let clear = true
      for (const o of list) {
        if (px > o.at - o.width / 2 - 0.15 && px < o.at + o.width / 2 + 0.15 && py > o.sill - 0.15 && py < o.sill + o.height + 0.15) clear = false
      }
      if (!clear) continue
      b.geom('concreteRubble', impactChip(rng.range(0.035, 0.11), rng.range(0.02, 0.055), 6),
        xform(px, py, out + 0.004, Math.PI))
    }
    const patches = Math.round(L * H * 0.1 * wet)
    for (let i = 0; i < patches; i++) {
      b.geom('plasterDamaged', decalQuad(rng.range(0.5, 1.8), rng.range(0.4, 1.4), 0.3, i * 3.7 + L),
        xform(rng.range(0.4, L - 0.4), rng.range(0.3, H - 0.4), out - 0.012))
    }
    // Damp rising from the base — always present on a render wall in a dusty town.
    b.geom('dirt', decalQuad(L * 0.92, 0.75, 0.16, L * 1.7),
      xform(L / 2, 0.36, out - 0.011))
  }
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

/**
 * A straight flight climbing toward local -Z. Visual steps plus one inclined
 * box collider so the character controller gets a smooth ramp instead of
 * stuttering up eight separate ledges.
 */
export function buildStairFlight(
  b: Builder,
  x: number, y: number, z: number, yaw: number,
  width: number, steps: number, rise: number, run: number,
  mat: MaterialName = 'concreteWorn',
  stringer = true,
): void {
  b.push(x, y, z, yaw)
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise
    b.box(mat, width, top, run, 0, top / 2, -(i + 0.5) * run, 0, 0.018)
  }
  const theta = Math.atan2(rise, run)
  const len = steps * Math.hypot(run, rise)
  const m = new THREE.Matrix4()
    .makeTranslation(0, steps * rise * 0.5 + rise * 0.5, -steps * run * 0.5)
    .multiply(new THREE.Matrix4().makeRotationX(theta))
    .multiply(new THREE.Matrix4().makeTranslation(0, -0.3, 0))
  b.collideLocal(width, 0.6, len, m, 'concrete')
  if (stringer) {
    for (let i = 0; i < steps; i++) {
      const top = (i + 1) * rise
      b.plate(mat, 0.12, top + 0.55, run, width / 2 + 0.06, (top + 0.55) / 2, -(i + 0.5) * run)
    }
  }
  b.pop()
}

// ---------------------------------------------------------------------------
// Facade rhythm
// ---------------------------------------------------------------------------

function bayPositions(length: number, bay: number, inset = 1.0): number[] {
  const usable = length - inset * 2
  if (usable <= 0.6) return [length / 2]
  const n = Math.max(1, Math.round(usable / bay))
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(inset + ((i + 0.5) * usable) / n)
  return out
}

function groundOpenings(style: GroundStyle, length: number, bay: number, rng: Rand): Opening[] {
  switch (style) {
    case 'blank':
      return []
    case 'door': {
      const at = length * rng.range(0.32, 0.68)
      return [{ at, width: DOOR_W, sill: 0, height: DOOR_H, kind: 'door' }]
    }
    case 'windows':
      return bayPositions(length, bay).map((at) => ({
        at, width: rng.range(0.95, 1.25), sill: SILL_H + rng.spread(0.06), height: WINDOW_H,
        kind: 'window' as const, shutters: rng.bool(0.55), bars: rng.bool(0.3),
      }))
    case 'shop': {
      const at = length / 2 + rng.spread(length * 0.12)
      return [{ at, width: Math.min(3.2, length - 1.6), sill: 0.32, height: 2.35, kind: 'shop', glass: false }]
    }
    case 'shopdoor': {
      const shopAt = length * 0.36
      const doorAt = length * 0.74
      return [
        { at: shopAt, width: Math.min(2.7, length * 0.42), sill: 0.3, height: 2.3, kind: 'shop', glass: false },
        { at: doorAt, width: DOOR_W, sill: 0, height: DOOR_H, kind: 'door' },
      ]
    }
    case 'arch': {
      const positions = bayPositions(length, Math.max(bay, 3.0), 0.9)
      return positions.map((at) => ({ at, width: 1.9, sill: 0, height: 3.0, kind: 'arch' as const }))
    }
    case 'garage':
      return [{ at: length / 2, width: Math.min(3.4, length - 1.0), sill: 0, height: 2.6, kind: 'hole' }]
    case 'ruin': {
      const out: Opening[] = []
      for (const at of bayPositions(length, bay)) {
        out.push({ at, width: rng.range(1.1, 1.9), sill: rng.range(0.4, 1.0), height: rng.range(1.5, 2.2), kind: 'hole' })
      }
      return out
    }
    default:
      return []
  }
}

function upperOpenings(style: UpperStyle, length: number, bay: number, rng: Rand): Opening[] {
  if (style === 'blank') return []
  if (style === 'loggia') {
    return bayPositions(length, Math.max(bay, 2.6), 0.8).map((at) => ({
      at, width: 1.7, sill: 0.95, height: 2.05, kind: 'arch' as const, glass: false,
    }))
  }
  return bayPositions(length, bay).map((at) => ({
    at, width: rng.range(0.95, 1.3), sill: 0.82 + rng.spread(0.05), height: WINDOW_H,
    kind: 'window' as const, shutters: rng.bool(0.62), broken: rng.bool(0.2),
  }))
}

// ---------------------------------------------------------------------------
// Building assembly
// ---------------------------------------------------------------------------

const SIDES: Side[] = ['n', 'e', 's', 'w']

interface SidePlacement {
  x: number
  z: number
  yaw: number
  length: number
}

function sidePlacement(side: Side, w: number, d: number, t: number): SidePlacement {
  switch (side) {
    case 'n': return { x: -w / 2, z: -d / 2 + t / 2, yaw: 0, length: w }
    case 'e': return { x: w / 2 - t / 2, z: -d / 2, yaw: -Math.PI / 2, length: d }
    case 's': return { x: w / 2, z: d / 2 - t / 2, yaw: Math.PI, length: w }
    default: return { x: -w / 2 + t / 2, z: d / 2, yaw: Math.PI / 2, length: d }
  }
}

/** Highest terrain sample under the footprint, so nothing floats or sinks. */
export function footprintBase(cx: number, cz: number, w: number, d: number): number {
  let h = -Infinity
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      h = Math.max(h, groundHeight(cx + (i * w) / 2, cz + (j * d) / 2))
    }
  }
  return h + 0.04
}

interface Stairwell { w: number; d: number; x: number; z: number }

/** A floor slab in four pieces, leaving a void for the stair to climb through. */
function slabWithWell(b: Builder, mat: MaterialName, w: number, d: number, T: number, y: number, sw: Stairwell): void {
  const ix = w / 2 - T * 0.8
  const iz = d / 2 - T * 0.8
  const x0 = sw.x - sw.w / 2
  const x1 = sw.x + sw.w / 2
  const z0 = sw.z - sw.d / 2
  const z1 = sw.z + sw.d / 2
  const slab = (ax0: number, ax1: number, az0: number, az1: number) => {
    if (ax1 - ax0 < 0.05 || az1 - az0 < 0.05) return
    b.solid(mat, ax1 - ax0, SLAB_T, az1 - az0, (ax0 + ax1) / 2, y - SLAB_T / 2, (az0 + az1) / 2, 0, 0.02, 'concrete')
  }
  slab(-ix, x0, -iz, iz)
  slab(x1, ix, -iz, iz)
  slab(x0, x1, -iz, z0)
  slab(x0, x1, z1, iz)
}

export interface BuildResult {
  /** Roofed volumes, in world space, for `isIndoors`. */
  indoor: THREE.Box3[]
  /** Flat rooftop decks the player and props can stand on. */
  decks: { cx: number; cz: number; w: number; d: number; y: number; yaw: number }[]
}

/**
 * Assembles a rectangular building from the kit: plinth, four dressed facades
 * per storey, floor slabs, roof slab, parapet with coping, and either an
 * inhabited interior or a light-blocking inner shell.
 */
export function buildBuilding(b: Builder, spec: BuildingSpec, rng: Rand, result: BuildResult): number {
  const w = spec.w
  const d = spec.d
  const yaw = spec.yaw ?? 0
  const sh = spec.storeyH ?? STOREY
  const base = footprintBase(spec.cx, spec.cz, w, d)
  const trim = spec.trim ?? 'stoneBlock'
  const roofMat = spec.roof ?? 'concreteWorn'
  const parapet = spec.parapet ?? PARAPET_H
  const damage = spec.damage ?? 0.5
  const T = WALL_T

  b.push(spec.cx, base, spec.cz, yaw)

  // Foundation plinth — buries the footprint into the undulating ground.
  b.solid(trim, w + 0.22, 1.5, d + 0.22, 0, -0.72, 0, 0, 0.05, 'concrete')

  // Stairwell reserved against the east wall, running north to south.
  const sw = {
    w: 1.55,
    d: Math.min(5.1, d - 2.2),
    x: w / 2 - T - 0.95,
    z: -d / 2 + T + Math.min(5.1, d - 2.2) / 2 + 0.35,
  }

  for (let s = 0; s < spec.storeys; s++) {
    const y0 = s * sh
    for (const side of SIDES) {
      const face = spec.faces[side]
      if (!face) continue
      const p = sidePlacement(side, w, d, T)
      const bay = face.bay ?? 2.9
      const openings = s === 0
        ? groundOpenings(face.ground, p.length, bay, rng)
        : upperOpenings(face.upper, p.length, bay, rng)
      b.push(p.x, y0, p.z, p.yaw)
      buildWall(b, {
        length: p.length,
        height: sh,
        thickness: T,
        mat: spec.wall,
        trim,
        openings,
        exterior: true,
        plinth: s === 0 ? 0.42 : 0,
        cornice: s === spec.storeys - 1,
        weather: damage,
        rng,
      })
      // Balcony slab on upper storeys that call for one.
      if (s > 0 && face.upper === 'balcony' && openings.length > 0) {
        const o = openings[Math.floor(openings.length / 2)]
        b.solid(trim, Math.min(p.length - 0.6, o.width + 2.0), 0.14, 1.15, o.at, 0.07, -T / 2 - 0.575, 0, 0.03)
        const bw = Math.min(p.length - 0.6, o.width + 2.0)
        for (let i = 0; i <= 6; i++) {
          b.plate('metalRusted', 0.035, 0.95, 0.035, o.at - bw / 2 + (bw * i) / 6, 0.62, -T / 2 - 1.1)
        }
        b.plate('metalRusted', bw, 0.05, 0.05, o.at, 1.11, -T / 2 - 1.1)
        b.plate('metalRusted', bw, 0.04, 0.04, o.at, 0.62, -T / 2 - 1.1)
        b.plate('metalRusted', 0.04, 0.95, 1.1, o.at - bw / 2, 0.62, -T / 2 - 0.58)
        b.plate('metalRusted', 0.04, 0.95, 1.1, o.at + bw / 2, 0.62, -T / 2 - 0.58)
      }
      b.pop()
    }
    // Floor slab between storeys, with a stairwell void when enterable.
    if (s > 0) {
      if (spec.enterable) slabWithWell(b, roofMat, w, d, T, y0, sw)
      else b.solid(roofMat, w - T * 1.6, SLAB_T, d - T * 1.6, 0, y0 - SLAB_T / 2, 0, 0, 0.02, 'concrete')
      buildStairFlight(b, sw.x, (s - 1) * sh, sw.z - sw.d / 2 + 0.18, Math.PI, sw.w - 0.2, 18, sh / 18, 0.26, 'concreteWorn', true)
    }
  }

  // Interior partitions.
  for (const p of spec.partitions ?? []) {
    const y0 = p.storey * sh
    const len = p.to - p.from
    if (p.axis === 'x') b.push(p.from, y0, p.at, 0)
    else b.push(p.at, y0, p.from, -Math.PI / 2)
    buildWall(b, {
      length: len, height: sh - SLAB_T, thickness: 0.22, mat: p.mat ?? 'plasterWhite',
      trim: 'plasterDamaged', openings: p.openings ?? [], exterior: false, weather: 0, rng,
      surface: 'plaster',
    })
    b.pop()
  }

  const roofY = spec.storeys * sh
  // Roof slab and parapet.
  if (spec.enterable) {
    slabWithWell(b, roofMat, w, d, T, roofY, sw)
    buildStairFlight(b, sw.x, (spec.storeys - 1) * sh, sw.z - sw.d / 2 + 0.18, Math.PI, sw.w - 0.2, 18, sh / 18, 0.26, 'concreteWorn', true)
    // Bulkhead hut over the stair head, with a doorway onto the deck.
    b.push(sw.x, roofY, sw.z, 0)
    const bw = sw.w + 0.7
    const bd = sw.d * 0.55
    b.solid(spec.wall, bw, 2.35, 0.24, 0, 1.18, -bd / 2, 0, 0.03)
    b.solid(spec.wall, 0.24, 2.35, bd, -bw / 2, 1.18, 0, 0, 0.03)
    b.solid(spec.wall, 0.24, 2.35, bd, bw / 2, 1.18, 0, 0, 0.03)
    b.solid(roofMat, bw + 0.3, 0.18, bd + 0.3, 0, 2.44, 0, 0, 0.03, 'concrete')
    b.pop()
  } else {
    b.solid(roofMat, w - T * 0.2, SLAB_T, d - T * 0.2, 0, roofY - SLAB_T / 2, 0, 0, 0.03, 'concrete')
  }
  if (parapet > 0) {
    const pt = 0.24
    const gaps = damage > 0.6
    for (const side of SIDES) {
      const p = sidePlacement(side, w, d, pt)
      b.push(p.x, roofY, p.z, p.yaw)
      if (gaps && rng.bool(0.4)) {
        // A blown-out section of parapet, with the rest still standing.
        const cut = rng.range(0.25, 0.55)
        const cutAt = rng.range(0.2, 0.8)
        const a = p.length * (cutAt - cut / 2)
        const c = p.length * (cutAt + cut / 2)
        if (a > 0.3) b.solid(spec.wall, a, parapet, pt, a / 2, parapet / 2, 0, 0, 0.03)
        if (c < p.length - 0.3) b.solid(spec.wall, p.length - c, parapet * rng.range(0.5, 0.9), pt, (p.length + c) / 2, (parapet * 0.7) / 2, 0, 0, 0.03)
        b.solid(spec.wall, c - a, parapet * rng.range(0.2, 0.45), pt, (a + c) / 2, parapet * 0.16, 0, 0, 0.03)
      } else {
        b.solid(spec.wall, p.length, parapet, pt, p.length / 2, parapet / 2, 0, 0, 0.03)
        b.box(trim, p.length, 0.09, pt + 0.16, p.length / 2, parapet + 0.045, 0, 0, 0.03)
      }
      b.pop()
    }
    result.decks.push({ cx: spec.cx, cz: spec.cz, w: w - 1.2, d: d - 1.2, y: base + roofY, yaw })
  }

  // Drainpipe down one corner, with brackets.
  {
    const cx = (rng.bool() ? 1 : -1) * (w / 2 - 0.22)
    const cz = (rng.bool() ? 1 : -1) * (d / 2 + 0.1)
    const total = roofY
    b.geom('metalRusted', cylinderGeom(0.055, 0.055, total, 8), xform(cx, total / 2, cz))
    for (let i = 0; i < Math.floor(total / 1.4); i++) {
      b.plate('metalRusted', 0.14, 0.05, 0.16, cx, 0.7 + i * 1.4, cz - Math.sign(cz) * 0.08)
    }
    b.geom('metalRusted', cylinderGeom(0.075, 0.075, 0.3, 8), xform(cx, total + 0.1, cz))
    // Splash stain where it discharges.
    b.geom('dirt', decalQuad(0.8, 0.9, 0.25, 17), xform(cx, 0.45, cz - Math.sign(cz) * 0.06))
  }

  // Surface-run conduit, a junction box and a meter — the clutter that makes a
  // wall look inhabited rather than extruded.
  {
    const p = sidePlacement(rng.pick(SIDES), w, d, T)
    b.push(p.x, 0, p.z, p.yaw)
    const runX = rng.range(1.0, Math.max(1.2, p.length - 1.0))
    const hgt = rng.range(2.1, 3.0)
    b.geom('metalPainted', cylinderGeom(0.028, 0.028, hgt, 6), xform(runX, hgt / 2, -T / 2 - 0.045))
    b.geom('metalPainted', cylinderGeom(0.028, 0.028, Math.min(2.2, p.length - runX - 0.4), 6),
      xform(runX + Math.min(2.2, p.length - runX - 0.4) / 2, hgt, -T / 2 - 0.045, 0, 0, Math.PI / 2))
    b.plate('metalPainted', 0.24, 0.3, 0.13, runX, 1.55, -T / 2 - 0.075)
    b.pop()
  }

  if (!spec.enterable) {
    // Light-tight inner shell: peering through a window shows a dark room, and
    // the sun cannot leak through the building.
    b.box('concrete', Math.max(0.4, w - 3.0), roofY - 0.4, Math.max(0.4, d - 3.0), 0, roofY / 2 - 0.2, 0, 0, 0.05)
    if (spec.interiorFloor !== false) {
      b.solid(roofMat, w - T * 1.6, 0.3, d - T * 1.6, 0, -0.15, 0, 0, 0.02, 'concrete')
    }
  } else {
    b.solid('tileFloor', w - T * 1.6, 0.3, d - T * 1.6, 0, -0.15, 0, 0, 0.02, 'tile')
    const box = new THREE.Box3()
    const half = new THREE.Vector3(w / 2, 0, d / 2)
    const c = new THREE.Vector3(spec.cx, base + roofY / 2, spec.cz)
    box.setFromCenterAndSize(c, new THREE.Vector3(Math.abs(half.x * 2) - 0.6, roofY, Math.abs(half.z * 2) - 0.6))
    result.indoor.push(box)
  }

  b.pop()
  return base
}

// ---------------------------------------------------------------------------
// The district
// ---------------------------------------------------------------------------

const F = (ground: GroundStyle, upper: UpperStyle, bay?: number): FacadeSpec => ({ ground, upper, bay })

/**
 * Hand-composed layout. Two flanking routes (a wide market street west, a
 * narrow alley east) run south from a raised market square; a demolished block
 * and the road out of town close the south-east.
 */
export const BUILDINGS: BuildingSpec[] = [
  // --- Interior hero: the bakery on the plaza's south side -----------------
  {
    id: 'bakery', cx: -16.5, cz: 5.75, w: 14, d: 12.5, storeys: 2,
    wall: 'plasterOchre', trim: 'stoneBlock', damage: 0.45, enterable: true,
    faces: {
      n: F('shopdoor', 'balcony', 3.0),
      e: F('windows', 'windows', 2.7),
      s: F('door', 'windows', 3.0),
      w: F('windows', 'windows', 3.2),
    },
    // The cross wall the interior pose looks through: a blown-out opening at
    // eye height frames the sunlit far room.
    partitions: [
      {
        axis: 'z', at: 0, from: -6.25, to: 6.25, storey: 0, mat: 'plasterDamaged',
        openings: [
          { at: 8.5, width: 2.35, sill: 0, height: 2.55, kind: 'hole' },
          { at: 2.6, width: 0.95, sill: 0, height: DOOR_H, kind: 'door' },
        ],
      },
      { axis: 'x', at: -1.6, from: -6.9, to: 0, storey: 0, mat: 'plasterWhite', openings: [{ at: 3.4, width: 1.0, sill: 0, height: DOOR_H, kind: 'door' }] },
      { axis: 'z', at: 0.6, from: -6.25, to: 6.25, storey: 1, mat: 'plasterWhite', openings: [{ at: 7.4, width: 1.9, sill: 0, height: 2.4, kind: 'hole' }] },
    ],
  },
  // --- Market street, west side -------------------------------------------
  {
    id: 'apartment', cx: -15.75, cz: 25, w: 10.5, d: 14, storeys: 2,
    wall: 'plasterWhite', trim: 'concreteWorn', damage: 0.7, enterable: true,
    faces: {
      n: F('windows', 'windows', 3.0),
      e: F('shopdoor', 'balcony', 3.1),
      s: F('windows', 'windows', 3.0),
      w: F('blank', 'windows', 3.4),
    },
    partitions: [
      { axis: 'x', at: 0.5, from: -5.25, to: 1.2, storey: 0, openings: [{ at: 3.6, width: 1.0, sill: 0, height: DOOR_H, kind: 'door' }] },
      { axis: 'x', at: 1.5, from: -5.25, to: 1.0, storey: 1, openings: [{ at: 3.2, width: 1.0, sill: 0, height: DOOR_H, kind: 'door' }] },
    ],
  },
  {
    id: 'westrow', cx: -27.5, cz: 24, w: 10, d: 20, storeys: 2,
    wall: 'stuccoTan', trim: 'stoneBlock', damage: 0.6,
    faces: { n: F('windows', 'windows'), e: F('windows', 'windows', 3.4), s: F('door', 'windows'), w: F('blank', 'blank') },
  },
  {
    id: 'streetEnd', cx: -11, cz: 40.5, w: 15, d: 11, storeys: 2,
    wall: 'brickPainted', trim: 'concreteWorn', damage: 0.8,
    faces: { n: F('shopdoor', 'balcony', 3.2), e: F('windows', 'windows'), s: F('blank', 'windows'), w: F('blank', 'blank') },
  },
  // --- Between the two routes ---------------------------------------------
  {
    id: 'cornerShop', cx: 3.25, cz: 15.75, w: 3.5, d: 5.5, storeys: 1, storeyH: 3.4,
    wall: 'plasterDamaged', trim: 'concreteWorn', damage: 0.85, parapet: 0.95,
    faces: { n: F('door', 'blank'), e: F('windows', 'blank', 2.4), s: F('blank', 'blank'), w: F('shop', 'blank') },
  },
  {
    id: 'wedge', cx: 2.25, cz: 29.5, w: 5.5, d: 11, storeys: 2,
    wall: 'plasterOchre', trim: 'stoneBlock', damage: 0.7,
    faces: { n: F('windows', 'windows', 2.4), e: F('shopdoor', 'windows', 3.0), s: F('door', 'windows'), w: F('shop', 'balcony', 3.0) },
  },
  // --- Alley east side ------------------------------------------------------
  {
    id: 'eastblock', cx: 12.35, cz: 13.25, w: 6.3, d: 12.5, storeys: 2,
    wall: 'brickPainted', trim: 'concreteWorn', damage: 0.75, enterable: true,
    faces: { n: F('windows', 'windows', 2.8), e: F('door', 'windows', 3.0), s: F('windows', 'balcony'), w: F('shopdoor', 'loggia', 2.9) },
    partitions: [
      { axis: 'x', at: 2.6, from: -3.15, to: 3.15, storey: 0, mat: 'plasterDamaged', openings: [{ at: 2.2, width: 1.7, sill: 0, height: 2.4, kind: 'hole' }] },
      { axis: 'x', at: 3.0, from: -3.15, to: 3.15, storey: 1, openings: [{ at: 3.6, width: 1.0, sill: 0, height: DOOR_H, kind: 'door' }] },
    ],
  },
  // --- Plaza east row -------------------------------------------------------
  {
    id: 'plazaE1', cx: 10, cz: -8.5, w: 10, d: 9, storeys: 2,
    wall: 'stuccoTan', trim: 'stoneBlock', damage: 0.4,
    faces: { n: F('windows', 'windows'), e: F('blank', 'windows'), s: F('windows', 'balcony'), w: F('shopdoor', 'balcony', 3.0) },
  },
  {
    id: 'plazaE2', cx: 10, cz: -18.5, w: 10, d: 10, storeys: 3,
    wall: 'plasterWhite', trim: 'stoneBlock', damage: 0.35,
    faces: { n: F('windows', 'windows'), e: F('blank', 'windows'), s: F('windows', 'windows'), w: F('shop', 'balcony', 2.8) },
  },
  {
    id: 'plazaE3', cx: 11, cz: -28, w: 12, d: 8, storeys: 2,
    wall: 'brickRed', trim: 'concreteWorn', damage: 0.55,
    faces: { n: F('windows', 'windows'), e: F('blank', 'blank'), s: F('arch', 'windows', 3.2), w: F('windows', 'windows') },
  },
  // --- Plaza west row -------------------------------------------------------
  {
    id: 'plazaW1', cx: -29.5, cz: -8, w: 9, d: 12, storeys: 2,
    wall: 'plasterOchre', trim: 'stoneBlock', damage: 0.5,
    faces: { n: F('windows', 'windows'), e: F('shopdoor', 'balcony', 3.0), s: F('windows', 'windows'), w: F('blank', 'blank') },
  },
  {
    id: 'plazaW2', cx: -30.5, cz: -20, w: 11, d: 12, storeys: 3,
    wall: 'stuccoTan', trim: 'stoneBlock', damage: 0.45,
    faces: { n: F('windows', 'windows'), e: F('arch', 'loggia', 3.1), s: F('windows', 'windows'), w: F('blank', 'blank') },
  },
  // --- North of the plaza ---------------------------------------------------
  {
    id: 'civic', cx: 0, cz: -34.5, w: 16, d: 10, storeys: 2, storeyH: 3.6,
    wall: 'stoneBlock', trim: 'concreteWorn', damage: 0.3,
    faces: { n: F('blank', 'blank'), e: F('windows', 'windows'), s: F('arch', 'loggia', 3.4), w: F('windows', 'windows') },
  },
  {
    id: 'northrow', cx: -30, cz: -46, w: 20, d: 10, storeys: 2,
    wall: 'plasterWhite', trim: 'stoneBlock', damage: 0.4,
    faces: { n: F('blank', 'blank'), e: F('windows', 'windows'), s: F('windows', 'windows'), w: F('blank', 'blank') },
  },
  // --- East of the plaza, across the road ----------------------------------
  {
    id: 'eastrow1', cx: 30, cz: -12, w: 14, d: 16, storeys: 3,
    wall: 'plasterOchre', trim: 'stoneBlock', damage: 0.4,
    faces: { n: F('windows', 'windows'), e: F('blank', 'blank'), s: F('windows', 'windows'), w: F('shopdoor', 'balcony', 3.2) },
  },
  {
    id: 'eastrow2', cx: 31, cz: 6, w: 16, d: 14, storeys: 2,
    wall: 'stuccoTan', trim: 'concreteWorn', damage: 0.5,
    faces: { n: F('windows', 'windows'), e: F('blank', 'blank'), s: F('windows', 'windows'), w: F('windows', 'windows') },
  },
  // --- Compound north of the highway ---------------------------------------
  {
    id: 'compound', cx: 30, cz: 18, w: 12, d: 9, storeys: 2,
    wall: 'plasterDamaged', trim: 'concreteWorn', damage: 0.8,
    faces: { n: F('windows', 'windows'), e: F('windows', 'windows'), s: F('shopdoor', 'balcony', 3.0), w: F('ruin', 'windows') },
  },
  // --- South of the highway -------------------------------------------------
  {
    id: 'southrow', cx: 24, cz: 44, w: 20, d: 10, storeys: 2,
    wall: 'brickPainted', trim: 'concreteWorn', damage: 0.7,
    faces: { n: F('shopdoor', 'windows', 3.4), e: F('windows', 'windows'), s: F('blank', 'blank'), w: F('windows', 'windows') },
  },
  {
    id: 'southwest', cx: -2, cz: 46, w: 14, d: 10, storeys: 2,
    wall: 'stuccoTan', trim: 'stoneBlock', damage: 0.6,
    faces: { n: F('windows', 'windows'), e: F('windows', 'windows'), s: F('blank', 'blank'), w: F('blank', 'blank') },
  },
  {
    id: 'westfar', cx: -34, cz: 8, w: 12, d: 14, storeys: 3,
    wall: 'plasterWhite', trim: 'stoneBlock', damage: 0.45,
    faces: { n: F('windows', 'windows'), e: F('windows', 'balcony', 3.2), s: F('windows', 'windows'), w: F('blank', 'blank') },
  },
  {
    id: 'westfar2', cx: -36, cz: 34, w: 14, d: 16, storeys: 2,
    wall: 'stuccoTan', trim: 'concreteWorn', damage: 0.6,
    faces: { n: F('windows', 'windows'), e: F('windows', 'windows'), s: F('blank', 'blank'), w: F('blank', 'blank') },
  },
]

/** Footprints used to keep scatter systems from placing props inside walls. */
export function insideAnyBuilding(x: number, z: number, margin = 0.6): boolean {
  for (const s of BUILDINGS) {
    if (rotRectSdf(x, z, s.cx, s.cz, s.w / 2 + margin, s.d / 2 + margin, s.yaw ?? 0) < 0) return true
  }
  for (const s of EXTRA_FOOTPRINTS) {
    if (rotRectSdf(x, z, s.cx, s.cz, s.hw + margin, s.hd + margin, s.yaw) < 0) return true
  }
  return false
}

/** Custom structures that are not generic rectangles but still block placement. */
export const EXTRA_FOOTPRINTS: { cx: number; cz: number; hw: number; hd: number; yaw: number }[] = [
  { cx: -21.5, cz: -36, hw: 8.5, hd: 6, yaw: 0 }, // mosque
  { cx: -15, cz: -30.5, hw: 1.5, hd: 1.5, yaw: 0 }, // minaret
  { cx: 19.75, cz: 16.25, hw: 4.25, hd: 5.75, yaw: 0 }, // market hall
  { cx: 9.35, cz: 29.5, hw: 0.35, hd: 5.8, yaw: 0 }, // alley compound wall
  { cx: 31, cz: 27.5, hw: 2.2, hd: 2.2, yaw: 0 }, // water tower legs
]

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** The mosque closing the plaza's north side: iwan arch, dome, stone banding. */
export function buildMosque(b: Builder, rng: Rand, result: BuildResult): void {
  const cx = -21.5
  const cz = -36
  const w = 17
  const d = 12
  const h = 8.6
  const base = footprintBase(cx, cz, w, d)
  b.push(cx, base, cz, 0)
  b.solid('stoneBlock', w + 0.3, 1.6, d + 0.3, 0, -0.78, 0, 0, 0.06, 'concrete')

  const T = 0.45
  // South facade with a monumental iwan.
  b.push(w / 2, 0, d / 2 - T / 2, Math.PI)
  buildWall(b, {
    length: w, height: h, thickness: T, mat: 'stuccoTan', trim: 'stoneBlock',
    exterior: true, plinth: 0.5, cornice: true, weather: 0.3, rng,
    openings: [
      { at: w / 2, width: 4.6, sill: 0, height: 6.6, kind: 'arch' },
      { at: 2.4, width: 1.1, sill: 4.0, height: 1.9, kind: 'arch', glass: false },
      { at: w - 2.4, width: 1.1, sill: 4.0, height: 1.9, kind: 'arch', glass: false },
    ],
  })
  b.pop()
  for (const [side, sx, sz, syaw, len] of [
    ['n', -w / 2, -d / 2 + T / 2, 0, w],
    ['e', w / 2 - T / 2, -d / 2, -Math.PI / 2, d],
    ['w', -w / 2 + T / 2, d / 2, Math.PI / 2, d],
  ] as [string, number, number, number, number][]) {
    void side
    b.push(sx, 0, sz, syaw)
    buildWall(b, {
      length: len, height: h, thickness: T, mat: 'stuccoTan', trim: 'stoneBlock',
      exterior: true, plinth: 0.5, cornice: true, weather: 0.3, rng,
      openings: bayPositions(len, 3.6, 1.6).map((at) => ({
        at, width: 1.0, sill: 4.4, height: 2.0, kind: 'arch' as const, glass: false,
      })),
    })
    b.pop()
  }
  // Interior shell so the iwan reads as a deep, dark recess.
  b.box('stoneBlock', w - 3.6, h - 0.6, d - 3.6, 0, (h - 0.6) / 2, 0, 0, 0.05)
  b.solid('concreteWorn', w - 0.4, SLAB_T, d - 0.4, 0, h + SLAB_T / 2, 0, 0, 0.04, 'concrete')

  // Drum and dome.
  const drumY = h + SLAB_T
  b.geom('stuccoTan', cylinderGeom(4.3, 4.6, 1.8, 20), xform(0, drumY + 0.9, 0))
  b.geom('stoneBlock', cylinderGeom(4.7, 4.7, 0.22, 20), xform(0, drumY + 1.9, 0))
  b.geom('plasterWhite', sphereGeom(4.35, 22, 12, Math.PI * 2, Math.PI / 2), xform(0, drumY + 1.9, 0))
  b.geom('metalPainted', cylinderGeom(0.09, 0.16, 1.5, 8), xform(0, drumY + 6.9, 0))
  b.geom('metalPainted', sphereGeom(0.28, 10, 8), xform(0, drumY + 7.7, 0))
  b.collide(8.6, 5.5, 8.6, 0, drumY + 2.7, 0, 0, 'concrete')

  // Corner buttresses.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.solid('stoneBlock', 1.3, h + 1.2, 1.3, sx * (w / 2 - 0.3), (h + 1.2) / 2, sz * (d / 2 - 0.3), 0, 0.06)
      b.geom('stoneBlock', sphereGeom(0.5, 10, 6), xform(sx * (w / 2 - 0.3), h + 1.2, sz * (d / 2 - 0.3)))
    }
  }
  b.pop()
  result.indoor.push(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(cx, base + h / 2, cz), new THREE.Vector3(w - 1.5, h, d - 1.5)))
}

/** Minaret — the district's skyline anchor and the plaza pose's back subject. */
export function buildMinaret(b: Builder, rng: Rand): void {
  const cx = -15
  const cz = -30.5
  const base = footprintBase(cx, cz, 3, 3)
  b.push(cx, base, cz, 0.18)
  b.solid('stoneBlock', 3.4, 1.4, 3.4, 0, -0.6, 0, 0, 0.06, 'concrete')
  b.solid('stoneBlock', 3.0, 1.2, 3.0, 0, 0.6, 0, 0, 0.05)
  b.solid('stuccoTan', 2.5, 11.5, 2.5, 0, 1.2 + 5.75, 0, 0, 0.05)
  // Banding and blind arcading up the shaft.
  for (let i = 0; i < 5; i++) {
    b.box('stoneBlock', 2.66, 0.16, 2.66, 0, 2.6 + i * 2.2, 0, 0, 0.03)
    for (let f = 0; f < 4; f++) {
      b.plate('plasterDamaged', 0.6, 1.1, 0.05, 0, 3.4 + i * 2.2, 1.28, (f * Math.PI) / 2)
    }
  }
  // Muezzin's gallery.
  const gy = 12.7
  b.solid('stoneBlock', 4.2, 0.28, 4.2, 0, gy, 0, 0, 0.04)
  for (let f = 0; f < 4; f++) {
    b.push(0, 0, 0, (f * Math.PI) / 2)
    for (let i = 0; i < 7; i++) {
      b.plate('stoneBlock', 0.11, 0.85, 0.11, -1.8 + i * 0.6, gy + 0.57, 2.0)
    }
    b.box('stoneBlock', 4.2, 0.12, 0.18, 0, gy + 1.05, 2.0, 0, 0.03)
    b.pop()
  }
  b.solid('stuccoTan', 2.0, 5.4, 2.0, 0, gy + 0.28 + 2.7, 0, 0, 0.04)
  for (let f = 0; f < 4; f++) {
    b.plate('plasterDamaged', 0.5, 1.5, 0.06, 0, gy + 2.2, 1.02, (f * Math.PI) / 2)
  }
  b.geom('stoneBlock', cylinderGeom(1.35, 1.5, 0.3, 12), xform(0, gy + 5.85, 0))
  b.geom('plasterWhite', sphereGeom(1.35, 14, 9, Math.PI * 2, Math.PI / 2), xform(0, gy + 6.0, 0))
  b.geom('metalPainted', cylinderGeom(0.05, 0.09, 1.3, 8), xform(0, gy + 8.0, 0))
  b.geom('metalPainted', sphereGeom(0.2, 8, 6), xform(0, gy + 8.7, 0))
  // Loudspeakers on the gallery, pointing over the square.
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2 + 0.4
    b.geom('metalPainted', cylinderGeom(0.26, 0.1, 0.42, 10),
      xform(Math.sin(a) * 1.1, gy + 1.6, Math.cos(a) * 1.1, a, Math.PI / 2))
  }
  void rng
  b.pop()
}

/**
 * The covered market hall east of the alley. Its 2.8 m roof deck is the
 * district's elevated overwatch position and the vista pose's vantage point.
 */
export function buildMarketHall(b: Builder, rng: Rand, result: BuildResult): void {
  const cx = 19.75
  const cz = 16.25
  const w = 8.5
  const d = 11.5
  const deck = 2.8
  const base = footprintBase(cx, cz, w, d)
  const T = 0.3
  b.push(cx, base, cz, 0)
  b.solid('stoneBlock', w + 0.24, 1.4, d + 0.24, 0, -0.68, 0, 0, 0.05, 'concrete')

  const faces: [Side, Opening[]][] = [
    ['n', [{ at: w / 2, width: 3.2, sill: 0, height: 2.35, kind: 'arch' }]],
    ['e', [
      { at: 3.0, width: 1.1, sill: 1.15, height: 1.1, kind: 'window', bars: true },
      { at: 8.4, width: 1.1, sill: 1.15, height: 1.1, kind: 'window', bars: true },
    ]],
    ['s', [{ at: w / 2, width: 2.4, sill: 0, height: 2.3, kind: 'arch' }]],
    // Local x runs from z = +d/2 back to -d/2; keep the openings clear of the
    // exterior stair that lands at the north end of this face.
    ['w', [
      { at: 5.6, width: 2.6, sill: 0.35, height: 2.0, kind: 'shop', glass: false },
      { at: 9.2, width: DOOR_W, sill: 0, height: DOOR_H, kind: 'door' },
    ]],
  ]
  for (const [side, openings] of faces) {
    const p = sidePlacement(side, w, d, T)
    b.push(p.x, 0, p.z, p.yaw)
    buildWall(b, {
      length: p.length, height: deck, thickness: T, mat: 'brickPainted', trim: 'concreteWorn',
      openings, exterior: true, plinth: 0.35, weather: 0.7, rng,
    })
    b.pop()
  }
  // Deck slab, then a low parapet the player can shoot over from a crouch.
  b.solid('concreteWorn', w, 0.26, d, 0, deck - 0.13, 0, 0, 0.03, 'concrete')
  const pt = 0.22
  const parapet = 0.84
  for (const side of SIDES) {
    const p = sidePlacement(side, w, d, pt)
    b.push(p.x, deck, p.z, p.yaw)
    if (side === 'w') {
      // Open where the exterior stair lands — the way onto the deck.
      const gap = 4.2
      b.solid('brickPainted', p.length - gap, parapet, pt, gap + (p.length - gap) / 2, parapet / 2, 0, 0, 0.03)
      b.box('concreteWorn', p.length - gap, 0.08, pt + 0.14, gap + (p.length - gap) / 2, parapet + 0.04, 0, 0, 0.03)
    } else if (side === 's') {
      // A shell took out the middle of this run. The breach is what makes the
      // overwatch position read: the district opens up through it, and the
      // stumps either side frame the shot instead of walling it off.
      const a = 1.8
      const c = 5.0
      b.solid('brickPainted', a, parapet, pt, a / 2, parapet / 2, 0, 0, 0.03)
      b.box('concreteWorn', a, 0.08, pt + 0.14, a / 2, parapet + 0.04, 0, 0, 0.03)
      b.solid('brickPainted', p.length - c, parapet, pt, (p.length + c) / 2, parapet / 2, 0, 0, 0.03)
      b.box('concreteWorn', p.length - c, 0.08, pt + 0.14, (p.length + c) / 2, parapet + 0.04, 0, 0, 0.03)
      b.solid('brickPainted', c - a, 0.24, pt, (a + c) / 2, 0.12, 0, 0, 0.03)
      for (let i = 0; i < 5; i++) {
        b.geom('rebar', cylinderGeom(0.013, 0.013, rng.range(0.3, 0.6), 4),
          xform(a + rng.range(0.1, c - a - 0.1), 0.4, rng.spread(0.06), rng.range(0, 3.1), rng.spread(0.6), rng.spread(0.6)))
      }
    } else {
      b.solid('brickPainted', p.length, parapet, pt, p.length / 2, parapet / 2, 0, 0, 0.03)
      b.box('concreteWorn', p.length, 0.08, pt + 0.14, p.length / 2, parapet + 0.04, 0, 0, 0.03)
    }
    b.pop()
  }
  // Interior: an open hall with a beam grid and hanging bulbs.
  b.solid('tileFloor', w - 0.9, 0.24, d - 0.9, 0, -0.1, 0, 0, 0.02, 'tile')
  for (let i = 0; i < 5; i++) {
    b.box('woodBeam', w - 0.6, 0.2, 0.16, 0, deck - 0.42, -d / 2 + 1.4 + i * 2.1, 0, 0.02)
  }
  for (const sx of [-1, 1]) {
    b.solid('woodBeam', 0.22, deck - 0.5, 0.22, sx * 2.4, (deck - 0.5) / 2, 0, 0, 0.025)
  }
  b.pop()

  // Exterior stair climbing north along the west face, from the alley
  // junction up to the deck — the route to the district's overwatch position.
  const stx = cx - w / 2 - 0.85
  const stz = cz + d / 2 + 1.2
  buildStairFlight(b, stx, base, stz, 0, 1.5, 16, deck / 16, 0.26, 'concreteWorn', false)
  b.push(stx, base, stz, 0)
  // Outboard stringer wall, so the flight is not a floating staircase.
  for (let i = 0; i < 16; i++) {
    const top = (i + 1) * (deck / 16)
    b.box('brickPainted', 0.26, top + 0.5, 0.26, -0.88, (top + 0.5) / 2 - 0.25, -(i + 0.5) * 0.26, 0, 0.03)
  }
  // Landing bridging the parapet gap onto the deck.
  b.solid('concreteWorn', 2.4, 0.24, 1.5, 0.55, deck - 0.12, -4.16 - 0.75, 0, 0.03, 'concrete')
  b.pop()

  result.decks.push({ cx, cz, w: w - 1.4, d: d - 1.4, y: base + deck, yaw: 0 })
  result.indoor.push(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(cx, base + deck / 2, cz), new THREE.Vector3(w - 1.0, deck, d - 1.0)))
}

/**
 * An enclosed first-floor passage bridging the alley — the sabat that gives
 * the alley pose a dark ceiling and turns it into a real corridor.
 */
export function buildSabat(b: Builder, rng: Rand, result: BuildResult): void {
  const x0 = 5.0
  const x1 = 9.2
  const zc = 18.0
  const width = 3.0
  const y = footprintBase((x0 + x1) / 2, zc, x1 - x0, width) + STOREY
  const span = x1 - x0
  b.push((x0 + x1) / 2, y, zc, 0)
  b.solid('concreteWorn', span + 0.4, 0.3, width, 0, -0.15, 0, 0, 0.03, 'concrete')
  b.solid('plasterOchre', span + 0.4, 2.55, 0.32, 0, 1.4, -width / 2 + 0.16, 0, 0.03)
  b.solid('plasterOchre', span + 0.4, 2.55, 0.32, 0, 1.4, width / 2 - 0.16, 0, 0.03)
  b.solid('concreteWorn', span + 0.5, 0.26, width + 0.24, 0, 2.8, 0, 0, 0.04, 'concrete')
  // A small barred window over the alley on each side.
  for (const sz of [-1, 1]) {
    b.plate('plasterDamaged', 0.9, 0.9, 0.06, 0.8 * sz, 1.5, sz * (width / 2 - 0.02))
    for (let i = 0; i < 3; i++) {
      b.geom('rebar', cylinderGeom(0.016, 0.016, 0.86, 6), xform(0.8 * sz - 0.3 + i * 0.3, 1.5, sz * (width / 2 - 0.05)))
    }
  }
  // Timber joists poking out under the bridge — a classic medina detail.
  for (let i = 0; i < 5; i++) {
    b.geom('woodBeam', cylinderGeom(0.07, 0.075, span + 0.7, 7),
      xform(0, -0.34, -width / 2 + 0.4 + i * ((width - 0.8) / 4), 0, 0, Math.PI / 2))
  }
  b.geom('dirt', decalQuad(span, 1.2, 0.2, 9), xform(0, 1.0, -width / 2 - 0.02))
  b.pop()
  void rng
  result.indoor.push(new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3((x0 + x1) / 2, y + 1.3, zc), new THREE.Vector3(span, 2.6, width - 0.4)))
}

/**
 * Boundary walls: they define the alley's southern half and the compounds
 * without costing a full building, and give hard cover along the sightlines.
 */
export function buildCompoundWalls(b: Builder, rng: Rand): void {
  const runs: { x0: number; z0: number; x1: number; z1: number; h: number; mat: MaterialName; gate?: number }[] = [
    // East side of the alley, south of the junction — low enough that sun
    // spills over it onto the alley's west wall.
    { x0: 9.35, z0: 24.0, x1: 9.35, z1: 35.2, h: 2.55, mat: 'brickPainted', gate: 0.62 },
    // Lot boundary along the highway shoulder.
    { x0: 9.6, z0: 35.2, x1: 26.0, z1: 35.2, h: 2.2, mat: 'concreteWorn' },
    { x0: 26.0, z0: 21.5, x1: 26.0, z1: 35.2, h: 1.85, mat: 'stuccoTan' },
    // Compound around the house north of the highway.
    { x0: 22.5, z0: 12.0, x1: 22.5, z1: 24.0, h: 2.7, mat: 'stuccoTan', gate: 0.5 },
    { x0: 22.5, z0: 24.0, x1: 37.5, z1: 24.0, h: 2.7, mat: 'stuccoTan' },
    // Yard behind the apartment block.
    { x0: -21.5, z0: 18.0, x1: -21.5, z1: 33.0, h: 2.4, mat: 'plasterDamaged' },
    { x0: -21.5, z0: 33.0, x1: -10.0, z1: 33.0, h: 2.4, mat: 'plasterDamaged', gate: 0.4 },
    // Plaza's north-west corner.
    { x0: -25.5, z0: -26.5, x1: -25.5, z1: -14.0, h: 2.6, mat: 'stoneBlock' },
  ]
  for (const r of runs) {
    const dx = r.x1 - r.x0
    const dz = r.z1 - r.z0
    const len = Math.hypot(dx, dz)
    const yaw = Math.atan2(-dz, dx)
    const cxm = (r.x0 + r.x1) / 2
    const czm = (r.z0 + r.z1) / 2
    const base = footprintBase(cxm, czm, Math.abs(dx) + 0.4, Math.abs(dz) + 0.4)
    b.push(cxm, base, czm, yaw)
    const openings: Opening[] = []
    if (r.gate !== undefined) {
      openings.push({ at: len * r.gate, width: 2.4, sill: 0, height: 2.15, kind: 'hole' })
    }
    buildWall(b, {
      length: len, height: r.h, thickness: 0.28, mat: r.mat, trim: 'concreteWorn',
      openings, exterior: true, plinth: 0.3, weather: 0.8, rng,
    })
    // Coping and pier caps.
    b.box('concreteWorn', len, 0.1, 0.4, 0, r.h + 0.05, 0, 0, 0.03)
    const piers = Math.max(2, Math.round(len / 4))
    for (let i = 0; i <= piers; i++) {
      const px = (len * i) / piers - len / 2
      b.solid(r.mat, 0.46, r.h + 0.3, 0.46, px, (r.h + 0.3) / 2, 0, 0, 0.035)
      b.box('concreteWorn', 0.58, 0.12, 0.58, px, r.h + 0.36, 0, 0, 0.03)
    }
    b.pop()
  }
}

/** Landmark on the skyline south-east: a steel water tower on braced legs. */
export function buildWaterTower(b: Builder, rng: Rand): void {
  const cx = 31
  const cz = 27.5
  const base = footprintBase(cx, cz, 5, 5)
  b.push(cx, base, cz, 0.3)
  const legH = 8.6
  const spread = 1.9
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    const sx = Math.cos(a) * spread
    const sz = Math.sin(a) * spread
    const tx = Math.cos(a) * 1.15
    const tz = Math.sin(a) * 1.15
    const dx = tx - sx
    const dz = tz - sz
    const lean = Math.atan2(Math.hypot(dx, dz), legH)
    const m = xform((sx + tx) / 2, legH / 2, (sz + tz) / 2, Math.atan2(-dz, dx), 0, -lean)
    b.geom('metalRusted', chamferBox(0.16, legH + 0.4, 0.16, 0.02), m)
    b.collide(0.3, legH, 0.3, sx, legH / 2, sz, 0, 'metal')
  }
  for (const y of [2.6, 5.4]) {
    for (let i = 0; i < 4; i++) {
      const a0 = (i * Math.PI) / 2 + Math.PI / 4
      const a1 = ((i + 1) * Math.PI) / 2 + Math.PI / 4
      const t = 1 - y / legH
      const r0 = 1.15 + (spread - 1.15) * t
      const p0 = new THREE.Vector3(Math.cos(a0) * r0, y, Math.sin(a0) * r0)
      const p1 = new THREE.Vector3(Math.cos(a1) * r0, y, Math.sin(a1) * r0)
      const mid = p0.clone().add(p1).multiplyScalar(0.5)
      const len = p0.distanceTo(p1)
      b.geom('metalRusted', chamferBox(len, 0.09, 0.09, 0.015),
        xform(mid.x, mid.y, mid.z, Math.atan2(-(p1.z - p0.z), p1.x - p0.x)))
    }
  }
  b.geom('metalRusted', cylinderGeom(2.5, 2.2, 3.4, 16), xform(0, legH + 1.7, 0))
  b.geom('metalRusted', cylinderGeom(1.2, 2.5, 1.0, 16), xform(0, legH - 0.2, 0))
  b.geom('metalCorrugated', cylinderGeom(0.2, 2.6, 1.1, 16), xform(0, legH + 3.9, 0))
  b.collide(4.4, 3.4, 4.4, 0, legH + 1.7, 0, 0, 'metal')
  // Access ladder.
  for (let i = 0; i < 26; i++) {
    b.plate('metalRusted', 0.42, 0.035, 0.035, 0, 0.5 + i * 0.34, 2.62)
  }
  for (const sx of [-0.2, 0.2]) {
    b.geom('metalRusted', cylinderGeom(0.03, 0.03, 9.4, 6), xform(sx, 4.9, 2.62))
  }
  void rng
  b.pop()
}

/** Distant blocks beyond the playable area, to give the skyline depth. */
export function buildSkyline(b: Builder, rng: Rand): void {
  const rings = [
    { r: 96, n: 26, hMin: 5, hMax: 13 },
    { r: 148, n: 30, hMin: 7, hMax: 20 },
    { r: 205, n: 26, hMin: 6, hMax: 26 },
  ]
  const pal: MaterialName[] = ['stuccoTan', 'plasterOchre', 'plasterWhite', 'concreteWorn', 'brickPainted']
  for (const ring of rings) {
    for (let i = 0; i < ring.n; i++) {
      const a = (i / ring.n) * Math.PI * 2 + rng.spread(0.08)
      const r = ring.r * rng.range(0.82, 1.2)
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const w = rng.range(9, 26)
      const d = rng.range(9, 22)
      const h = rng.range(ring.hMin, ring.hMax)
      b.box(rng.pick(pal), w, h, d, x, h / 2 - 1.5, z, rng.range(0, Math.PI), 0.12)
      if (rng.bool(0.25)) {
        b.box('stuccoTan', 2.2, h * rng.range(0.5, 1.1), 2.2, x + rng.spread(w / 3), h + h * 0.3, z + rng.spread(d / 3), 0, 0.1)
      }
    }
  }
}

/** Roof clutter shared by every deck: AC units, dishes, tanks, aerials. */
export function buildRoofClutter(b: Builder, decks: BuildResult['decks'], rng: Rand): void {
  for (const deck of decks) {
    if (deck.w < 2 || deck.d < 2) continue
    b.push(deck.cx, deck.y, deck.cz, deck.yaw)
    const n = Math.max(2, Math.round((deck.w * deck.d) / 14))
    for (let i = 0; i < n; i++) {
      const x = rng.spread(deck.w / 2 - 0.5)
      const z = rng.spread(deck.d / 2 - 0.5)
      const kind = rng.next()
      if (kind < 0.28) {
        // Water tank on a stand.
        const r = rng.range(0.45, 0.65)
        for (let l = 0; l < 4; l++) {
          const a = (l * Math.PI) / 2 + 0.7
          b.plate('metalRusted', 0.07, 0.5, 0.07, x + Math.cos(a) * r * 0.7, 0.25, z + Math.sin(a) * r * 0.7)
        }
        b.geom('metalPainted', cylinderGeom(r, r, rng.range(0.8, 1.2), 12), xform(x, 0.5 + 0.5, z))
        b.collide(r * 2, 1.6, r * 2, x, 0.8, z, 0, 'thinMetal')
      } else if (kind < 0.52) {
        // Split AC condenser.
        const yaw = rng.range(0, Math.PI * 2)
        b.solid('metalPainted', 0.86, 0.62, 0.36, x, 0.31, z, yaw, 0.02, 'thinMetal')
        b.geom('steelBrushed', cylinderGeom(0.24, 0.24, 0.06, 12), xform(x + Math.sin(yaw) * 0, 0.34, z, yaw, Math.PI / 2))
        b.plate('metalRusted', 0.9, 0.06, 0.4, x, 0.03, z, yaw)
      } else if (kind < 0.72) {
        // Satellite dish, angled at the sky.
        const yaw = rng.range(0, Math.PI * 2)
        const r = rng.range(0.34, 0.55)
        b.geom('metalPainted', cylinderGeom(0.05, 0.06, 0.9, 8), xform(x, 0.45, z))
        b.geom('plasterWhite', sphereGeom(r, 14, 8, Math.PI * 2, 0.62),
          xform(x, 0.95, z, yaw, Math.PI * 0.62))
        b.plate('metalRusted', 0.42, 0.05, 0.42, x, 0.02, z, yaw)
      } else if (kind < 0.86) {
        // Stacked crates and a tarp.
        const h = rng.range(0.45, 0.9)
        b.solid('woodCrate', 0.8, h, 0.7, x, h / 2, z, rng.range(0, 3.1), 0.03, 'wood')
      } else {
        // Aerial mast with guy wires.
        const h = rng.range(1.8, 3.4)
        b.geom('metalRusted', cylinderGeom(0.03, 0.045, h, 6), xform(x, h / 2, z))
        for (let k = 0; k < 4; k++) {
          b.plate('metalRusted', 0.5, 0.02, 0.02, x, h - 0.2 - k * 0.22, z, rng.range(0, 3.1))
        }
      }
    }
    // Laundry line across the deck.
    if (rng.bool(0.6) && deck.w > 3.5) {
      b.geom('metalRusted', cylinderGeom(0.04, 0.04, 1.5, 6), xform(-deck.w / 2 + 0.4, 0.75, 0))
      b.geom('metalRusted', cylinderGeom(0.04, 0.04, 1.5, 6), xform(deck.w / 2 - 0.4, 0.75, 0))
    }
    b.pop()
  }
}

export { bayPositions, sidePlacement, xform }
