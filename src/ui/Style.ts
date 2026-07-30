/**
 * Shared HUD look: palette, the single injected stylesheet, and the small DOM
 * helpers every widget uses.
 *
 * Layout rules for the whole UI layer:
 *  - Sizes are expressed in `calc(N * var(--px))` where `--px` is one *design*
 *    pixel scaled to the viewport, so the HUD is resolution independent.
 *  - Per-frame animation only ever touches `transform` and `opacity` (see
 *    `Fx`), never a layout or paint-heavy property.
 */

export const PALETTE = {
  /** Off-white with a hint of green — never pure white. */
  fg: '232,236,231',
  /** Desaturated tactical green: friendly, UI accents. */
  accent: '154,196,138',
  /** Objective / warning amber. */
  amber: '214,168,88',
  /** Damage and enemies only. */
  danger: '226,64,52',
  ink: '6,9,8',
} as const

/**
 * Legibility rule for the whole layer: nothing is drawn as an unsupported
 * bright mark. Every light element gets either a dark 1px casing (`--sh`), a
 * heavier outline for headline type (`--ol`), or a gradient scrim behind it
 * (`--scrim-*`). The HUD has to survive a sunlit stucco wall and a black
 * interior in the same frame.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  parent?: Node,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (parent) parent.appendChild(node)
  return node
}

export function svgEl(tag: string, attrs?: Record<string, string | number>, parent?: Node): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  if (attrs) for (const k in attrs) node.setAttribute(k, String(attrs[k]))
  if (parent) parent.appendChild(node)
  return node
}

/** Builds one `<path>` from several sub-paths so a glyph is a single node. */
export function pathOf(parts: readonly string[], attrs?: Record<string, string | number>, parent?: Node): SVGElement {
  return svgEl('path', { d: parts.join(' '), ...attrs }, parent)
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Frame-rate independent exponential smoothing. `dt === 0` freezes it. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  if (dt <= 0) return current
  return current + (target - current) * (1 - Math.exp(-lambda * dt))
}

export function easeOutCubic(t: number): number {
  const u = 1 - t
  return 1 - u * u * u
}

/**
 * Writes `transform` / `opacity` on an element without allocating a string
 * unless the quantised value actually changed. Everything animated per frame
 * goes through this.
 */
export class Fx {
  readonly node: HTMLElement | SVGElement
  private qx = NaN
  private qy = NaN
  private qr = NaN
  private qs = NaN
  private qo = NaN
  /** Undefined until the first write, so the DOM and this cache cannot drift. */
  private shown: boolean | undefined

  constructor(node: HTMLElement | SVGElement) {
    this.node = node
  }

  /** Pixel offsets, degrees, uniform scale. */
  set(x: number, y: number, rotDeg = 0, scale = 1): void {
    const qx = Math.round(x * 8)
    const qy = Math.round(y * 8)
    const qr = Math.round(rotDeg * 8)
    const qs = Math.round(scale * 500)
    if (qx === this.qx && qy === this.qy && qr === this.qr && qs === this.qs) return
    this.qx = qx
    this.qy = qy
    this.qr = qr
    this.qs = qs
    ;(this.node as HTMLElement).style.transform =
      `translate3d(${qx / 8}px,${qy / 8}px,0) rotate(${qr / 8}deg) scale(${qs / 500})`
  }

  opacity(v: number): void {
    const q = Math.round(clamp(v, 0, 1) * 250)
    if (q === this.qo) return
    this.qo = q
    ;(this.node as HTMLElement).style.opacity = q === 250 ? '1' : String(q / 250)
  }

  /** `display` toggle so fully faded widgets stop compositing entirely. */
  visible(on: boolean): void {
    if (on === this.shown) return
    this.shown = on
    ;(this.node as HTMLElement).style.display = on ? '' : 'none'
  }
}

/** Sets textContent only when it differs — avoids per-frame layout. */
export class TextSlot {
  private last = ' '
  constructor(readonly node: HTMLElement) {}
  set(v: string): void {
    if (v === this.last) return
    this.last = v
    this.node.textContent = v
  }
}

export function toggleClass(node: Element, cls: string, on: boolean): void {
  if (on === node.classList.contains(cls)) return
  node.classList.toggle(cls, on)
}

