import * as THREE from 'three'
import { Rand } from '../core/Rand'

/**
 * Every texture the FX system uses is generated here, in code, at boot. No
 * network fetches, no binary assets.
 *
 * Two encodings are used:
 *
 * - **Particle masks** (`smokeSheet`, `sprites`): RGB is white, the shape lives
 *   entirely in the alpha channel. Particle colour comes from the per-particle
 *   gradient, so one mask serves dust, blood, sparks and fireball alike. The
 *   alpha channel is also used as an *erosion field*: raising a threshold over
 *   a particle's life dissolves the puff organically instead of just fading it.
 * - **Decal atlases** (`decalAlbedo` + `decalNormal`): real albedo with a mask
 *   in alpha, plus a tangent-space normal map Sobel-derived from a height pass
 *   drawn with the same primitives.
 */

export const SPRITE = {
  puff: 0,
  spark: 1,
  streak: 2,
  star: 3,
  granule: 4,
  chip: 5,
  splinter: 6,
  shard: 7,
  leaf: 8,
  droplet: 9,
  mist: 10,
  ring: 11,
  core: 12,
  crown: 13,
  scrap: 14,
  ember: 15,
} as const

export const DECAL = {
  holeConcreteA: 0,
  holeConcreteB: 1,
  holeMetal: 2,
  holeWood: 3,
  holeGlass: 4,
  holePlaster: 5,
  holeDirt: 6,
  holeFoliage: 7,
  bloodA: 8,
  bloodB: 9,
  bloodPool: 10,
  scorchLarge: 11,
  scorchSmall: 12,
  scratch: 13,
  dustSplat: 14,
  waterRing: 15,
} as const

export interface FxTextureSet {
  /** 4x4 sheet of 16 evolving smoke frames. */
  smokeSheet: THREE.Texture
  /** 4x4 atlas of static particle masks, indexed by `SPRITE`. */
  sprites: THREE.Texture
  /** 4x4 decal albedo atlas, indexed by `DECAL`. */
  decalAlbedo: THREE.Texture
  /** Matching tangent-space normals. */
  decalNormal: THREE.Texture
  /** Crumpled paper for wind-blown litter. */
  paper: THREE.Texture
  dispose(): void
}

// --- low level helpers ------------------------------------------------------

function makeCanvas(w: number, h: number, readFrequently = false): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: readFrequently })
  if (!g) throw new Error('fx: 2d canvas unavailable')
  return g
}

function hash2(x: number, y: number, s: number): number {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9)
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b)
  n ^= n >>> 13
  n = Math.imul(n, 0xc2b2ae35)
  n ^= n >>> 16
  return (n >>> 0) / 4294967296
}

/** One octave of wrapping value noise accumulated into `out`. */
function valueOctave(size: number, freq: number, seed: number, amp: number, out: Float32Array): void {
  const scale = freq / size
  for (let y = 0; y < size; y++) {
    const fy = y * scale
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const sy = ty * ty * (3 - 2 * ty)
    const ya = ((y0 % freq) + freq) % freq
    const yb = (ya + 1) % freq
    const row = y * size
    for (let x = 0; x < size; x++) {
      const fx = x * scale
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const sx = tx * tx * (3 - 2 * tx)
      const xa = ((x0 % freq) + freq) % freq
      const xb = (xa + 1) % freq
      const a = hash2(xa, ya, seed)
      const b = hash2(xb, ya, seed)
      const c = hash2(xa, yb, seed)
      const d = hash2(xb, yb, seed)
      const top = a + (b - a) * sx
      const bot = c + (d - c) * sx
      out[row + x] += (top + (bot - top) * sy) * amp
    }
  }
}

/** Tiling greyscale fBm rendered opaque into its own canvas. */
function fbmCanvas(size: number, baseFreq: number, octaves: number, seed: number, contrast: number): HTMLCanvasElement {
  const buf = new Float32Array(size * size)
  let amp = 1
  let total = 0
  let freq = baseFreq
  for (let o = 0; o < octaves; o++) {
    valueOctave(size, freq, seed + o * 977, amp, buf)
    total += amp
    amp *= 0.52
    freq *= 2
  }
  const g = makeCanvas(size, size, true)
  const img = g.createImageData(size, size)
  const px = img.data
  const inv = 1 / total
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i] * inv
    v = (v - 0.5) * contrast + 0.5
    const b = Math.max(0, Math.min(255, Math.round(v * 255)))
    const o = i * 4
    px[o] = b
    px[o + 1] = b
    px[o + 2] = b
    px[o + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return g.canvas
}

/**
 * Collapses an opaque greyscale tile into `rgb = white, a = curve(luminance)`.
 * Every particle mask goes through this so the shader has one convention.
 */
