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
    // A frame, so the caption and bar are on screen before the work that
    // blocks the thread begins rather than after it ends.
    await nextFrame()
    this.lastYield = performance.now()
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
