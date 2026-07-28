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
/** Side of the map window in design pixels — mirrors the CSS. */
const WINDOW = 186
/** Corner radius of the map window, in design pixels. */
const RADIUS = 7

type Family = 'stone' | 'earth' | 'timber' | 'green' | 'water' | 'metal'

/**
 * The fifteen physical surfaces collapse into six map families. A tactical map
 * is a diagram, not a photograph: fifteen literal colours read as noise, six
 * tightly-valued families read as terrain.
 */
const FAMILY: Record<Surface, Family> = {
  concrete: 'stone',
  plaster: 'stone',
  tile: 'stone',
  glass: 'stone',
  metal: 'metal',
  thinMetal: 'metal',
  rubber: 'metal',
  wood: 'timber',
  fabric: 'timber',
  dirt: 'earth',
  sand: 'earth',
  gravel: 'earth',
  foliage: 'green',
  water: 'water',
  flesh: 'earth',
}

/** Walkable ground. Deliberately dark and barely saturated. */
const GROUND: Record<Family, [number, number, number]> = {
  stone: [28, 31, 33],
  earth: [36, 33, 27],
  timber: [34, 30, 25],
  green: [26, 33, 28],
  water: [18, 29, 36],
  metal: [29, 32, 34],
}
/** Waist-high cover: one clear value step above the ground under it. */
const COVER: [number, number, number] = [50, 55, 58]
/** Building mass at storey height, ramping toward roof height. */
const BUILD_LO: [number, number, number] = [74, 82, 88]
const BUILD_HI: [number, number, number] = [104, 114, 121]

/** Height above local ground at which a cell stops being floor. */
const COVER_AT = 0.7
/** Height at which a cell becomes building mass rather than cover. */
const BUILD_AT = 2.4

/**
 * Top-down tactical map. The level is sampled once at init with downward
 * raycasts into a height + surface grid, painted into an off-screen texture,
 * then blitted rotated around the player every frame. Enemies only appear once
 * they fire, and decay — the map never gives the fight away for free.
 *
 * Everything static (scan lines, vignette, ring, corner brackets, scale
 * legend) is rasterised once per resolution into a second off-screen canvas
 * and composited with a single `drawImage`, so the per-frame cost is the map
 * blit, a handful of glyphs and that one composite.
 */
export class Minimap {
  readonly root: HTMLDivElement

  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private map = document.createElement('canvas')
  private chrome = document.createElement('canvas')
  private origin = new THREE.Vector2()
  private extent = new THREE.Vector2(1, 1)
  private baked = false

  private size = 1
  private unit = 1
  /** Rounded-rect mask, rebuilt on layout so the map can never square off. */
  private mask = new Path2D()
  private cone: CanvasGradient | null = null
  private halo: CanvasGradient | null = null
  /** Hoisted so the per-frame path never builds a font string. */
  private northFont = ''

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
    this.size = Math.max(2, Math.round(WINDOW * this.unit))
    this.canvas.width = this.size
    this.canvas.height = this.size
    this.mask = roundedRect(0, 0, this.size, this.size, RADIUS * this.unit)
    this.northFont = `600 ${Math.round(9.5 * this.unit)}px ${MAP_FONT}`
    this.buildChrome()

    const u = this.unit
    const cone = this.g.createLinearGradient(0, 0, 0, -30 * u)
    cone.addColorStop(0, 'rgba(196,224,186,.22)')
    cone.addColorStop(0.55, 'rgba(186,216,178,.09)')
    cone.addColorStop(1, 'rgba(180,212,172,0)')
    this.cone = cone

