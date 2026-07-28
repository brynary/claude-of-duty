import * as THREE from 'three'
import type { MaterialName } from '../render/MaterialNames'
import type { Rand } from '../core/Rand'
import {
  Builder, InstanceFarm, catenary, chamferBox, clothQuad, cylinderGeom, decalQuad,
  normalizeGeom, plainBox, sphereGeom, valueNoise,
} from './Kit'
import { groundHeight } from './Terrain'
import { insideAnyBuilding, xform } from './Buildings'

/**
 * Props: the layer that turns architecture into a place someone lives in.
 * Everything repeated is instanced; everything hand-composed for a specific
 * camera is authored into the merged static batch.
 */

// ---------------------------------------------------------------------------
// Prop geometry
// ---------------------------------------------------------------------------

/** Extrudes a closed 2D profile (metres, XY) along Z with a small bevel. */
function extrudeProfile(pts: [number, number][], depth: number, bevel = 0.014): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2, bevelEnabled: true, bevelSize: bevel,
    bevelThickness: bevel, bevelSegments: 1, steps: 1, curveSegments: 4,
  })
  g.translate(0, 0, -depth / 2 + bevel)
  return normalizeGeom(g)
}

/** Irregular rock/rubble lump — an icosahedron pushed around deterministically. */
function rockGeom(r: number, seed: number, rough = 0.36): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 0).toNonIndexed()
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  const cache = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(3)}|${v.y.toFixed(3)}|${v.z.toFixed(3)}`
    let f = cache.get(key)
    if (f === undefined) {
      f = 1 + valueNoise(v.x * 3.1 + seed, v.z * 3.1 - seed) * rough + valueNoise(v.y * 2.7 - seed, v.x * 2.1) * rough * 0.5
      cache.set(key, f)
    }
    pos.setXYZ(i, v.x * f, v.y * f * 0.72, v.z * f)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  const uv: number[] = []
  for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i), pos.getZ(i))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return normalizeGeom(g)
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  for (const p of parts) {
    const pp = p.getAttribute('position')
    const nn = p.getAttribute('normal')
    const tt = p.getAttribute('uv')
    for (let i = 0; i < pp.count; i++) {
      pos.push(pp.getX(i), pp.getY(i), pp.getZ(i))
      nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i))
      uv.push(tt.getX(i), tt.getY(i))
    }
    p.dispose()
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return g
}

function at(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  return g.clone().applyMatrix4(m)
}

function crateGeom(w: number, h: number, d: number): THREE.BufferGeometry {
  const parts = [chamferBox(w, h, d, 0.02)]
  const t = 0.045
  // Corner battens and a diagonal brace: reads as boards, not a cube. Detail
  // members are plain boxes — a chamfer on a 5 cm batten is invisible.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(at(plainBox(t * 2, h + 0.006, t * 2), xform(sx * (w / 2 - t), 0, sz * (d / 2 - t))))
    }
  }
  for (const sz of [-1, 1]) {
    parts.push(at(plainBox(w + 0.008, t * 1.6, t * 1.6), xform(0, h / 2 - 0.06, sz * (d / 2 + 0.004))))
    parts.push(at(plainBox(w + 0.008, t * 1.6, t * 1.6), xform(0, -h / 2 + 0.06, sz * (d / 2 + 0.004))))
    const diag = Math.hypot(w - 0.1, h - 0.16)
    parts.push(at(plainBox(diag, t * 1.3, t * 1.2),
      xform(0, 0, sz * (d / 2 + 0.003), 0, 0, Math.atan2(h - 0.16, w - 0.1) * sz)))
  }
  return merge(parts)
}

function barrelGeom(r: number, h: number, rusty: boolean): THREE.BufferGeometry {
  const parts = [cylinderGeom(r, r, h, 12)]
  for (const y of [-h * 0.28, h * 0.28]) {
    parts.push(at(cylinderGeom(r + 0.022, r + 0.022, 0.055, 12, false), xform(0, y, 0)))
  }
  parts.push(at(cylinderGeom(r * 0.99, r * 0.99, 0.05, 12, false), xform(0, h / 2 + 0.02, 0)))
  if (rusty) parts.push(at(cylinderGeom(0.05, 0.05, 0.04, 6), xform(r * 0.5, h / 2 + 0.04, 0)))
  return merge(parts)
}

function palletGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    parts.push(at(plainBox(1.2, 0.08, 0.1), xform(0, 0.04, -0.35 + i * 0.35)))
  }
  for (let i = 0; i < 6; i++) {
    parts.push(at(plainBox(0.11, 0.022, 0.8), xform(-0.55 + i * 0.22, 0.095, 0)))
  }
  for (let i = 0; i < 4; i++) {
    parts.push(at(plainBox(0.14, 0.022, 0.8), xform(-0.45 + i * 0.3, -0.012, 0)))
  }
  return merge(parts)
}

function tyreGeom(r: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(r, r * 0.34, 6, 16).toNonIndexed()
  g.rotateX(Math.PI / 2)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r * 0.7)
  return normalizeGeom(g)
}

function sandbagGeom(): THREE.BufferGeometry {
  return chamferBox(0.52, 0.19, 0.3, 0.085)
}

function jerseyGeom(): THREE.BufferGeometry {
  return extrudeProfile([
    [-0.31, 0], [0.31, 0], [0.31, 0.09], [0.15, 0.34], [0.1, 0.9], [-0.1, 0.9], [-0.15, 0.34], [-0.31, 0.09],
  ], 1.55, 0.016)
}

function hescoGeom(): THREE.BufferGeometry {
  const parts = [chamferBox(1.0, 1.0, 1.0, 0.05)]
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.push(at(plainBox(1.02, 0.03, 0.03), xform(0, -0.36 + i * 0.36, sz * 0.51)))
    }
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.push(at(plainBox(0.03, 0.03, 1.02), xform(sx * 0.51, -0.36 + i * 0.36, 0)))
    }
  }
  return merge(parts)
}

function coneGeom(): THREE.BufferGeometry {
  const parts = [
    at(plainBox(0.34, 0.035, 0.34), xform(0, 0.017, 0)),
    at(cylinderGeom(0.035, 0.14, 0.52, 8), xform(0, 0.28, 0)),
    at(cylinderGeom(0.09, 0.1, 0.07, 8, false), xform(0, 0.36, 0)),
  ]
  return merge(parts)
}

function gasBottleGeom(): THREE.BufferGeometry {
  const parts = [
    cylinderGeom(0.16, 0.17, 0.58, 10),
    at(sphereGeom(0.16, 10, 5, Math.PI * 2, Math.PI / 2), xform(0, 0.29, 0)),
    at(cylinderGeom(0.045, 0.045, 0.1, 6), xform(0, 0.47, 0)),
  ]
  return merge(parts)
}

function bucketGeom(): THREE.BufferGeometry {
  return cylinderGeom(0.16, 0.12, 0.28, 10)
}

function sackGeom(): THREE.BufferGeometry {
  const parts = [
    chamferBox(0.46, 0.34, 0.34, 0.13),
    at(chamferBox(0.16, 0.1, 0.14, 0.045), xform(0, 0.2, 0, 0, 0, 0.4)),
  ]
  return merge(parts)
}

function basketGeom(): THREE.BufferGeometry {
  const parts = [cylinderGeom(0.28, 0.2, 0.3, 9, false)]
  for (let i = 0; i < 2; i++) parts.push(at(cylinderGeom(0.25 + i * 0.014, 0.25 + i * 0.014, 0.025, 9, false), xform(0, -0.06 + i * 0.14, 0)))
  return merge(parts)
}

function cinderGeom(): THREE.BufferGeometry {
  const parts = [chamferBox(0.44, 0.2, 0.21, 0.015)]
  for (const sx of [-1, 1]) parts.push(at(plainBox(0.13, 0.21, 0.13), xform(sx * 0.11, 0.005, 0)))
  return merge(parts)
}

function spoolGeom(): THREE.BufferGeometry {
  const parts = [
    at(cylinderGeom(0.62, 0.62, 0.07, 12), xform(0, 0, 0.3, 0, 0, Math.PI / 2)),
    at(cylinderGeom(0.62, 0.62, 0.07, 12), xform(0, 0, -0.3, 0, 0, Math.PI / 2)),
    at(cylinderGeom(0.34, 0.34, 0.56, 10, false), xform(0, 0, 0, 0, 0, Math.PI / 2)),
  ]
  const g = merge(parts)
  g.rotateZ(Math.PI / 2)
  g.rotateY(Math.PI / 2)
  return normalizeGeom(g)
}

function acUnitGeom(): THREE.BufferGeometry {
  const parts = [
    chamferBox(0.84, 0.6, 0.34, 0.025),
    at(cylinderGeom(0.22, 0.22, 0.05, 10), xform(0, 0.02, 0.18, 0, Math.PI / 2)),
    at(plainBox(0.9, 0.06, 0.4), xform(0, -0.32, 0)),
    at(plainBox(0.1, 0.1, 0.3), xform(-0.4, 0.2, -0.2)),
  ]
  return merge(parts)
}

function plasticChairGeom(): THREE.BufferGeometry {
  const parts = [at(chamferBox(0.44, 0.05, 0.42, 0.02), xform(0, 0.44, 0))]
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(at(plainBox(0.04, 0.44, 0.04), xform(sx * 0.18, 0.22, sz * 0.17)))
    }
  }
  parts.push(at(chamferBox(0.42, 0.44, 0.05, 0.02), xform(0, 0.68, -0.19, 0, -0.14)))
  return merge(parts)
}

function tableGeom(w: number, d: number, h: number): THREE.BufferGeometry {
  const parts = [at(chamferBox(w, 0.055, d, 0.015), xform(0, h - 0.028, 0))]
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(at(plainBox(0.06, h - 0.06, 0.06), xform(sx * (w / 2 - 0.07), (h - 0.06) / 2, sz * (d / 2 - 0.07))))
    }
  }
  parts.push(at(plainBox(w - 0.16, 0.04, 0.04), xform(0, h * 0.35, d / 2 - 0.07)))
  parts.push(at(plainBox(w - 0.16, 0.04, 0.04), xform(0, h * 0.35, -d / 2 + 0.07)))
  return merge(parts)
}

function rebarBundleGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    parts.push(at(cylinderGeom(0.012, 0.012, 2.4, 4, false),
      xform((i - 2) * 0.032, 0.012 + (i % 2) * 0.024, (i - 2) * 0.01, 0, 0, Math.PI / 2)))
  }
  return merge(parts)
}

/** Registers every instanced prop kind used across the map. */
export function definePropKinds(farm: InstanceFarm): void {
  farm.define('crateS', crateGeom(0.52, 0.44, 0.46), 'woodCrate')
  farm.define('crateM', crateGeom(0.78, 0.62, 0.6), 'woodCrate')
  farm.define('crateL', crateGeom(1.18, 0.72, 0.78), 'woodCrate')
  farm.define('ammoBox', crateGeom(0.7, 0.34, 0.36), 'metalPainted')
  farm.define('barrelBlue', barrelGeom(0.29, 0.88, true), 'metalPainted')
  farm.define('barrelRust', barrelGeom(0.29, 0.88, true), 'metalRusted')
  farm.define('drumShort', barrelGeom(0.28, 0.6, false), 'metalRusted')
  farm.define('pallet', palletGeom(), 'woodPlank')
  farm.define('tyre', tyreGeom(0.36), 'rubber')
  farm.define('tyreBig', tyreGeom(0.52), 'rubber')
  farm.define('sandbag', sandbagGeom(), 'sandbag', false)
  farm.define('jersey', jerseyGeom(), 'concreteWorn')
  farm.define('hesco', hescoGeom(), 'sandbag')
  farm.define('cone', coneGeom(), 'rubber')
  farm.define('gasBottle', gasBottleGeom(), 'metalPainted')
  farm.define('bucket', bucketGeom(), 'metalPainted')
  farm.define('sack', sackGeom(), 'fabricAwning')
  farm.define('basket', basketGeom(), 'woodPlank')
  farm.define('cinder', cinderGeom(), 'concreteRubble')
  farm.define('brick', plainBox(0.23, 0.07, 0.11), 'brickRed', false)
  farm.define('spool', spoolGeom(), 'woodPlank')
  farm.define('acUnit', acUnitGeom(), 'metalPainted')
  farm.define('chair', plasticChairGeom(), 'metalPainted')
  farm.define('table', tableGeom(1.35, 0.75, 0.74), 'woodPlank')
  farm.define('tableSmall', tableGeom(0.85, 0.6, 0.5), 'woodPlank')
  farm.define('rebar', rebarBundleGeom(), 'rebar')
  farm.define('plank', plainBox(2.0, 0.05, 0.2), 'woodPlank', false)
  farm.define('sheet', plainBox(1.6, 0.03, 0.85), 'metalCorrugated')
  for (let i = 0; i < 4; i++) {
    farm.define(`rubble${i}`, rockGeom(0.3 + i * 0.16, i * 3 + 1), 'concreteRubble', i > 1)
    farm.define(`chunk${i}`, rockGeom(0.1 + i * 0.05, i * 7 + 11, 0.5), 'concreteRubble', false)
  }
  farm.define('stone', rockGeom(0.22, 41, 0.45), 'stoneBlock', false)
}

// ---------------------------------------------------------------------------
// Composed set pieces
// ---------------------------------------------------------------------------

/** Market stall: timber frame, sagging canvas, goods and a hanging back cloth. */
export function buildStall(
  b: Builder, farm: InstanceFarm, rng: Rand,
  x: number, z: number, yaw: number, width = 2.6, depth = 1.9,
): void {
  const base = groundHeight(x, z)
  b.push(x, base, z, yaw)
  const postH = 2.25
  const hw = width / 2
  const hd = depth / 2
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.solid('woodBeam', 0.09, postH, 0.09, sx * hw, postH / 2, sz * hd, 0, 0.012, 'wood')
    }
  }
  b.plate('woodBeam', width + 0.12, 0.09, 0.09, 0, postH, -hd)
  b.plate('woodBeam', width + 0.12, 0.09, 0.09, 0, postH - 0.28, hd)
  for (const sx of [-1, 1]) b.plate('woodBeam', 0.08, 0.08, depth + 0.1, sx * hw, postH - 0.14, 0)

  // Canvas awning, sagging between the rails and overhanging the front.
  const canvas: MaterialName = rng.pick(['fabricAwning', 'tarp', 'fabricAwning'])
  b.geom(canvas, clothQuad(
    new THREE.Vector3(-hw - 0.35, postH + 0.05, -hd - 0.55),
    new THREE.Vector3(hw + 0.35, postH + 0.05, -hd - 0.55),
    new THREE.Vector3(hw + 0.35, postH - 0.24, hd + 0.15),
    new THREE.Vector3(-hw - 0.35, postH - 0.24, hd + 0.15),
    0.16, 0.045, 8, 4, x * 3 + z))
  // Scalloped valance along the front edge.
  b.geom(canvas, clothQuad(
    new THREE.Vector3(-hw - 0.35, postH + 0.03, -hd - 0.55),
    new THREE.Vector3(hw + 0.35, postH + 0.03, -hd - 0.55),
    new THREE.Vector3(hw + 0.35, postH - 0.36, -hd - 0.55),
    new THREE.Vector3(-hw - 0.35, postH - 0.36, -hd - 0.55),
    0.06, 0.05, 10, 2, x))

  // Counter and goods.
  const ch = 0.86
  b.solid('woodPlank', width, 0.07, depth * 0.8, 0, ch, 0.05, 0, 0.014, 'wood')
  b.plate('woodPlank', width, ch - 0.1, 0.05, 0, (ch - 0.1) / 2, -hd * 0.78)
  for (let i = 0; i < rng.int(3, 6); i++) {
    const gx = rng.spread(hw - 0.28)
    const gz = rng.spread(hd * 0.3)
    const kind = rng.next()
    if (kind < 0.35) farm.place('basket', x + rot(gx, gz, yaw).x, base + ch + 0.19, z + rot(gx, gz, yaw).z, rng.range(0, 3.1), rng.range(0.8, 1.1))
    else if (kind < 0.6) farm.place('sack', x + rot(gx, gz, yaw).x, base + ch + 0.2, z + rot(gx, gz, yaw).z, rng.range(0, 3.1), rng.range(0.7, 0.95))
    else farm.place('crateS', x + rot(gx, gz, yaw).x, base + ch + 0.25, z + rot(gx, gz, yaw).z, rng.range(0, 3.1), rng.range(0.55, 0.8))
  }
  // Produce heaped in the baskets.
  for (let i = 0; i < 12; i++) {
    const gx = rng.spread(hw - 0.3)
    const gz = rng.spread(hd * 0.25)
    b.geom(rng.pick<MaterialName>(['foliage', 'woodPainted', 'fabricAwning']),
      sphereGeom(rng.range(0.045, 0.085), 6, 4), xform(gx, ch + 0.13, gz))
  }
  // Hanging cloth at the back, and a bare bulb on a flex.
  if (rng.bool(0.7)) {
    b.geom(rng.pick<MaterialName>(['tarp', 'fabricAwning']), clothQuad(
      new THREE.Vector3(-hw, postH - 0.3, hd),
      new THREE.Vector3(hw, postH - 0.3, hd),
      new THREE.Vector3(hw, rng.range(0.3, 0.9), hd + 0.06),
      new THREE.Vector3(-hw, rng.range(0.3, 0.9), hd + 0.06),
      0.05, 0.06, 6, 5, z))
  }
  b.geom('metalPainted', cylinderGeom(0.006, 0.006, 0.35, 4), xform(rng.spread(0.6), postH - 0.32, 0))
  b.geom('glass', sphereGeom(0.06, 8, 6), xform(0, postH - 0.5, 0))
  // Crates stacked at the stall's foot.
  const n = rng.int(1, 3)
  for (let i = 0; i < n; i++) {
    const p = rot(rng.spread(hw), hd + rng.range(0.2, 0.5), yaw)
    farm.place('crateM', x + p.x, base + 0.31, z + p.z, rng.range(0, 3.1))
  }
  b.pop()
}

/** Rotates a local XZ offset into world space by `yaw` (three's Y convention). */
function rot(x: number, z: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: x * c + z * s, z: -x * s + z * c }
}

/** Dry ornamental fountain at the heart of the square. */
export function buildFountain(b: Builder, farm: InstanceFarm, rng: Rand, x: number, z: number): void {
  const base = groundHeight(x, z)
  b.push(x, base, z, 0.2)
  const sides = 8
  const r = 2.5
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2
    const len = 2 * r * Math.tan(Math.PI / sides)
    b.solid('stoneBlock', len + 0.06, 0.72, 0.34, Math.cos(a) * r, 0.36, Math.sin(a) * r, -a, 0.035)
    b.box('stoneBlock', len + 0.14, 0.09, 0.46, Math.cos(a) * r, 0.76, Math.sin(a) * r, -a, 0.03)
  }
  b.solid('concreteWorn', r * 1.9, 0.24, r * 1.9, 0, 0.12, 0, 0, 0.04, 'concrete')
  b.solid('stoneBlock', 0.9, 1.5, 0.9, 0, 0.75, 0, 0.4, 0.05)
  b.solid('stoneBlock', 1.25, 0.16, 1.25, 0, 1.55, 0, 0.4, 0.04)
  b.geom('stoneBlock', cylinderGeom(0.22, 0.36, 0.5, 10), xform(0, 1.85, 0))
  b.geom('metalRusted', cylinderGeom(0.045, 0.05, 0.5, 8), xform(0, 2.3, 0))
  // Silted up with sand and rubbish rather than water.
  b.geom('sand', decalQuad(r * 1.7, r * 1.7, 0.1, 3), xform(0, 0.26, 0, 0, -Math.PI / 2))
  for (let i = 0; i < 7; i++) {
    const a = rng.range(0, Math.PI * 2)
    const rr = rng.range(0.6, r - 0.5)
    farm.place(`chunk${rng.int(0, 3)}`, x + Math.cos(a) * rr, base + 0.3, z + Math.sin(a) * rr, rng.range(0, 3.1), rng.range(0.8, 1.5))
  }
  b.pop()
}

/**
 * Burnt-out saloon. Built from chamfered masses rather than a real car mesh,
 * but with the proportions and the collapsed, gutted silhouette right.
 */
export function buildWreckCar(b: Builder, rng: Rand, x: number, z: number, yaw: number): void {
  const base = groundHeight(x, z)
  b.push(x, base, z, yaw)
  const body: MaterialName = 'metalRusted'
  // Chassis and sills.
  b.solid(body, 1.72, 0.34, 4.25, 0, 0.52, 0, 0, 0.06, 'metal')
  b.box(body, 1.78, 0.2, 3.9, 0, 0.36, 0, 0, 0.05)
  // Bonnet, boot and cabin.
  b.box(body, 1.66, 0.24, 1.45, 0, 0.8, -1.35, 0, 0.07)
  b.box(body, 1.66, 0.22, 1.05, 0, 0.79, 1.6, 0, 0.07)
  b.solid(body, 1.6, 0.72, 2.0, 0, 1.05, 0.12, 0, 0.09, 'metal')
  // A-pillars and roof, partly collapsed.
  b.box(body, 1.5, 0.06, 1.85, 0, 1.42, 0.15, 0, 0.05)
  for (const sx of [-1, 1]) {
    b.box(body, 0.08, 0.5, 0.1, sx * 0.72, 1.2, -0.82, 0, 0.02)
    b.box(body, 0.08, 0.44, 0.1, sx * 0.74, 1.2, 1.05, 0, 0.02)
  }
  // Wheel arches and burnt rims; two tyres gone.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wx = sx * 0.8
      const wz = sz * 1.42
      b.box(body, 0.16, 0.5, 0.86, wx, 0.62, wz, 0, 0.06)
      b.geom('gunmetal', cylinderGeom(0.31, 0.31, 0.18, 12), xform(wx, 0.33, wz, 0, 0, Math.PI / 2))
      if (rng.bool(0.55)) {
        b.geom('rubber', tyreGeom(0.34), xform(wx, 0.33, wz, 0, 0, Math.PI / 2))
      }
    }
  }
  // Bumpers, grille and the door hanging open.
  b.box('gunmetal', 1.74, 0.16, 0.14, 0, 0.62, -2.15, 0, 0.03)
  b.box('gunmetal', 1.74, 0.16, 0.14, 0, 0.62, 2.15, 0, 0.03)
  b.box('steelBrushed', 1.2, 0.22, 0.06, 0, 0.82, -2.1, 0, 0.02)
  const swing = rng.range(0.6, 1.2)
  const m = xform(-0.82, 1.0, -0.35, swing)
  m.multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.55))
  b.geom(body, chamferBox(0.07, 0.8, 1.1, 0.03), m)
  // Scorching up the flanks and under the wheel arches.
  for (const sx of [-1, 1]) {
    b.geom('plasterDamaged', decalQuad(3.0, 0.7, 0.2, sx * 7), xform(sx * 0.9, 1.15, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2))
  }
  b.geom('asphaltCracked', decalQuad(2.6, 4.8, 0.16, 21), xform(0, 0.02, 0, 0, -Math.PI / 2))
  b.pop()
}

/** Gutted minibus, tipped onto a flat and stripped for parts. */
export function buildWreckBus(b: Builder, x: number, z: number, yaw: number, rng: Rand): void {
  const base = groundHeight(x, z)
  b.push(x, base, z, yaw)
  const body: MaterialName = 'metalRusted'
  const L = 7.4
  const W = 2.3
  b.solid(body, W, 0.5, L, 0, 0.72, 0, 0, 0.06, 'metal')
  // Sides with window bands punched out.
  for (const sx of [-1, 1]) {
    b.solid(body, 0.1, 0.65, L, sx * (W / 2 - 0.05), 1.3, 0, 0, 0.03, 'thinMetal')
    b.solid(body, 0.1, 0.45, L, sx * (W / 2 - 0.05), 2.5, 0, 0, 0.03, 'thinMetal')
    for (let i = 0; i < 5; i++) {
      b.box(body, 0.09, 0.9, 0.09, sx * (W / 2 - 0.05), 2.0, -L / 2 + 0.9 + i * 1.4, 0, 0.02)
    }
  }
  b.solid(body, W, 0.12, L * 0.86, 0, 2.72, 0.1, 0, 0.05, 'thinMetal')
  b.solid(body, W - 0.1, 2.3, 0.12, 0, 1.75, -L / 2, 0, 0.04, 'thinMetal')
  b.solid(body, W - 0.1, 1.6, 0.12, 0, 1.4, L / 2, 0, 0.04, 'thinMetal')
  b.box('glassDirty', W - 0.3, 1.0, 0.04, 0, 2.1, -L / 2 - 0.02, 0, 0.01)
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const wz = sz * (L / 2 - 1.3)
      b.geom('gunmetal', cylinderGeom(0.34, 0.34, 0.2, 12), xform(sx * (W / 2 - 0.18), 0.38, wz, 0, 0, Math.PI / 2))
      if (rng.bool(0.5)) b.geom('rubber', tyreGeom(0.44), xform(sx * (W / 2 - 0.18), 0.4, wz, 0, 0, Math.PI / 2))
    }
  }
  b.geom('plasterDamaged', decalQuad(6.0, 1.6, 0.2, 5), xform(W / 2 + 0.02, 1.9, 0, -Math.PI / 2))
  b.pop()
}

/** Sandbag emplacement: a curved revetment with an ammo crate and a firing step. */
export function buildEmplacement(
  b: Builder, farm: InstanceFarm, rng: Rand,
  x: number, z: number, yaw: number, length = 3.0, rows = 4, curve = 0.22,
  baseY?: number,
): void {
  const base = baseY ?? groundHeight(x, z)
  const perRow = Math.max(2, Math.round(length / 0.5))
  for (let r = 0; r < rows; r++) {
    const y = base + 0.095 + r * 0.175
    const inset = r * 0.035
    const offset = r % 2 === 0 ? 0 : 0.26
    for (let i = 0; i < perRow; i++) {
      const t = (i + 0.5) / perRow - 0.5
      const lx = t * length + offset
      const lz = curve * (t * 2) * (t * 2) - inset
      const p = rot(lx, lz, yaw)
      if (r === rows - 1 && rng.bool(0.22)) continue
      farm.place('sandbag', x + p.x, y, z + p.z, yaw + rng.spread(0.13), rng.range(0.94, 1.06), rng.spread(0.05), rng.spread(0.05))
    }
  }
  b.collide(length + 0.5, rows * 0.175, 0.75, x, base + (rows * 0.175) / 2, z, yaw, 'fabric')
  if (rng.bool(0.7)) {
    const p = rot(rng.spread(length * 0.4), 0.9, yaw)
    farm.place('ammoBox', x + p.x, base + 0.18, z + p.z, yaw + rng.spread(0.5))
  }
}

/** Awning bolted to a facade above a shopfront. */
export function buildAwning(
  b: Builder, x: number, y: number, z: number, yaw: number,
  width: number, project: number, mat: MaterialName, sag = 0.13,
): void {
  b.push(x, y, z, yaw)
  const hw = width / 2
  b.geom(mat, clothQuad(
    new THREE.Vector3(-hw, 0.36, -project),
    new THREE.Vector3(hw, 0.36, -project),
    new THREE.Vector3(hw, 0, 0),
    new THREE.Vector3(-hw, 0, 0),
    sag, 0.04, 8, 3, x + z))
  b.geom(mat, clothQuad(
    new THREE.Vector3(-hw, 0.36, -project),
    new THREE.Vector3(hw, 0.36, -project),
    new THREE.Vector3(hw, 0.06, -project),
    new THREE.Vector3(-hw, 0.06, -project),
    0.05, 0.05, 10, 2, z))
  for (const sx of [-1, 1]) {
    b.geom('metalRusted', cylinderGeom(0.022, 0.022, Math.hypot(project, 0.36), 5),
      xform(sx * (hw - 0.08), 0.18, -project / 2, 0, Math.atan2(project, 0.36) + Math.PI / 2))
    b.plate('metalRusted', 0.05, 0.4, 0.05, sx * (hw - 0.08), 0.2, -0.03)
  }
  b.plate('metalRusted', width, 0.045, 0.045, 0, 0.37, -project)
  b.pop()
}

/**
 * Overhead lines: sagging power cables between poles and laundry strung
 * between facades. These read as strong silhouettes against a low sun.
 */
export function buildOverhead(b: Builder, rng: Rand): void {
  // Power poles along the road out of town.
  const dir = new THREE.Vector2(0.9397, 0.342)
  // South verge of the carriageway, deliberately off every graded sightline —
  // a pole through the middle of a frame is the cheapest way to ruin a shot.
  const start = new THREE.Vector2(11.0, 30.4)
  const poles: THREE.Vector3[] = []
  for (let i = 0; i < 5; i++) {
    const px = start.x + dir.x * i * 10.5
    const pz = start.y + dir.y * i * 10.5
    const base = groundHeight(px, pz)
    const h = 8.2
    b.push(px, base, pz, -0.349)
    b.geom('woodBeam', cylinderGeom(0.13, 0.19, h, 8), xform(0, h / 2, 0))
    b.collide(0.4, h, 0.4, 0, h / 2, 0, 0, 'wood')
    b.plate('woodBeam', 0.11, 0.11, 1.9, 0, h - 0.5, 0)
    b.plate('woodBeam', 0.09, 0.09, 1.4, 0, h - 1.15, 0)
    for (const sz of [-0.85, 0, 0.85]) {
      b.geom('glassDirty', cylinderGeom(0.055, 0.07, 0.13, 6), xform(0, h - 0.38, sz))
    }
    if (i === 1) {
      b.plate('metalPainted', 0.5, 0.7, 0.28, 0.24, 3.0, 0)
    }
    b.pop()
    poles.push(new THREE.Vector3(px, base + h - 0.32, pz))
  }
  for (let i = 0; i < poles.length - 1; i++) {
    for (const off of [-0.85, 0, 0.85]) {
      // Offset perpendicular to the run, matching the crossarm insulators.
      const p0 = new THREE.Vector3(poles[i].x - dir.y * off, poles[i].y, poles[i].z + dir.x * off)
      const p1 = new THREE.Vector3(poles[i + 1].x - dir.y * off, poles[i + 1].y, poles[i + 1].z + dir.x * off)
      b.geom('metalRusted', catenary(p0, p1, 0.75, 0.022, 8, 4))
    }
  }
  // Service drops from the poles to the nearby rooftops.
  b.geom('metalRusted', catenary(poles[0], new THREE.Vector3(23.6, groundHeight(23.6, 18) + 6.4, 18.0), 0.5, 0.018, 8, 4))
  b.geom('metalRusted', catenary(poles[1], new THREE.Vector3(26.5, groundHeight(26.5, 24) + 3.0, 24.0), 0.6, 0.018, 8, 4))

  // Cross-street laundry: the sunset pose looks straight through these.
  const lines: [number, number, number, number, number][] = [
    [-10.3, 16.4, 1.6, 17.2, 4.6],
    [-10.3, 20.8, 1.6, 21.4, 5.2],
    [-10.3, 27.0, -0.4, 27.6, 4.3],
    [4.9, 14.4, 9.3, 14.9, 5.0],
    [4.9, 26.5, 9.3, 27.0, 4.4],
    [-21.2, 22.0, -10.6, 22.4, 5.4],
  ]
  for (const [x0, z0, x1, z1, y] of lines) {
    const p0 = new THREE.Vector3(x0, groundHeight(x0, z0) + y, z0)
    const p1 = new THREE.Vector3(x1, groundHeight(x1, z1) + y, z1)
    b.geom('metalRusted', catenary(p0, p1, 0.32, 0.012, 10, 4))
    const n = rng.int(2, 4)
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.35) / (n + 0.6)
      const t1 = t0 + rng.range(0.1, 0.2)
      const a = p0.clone().lerp(p1, t0)
      const c = p0.clone().lerp(p1, t1)
      a.y -= Math.sin(Math.PI * t0) * 0.32
      c.y -= Math.sin(Math.PI * t1) * 0.32
      const drop = rng.range(0.7, 1.5)
      b.geom(rng.pick<MaterialName>(['fabricAwning', 'tarp', 'fabricAwning']), clothQuad(
        a, c,
        new THREE.Vector3(c.x, c.y - drop, c.z),
        new THREE.Vector3(a.x, a.y - drop, a.z),
        0.05, 0.055, 5, 5, i * 3.3 + x0))
    }
  }
  // Bunting over the market square.
  const bx0 = new THREE.Vector3(-20, groundHeight(-20, -12) + 5.6, -12)
  const bx1 = new THREE.Vector3(-1, groundHeight(-1, -16) + 5.2, -16)
  b.geom('metalRusted', catenary(bx0, bx1, 1.2, 0.012, 12, 4))
  for (let i = 0; i < 16; i++) {
    const t = (i + 0.5) / 16
    const p = bx0.clone().lerp(bx1, t)
    p.y -= Math.sin(Math.PI * t) * 1.2
    b.geom(rng.pick<MaterialName>(['fabricAwning', 'tarp']), clothQuad(
      new THREE.Vector3(p.x - 0.14, p.y, p.z),
      new THREE.Vector3(p.x + 0.14, p.y, p.z),
      new THREE.Vector3(p.x + 0.02, p.y - 0.28, p.z),
      new THREE.Vector3(p.x - 0.02, p.y - 0.28, p.z),
      0.01, 0.02, 2, 2, i))
  }
}

/** Shop signage: a board with an abstract cursive script and a hanging lamp. */
export function buildSign(
  b: Builder, rng: Rand,
  x: number, y: number, z: number, yaw: number, width: number, height: number,
  board: MaterialName = 'metalPainted', ink: MaterialName = 'plasterWhite',
): void {
  b.push(x, y, z, yaw)
  b.box(board, width, height, 0.06, 0, 0, 0, 0, 0.012)
  b.plate('metalRusted', width + 0.08, 0.05, 0.1, 0, height / 2 + 0.02, 0)
  b.plate('metalRusted', width + 0.08, 0.05, 0.1, 0, -height / 2 - 0.02, 0)
  // A run of connected strokes with ascenders and dots — reads as script at
  // any distance without needing a texture.
  const baseline = -height * 0.12
  let cx = width / 2 - 0.12
  const stroke = 0.028
  while (cx > -width / 2 + 0.12) {
    const gw = rng.range(0.07, 0.19)
    b.plate(ink, gw, stroke, 0.02, cx - gw / 2, baseline, -0.04)
    const kind = rng.next()
    if (kind < 0.3) {
      b.plate(ink, stroke, height * rng.range(0.3, 0.5), 0.02, cx - gw / 2, baseline + height * 0.2, -0.04)
    } else if (kind < 0.5) {
      b.plate(ink, stroke, height * 0.22, 0.02, cx - gw / 2, baseline - height * 0.16, -0.04)
    } else if (kind < 0.68) {
      b.plate(ink, gw * 0.8, stroke, 0.02, cx - gw / 2, baseline + height * 0.2, -0.04)
    }
    if (rng.bool(0.35)) {
      b.plate(ink, stroke * 1.4, stroke * 1.4, 0.02, cx - gw * 0.5, baseline + height * 0.3, -0.04)
    }
    cx -= gw + rng.range(0.02, 0.05)
  }
  if (rng.bool(0.5)) {
    b.geom('metalRusted', cylinderGeom(0.02, 0.02, 0.4, 5), xform(width / 2 - 0.2, height / 2 + 0.3, -0.2, 0, 0, 0.7))
    b.geom('metalPainted', cylinderGeom(0.13, 0.05, 0.12, 10), xform(width / 2 - 0.42, height / 2 + 0.34, -0.34))
  }
  b.pop()
}

// ---------------------------------------------------------------------------
// Interiors
// ---------------------------------------------------------------------------

/** Furnishes the three enterable buildings; empty shells read as blockout. */
export function buildInteriors(b: Builder, farm: InstanceFarm, rng: Rand): void {
  // --- Bakery: the interior pose looks west through the cross-wall opening.
  const bY = groundHeight(-16.5, 5.75) + 0.04
  // East room: counter, oven, shelves and sacks of flour.
  b.push(-11.6, bY, 2.4, -Math.PI / 2)
  b.solid('woodPlank', 3.4, 0.94, 0.72, 0, 0.47, 0, 0, 0.02, 'wood')
  b.box('stoneBlock', 3.5, 0.07, 0.8, 0, 0.97, 0, 0, 0.02)
  b.pop()
  // Bread oven with an arched mouth and a flue.
  b.push(-11.4, bY, 9.4, 0)
  b.solid('brickRed', 2.0, 1.9, 1.5, 0, 0.95, 0, 0, 0.03)
  b.box('concreteRubble', 0.85, 0.7, 0.4, 0, 0.85, -0.78, 0, 0.05)
  b.geom('metalRusted', cylinderGeom(0.19, 0.22, 1.4, 10), xform(0.6, 2.6, 0))
  b.geom('plasterDamaged', decalQuad(1.6, 1.0, 0.2, 8), xform(0, 1.5, -0.77))
  b.pop()
  for (let i = 0; i < 5; i++) {
    farm.place('sack', -12.5 + rng.spread(0.7), bY + 0.18, 4.6 + i * 0.55 + rng.spread(0.2), rng.range(0, 3.1), rng.range(0.9, 1.15))
  }
  farm.place('table', -13.6, bY, 6.6, 0.4)
  farm.place('chair', -14.4, bY, 7.4, 2.1)
  farm.place('chair', -12.9, bY, 7.6, 5.4)
  farm.place('crateM', -10.6, bY + 0.31, 11.0, 0.6)
  farm.place('crateS', -10.6, bY + 0.84, 11.0, 1.4)
  farm.place('basket', -10.9, bY + 0.15, 6.0, 0.9)
  // Shelving on the east wall.
  b.push(-10.05, bY, 6.6, -Math.PI / 2)
  for (let i = 0; i < 3; i++) {
    b.plate('woodPlank', 2.6, 0.045, 0.34, 0, 0.9 + i * 0.55, 0.16)
    for (let k = 0; k < 5; k++) {
      if (rng.bool(0.65)) {
        b.geom(rng.pick<MaterialName>(['metalPainted', 'woodPainted', 'glassDirty']),
          cylinderGeom(0.055, 0.06, rng.range(0.16, 0.3), 6), xform(-1.1 + k * 0.55, 1.05 + i * 0.55, 0.16))
      }
    }
  }
  b.pop()

  // --- West room: the pose's midground and background.
  const wt = groundHeight(-19.8, 8.2) + 0.04
  farm.place('table', -19.8, wt, 8.2, 0.18)
  farm.place('chair', -18.7, wt, 8.9, 2.6)
  farm.place('chair', -20.7, wt, 7.1, 5.9)
  b.geom('metalPainted', cylinderGeom(0.11, 0.09, 0.07, 12), xform(-19.6, wt + 0.78, 8.1))
  b.geom('glassDirty', cylinderGeom(0.038, 0.045, 0.26, 8), xform(-20.2, wt + 0.87, 8.4))
  b.geom('woodPainted', cylinderGeom(0.07, 0.075, 0.13, 10), xform(-19.9, wt + 0.8, 8.6))
  // Rug, worn through in the middle.
  b.geom('tarp', decalQuad(2.9, 2.1, 0.06, 12), xform(-19.6, wt + 0.012, 8.6, 0, -Math.PI / 2))
  // Cupboard against the west wall, doors ajar.
  b.push(-22.6, wt, 5.4, Math.PI / 2)
  b.solid('woodPainted', 1.5, 1.85, 0.5, 0, 0.93, 0, 0, 0.02, 'wood')
  b.box('woodPainted', 0.7, 1.5, 0.04, -0.36, 1.0, -0.28, -0.55, 0.01)
  b.box('woodPainted', 1.55, 0.06, 0.58, 0, 1.88, 0, 0, 0.02)
  b.pop()
  // Mattress and blankets in the corner.
  b.box('fabricAwning', 1.95, 0.16, 1.05, -21.4, wt + 0.08, 10.4, 0.25, 0.06)
  b.geom('tarp', clothQuad(
    new THREE.Vector3(-22.2, wt + 0.19, 10.0), new THREE.Vector3(-20.6, wt + 0.17, 10.2),
    new THREE.Vector3(-20.5, wt + 0.16, 10.9), new THREE.Vector3(-22.3, wt + 0.18, 10.8),
    -0.06, 0.03, 5, 4, 3))
  farm.place('crateL', -22.4, wt + 0.36, 2.4, 0.2)
  farm.place('crateS', -21.4, wt + 0.22, 2.6, 1.1)
  farm.place('bucket', -18.4, wt + 0.14, 11.2, 0.8)
  // A toppled chair in the near foreground of the pose.
  farm.place('chair', -15.4, wt + 0.2, 6.7, 1.2, 1, 1.45, 0.2)
  // Bare bulbs on flex, one still hanging over the table.
  for (const [lx, lz] of [[-19.9, 8.2], [-13.4, 7.0]] as [number, number][]) {
    b.geom('metalPainted', cylinderGeom(0.005, 0.005, 0.75, 4), xform(lx, wt + 2.55, lz))
    b.geom('glass', sphereGeom(0.055, 8, 6), xform(lx, wt + 2.16, lz))
    b.geom('metalPainted', cylinderGeom(0.02, 0.025, 0.06, 8), xform(lx, wt + 2.23, lz))
  }
  // Plaster fallen from the ceiling.
  for (let i = 0; i < 14; i++) {
    const px = -22.8 + rng.range(0, 12.6)
    const pz = 0.2 + rng.range(0, 11.2)
    farm.place(`chunk${rng.int(0, 3)}`, px, wt + 0.05, pz, rng.range(0, 3.1), rng.range(0.5, 1.1))
  }

  // --- Apartment: living space above the shop.
  const aY = groundHeight(-15.75, 25) + 0.04
  farm.place('table', -13.6, aY, 27.6, 1.3)
  farm.place('chair', -13.0, aY, 28.6, 3.6)
  farm.place('chair', -14.6, aY, 26.7, 0.4)
  b.box('fabricAwning', 2.1, 0.42, 0.85, -19.0, aY + 0.21, 27.8, 0.05, 0.12)
  b.box('fabricAwning', 2.1, 0.3, 0.35, -19.3, aY + 0.6, 28.1, 0.05, 0.1)
  farm.place('crateL', -19.6, aY + 0.36, 22.0, 0.9)
  farm.place('crateM', -18.4, aY + 0.31, 21.6, 2.2)
  farm.place('barrelRust', -12.0, aY + 0.44, 20.4, 0.6)
  b.geom('tarp', decalQuad(2.6, 1.9, 0.07, 22), xform(-14.4, aY + 0.012, 27.4, 0, -Math.PI / 2))
  b.push(-20.4, aY, 23.6, Math.PI / 2)
  b.solid('woodPainted', 1.3, 1.7, 0.45, 0, 0.85, 0, 0, 0.02, 'wood')
  b.box('metalPainted', 0.6, 0.45, 0.4, 0, 1.92, 0, 0.3, 0.02)
  b.pop()
  for (let i = 0; i < 10; i++) {
    farm.place(`chunk${rng.int(0, 3)}`, -20.5 + rng.range(0, 9.5), aY + 0.05, 19 + rng.range(0, 12), rng.range(0, 3.1), rng.range(0.5, 1.0))
  }

  // --- East block ground floor: a stripped shop.
  const eY = groundHeight(12.35, 13.25) + 0.04
  b.push(11.4, eY, 9.6, 0)
  b.solid('woodPlank', 2.8, 0.9, 0.62, 0, 0.45, 0, 0, 0.02, 'wood')
  b.pop()
  farm.place('crateM', 13.6, eY + 0.31, 10.4, 0.5)
  farm.place('crateS', 13.6, eY + 0.84, 10.4, 1.9)
  farm.place('crateL', 10.6, eY + 0.36, 16.2, 2.4)
  farm.place('barrelBlue', 13.8, eY + 0.44, 17.4, 0)
  farm.place('pallet', 11.0, eY + 0.05, 18.2, 0.7)
  farm.place('tyre', 13.4, eY + 0.13, 12.2, 1.1)
  for (let i = 0; i < 12; i++) {
    farm.place(`chunk${rng.int(0, 3)}`, 9.6 + rng.range(0, 5.2), eY + 0.05, 7.6 + rng.range(0, 11), rng.range(0, 3.1), rng.range(0.5, 1.1))
  }

  // --- Market hall: trestle tables and produce, lit through the arches.
  const mY = groundHeight(19.75, 16.25) + 0.04
  for (let i = 0; i < 4; i++) {
    const tz = 12.2 + i * 2.5
    farm.place('table', 17.8, mY, tz, 0)
    farm.place('table', 21.7, mY, tz, 0)
    for (let k = 0; k < 3; k++) {
      farm.place('basket', 17.4 + k * 0.42, mY + 0.9, tz + rng.spread(0.2), rng.range(0, 3.1), 0.8)
      farm.place('basket', 21.3 + k * 0.42, mY + 0.9, tz + rng.spread(0.2), rng.range(0, 3.1), 0.8)
    }
  }
  for (let i = 0; i < 26; i++) {
    b.geom(rng.pick<MaterialName>(['foliage', 'woodPainted', 'fabricAwning']),
      sphereGeom(rng.range(0.05, 0.09), 6, 4),
      xform(17.3 + rng.range(0, 4.8), mY + 0.86, 11.8 + rng.range(0, 8.4)))
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface StallSite { x: number; z: number; yaw: number; w?: number }

/** Hand-composed market: two loose rows framing the plaza pose's sightline. */
const STALLS: StallSite[] = [
  { x: -6.6, z: -8.7, yaw: -2.42, w: 3.0 },
  { x: 1.2, z: -8.6, yaw: -0.9 },
  { x: -13.6, z: -11.4, yaw: 1.9 },
  { x: -13.2, z: -19.2, yaw: 2.2, w: 3.1 },
  { x: -5.2, z: -17.6, yaw: -1.5 },
  { x: -17.8, z: -22.6, yaw: 0.3 },
  { x: -20.2, z: -15.0, yaw: 1.6 },
  { x: -8.6, z: -23.4, yaw: -0.2, w: 3.2 },
  { x: 1.6, z: -20.4, yaw: -1.7 },
  { x: -18.6, z: -6.4, yaw: 2.6 },
  // Market street, in front of the apartment shopfront.
  { x: -8.8, z: 20.4, yaw: -1.5 },
  { x: -8.6, z: 25.2, yaw: -1.5, w: 3.0 },
  { x: -2.0, z: 31.4, yaw: 1.4 },
]

/** Everything hand-placed for a specific composition. */
export function buildSetPieces(b: Builder, farm: InstanceFarm, rng: Rand): void {
  for (const s of STALLS) buildStall(b, farm, rng, s.x, s.z, s.yaw, s.w ?? 2.6)
  buildFountain(b, farm, rng, -9.0, -14.0)

  // Wrecks.
  buildWreckCar(b, rng, -3.2, 22.6, 0.62) // firefight midground
  buildWreckCar(b, rng, 7.05, 27.4, 0.16) // alley midground
  buildWreckCar(b, rng, 14.4, -3.0, 2.4)
  buildWreckBus(b, 17.2, 31.4, 0.34, rng)

  // Cover along the graded sightlines.
  buildEmplacement(b, farm, rng, 6.9, 12.4, 0.05, 2.0, 4, 0.18)
  buildEmplacement(b, farm, rng, -5.4, 27.8, -0.35, 3.2, 5, 0.25)
  buildEmplacement(b, farm, rng, -1.0, 15.4, 1.9, 2.4, 4, 0.2)
  // Sandbags flanking the breach in the market hall's south parapet — the
  // vista pose looks straight through the gap between them.
  const deckTop = groundHeight(19.75, 16.25) + 0.04 + 2.8 + 0.84
  buildEmplacement(b, farm, rng, 23.1, 21.5, 0.0, 1.3, 2, 0.05, deckTop)
  buildEmplacement(b, farm, rng, 17.4, 21.5, 0.0, 2.0, 2, 0.05, deckTop)
  // Spent casings and an ammo crate at the firing position.
  farm.place('ammoBox', 22.2, deckTop - 0.66, 20.4, 0.4)
  farm.place('crateS', 16.6, deckTop - 0.62, 20.0, 1.2)
  buildEmplacement(b, farm, rng, 23.6, 28.9, -0.35, 3.4, 4, 0.22) // checkpoint
  buildEmplacement(b, farm, rng, -12.5, -3.4, 0.15, 2.8, 4, 0.2)

  // Awnings over the shopfronts that face the graded cameras. The anchor sits
  // on the wall plane; the canvas projects along the facade's outward normal.
  buildAwning(b, -10.48, groundHeight(-10.5, 21) + 2.75, 21.0, -Math.PI / 2, 3.4, 1.5, 'fabricAwning')
  buildAwning(b, -10.48, groundHeight(-10.5, 27.5) + 2.7, 27.5, -Math.PI / 2, 2.8, 1.3, 'tarp', 0.1)
  buildAwning(b, -16.4, groundHeight(-16.4, -0.6) + 2.8, -0.54, 0, 4.2, 1.7, 'fabricAwning')
  buildAwning(b, 5.02, groundHeight(5, 29) + 2.65, 29.0, -Math.PI / 2, 3.0, 1.4, 'tarp')
  buildAwning(b, 9.18, groundHeight(9.2, 15.5) + 2.8, 15.5, Math.PI / 2, 3.2, 1.5, 'fabricAwning')
  buildAwning(b, 5.02, groundHeight(5, 15.8) + 2.9, 15.8, -Math.PI / 2, 2.4, 1.2, 'tarp', 0.09)
  buildAwning(b, 12.0, groundHeight(12.0, -4.0) + 2.9, -3.96, Math.PI, 3.6, 1.6, 'fabricAwning')

  // Signage on the same frontages.
  buildSign(b, rng, -10.44, groundHeight(-10.5, 23.6) + 3.55, 23.6, -Math.PI / 2, 2.6, 0.62, 'metalPainted', 'plasterWhite')
  buildSign(b, rng, -16.2, groundHeight(-16.2, -0.6) + 3.5, -0.56, 0, 3.2, 0.7, 'woodPainted', 'plasterOchre')
  buildSign(b, rng, 9.26, groundHeight(9.2, 17.6) + 3.4, 17.6, Math.PI / 2, 2.2, 0.55, 'metalRusted', 'plasterWhite')
  buildSign(b, rng, 5.06, groundHeight(5, 30.5) + 3.35, 30.5, -Math.PI / 2, 2.4, 0.58, 'metalPainted', 'brickRed')
  buildSign(b, rng, 22.4, groundHeight(22.4, 38.9) + 3.6, 38.9, 0, 4.0, 0.8, 'woodPainted', 'plasterWhite')

  // Road furniture on the highway.
  b.push(24.6, groundHeight(24.6, 26.4), 26.4, -0.349 + Math.PI)
  b.geom('metalPainted', cylinderGeom(0.05, 0.055, 2.6, 8), xform(0, 1.3, 0))
  b.collide(0.3, 2.6, 0.3, 0, 1.3, 0, 0, 'metal')
  b.box('metalPainted', 1.5, 0.9, 0.05, 0, 2.35, 0, 0, 0.015)
  b.pop()
  buildSign(b, rng, 24.6, groundHeight(24.6, 26.4) + 2.35, 26.35, -0.349 + Math.PI, 1.4, 0.8, 'metalPainted', 'plasterWhite')

  // Checkpoint hut by the road.
  b.push(28.2, groundHeight(28.2, 34.6), 34.6, -0.349)
  b.solid('metalCorrugated', 2.2, 2.5, 2.0, 0, 1.25, 0, 0, 0.03, 'thinMetal')
  b.box('metalCorrugated', 2.5, 0.09, 2.3, 0, 2.55, 0, 0, 0.03)
  b.box('glassDirty', 1.2, 0.8, 0.05, 0, 1.7, -1.01, 0, 0.01)
  b.box('woodPainted', 0.9, 2.05, 0.06, 0.5, 1.02, 1.0, 0, 0.015)
  b.pop()
}

/**
 * Scattered clutter. Deterministic rejection sampling over the open ground,
 * biased toward wall bases and corners the way real rubbish accumulates.
 */
export function scatterClutter(b: Builder, farm: InstanceFarm, rng: Rand, density: number): void {
  const kinds = [
    'crateS', 'crateM', 'crateL', 'barrelRust', 'barrelBlue', 'drumShort', 'pallet',
    'tyre', 'tyreBig', 'cone', 'gasBottle', 'bucket', 'sack', 'basket', 'cinder',
    'spool', 'chair', 'plank', 'sheet', 'rebar',
  ]
  const clusters: [number, number, number][] = [
    [6.9, 20.4, 3.0], [7.4, 31.5, 2.6], [-6.5, 17.5, 3.4], [-7.5, 31.0, 3.6],
    [-2.5, 12.0, 3.6], [2.5, 8.5, 3.0], [-11.5, -2.5, 3.4], [3.4, -3.0, 3.0],
    [12.5, 24.5, 4.2], [21.0, 26.0, 4.4], [24.0, 33.0, 4.0], [16.0, 36.5, 4.0],
    [-19.0, 16.5, 3.4], [-22.5, 30.5, 3.6], [-26.0, -3.0, 3.2], [-24.5, -24.0, 3.4],
    [6.0, -14.0, 3.0], [-2.0, -27.0, 3.4], [-27.5, 12.0, 3.2], [11.0, 40.0, 4.0],
    [30.5, 12.0, 3.6], [-13.0, 36.0, 3.4], [1.0, 38.0, 3.6], [19.5, 9.0, 3.0],
  ]
  const total = Math.round(320 * density)
  let placed = 0
  let guard = 0
  while (placed < total && guard < total * 30) {
    guard++
    const c = clusters[Math.floor(rng.next() * clusters.length)]
    const a = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(rng.next()) * c[2]
    const x = c[0] + Math.cos(a) * r
    const z = c[1] + Math.sin(a) * r
    if (insideAnyBuilding(x, z, 0.35)) continue
    const y = groundHeight(x, z)
    const kind = kinds[Math.floor(rng.next() * kinds.length)]
    const yaw = rng.range(0, Math.PI * 2)
    const tilt = rng.bool(0.18) ? rng.spread(0.35) : rng.spread(0.05)
    let lift = 0.32
    switch (kind) {
      case 'crateS': lift = 0.22; break
      case 'crateM': lift = 0.31; break
      case 'crateL': lift = 0.36; break
      case 'barrelRust': case 'barrelBlue': lift = 0.44; break
      case 'drumShort': lift = 0.3; break
      case 'pallet': lift = 0.05; break
      case 'tyre': lift = 0.13; break
      case 'tyreBig': lift = 0.18; break
      case 'cone': lift = 0.0; break
      case 'gasBottle': lift = 0.29; break
      case 'bucket': lift = 0.14; break
      case 'sack': lift = 0.17; break
      case 'basket': lift = 0.15; break
      case 'cinder': lift = 0.1; break
      case 'spool': lift = 0.62; break
      case 'chair': lift = 0.0; break
      case 'plank': lift = 0.03; break
      case 'sheet': lift = 0.02; break
      case 'rebar': lift = 0.03; break
      default: lift = 0.3
    }
    farm.place(kind, x, y + lift, z, yaw, rng.range(0.9, 1.08), tilt, rng.spread(0.06))
    // Only the objects big enough to matter get collision.
    if (kind === 'crateL' || kind === 'crateM' || kind === 'barrelRust' || kind === 'barrelBlue' || kind === 'spool') {
      b.collide(0.8, 0.85, 0.8, x, y + 0.42, z, yaw, kind === 'spool' ? 'wood' : 'metal')
    }
    placed++
  }

  // Jersey barriers and HESCO in deliberate lines, not scattered.
  const barrierRuns: [number, number, number, number][] = [
    [2.6, 10.6, -0.25, 3], [8.6, 9.6, 0.2, 2], [-2.4, 16.8, 1.35, 3],
    [21.6, 27.2, -0.349, 4], [26.4, 32.4, -0.349 + Math.PI, 3],
    [-6.0, 12.2, 1.6, 2], [12.6, 22.4, 0.1, 3], [-16.0, -1.8, 0.0, 2],
  ]
  for (const [x, z, yaw, n] of barrierRuns) {
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 1.62
      const p = rot(off, 0, yaw)
      const px = x + p.x
      const pz = z + p.z
      const y = groundHeight(px, pz)
      farm.place('jersey', px, y - 0.02, pz, yaw + rng.spread(0.05))
      b.collide(1.6, 0.95, 0.62, px, y + 0.45, pz, yaw, 'concrete')
    }
  }
  for (const [x, z, yaw, n] of [[22.9, 30.2, -0.349, 3], [10.4, 20.0, 0.1, 2]] as [number, number, number, number][]) {
    for (let i = 0; i < n; i++) {
      const p = rot((i - (n - 1) / 2) * 1.04, 0, yaw)
      const px = x + p.x
      const pz = z + p.z
      const y = groundHeight(px, pz)
      farm.place('hesco', px, y + 0.5, pz, yaw)
      b.collide(1.05, 1.05, 1.05, px, y + 0.5, pz, yaw, 'fabric')
    }
  }

  // Stacked crates and drums that read as deliberate cover.
  const stacks: [number, number][] = [
    [4.4, 11.4], [8.5, 16.2], [-9.4, 30.2], [-4.6, 13.6], [13.4, 25.6],
    [-14.6, -25.5], [2.8, -12.0], [25.4, 24.6], [-23.4, 6.5], [5.6, 33.4],
  ]
  for (const [x, z] of stacks) {
    const y = groundHeight(x, z)
    const yaw = rng.range(0, Math.PI * 2)
    farm.place('pallet', x, y + 0.05, z, yaw)
    farm.place('crateL', x, y + 0.5, z, yaw + rng.spread(0.1))
    if (rng.bool(0.7)) farm.place('crateM', x + rng.spread(0.2), y + 1.18, z + rng.spread(0.2), yaw + rng.spread(0.6))
    if (rng.bool(0.45)) farm.place('crateS', x + rng.spread(0.25), y + 1.72, z + rng.spread(0.25), yaw + rng.spread(0.9))
    b.collide(1.3, 1.5, 0.95, x, y + 0.75, z, yaw, 'wood')
  }

  // Wall-mounted air conditioners. `yaw` points the condenser fan away from
  // the facade; the unit hangs 0.18 m proud of the wall plane.
  const acs: [number, number, number][] = [
    [-10.32, 19.2, Math.PI / 2], [-10.32, 26.4, Math.PI / 2],
    [9.02, 12.4, -Math.PI / 2], [9.02, 18.2, -Math.PI / 2],
    [5.18, 27.4, Math.PI / 2], [-9.32, 3.2, Math.PI / 2],
    [4.82, -7.4, -Math.PI / 2], [4.82, -21.0, -Math.PI / 2],
    [-24.82, -20.0, Math.PI / 2], [1.32, 15.0, -Math.PI / 2],
  ]
  for (const [x, z, yaw] of acs) {
    const y = groundHeight(x, z) + rng.range(2.9, 4.6)
    farm.place('acUnit', x, y, z, yaw)
    b.push(x, y, z, yaw)
    b.box('metalRusted', 0.5, 0.5, 0.06, 0, -0.35, -0.2, 0, 0.012)
    b.geom('dirt', decalQuad(0.5, 1.6, 0.24, 33), xform(0, -1.15, -0.2))
    b.pop()
  }
}

/** Torn posters and stencils pasted at eye height along the busy frontages. */
export function buildPosters(b: Builder, rng: Rand): void {
  // Anchors sit exactly on a wall plane; the decal's own 14 mm offset puts it
  // just proud of the render.
  const walls: [number, number, number][] = [
    [-10.5, 20.0, -Math.PI / 2], [-10.5, 23.2, -Math.PI / 2], [-10.5, 29.4, -Math.PI / 2],
    [9.2, 10.4, Math.PI / 2], [9.2, 14.2, Math.PI / 2], [9.2, 17.4, Math.PI / 2],
    [5.0, 26.0, -Math.PI / 2], [5.0, 31.2, -Math.PI / 2], [1.5, 14.6, Math.PI / 2],
    [-9.5, 4.2, -Math.PI / 2], [-9.5, 8.6, -Math.PI / 2], [5.0, -9.0, Math.PI / 2],
    [-16.4, -0.5, 0], [-13.0, -0.5, 0], [-25.0, -18.0, -Math.PI / 2],
    [9.21, 26.6, Math.PI / 2], [9.21, 31.0, Math.PI / 2],
  ]
  for (const [x, z, yaw] of walls) {
    const y = groundHeight(x, z) + rng.range(1.1, 2.2)
    const w = rng.range(0.5, 0.9)
    const h = rng.range(0.65, 1.15)
    b.push(x, y, z, yaw)
    b.geom(rng.pick<MaterialName>(['plasterWhite', 'fabricAwning', 'woodPainted']),
      decalQuad(w, h, 0.1, x * 3 + z), xform(0, 0, -0.014))
    b.geom('plasterDamaged', decalQuad(w * 0.45, h * 0.3, 0.35, z * 5), xform(rng.spread(w * 0.2), -h * 0.3, -0.017))
    if (rng.bool(0.5)) {
      b.geom(rng.pick<MaterialName>(['plasterWhite', 'tarp']),
        decalQuad(w * 0.8, h * 0.8, 0.16, x * 7), xform(rng.spread(0.35), rng.spread(0.3), -0.02))
    }
    b.pop()
  }
}

export { rockGeom, extrudeProfile }
