import { createConfig, type Config, type QualityLevel } from '../core/Config'
import { Rand } from '../core/Rand'
import type { GameContext } from '../core/Types'
import { TextSlot, el } from './Style'

export type MenuScreen = 'none' | 'start' | 'pause' | 'settings' | 'death'

export interface MenuHandlers {
  onDeploy(): void
  onResume(): void
  onQuit(): void
  onRespawn(): void
}

/** Config fields a quality preset owns; everything else survives a change. */
const RENDER_KEYS = [
  'maxPixelRatio', 'taa', 'ssao', 'ssr', 'bloom', 'motionBlur', 'volumetricLight',
  'depthOfField', 'filmGrain', 'chromaticAberration', 'sharpen',
  'shadowMapSize', 'shadowCascades', 'shadowDistance',
  'anisotropy', 'detailDensity', 'particleBudget', 'decalBudget',
] as const

const RESPAWN_SECONDS = 3.4

/**
 * Start, pause, settings and death screens. Each is a full-bleed panel over a
 * blurred, desaturated freeze of the live scene, with staggered entrances and
 * a single accent colour doing all the work.
 */
export class Menus {
  readonly root: HTMLDivElement

  private screens = new Map<Exclude<MenuScreen, 'none'>, HTMLElement>()
  private state: MenuScreen = 'none'
  private previous: MenuScreen = 'start'
  private hideTimer = 0

  private deathSub: TextSlot
  private deathTimer: TextSlot
  private diedAt = -1
  private respawned = false

  private ctx: GameContext
  private handlers: MenuHandlers
  private baseSensitivity: number
  private grain: string

  constructor(ctx: GameContext, handlers: MenuHandlers) {
    this.ctx = ctx
    this.handlers = handlers
    this.baseSensitivity = ctx.config.sensitivity
    this.grain = noiseTile(ctx.config.seed)

    this.root = document.createElement('div')
    this.root.id = 'cod-menu'
    document.body.appendChild(this.root)

    this.screens.set('start', this.buildStart())
    this.screens.set('pause', this.buildPause())
    this.screens.set('settings', this.buildSettings())
    const death = this.buildDeath()
    this.screens.set('death', death.node)
    this.deathSub = death.sub
    this.deathTimer = death.timer

    for (const node of this.screens.values()) node.classList.add('closed')
  }

  get current(): MenuScreen {
    return this.state
  }

  get isOpen(): boolean {
    return this.state !== 'none'
  }

  layout(scale: number): void {
    this.root.style.setProperty('--s', String(scale))
  }

  show(screen: MenuScreen): void {
    if (screen === this.state) return
    if (this.state !== 'none') this.previous = this.state
    this.state = screen
    this.root.style.pointerEvents = screen === 'none' ? 'none' : 'auto'

    window.clearTimeout(this.hideTimer)
    for (const [name, node] of this.screens) {
      if (name === screen) {
        node.classList.remove('closed')
        restartEntrance(node)
        // Next frame, so the opacity transition actually runs.
        requestAnimationFrame(() => node.classList.add('open'))
      } else {
        node.classList.remove('open')
      }
    }
    this.hideTimer = window.setTimeout(() => {
      for (const [name, node] of this.screens) {
        if (name !== this.state) node.classList.add('closed')
      }
    }, 340)

    if (screen === 'death') {
      this.diedAt = this.ctx.elapsed
      this.respawned = false
    }
  }

  /** Returns to whichever screen opened settings. */
  back(): void {
    this.show(this.previous === 'settings' ? 'pause' : this.previous)
  }

  setDeathCause(text: string): void {
    this.deathSub.set(text.toUpperCase())
  }

  update(elapsed: number): void {
    if (this.state !== 'death') return
    const left = Math.max(0, RESPAWN_SECONDS - (elapsed - this.diedAt))
    this.deathTimer.set(left > 0 ? `REDEPLOYING IN ${left.toFixed(1)}` : 'REDEPLOYING')
    if (left <= 0 && !this.respawned) {
      this.respawned = true
      this.handlers.onRespawn()
    }
  }

  // --- screen construction -------------------------------------------------

