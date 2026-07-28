import * as THREE from 'three'
import type { PhysicsService } from '../core/Types'
import type { Rand } from '../core/Rand'

/**
 * Navigation built by sampling the level with physics rays rather than by
 * pre-authoring a mesh — the level is generated procedurally, so the only
 * reliable description of where a soldier can stand is the collision world
 * itself.
 *
 * A uniform grid stores, per cell: standable or not, the ground height, and a
 * clearance value (cells to the nearest obstruction). Clearance feeds the A*
 * cost so paths favour the middle of a corridor, and it gates the string-pull
 * so smoothing never shaves a corner into a wall.
 */

const MAX_DIM = 128
/** Largest height change a soldier will step across between adjacent cells. */
const STEP_HEIGHT = 0.45
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
]

export class NavGrid {
  cols = 0
  rows = 0
  cell = 0.8
  originX = 0
  originZ = 0

  private walk!: Uint8Array
  private height!: Float32Array
  private clear!: Uint8Array

  // A* scratch, allocated once and reused. Visit stamps avoid clearing arrays.
  private gScore!: Float32Array
  private fScore!: Float32Array
  private cameFrom!: Int32Array
  private stamp!: Int32Array
  private closed!: Uint8Array
  private heap: number[] = []
  private run = 0

  private rayDown = new THREE.Vector3(0, -1, 0)
  private rayUp = new THREE.Vector3(0, 1, 0)
  private probe = new THREE.Vector3()
  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()

