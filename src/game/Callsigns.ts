/**
 * The roster. Two disjoint pools: the first six names are the player's side,
 * the last six the opposition. A name is bound to a team for the whole match,
 * so the killfeed, the compass and the mission-failed screen can never
 * contradict each other about who someone was.
 *
 * This lives under `game/` rather than `ui/` because the match layer needs it
 * to name whoever killed the player, and the interface layer is allowed to
 * depend on the match layer but not the other way round.
 */

export type Faction = 'you' | 'friendly' | 'enemy'

const CALLSIGNS = [
  'MERAD', 'HASSAN', 'RASHID', 'KANE', 'ROSS', 'BRAVO',
  'ZAROV', 'VOLK', 'ORLOV', 'SOKOL', 'DUSHKA', 'BARIN',
]
const SIDE_POOL = 6
const RANKS = ['PVT.', 'CPL.', 'SGT.', 'LT.']

/** Picks a callsign from the half of the roster that belongs to `side`. */
export function callsign(side: Faction, id: number): string {
  const i = Math.abs(Math.round(id)) % SIDE_POOL
  const slot = side === 'enemy' ? SIDE_POOL + i : i
  return `${RANKS[slot % RANKS.length]} ${CALLSIGNS[slot]}`
}
