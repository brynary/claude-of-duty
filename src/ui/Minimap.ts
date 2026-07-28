import * as THREE from 'three'
import type { PhysicsService, Surface } from '../core/Types'
import { el } from './Style'

export interface Contact {
  x: number
  z: number
  /** 0..1 fade. */
  strength: number
}

/** Metres visible from the centre of the map to its edge. */
const VIEW_RADIUS = 30
/** Longest side of the baked map texture, in pixels. */
const MAX_TEXTURE = 640
/** Most rays cast along one axis when baking the heightfield. */
const MAX_SAMPLES = 128

const SURFACE_COLOUR: Partial<Record<Surface, [number, number, number]>> = {
  concrete: [38, 41, 42],
  metal: [40, 44, 47],
  thinMetal: [43, 46, 48],
  wood: [47, 37, 27],
  dirt: [47, 39, 29],
  sand: [58, 51, 37],
  gravel: [39, 39, 37],
  glass: [32, 45, 50],
  fabric: [50, 45, 35],
  plaster: [52, 50, 45],
  tile: [46, 40, 36],
  rubber: [28, 29, 30],
  foliage: [30, 42, 30],
  water: [16, 35, 45],
  flesh: [56, 35, 32],
}

/**
 * Top-down tactical map. The level is sampled once at init with downward
 * raycasts into a height + surface grid, painted into an off-screen texture,
 * then blitted rotated around the player every frame. Enemies only appear once
 * they fire, and decay — the map never gives the fight away for free.
 */
export class Minimap {
  readonly root: HTMLDivElement

  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private map = document.createElement('canvas')
  private origin = new THREE.Vector2()
  private extent = new THREE.Vector2(1, 1)
  private baked = false

  private size = 1
  private unit = 1

  constructor(parent: HTMLElement) {
    this.root = el('div', 'minimap', parent)
    const tag = el('div', 'minimap-tag', this.root)
    const b = el('b', '', tag)
    b.textContent = 'SECTOR 07'
    const frame = el('div', 'minimap-frame', this.root)
    this.canvas = el('canvas', '', frame)
    this.g = this.canvas.getContext('2d')!
  }

  layout(scale: number, dpr: number): void {
    this.unit = scale * dpr
    this.size = Math.max(2, Math.round(186 * this.unit))
    this.canvas.width = this.size
    this.canvas.height = this.size
  }