  build(physics: PhysicsService, bounds: THREE.Box3): void {
    const spanX = Math.max(4, bounds.max.x - bounds.min.x)
    const spanZ = Math.max(4, bounds.max.z - bounds.min.z)
    this.cell = Math.max(0.7, Math.max(spanX, spanZ) / MAX_DIM)
    this.cols = Math.min(MAX_DIM, Math.ceil(spanX / this.cell))
    this.rows = Math.min(MAX_DIM, Math.ceil(spanZ / this.cell))
    this.originX = bounds.min.x
    this.originZ = bounds.min.z

    const n = this.cols * this.rows
    this.walk = new Uint8Array(n)
    this.height = new Float32Array(n)
    this.clear = new Uint8Array(n)
    this.gScore = new Float32Array(n)
    this.fScore = new Float32Array(n)
    this.cameFrom = new Int32Array(n)
    this.stamp = new Int32Array(n)
    this.closed = new Uint8Array(n)

    const top = bounds.max.y + 2
    const drop = bounds.max.y - bounds.min.y + 6

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c
        this.probe.set(this.originX + (c + 0.5) * this.cell, top, this.originZ + (r + 0.5) * this.cell)
        const ground = physics.raycast(this.probe, this.rayDown, drop, { characters: false })
        if (!ground || ground.normal.y < 0.65) {
          this.height[i] = bounds.min.y
          continue
        }
        this.height[i] = ground.point.y
        // Head clearance: a soldier needs 1.7 m above the floor to stand.
        this.probe.set(ground.point.x, ground.point.y + 0.35, ground.point.z)
        const ceiling = physics.raycast(this.probe, this.rayUp, 1.45, { characters: false })
        this.walk[i] = ceiling ? 0 : 1
      }
    }

    this.computeClearance()
  }

  /** Standable cell count; zero means the sample pass found no world at all. */
  get walkableCount(): number {
    if (!this.walk) return 0
    let n = 0
    for (let i = 0; i < this.walk.length; i++) n += this.walk[i]
    return n
  }

  /**
   * Chebyshev distance to the nearest hazard, saturating at 8. A hazard is
   * either a blocked cell or a **height discontinuity** — the lip of a roof or
   * the top of a wall reads as perfectly standable to a downward ray, so
   * without the second rule a soldier will happily be placed on a 0.7 m ledge
   * and try to path along it.
   */
  private computeClearance(): void {
    const n = this.cols * this.rows
    const queue = new Int32Array(n * 2)
    let head = 0
    let tail = 0
    for (let i = 0; i < n; i++) {
      if (!this.walk[i]) {
        this.clear[i] = 0
        queue[tail++] = i
      } else {
        this.clear[i] = 255
      }
    }
    for (let r = 1; r < this.rows - 1; r++) {
      for (let c = 1; c < this.cols - 1; c++) {
        const i = r * this.cols + c
        if (this.clear[i] === 0) continue
        const h = this.height[i]
        for (let k = 0; k < 8; k++) {
          const j = (r + DIRS[k][1]) * this.cols + (c + DIRS[k][0])
          if (this.walk[j] && Math.abs(this.height[j] - h) <= STEP_HEIGHT) continue
          this.clear[i] = 0
          queue[tail++] = i
          break
        }
      }
    }
    // Border cells count as blocked so soldiers do not hug the world edge.
    for (let c = 0; c < this.cols; c++) {
      for (const r of [0, this.rows - 1]) {
        const i = r * this.cols + c
        if (this.clear[i] !== 0) { this.clear[i] = 0; queue[tail++] = i }
      }
    }
    for (let r = 0; r < this.rows; r++) {
      for (const c of [0, this.cols - 1]) {
        const i = r * this.cols + c
        if (this.clear[i] !== 0) { this.clear[i] = 0; queue[tail++] = i }
      }
    }
    while (head < tail) {
      const i = queue[head++]
      const d = this.clear[i]
      if (d >= 8) continue
      const c = i % this.cols
      const r = (i / this.cols) | 0
      for (let k = 0; k < 8; k++) {
        const nc = c + DIRS[k][0]
        const nr = r + DIRS[k][1]
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue
        const j = nr * this.cols + nc
        if (this.clear[j] > d + 1) {
          this.clear[j] = d + 1
          if (tail < queue.length) queue[tail++] = j
        }
      }
    }
  }

  colOf(x: number): number {
    return Math.floor((x - this.originX) / this.cell)
  }

  rowOf(z: number): number {
    return Math.floor((z - this.originZ) / this.cell)
  }

  indexOf(x: number, z: number): number {
    const c = this.colOf(x)
    const r = this.rowOf(z)
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1
    return r * this.cols + c
  }

  isWalkable(x: number, z: number): boolean {
    const i = this.indexOf(x, z)
    return i >= 0 && this.walk[i] === 1
  }

  /** Cells of headroom around a point; 0 means against a wall. */
  clearanceAt(x: number, z: number): number {
    const i = this.indexOf(x, z)
    return i >= 0 ? this.clear[i] : 0
  }

  heightAt(x: number, z: number): number {
    const i = this.indexOf(x, z)
    return i >= 0 ? this.height[i] : 0
  }

  centerOf(i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = i % this.cols
    const r = (i / this.cols) | 0
    return out.set(this.originX + (c + 0.5) * this.cell, this.height[i], this.originZ + (r + 0.5) * this.cell)
  }

  /** Nearest standable cell within `radius`, spiralling outward. */
  nearestWalkable(p: THREE.Vector3, radius: number, out: THREE.Vector3, minClearance = 1): boolean {
    const steps = Math.max(1, Math.ceil(radius / this.cell))
    const c0 = this.colOf(p.x)
    const r0 = this.rowOf(p.z)
    for (let ring = 0; ring <= steps; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue
          const c = c0 + dc
          const r = r0 + dr
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue
          const i = r * this.cols + c
          if (!this.walk[i] || this.clear[i] < minClearance) continue
          this.centerOf(i, out)
          return true
        }
      }
    }
    return false
  }

  /** A seeded standable point in an annulus around `center`. */
  randomPointNear(center: THREE.Vector3, minR: number, maxR: number, rng: Rand, out: THREE.Vector3): boolean {
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = rng.next() * Math.PI * 2
      const d = minR + rng.next() * (maxR - minR)
      this.tmpA.set(center.x + Math.cos(a) * d, center.y, center.z + Math.sin(a) * d)
      const i = this.indexOf(this.tmpA.x, this.tmpA.z)
      if (i >= 0 && this.walk[i] && this.clear[i] >= 1) {
        this.centerOf(i, out)
        return true
      }
    }
    return false
  }

  /**
   * True when a soldier can walk the straight line a→b: every sampled cell is
   * standable, has room for a body, and the floor never steps more than
   * STEP_HEIGHT between samples.
   */
  lineOfWalk(a: THREE.Vector3, b: THREE.Vector3, minClearance = 1): boolean {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const dist = Math.hypot(dx, dz)
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.5)))
    let prevH = this.heightAt(a.x, a.z)
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = a.x + dx * t
      const z = a.z + dz * t
      const i = this.indexOf(x, z)
      if (i < 0 || !this.walk[i] || this.clear[i] < minClearance) return false
      if (Math.abs(this.height[i] - prevH) > STEP_HEIGHT) return false
      prevH = this.height[i]
    }
    return true
  }

  // --- A* ------------------------------------------------------------------

  private push(i: number): void {
    const heap = this.heap
    heap.push(i)
    let n = heap.length - 1
    while (n > 0) {
      const parent = (n - 1) >> 1
      if (this.fScore[heap[parent]] <= this.fScore[heap[n]]) break
      const t = heap[parent]
      heap[parent] = heap[n]
      heap[n] = t
      n = parent
    }
  }

  private pop(): number {
    const heap = this.heap
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let n = 0
      for (;;) {
        const l = n * 2 + 1
        const r = l + 1
        let best = n
        if (l < heap.length && this.fScore[heap[l]] < this.fScore[heap[best]]) best = l
        if (r < heap.length && this.fScore[heap[r]] < this.fScore[heap[best]]) best = r
        if (best === n) break
        const t = heap[best]
        heap[best] = heap[n]
        heap[n] = t
        n = best
      }
    }
    return top
  }

  /**
   * Grid A* followed by a string pull. Returns the number of waypoints written
   * into `out`, or 0 when no route exists.
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3[], maxNodes = 3000): number {
    if (!this.cols) return 0
    if (!this.nearestWalkable(from, 3, this.tmpA)) return 0
    if (!this.nearestWalkable(to, 4, this.tmpB)) return 0
    const start = this.indexOf(this.tmpA.x, this.tmpA.z)
    const goal = this.indexOf(this.tmpB.x, this.tmpB.z)
    if (start < 0 || goal < 0) return 0

    if (start === goal) {
      out.length = 0
      out.push(this.tmpB.clone())
      return 1
    }

    this.run++
    this.heap.length = 0
    const gc = goal % this.cols
    const gr = (goal / this.cols) | 0
    const h = (i: number) => {
      const dc = Math.abs((i % this.cols) - gc)
      const dr = Math.abs(((i / this.cols) | 0) - gr)
      const lo = Math.min(dc, dr)
      return (dc + dr - 2 * lo + Math.SQRT2 * lo) * this.cell
    }

    this.gScore[start] = 0
    this.fScore[start] = h(start)
    this.stamp[start] = this.run
    this.closed[start] = 0
    this.cameFrom[start] = -1
    this.push(start)

    let expanded = 0
    let found = false
    while (this.heap.length > 0 && expanded < maxNodes) {
      const cur = this.pop()
      if (cur === goal) { found = true; break }
      if (this.closed[cur] === 1 && this.stamp[cur] === this.run) continue
      this.closed[cur] = 1
      expanded++
      const cc = cur % this.cols
      const cr = (cur / this.cols) | 0
      const ch = this.height[cur]
      for (let k = 0; k < 8; k++) {
        const nc = cc + DIRS[k][0]
        const nr = cr + DIRS[k][1]
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue
        const j = nr * this.cols + nc
        if (!this.walk[j]) continue
        if (Math.abs(this.height[j] - ch) > STEP_HEIGHT) continue
        // Do not cut a diagonal through a wall corner.
        if (DIRS[k][0] !== 0 && DIRS[k][1] !== 0) {
          if (!this.walk[cr * this.cols + nc] || !this.walk[nr * this.cols + cc]) continue
        }
        // Hugging a wall is legal but expensive, so soldiers take the open lane.
        const hug = this.clear[j] <= 1 ? 1.8 : this.clear[j] === 2 ? 0.5 : 0
        const tentative = this.gScore[cur] + DIRS[k][2] * this.cell * (1 + hug)
        if (this.stamp[j] !== this.run) {
          this.stamp[j] = this.run
          this.closed[j] = 0
          this.gScore[j] = Infinity
        }
        if (tentative < this.gScore[j]) {
          this.gScore[j] = tentative
          this.fScore[j] = tentative + h(j)
          this.cameFrom[j] = cur
          this.push(j)
        }
      }
    }

    if (!found) return 0

    // Walk the parent chain back, then string-pull it forward.
    const raw: number[] = []
    let node = goal
    while (node !== -1) {
      raw.push(node)
      if (node === start) break
      node = this.cameFrom[node]
    }
    raw.reverse()

    out.length = 0
    const p = new THREE.Vector3()
    const q = new THREE.Vector3()
    let anchor = 0
    this.centerOf(raw[0], p)
    while (anchor < raw.length - 1) {
      let far = anchor + 1
      // Capping the look-ahead keeps the string pull linear on long routes; a
      // 30-cell straight run is already far more than a soldier commits to.
      const limit = Math.min(raw.length - 1, anchor + 30)
      for (let probe = limit; probe > anchor + 1; probe--) {
        this.centerOf(raw[probe], q)
        if (this.lineOfWalk(p, q, 1)) { far = probe; break }
      }
      this.centerOf(raw[far], q)
      out.push(q.clone())
      p.copy(q)
      anchor = far
    }
    if (out.length === 0) out.push(this.tmpB.clone())
    // The final waypoint should be the requested destination, not a cell centre.
    out[out.length - 1].set(to.x, this.heightAt(to.x, to.z), to.z)
    return out.length
  }

}

/**
 * Local steering: whiskers ahead of the soldier push the desired direction away
 * from geometry, so a soldier rounding a corner slides off the wall instead of
 * grinding along it while its path says "forward".
 */