function luminanceToAlpha(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lo: number, hi: number): void {
  const img = g.getImageData(x, y, w, h)
  const px = img.data
  const span = Math.max(hi - lo, 1e-3)
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] / 255
    let a = (l - lo) / span
    a = a < 0 ? 0 : a > 1 ? 1 : a
    a = a * a * (3 - 2 * a)
    px[i] = 255
    px[i + 1] = 255
    px[i + 2] = 255
    px[i + 3] = Math.round(a * 255)
  }
  g.putImageData(img, x, y)
}

function radial(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: [number, string][]): CanvasGradient {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 0.001))
  for (const [t, c] of stops) grad.addColorStop(t, c)
  return grad
}

// --- smoke sheet ------------------------------------------------------------

function buildSmokeSheet(rand: Rand): HTMLCanvasElement {
  const T = 128
  const COLS = 4
  const sheet = makeCanvas(T * COLS, T * COLS, true)
  const nA = fbmCanvas(256, 3, 4, Math.floor(rand.next() * 1e6), 1.5)
  const nB = fbmCanvas(256, 5, 3, Math.floor(rand.next() * 1e6), 1.7)
  const frame = makeCanvas(T, T, true)

  for (let f = 0; f < 16; f++) {
    const g = frame
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'source-over'
    g.globalAlpha = 1
    g.fillStyle = '#000'
    g.fillRect(0, 0, T, T)

    // Two noise layers sliding past each other produce billowing over the sheet.
    const s1 = T * (1.7 + f * 0.045)
    const s2 = T * (2.9 + f * 0.09)
    g.drawImage(nA, -f * 5 - 10, f * 9 - 20, s1, s1)
    g.globalCompositeOperation = 'lighter'
    g.drawImage(nA, s1 - f * 5 - 10, f * 9 - 20, s1, s1)
    g.globalCompositeOperation = 'multiply'
    g.drawImage(nB, f * 11 - 30, -f * 6 - 10, s2, s2)

    // A softly growing disc trims the billows into a coherent puff.
    const r = T * (0.30 + f * 0.0125)
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = radial(g, T / 2, T / 2, r, [
      [0, '#ffffff'],
      [0.55, '#e2e2e2'],
      [0.82, '#585858'],
      [1, '#000000'],
    ])
    g.fillRect(0, 0, T, T)
    g.globalCompositeOperation = 'source-over'

    // Later frames are thinner: raise the black point as the puff dissipates.
    luminanceToAlpha(g, 0, 0, T, T, 0.12 + f * 0.018, 0.52 + f * 0.02)

    const col = f % COLS
    const row = (f / COLS) | 0
    sheet.clearRect(col * T, row * T, T, T)
    sheet.drawImage(frame.canvas, col * T, row * T)
  }
  return sheet.canvas
}

// --- static sprite atlas ----------------------------------------------------

