import { Fx, TextSlot, el, toggleClass } from './Style'

const MAX_PIPS = 7
/** Fraction of a magazine below which the counter goes red. */
const LOW = 0.25

/**
 * Bottom-right ammunition block: magazine large, reserve small, weapon name,
 * fire mode and a segmented bar showing what is left in the magazine. The
 * magazine size is inferred from the largest count seen, so it works with
 * whatever the weapon system loads.
 *
 * The bar reads the same value as the numeral on purpose — an empty gun shows
 * an empty bar. An earlier version counted spare magazines there, which put a
 * full seven-segment bar next to a `00` and made the readout unreadable.
 */
export class AmmoPanel {
  readonly root: HTMLDivElement

  private nameSlot: TextSlot
  private magSlot: TextSlot
  private resSlot: TextSlot
  private modeSlot: TextSlot
  private pips: HTMLElement[] = []
  private magFx: Fx

  private mag = 30
  private reserve = 120
  private magSize = 30
  private punchAt = -99

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ammo', parent)
    this.nameSlot = new TextSlot(el('div', 'ammo-name', this.root))
    el('div', 'ammo-rule', this.root)

    const nums = el('div', 'ammo-nums', this.root)
    const magNode = el('div', 'ammo-mag', nums)
    this.magSlot = new TextSlot(magNode)
    this.magFx = new Fx(magNode)
    const slash = el('div', 'ammo-slash', nums)
    slash.textContent = '/'
    this.resSlot = new TextSlot(el('div', 'ammo-res', nums))

    const meta = el('div', 'ammo-meta', this.root)
    this.modeSlot = new TextSlot(el('div', 'ammo-mode', meta))
    const pips = el('div', 'pips', meta)
    for (let i = 0; i < MAX_PIPS; i++) this.pips.push(el('div', 'pip', pips))

    this.nameSlot.set('M4A1')
    this.modeSlot.set('AUTO')
    this.apply()
  }

  setWeapon(name: string): void {
    this.nameSlot.set(name.toUpperCase())
    // A new weapon invalidates the inferred magazine size.
    this.magSize = Math.max(1, this.mag)
  }

  setMode(mode: string): void {
    this.modeSlot.set(mode.toUpperCase())
  }

  setAmmo(mag: number, reserve: number, elapsed: number): void {
    const m = Math.max(0, Math.round(mag))
    const r = Math.max(0, Math.round(reserve))
    if (m === this.mag && r === this.reserve) return
    if (m < this.mag) this.punchAt = elapsed
    this.mag = m
    this.reserve = r
    if (m > this.magSize) this.magSize = m
    this.apply()
  }

  get magazine(): number { return this.mag }
  get reserveRounds(): number { return this.reserve }
  get magazineSize(): number { return this.magSize }
  get isLow(): boolean { return this.mag / Math.max(1, this.magSize) < LOW }
  get isEmpty(): boolean { return this.mag <= 0 }

  private apply(): void {
    this.magSlot.set(this.mag < 10 ? `0${this.mag}` : String(this.mag))
    this.resSlot.set(String(this.reserve))
    toggleClass(this.root, 'low', this.isLow)

    const fraction = this.mag / Math.max(1, this.magSize)
    const lit = this.mag <= 0 ? 0 : Math.max(1, Math.min(MAX_PIPS, Math.round(fraction * MAX_PIPS)))
    for (let i = 0; i < MAX_PIPS; i++) toggleClass(this.pips[i], 'on', i < lit)
    toggleClass(this.root, 'dry', this.mag <= 0)
  }

  /** Subtle recoil punch on the counter each time a round leaves the gun. */
  update(elapsed: number): void {
    const age = elapsed - this.punchAt
    if (age >= 0 && age < 0.1) {
      this.magFx.set(0, 0, 0, 1 + 0.05 * (1 - age / 0.1))
    } else {
      this.magFx.set(0, 0, 0, 1)
    }
  }
}
