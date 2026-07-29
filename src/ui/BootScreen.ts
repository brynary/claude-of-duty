import type { BootProgress } from '../core/Types'

/**
 * The loading screen.
 *
 * The markup and its styling live in `index.html` so the frame is on screen
 * within the browser's first paint, seconds before this module has even been
 * parsed. Everything here only drives it: the stage caption, the bar, and the
 * hand-off to the game.
 *
 * Three rules shape it:
 *
 *  - **The bar tells the truth.** Each system is weighted by what it actually
 *    costs, measured at boot, so the fill moves at a roughly even rate instead
 *    of sitting at 6% through the twelve seconds of texture baking and then
 *    leaping to 90%.
 *  - **The main thread must breathe.** Every stage yields a frame before it
 *    runs, and the long ones report progress from the inside, or the caption
 *    would only ever repaint after the work it announces has finished.
 *  - **The world is already alive behind it.** The engine starts, and the
 *    opening frames — the post chain's own shaders, the light probes that bake
 *    on frame three — are drawn under the screen rather than in front of the
 *    player. `Press any key` only appears once that is done.
 */

/** What each system is worth on the bar, relative to the others. */
const WEIGHT: Record<string, number> = {
  materials: 62,
  level: 5,
  weapons: 3,
  ai: 2,
  audio: 1.5,
  fx: 1.5,
  lighting: 1,
  prewarm: 2,
}
const DEFAULT_WEIGHT = 0.6

/** Plain description of what the game is doing, in the game's own voice. */
const CAPTION: Record<string, string> = {
  materials: 'Baking surfaces',
  physics: 'Settling the world',
  lighting: 'Placing the sun',
  fx: 'Loading effects',
  audio: 'Opening the channel',
  level: 'Building the district',
  playbot: 'Briefing the operator',
  player: 'Inserting operator',
  ai: 'Deploying hostiles',
  difficulty: 'Reading the opposition',
  match: 'Setting the mission',
  weapons: 'Drawing weapons',
  hud: 'Calibrating optics',
  postfx: 'Focusing the lens',
  telemetry: 'Opening the log',
  prewarm: 'Compiling shaders',
}

const INTEL = [
  'Every wall in this district is a different thickness. Some of them stop rounds.',
  'Lean out, fire, lean back. A shoulder is a smaller target than a chest.',
  'Reloading behind cover costs you nothing. Reloading in the open costs you everything.',
  'Hostiles call out what they see. If you hear your position, move.',
  'The first shot of a burst is the accurate one. Tap at range.',
  'Sprinting is faster than the man shooting at you expects. Use it between cover.',
]

export class BootScreen implements BootProgress {
  private readonly root = document.getElementById('boot')
  private readonly stageEl = document.getElementById('boot-stage')
  private readonly pctEl = document.getElementById('boot-pct')
  private readonly fillEl = document.getElementById('boot-fill')
  private readonly intelEl = document.getElementById('boot-intel')

  private weights: number[] = []
  private names: string[] = []
  private total = 1
  private index = -1
  /** Weight consumed by the stages already finished. */
  private banked = 0
  private shown = 0
  private lastYield = 0
  private intelTimer = 0
  private dismissed = false
  /** Puts the warmed overlays back exactly as they were; see `warmOverlays`. */
  private warmRestore: (() => void) | null = null
  private warmed = false

  /** True when there is no screen in the document, e.g. a harness page. */
  private readonly absent: boolean

  constructor(private readonly autoDismiss: boolean) {
    this.absent = !this.root
    if (this.absent) return
    this.cycleIntel()
  }

  begin(names: string[]): void {
    if (this.absent) return
    this.names = names
    this.weights = names.map((n) => WEIGHT[n] ?? DEFAULT_WEIGHT)
    this.total = this.weights.reduce((a, b) => a + b, 0)
  }

  async stage(name: string): Promise<void> {
    if (this.absent) return
    if (this.index >= 0) this.banked += this.weights[this.index] ?? 0
    this.index = this.names.indexOf(name, this.index + 1)
    if (this.stageEl) this.stageEl.textContent = CAPTION[name] ?? name
    this.paint(0)
    // The frame this yield produces is also the one that carries the overlay
    // warm, while this screen still hides everything beneath it.
    this.warmOverlays()
    // A frame, so the caption and bar are on screen before the work that
    // blocks the thread begins rather than after it ends.
    await nextFrame()
    this.lastYield = performance.now()
  }