function buildSprites(rand: Rand): HTMLCanvasElement {
  const T = 128
  const g = makeCanvas(T * 4, T * 4, true)
  const noise = fbmCanvas(128, 6, 3, Math.floor(rand.next() * 1e6), 1.9)

  const tile = (i: number): { x: number; y: number } => ({ x: (i % 4) * T, y: ((i / 4) | 0) * T })
  const begin = (i: number) => {
    const t = tile(i)
    g.setTransform(1, 0, 0, 1, t.x, t.y)
    g.save()
    g.beginPath()
    g.rect(0, 0, T, T)
    g.clip()
    return t
  }
  const end = () => {
    g.restore()
    g.setTransform(1, 0, 0, 1, 0, 0)
  }
  const W = (a: number) => `rgba(255,255,255,${a})`

  const C = T / 2

  // 0 soft puff — dust, generic smoke fallback.
  begin(SPRITE.puff)
  g.fillStyle = radial(g, C, C, C * 0.95, [[0, W(1)], [0.4, W(0.72)], [0.75, W(0.2)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  g.globalCompositeOperation = 'destination-in'
  g.globalAlpha = 0.85
  g.drawImage(noise, -8, -8, T + 16, T + 16)
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = radial(g, C, C, C * 0.55, [[0, W(0.55)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  end()

  // 1 spark — tight bright point with a faint halo.
  begin(SPRITE.spark)
  g.fillStyle = radial(g, C, C, C * 0.9, [[0, W(0.35)], [0.25, W(0.1)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  g.fillStyle = radial(g, C, C, C * 0.22, [[0, W(1)], [0.5, W(0.85)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  end()

  // 2 streak — elongated, for velocity-stretched sparks and debris trails.
  begin(SPRITE.streak)
  {
    const grad = g.createLinearGradient(0, 0, 0, T)
    grad.addColorStop(0, W(0))
    grad.addColorStop(0.18, W(0.35))
    grad.addColorStop(0.72, W(1))
    grad.addColorStop(1, W(0))
    g.fillStyle = grad
    g.fillRect(C - T * 0.16, 0, T * 0.32, T)
    g.globalCompositeOperation = 'destination-in'
    const cross = g.createLinearGradient(C - T * 0.16, 0, C + T * 0.16, 0)
    cross.addColorStop(0, W(0))
    cross.addColorStop(0.5, W(1))
    cross.addColorStop(1, W(0))
    g.fillStyle = cross
    g.fillRect(C - T * 0.16, 0, T * 0.32, T)
    g.globalCompositeOperation = 'source-over'
  }
  end()

  // 3 star flare — muzzle flash radial spikes.
  begin(SPRITE.star)
  g.fillStyle = radial(g, C, C, C * 0.30, [[0, W(1)], [0.45, W(0.55)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.21
    const len = C * (i % 2 === 0 ? rand.range(0.78, 0.98) : rand.range(0.34, 0.55))
    const wdt = i % 2 === 0 ? 0.055 : 0.032
    g.save()
    g.translate(C, C)
    g.rotate(a)
    const grad = g.createLinearGradient(0, 0, len, 0)
    grad.addColorStop(0, W(0.95))
    grad.addColorStop(0.35, W(0.4))
    grad.addColorStop(1, W(0))
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(0, -T * wdt)
    g.lineTo(len, 0)
    g.lineTo(0, T * wdt)
    g.closePath()
    g.fill()
    g.restore()
  }
  end()

  // 4 granule cluster — sand/gravel debris.
  begin(SPRITE.granule)
  for (let i = 0; i < 9; i++) {
    const a = rand.range(0, Math.PI * 2)
    const r = rand.range(0, C * 0.62)
    const s = rand.range(C * 0.07, C * 0.2)
    g.fillStyle = radial(g, C + Math.cos(a) * r, C + Math.sin(a) * r, s, [[0, W(1)], [0.6, W(0.7)], [1, W(0)]])
    g.fillRect(0, 0, T, T)
  }
  end()

  // 5 chip — irregular rock fragment silhouette.
  begin(SPRITE.chip)
  g.fillStyle = W(1)
  g.beginPath()
  for (let i = 0; i <= 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const r = C * rand.range(0.42, 0.82)
    const x = C + Math.cos(a) * r
    const y = C + Math.sin(a) * r * 0.85
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.fill()
  end()

  // 6 splinter — long wooden shard.
  begin(SPRITE.splinter)
  g.fillStyle = W(1)
  g.beginPath()
  g.moveTo(C - T * 0.045, T * 0.06)
  g.lineTo(C + T * 0.06, T * 0.2)
  g.lineTo(C + T * 0.03, T * 0.9)
  g.lineTo(C - T * 0.02, T * 0.96)
  g.lineTo(C - T * 0.075, T * 0.5)
  g.closePath()
  g.fill()
  end()

  // 7 glass shard — triangular with a bright catching edge.
  begin(SPRITE.shard)
  g.fillStyle = W(0.55)
  g.beginPath()
  g.moveTo(C * 0.5, T * 0.1)
  g.lineTo(C * 1.62, T * 0.42)
  g.lineTo(C * 0.86, T * 0.94)
  g.closePath()
  g.fill()
  g.strokeStyle = W(1)
  g.lineWidth = T * 0.035
  g.stroke()
  end()

  // 8 leaf.
  begin(SPRITE.leaf)
  g.fillStyle = W(1)
  g.beginPath()
  g.ellipse(C, C, C * 0.34, C * 0.72, 0.4, 0, Math.PI * 2)
  g.fill()
  g.globalCompositeOperation = 'destination-out'
  g.strokeStyle = W(0.5)
  g.lineWidth = T * 0.02
  g.beginPath()
  g.moveTo(C - C * 0.26, C + C * 0.6)
  g.lineTo(C + C * 0.26, C - C * 0.6)
  g.stroke()
  g.globalCompositeOperation = 'source-over'
  end()

  // 9 droplet — water/blood teardrop.
  begin(SPRITE.droplet)
  g.fillStyle = radial(g, C, C * 1.12, C * 0.42, [[0, W(1)], [0.7, W(0.85)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  g.fillStyle = W(0.8)
  g.beginPath()
  g.moveTo(C, C * 0.28)
  g.quadraticCurveTo(C + C * 0.34, C * 1.0, C, C * 1.5)
  g.quadraticCurveTo(C - C * 0.34, C * 1.0, C, C * 0.28)
  g.fill()
  end()

  // 10 mist — fine speckle inside a soft blob (blood mist, water spray).
  begin(SPRITE.mist)
  for (let i = 0; i < 90; i++) {
    const a = rand.range(0, Math.PI * 2)
    const r = Math.sqrt(rand.next()) * C * 0.9
    const s = rand.range(T * 0.008, T * 0.035)
    g.fillStyle = W(rand.range(0.25, 0.95))
    g.beginPath()
    g.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, s, 0, Math.PI * 2)
    g.fill()
  }
  g.globalCompositeOperation = 'destination-in'
  g.fillStyle = radial(g, C, C, C, [[0, W(1)], [0.6, W(0.85)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  g.globalCompositeOperation = 'source-over'
  end()

  // 11 ring — shockwave / water ripple.
  begin(SPRITE.ring)
  {
    const grad = g.createRadialGradient(C, C, C * 0.62, C, C, C * 0.99)
    grad.addColorStop(0, W(0))
    grad.addColorStop(0.35, W(0.15))
    grad.addColorStop(0.72, W(1))
    grad.addColorStop(0.9, W(0.35))
    grad.addColorStop(1, W(0))
    g.fillStyle = grad
    g.fillRect(0, 0, T, T)
  }
  end()

  // 12 core — very tight hot centre for muzzle flash / explosion flash.
  begin(SPRITE.core)
  g.fillStyle = radial(g, C, C, C, [[0, W(1)], [0.12, W(0.95)], [0.34, W(0.42)], [0.66, W(0.08)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  end()

  // 13 crown — splash crown segment for water impacts.
  begin(SPRITE.crown)
  g.fillStyle = W(1)
  g.beginPath()
  g.moveTo(C * 0.35, T * 0.98)
  g.quadraticCurveTo(C * 0.62, T * 0.3, C, T * 0.05)
  g.quadraticCurveTo(C * 1.38, T * 0.3, C * 1.65, T * 0.98)
  g.closePath()
  g.fill()
  g.globalCompositeOperation = 'destination-in'
  {
    const grad = g.createLinearGradient(0, 0, 0, T)
    grad.addColorStop(0, W(0.15))
    grad.addColorStop(0.45, W(0.8))
    grad.addColorStop(1, W(1))
    g.fillStyle = grad
    g.fillRect(0, 0, T, T)
  }
  g.globalCompositeOperation = 'source-over'
  end()

  // 14 scrap — torn paper / fabric fragment.
  begin(SPRITE.scrap)
  g.fillStyle = W(1)
  g.beginPath()
  g.moveTo(T * 0.2, T * 0.24)
  g.lineTo(T * 0.78, T * 0.16)
  g.lineTo(T * 0.86, T * 0.7)
  g.lineTo(T * 0.42, T * 0.88)
  g.lineTo(T * 0.16, T * 0.62)
  g.closePath()
  g.fill()
  end()

  // 15 ember — small dot with a warm halo.
  begin(SPRITE.ember)
  g.fillStyle = radial(g, C, C, C * 0.75, [[0, W(0.5)], [0.3, W(0.16)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  g.fillStyle = radial(g, C, C, C * 0.14, [[0, W(1)], [1, W(0)]])
  g.fillRect(0, 0, T, T)
  end()

  return g.canvas
}

// --- decal atlas ------------------------------------------------------------

type DecalMode = 'albedo' | 'height'

/**
 * Draws one decal tile. `albedo` writes colour + coverage; `height` writes a
 * greyscale surface displacement that the normal map is derived from, so the
 * crushed rim of a bullet hole catches light the way the albedo implies.
 */
function drawDecal(g: CanvasRenderingContext2D, index: number, T: number, mode: DecalMode, rand: Rand): void {
  const C = T / 2
  const albedo = mode === 'albedo'
  // Height convention: 0.5 is flat, <0.5 is a depression, >0.5 is raised.
  const flat = '#808080'
  if (!albedo) {
    g.fillStyle = flat
    g.fillRect(0, 0, T, T)
  }

  const rgba = (r: number, gg: number, b: number, a: number) => `rgba(${r | 0},${gg | 0},${b | 0},${a})`
  const grey = (v: number, a = 1) => rgba(v * 255, v * 255, v * 255, a)

  /** Radial cracks that vary per surface. */
  const cracks = (count: number, len: number, width: number, colour: string, heightColour: string) => {
    g.strokeStyle = albedo ? colour : heightColour
    g.lineCap = 'round'
    for (let i = 0; i < count; i++) {
      const a = rand.range(0, Math.PI * 2)
      const l = C * len * rand.range(0.55, 1.25)
      g.lineWidth = T * width * rand.range(0.6, 1.4)
      g.beginPath()
      g.moveTo(C, C)
      let x = C
      let y = C
      const segs = 3
      for (let s = 1; s <= segs; s++) {
        const wobble = rand.spread(0.32)
        x = C + Math.cos(a + wobble) * (l * s) / segs
        y = C + Math.sin(a + wobble) * (l * s) / segs
        g.lineTo(x, y)
      }
      g.stroke()
    }
  }

  /** Speckled dust/soot halo. */
  const speckle = (count: number, radius: number, colour: (a: number) => string, size: number) => {
    for (let i = 0; i < count; i++) {
      const a = rand.range(0, Math.PI * 2)
      const r = Math.pow(rand.next(), 0.55) * C * radius
      const s = T * size * rand.range(0.4, 1.6)
      g.fillStyle = colour(rand.range(0.15, 0.75))
      g.beginPath()
      g.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, s, 0, Math.PI * 2)
      g.fill()
    }
  }

  switch (index) {
    case DECAL.holeConcreteA:
    case DECAL.holeConcreteB: {
      const scatter = index === DECAL.holeConcreteA ? 0.9 : 0.62
      if (albedo) {
        speckle(70, scatter, (a) => rgba(168, 162, 150, a * 0.5), 0.014)
        // Crushed, lighter rim of pulverised material.
        g.fillStyle = radial(g, C, C, C * 0.44, [
          [0, 'rgba(212,206,192,0.95)'], [0.55, 'rgba(196,189,174,0.8)'], [1, 'rgba(180,174,160,0)'],
        ])
        g.fillRect(0, 0, T, T)
        cracks(index === DECAL.holeConcreteA ? 7 : 5, 0.85, 0.012, 'rgba(48,44,40,0.85)', grey(0.34))
        // Dark crater.
        g.fillStyle = radial(g, C, C, C * 0.24, [
          [0, 'rgba(12,11,10,1)'], [0.6, 'rgba(26,24,22,0.98)'], [1, 'rgba(60,56,50,0)'],
        ])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.46, [[0, grey(0.72)], [0.55, grey(0.6)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
        cracks(index === DECAL.holeConcreteA ? 7 : 5, 0.85, 0.012, grey(0.34), grey(0.34))
        g.fillStyle = radial(g, C, C, C * 0.26, [[0, grey(0.05)], [0.7, grey(0.24)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holePlaster: {
      if (albedo) {
        speckle(90, 0.95, (a) => rgba(226, 220, 206, a * 0.55), 0.016)
        g.fillStyle = radial(g, C, C, C * 0.52, [
          [0, 'rgba(238,233,220,0.9)'], [0.6, 'rgba(226,220,206,0.6)'], [1, 'rgba(226,220,206,0)'],
        ])
        g.fillRect(0, 0, T, T)
        cracks(9, 0.9, 0.009, 'rgba(70,64,56,0.6)', grey(0.36))
        g.fillStyle = radial(g, C, C, C * 0.2, [[0, 'rgba(28,25,22,1)'], [1, 'rgba(60,55,48,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.5, [[0, grey(0.66)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
        g.fillStyle = radial(g, C, C, C * 0.22, [[0, grey(0.08)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holeMetal: {
      if (albedo) {
        // Torn, brightened lip where the jacket peeled the paint back.
        g.fillStyle = radial(g, C, C, C * 0.36, [
          [0, 'rgba(214,210,205,0.95)'], [0.5, 'rgba(150,146,142,0.85)'], [1, 'rgba(120,116,112,0)'],
        ])
        g.fillRect(0, 0, T, T)
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + rand.spread(0.2)
          const l = C * rand.range(0.2, 0.38)
          g.fillStyle = rgba(228, 224, 218, 0.9)
          g.beginPath()
          g.moveTo(C, C)
          g.lineTo(C + Math.cos(a - 0.16) * l, C + Math.sin(a - 0.16) * l)
          g.lineTo(C + Math.cos(a + 0.16) * l, C + Math.sin(a + 0.16) * l)
          g.closePath()
          g.fill()
        }
        g.fillStyle = radial(g, C, C, C * 0.17, [[0, 'rgba(6,6,7,1)'], [0.75, 'rgba(14,14,16,1)'], [1, 'rgba(30,30,32,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.36, [[0, grey(0.86)], [0.55, grey(0.62)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
        g.fillStyle = radial(g, C, C, C * 0.18, [[0, grey(0.02)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holeWood: {
      if (albedo) {
        speckle(50, 0.85, (a) => rgba(120, 92, 58, a * 0.5), 0.014)
        g.fillStyle = radial(g, C, C, C * 0.42, [
          [0, 'rgba(176,140,92,0.9)'], [0.6, 'rgba(148,116,74,0.6)'], [1, 'rgba(130,100,62,0)'],
        ])
        g.fillRect(0, 0, T, T)
        // Splintered fibres run further along the grain.
        g.save()
        g.translate(C, C)
        g.scale(1, 0.42)
        g.translate(-C, -C)
        cracks(11, 1.05, 0.014, 'rgba(92,66,38,0.9)', grey(0.3))
        g.restore()
        g.fillStyle = radial(g, C, C, C * 0.2, [[0, 'rgba(18,13,8,1)'], [1, 'rgba(52,38,22,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.44, [[0, grey(0.68)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
        g.save()
        g.translate(C, C)
        g.scale(1, 0.42)
        g.translate(-C, -C)
        cracks(11, 1.05, 0.014, grey(0.3), grey(0.3))
        g.restore()
        g.fillStyle = radial(g, C, C, C * 0.22, [[0, grey(0.06)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holeGlass: {
      if (albedo) {
        g.strokeStyle = 'rgba(235,244,248,0.85)'
        g.lineCap = 'round'
        const spokes = 12
        const angles: number[] = []
        for (let i = 0; i < spokes; i++) angles.push((i / spokes) * Math.PI * 2 + rand.spread(0.16))
        for (const a of angles) {
          g.lineWidth = T * rand.range(0.006, 0.016)
          g.beginPath()
          g.moveTo(C, C)
          g.lineTo(C + Math.cos(a) * C * rand.range(0.6, 0.98), C + Math.sin(a) * C * rand.range(0.6, 0.98))
          g.stroke()
        }
        // Concentric fracture rings between the spokes.
        for (let ring = 1; ring <= 3; ring++) {
          const rr = C * (0.22 + ring * 0.22)
          g.lineWidth = T * 0.006
          g.beginPath()
          for (let i = 0; i <= spokes; i++) {
            const a = angles[i % spokes]
            const r = rr * rand.range(0.85, 1.15)
            const x = C + Math.cos(a) * r
            const y = C + Math.sin(a) * r
            if (i === 0) g.moveTo(x, y)
            else g.lineTo(x, y)
          }
          g.stroke()
        }
        g.fillStyle = radial(g, C, C, C * 0.16, [[0, 'rgba(255,255,255,0.95)'], [0.5, 'rgba(226,240,246,0.6)'], [1, 'rgba(226,240,246,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.2, [[0, grey(0.3)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holeDirt: {
      if (albedo) {
        speckle(120, 1.0, (a) => rgba(96, 78, 56, a * 0.6), 0.018)
        g.fillStyle = radial(g, C, C, C * 0.55, [
          [0, 'rgba(58,46,32,0.92)'], [0.5, 'rgba(78,62,44,0.6)'], [1, 'rgba(96,78,56,0)'],
        ])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.55, [[0, grey(0.22)], [0.6, grey(0.42)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.holeFoliage: {
      if (albedo) {
        speckle(60, 0.9, (a) => rgba(74, 96, 46, a * 0.6), 0.02)
        g.fillStyle = radial(g, C, C, C * 0.35, [[0, 'rgba(46,58,28,0.8)'], [1, 'rgba(46,58,28,0)']])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.bloodA:
    case DECAL.bloodB: {
      if (albedo) {
        const drips = index === DECAL.bloodA ? 5 : 3
        g.fillStyle = 'rgba(58,7,7,0.94)'
        g.beginPath()
        for (let i = 0; i <= 16; i++) {
          const a = (i / 16) * Math.PI * 2
          const r = C * (0.34 + Math.sin(a * rand.range(2, 4) + index) * 0.1 + rand.range(-0.05, 0.09))
          const x = C + Math.cos(a) * r
          const y = C + Math.sin(a) * r
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.closePath()
        g.fill()
        for (let i = 0; i < drips; i++) {
          const a = rand.range(0, Math.PI * 2)
          const r = C * rand.range(0.32, 0.5)
          g.fillStyle = 'rgba(50,6,6,0.9)'
          g.beginPath()
          g.ellipse(C + Math.cos(a) * r, C + Math.sin(a) * r + C * 0.18, C * 0.05, C * rand.range(0.12, 0.3), 0, 0, Math.PI * 2)
          g.fill()
        }
        speckle(70, 0.95, (a) => rgba(76, 10, 10, a), 0.013)
        // Wet specular-ish highlight: brighter, redder centre.
        g.fillStyle = radial(g, C * 0.92, C * 0.9, C * 0.2, [[0, 'rgba(122,18,14,0.5)'], [1, 'rgba(122,18,14,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.42, [[0, grey(0.56)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.bloodPool: {
      if (albedo) {
        g.fillStyle = 'rgba(44,5,5,0.97)'
        g.beginPath()
        for (let i = 0; i <= 24; i++) {
          const a = (i / 24) * Math.PI * 2
          const r = C * (0.72 + Math.sin(a * 3.1) * 0.06 + Math.sin(a * 5.7 + 1.2) * 0.04)
          const x = C + Math.cos(a) * r
          const y = C + Math.sin(a) * r * 0.86
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.closePath()
        g.fill()
        // Darker, thicker rim where the pool has dried at the edge.
        g.strokeStyle = 'rgba(28,3,3,0.9)'
        g.lineWidth = T * 0.02
        g.stroke()
        g.fillStyle = radial(g, C * 0.85, C * 0.82, C * 0.42, [[0, 'rgba(108,14,12,0.42)'], [1, 'rgba(108,14,12,0)']])
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.75, [[0, grey(0.54)], [0.9, grey(0.52)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.scorchLarge:
    case DECAL.scorchSmall: {
      const spread = index === DECAL.scorchLarge ? 0.95 : 0.6
      if (albedo) {
        g.fillStyle = radial(g, C, C, C * spread, [
          [0, 'rgba(9,8,8,0.95)'], [0.35, 'rgba(16,14,13,0.8)'], [0.7, 'rgba(28,25,23,0.35)'], [1, 'rgba(40,36,33,0)'],
        ])
        g.fillRect(0, 0, T, T)
        // Radial soot streaks thrown outward by the blast.
        for (let i = 0; i < 26; i++) {
          const a = rand.range(0, Math.PI * 2)
          const l = C * spread * rand.range(0.6, 1.35)
          g.strokeStyle = `rgba(10,9,9,${rand.range(0.2, 0.6)})`
          g.lineWidth = T * rand.range(0.006, 0.03)
          g.beginPath()
          g.moveTo(C + Math.cos(a) * C * 0.16, C + Math.sin(a) * C * 0.16)
          g.lineTo(C + Math.cos(a) * l, C + Math.sin(a) * l)
          g.stroke()
        }
        speckle(80, spread, (a) => rgba(12, 11, 10, a * 0.7), 0.02)
      } else {
        g.fillStyle = radial(g, C, C, C * spread * 0.5, [[0, grey(0.4)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.scratch: {
      if (albedo) {
        g.save()
        g.translate(C, C)
        g.rotate(0.32)
        const grad = g.createLinearGradient(-C, 0, C, 0)
        grad.addColorStop(0, 'rgba(190,185,178,0)')
        grad.addColorStop(0.25, 'rgba(206,200,192,0.85)')
        grad.addColorStop(0.72, 'rgba(150,144,138,0.55)')
        grad.addColorStop(1, 'rgba(150,144,138,0)')
        g.fillStyle = grad
        g.beginPath()
        g.ellipse(0, 0, C * 0.92, C * 0.12, 0, 0, Math.PI * 2)
        g.fill()
        g.restore()
      } else {
        g.save()
        g.translate(C, C)
        g.rotate(0.32)
        g.fillStyle = grey(0.34)
        g.beginPath()
        g.ellipse(0, 0, C * 0.9, C * 0.1, 0, 0, Math.PI * 2)
        g.fill()
        g.restore()
      }
      break
    }
    case DECAL.dustSplat: {
      if (albedo) {
        speckle(110, 1.0, (a) => rgba(196, 189, 172, a * 0.5), 0.02)
        g.fillStyle = radial(g, C, C, C * 0.6, [[0, 'rgba(206,199,182,0.55)'], [1, 'rgba(206,199,182,0)']])
        g.fillRect(0, 0, T, T)
      }
      break
    }
    case DECAL.waterRing: {
      if (albedo) {
        const grad = g.createRadialGradient(C, C, C * 0.5, C, C, C * 0.95)
        grad.addColorStop(0, 'rgba(220,240,248,0)')
        grad.addColorStop(0.55, 'rgba(220,240,248,0.45)')
        grad.addColorStop(0.8, 'rgba(240,250,255,0.6)')
        grad.addColorStop(1, 'rgba(220,240,248,0)')
        g.fillStyle = grad
        g.fillRect(0, 0, T, T)
      } else {
        g.fillStyle = radial(g, C, C, C * 0.9, [[0, grey(0.5)], [0.7, grey(0.62)], [1, grey(0.5)]])
        g.fillRect(0, 0, T, T)
      }
      break
    }
  }
}

function buildDecalAtlas(rand: Rand, mode: DecalMode, tileSize: number): CanvasRenderingContext2D {
  const g = makeCanvas(tileSize * 4, tileSize * 4, true)
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * tileSize
    const y = ((i / 4) | 0) * tileSize
    g.save()
    g.setTransform(1, 0, 0, 1, x, y)
    g.beginPath()
    g.rect(0, 0, tileSize, tileSize)
    g.clip()
    drawDecal(g, i, tileSize, mode, rand)
    g.restore()
  }
  g.setTransform(1, 0, 0, 1, 0, 0)
  return g
}

/** Sobel the height atlas into a tangent-space normal map, per tile. */
function heightToNormal(src: CanvasRenderingContext2D, size: number, tileSize: number, strength: number): HTMLCanvasElement {
  const img = src.getImageData(0, 0, size, size)
  const h = img.data
  const out = src.createImageData(size, size)
  const o = out.data
  const clampTile = (v: number, base: number) => {
    const t = v - base
    return base + (t < 0 ? 0 : t >= tileSize ? tileSize - 1 : t)
  }
  for (let y = 0; y < size; y++) {
    const tileY = (y / tileSize | 0) * tileSize
    for (let x = 0; x < size; x++) {
      const tileX = (x / tileSize | 0) * tileSize
      const xl = clampTile(x - 1, tileX)
      const xr = clampTile(x + 1, tileX)
      const yu = clampTile(y - 1, tileY)
      const yd = clampTile(y + 1, tileY)
      const l = h[(y * size + xl) * 4] / 255
      const r = h[(y * size + xr) * 4] / 255
      const u = h[(yu * size + x) * 4] / 255
      const d = h[(yd * size + x) * 4] / 255
      let nx = (l - r) * strength
      let ny = (d - u) * strength
      const nz = 1
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx *= inv
      ny *= inv
      const i = (y * size + x) * 4
      o[i] = (nx * 0.5 + 0.5) * 255
      o[i + 1] = (ny * 0.5 + 0.5) * 255
      o[i + 2] = nz * inv * 255
      o[i + 3] = 255
    }
  }
  const g = makeCanvas(size, size)
  g.putImageData(out, 0, 0)
  return g.canvas
}

function buildPaper(rand: Rand): HTMLCanvasElement {
  const T = 128
  const g = makeCanvas(T, T, true)
  g.fillStyle = '#cfc7b4'
  g.fillRect(0, 0, T, T)
  const noise = fbmCanvas(128, 8, 3, Math.floor(rand.next() * 1e6), 0.6)
  g.globalAlpha = 0.35
  g.globalCompositeOperation = 'multiply'
  g.drawImage(noise, 0, 0)
  g.globalCompositeOperation = 'source-over'
  g.globalAlpha = 1
  // Print-like smudges so it does not read as a blank white card.
  g.fillStyle = 'rgba(70,64,56,0.5)'
  for (let i = 0; i < 9; i++) {
    const y = 18 + i * 11 + rand.range(-2, 2)
    g.fillRect(16 + rand.range(0, 10), y, rand.range(40, 92), 2.5)
  }
  g.strokeStyle = 'rgba(120,110,96,0.6)'
  g.lineWidth = 3
  g.strokeRect(2, 2, T - 4, T - 4)
  return g.canvas
}

// --- assembly ---------------------------------------------------------------

function texture(canvas: HTMLCanvasElement, anisotropy: number, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = true
  t.anisotropy = anisotropy
  t.needsUpdate = true
  return t
}

export function buildFxTextures(anisotropy: number, seed: number): FxTextureSet {
  const rand = new Rand(seed ^ 0x5f3a91)

  const smokeSheet = texture(buildSmokeSheet(rand), Math.min(anisotropy, 4), true)
  const sprites = texture(buildSprites(rand), Math.min(anisotropy, 4), true)

  const albedoTile = 192
  const albedoCtx = buildDecalAtlas(new Rand(seed ^ 0x11aa33), 'albedo', albedoTile)
  const heightCtx = buildDecalAtlas(new Rand(seed ^ 0x11aa33), 'height', 96)
  const decalAlbedo = texture(albedoCtx.canvas, anisotropy, true)
  const decalNormal = texture(heightToNormal(heightCtx, 96 * 4, 96, 6), anisotropy, false)
  const paper = texture(buildPaper(rand), anisotropy, true)

  // Mip chains bleed neighbouring tiles into each other at the smallest levels;
  // clamping the mip range keeps decal and sprite tiles from cross-contaminating.
  smokeSheet.minFilter = THREE.LinearMipmapLinearFilter
  sprites.minFilter = THREE.LinearMipmapLinearFilter

  return {
    smokeSheet,
    sprites,
    decalAlbedo,
    decalNormal,
    paper,
    dispose() {
      smokeSheet.dispose()
      sprites.dispose()
      decalAlbedo.dispose()
      decalNormal.dispose()
      paper.dispose()
    },
  }
}