  /**
   * Bakes the level silhouette. Called once, after the level and physics have
   * registered — roughly 16k raycasts, ~20ms, and never touched again.
   */
  bake(physics: PhysicsService, bounds: THREE.Box3): void {
    const min = bounds.min
    const max = bounds.max
    const sizeX = Math.max(1, max.x - min.x)
    const sizeZ = Math.max(1, max.z - min.z)
    this.origin.set(min.x, min.z)
    this.extent.set(sizeX, sizeZ)

    const nx = Math.min(MAX_SAMPLES, Math.max(24, Math.round(sizeX / 0.6)))
    const nz = Math.min(MAX_SAMPLES, Math.max(24, Math.round(sizeZ / 0.6)))
    const heights = new Float32Array(nx * nz)
    const surfaces: Surface[] = new Array(nx * nz)

    const origin = new THREE.Vector3()
    const down = new THREE.Vector3(0, -1, 0)
    const top = max.y + 6
    const reach = top - min.y + 12
    const groundY = Math.min(0, min.y)

    for (let j = 0; j < nz; j++) {
      const z = min.z + ((j + 0.5) / nz) * sizeZ
      for (let i = 0; i < nx; i++) {
        const x = min.x + ((i + 0.5) / nx) * sizeX
        origin.set(x, top, z)
        let h = -1e3
        let surf: Surface = 'concrete'
        try {
          const hit = physics.raycast(origin, down, reach, { characters: false })
          if (hit) {
            h = hit.point.y
            surf = hit.surface
          }
        } catch {
          h = -1e3
        }
        heights[j * nx + i] = h
        surfaces[j * nx + i] = surf
      }
    }

    const cell = Math.max(2, Math.floor(MAX_TEXTURE / Math.max(nx, nz)))
    this.map.width = nx * cell
    this.map.height = nz * cell
    const g = this.map.getContext('2d')!
    g.clearRect(0, 0, this.map.width, this.map.height)

    // Pass 1 — flat fill per cell, tinted by surface and lifted by height.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i]
        if (h < -900) continue
        const base = SURFACE_COLOUR[surfaces[j * nx + i]] ?? SURFACE_COLOUR.concrete!
        const rise = Math.min(Math.max(h - groundY, 0), 9) / 9
        const lift = 1 + rise * 0.9
        const r = Math.min(255, base[0] * lift)
        const gr = Math.min(255, base[1] * lift)
        const b = Math.min(255, base[2] * lift + rise * 10)
        g.fillStyle = `rgb(${r | 0},${gr | 0},${b | 0})`
        g.fillRect(i * cell, j * cell, cell, cell)
      }
    }

    // Pass 2 — bevel the height discontinuities so buildings read as volumes.
    g.lineWidth = Math.max(1, cell * 0.25)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i]
        if (h < -900) continue
        const hw = i > 0 ? heights[j * nx + i - 1] : h
        const hn = j > 0 ? heights[(j - 1) * nx + i] : h
        const x = i * cell
        const y = j * cell
        if (h - hw > 0.8) {
          g.strokeStyle = 'rgba(226,232,224,.30)'
          g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + cell); g.stroke()
        } else if (hw - h > 0.8) {
          g.strokeStyle = 'rgba(0,0,0,.42)'
          g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + cell); g.stroke()
        }
        if (h - hn > 0.8) {
          g.strokeStyle = 'rgba(226,232,224,.30)'
          g.beginPath(); g.moveTo(x, y + 0.5); g.lineTo(x + cell, y + 0.5); g.stroke()
        } else if (hn - h > 0.8) {
          g.strokeStyle = 'rgba(0,0,0,.42)'
          g.beginPath(); g.moveTo(x, y + 0.5); g.lineTo(x + cell, y + 0.5); g.stroke()
        }
      }
    }

    // Pass 3 — a faint 10 m survey grid.
    g.strokeStyle = 'rgba(154,196,138,.07)'
    g.lineWidth = 1
    const ppm = this.map.width / sizeX
    for (let m = Math.ceil(min.x / 10) * 10; m < max.x; m += 10) {
      const x = Math.round((m - min.x) * ppm) + 0.5
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.map.height); g.stroke()
    }
    const ppmZ = this.map.height / sizeZ
    for (let m = Math.ceil(min.z / 10) * 10; m < max.z; m += 10) {
      const y = Math.round((m - min.z) * ppmZ) + 0.5
      g.beginPath(); g.moveTo(0, y); g.lineTo(this.map.width, y); g.stroke()
    }

    this.baked = true
  }

  update(px: number, pz: number, yaw: number, contacts: Contact[], contactCount: number): void {
    const g = this.g
    const s = this.size
    const c = s / 2
    const scale = c / VIEW_RADIUS
    const u = this.unit

    g.clearRect(0, 0, s, s)
    g.fillStyle = 'rgba(11,14,13,.86)'
    g.fillRect(0, 0, s, s)

    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)

    if (this.baked) {
      g.save()
      g.translate(c, c)
      g.rotate(yaw)
      g.scale(scale, scale)
      g.translate(-px, -pz)
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.globalAlpha = 0.95
      g.drawImage(this.map, this.origin.x, this.origin.y, this.extent.x, this.extent.y)
      g.globalAlpha = 1
      // Playable boundary.
      g.strokeStyle = 'rgba(226,64,52,.34)'
      g.lineWidth = 1.6 / scale
      g.setLineDash([2 / scale, 2 / scale])
      g.strokeRect(this.origin.x, this.origin.y, this.extent.x, this.extent.y)
      g.setLineDash([])
      g.restore()
    }

    // Contacts, drawn in screen space so the glyphs stay upright.
    for (let i = 0; i < contactCount; i++) {
      const ct = contacts[i]
      if (ct.strength <= 0.02) continue
      const rx = ct.x - px
      const rz = ct.z - pz
      let sxp = (rx * cos - rz * sin) * scale
      let syp = (rx * sin + rz * cos) * scale
      const d = Math.hypot(sxp, syp)
      const edge = c - 7 * u
      const clamped = d > edge
      if (clamped) { sxp = (sxp / d) * edge; syp = (syp / d) * edge }
      g.save()
      g.translate(c + sxp, c + syp)
      g.rotate(Math.PI / 4)
      const r = 3.1 * u
      g.fillStyle = 'rgba(6,9,8,.65)'
      g.fillRect(-r - u, -r - u, (r + u) * 2, (r + u) * 2)
      g.fillStyle = `rgba(226,64,52,${clamped ? ct.strength * 0.55 : ct.strength})`
      g.fillRect(-r, -r, r * 2, r * 2)
      g.restore()
    }

    // View cone.
    g.save()
    g.translate(c, c)
    const cone = g.createLinearGradient(0, 0, 0, -26 * u)
    cone.addColorStop(0, 'rgba(232,236,231,.16)')
    cone.addColorStop(1, 'rgba(232,236,231,0)')
    g.fillStyle = cone
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(-12 * u, -26 * u)
    g.lineTo(12 * u, -26 * u)
    g.closePath()
    g.fill()

    // Player arrow.
    g.beginPath()
    g.moveTo(0, -6.4 * u)
    g.lineTo(4.6 * u, 5.2 * u)
    g.lineTo(0, 2.6 * u)
    g.lineTo(-4.6 * u, 5.2 * u)
    g.closePath()
    g.fillStyle = 'rgba(154,196,138,.96)'
    g.strokeStyle = 'rgba(6,9,8,.85)'
    g.lineWidth = 1.4 * u
    g.stroke()
    g.fill()
    g.restore()

    // North index on the ring, plus corner ticks.
    const nAngle = yaw - Math.PI / 2
    const nx = c + Math.cos(nAngle) * (c - 11 * u)
    const ny = c + Math.sin(nAngle) * (c - 11 * u)
    g.font = `600 ${11 * u}px 'DIN Condensed','Arial Narrow','Helvetica Neue',sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(6,9,8,.7)'
    g.fillText('N', nx + u, ny + u)
    g.fillStyle = 'rgba(232,236,231,.82)'
    g.fillText('N', nx, ny)

    const t = 9 * u
    g.strokeStyle = 'rgba(232,236,231,.5)'
    g.lineWidth = Math.max(1, 1.3 * u)
    for (let i = 0; i < 4; i++) {
      const fx = i % 2 === 0 ? 1 : -1
      const fy = i < 2 ? 1 : -1
      const ox = (i % 2 === 0 ? 0 : s) + fx * 1.5 * u
      const oy = (i < 2 ? 0 : s) + fy * 1.5 * u
      g.beginPath()
      g.moveTo(ox + fx * t, oy)
      g.lineTo(ox, oy)
      g.lineTo(ox, oy + fy * t)
      g.stroke()
    }

    // Edge falloff so the map sinks into the frame.
    const vig = g.createRadialGradient(c, c, c * 0.55, c, c, c * 1.05)
    vig.addColorStop(0, 'rgba(6,9,8,0)')
    vig.addColorStop(1, 'rgba(6,9,8,.6)')
    g.fillStyle = vig
    g.fillRect(0, 0, s, s)
  }
}
