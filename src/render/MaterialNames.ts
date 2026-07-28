import type { Surface } from '../core/Types'

/**
 * The canonical material vocabulary. The materials system must be able to
 * produce every name here; every other system may only ask for these names.
 * This is the contract that lets material authoring and level building happen
 * independently.
 */
export const MATERIALS = {
  // Ground
  asphalt: 'concrete',
  asphaltCracked: 'concrete',
  concrete: 'concrete',
  concreteWorn: 'concrete',
  concreteRubble: 'gravel',
  sand: 'sand',
  dirt: 'dirt',
  gravel: 'gravel',
  cobblestone: 'concrete',

  // Walls / architecture
  plasterWhite: 'plaster',
  plasterOchre: 'plaster',
  plasterDamaged: 'plaster',
  brickRed: 'concrete',
  brickPainted: 'concrete',
  stuccoTan: 'plaster',
  stoneBlock: 'concrete',
  tileRoof: 'tile',
  tileFloor: 'tile',

  // Metal
  metalPainted: 'metal',
  metalRusted: 'metal',
  metalCorrugated: 'thinMetal',
  steelBrushed: 'metal',
  gunmetal: 'metal',
  chainlink: 'thinMetal',
  rebar: 'metal',

  // Wood
  woodPlank: 'wood',
  woodPainted: 'wood',
  woodCrate: 'wood',
  woodBeam: 'wood',

  // Soft / misc
  glass: 'glass',
  glassDirty: 'glass',
  fabricAwning: 'fabric',
  sandbag: 'fabric',
  tarp: 'fabric',
  rubber: 'rubber',
  foliage: 'foliage',
  water: 'water',

  // Characters
  skin: 'flesh',
  uniform: 'fabric',
  webbing: 'fabric',
  helmet: 'metal',
  bootLeather: 'fabric',
} as const satisfies Record<string, Surface>

export type MaterialName = keyof typeof MATERIALS

/** The physical surface a material behaves as, for impacts and footsteps. */
export function surfaceOf(name: MaterialName): Surface {
  return MATERIALS[name] as Surface
}

export const MATERIAL_NAMES = Object.keys(MATERIALS) as MaterialName[]
