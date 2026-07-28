import type { RecoilProfile } from './Recoil'
import type { WeaponKind } from './WeaponGeometry'

export type FireMode = 'auto' | 'burst' | 'semi'

/**
 * Position + XYZ euler offset of the weapon root, in camera space.
 *
 * Framing rule for every hip pose below: the rearmost point of the weapon must
 * stay at least ~0.19m in front of the eye. The viewmodel camera's near plane
 * is 6mm, so a buttpad parked at 1cm does not clip away — it explodes across
 * the lower half of the frame under extreme perspective, which is what made the
 * first pass read as a gun smeared diagonally through screen centre. Pushing
 * the whole weapon forward costs apparent size but buys a stable silhouette
 * that stays inside the lower-right quadrant.
 */
export interface VmPose {
  pos: readonly [number, number, number]
  rot: readonly [number, number, number]
}

export interface WeaponDef {
  id: string
  displayName: string
  kind: WeaponKind
  /** Prefix for audio ids: `${sfx}_fire`, `${sfx}_reload_out`, ... */
  sfx: string

  // --- ballistics -------------------------------------------------------
  /** Damage at the muzzle, before region multipliers. 100 = full health. */
  damage: number
  /** Damage past `falloffEnd`. */
  damageMin: number
  falloffStart: number
  falloffEnd: number
  headMult: number
  chestMult: number
  stomachMult: number
  limbMult: number
  /** Multiplier on how deep rounds punch through penetrable surfaces. */
  penetration: number
  /** Rounds a single shot can pass through before stopping. */
  maxPenetrations: number
  range: number
  rpm: number
  /** Pellets per trigger pull; >1 for shotguns. */
  pellets: number
  modes: readonly FireMode[]
  burstCount: number
  /** Delay between bursts, seconds. */
  burstDelay: number
  magSize: number
  reserve: number
  /** Metres per second used for the tracer's travel time. */
  muzzleVelocity: number
  /** Loudness radius reported to the AI. */
  noiseRadius: number

  // --- accuracy ---------------------------------------------------------
  spreadHip: number
  spreadAds: number
  spreadPerShot: number
  spreadMax: number
  /** Spread bled off per second once the trigger is released. */
  spreadDecay: number
  spreadMoveMul: number
  spreadCrouchMul: number
  spreadJumpMul: number

  recoil: RecoilProfile

  // --- handling ---------------------------------------------------------
  adsTime: number
  /** Distance from the eye to the sight reference point when aiming. */
  eyeRelief: number
  /** World camera FOV multiplier at full ADS. */
  adsFovScale: number
  /** Viewmodel camera FOV at full ADS. */
  adsVmFov: number
  reloadTime: number
  reloadEmptyTime: number
  /** Normalised times within the reload where the magazine leaves and seats. */
  magOutAt: number
  magInAt: number
  /** Normalised time of the charging-handle pull on an empty reload. */
  chargeAt: number
  drawTime: number
  holsterTime: number
  /** Time from sprint pose back to a usable ready pose. */
  sprintOutTime: number
  inspectTime: number

  // --- viewmodel --------------------------------------------------------
  hip: VmPose
  sprint: VmPose
  lowReady: VmPose
  /** Scales the walk bob; heavy weapons move less. */
  bobScale: number
  swayScale: number
  /** Local pivot the recoil rotates around, roughly the shoulder pocket. */
  recoilPivot: readonly [number, number, number]
  /** Shell ejection velocity in weapon space. */
  shellVel: readonly [number, number, number]
  muzzleFlashScale: number
  /** Slide/bolt travel for weapons with a reciprocating part. */
  boltTravel: number
  /** Locks the slide back on empty. */
  slideLock: boolean
}

const RIFLE_PATTERN: readonly (readonly [number, number])[] = [
  [1.35, 0.10], [1.05, -0.15], [0.95, -0.35], [0.90, -0.55], [0.85, -0.70],
  [0.80, -0.60], [0.78, -0.25], [0.76, 0.25], [0.74, 0.70], [0.72, 0.95],
  [0.70, 1.00], [0.68, 0.80], [0.66, 0.45], [0.64, 0.05], [0.62, -0.35],
  [0.60, -0.70], [0.58, -0.90], [0.56, -0.80], [0.54, -0.45], [0.52, 0.00],
]

const SMG_PATTERN: readonly (readonly [number, number])[] = [
  [1.15, -0.20], [0.95, -0.45], [0.88, -0.70], [0.84, -0.85], [0.80, -0.70],
  [0.78, -0.30], [0.76, 0.20], [0.74, 0.65], [0.72, 0.95], [0.70, 1.05],
  [0.68, 0.85], [0.66, 0.40], [0.64, -0.10], [0.62, -0.55], [0.60, -0.85],
]

const SNIPER_PATTERN: readonly (readonly [number, number])[] = [
  [1.0, 0.35], [1.0, -0.4], [1.0, 0.25],
]

