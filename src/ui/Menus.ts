import { createConfig, type Config, type QualityLevel } from '../core/Config'
import { Rand } from '../core/Rand'
import type { GameContext } from '../core/Types'
import { difficulty, presetFacts, PRESET_ORDER, type DifficultyPreset } from '../game/Difficulty'
import type { MatchSummary } from '../game/Match'
import { formatClock, formatScore } from './MatchHud'
import { TextSlot, el } from './Style'

export type MenuScreen = 'none' | 'start' | 'pause' | 'settings' | 'death' | 'victory' | 'defeat'

export interface MenuHandlers {
  onDeploy(): void
  onResume(): void
  onQuit(): void
  onRespawn(): void
  /** Start a fresh match from an end screen. */
  onRestart(): void
}

/** The rows of the debrief table, in reading order. */
const RESULT_ROWS = [
  'KILLS', 'ACCURACY', 'HEADSHOTS', 'BEST STREAK',
  'SHOTS FIRED', 'DAMAGE TAKEN', 'TIME', 'REDEPLOYS',
] as const

interface ResultScreen {
  node: HTMLElement
  title: TextSlot
  sub: HTMLElement
  score: TextSlot
  wavesRow: HTMLElement
  waves: HTMLElement[]
  rows: Map<string, TextSlot>
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
 * The difficulty readout, in reading order.
 *
 * The tiles carry the one summary number — lethality against Regular — so the
 * whole ladder can be compared without hovering it. This is the breakdown of
 * that number for the one preset under the pointer, and it is deliberately the
 * three variables FEEL_TARGET §7.6 establishes that the presets move. Every
 * figure comes out of `presetFacts`; none of it is a bar drawn to look
 * convincing.
 */
const DIFF_STATS = ['YOUR HEALTH', 'ENEMY ACCURACY', 'REACTION TIME'] as const

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

  private victory!: ResultScreen
  private defeat!: ResultScreen

  private diffBlock!: HTMLElement
  private diffTiles = new Map<DifficultyPreset, HTMLElement>()
  private diffBlurb!: TextSlot
  private diffStats = new Map<string, TextSlot>()
  /** Which preset the readout is describing: the hovered tile while one is
   * hovered, the chosen one otherwise. Held so a repeat does no DOM work. */
  private diffShown: DifficultyPreset | null = null

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

    this.victory = this.buildResult('victory', 'PLAZA SECURED', 'REDEPLOY')
    this.defeat = this.buildResult('defeat', 'MISSION FAILED', 'TRY AGAIN')
    this.screens.set('victory', this.victory.node)
    this.screens.set('defeat', this.defeat.node)

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

    // Before DEPLOY, because the choice is part of committing to the mission
    // rather than a setting buried behind it — which is where it was, reachable
    // only as `?difficulty=veteran` in the query string.
    this.buildDifficulty(pane, i++)

    this.item(pane, 'DEPLOY', i++, true, () => this.handlers.onDeploy())
    this.item(pane, 'SETTINGS', i++, false, () => this.show('settings'))