  private shell(cls: string): HTMLElement {
    const node = el('div', `screen ${cls}`, this.root)
    el('div', 'backdrop', node)
    const grain = el('div', 'grain', node)
    grain.style.backgroundImage = `url(${this.grain})`
    el('div', 'scan', node)
    return node
  }

  private buildStart(): HTMLElement {
    const node = this.shell('start')
    const pane = el('div', 'pane', node)
    let i = 0
    const eyebrow = stagger(el('div', 'eyebrow', pane), i++)
    eyebrow.textContent = 'CLASSIFIED // TASK FORCE 141'
    const title = stagger(el('h1', 'title', pane), i++)
    title.textContent = 'CLAUDE OF DUTY'
    const sub = stagger(el('div', 'subtitle', pane), i++)
    sub.textContent = 'OPERATION SILENT CORRIDOR — SECTOR 07'
    stagger(el('div', 'divider', pane), i++)

    this.item(pane, 'DEPLOY', i++, true, () => this.handlers.onDeploy())
    this.item(pane, 'SETTINGS', i++, false, () => this.show('settings'))

    const hint = stagger(el('div', 'hint', pane), i++)
    for (const h of ['WASD MOVE', 'SHIFT SPRINT', 'CTRL CROUCH', 'R RELOAD', 'RMB ADS', 'ESC PAUSE']) {
      el('span', '', hint).textContent = h
    }

    const corner = el('div', 'corner', node)
    for (const line of [
      'LOCATION — ALEPPO CORRIDOR',
      'TIME — 14:40 LOCAL',
      'OBJECTIVE — CLEAR AND HOLD THE PLAZA',
    ]) el('div', '', corner).textContent = line
    return node
  }

  private buildPause(): HTMLElement {
    const node = this.shell('pause')
    const pane = el('div', 'pane', node)
    let i = 0
    stagger(el('div', 'eyebrow', pane), i++).textContent = 'MISSION SUSPENDED'
    const title = stagger(el('h1', 'title', pane), i++)
    title.textContent = 'PAUSED'
    title.style.fontSize = 'calc(62 * var(--px))'
    stagger(el('div', 'divider', pane), i++)
    this.item(pane, 'RESUME', i++, true, () => this.handlers.onResume())
    this.item(pane, 'SETTINGS', i++, false, () => this.show('settings'))
    this.item(pane, 'ABORT MISSION', i++, false, () => this.handlers.onQuit())
    return node
  }

  private buildDeath(): { node: HTMLElement; sub: TextSlot; timer: TextSlot } {
    const node = this.shell('death')
    const pane = el('div', 'pane center', node)
    let i = 0
    const title = stagger(el('h1', 'death-title', pane), i++)
    title.textContent = 'KILLED IN ACTION'
    const sub = new TextSlot(stagger(el('div', 'death-sub', pane), i++))
    sub.set('ENEMY CONTACT')
    const timer = new TextSlot(stagger(el('div', 'death-timer', pane), i++))
    timer.set('REDEPLOYING')
    return { node, sub, timer }
  }

  private buildSettings(): HTMLElement {
    const node = this.shell('settings')
    const pane = el('div', 'pane', node)
    const cfg = this.ctx.config
    let i = 0
    stagger(el('div', 'eyebrow', pane), i++).textContent = 'FIELD CONFIGURATION'
    const title = stagger(el('h1', 'title', pane), i++)
    title.textContent = 'SETTINGS'
    title.style.fontSize = 'calc(56 * var(--px))'
    stagger(el('div', 'divider', pane), i++)

    const list = stagger(el('div', 'settings', pane), i++)

    this.segRow(list, 'QUALITY', ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'],
      () => cfg.quality.toUpperCase(),
      (v) => this.applyQuality(v.toLowerCase() as QualityLevel))

    this.sliderRow(list, 'FIELD OF VIEW', 65, 115, 1, cfg.fov, (v) => {
      cfg.fov = v
      this.ctx.camera.fov = v
      this.ctx.camera.updateProjectionMatrix()
      return `${v.toFixed(0)}°`
    })

    this.sliderRow(list, 'SENSITIVITY', 0.4, 2.5, 0.05, 1, (v) => {
      cfg.sensitivity = this.baseSensitivity * v
      return `${v.toFixed(2)}x`
    })

    this.toggleRow(list, 'MOTION BLUR', () => cfg.motionBlur, (v) => { cfg.motionBlur = v })
    this.toggleRow(list, 'DEPTH OF FIELD', () => cfg.depthOfField, (v) => { cfg.depthOfField = v })
    this.toggleRow(list, 'FILM GRAIN', () => cfg.filmGrain, (v) => { cfg.filmGrain = v })
    this.toggleRow(list, 'HEADS-UP DISPLAY', () => !cfg.hideHud, (v) => { cfg.hideHud = !v })

    this.item(pane, 'BACK', i++, false, () => this.back())
    return node
  }

