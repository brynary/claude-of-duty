import { Fx, el, pathOf, svgEl } from './Style'

const HOLD = 5.0
const FADE = 0.7
const MAX_ROWS = 5

/** Which side of the fight a name belongs to. */
export type Side = 'you' | 'friendly' | 'enemy'

const SIDE_CLASS: Record<Side, string> = { you: 'me', friendly: 'ally', enemy: 'foe' }

interface Row {
  node: HTMLElement
  fx: Fx
  born: number
}

/**
 * Top-right kill log: `KILLER [weapon] VICTIM`, newest at the bottom, each
 * entry holding for five seconds before it fades. Weapon glyphs are inline
 * SVG silhouettes so they stay sharp at any resolution.
 *
 * Colour encodes **team**, never role: a given callsign is the same colour
 * whether it appears as a killer or as a victim. Colouring by role is what
 * produced the earlier frame where one operator was white in one row and red
 * in the next.
 */
export class Killfeed {
  private root: HTMLDivElement
  private rows: Row[] = []

  constructor(parent: HTMLElement) {
    this.root = el('div', 'killfeed', parent)
  }

  add(
    killer: string,
    victim: string,
    weapon: string,
    headshot: boolean,
    killerSide: Side,
    victimSide: Side,
    elapsed: number,
  ): void {
    const node = el('div', 'kf-row', this.root)
    if (killerSide === 'you') node.classList.add('mine')
    if (victimSide === 'you') node.classList.add('victim-me')

    const k = el('span', 'kf-name', node)
    k.textContent = killer.toUpperCase()
    k.classList.add(SIDE_CLASS[killerSide])

    const icon = svgEl('svg', { class: 'kf-icon', viewBox: '0 0 48 17' }, node)
    pathOf(weaponGlyph(weapon), { fill: 'rgba(232,236,231,.86)' }, icon)

    if (headshot) {
      const hs = svgEl('svg', { class: 'kf-hs', viewBox: '0 0 10 11' }, node)
      pathOf(SKULL, { fill: 'rgba(232,236,231,.8)', 'fill-rule': 'evenodd' }, hs)
    }

    const v = el('span', 'kf-name', node)
    v.textContent = victim.toUpperCase()
    v.classList.add(SIDE_CLASS[victimSide])

    this.rows.push({ node, fx: new Fx(node), born: elapsed })
    while (this.rows.length > MAX_ROWS) {
      const dead = this.rows.shift()
      dead?.node.remove()
    }
  }

  clear(): void {
    for (const r of this.rows) r.node.remove()
    this.rows.length = 0
  }

  update(elapsed: number): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]
      const age = elapsed - r.born
      if (age > HOLD + FADE) {
        r.node.remove()
        this.rows.splice(i, 1)
        continue
      }
      if (age > HOLD) r.fx.opacity(1 - (age - HOLD) / FADE)
    }
  }
}

/** Head-shot marker: skull with the eye sockets punched out (evenodd). */
const SKULL = [
  'M5 0.5 C2.5 0.5 0.7 2.3 0.7 4.7 C0.7 6.2 1.4 7.2 2.3 7.9 V10.4 H3.8 V8.9 H6.2 V10.4 H7.7 V7.9 C8.6 7.2 9.3 6.2 9.3 4.7 C9.3 2.3 7.5 0.5 5 0.5 Z',
  'M3.3 4.5 m-1.15 0 a1.15 1.15 0 1 0 2.3 0 a1.15 1.15 0 1 0 -2.3 0',
  'M6.7 4.5 m-1.15 0 a1.15 1.15 0 1 0 2.3 0 a1.15 1.15 0 1 0 -2.3 0',
]