    const hint = stagger(el('div', 'hint', pane), i++)
    for (const h of ['WASD MOVE', 'SHIFT SPRINT', 'CTRL CROUCH', 'C TOGGLE CROUCH', 'R RELOAD', 'RMB ADS', 'ESC PAUSE']) {
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

  /**
   * The difficulty ladder: four tiles, a threat meter on each, and one readout
   * under them that describes whichever tile the pointer is over — hover to
   * compare, click to commit, exactly as the series does it.
   *
   * The tiles are the only place in this layer that writes to a game system.
   * `difficulty` is the shared instance every other system already imports, and
   * it is the single source of truth for what is selected: this widget holds no
   * copy of the choice, so it cannot drift from what the AI is applying.
   */
  private buildDifficulty(pane: HTMLElement, index: number): void {
    const block = stagger(el('div', 'diff', pane), index)
    this.diffBlock = block

    const head = el('div', 'diff-head', block)
    el('span', 'diff-title', head).textContent = 'DIFFICULTY'
    el('span', 'diff-keys', head).textContent = '◄ ► TO CHANGE'

    const tiles = el('div', 'diff-tiles', block)
    for (const id of PRESET_ORDER) {
      const facts = presetFacts(id)
      const tile = el('button', `diff-tile ${id}`, tiles)
      tile.type = 'button'
      // Painted by the select animation only, so the sweep never costs a
      // repaint while the menu is just sitting there.
      el('i', 'sweep', tile)
      const top = el('span', 'top', tile)
      el('span', 'n', top).textContent = facts.label
      el('span', 'x', top).textContent = `${facts.lethality.toFixed(2)}x`
      const pips = el('span', 'pips', tile)
      for (let rung = 0; rung < facts.rungs; rung++) {
        el('i', rung < facts.tier ? 'lit' : '', pips)
      }
      tile.addEventListener('click', (e) => { e.preventDefault(); this.chooseDifficulty(id) })
      tile.addEventListener('mouseenter', () => this.describeDifficulty(id))
      tile.addEventListener('mouseleave', () => this.describeDifficulty(difficulty.currentPreset()))
      this.diffTiles.set(id, tile)
    }

    const read = el('div', 'diff-read', block)
    this.diffBlurb = new TextSlot(el('div', 'diff-blurb', read))
    const stats = el('div', 'diff-stats', read)
    for (const label of DIFF_STATS) {
      const cell = el('div', '', stats)
      el('span', '', cell).textContent = label
      this.diffStats.set(label, new TextSlot(el('b', '', cell)))
    }

    this.markDifficulty()
    this.describeDifficulty(difficulty.currentPreset())
  }

  /**
   * Moves the selection one rung. Clamped rather than wrapped: a single key
   * press must never carry the player from the hardest preset to the easiest.
   */
  stepDifficulty(delta: number): void {
    const at = PRESET_ORDER.indexOf(difficulty.currentPreset())
    const next = PRESET_ORDER[clampIndex(at + delta, PRESET_ORDER.length)]
    if (next !== difficulty.currentPreset()) this.chooseDifficulty(next)
  }

  private chooseDifficulty(id: DifficultyPreset): void {
    difficulty.setPreset(id)
    this.markDifficulty()
    this.describeDifficulty(id)
    const tile = this.diffTiles.get(id)
    if (tile) restartSweep(tile)
  }

  private markDifficulty(): void {
    const chosen = difficulty.currentPreset()
    for (const [id, tile] of this.diffTiles) {
      tile.classList.toggle('on', id === chosen)
      tile.setAttribute('aria-pressed', id === chosen ? 'true' : 'false')
    }
  }

  private describeDifficulty(id: DifficultyPreset): void {
    if (id === this.diffShown) return
    this.diffShown = id
    const f = presetFacts(id)
    this.diffBlurb.set(f.blurb.toUpperCase())
    this.diffStats.get('YOUR HEALTH')?.set(`${f.playerMaxHealth.toFixed(0)} HP`)
    // Near accuracy: the chance a shot inside 20 m is allowed to land. Far
    // accuracy moves with it, so one figure describes the change.
    this.diffStats.get('ENEMY ACCURACY')?.set(`${Math.round(f.hitChanceNear * 100)}%`)
    this.diffStats.get('REACTION TIME')?.set(`${f.reactionMinMs.toFixed(0)}-${f.reactionMaxMs.toFixed(0)} MS`)
    // The top rung turns the whole block red, the same signal the wave banner
    // uses for the final push. Veteran's blurb is "You will not survive"; it
    // should not be presented in the same friendly green as Recruit.
    this.diffBlock.classList.toggle('alert', f.tier >= f.rungs)
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

  /**
   * Debrief. The same construction serves win and loss because they are the
   * same information — the only differences are the headline, the accent and
   * one extra line naming whoever finished you.
   */
  private buildResult(kind: 'victory' | 'defeat', headline: string, primary: string): ResultScreen {
    const node = this.shell(kind)
    const pane = el('div', 'result', node)
    let i = 0
    const eyebrow = stagger(el('div', 'eyebrow', pane), i++)
    eyebrow.textContent = 'OPERATION SILENT CORRIDOR'
    const title = new TextSlot(stagger(el('div', 'result-title', pane), i++))
    title.set(headline)
    const sub = stagger(el('div', 'result-sub', pane), i++)

    const scoreRow = stagger(el('div', 'result-score', pane), i++)
    const score = new TextSlot(el('div', 'n', scoreRow))
    el('div', 'lbl', scoreRow).textContent = 'FINAL SCORE'
    score.set('0')

    const wavesRow = stagger(el('div', 'result-waves', pane), i++)
    const waves: HTMLElement[] = []

    const grid = stagger(el('div', 'result-grid', pane), i++)
    const rows = new Map<string, TextSlot>()
    for (const label of RESULT_ROWS) {
      const row = el('div', '', grid)
      el('span', '', row).textContent = label
      rows.set(label, new TextSlot(el('b', '', row)))
    }

    this.item(pane, primary, i++, true, () => this.handlers.onRestart())
    this.item(pane, 'RETURN TO MENU', i++, false, () => this.handlers.onQuit())
    return { node, title, sub, score, wavesRow, waves, rows }
  }

  /** Fills a debrief and opens it. */
  showResult(summary: MatchSummary): void {
    const screen = summary.won ? this.victory : this.defeat
    screen.score.set(formatScore(summary.score))

    // Wave marks are built the first time, since the wave count is fixed for
    // the match but not known when the screen is constructed.
    if (screen.waves.length !== summary.waveCount) {
      screen.wavesRow.textContent = ''
      screen.waves.length = 0
      for (let i = 0; i < summary.waveCount; i++) screen.waves.push(el('i', '', screen.wavesRow))
    }
    for (let i = 0; i < screen.waves.length; i++) {
      const done = i < summary.wavesCleared
      screen.waves[i].className = done ? 'done' : (!summary.won && i === summary.fellOnWave - 1) ? 'lost' : ''
    }

    const set = (k: string, v: string) => screen.rows.get(k)?.set(v)
    set('KILLS', String(summary.kills))
    set('ACCURACY', `${Math.round(Math.min(1, summary.accuracy) * 100)}%`)
    set('HEADSHOTS', String(summary.headshots))
    set('BEST STREAK', String(summary.bestStreak))
    set('SHOTS FIRED', String(summary.shotsFired))
    set('DAMAGE TAKEN', String(Math.round(summary.damageTaken)))
    set('TIME', formatClock(summary.timeSurvived))
    set('REDEPLOYS', String(summary.deaths))

    screen.sub.textContent = ''
    if (summary.won) {
      line(screen.sub, `ALL ${summary.waveCount} PUSHES REPELLED`)
      line(screen.sub, `THE PLAZA HELD FOR ${formatClock(summary.timeSurvived)}`)
    } else {
      const by = summary.killedBy
        ? `KILLED BY <b>${summary.killedBy}</b> AT ${summary.killedAtRange.toFixed(0)} M`
        : 'KILLED IN ACTION'
      lineHtml(screen.sub, by)
      line(screen.sub, `FELL ON WAVE ${summary.fellOnWave} OF ${summary.waveCount} — ${summary.wavesCleared} CLEARED`)
    }

    this.show(summary.won ? 'victory' : 'defeat')
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

function line(parent: HTMLElement, text: string): void {
  el('div', '', parent).textContent = text
}

/**
 * The only markup written from a string in the whole layer, and it interpolates
 * one value: a callsign drawn from a twelve-entry constant table. Nothing here
 * is ever player-supplied.
 */
function lineHtml(parent: HTMLElement, html: string): void {
  el('div', '', parent).innerHTML = html
}

function clampIndex(i: number, length: number): number {
  return i < 0 ? 0 : i >= length ? length - 1 : i
}

/** Replays a tile's select sweep, whether or not it has run before. */
function restartSweep(tile: HTMLElement): void {
  tile.classList.remove('picked')
  void tile.offsetWidth
  tile.classList.add('picked')
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