  /**
   * The pause, death and debrief screens sit on a full-viewport
   * `backdrop-filter` blur whose compositor surface only rasterises the first
   * time a screen opens — tens of milliseconds at desktop resolutions, and the
   * death screen's first open lands mid-combat, on the exact frame the player
   * dies. The blood overlay pays a similar first-hit toll decoding and
   * rasterising its two full-screen blend layers. While this screen is opaque,
   * nothing underneath can reach the display, so the overlays are given one
   * real painted frame here and then put back precisely as they were: the
   * surfaces and decoded textures stay resident, and the first genuine open
   * costs what every later open costs.
   *
   * Runs once, on the first stage after the HUD has built its DOM; earlier
   * stages find nothing and simply try again. A page with no HUD warms nothing.
   */
  private warmOverlays(): void {
    // A scripted page dismisses this screen immediately, and dismiss() puts
    // the warmed styles back before any frame commits — so the warm can never
    // land there, only leak. Measured: with it active, the firefight capture
    // differed from the reference build on 41k pixels.
    if (this.autoDismiss) return
    if (this.warmed || this.dismissed) return
    const screens = document.querySelectorAll<HTMLElement>('#cod-menu .screen')
    const blood = document.querySelectorAll<HTMLElement>('#cod-hud .blood, #cod-hud .blood-glow')
    if (screens.length === 0 && blood.length === 0) return
    this.warmed = true

    const undo: (() => void)[] = []
    const set = (node: HTMLElement, prop: 'display' | 'opacity' | 'pointerEvents', value: string): void => {
      const prior = node.style[prop]
      node.style[prop] = value
      undo.push(() => { node.style[prop] = prior })
    }
    for (const node of screens) {
      set(node, 'display', 'flex')
      // Full strength rather than an opacity epsilon: a fractional-opacity
      // ancestor becomes its own backdrop root, and the blur would rasterise
      // an empty group instead of the live page it needs to learn to sample.
      set(node, 'opacity', '1')
      // Nothing may become clickable because of the warm, however briefly.
      set(node, 'pointerEvents', 'none')
    }
    for (const node of blood) set(node, 'opacity', '1')

    this.warmRestore = () => {
      this.warmRestore = null
      for (const fn of undo) fn()
    }
    // Two frames: the styles are in place before the next paint, and the
    // restore runs at the top of the frame after it, so exactly one committed
    // frame carries the warm — enough to rasterise, all of it under the cover.
    requestAnimationFrame(() => requestAnimationFrame(() => this.warmRestore?.()))
  }

  async step(fraction: number): Promise<void> {
    if (this.absent) return
    this.paint(fraction)
    // Yielding per item would cost a frame each; once every 40 ms keeps the bar
    // moving without turning the bake into a slideshow.
    const now = performance.now()
    if (now - this.lastYield < 40) return
    await nextFrame()
    this.lastYield = performance.now()
  }

  /** Bar position for `fraction` through the current stage. */
  private paint(fraction: number): void {
    const weight = this.index >= 0 ? this.weights[this.index] ?? 0 : 0
    const value = (this.banked + weight * clamp01(fraction)) / this.total
    // Never runs backwards, and never quite reaches the end before it is ready.
    this.shown = Math.max(this.shown, Math.min(value, 0.995))
    if (this.fillEl) this.fillEl.style.width = `${(this.shown * 100).toFixed(1)}%`
    if (this.pctEl) this.pctEl.textContent = `${Math.round(this.shown * 100)}%`
  }

  /**
   * Loading is done. Fills the bar, then waits for the player — or leaves
   * immediately when a harness is driving, since a capture must not photograph
   * the loading screen.
   */
  async finish(): Promise<void> {
    if (this.absent) return
    this.shown = 1
    if (this.fillEl) this.fillEl.style.width = '100%'
    if (this.pctEl) this.pctEl.textContent = '100%'
    if (this.stageEl) this.stageEl.textContent = 'Ready'
    this.root?.classList.add('ready')

    if (this.autoDismiss) {
      this.dismiss(true)
      return
    }
    await new Promise<void>((resolve) => {
      // Captured and swallowed: the key that dismisses this screen must not
      // also land on the menu behind it and press whatever it is sitting on.
      const go = (e: Event) => {
        e.stopPropagation()
        e.preventDefault()
        window.removeEventListener('keydown', go, true)
        window.removeEventListener('pointerdown', go, true)
        resolve()
      }
      window.addEventListener('keydown', go, true)
      window.addEventListener('pointerdown', go, true)
    })
    this.dismiss(false)
  }

  private dismiss(immediate: boolean): void {
    if (this.dismissed) return
    this.dismissed = true
    // The cover is about to lift; whatever the warm touched must already be
    // back exactly as it was, or a warmed frame could reach the screen.
    this.warmRestore?.()
    window.clearInterval(this.intelTimer)
    if (immediate) {
      // A capture must not photograph even a fading loading screen.
      this.root?.remove()
      return
    }
    this.root?.classList.add('gone')
    // Removed rather than left transparent, so it can never eat a click.
    window.setTimeout(() => this.root?.remove(), 1100)
  }

  private cycleIntel(): void {
    let i = 0
    this.intelTimer = window.setInterval(() => {
      const el = this.intelEl
      if (!el) return
      el.classList.add('fading')
      window.setTimeout(() => {
        i = (i + 1) % INTEL.length
        el.textContent = INTEL[i]
        el.classList.remove('fading')
      }, 500)
    }, 6500)
  }
}

/**
 * A frame, or a short wait if the browser is not drawing any — a background tab
 * never fires `requestAnimationFrame`, and loading must not wait for attention.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    requestAnimationFrame(done)
    window.setTimeout(done, 120)
  })
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