export class Steering {
  private probeDir = new THREE.Vector3()
  private right = new THREE.Vector3()
  /** Deterministic tie-break so two soldiers do not mirror into each other. */
  private bias = 1

  constructor(private physics: PhysicsService) {}

  setBias(sign: number): void {
    this.bias = sign >= 0 ? 1 : -1
  }

  private probe(origin: THREE.Vector3, dir: THREE.Vector3, len: number): number {
    const hit = this.physics.raycast(origin, dir, len, { characters: false })
    return hit ? 1 - hit.distance / len : 0
  }

  /**
   * Whiskers ahead of the soldier steer it around geometry the path did not
   * account for. It deliberately **cannot reverse** the desired heading: the
   * forward term only ever shrinks, and the correction is lateral. Pushing back
   * along a wall normal, the obvious approach, makes a soldier facing a flat
   * wall oscillate on the spot.
   *
   * @param out receives the corrected, normalised horizontal direction.
   * @returns how blocked the path ahead is, 0..1.
   */
  avoid(origin: THREE.Vector3, desired: THREE.Vector3, out: THREE.Vector3): number {
    const len = 1.6
    this.right.set(desired.z, 0, -desired.x)
    if (this.right.lengthSq() < 1e-8) {
      out.copy(desired)
      return 0
    }
    this.right.normalize()

    const ahead = this.probe(origin, desired, len)
    const angle = 0.6
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    this.probeDir.set(desired.x * cos + this.right.x * sin, 0, desired.z * cos + this.right.z * sin).normalize()
    const rightP = this.probe(origin, this.probeDir, len * 0.85)
    this.probeDir.set(desired.x * cos - this.right.x * sin, 0, desired.z * cos - this.right.z * sin).normalize()
    const leftP = this.probe(origin, this.probeDir, len * 0.85)

    // Turn toward the freer side; if both sides read the same, commit to one
    // rather than splitting the difference and walking into the corner.
    let lateral = leftP - rightP
    if (ahead > 0.08 && Math.abs(lateral) < 0.06) lateral = this.bias * ahead
    out.set(
      desired.x * (1 - ahead * 0.75) + this.right.x * lateral * 1.7,
      0,
      desired.z * (1 - ahead * 0.75) + this.right.z * lateral * 1.7,
    )
    if (out.lengthSq() < 1e-6) out.copy(desired)
    out.normalize()
    return Math.max(ahead, Math.max(leftP, rightP))
  }
}