  private item(parent: HTMLElement, label: string, index: number, primary: boolean, onClick: () => void): HTMLElement {
    const node = el('button', `item${primary ? ' primary' : ''}`, parent)
    node.type = 'button'
    stagger(node, index)
    el('span', '', node).textContent = label
    el('span', 'chev', node).textContent = '›'
    node.addEventListener('click', (e) => { e.preventDefault(); onClick() })
    return node
  }

  private row(parent: HTMLElement, label: string): HTMLElement {
    const row = el('div', 'row', parent)
    el('div', 'row-label', row).textContent = label
    return row
  }

  private segRow(parent: HTMLElement, label: string, options: string[], get: () => string, set: (v: string) => void): void {
    const row = this.row(parent, label)
    const seg = el('div', 'seg', row)
    const buttons: HTMLButtonElement[] = []
    const sync = () => {
      const active = get()
      buttons.forEach((b, i) => b.classList.toggle('on', options[i] === active))
    }
    for (const opt of options) {
      const b = el('button', '', seg)
      b.type = 'button'
      b.textContent = opt
      b.addEventListener('click', () => { set(opt); sync() })
      buttons.push(b)
    }
    sync()
  }

  private toggleRow(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void): void {
    this.segRow(parent, label, ['OFF', 'ON'],
      () => (get() ? 'ON' : 'OFF'),
      (v) => {
        set(v === 'ON')
        this.ctx.events.emit('quality:changed', { level: this.ctx.config.quality })
      })
  }

  private sliderRow(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    apply: (v: number) => string,
  ): void {
    const row = this.row(parent, label)
    const wrap = el('div', 'slider', row)
    const input = el('input', '', wrap)
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(value)
    const out = el('output', '', wrap)
    out.textContent = apply(value)
    input.addEventListener('input', () => { out.textContent = apply(Number(input.value)) })
  }

  /** Re-resolves the quality preset and republishes it to every system. */
  private applyQuality(level: QualityLevel): void {
    const preset = createConfig(`?quality=${level}`)
    const cfg = this.ctx.config as unknown as Record<string, unknown>
    const src = preset as unknown as Record<string, unknown>
    for (const key of RENDER_KEYS) cfg[key] = src[key]
    ;(this.ctx.config as Config).quality = level
    this.ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.ctx.config.maxPixelRatio))
    this.ctx.events.emit('quality:changed', { level })
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer)
    this.root.remove()
  }
}

function stagger<T extends HTMLElement>(node: T, index: number): T {
  node.classList.add('anim')
  node.style.animationDelay = `${40 + index * 55}ms`
  return node
}

function restartEntrance(node: HTMLElement): void {
  const items = node.querySelectorAll<HTMLElement>('.anim')
  for (const item of items) {
    const delay = item.style.animationDelay
    item.style.animation = 'none'
    void item.offsetWidth
    item.style.animation = ''
    item.style.animationDelay = delay
  }
}

/** Tiny seeded noise tile used as menu film grain. */
function noiseTile(seed: number): string {
  const S = 64
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const g = cv.getContext('2d')!
  const img = g.createImageData(S, S)
  const rng = new Rand(seed ^ 0x9e37)
  for (let i = 0; i < S * S; i++) {
    const v = 108 + Math.round(rng.gaussian() * 26)
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 40
  }
  g.putImageData(img, 0, 0)
  return cv.toDataURL('image/png')
}