const PISTOL_PATTERN: readonly (readonly [number, number])[] = [
  [1.0, 0.3], [0.95, -0.45], [0.92, 0.5], [0.9, -0.3], [0.88, 0.2],
]

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 'M4A1',
    displayName: 'M4A1',
    kind: 'rifle',
    sfx: 'rifle',
    damage: 33, damageMin: 22, falloffStart: 24, falloffEnd: 52,
    headMult: 1.55, chestMult: 1, stomachMult: 1.05, limbMult: 0.85,
    penetration: 1, maxPenetrations: 2, range: 320,
    rpm: 780, pellets: 1,
    modes: ['auto', 'burst', 'semi'], burstCount: 3, burstDelay: 0.2,
    magSize: 30, reserve: 210, muzzleVelocity: 880, noiseRadius: 45,
    spreadHip: 0.0295, spreadAds: 0.0028, spreadPerShot: 0.0021, spreadMax: 0.055,
    spreadDecay: 0.10, spreadMoveMul: 1.7, spreadCrouchMul: 0.72, spreadJumpMul: 2.4,
    recoil: {
      pitch: 0.0125, yaw: 0.0042, jitter: 0.18, pattern: RIFLE_PATTERN,
      snap: 38, recovery: 9, permanent: 0.12, adsScale: 0.72,
      kickBack: 0.014, kickUp: 0.055, kickRoll: 0.030, visualSnap: 26,
    },
    // Eye relief is deliberately longer than the optic's real 60mm: it sets how
    // much of the frame the sight housing eats at full ADS. 0.255m puts the
    // 41mm tube at 20% of frame height, which is the shipped-shooter read.
    //
    // It went to 0.295 last round to get the cheek comb away from the camera,
    // and that was treating the symptom: the comb was sitting 18mm under the
    // sight axis, so it grazed the whole length of the sight line no matter
    // where the eye stood, and buying clearance with eye relief only shrank the
    // optic (17.3% of frame height) while still leaving 21% of the frame as
    // buttstock. The comb is 12.5mm lower now — see `addCarbineStock` — so the
    // eye can come back to where the sight picture reads: measured down the
    // centre column at 0.255, the glass is open from 42% to 53% of frame
    // height, the mount, folded rear sight and charging handle run 60-75%, the
    // rail ladder 77-87%, and the comb is the bottom 10%.
    adsTime: 0.18, eyeRelief: 0.255, adsFovScale: 0.72, adsVmFov: 46,
    reloadTime: 2.1, reloadEmptyTime: 2.6, magOutAt: 0.30, magInAt: 0.56, chargeAt: 0.80,
    drawTime: 0.5, holsterTime: 0.32, sprintOutTime: 0.16, inspectTime: 2.4,
    // Measured against a 60 degree viewmodel camera at 16:9: 28.8% of screen
    // width, top of the optic at 52% height, magazine tip on the bottom edge,
    // nothing closer than 24cm to the eye.
    hip: { pos: [0.132, -0.114, -0.500], rot: [0.014, 0.048, 0.108] },
    sprint: { pos: [0.112, -0.170, -0.470], rot: [-0.42, 0.62, 0.36] },
    lowReady: { pos: [0.126, -0.104, -0.540], rot: [-0.095, 0.170, 0.105] },
    bobScale: 1, swayScale: 1,
    recoilPivot: [0, -0.02, 0.22],
    shellVel: [2.6, 1.5, 0.5],
    muzzleFlashScale: 1,
    boltTravel: 0, slideLock: false,
  },
  {
    id: 'MP9K',
    displayName: 'MP9-K',
    kind: 'smg',
    sfx: 'smg',
    damage: 26, damageMin: 15, falloffStart: 12, falloffEnd: 30,
    headMult: 1.4, chestMult: 1, stomachMult: 1.05, limbMult: 0.9,
    penetration: 0.55, maxPenetrations: 1, range: 200,
    rpm: 920, pellets: 1,
    modes: ['auto', 'semi'], burstCount: 3, burstDelay: 0.18,
    magSize: 32, reserve: 224, muzzleVelocity: 400, noiseRadius: 38,
    spreadHip: 0.0225, spreadAds: 0.0060, spreadPerShot: 0.0020, spreadMax: 0.060,
    spreadDecay: 0.13, spreadMoveMul: 1.35, spreadCrouchMul: 0.80, spreadJumpMul: 2.0,
    recoil: {
      pitch: 0.0092, yaw: 0.0040, jitter: 0.26, pattern: SMG_PATTERN,
      snap: 42, recovery: 11, permanent: 0.08, adsScale: 0.76,
      kickBack: 0.010, kickUp: 0.042, kickRoll: 0.026, visualSnap: 30,
    },
    adsTime: 0.14, eyeRelief: 0.235, adsFovScale: 0.80, adsVmFov: 50,
    reloadTime: 1.95, reloadEmptyTime: 2.45, magOutAt: 0.28, magInAt: 0.54, chargeAt: 0.80,
    drawTime: 0.42, holsterTime: 0.28, sprintOutTime: 0.13, inspectTime: 2.2,
    hip: { pos: [0.124, -0.106, -0.470], rot: [0.016, 0.052, 0.104] },
    sprint: { pos: [0.106, -0.160, -0.440], rot: [-0.44, 0.66, 0.38] },
    lowReady: { pos: [0.118, -0.098, -0.500], rot: [-0.095, 0.175, 0.100] },
    bobScale: 1.1, swayScale: 1.15,
    recoilPivot: [0, -0.02, 0.18],
    shellVel: [2.9, 1.6, 0.4],
    muzzleFlashScale: 0.85,
    boltTravel: 0, slideLock: false,
  },
  {
    id: 'SR338',
    displayName: 'SR-338',
    kind: 'sniper',
    sfx: 'sniper',
    damage: 145, damageMin: 110, falloffStart: 90, falloffEnd: 220,
    headMult: 2.0, chestMult: 1, stomachMult: 1, limbMult: 0.72,
    penetration: 2.4, maxPenetrations: 3, range: 600,
    rpm: 52, pellets: 1,
    modes: ['semi'], burstCount: 1, burstDelay: 0,
    magSize: 7, reserve: 42, muzzleVelocity: 915, noiseRadius: 90,
    spreadHip: 0.085, spreadAds: 0.0003, spreadPerShot: 0.010, spreadMax: 0.12,
    spreadDecay: 0.20, spreadMoveMul: 2.2, spreadCrouchMul: 0.60, spreadJumpMul: 3.0,
    recoil: {
      pitch: 0.052, yaw: 0.010, jitter: 0.22, pattern: SNIPER_PATTERN,
      snap: 30, recovery: 6, permanent: 0.0, adsScale: 0.9,
      kickBack: 0.040, kickUp: 0.150, kickRoll: 0.045, visualSnap: 15,
    },
    adsTime: 0.34, eyeRelief: 0.300, adsFovScale: 0.30, adsVmFov: 40,
    reloadTime: 2.7, reloadEmptyTime: 3.2, magOutAt: 0.28, magInAt: 0.55, chargeAt: 0.82,
    drawTime: 0.72, holsterTime: 0.45, sprintOutTime: 0.26, inspectTime: 2.8,
    hip: { pos: [0.136, -0.120, -0.505], rot: [0.012, 0.044, 0.102] },
    sprint: { pos: [0.116, -0.176, -0.470], rot: [-0.38, 0.58, 0.34] },
    lowReady: { pos: [0.130, -0.110, -0.545], rot: [-0.090, 0.160, 0.100] },
    bobScale: 0.8, swayScale: 0.75,
    recoilPivot: [0, -0.02, 0.22],
    shellVel: [2.2, 1.4, 0.6],
    muzzleFlashScale: 1.5,
    boltTravel: 0.07, slideLock: false,
  },
  {
    id: 'M17',
    displayName: 'M17',
    kind: 'pistol',
    sfx: 'pistol',
    damage: 30, damageMin: 17, falloffStart: 11, falloffEnd: 28,
    headMult: 1.6, chestMult: 1, stomachMult: 1, limbMult: 0.85,
    penetration: 0.5, maxPenetrations: 1, range: 140,
    rpm: 430, pellets: 1,
    modes: ['semi', 'burst'], burstCount: 3, burstDelay: 0.22,
    magSize: 17, reserve: 68, muzzleVelocity: 360, noiseRadius: 32,
    spreadHip: 0.0230, spreadAds: 0.0040, spreadPerShot: 0.0045, spreadMax: 0.070,
    spreadDecay: 0.16, spreadMoveMul: 1.4, spreadCrouchMul: 0.78, spreadJumpMul: 2.2,
    recoil: {
      pitch: 0.0165, yaw: 0.0055, jitter: 0.3, pattern: PISTOL_PATTERN,
      snap: 44, recovery: 13, permanent: 0.05, adsScale: 0.8,
      kickBack: 0.012, kickUp: 0.075, kickRoll: 0.020, visualSnap: 32,
    },
    adsTime: 0.16, eyeRelief: 0.320, adsFovScale: 0.82, adsVmFov: 50,
    reloadTime: 1.65, reloadEmptyTime: 2.2, magOutAt: 0.26, magInAt: 0.56, chargeAt: 0.80,
    drawTime: 0.36, holsterTime: 0.24, sprintOutTime: 0.11, inspectTime: 2.0,
    hip: { pos: [0.104, -0.116, -0.330], rot: [0.028, 0.052, 0.088] },
    sprint: { pos: [0.088, -0.166, -0.305], rot: [-0.46, 0.56, 0.32] },
    lowReady: { pos: [0.098, -0.104, -0.360], rot: [-0.120, 0.180, 0.082] },
    bobScale: 1.15, swayScale: 1.3,
    recoilPivot: [0, -0.06, 0.08],
    shellVel: [3.1, 2.0, 0.3],
    muzzleFlashScale: 0.7,
    boltTravel: 0.026, slideLock: true,
  },
]

export const WEAPON_BY_ID = new Map(WEAPONS.map((w) => [w.id, w]))

/** Seconds between shots. */
export function shotInterval(def: WeaponDef): number {
  return 60 / def.rpm
}