const CSS = `
#cod-hud, #cod-menu {
  position: fixed; inset: 0;
  --s: 1;
  --px: calc(var(--s) * 1px);
  --fg: ${PALETTE.fg};
  --accent: ${PALETTE.accent};
  --amber: ${PALETTE.amber};
  --danger: ${PALETTE.danger};
  --ink: ${PALETTE.ink};
  --f: 'DIN Condensed', 'Oswald', 'Arial Narrow', 'Roboto Condensed', 'Liberation Sans Narrow', 'Helvetica Neue', system-ui, sans-serif;
  --fm: ui-monospace, 'SF Mono', 'Menlo', 'Consolas', monospace;
  --sh:
    0 0 calc(1 * var(--px)) rgba(2,4,4,.88),
    0 calc(1 * var(--px)) calc(2 * var(--px)) rgba(2,4,4,.9),
    0 0 calc(10 * var(--px)) rgba(2,4,4,.5);
  --ol:
    0 0 calc(1.4 * var(--px)) rgba(2,4,4,.95),
    calc(1 * var(--px)) calc(1 * var(--px)) calc(2 * var(--px)) rgba(2,4,4,.86),
    calc(-1 * var(--px)) calc(1 * var(--px)) calc(2 * var(--px)) rgba(2,4,4,.7),
    0 calc(2 * var(--px)) calc(7 * var(--px)) rgba(2,4,4,.8),
    0 0 calc(22 * var(--px)) rgba(2,4,4,.45);
  font-family: var(--f);
  font-weight: 500;
  color: rgba(var(--fg), .9);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1, 'lnum' 1;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
/* Clipping to the viewport keeps the feathered scrims — which deliberately
   extend past their widgets — from spilling outside it. */
#cod-hud { z-index: 10; pointer-events: none; overflow: hidden; transition: opacity .28s ease; }
#cod-menu { z-index: 20; pointer-events: none; }
#cod-hud.is-hidden { opacity: 0; }
#cod-hud.hud-off { display: none; }
#cod-hud .lbl {
  font-size: calc(11 * var(--px));
  letter-spacing: calc(2.1 * var(--px));
  text-transform: uppercase;
  text-shadow: var(--sh);
  color: rgba(var(--fg), .74);
}

/* ---------------------------------------------------------------- crosshair */
#cod-hud .center {
  position: absolute; inset: 0;
  display: grid; place-items: center; place-content: center;
}
/* Zero-sized grid stacks: every child centres on the exact screen centre and
   overflows symmetrically, so nothing needs a -50% correction in transforms.
   place-content centres the (content-sized) track on the zero-sized box, then
   place-items centres each child inside that track. */
#cod-hud .center > * { grid-area: 1 / 1; }
#cod-hud .stack {
  display: grid; place-items: center; place-content: center;
  width: 0; height: 0;
}
#cod-hud .stack > * { grid-area: 1 / 1; }
#cod-hud .xh-tick {
  background: rgba(var(--fg), .88);
  box-shadow:
    0 0 0 calc(1 * var(--px)) rgba(2,4,4,.78),
    0 0 calc(5 * var(--px)) rgba(2,4,4,.65);
  will-change: transform;
}
#cod-hud .xh-tick.v { width: calc(1.8 * var(--px)); height: calc(8.5 * var(--px)); }
#cod-hud .xh-tick.h { width: calc(8.5 * var(--px)); height: calc(1.8 * var(--px)); }
#cod-hud .xh-dot {
  width: calc(2.2 * var(--px)); height: calc(2.2 * var(--px));
  border-radius: 50%;
  background: rgba(var(--fg), .9);
  box-shadow: 0 0 0 calc(1 * var(--px)) rgba(2,4,4,.82), 0 0 calc(4 * var(--px)) rgba(2,4,4,.5);
}
#cod-hud .hitmark { width: calc(56 * var(--px)); height: calc(56 * var(--px)); overflow: visible; will-change: transform, opacity; }
#cod-hud .sprint-arc { width: calc(104 * var(--px)); height: calc(104 * var(--px)); overflow: visible; }

/* ------------------------------------------------------- damage indicators */
#cod-hud .dmg-arc {
  width: calc(250 * var(--px)); height: calc(250 * var(--px));
  overflow: visible;
  will-change: transform, opacity;
}

/* -------------------------------------------------------------- blood / hp */
#cod-hud .blood {
  position: absolute; inset: 0;
  background-size: 100% 100%;
  mix-blend-mode: multiply;
  will-change: opacity;
}
#cod-hud .blood-glow {
  position: absolute; inset: 0;
  background:
    radial-gradient(72% 62% at 50% 50%, rgba(0,0,0,0) 44%, rgba(116,12,10,.38) 80%, rgba(78,5,5,.82) 100%);
  will-change: opacity;
}
#cod-hud .blood-pulse { position: absolute; inset: 0; }
#cod-hud .blood-pulse.crit { animation: codHeartbeat 1.15s ease-in-out infinite; }
@keyframes codHeartbeat {
  0%   { opacity: .55; }
  8%   { opacity: 1; }
  20%  { opacity: .6; }
  30%  { opacity: .92; }
  48%  { opacity: .5; }
  100% { opacity: .55; }
}

/* ---------------------------------------------------------------- minimap */
#cod-hud .minimap {
  position: absolute;
  left: calc(34 * var(--px)); top: calc(30 * var(--px));
  width: calc(186 * var(--px)); height: calc(186 * var(--px));
}
/* A soft pool of shadow under the whole widget so the label and the frame
   edge hold against a sunlit wall as well as against a dark interior. */
#cod-hud .minimap::before {
  content: '';
  position: absolute;
  left: calc(-46 * var(--px)); top: calc(-40 * var(--px));
  right: calc(-46 * var(--px)); bottom: calc(-40 * var(--px));
  background: radial-gradient(46% 44% at 44% 48%,
    rgba(3,5,6,.3) 0%, rgba(3,5,6,.24) 40%, rgba(3,5,6,.11) 70%, rgba(3,5,6,.03) 88%, rgba(3,5,6,0) 100%);
  z-index: -1;
}
#cod-hud .minimap-frame {
  position: absolute; inset: 0;
  border-radius: calc(7 * var(--px));
  background: rgb(10,14,16);
  box-shadow:
    0 calc(3 * var(--px)) calc(18 * var(--px)) rgba(0,0,0,.58),
    0 calc(1 * var(--px)) calc(3 * var(--px)) rgba(0,0,0,.6);
  overflow: hidden;
}
#cod-hud .minimap canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#cod-hud .minimap-tag {
  position: absolute; left: calc(1 * var(--px)); top: calc(-16 * var(--px));
  display: flex; gap: calc(7 * var(--px)); align-items: center;
}
#cod-hud .minimap-tag::before {
  content: '';
  width: calc(2 * var(--px)); height: calc(9 * var(--px));
  background: rgba(var(--accent), .8);
  box-shadow: 0 0 calc(5 * var(--px)) rgba(var(--accent), .35);
}
#cod-hud .minimap-tag b {
  font-weight: 600;
  color: rgba(var(--accent), .88);
  letter-spacing: calc(2.4 * var(--px));
  font-size: calc(11 * var(--px));
  text-shadow: var(--sh);
}

/* ---------------------------------------------------------------- compass */
#cod-hud .compass {
  position: absolute; left: 50%; top: calc(18 * var(--px));
  width: calc(470 * var(--px)); height: calc(34 * var(--px));
  transform: translateX(-50%);
}
/* The whole scrim lives on an oversized pseudo-element and reaches zero alpha
   before that element's edge, so the ruler never sits on a hard-edged plate —
   a rectangle of flat grey is the single clearest "browser UI" tell. */
#cod-hud .compass::before {
  content: '';
  position: absolute;
  left: calc(-56 * var(--px)); right: calc(-56 * var(--px));
  top: calc(-28 * var(--px)); bottom: calc(-22 * var(--px));
  background: radial-gradient(44% 46% at 50% 50%,
    rgba(4,7,7,.36) 0%, rgba(4,7,7,.3) 34%, rgba(4,7,7,.18) 62%, rgba(4,7,7,.06) 84%, rgba(4,7,7,0) 100%);
  z-index: -1;
}
#cod-hud .compass::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: 0;
  height: calc(1 * var(--px));
  background: linear-gradient(90deg,
    rgba(232,236,231,0) 0%, rgba(232,236,231,.22) 22%, rgba(232,236,231,.34) 50%, rgba(232,236,231,.22) 78%, rgba(232,236,231,0) 100%);
}
#cod-hud .compass canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 9%, #000 91%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 9%, #000 91%, transparent 100%);
}
#cod-hud .compass-caret {
  position: absolute; left: 50%; top: calc(-5 * var(--px));
  width: 0; height: 0;
  border-left: calc(4.5 * var(--px)) solid transparent;
  border-right: calc(4.5 * var(--px)) solid transparent;
  border-top: calc(5.5 * var(--px)) solid rgba(var(--fg), .9);
  transform: translateX(-50%);
  filter: drop-shadow(0 calc(1 * var(--px)) calc(1.5 * var(--px)) rgba(0,0,0,.8));
}
#cod-hud .objective {
  position: absolute; left: 50%; top: calc(59 * var(--px));
  transform: translateX(-50%);
  display: flex; align-items: center; gap: calc(9 * var(--px));
  white-space: nowrap;
}
#cod-hud .objective::before {
  content: '';
  position: absolute;
  left: calc(-46 * var(--px)); right: calc(-46 * var(--px));
  top: calc(-14 * var(--px)); bottom: calc(-14 * var(--px));
  background: radial-gradient(44% 44% at 50% 50%,
    rgba(4,7,7,.34) 0%, rgba(4,7,7,.26) 44%, rgba(4,7,7,.09) 76%, rgba(4,7,7,0) 100%);
  z-index: -1;
}
#cod-hud .objective .dot {
  width: calc(5 * var(--px)); height: calc(5 * var(--px));
  background: rgba(var(--amber), .9);
  transform: rotate(45deg);
  box-shadow: 0 0 calc(6 * var(--px)) rgba(var(--amber), .5);
}
#cod-hud .objective .sep { width: calc(1 * var(--px)); height: calc(9 * var(--px)); background: rgba(var(--fg), .26); }
#cod-hud .objective .score { color: rgba(var(--accent), .82); letter-spacing: calc(2.4 * var(--px)); }

/* --------------------------------------------------------------- killfeed */
#cod-hud .killfeed {
  position: absolute; right: calc(34 * var(--px)); top: calc(30 * var(--px));
  display: flex; flex-direction: column; align-items: flex-end;
  gap: calc(3 * var(--px));
  width: calc(420 * var(--px));
}
#cod-hud .kf-row {
  display: flex; align-items: center; justify-content: flex-end;
  gap: calc(7 * var(--px));
  padding: calc(3 * var(--px)) calc(7 * var(--px)) calc(3.5 * var(--px)) calc(9 * var(--px));
  background: linear-gradient(90deg, rgba(4,7,7,0) 0%, rgba(4,7,7,.5) 40%, rgba(4,7,7,.6) 100%);
  border-right: calc(1.5 * var(--px)) solid rgba(var(--fg), .16);
  animation: codKfIn .22s cubic-bezier(.2,.8,.25,1) both;
  will-change: transform, opacity;
}
#cod-hud .kf-row.mine { border-right-color: rgba(var(--accent), .75); }
#cod-hud .kf-row.victim-me { border-right-color: rgba(var(--danger), .8); }
@keyframes codKfIn {
  from { opacity: 0; transform: translateX(calc(16 * var(--px))); }
  to   { opacity: 1; transform: none; }
}
#cod-hud .kf-name {
  font-size: calc(14 * var(--px));
  letter-spacing: calc(1.5 * var(--px));
  text-transform: uppercase;
  text-shadow: var(--sh);
  color: rgba(var(--fg), .84);
}
/* Colour is team, never role. Ally and player share a hue at two weights, so
   the player still reads first among friendlies. */
#cod-hud .kf-name.me { color: rgba(var(--accent), .98); font-weight: 600; }
#cod-hud .kf-name.ally { color: rgba(var(--accent), .84); }
#cod-hud .kf-name.foe { color: rgba(var(--danger), .94); }
#cod-hud .kf-icon { height: calc(13 * var(--px)); width: calc(40 * var(--px)); overflow: visible; }
#cod-hud .kf-hs { height: calc(12 * var(--px)); width: calc(10 * var(--px)); margin-left: calc(-3 * var(--px)); }

/* ------------------------------------------------------------------- ammo */
#cod-hud .ammo {
  position: absolute; right: calc(38 * var(--px)); bottom: calc(30 * var(--px));
  display: flex; flex-direction: column; align-items: flex-end;
}
/* Legibility scrim. The counter sits over whatever the level happens to put
   in the bottom-right corner — sunlit stucco in one pose, black shadow in the
   next — so it carries its own soft ground rather than relying on the frame. */
#cod-hud .ammo::before {
  content: '';
  position: absolute;
  right: calc(-70 * var(--px)); bottom: calc(-70 * var(--px));
  left: calc(-230 * var(--px)); top: calc(-160 * var(--px));
  background: radial-gradient(56% 54% at 76% 64%,
    rgba(3,5,6,.42) 0%, rgba(3,5,6,.34) 30%, rgba(3,5,6,.2) 56%, rgba(3,5,6,.07) 79%, rgba(3,5,6,0) 100%);
  z-index: -1;
}
#cod-hud .ammo-name {
  font-size: calc(15 * var(--px));
  letter-spacing: calc(3.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .8);
  text-shadow: var(--sh);
}
#cod-hud .ammo-rule {
  width: calc(150 * var(--px)); height: calc(1 * var(--px));
  margin: calc(5 * var(--px)) 0 calc(2 * var(--px));
  background: linear-gradient(90deg, rgba(var(--fg),0), rgba(var(--fg),.3) 70%, rgba(var(--fg),.46));
  box-shadow: 0 calc(1 * var(--px)) 0 rgba(2,4,4,.55);
}
#cod-hud .ammo-nums { display: flex; align-items: baseline; gap: calc(4 * var(--px)); }
#cod-hud .ammo-mag {
  font-size: calc(54 * var(--px));
  line-height: .92;
  font-weight: 600;
  letter-spacing: calc(-0.5 * var(--px));
  color: rgba(var(--fg), .87);
  text-shadow: var(--ol);
  transition: color .18s linear;
  transform-origin: 50% 88%;
  will-change: transform;
}
#cod-hud .ammo.low .ammo-mag { color: rgba(var(--danger), .94); }
#cod-hud .ammo-slash { font-size: calc(24 * var(--px)); color: rgba(var(--fg), .32); text-shadow: var(--sh); }
#cod-hud .ammo-res { font-size: calc(21 * var(--px)); color: rgba(var(--fg), .62); letter-spacing: calc(.6 * var(--px)); text-shadow: var(--sh); }
#cod-hud .ammo-meta {
  display: flex; align-items: center; gap: calc(8 * var(--px));
  margin-top: calc(6 * var(--px));
}
#cod-hud .ammo-mode {
  font-size: calc(11 * var(--px));
  letter-spacing: calc(2.2 * var(--px));
  padding: calc(1.5 * var(--px)) calc(5 * var(--px)) calc(2 * var(--px));
  color: rgba(var(--fg), .74);
  border: calc(1 * var(--px)) solid rgba(var(--fg), .22);
  background: rgba(3,5,6,.3);
  text-shadow: var(--sh);
}
/* Rounds left in the magazine, not spare magazines — same value as the
   numeral above it, so an empty gun reads empty in both places. */
#cod-hud .pips { display: flex; gap: calc(3 * var(--px)); }
#cod-hud .pip {
  width: calc(5 * var(--px)); height: calc(12 * var(--px));
  transform: skewX(-16deg);
  background: rgba(var(--fg), .07);
  box-shadow: inset 0 0 0 calc(1 * var(--px)) rgba(var(--fg), .16), 0 0 calc(3 * var(--px)) rgba(2,4,4,.5);
}
#cod-hud .pip.on {
  background: rgba(var(--fg), .74);
  box-shadow: 0 0 calc(4 * var(--px)) rgba(2,4,4,.75), inset 0 0 0 calc(1 * var(--px)) rgba(2,4,4,.35);
}
#cod-hud .ammo.low .pip.on { background: rgba(var(--danger), .86); }
/* An empty magazine outlines the whole bar, so "no rounds" reads even at a
   glance from the corner of the eye. */
#cod-hud .ammo.dry .pip {
  box-shadow: inset 0 0 0 calc(1 * var(--px)) rgba(var(--danger), .42), 0 0 calc(3 * var(--px)) rgba(2,4,4,.5);
}

/* ---------------------------------------------------------------- prompts */
#cod-hud .prompts {
  position: absolute; right: calc(38 * var(--px)); bottom: calc(152 * var(--px));
  display: flex; flex-direction: column; align-items: flex-end; gap: calc(5 * var(--px));
}
#cod-hud .prompt {
  display: flex; align-items: center; gap: calc(7 * var(--px));
  font-size: calc(13 * var(--px));
  letter-spacing: calc(2.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--amber), .92);
  text-shadow: var(--sh);
  will-change: opacity;
}
#cod-hud .prompt.danger { color: rgba(var(--danger), .92); }
#cod-hud .key {
  display: inline-grid; place-items: center;
  min-width: calc(16 * var(--px)); height: calc(16 * var(--px));
  padding: 0 calc(3 * var(--px));
  font-size: calc(10 * var(--px));
  letter-spacing: calc(.5 * var(--px));
  color: rgba(var(--fg), .88);
  border: calc(1 * var(--px)) solid rgba(var(--fg), .38);
  border-radius: calc(2 * var(--px));
  background: rgba(6,9,8,.45);
}

/* --------------------------------------------------------------- messages */
#cod-hud .message {
  position: absolute; left: 0; right: 0; top: 30%;
  display: flex; flex-direction: column; align-items: center; gap: calc(6 * var(--px));
  white-space: nowrap;
  will-change: transform, opacity;
}
#cod-hud .message .txt {
  font-size: calc(26 * var(--px));
  letter-spacing: calc(6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .9);
  text-shadow: var(--ol);
  padding-left: calc(6 * var(--px));
}
#cod-hud .message .rule {
  width: calc(150 * var(--px)); height: calc(1 * var(--px));
  background: linear-gradient(90deg, rgba(var(--amber),0), rgba(var(--amber),.7), rgba(var(--amber),0));
}

/* ------------------------------------------------------------- match layer */
/* Bottom-left is the only free quadrant: minimap top-left, killfeed top-right,
   ammunition bottom-right. The score gets it to itself. */
#cod-hud .scorebox {
  position: absolute; left: calc(34 * var(--px)); bottom: calc(30 * var(--px));
  display: flex; flex-direction: column; align-items: flex-start;
}
#cod-hud .scorebox::before {
  content: '';
  position: absolute;
  left: calc(-64 * var(--px)); bottom: calc(-56 * var(--px));
  right: calc(-150 * var(--px)); top: calc(-52 * var(--px));
  background: radial-gradient(54% 56% at 26% 62%,
    rgba(3,5,6,.4) 0%, rgba(3,5,6,.31) 32%, rgba(3,5,6,.17) 58%, rgba(3,5,6,.06) 80%, rgba(3,5,6,0) 100%);
  z-index: -1;
}
#cod-hud .score-val {
  font-size: calc(42 * var(--px));
  line-height: .96;
  font-weight: 600;
  letter-spacing: calc(-0.2 * var(--px));
  color: rgba(var(--fg), .9);
  text-shadow: var(--ol);
  transform-origin: 0% 80%;
  margin-top: calc(2 * var(--px));
  will-change: transform;
}
#cod-hud .score-rule {
  width: calc(132 * var(--px)); height: calc(1 * var(--px));
  margin: calc(6 * var(--px)) 0 calc(6 * var(--px));
  background: linear-gradient(90deg, rgba(var(--accent),.5), rgba(var(--fg),.16) 62%, rgba(var(--fg),0));
  box-shadow: 0 calc(1 * var(--px)) 0 rgba(2,4,4,.55);
}
#cod-hud .score-foot { display: flex; align-items: center; gap: calc(8 * var(--px)); }
#cod-hud .lives { display: flex; gap: calc(3 * var(--px)); }
#cod-hud .lives i {
  width: calc(9 * var(--px)); height: calc(9 * var(--px));
  transform: rotate(45deg);
  background: rgba(var(--accent), .86);
  box-shadow: 0 0 calc(4 * var(--px)) rgba(2,4,4,.7);
}
/* A spent reinforcement leaves its outline behind: the player should be able to
   see what they have used, not just what is left. */
#cod-hud .lives i.spent {
  background: rgba(var(--danger), .1);
  box-shadow: inset 0 0 0 calc(1 * var(--px)) rgba(var(--danger), .5), 0 0 calc(3 * var(--px)) rgba(2,4,4,.6);
}
#cod-hud .streak {
  margin-top: calc(7 * var(--px));
  font-size: calc(12 * var(--px));
  letter-spacing: calc(2.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--amber), .92);
  text-shadow: var(--sh);
  will-change: opacity;
}

/* Score popups, directly under the reticle where the eye already is. */
#cod-hud .awards {
  position: absolute; left: 0; right: 0; top: 50%;
  margin-top: calc(62 * var(--px));
  height: 0;
}
#cod-hud .award {
  position: absolute; left: 0; right: 0; top: 0;
  display: flex; align-items: baseline; justify-content: center;
  gap: calc(7 * var(--px));
  white-space: nowrap;
  will-change: transform, opacity;
}
#cod-hud .award b {
  font-weight: 600;
  font-size: calc(17 * var(--px));
  letter-spacing: calc(.4 * var(--px));
  color: rgba(var(--fg), .95);
  text-shadow: var(--ol);
}
#cod-hud .award span {
  font-size: calc(11.5 * var(--px));
  letter-spacing: calc(2.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .6);
  text-shadow: var(--sh);
}
#cod-hud .award.bonus b { color: rgba(var(--amber), .96); }
#cod-hud .award.bonus span { color: rgba(var(--amber), .68); }
#cod-hud .award.wave b { color: rgba(var(--accent), .98); }
#cod-hud .award.wave span { color: rgba(var(--accent), .74); }

/* Wave announcements and the between-round countdown. */
#cod-hud .wavebanner {
  position: absolute; left: 0; right: 0; top: 21%;
  display: flex; flex-direction: column; align-items: center;
  white-space: nowrap;
  will-change: transform, opacity;
}
#cod-hud .wavebanner::before {
  content: '';
  position: absolute;
  left: 22%; right: 22%;
  top: calc(-30 * var(--px)); bottom: calc(-26 * var(--px));
  background: radial-gradient(46% 50% at 50% 50%,
    rgba(4,7,7,.4) 0%, rgba(4,7,7,.3) 38%, rgba(4,7,7,.13) 70%, rgba(4,7,7,0) 100%);
  z-index: -1;
}
#cod-hud .wb-eyebrow {
  font-size: calc(11.5 * var(--px));
  letter-spacing: calc(6.5 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--accent), .84);
  text-shadow: var(--sh);
  padding-left: calc(6.5 * var(--px));
}
#cod-hud .wavebanner.alert .wb-eyebrow { color: rgba(var(--danger), .9); }
#cod-hud .wb-title {
  margin-top: calc(5 * var(--px));
  font-size: calc(34 * var(--px));
  line-height: 1;
  font-weight: 600;
  letter-spacing: calc(7 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .94);
  text-shadow: var(--ol);
  padding-left: calc(7 * var(--px));
  transform: scaleX(.95);
}
#cod-hud .wb-rule {
  width: calc(210 * var(--px)); height: calc(1 * var(--px));
  margin: calc(9 * var(--px)) 0 calc(8 * var(--px));
  background: linear-gradient(90deg, rgba(var(--amber),0), rgba(var(--amber),.72), rgba(var(--amber),0));
}
#cod-hud .wavebanner.alert .wb-rule {
  background: linear-gradient(90deg, rgba(var(--danger),0), rgba(var(--danger),.75), rgba(var(--danger),0));
}
#cod-hud .wb-sub {
  font-size: calc(12.5 * var(--px));
  letter-spacing: calc(3.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .58);
  text-shadow: var(--sh);
  padding-left: calc(3.6 * var(--px));
}

/* ------------------------------------------------------------------ stats */
#cod-hud .stats {
  position: absolute; left: calc(34 * var(--px)); bottom: calc(150 * var(--px));
  font-family: var(--fm);
  font-size: calc(10 * var(--px));
  line-height: 1.55;
  letter-spacing: 0;
  color: rgba(var(--fg), .72);
  text-shadow: 0 calc(1 * var(--px)) calc(2 * var(--px)) rgba(0,0,0,.9);
  background: rgba(6,9,8,.34);
  border-left: calc(1.5 * var(--px)) solid rgba(var(--accent), .55);
  padding: calc(5 * var(--px)) calc(9 * var(--px)) calc(6 * var(--px));
}
#cod-hud .stats canvas { display: block; margin-top: calc(4 * var(--px)); width: calc(112 * var(--px)); height: calc(26 * var(--px)); opacity: .85; }

/* ------------------------------------------------------------------ menus */
#cod-menu .screen {
  position: absolute; inset: 0;
  pointer-events: auto;
  display: flex; flex-direction: column;
  opacity: 0;
  transition: opacity .3s ease;
}
#cod-menu .screen.open { opacity: 1; }
#cod-menu .screen.closed { display: none; }
#cod-menu .backdrop {
  position: absolute; inset: 0;
  -webkit-backdrop-filter: blur(calc(14 * var(--px))) saturate(.62) brightness(.44);
  backdrop-filter: blur(calc(14 * var(--px))) saturate(.62) brightness(.44);
  background:
    radial-gradient(120% 100% at 22% 12%, rgba(18,26,22,.22), rgba(4,6,6,.72) 72%),
    linear-gradient(180deg, rgba(4,6,6,.55), rgba(4,6,6,.28) 40%, rgba(4,6,6,.75));
}
#cod-menu .screen.death .backdrop {
  -webkit-backdrop-filter: blur(calc(6 * var(--px))) saturate(.18) brightness(.5);
  backdrop-filter: blur(calc(6 * var(--px))) saturate(.18) brightness(.5);
  background: radial-gradient(110% 90% at 50% 46%, rgba(60,6,6,.28), rgba(3,4,4,.86) 80%);
}
#cod-menu .grain {
  position: absolute; inset: 0;
  opacity: .5;
  background-size: calc(190 * var(--px)) calc(190 * var(--px));
  mix-blend-mode: overlay;
}
#cod-menu .scan {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(180deg, rgba(255,255,255,.028) 0 calc(1 * var(--px)), rgba(0,0,0,0) calc(1 * var(--px)) calc(4 * var(--px)));
  opacity: .5;
}
#cod-menu .pane {
  position: relative;
  margin: auto 0 auto calc(96 * var(--px));
  display: flex; flex-direction: column;
  width: calc(480 * var(--px));
}
#cod-menu .pane.center {
  margin: auto; align-items: center; text-align: center;
  width: calc(720 * var(--px));
}
#cod-menu .anim { animation: codMenuIn .46s cubic-bezier(.16,.84,.3,1) both; }
@keyframes codMenuIn {
  from { opacity: 0; transform: translate3d(calc(-14 * var(--px)), 0, 0); }
  to   { opacity: 1; transform: none; }
}
#cod-menu .eyebrow {
  font-size: calc(12 * var(--px));
  letter-spacing: calc(7 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--accent), .8);
  text-shadow: var(--sh);
  display: flex; align-items: center; gap: calc(10 * var(--px));
}
#cod-menu .eyebrow::before {
  content: ''; width: calc(26 * var(--px)); height: calc(1 * var(--px));
  background: rgba(var(--accent), .7);
}
#cod-menu .title {
  font-size: calc(84 * var(--px));
  line-height: .88;
  font-weight: 700;
  letter-spacing: calc(2 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .95);
  text-shadow: 0 calc(3 * var(--px)) calc(20 * var(--px)) rgba(0,0,0,.75);
  margin: calc(12 * var(--px)) 0 calc(2 * var(--px));
  transform: scaleX(.94); transform-origin: left center;
}
#cod-menu .pane.center .title { transform: scaleX(.94); transform-origin: center; }
#cod-menu .subtitle {
  font-size: calc(13 * var(--px));
  letter-spacing: calc(4.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .5);
}
#cod-menu .divider {
  height: calc(1 * var(--px));
  margin: calc(24 * var(--px)) 0 calc(14 * var(--px));
  background: linear-gradient(90deg, rgba(var(--fg),.42), rgba(var(--fg),.06) 70%, rgba(var(--fg),0));
}
#cod-menu button { font: inherit; border: 0; background: none; color: inherit; }
#cod-menu .item {
  position: relative;
  width: 100%;
  font-family: inherit; font-weight: 500;
  display: flex; align-items: center; justify-content: space-between;
  padding: calc(11 * var(--px)) calc(14 * var(--px)) calc(11 * var(--px)) calc(20 * var(--px));
  font-size: calc(19 * var(--px));
  letter-spacing: calc(3.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .74);
  background: rgba(255,255,255,0);
  cursor: pointer;
  transition: background-color .16s ease, color .16s ease, transform .16s cubic-bezier(.2,.8,.3,1);
  will-change: transform;
}
#cod-menu .item::before {
  content: '';
  position: absolute; left: 0; top: calc(6 * var(--px)); bottom: calc(6 * var(--px));
  width: calc(2 * var(--px));
  background: rgba(var(--fg), .22);
  transition: background-color .16s ease, transform .16s ease;
  transform: scaleY(.5);
}
#cod-menu .item:hover, #cod-menu .item:focus-visible {
  color: rgba(var(--fg), .98);
  background: rgba(var(--fg), .07);
  transform: translate3d(calc(5 * var(--px)), 0, 0);
  outline: none;
}
#cod-menu .item:hover::before, #cod-menu .item:focus-visible::before {
  background: rgba(var(--accent), .95);
  transform: scaleY(1);
}
#cod-menu .item .chev { opacity: 0; font-size: calc(15 * var(--px)); transition: opacity .16s ease, transform .16s ease; transform: translateX(calc(-4 * var(--px))); }
#cod-menu .item:hover .chev { opacity: .8; transform: none; }
#cod-menu .item.primary { color: rgba(var(--fg), .96); font-size: calc(22 * var(--px)); }
#cod-menu .item.primary::before { background: rgba(var(--accent), .85); transform: scaleY(1); }

#cod-menu .settings { display: flex; flex-direction: column; gap: calc(2 * var(--px)); }
#cod-menu .row {
  display: flex; align-items: center; justify-content: space-between;
  gap: calc(18 * var(--px));
  padding: calc(9 * var(--px)) calc(6 * var(--px)) calc(9 * var(--px)) calc(20 * var(--px));
  border-bottom: calc(1 * var(--px)) solid rgba(var(--fg), .07);
}
#cod-menu .row-label {
  font-size: calc(13 * var(--px));
  letter-spacing: calc(2.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .66);
  white-space: nowrap;
}
#cod-menu .seg { display: flex; gap: calc(2 * var(--px)); }
#cod-menu .seg button {
  font: inherit;
  font-size: calc(11.5 * var(--px));
  letter-spacing: calc(1.8 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .55);
  background: rgba(var(--fg), .05);
  border: calc(1 * var(--px)) solid rgba(var(--fg), .12);
  padding: calc(4 * var(--px)) calc(9 * var(--px)) calc(5 * var(--px));
  cursor: pointer;
  transition: color .14s ease, background-color .14s ease, border-color .14s ease;
}
#cod-menu .seg button:hover { color: rgba(var(--fg), .9); background: rgba(var(--fg), .12); }
#cod-menu .seg button.on {
  color: rgba(var(--ink), 1);
  background: rgba(var(--accent), .76);
  border-color: rgba(var(--accent), .8);
}
#cod-menu .slider { display: flex; align-items: center; gap: calc(10 * var(--px)); }
#cod-menu .slider output {
  font-size: calc(12 * var(--px)); letter-spacing: calc(1 * var(--px));
  color: rgba(var(--fg), .8); min-width: calc(34 * var(--px)); text-align: right;
}
#cod-menu input[type=range] {
  -webkit-appearance: none; appearance: none;
  width: calc(150 * var(--px)); height: calc(2 * var(--px));
  background: rgba(var(--fg), .2);
  cursor: pointer;
}
#cod-menu input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: calc(5 * var(--px)); height: calc(14 * var(--px));
  background: rgba(var(--accent), .95);
  box-shadow: 0 0 calc(6 * var(--px)) rgba(0,0,0,.6);
}
#cod-menu .hint {
  margin-top: calc(18 * var(--px));
  font-size: calc(11 * var(--px));
  letter-spacing: calc(2.2 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .34);
  display: flex; gap: calc(16 * var(--px)); flex-wrap: wrap;
}
#cod-menu .corner {
  position: absolute; right: calc(40 * var(--px)); bottom: calc(30 * var(--px));
  text-align: right;
  font-size: calc(10.5 * var(--px));
  letter-spacing: calc(2.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .3);
  line-height: 1.7;
}
/* ------------------------------------------------------- difficulty ladder */
/* The only control on the start screen that changes the game rather than the
   picture, so it carries more weight than a settings row: four tiles, a threat
   meter on each, and a readout of the three variables the preset actually
   moves. The ladder is colour-coded green → amber → red, so which end of it a
   tile sits on is legible before a word has been read.

   The start pane widens for it. Every other screen keeps the narrower column,
   which is why this overrides .pane rather than changing it. */
#cod-menu .screen.start .pane { width: calc(690 * var(--px)); }
#cod-menu .diff { margin: calc(4 * var(--px)) 0 calc(20 * var(--px)); }
#cod-menu .diff-head {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 0 calc(2 * var(--px)) calc(9 * var(--px)) calc(20 * var(--px));
}
#cod-menu .diff-title {
  font-size: calc(12 * var(--px));
  letter-spacing: calc(4.6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .62);
  text-shadow: var(--sh);
}
#cod-menu .diff-keys {
  font-size: calc(10 * var(--px));
  letter-spacing: calc(2.2 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .3);
}
/* Column flow rather than a fixed repeat(4, ...): the tile count comes from
   PRESET_ORDER, and a fifth preset should not need a stylesheet edit. */
#cod-menu .diff-tiles {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: calc(4 * var(--px));
  margin-left: calc(20 * var(--px));
}
#cod-menu .diff-tile {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  display: flex; flex-direction: column; align-items: stretch;
  gap: calc(13 * var(--px));
  padding: calc(13 * var(--px)) calc(12 * var(--px)) calc(12 * var(--px));
  background: linear-gradient(180deg, rgba(var(--fg), .085), rgba(var(--fg), .02));
  border: calc(1 * var(--px)) solid rgba(var(--fg), .1);
  border-top: calc(3 * var(--px)) solid rgba(var(--fg), .2);
  box-shadow: inset 0 calc(1 * var(--px)) 0 rgba(var(--fg), .06);
  transition: border-color .16s ease, transform .16s cubic-bezier(.2,.8,.3,1);
  will-change: transform;
}
/* The fill is a separate layer so selection can cross-fade it. A gradient in
   the background shorthand cannot be transitioned. */
#cod-menu .diff-tile::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(var(--accent), .3), rgba(var(--accent), .04) 72%);
  opacity: 0;
  transition: opacity .18s ease;
}
#cod-menu .diff-tile:hover { border-color: rgba(var(--fg), .3); }
#cod-menu .diff-tile:hover::before { opacity: .3; }
#cod-menu .diff-tile:focus-visible { outline: none; border-color: rgba(var(--accent), .55); }
#cod-menu .diff-tile:focus-visible::before { opacity: .45; }
#cod-menu .diff-tile:hover, #cod-menu .diff-tile.on {
  transform: translate3d(0, calc(-2 * var(--px)), 0);
}
/* The inset glow reads as light spilling down off the lit top edge, which is
   what gives the selected tile depth rather than just a brighter fill. Inset
   because overflow: hidden would clip an outer one. */
#cod-menu .diff-tile.on {
  border-color: rgba(var(--accent), .34);
  border-top-color: rgba(var(--accent), .95);
  box-shadow: inset 0 calc(11 * var(--px)) calc(17 * var(--px)) calc(-11 * var(--px)) rgba(var(--accent), .55);
}
#cod-menu .diff-tile.on::before { opacity: 1; }
#cod-menu .diff-tile.on .n { color: rgba(var(--fg), .99); }
/* "You will not survive" does not belong in the same friendly green as
   "for players new to first person action games". */
#cod-menu .diff-tile.veteran.on {
  border-color: rgba(var(--danger), .4);
  border-top-color: rgba(var(--danger), .92);
  box-shadow: inset 0 calc(11 * var(--px)) calc(17 * var(--px)) calc(-11 * var(--px)) rgba(var(--danger), .55);
}
#cod-menu .diff-tile.veteran.on::before {
  background: linear-gradient(180deg, rgba(var(--danger), .3), rgba(var(--danger), .04) 72%);
}
#cod-menu .diff-tile .top {
  position: relative;
  display: flex; align-items: baseline; justify-content: space-between;
  gap: calc(6 * var(--px));
}
#cod-menu .diff-tile .n {
  font-size: calc(17 * var(--px));
  font-weight: 600;
  letter-spacing: calc(2.2 * var(--px));
  text-transform: uppercase;
  white-space: nowrap;
  color: rgba(var(--fg), .6);
  text-shadow: var(--sh);
  transition: color .16s ease;
}
/* Lethality against Regular, on every tile rather than only the selected one,
   so the whole ladder can be compared without hovering it. */
#cod-menu .diff-tile .x {
  font-family: var(--fm);
  font-size: calc(11 * var(--px));
  letter-spacing: 0;
  color: rgba(var(--fg), .42);
  text-shadow: var(--sh);
  transition: color .16s ease;
}
#cod-menu .diff-tile.on .x { color: rgba(var(--fg), .78); }
/* A signal-strength ladder: rising bars, lit up to the preset's rung. */
#cod-menu .diff-tile .pips {
  position: relative;
  display: flex; align-items: flex-end; gap: calc(4 * var(--px));
  height: calc(12 * var(--px));
}
#cod-menu .diff-tile .pips i {
  width: calc(11 * var(--px));
  background: rgba(var(--fg), .14);
  box-shadow: inset 0 0 0 calc(1 * var(--px)) rgba(2,4,4,.45);
}
#cod-menu .diff-tile .pips i:nth-child(1) { height: calc(4.5 * var(--px)); }
#cod-menu .diff-tile .pips i:nth-child(2) { height: calc(7 * var(--px)); }
#cod-menu .diff-tile .pips i:nth-child(3) { height: calc(9.5 * var(--px)); }
#cod-menu .diff-tile .pips i:nth-child(4) { height: calc(12 * var(--px)); }
#cod-menu .diff-tile .pips i.lit { background: rgba(var(--accent), .8); }
#cod-menu .diff-tile.hardened .pips i.lit { background: rgba(var(--amber), .84); }
#cod-menu .diff-tile.veteran .pips i.lit { background: rgba(var(--danger), .82); }
/* Painted only while the select animation runs. */
#cod-menu .diff-tile .sweep {
  position: absolute; top: 0; bottom: 0; left: 0;
  width: 45%;
  background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.42), rgba(255,255,255,0));
  opacity: 0;
  pointer-events: none;
}
#cod-menu .diff-tile.picked .sweep { animation: codDiffSweep .46s cubic-bezier(.3,.7,.3,1) 1; }
@keyframes codDiffSweep {
  from { opacity: 0; transform: translate3d(-120%, 0, 0); }
  30%  { opacity: 1; }
  to   { opacity: 0; transform: translate3d(320%, 0, 0); }
}
#cod-menu .diff-read {
  margin: calc(11 * var(--px)) 0 0 calc(20 * var(--px));
  border-left: calc(2 * var(--px)) solid rgba(var(--accent), .55);
  padding: calc(1 * var(--px)) 0 calc(1 * var(--px)) calc(12 * var(--px));
  transition: border-color .2s ease;
}
#cod-menu .diff.alert .diff-read { border-left-color: rgba(var(--danger), .72); }
#cod-menu .diff-blurb {
  font-size: calc(12.5 * var(--px));
  letter-spacing: calc(2.8 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .64);
  text-shadow: var(--sh);
  transition: color .2s ease;
}
#cod-menu .diff.alert .diff-blurb { color: rgba(var(--danger), .84); }
#cod-menu .diff-stats {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  margin-top: calc(10 * var(--px));
}
#cod-menu .diff-stats div {
  display: flex; flex-direction: column; gap: calc(3 * var(--px));
  border-left: calc(1 * var(--px)) solid rgba(var(--fg), .1);
  padding-left: calc(10 * var(--px));
}
#cod-menu .diff-stats div:first-child { border-left: 0; padding-left: 0; }
#cod-menu .diff-stats span {
  font-size: calc(9.5 * var(--px));
  letter-spacing: calc(1.9 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .34);
}
/* Monospace, like the stats overlay: these are instrument readings, and they
   must not reflow as the digits change under the pointer. */
#cod-menu .diff-stats b {
  font-family: var(--fm);
  font-size: calc(12.5 * var(--px));
  font-weight: 600;
  letter-spacing: 0;
  color: rgba(var(--fg), .88);
  text-shadow: var(--sh);
}

#cod-menu .death-title {
  font-size: calc(58 * var(--px));
  letter-spacing: calc(10 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .92);
  text-shadow: 0 calc(3 * var(--px)) calc(24 * var(--px)) rgba(0,0,0,.8);
}
#cod-menu .death-sub {
  margin-top: calc(10 * var(--px));
  font-size: calc(14 * var(--px));
  letter-spacing: calc(4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--danger), .8);
}
#cod-menu .death-timer {
  margin-top: calc(26 * var(--px));
  font-size: calc(13 * var(--px));
  letter-spacing: calc(3.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .55);
}

/* ---------------------------------------------------------- end of match */
/* Victory reads as the mission debrief it is: cool, lit, composed. Defeat
   keeps the death screen's red wash so the two are never confused at a
   glance, even before a word has been read. */
#cod-menu .screen.victory .backdrop {
  background: radial-gradient(110% 92% at 50% 40%, rgba(22,40,28,.3), rgba(3,5,5,.86) 78%);
}
#cod-menu .screen.defeat .backdrop {
  background: radial-gradient(110% 92% at 50% 44%, rgba(58,7,7,.32), rgba(3,4,4,.88) 78%);
}
#cod-menu .result {
  margin: auto; text-align: left;
  width: calc(560 * var(--px));
  display: flex; flex-direction: column;
}
#cod-menu .result .eyebrow { justify-content: flex-start; }
#cod-menu .result-title {
  font-size: calc(64 * var(--px));
  line-height: .9;
  font-weight: 700;
  letter-spacing: calc(6 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .96);
  text-shadow: 0 calc(3 * var(--px)) calc(24 * var(--px)) rgba(0,0,0,.8);
  margin: calc(12 * var(--px)) 0 calc(4 * var(--px));
  transform: scaleX(.95); transform-origin: left center;
}
#cod-menu .screen.defeat .result-title { color: rgba(var(--danger), .92); }
#cod-menu .result-sub {
  font-size: calc(13.5 * var(--px));
  letter-spacing: calc(4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .5);
  line-height: 1.75;
}
#cod-menu .screen.defeat .result-sub b {
  font-weight: 600;
  color: rgba(var(--danger), .84);
}
/* The score is the headline number, not a table row. */
#cod-menu .result-score {
  display: flex; align-items: baseline; gap: calc(12 * var(--px));
  margin: calc(20 * var(--px)) 0 calc(4 * var(--px));
}
#cod-menu .result-score .n {
  font-size: calc(54 * var(--px));
  line-height: 1;
  font-weight: 600;
  color: rgba(var(--accent), .96);
  text-shadow: 0 calc(2 * var(--px)) calc(16 * var(--px)) rgba(0,0,0,.7);
}
#cod-menu .result-score .lbl {
  font-size: calc(12 * var(--px));
  letter-spacing: calc(4.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .45);
}
#cod-menu .result-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: calc(40 * var(--px));
  margin: calc(14 * var(--px)) 0 calc(20 * var(--px));
}
#cod-menu .result-grid div {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: calc(14 * var(--px));
  padding: calc(7 * var(--px)) 0 calc(7 * var(--px));
  border-bottom: calc(1 * var(--px)) solid rgba(var(--fg), .08);
  font-size: calc(13 * var(--px));
  letter-spacing: calc(2.4 * var(--px));
  text-transform: uppercase;
  color: rgba(var(--fg), .52);
}
#cod-menu .result-grid div b {
  font-weight: 600;
  font-size: calc(16 * var(--px));
  letter-spacing: calc(1 * var(--px));
  color: rgba(var(--fg), .9);
}
/* Waves are the spine of the match, so progress through them gets its own
   row of marks rather than being buried as "4 / 6" in the table. */
#cod-menu .result-waves { display: flex; gap: calc(5 * var(--px)); margin-bottom: calc(22 * var(--px)); }
#cod-menu .result-waves i {
  flex: 1 1 0;
  height: calc(4 * var(--px));
  background: rgba(var(--fg), .12);
  box-shadow: inset 0 0 0 calc(1 * var(--px)) rgba(2,4,4,.5);
}
#cod-menu .result-waves i.done { background: rgba(var(--accent), .84); }
#cod-menu .result-waves i.lost { background: rgba(var(--danger), .7); }
`

export function installStyles(): void {
  if (document.getElementById('cod-hud-style')) return
  const tag = document.createElement('style')
  tag.id = 'cod-hud-style'
  tag.textContent = CSS
  document.head.appendChild(tag)
}
