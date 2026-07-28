import { Rand } from '../core/Rand'
import { Fx, TextSlot, clamp, damp, easeOutCubic, el, pathOf, svgEl, toggleClass } from './Style'

/** How long a damage-direction arc stays on screen. */
const ARC_LIFE = 1.45
const ARC_SLOTS = 6

interface ArcSlot {
  fx: Fx
  bearing: number
  start: number
  live: boolean
}

/**
 * Arcs around the reticle pointing at whatever just hurt you. Repeated hits
 * from roughly the same bearing refresh one arc instead of stacking, which is
 * what makes the direction readable during sustained fire.
 */
export class DamageIndicators {
  private slots: ArcSlot[] = []

  constructor(parent: HTMLElement) {
    const stack = el('div', 'stack', parent)
    ensureDefs()
    for (let i = 0; i < ARC_SLOTS; i++) {
      const svg = svgEl('svg', { class: 'dmg-arc', viewBox: '-125 -125 250 250' }, stack)
      const R = 98
      const half = 18.5
      const a0 = (-90 - half) * (Math.PI / 180)
      const a1 = (-90 + half) * (Math.PI / 180)
      const d = [
        `M${(Math.cos(a0) * R).toFixed(2)} ${(Math.sin(a0) * R).toFixed(2)}`,
        `A${R} ${R} 0 0 1 ${(Math.cos(a1) * R).toFixed(2)} ${(Math.sin(a1) * R).toFixed(2)}`,
      ]
      pathOf(d, { stroke: 'rgba(0,0,0,.3)', 'stroke-width': 12, fill: 'none', 'stroke-linecap': 'round' }, svg)
      pathOf(d, { stroke: 'url(#codDmgGrad)', 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round' }, svg)
      pathOf(d, { stroke: 'url(#codDmgCore)', 'stroke-width': 2.8, fill: 'none', 'stroke-linecap': 'round' }, svg)
      const fx = new Fx(svg)
      fx.opacity(0)
      fx.visible(false)
      this.slots.push({ fx, bearing: 0, start: -99, live: false })
    }
  }

  /** @param bearing Degrees clockwise from straight ahead. */
  add(bearing: number, elapsed: number): void {
    let best: ArcSlot | null = null
    for (const s of this.slots) {
      if (s.live && Math.abs(angleDelta(s.bearing, bearing)) < 26) { best = s; break }
    }
    if (!best) {
      let oldest = this.slots[0]
      for (const s of this.slots) {
        if (!s.live) { oldest = s; break }
        if (s.start < oldest.start) oldest = s
      }
      best = oldest
    }
    best.bearing = bearing
    best.start = elapsed
    best.live = true
  }

  clear(): void {
    for (const s of this.slots) {
      s.live = false
      s.fx.opacity(0)
      s.fx.visible(false)
    }
  }

  update(elapsed: number): void {
    for (const s of this.slots) {
      if (!s.live) continue
      const age = elapsed - s.start
      if (age >= ARC_LIFE) {
        s.live = false
        s.fx.opacity(0)
        s.fx.visible(false)
        continue
      }
      const t = age / ARC_LIFE
      // Snap in, hold, then a long tail so the direction lingers just enough.
      const fade = t < 0.08 ? t / 0.08 : Math.pow(1 - (t - 0.08) / 0.92, 1.6)
      s.fx.visible(true)
      s.fx.set(0, 0, s.bearing, 1 + 0.09 * (1 - easeOutCubic(Math.min(t * 3, 1))))
      s.fx.opacity(fade)
    }
  }
}

function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

let defsDone = false
function ensureDefs(): void {
  if (defsDone) return
  defsDone = true
  const svg = svgEl('svg', { width: 0, height: 0, style: 'position:absolute' })
  const defs = svgEl('defs', {}, svg)
  const grad = svgEl('linearGradient', { id: 'codDmgGrad', x1: '0', y1: '0', x2: '1', y2: '0' }, defs)
  svgEl('stop', { offset: '0', 'stop-color': 'rgb(238,72,58)', 'stop-opacity': '0' }, grad)
  svgEl('stop', { offset: '.5', 'stop-color': 'rgb(238,72,58)', 'stop-opacity': '.96' }, grad)
  svgEl('stop', { offset: '1', 'stop-color': 'rgb(238,72,58)', 'stop-opacity': '0' }, grad)
  const core = svgEl('linearGradient', { id: 'codDmgCore', x1: '0', y1: '0', x2: '1', y2: '0' }, defs)
  svgEl('stop', { offset: '0', 'stop-color': 'rgb(255,206,196)', 'stop-opacity': '0' }, core)
  svgEl('stop', { offset: '.45', 'stop-color': 'rgb(255,224,214)', 'stop-opacity': '.95' }, core)
  svgEl('stop', { offset: '1', 'stop-color': 'rgb(255,206,196)', 'stop-opacity': '0' }, core)
  document.body.appendChild(svg)
}

/**
 * Health is never a bar. Damage shows as blood at the screen edge — a
 * procedurally painted splatter multiplied over the frame plus a red edge
 * glow — and clears as health regenerates. Below a third health the whole
 * thing pulses with a double-thump heartbeat.
 */
export class BloodOverlay {
  private wrap: HTMLElement
  private splatter: Fx
  private glow: Fx
  private level = 0
  private punch = 0

  constructor(parent: HTMLElement, seed: number) {
    this.wrap = el('div', 'blood-pulse', parent)
    const splat = el('div', 'blood', this.wrap)
    splat.style.backgroundImage = `url(${bloodTexture(seed)})`
    this.splatter = new Fx(splat)
    this.glow = new Fx(el('div', 'blood-glow', this.wrap))
    this.splatter.opacity(0)
    this.glow.opacity(0)
  }

  /** A sharp spike on impact that decays back to the health-driven level. */
  hit(amount: number): void {
    this.punch = clamp(this.punch + amount * 0.02 + 0.22, 0, 1)
  }

  update(dt: number, healthFraction: number): void {
    const target = clamp(1 - healthFraction, 0, 1)
    // Damage arrives instantly, recovery is slow — the regen read.
    this.level = target > this.level ? target : damp(this.level, target, 2.4, dt)
    this.punch = damp(this.punch, 0, 3.4, dt)

    const v = clamp(this.level * 1.05 + this.punch * 0.5, 0, 1.1)
    // Deliberately non-linear: light damage is a hint at the edge, a near-kill
    // is unmistakable, and the middle never obscures the fight.
    const splat = clamp(Math.pow(v, 1.5) * 0.92, 0, 1)
    this.splatter.opacity(splat)
    this.splatter.visible(splat > 0.004)
    const glow = clamp(Math.pow(v, 1.8) * 0.95, 0, 1)
    this.glow.opacity(glow)
    this.glow.visible(glow > 0.004)
    toggleClass(this.wrap, 'crit', healthFraction < 0.3 && healthFraction > 0)
  }
}

/** Paints a seeded blood splatter, heaviest at the screen edge. */
function bloodTexture(seed: number): string {
  const S = 512
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const g = cv.getContext('2d')!
  const rng = new Rand(seed ^ 0x5eed)

  const blob = (x: number, y: number, r: number, a: number, dark: number) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    const cr = Math.round(168 - dark * 82)
    const cg = Math.round(26 - dark * 18)
    const cb = Math.round(22 - dark * 15)
    grd.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`)
    grd.addColorStop(0.55, `rgba(${cr},${cg},${cb},${a * 0.55})`)
    grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
    g.fillStyle = grd
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }

  const place = (bias: number): [number, number] => {
    const edge = rng.int(0, 3)
    const along = rng.next() * S
    const depth = Math.pow(rng.next(), bias) * S * 0.26
    if (edge === 0) return [along, depth]
    if (edge === 1) return [S - depth, along]
    if (edge === 2) return [along, S - depth]
    return [depth, along]
  }

  // Large wet masses hugging each edge.
  for (let i = 0; i < 76; i++) {
    const [x, y] = place(2.6)
    const r = rng.range(24, 104)
    blob(x, y, r, rng.range(0.36, 0.82), rng.next())
    // A short smear pulling inward, never far enough to reach the action.
    const steps = rng.int(1, 3)
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const tx = x + (S / 2 - x) * t * 0.12
      const ty = y + (S / 2 - y) * t * 0.12
      blob(tx, ty, r * (1 - t * 0.55), rng.range(0.12, 0.34), rng.next())
    }
  }
  // Fine droplets.
  for (let i = 0; i < 240; i++) {
    const [x, y] = place(1.7)
    blob(x, y, rng.range(1.5, 6.5), rng.range(0.35, 0.85), rng.range(0.4, 1))
  }

  // Keep the centre of the screen clear — this must never block the fight.
  g.globalCompositeOperation = 'destination-in'
  const mask = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.72)
  mask.addColorStop(0, 'rgba(0,0,0,0)')
  mask.addColorStop(0.42, 'rgba(0,0,0,.2)')
  mask.addColorStop(0.74, 'rgba(0,0,0,.72)')
  mask.addColorStop(1, 'rgba(0,0,0,1)')
  g.fillStyle = mask
  g.fillRect(0, 0, S, S)
  g.globalCompositeOperation = 'source-over'

  return cv.toDataURL('image/png')
}

/**
 * Thin arc under the reticle that fills while sprinting. Uses the player's
 * `stamina` if the movement system exposes one, otherwise models it locally so
 * the readout still tracks sprint duration.
 */
export class SprintArc {
  private fx: Fx
  private fill: SVGElement
  private stamina = 1
  private rest = 0
  private readonly len: number

  constructor(parent: HTMLElement) {
    const stack = el('div', 'stack', parent)
    const svg = svgEl('svg', { class: 'sprint-arc', viewBox: '-52 -52 104 104' }, stack)
    const R = 42
    const half = 34
    const a0 = (90 - half) * (Math.PI / 180)
    const a1 = (90 + half) * (Math.PI / 180)
    const d = [
      `M${(Math.cos(a1) * R).toFixed(2)} ${(Math.sin(a1) * R).toFixed(2)}`,
      `A${R} ${R} 0 0 0 ${(Math.cos(a0) * R).toFixed(2)} ${(Math.sin(a0) * R).toFixed(2)}`,
    ]
    pathOf(d, { stroke: 'rgba(0,0,0,.4)', 'stroke-width': 4.6, fill: 'none', 'stroke-linecap': 'round' }, svg)
    pathOf(d, { stroke: 'rgba(232,236,231,.16)', 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round' }, svg)
    this.fill = pathOf(d, {
      stroke: 'rgba(154,196,138,.92)', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round',
    }, svg)
    this.len = (2 * half * Math.PI * R) / 180
    this.fill.setAttribute('stroke-dasharray', String(this.len))
    this.fx = new Fx(svg)
    this.fx.opacity(0)
    this.fx.visible(false)
  }

  update(dt: number, sprinting: boolean, external: number | null): void {
    if (external !== null) {
      this.stamina = clamp(external, 0, 1)
    } else if (sprinting) {
      this.stamina = clamp(this.stamina - dt / 6.5, 0, 1)
      this.rest = 0
    } else {
      this.rest += dt
      if (this.rest > 0.5) this.stamina = clamp(this.stamina + dt / 4.2, 0, 1)
    }
    const show = sprinting || this.stamina < 0.995
    this.fx.visible(show)
    if (!show) return
    this.fx.opacity(sprinting ? 0.95 : 0.42 + 0.4 * (1 - this.stamina))
    this.fill.setAttribute('stroke-dashoffset', (this.len * (1 - this.stamina)).toFixed(2))
  }
}

/** Reload / low-ammo callouts stacked above the ammo counter. */
export class Prompts {
  private reload: Fx
  private reloadRow: HTMLElement
  private low: Fx
  private showReload = false
  private showLow = false

  constructor(parent: HTMLElement) {
    const root = el('div', 'prompts', parent)

    const reload = el('div', 'prompt', root)
    el('span', '', reload).textContent = 'RELOAD'
    el('span', 'key', reload).textContent = 'R'
    this.reloadRow = reload
    this.reload = new Fx(reload)
    this.reload.visible(false)

    const low = el('div', 'prompt danger', root)
    low.textContent = 'LOW AMMO'
    this.low = new Fx(low)
    this.low.visible(false)
  }

  update(elapsed: number, needReload: boolean, empty: boolean, lowAmmo: boolean, reloading: boolean): void {
    const wantReload = needReload && !reloading
    if (wantReload !== this.showReload) {
      this.showReload = wantReload
      this.reload.visible(wantReload)
    }
    if (wantReload) {
      toggleClass(this.reloadRow, 'danger', empty)
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * (empty ? 9.5 : 5.5))
      this.reload.opacity(empty ? 0.6 + pulse * 0.4 : 0.55 + pulse * 0.3)
    }

    const wantLow = lowAmmo && !empty && !reloading
    if (wantLow !== this.showLow) {
      this.showLow = wantLow
      this.low.visible(wantLow)
    }
    if (wantLow) this.low.opacity(0.55 + 0.35 * Math.sin(elapsed * 6.2))
  }
}

/** Centre-screen objective / streak callout. */
export class MessageToast {
  private fx: Fx
  private text: TextSlot
  private until = -1
  private start = -1

  constructor(parent: HTMLElement) {
    const root = el('div', 'message', parent)
    this.text = new TextSlot(el('div', 'txt', root))
    el('div', 'rule', root)
    this.fx = new Fx(root)
    this.fx.visible(false)
  }

  show(text: string, seconds: number, elapsed: number): void {
    this.text.set(text)
    this.start = elapsed
    this.until = elapsed + Math.max(0.6, seconds)
    this.fx.visible(true)
  }

  update(elapsed: number): void {
    if (this.until < 0) return
    if (elapsed > this.until) {
      this.until = -1
      this.fx.visible(false)
      return
    }
    const age = elapsed - this.start
    const remain = this.until - elapsed
    const fade = Math.min(1, age / 0.22) * Math.min(1, remain / 0.45)
    this.fx.opacity(fade)
    this.fx.set(0, (1 - Math.min(1, age / 0.35)) * -6, 0, 1)
  }
}

/** Frame-time / draw-call overlay, enabled with `?stats=1`. */
export class StatsOverlay {
  private root: HTMLElement
  private line1: TextSlot
  private line2: TextSlot
  private line3: TextSlot
  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private history = new Float32Array(112)
  private cursor = 0
  private acc = 0
  private frames = 0
  private msAvg = 16
  private since = 0

  constructor(parent: HTMLElement) {
    this.root = el('div', 'stats', parent)
    this.line1 = new TextSlot(el('div', '', this.root))
    this.line2 = new TextSlot(el('div', '', this.root))
    this.line3 = new TextSlot(el('div', '', this.root))
    this.canvas = el('canvas', '', this.root)
    this.canvas.width = 224
    this.canvas.height = 52
    this.g = this.canvas.getContext('2d')!
    this.root.style.display = 'none'
  }

  setEnabled(on: boolean): void {
    this.root.style.display = on ? '' : 'none'
  }

  update(dt: number, ms: number, calls: number, tris: number, programs: number): void {
    this.msAvg += (ms - this.msAvg) * 0.08
    this.history[this.cursor] = ms
    this.cursor = (this.cursor + 1) % this.history.length
    this.acc += dt
    this.frames++
    this.since += dt

    if (this.since < 0.2) return
    this.since = 0
    const fps = this.acc > 0 ? this.frames / this.acc : 0
    this.acc = 0
    this.frames = 0
    this.line1.set(`${this.msAvg.toFixed(2)} ms   ${fps.toFixed(0)} fps`)
    this.line2.set(`draw ${calls}   tri ${formatCount(tris)}`)
    this.line3.set(`prog ${programs}`)
    this.drawGraph()
  }

  private drawGraph(): void {
    const g = this.g
    const w = this.canvas.width
    const h = this.canvas.height
    g.clearRect(0, 0, w, h)
    g.fillStyle = 'rgba(232,236,231,.05)'
    g.fillRect(0, 0, w, h)
    // 16.7 ms reference line.
    const y60 = h - (16.7 / 33) * h
    g.strokeStyle = 'rgba(214,168,88,.45)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(0, y60)
    g.lineTo(w, y60)
    g.stroke()

    g.beginPath()
    const n = this.history.length
    for (let i = 0; i < n; i++) {
      const v = this.history[(this.cursor + i) % n]
      const x = (i / (n - 1)) * w
      const y = h - Math.min(v / 33, 1) * h
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.strokeStyle = 'rgba(154,196,138,.9)'
    g.lineWidth = 1.5
    g.stroke()
  }
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}
