import { Fx, clamp, easeOutCubic, el, pathOf, svgEl } from './Style'

export type HitKind = 'normal' | 'headshot' | 'kill'

/** Length of one crosshair tick, in design pixels. */
const TICK = 8.5
/** Hitmarker lifetime — deliberately snappy. */
const HIT_LIFE = 0.13

/**
 * Four-tick reticle with a centre dot. The ticks sit `spread` design-pixels
 * from centre and are driven every frame from the weapon's cone of fire, so
 * firing, sprinting and jumping all read instantly. Hidden while aiming down
 * sights, where the optic takes over.
 */
export class Crosshair {
  readonly root: HTMLDivElement

  private ticks: Fx[] = []
  private dot: Fx
  private wrap: Fx
  private hitWrap: Fx
  private hitLayers: Record<HitKind, HTMLElement> = {} as Record<HitKind, HTMLElement>

  private scale = 1
  private spread = 6
  private hitAt = -99
  private hitKind: HitKind = 'normal'
  private hitVisible = false

  constructor(parent: HTMLElement) {
    this.root = el('div', 'stack xh', parent)
    this.wrap = new Fx(this.root)

    for (let i = 0; i < 4; i++) {
      this.ticks.push(new Fx(el('div', `xh-tick ${i < 2 ? 'v' : 'h'}`, this.root)))
    }
    this.dot = new Fx(el('div', 'xh-dot', this.root))

    const svg = svgEl('svg', { class: 'hitmark', viewBox: '-24 -24 48 48' }, this.root) as SVGElement
    this.hitWrap = new Fx(svg)
    this.hitLayers.normal = this.buildHit(svg, 'normal') as unknown as HTMLElement
    this.hitLayers.headshot = this.buildHit(svg, 'headshot') as unknown as HTMLElement
    this.hitLayers.kill = this.buildHit(svg, 'kill') as unknown as HTMLElement
    this.hitWrap.opacity(0)
    this.hitWrap.visible(false)
  }

  /**
   * Four diagonal strokes drawn twice — a dark casing first so the marker
   * survives against a bright sky, then the bright stroke on top.
   */
  private buildHit(parent: SVGElement, kind: HitKind): SVGElement {
    const g = svgEl('g', {}, parent)
    const inner = kind === 'headshot' ? 4.6 : 5.4
    const outer = kind === 'headshot' ? 15.5 : 12.6
    const width = kind === 'kill' ? 3 : kind === 'headshot' ? 2.1 : 2.6
    const d: string[] = []
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2
      const cx = Math.cos(a)
      const cy = Math.sin(a)
      d.push(`M${(cx * inner).toFixed(2)} ${(cy * inner).toFixed(2)} L${(cx * outer).toFixed(2)} ${(cy * outer).toFixed(2)}`)
    }
    const colour = kind === 'kill' ? 'rgba(228,62,50,.98)' : 'rgba(240,244,238,.97)'
    pathOf(d, {
      stroke: 'rgba(0,0,0,.6)',
      'stroke-width': width + 1.9,
      'stroke-linecap': 'butt',
      fill: 'none',
    }, g)
    pathOf(d, {
      stroke: colour,
      'stroke-width': width,
      'stroke-linecap': 'butt',
      fill: 'none',
    }, g)
    if (kind === 'headshot') {
      // A hairline diamond marks the sharper headshot variant.
      pathOf(['M0 -3.4 L3.4 0 L0 3.4 L-3.4 0 Z'], {
        stroke: colour, 'stroke-width': 1.1, fill: 'none',
      }, g)
    }
    if (kind === 'kill') {
      pathOf(['M0 -17.5 L2.3 -13.6 L-2.3 -13.6 Z'], { fill: colour }, g)
    }
    g.setAttribute('display', 'none')
    return g
  }

  layout(scale: number): void {
    this.scale = scale
  }

  hitmarker(kind: HitKind, elapsed: number): void {
    this.hitAt = elapsed
    this.hitKind = kind
    for (const k of ['normal', 'headshot', 'kill'] as HitKind[]) {
      this.hitLayers[k].setAttribute('display', k === kind ? '' : 'none')
    }
  }

  /**
   * @param spreadPx  Half-angle of the cone of fire projected to design pixels.
   * @param ads       0..1 aim-down-sights blend; the reticle yields to the optic.
   */
  update(elapsed: number, spreadPx: number, ads: number, hidden: boolean): void {
    this.spread = spreadPx
    const s = this.scale
    const off = (this.spread + TICK * 0.5) * s

    this.ticks[0].set(0, -off)
    this.ticks[1].set(0, off)
    this.ticks[2].set(-off, 0)
    this.ticks[3].set(off, 0)

    // The reticle hands over to the optic, but only once the optic is actually
    // near the eye. Fading it out in the first third of the blend left the
    // screen centre completely unmarked for most of the raise.
    const fade = hidden ? 0 : 1 - clamp((ads - 0.38) / 0.44, 0, 1)
    this.wrap.opacity(fade)
    this.wrap.visible(fade > 0.002)
    this.dot.opacity(1 - clamp((ads - 0.12) / 0.34, 0, 1))

    const age = elapsed - this.hitAt
    if (age >= 0 && age < HIT_LIFE) {
      const t = age / HIT_LIFE
      const k = easeOutCubic(t)
      const scale = (1.42 - 0.44 * k) * (this.hitKind === 'kill' ? 1.12 : 1)
      this.hitWrap.set(0, 0, 0, scale)
      this.hitWrap.opacity(t < 0.42 ? 1 : 1 - (t - 0.42) / 0.58)
      if (!this.hitVisible) {
        this.hitVisible = true
        this.hitWrap.visible(true)
      }
    } else if (this.hitVisible) {
      this.hitVisible = false
      this.hitWrap.opacity(0)
      this.hitWrap.visible(false)
    }
  }
}
