import type { Award, MatchState } from '../game/Match'
import { Fx, TextSlot, clamp, easeOutCubic, el, toggleClass } from './Style'

/**
 * The match layer's face: running score, reinforcements left, the scoring
 * popups under the reticle, and the wave banner that carries the
 * between-round beat.
 *
 * Same rules as the rest of the HUD — every per-frame write goes through `Fx`
 * or `TextSlot`, so an idle frame touches nothing, and nothing here allocates.
 */

/** Seconds a scoring popup lives. */
const AWARD_LIFE = 1.5
const AWARD_SLOTS = 6
/** Design pixels between stacked popups. */
const AWARD_ROW = 19

interface Chip {
  fx: Fx
  points: TextSlot
  label: TextSlot
  node: HTMLElement
  seq: number
  born: number
  live: boolean
}

/**
 * Score popups under the reticle. Newest sits closest to the reticle and older
 * ones are pushed outward as they fade, so a multi-kill reads as a stack that
 * grew rather than as three labels fighting for one line.
 */
export class AwardStack {
  private chips: Chip[] = []
  private lastSeq = -1
  private primed = false
  private scale = 1

  constructor(parent: HTMLElement) {
    const root = el('div', 'awards', parent)
    for (let i = 0; i < AWARD_SLOTS; i++) {
      const node = el('div', 'award', root)
      const points = new TextSlot(el('b', '', node))
      const label = new TextSlot(el('span', '', node))
      const fx = new Fx(node)
      fx.visible(false)
      this.chips.push({ fx, points, label, node, seq: -1, born: -99, live: false })
    }
  }

  layout(scale: number): void {
    this.scale = scale
  }

  /** Reads forward from the director's ring; never re-shows a popup. */
  ingest(awards: readonly Award[], seq: number, elapsed: number): void {
    // First sight of the ring: adopt its position rather than replaying
    // whatever is already in it.
    if (!this.primed) { this.primed = true; this.lastSeq = seq - 1 }
    // A restart rewinds the sequence; follow it rather than going silent.
    if (seq - 1 < this.lastSeq) this.lastSeq = seq - 1
    // Never replay more than the ring holds.
    const from = Math.max(this.lastSeq + 1, seq - awards.length)
    for (let i = from; i < seq; i++) {
      const a = awards[i % awards.length]
      if (a.seq !== i) continue
      this.push(a, elapsed)
    }
    this.lastSeq = seq - 1
  }

  private push(a: Award, elapsed: number): void {
    let slot = this.chips[0]
    for (const c of this.chips) {
      if (!c.live) { slot = c; break }
      if (c.born < slot.born) slot = c
    }
    slot.seq = a.seq
    slot.born = elapsed
    slot.live = true
    slot.points.set(a.points > 0 ? `+${a.points}` : String(a.points))
    slot.label.set(a.label)
    toggleClass(slot.node, 'bonus', a.tone === 'bonus')
    toggleClass(slot.node, 'wave', a.tone === 'wave')
    slot.fx.visible(true)
  }

  update(elapsed: number): void {
    for (const c of this.chips) {
      if (!c.live) continue
      const age = elapsed - c.born
      if (age >= AWARD_LIFE) {
        c.live = false
        c.fx.visible(false)
        continue
      }
      // Lane = how many live popups are newer than this one. Cheap enough at
      // six slots, and it keeps the stack ordered without sorting. The sequence
      // breaks ties, because a kill that is also a headshot and a longshot
      // pushes three popups on the same frame with identical timestamps and
      // they would otherwise all claim lane zero and draw on top of each other.
      let lane = 0
      for (const o of this.chips) {
        if (!o.live || o === c) continue
        if (o.born > c.born || (o.born === c.born && o.seq > c.seq)) lane++
      }

      const t = age / AWARD_LIFE
      const rise = easeOutCubic(Math.min(age / 0.5, 1)) * 7 * this.scale
      const fade = t < 0.06 ? t / 0.06 : Math.pow(1 - (t - 0.06) / 0.94, 1.4)
      c.fx.set(0, lane * -AWARD_ROW * this.scale - rise, 0, 1 + 0.1 * (1 - Math.min(age / 0.16, 1)))
      c.fx.opacity(fade)
    }
  }

  reset(): void {
    this.primed = false
    this.lastSeq = -1
    for (const c of this.chips) {
      c.live = false
      c.fx.visible(false)
    }
  }
}

/**
 * Bottom-left: the running total, the streak, and how many times the player
 * can still be redeployed. The number is the reason to keep playing, so it is
 * the only element down there and it is allowed to be large.
 */
export class ScorePanel {
  private root: HTMLElement
  private value: TextSlot
  private valueFx: Fx
  private streak: TextSlot
  private streakFx: Fx
  private lives: HTMLElement
  private pips: HTMLElement[] = []
  private livesRow: HTMLElement

  private shown = -1
  private punchAt = -99
  private pipCount = -1
  private shownStreak = -1

