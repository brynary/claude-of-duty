import { TextSlot, el } from './Style'

export type MarkerKind = 'enemy' | 'objective' | 'friendly'

export interface CompassMarker {
  bearing: number
  kind: MarkerKind
  /** 0..1 fade, used so contacts decay rather than vanish. */
  strength: number
}

/** Degrees of arc visible across the strip. */
const SPAN = 120
const FONT = `'DIN Condensed','Oswald','Arial Narrow','Roboto Condensed','Liberation Sans Narrow','Helvetica Neue',sans-serif`

/**
 * Top-centre scrolling heading strip. The 360° ruler is rasterised once into
 * an off-screen canvas and blitted with wrap-around each frame, so scrolling
 * costs one `drawImage` rather than sixty text draws.
 */
export class Compass {
  readonly root: HTMLDivElement

  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private strip: HTMLCanvasElement
  private sg: CanvasRenderingContext2D
  private objectiveText: TextSlot
  private scoreText: TextSlot

  private w = 1
  private h = 1
  private ppd = 1
  private unit = 1

  constructor(parent: HTMLElement) {
    this.root = el('div', 'compass', parent)
    this.canvas = el('canvas', '', this.root)
    this.g = this.canvas.getContext('2d')!
    this.strip = document.createElement('canvas')
    this.sg = this.strip.getContext('2d')!
    el('div', 'compass-caret', this.root)

    const obj = el('div', 'objective', parent)
    el('div', 'dot', obj)
    this.objectiveText = new TextSlot(el('div', 'lbl', obj))
    el('div', 'sep', obj)
    this.scoreText = new TextSlot(el('div', 'lbl score', obj))
    this.objectiveText.set('SECURE THE PLAZA')
    this.scoreText.set('0 / 12')
  }

  setObjective(text: string): void {
    this.objectiveText.set(text.toUpperCase())
  }

  setScore(text: string): void {
    this.scoreText.set(text)
  }

  layout(scale: number, dpr: number): void {
    this.unit = scale * dpr
    this.w = Math.round(470 * this.unit)
    this.h = Math.round(34 * this.unit)
    this.canvas.width = this.w
    this.canvas.height = this.h
    this.ppd = this.w / SPAN
    this.buildStrip()
  }

  /** Rasterises the full 360° ruler once per resolution change. */
  private buildStrip(): void {
    const u = this.unit
    const stripW = Math.round(360 * this.ppd)
    this.strip.width = stripW
    this.strip.height = this.h
    const g = this.sg
    g.clearRect(0, 0, stripW, this.h)

    // Every tick is drawn twice — a dark casing offset a pixel down-right,
    // then the bright stroke. A single light hairline disappears the moment
    // the ribbon crosses a sunlit wall.
    const baseY = this.h - Math.round(4 * u)
    const off = Math.max(1, Math.round(u))
    for (let pass = 0; pass < 2; pass++) {
      const shadow = pass === 0
      for (let deg = 0; deg < 360; deg += 5) {
        const x = Math.round(deg * this.ppd) + 0.5 + (shadow ? off : 0)
        const major = deg % 15 === 0
        const cardinal = deg % 45 === 0
        const len = cardinal ? 10 * u : major ? 7.5 * u : 4.5 * u
        g.strokeStyle = shadow
          ? 'rgba(4,7,6,.72)'
          : cardinal ? 'rgba(242,246,240,.92)'
            : major ? 'rgba(232,236,231,.72)' : 'rgba(232,236,231,.46)'
        g.lineWidth = Math.max(1, shadow ? u * 1.3 : u)
        g.beginPath()
        g.moveTo(x, baseY + (shadow ? off : 0))
        g.lineTo(x, baseY - len + (shadow ? off : 0))
        g.stroke()
      }
    }

    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    const labelY = baseY - 13 * u
    for (let deg = 0; deg < 360; deg += 15) {
      const x = Math.round(deg * this.ppd)
      const cardinal = CARDINALS[deg]
      if (cardinal) {
        const primary = cardinal.length === 1
        g.font = `600 ${(primary ? 20 : 13.5) * u}px ${FONT}`
        setSpacing(g, (primary ? 1.6 : 1.2) * u)
        g.fillStyle = 'rgba(4,7,6,.78)'
        g.fillText(cardinal, x + u, labelY + Math.max(1, u))
        g.fillStyle = primary ? 'rgba(242,246,240,.95)' : 'rgba(232,236,231,.8)'
        g.fillText(cardinal, x, labelY)
      } else {
        g.font = `500 ${10.5 * u}px ${FONT}`
        setSpacing(g, 0.9 * u)
        g.fillStyle = 'rgba(4,7,6,.72)'
        g.fillText(pad3(deg), x + u, labelY - 1 * u + u)
        g.fillStyle = 'rgba(232,236,231,.64)'
        g.fillText(pad3(deg), x, labelY - 1 * u)
      }
    }
    setSpacing(g, 0)
  }

  update(heading: number, markers: CompassMarker[], count: number): void {
    const g = this.g
    const w = this.w
    const h = this.h
    g.clearRect(0, 0, w, h)

    const stripW = this.strip.width
    let sx = ((heading - SPAN / 2) * this.ppd) % stripW
    if (sx < 0) sx += stripW
    const first = Math.min(w, stripW - sx)
    g.drawImage(this.strip, sx, 0, first, h, 0, 0, first, h)
    if (first < w) g.drawImage(this.strip, 0, 0, w - first, h, first, 0, w - first, h)

    const u = this.unit
    for (let i = 0; i < count; i++) {
      const m = markers[i]
      let rel = (m.bearing - heading) % 360
      if (rel > 180) rel -= 360
      if (rel < -180) rel += 360
      const off = Math.abs(rel) > SPAN / 2 - 4
      const x = Math.round(w / 2 + Math.max(-SPAN / 2 + 4, Math.min(SPAN / 2 - 4, rel)) * this.ppd)
      const y = Math.round(4.5 * u)
      const a = m.strength * (off ? 0.34 : 1)
      if (a <= 0.02) continue
      g.save()
      g.translate(x, y)
      g.rotate(Math.PI / 4)
      const r = (m.kind === 'objective' ? 4 : 3.4) * u
      g.fillStyle = 'rgba(6,9,8,.6)'
      g.fillRect(-r - u, -r - u, (r + u) * 2, (r + u) * 2)
      g.fillStyle = m.kind === 'enemy'
        ? `rgba(226,64,52,${a})`
        : m.kind === 'objective' ? `rgba(214,168,88,${a})` : `rgba(154,196,138,${a})`
      g.fillRect(-r, -r, r * 2, r * 2)
      g.restore()
    }
  }
}

const CARDINALS: Record<number, string> = {
  0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
}

function pad3(v: number): string {
  return v < 10 ? `00${v}` : v < 100 ? `0${v}` : String(v)
}

/** `letterSpacing` is Chromium-only; degrade quietly elsewhere. */
function setSpacing(g: CanvasRenderingContext2D, px: number): void {
  const ctx = g as CanvasRenderingContext2D & { letterSpacing?: string }
  if (typeof ctx.letterSpacing === 'string') ctx.letterSpacing = `${px}px`
}