const GLYPHS = {
  rifle: [
    'M1.5 6.4 L11 5.7 L11 10.7 L1.5 9.7 Z',
    'M11 5.2 H30 V11.1 H11 Z',
    'M30 7 H45.5 V8.9 H30 Z',
    'M30 6.2 H38.4 V9.7 H30 Z',
    'M19 2.6 H26.4 V5.2 H19 Z',
    'M21.6 5.2 H23.8 V5.8 H21.6 Z',
    'M39.6 3.5 H41.1 V6.5 H39.6 Z',
    'M17.4 11.1 H22.6 L21.3 16 H16.1 Z',
    'M13 11.1 H15.9 L14.7 15.1 H11.8 Z',
  ],
  smg: [
    'M2 6.6 H8.4 V9.2 H2 Z',
    'M8.4 4.9 H26 V11.4 H8.4 Z',
    'M26 6.9 H36.6 V9.1 H26 Z',
    'M26 6.1 H32 V9.9 H26 Z',
    'M17.6 3.1 H23.4 V4.9 H17.6 Z',
    'M14.6 11.4 H19.8 L18.7 16.2 H13.5 Z',
    'M10 11.4 H13.2 L12.2 15.4 H9 Z',
  ],
  sniper: [
    'M0.5 6.2 L10 5.5 L10 11 L0.5 10.1 Z',
    'M4 4.6 H10 V5.6 H4 Z',
    'M10 5.4 H26 V10.7 H10 Z',
    'M26 7 H47 V8.9 H26 Z',
    'M14.6 1.8 H28.4 V4.7 H14.6 Z',
    'M17 4.7 H19 V5.5 H17 Z',
    'M24 4.7 H26 V5.5 H24 Z',
    'M17.8 10.7 H22 L21.4 13.8 H17.2 Z',
    'M12 10.7 H15 L14 14.7 H11 Z',
    'M37.2 8.9 H38.6 L36.9 14.4 H35.7 Z',
    'M37.2 8.9 H38.6 L40.3 14.4 H39.1 Z',
  ],
  shotgun: [
    'M1 6 L11 5.5 L11 10.5 L1 9.5 Z',
    'M11 5.2 H24 V10.9 H11 Z',
    'M24 6.3 H45 V8.4 H24 Z',
    'M27 8.9 H35.4 V11.3 H27 Z',
    'M43.4 4.9 H44.8 V6.3 H43.4 Z',
    'M13 10.9 H16.2 L15.1 14.8 H11.9 Z',
  ],
  pistol: [
    'M13.5 4.8 H34 V8.7 H13.5 Z',
    'M13.5 8.7 H24 V10.5 H13.5 Z',
    'M34 6.3 H36.2 V8 H34 Z',
    'M13.5 10.5 H20.2 L17.6 16.4 H11.2 Z',
    'M20.6 10.5 H24.4 V11.6 H20.6 Z',
  ],
  knife: [
    'M6.4 8.2 L27 3.4 L35 7.5 L27 9.9 Z',
    'M4.6 5.4 H6.6 V11.2 H4.6 Z',
    'M0.6 6.6 H4.6 V10 H0.6 Z',
  ],
  explosive: [
    'M20 9 m-6.2 0 a6.2 6.2 0 1 0 12.4 0 a6.2 6.2 0 1 0 -12.4 0',
    'M18.6 2.2 H21.6 V3.6 H18.6 Z',
    'M21.6 2.4 H29 V3.8 H21.6 Z',
    'M28.4 1 H30.6 V5 H28.4 Z',
  ],
} as const

function weaponGlyph(name: string): readonly string[] {
  const n = name.toLowerCase()
  if (/knife|melee|bayonet|blade/.test(n)) return GLYPHS.knife
  if (/grenade|frag|launcher|rpg|rocket|semtex|c4|mine|explos/.test(n)) return GLYPHS.explosive
  if (/pistol|deagle|glock|1911|revolver|sidearm|m9|p226/.test(n)) return GLYPHS.pistol
  if (/shotgun|pump|12g|spas|benelli|slug/.test(n)) return GLYPHS.shotgun
  if (/sniper|bolt|barrett|awp|intervention|marksman|dmr|kar98/.test(n)) return GLYPHS.sniper
  if (/smg|mp5|mp7|uzi|vector|p90|mac|scorpion/.test(n)) return GLYPHS.smg
  return GLYPHS.rifle
}