    const halo = this.g.createRadialGradient(0, 0, 0, 0, 0, 15 * u)
    halo.addColorStop(0, 'rgba(154,196,138,.34)')
    halo.addColorStop(0.5, 'rgba(154,196,138,.11)')
    halo.addColorStop(1, 'rgba(154,196,138,0)')
    this.halo = halo
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
    const families: Family[] = new Array(nx * nz)

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
        let fam: Family = 'stone'
        try {
          const hit = physics.raycast(origin, down, reach, { characters: false })
          if (hit) {
            h = hit.point.y
            fam = FAMILY[hit.surface] ?? 'stone'
          }
        } catch {
          h = -1e3
        }
        heights[j * nx + i] = h
        families[j * nx + i] = fam
      }
    }

    const cell = Math.max(2, Math.floor(MAX_TEXTURE / Math.max(nx, nz)))
    this.map.width = nx * cell
    this.map.height = nz * cell
    const g = this.map.getContext('2d')!
    g.clearRect(0, 0, this.map.width, this.map.height)

    // Pass 1 — three-tier value structure: floor, cover, building mass. Each
    // cell carries a couple of levels of deterministic dither so large flat
    // regions do not band.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i]
        if (h < -900) continue
        const rise = Math.min(Math.max(h - groundY, 0), 14)
        const floor = GROUND[families[j * nx + i]]
        let r: number
        let gr: number
        let b: number
        if (rise < COVER_AT) {
          r = floor[0]; gr = floor[1]; b = floor[2]
        } else if (rise < BUILD_AT) {
          const t = (rise - COVER_AT) / (BUILD_AT - COVER_AT)
          r = mix(floor[0], COVER[0], 0.45 + t * 0.4)
          gr = mix(floor[1], COVER[1], 0.45 + t * 0.4)
          b = mix(floor[2], COVER[2], 0.45 + t * 0.4)
        } else {
          const t = Math.min((rise - BUILD_AT) / 7, 1)
          r = mix(BUILD_LO[0], BUILD_HI[0], t)
          gr = mix(BUILD_LO[1], BUILD_HI[1], t)
          b = mix(BUILD_LO[2], BUILD_HI[2], t)
        }
        const d = (hash2(i, j) - 0.5) * 7
        g.fillStyle = `rgb(${clamp8(r + d)},${clamp8(gr + d)},${clamp8(b + d * 0.8)})`
        g.fillRect(i * cell, j * cell, cell, cell)
      }
    }

    // Pass 2 — a cast shadow down-and-right of anything tall, so the tiers
    // read as extruded volumes rather than as painted regions.
    g.fillStyle = 'rgba(4,7,8,.34)'
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i]
        if (h < -900) continue
        const w = i > 0 ? heights[j * nx + i - 1] : h
        const n = j > 0 ? heights[(j - 1) * nx + i] : h
        const nw = i > 0 && j > 0 ? heights[(j - 1) * nx + i - 1] : h
        if (w - h > 1.4 || n - h > 1.4 || nw - h > 1.4) {
          g.fillRect(i * cell, j * cell, cell, cell)
        }
      }
    }

    // Pass 3 — bevel the height discontinuities: a lit north-west edge, a dark
    // south-east one. This is what makes a flat diagram read as architecture.
    g.lineWidth = Math.max(1, cell * 0.3)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const h = heights[j * nx + i]
        if (h < -900) continue
        const hw = i > 0 ? heights[j * nx + i - 1] : h
        const hn = j > 0 ? heights[(j - 1) * nx + i] : h
        const x = i * cell
        const y = j * cell
        if (h - hw > 0.6) {
          g.strokeStyle = 'rgba(214,229,234,.46)'
          g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + cell); g.stroke()
        } else if (hw - h > 0.6) {
          g.strokeStyle = 'rgba(0,0,0,.5)'
          g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + cell); g.stroke()
        }
        if (h - hn > 0.6) {
          g.strokeStyle = 'rgba(214,229,234,.46)'
          g.beginPath(); g.moveTo(x, y + 0.5); g.lineTo(x + cell, y + 0.5); g.stroke()
        } else if (hn - h > 0.6) {
          g.strokeStyle = 'rgba(0,0,0,.5)'
          g.beginPath(); g.moveTo(x, y + 0.5); g.lineTo(x + cell, y + 0.5); g.stroke()
        }
      }
    }

    // Pass 4 — a 10 m survey grid, just readable enough to give scale.
    g.strokeStyle = 'rgba(152,196,186,.13)'
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

  /**
   * Rasterises everything that does not move: the scan lines, the edge
   * falloff, the range ring, the corner brackets and the scale legend.
   */
  private buildChrome(): void {
    const s = this.size
    const u = this.unit
    const c = s / 2
    this.chrome.width = s
    this.chrome.height = s
    const g = this.chrome.getContext('2d')!
    g.clearRect(0, 0, s, s)

    // Scan lines — a display, not a printout.
    g.fillStyle = 'rgba(190,224,232,.045)'
    const step = Math.max(2, Math.round(3 * u))
    const line = Math.max(1, Math.round(u))
    for (let y = 0; y < s; y += step) g.fillRect(0, y, s, line)

    // Range ring at half the view radius, plus a hairline graticule.
    g.strokeStyle = 'rgba(214,229,224,.10)'
    g.lineWidth = Math.max(1, u)
    g.beginPath()
    g.arc(c, c, c * 0.5, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = 'rgba(214,229,224,.07)'
    g.beginPath()
    g.moveTo(c, c - c * 0.5); g.lineTo(c, c - c * 0.5 - 5 * u)
    g.moveTo(c, c + c * 0.5); g.lineTo(c, c + c * 0.5 + 5 * u)
    g.moveTo(c - c * 0.5, c); g.lineTo(c - c * 0.5 - 5 * u, c)
    g.moveTo(c + c * 0.5, c); g.lineTo(c + c * 0.5 + 5 * u, c)
    g.stroke()

    // Edge falloff so the map sinks into its frame.
    const vig = g.createRadialGradient(c, c, c * 0.46, c, c, c * 1.12)
    vig.addColorStop(0, 'rgba(5,8,9,0)')
    vig.addColorStop(0.7, 'rgba(5,8,9,.32)')
    vig.addColorStop(1, 'rgba(5,8,9,.78)')
    g.fillStyle = vig
    g.fillRect(0, 0, s, s)

    // A top-edge gloss reads as glass over the display.
    const gloss = g.createLinearGradient(0, 0, 0, s * 0.3)
    gloss.addColorStop(0, 'rgba(226,240,238,.07)')
    gloss.addColorStop(1, 'rgba(226,240,238,0)')
    g.fillStyle = gloss
    g.fillRect(0, 0, s, s * 0.3)

    // Corner brackets, inset far enough that the rounded mask never eats them.
    const inset = Math.round(6 * u)
    const len = Math.round(13 * u)
    g.strokeStyle = 'rgba(226,236,228,.42)'
    g.lineWidth = Math.max(1, Math.round(1.4 * u))
    g.lineCap = 'square'
    for (let i = 0; i < 4; i++) {
      const fx = i % 2 === 0 ? 1 : -1
      const fy = i < 2 ? 1 : -1
      const ox = (i % 2 === 0 ? inset : s - inset)
      const oy = (i < 2 ? inset : s - inset)
      g.beginPath()
      g.moveTo(ox + fx * len, oy)
      g.lineTo(ox, oy)
      g.lineTo(ox, oy + fy * len)
      g.stroke()
    }

    // Scale legend, bottom-left inside the brackets. The bar is exactly ten
    // metres long at the map's fixed zoom.
    const legendY = s - Math.round(11 * u)
    const legendX = inset + Math.round(4 * u)
    const legendW = Math.round((10 * c) / VIEW_RADIUS)
    g.strokeStyle = 'rgba(226,236,228,.34)'
    g.lineWidth = Math.max(1, u)
    g.beginPath()
    g.moveTo(legendX, legendY - 3 * u); g.lineTo(legendX, legendY)
    g.lineTo(legendX + legendW, legendY); g.lineTo(legendX + legendW, legendY - 3 * u)
    g.stroke()
    g.font = `600 ${Math.round(8.5 * u)}px ${MAP_FONT}`
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = 'rgba(6,9,8,.7)'
    g.fillText('10 M', legendX + legendW + 4 * u + u, legendY + u)
    g.fillStyle = 'rgba(226,236,228,.46)'
    g.fillText('10 M', legendX + legendW + 4 * u, legendY)
  }

  update(px: number, pz: number, yaw: number, contacts: Contact[], contactCount: number): void {
    const g = this.g
    const s = this.size
    const c = s / 2
    const scale = c / VIEW_RADIUS
    const u = this.unit

    g.save()
    g.clip(this.mask)

    // Opaque base: the world must never bleed through a tactical display.
    g.fillStyle = '#0a0e10'
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
      g.drawImage(this.map, this.origin.x, this.origin.y, this.extent.x, this.extent.y)
      // Playable boundary.
      g.strokeStyle = 'rgba(226,64,52,.38)'
      g.lineWidth = 1.6 / scale
      g.setLineDash([2.5 / scale, 2.5 / scale])
      g.strokeRect(this.origin.x, this.origin.y, this.extent.x, this.extent.y)
      g.setLineDash([])
      g.restore()
    }

    // Static chrome: scan lines, ring, vignette, brackets, legend.
    g.drawImage(this.chrome, 0, 0)

    // Contacts, drawn in screen space so the glyphs stay upright.
    for (let i = 0; i < contactCount; i++) {
      const ct = contacts[i]
      if (ct.strength <= 0.02) continue
      const rx = ct.x - px
      const rz = ct.z - pz
      let sxp = (rx * cos - rz * sin) * scale
      let syp = (rx * sin + rz * cos) * scale
      const d = Math.hypot(sxp, syp)
      const edge = c - 10 * u
      const clamped = d > edge
      if (clamped) { sxp = (sxp / d) * edge; syp = (syp / d) * edge }
      g.save()
      g.translate(c + sxp, c + syp)
      g.globalAlpha = clamped ? ct.strength * 0.6 : ct.strength
      if (clamped) {
        // Off-map contacts become a chevron pointing the way out.
        g.rotate(Math.atan2(syp, sxp) + Math.PI / 2)
        g.beginPath()
        g.moveTo(0, -4.6 * u)
        g.lineTo(3.9 * u, 3 * u)
        g.lineTo(-3.9 * u, 3 * u)
        g.closePath()
      } else {
        g.rotate(Math.PI / 4)
        const r = 3.3 * u
        g.beginPath()
        g.rect(-r, -r, r * 2, r * 2)
      }
      g.fillStyle = 'rgba(226,64,52,.95)'
      g.strokeStyle = 'rgba(6,9,8,.9)'
      g.lineWidth = Math.max(1, 1.6 * u)
      g.stroke()
      g.fill()
      g.globalAlpha = 1
      g.restore()
    }

    // Player: view cone, then a soft halo, then the arrow.
    g.save()
    g.translate(c, c)
    if (this.cone) {
      g.fillStyle = this.cone
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(-13 * u, -30 * u)
      g.lineTo(13 * u, -30 * u)
      g.closePath()
      g.fill()
    }
    if (this.halo) {
      g.fillStyle = this.halo
      g.fillRect(-15 * u, -15 * u, 30 * u, 30 * u)
    }
    g.beginPath()
    g.moveTo(0, -7.8 * u)
    g.lineTo(5.6 * u, 6.2 * u)
    g.lineTo(0, 3 * u)
    g.lineTo(-5.6 * u, 6.2 * u)
    g.closePath()
    g.strokeStyle = 'rgba(5,8,7,.92)'
    g.lineWidth = Math.max(1.5, 2.2 * u)
    g.lineJoin = 'round'
    g.stroke()
    g.fillStyle = 'rgba(178,222,158,.98)'
    g.fill()
    // A lit leading edge so the arrow has a direction at a glance.
    g.beginPath()
    g.moveTo(-5.6 * u, 6.2 * u)
    g.lineTo(0, -7.8 * u)
    g.lineTo(5.6 * u, 6.2 * u)
    g.strokeStyle = 'rgba(238,252,228,.75)'
    g.lineWidth = Math.max(1, u)
    g.stroke()
    g.restore()

    // North index: a pip on the range ring rather than a letter adrift in the
    // middle of the map.
    const nAngle = yaw - Math.PI / 2
    const nr = c - 13 * u
    const nx = c + Math.cos(nAngle) * nr
    const ny = c + Math.sin(nAngle) * nr
    g.save()
    g.translate(nx, ny)
    g.rotate(nAngle + Math.PI / 2)
    g.beginPath()
    g.moveTo(0, -4.4 * u)
    g.lineTo(2.9 * u, 1.4 * u)
    g.lineTo(-2.9 * u, 1.4 * u)
    g.closePath()
    g.strokeStyle = 'rgba(6,9,8,.85)'
    g.lineWidth = Math.max(1, 1.4 * u)
    g.stroke()
    g.fillStyle = 'rgba(232,238,231,.9)'
    g.fill()
    g.restore()

    g.font = this.northFont
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const lx = c + Math.cos(nAngle) * (nr - 10 * u)
    const ly = c + Math.sin(nAngle) * (nr - 10 * u)
    g.fillStyle = 'rgba(6,9,8,.8)'
    g.fillText('N', lx + u, ly + u)
    g.fillStyle = 'rgba(232,238,231,.78)'
    g.fillText('N', lx, ly)

    g.restore()

    // Border last and unclipped, so the rounded edge stays crisp: a dark
    // casing under a light hairline.
    g.lineJoin = 'round'
    g.strokeStyle = 'rgba(3,5,6,.9)'
    g.lineWidth = Math.max(2, 3 * u)
    g.stroke(this.mask)
    g.strokeStyle = 'rgba(206,220,212,.34)'
    g.lineWidth = Math.max(1, 1.2 * u)
    g.stroke(this.mask)
  }
}

const MAP_FONT = `'DIN Condensed','Oswald','Arial Narrow','Roboto Condensed','Liberation Sans Narrow','Helvetica Neue',sans-serif`

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

/** Deterministic per-cell dither. No PRNG state, so the bake is reproducible. */
function hash2(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** `roundRect` is not in every target's Path2D, so build the arcs by hand. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): Path2D {
  const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5))
  const p = new Path2D()
  p.moveTo(x + rad, y)
  p.lineTo(x + w - rad, y)
  p.arcTo(x + w, y, x + w, y + rad, rad)
  p.lineTo(x + w, y + h - rad)
  p.arcTo(x + w, y + h, x + w - rad, y + h, rad)
  p.lineTo(x + rad, y + h)
  p.arcTo(x, y + h, x, y + h - rad, rad)
  p.lineTo(x, y + rad)
  p.arcTo(x, y, x + rad, y, rad)
  p.closePath()
  return p
}