  constructor(parent: HTMLElement) {
    this.root = el('div', 'scorebox', parent)
    el('div', 'lbl', this.root).textContent = 'SCORE'
    const val = el('div', 'score-val', this.root)
    this.value = new TextSlot(val)
    this.valueFx = new Fx(val)
    this.value.set('0')
    el('div', 'score-rule', this.root)

    this.livesRow = el('div', 'score-foot', this.root)
    el('span', 'lbl', this.livesRow).textContent = 'REINFORCEMENTS'
    this.lives = el('span', 'lives', this.livesRow)

    const streak = el('div', 'streak', this.root)
    this.streak = new TextSlot(streak)
    this.streakFx = new Fx(streak)
    this.streakFx.visible(false)
  }

  update(state: MatchState, elapsed: number): void {
    if (state.score !== this.shown) {
      // Only punch upward: losing points is not a thing here, but a restart
      // resets to zero and should not fire the animation.
      if (state.score > this.shown) this.punchAt = elapsed
      this.shown = state.score
      this.value.set(formatScore(state.score))
    }
    const punch = clamp(1 - (elapsed - this.punchAt) / 0.24, 0, 1)
    this.valueFx.set(0, 0, 0, 1 + punch * punch * 0.075)

    const wantStreak = state.streak >= 2
    this.streakFx.visible(wantStreak)
    if (wantStreak) {
      // Guarded so a held streak does not build a new string every frame.
      if (state.streak !== this.shownStreak) {
        this.shownStreak = state.streak
        this.streak.set(`STREAK x${state.streak}`)
      }
      this.streakFx.opacity(0.72 + 0.24 * Math.sin(elapsed * 3.4))
    } else {
      this.shownStreak = -1
    }

    this.syncLives(state)
  }

  private syncLives(state: MatchState): void {
    const max = Number.isFinite(state.livesMax) ? state.livesMax : 0
    if (max <= 0) {
      // An unloseable match (capture and bot runs) has nothing to report.
      this.livesRow.style.display = 'none'
      return
    }
    if (max !== this.pipCount) {
      this.pipCount = max
      this.lives.textContent = ''
      this.pips.length = 0
      for (let i = 0; i < max; i++) this.pips.push(el('i', '', this.lives))
    }
    for (let i = 0; i < this.pips.length; i++) {
      toggleClass(this.pips[i], 'spent', i >= state.livesLeft)
    }
  }

  reset(): void {
    this.shown = -1
    this.punchAt = -99
    this.shownStreak = -1
  }
}

/**
 * The between-round beat, and the only thing on screen that announces what is
 * about to happen. Two modes: a timed announcement when a wave opens, and a
 * held panel with a live countdown while the plaza is quiet.
 */
export class WaveBanner {
  private fx: Fx
  private eyebrow: TextSlot
  private title: TextSlot
  private sub: TextSlot
  private node: HTMLElement
  private shownAt = -99
  private until = -1
  private held = false
  private scale = 1

  constructor(parent: HTMLElement) {
    this.node = el('div', 'wavebanner', parent)
    this.eyebrow = new TextSlot(el('div', 'wb-eyebrow', this.node))
    this.title = new TextSlot(el('div', 'wb-title', this.node))
    el('div', 'wb-rule', this.node)
    this.sub = new TextSlot(el('div', 'wb-sub', this.node))
    this.fx = new Fx(this.node)
    this.fx.visible(false)
  }

  layout(scale: number): void {
    this.scale = scale
  }

  /** @param seconds How long to hold. Zero holds until `hide()`. */
  show(eyebrow: string, title: string, sub: string, elapsed: number, seconds: number, tone = ''): void {
    this.eyebrow.set(eyebrow)
    this.title.set(title)
    this.sub.set(sub)
    toggleClass(this.node, 'alert', tone === 'alert')
    this.shownAt = elapsed
    this.held = seconds <= 0
    this.until = this.held ? -1 : elapsed + seconds
    this.fx.visible(true)
  }

  setSub(text: string): void {
    this.sub.set(text)
  }

  hide(): void {
    this.held = false
    this.until = -1
    this.fx.visible(false)
  }

  update(elapsed: number): void {
    if (!this.held && this.until < 0) return
    const age = elapsed - this.shownAt
    if (!this.held && elapsed > this.until) {
      this.until = -1
      this.fx.visible(false)
      return
    }
    const inFade = Math.min(1, age / 0.26)
    const outFade = this.held ? 1 : Math.min(1, (this.until - elapsed) / 0.5)
    this.fx.opacity(inFade * outFade)
    this.fx.set(0, (1 - easeOutCubic(Math.min(1, age / 0.42))) * -9 * this.scale, 0, 1)
  }
}

/** `12450` → `12,450`. Called only when the value changes. */
export function formatScore(n: number): string {
  const sign = n < 0 ? '-' : ''
  const digits = String(Math.abs(Math.round(n)))
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return sign + out
}

/** Seconds → `M:SS`, for countdowns and the end-of-match clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

export function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v)
}
