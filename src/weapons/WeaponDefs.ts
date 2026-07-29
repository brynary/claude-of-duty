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
  /** Rounds carried outside the magazine at spawn, and the ceiling resupply refills to. */
  reserve: number
  /**
   * Rounds returned to the reserve for each enemy the player kills.
   *
   * A fixed loadout cannot survive a mode whose fights never stop. Measured on
   * the shipped `push` run: the player fired 240 rounds, which is `magSize +
   * reserve` exactly, ran the loadout to zero at t=82 s of a 90 s run, and
   * spent the remaining 8.5 s dry-clicking — all 12 of that run's dry fires.
   * The sister `hold` run fired 230, stopped ten rounds short of the same wall,
   * and dry-fired zero times. The magazine was never the problem; the supply
   * was.
   *
   * Call of Duty's own answer is resupply, not a bigger pouch: campaign ammo
   * off bodies, Zombies' box, and multiplayer's Scavenger perk, which
   * replenishes from fallen players. 30+210 is already eight magazines, at the
   * generous end of what a CoD AR carries, so the loadout stays a CoD loadout
   * and the kills feed it.
   *
   * Sized so that a kill returns what a kill costs at the *top* of the target
   * accuracy band (§1, 18-45%): `shotsToKill / 0.45`. Accuracy above that band
   * is net-positive and below it drains, so shooting well literally buys
   * ammunition and shooting badly still runs you out.
   */
  resupplyPerKill: number
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
  /**
   * Normalised time of the charging-handle pull on an empty reload, and with it
   * the moment the first round becomes usable.
   *
   * Derived rather than guessed. An empty reload is the tactical reload with
   * bolt work appended: the magazine seats at the same *absolute* moment in
   * both animations, and the extra `reloadEmptyTime - reloadTime` is the bolt.
   * So the credit point is
   *
   *   chargeAt = (magInAt * reloadTime + reloadEmptyTime - reloadTime) / reloadEmptyTime
   *
   * This makes §3.3's reload-cancel window identical for a tactical and an
   * empty reload on the same weapon, which is the invariant CoD4's files imply,
   * instead of four unrelated numbers. The four values here were previously
   * 0.82 / 0.88 / 0.84 / 0.88 — all late, all invented, and all charging the
   * player up to half a second of extra lockout on the empty reload that a
   * fight with no lulls forces every single magazine.
   */
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

/**
 * Recoil bias curves, as [pitch, yaw] multipliers per shot index.
 *
 * These used to be memorisable spray paths with a full-amplitude horizontal
 * S-curve. FEEL_TARGET §3.5 is explicit that Call of Duty does not work that
 * way: "this is a randomised cone with a directional bias, not a memorisable
 * fixed spray pattern like CS or Battlefield. Two shots from the same weapon
 * never trace the same path." So the horizontal term here is a gentle lean that
 * the per-shot jitter (which is larger than it) rides on top of, and the
 * vertical term only makes the opening shots heavier than the settled tail.
 */
const RIFLE_PATTERN: readonly (readonly [number, number])[] = [
  [1.15, 0.05], [1.00, -0.10], [0.95, -0.18], [0.92, -0.26], [0.90, -0.30],
  [0.89, -0.26], [0.88, -0.14], [0.88, 0.04], [0.88, 0.20], [0.88, 0.30],
  [0.88, 0.32], [0.88, 0.26], [0.88, 0.14], [0.88, 0.00], [0.88, -0.14],
  [0.88, -0.26], [0.88, -0.32], [0.88, -0.28], [0.88, -0.16], [0.88, 0.00],
]

const SMG_PATTERN: readonly (readonly [number, number])[] = [
  [1.10, -0.06], [0.98, -0.14], [0.94, -0.22], [0.92, -0.28], [0.90, -0.24],
  [0.90, -0.10], [0.90, 0.06], [0.90, 0.20], [0.90, 0.30], [0.90, 0.34],
  [0.90, 0.28], [0.90, 0.14], [0.90, -0.02], [0.90, -0.18], [0.90, -0.28],
]

const SNIPER_PATTERN: readonly (readonly [number, number])[] = [
  [1.0, 0.18], [1.0, -0.20], [1.0, 0.12],
]

const PISTOL_PATTERN: readonly (readonly [number, number])[] = [
  [1.0, 0.10], [0.95, -0.16], [0.92, 0.18], [0.90, -0.10], [0.88, 0.06],
]

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 'M4A1',
    displayName: 'M4A1',
    kind: 'rifle',
    sfx: 'rifle',
    // 100 HP target, 26 dmg: 4 shots to kill inside 22.2 m, 5 past ~36 m.
    // 780 RPM -> 76.9 ms per shot -> TTK = 3 x 76.9 = 231 ms, inside the
    // 200-300 ms band (FEEL_TARGET §2.1) and next to BO6's XM4 at 296 ms.
    // Band edges are the GPR 91's stated 22.2 m / 45.7 m.
    damage: 26, damageMin: 19, falloffStart: 22.2, falloffEnd: 45.7,
    // §2.4: classic ARs are 1.4 head / 1.0 everywhere else; modern reintroduced
    // sub-1.0 limbs at 0.9-0.98. NOTE these are overridden today — Soldier.ts
    // applies its own REGION_MULT and Ballistics defers to it.
    headMult: 1.4, chestMult: 1, stomachMult: 1, limbMult: 0.95,
    penetration: 1, maxPenetrations: 2, range: 320,
    rpm: 780, pellets: 1,
    modes: ['auto', 'burst', 'semi'], burstCount: 3, burstDelay: 0.2,
    // 4 shots to kill, so a kill costs 4 / accuracy rounds: 8.9 at the 45% top
    // of the target band, 11.0 at the 36% the fixed-aim runs actually measured,
    // 22.2 at the 18% floor. Resupply of 9 is the first of those, so a 36%
    // player drains 2 rounds per kill (240-round loadout, ~120 kills) and an
    // 18% player drains 13 (~18 kills, and the dry-weapon swap catches them).
    //
    // 30 rounds at 11.0 per kill is 2.7 kills per magazine. That is already
    // *above* CoD: a BO6 XM4 is 5 STK, so 12.5-16.7 rounds per kill at the same
    // accuracies, i.e. 1.8-2.4 kills per magazine. Enlarging the magazine would
    // move away from the reference, not toward it, so it stays at 30.
    magSize: 30, reserve: 210, resupplyPerKill: 9, muzzleVelocity: 880, noiseRadius: 45,
    // spreadAds is 0 on every weapon here: §3.6 [stated], "all weapons in Call
    // of Duty ... are perfectly accurate at an infinite range while aiming down
    // the sights", corroborated by `adsSpread 0` in the shipped weapon files.
    spreadHip: 0.0295, spreadAds: 0, spreadPerShot: 0.0021, spreadMax: 0.055,
    spreadDecay: 0.10, spreadMoveMul: 1.7, spreadCrouchMul: 0.72, spreadJumpMul: 2.4,
    // Budget: the sights must still be on the presented torso at the 26 m
    // designed rifle distance after the 4 shots that make the kill. The climb
    // is vertical, so it is spent against the torso's *height* — 0.84 m of
    // chest and stomach is 1.85 deg at 26 m, so 0.93 deg of half-budget from a
    // centre-mass hold. (The older note here compared the pitch climb against
    // the 0.35 m torso *width*, which is the wrong axis.)
    //
    // Measured open loop, full ADS, trigger held, mean of 400 seeds at 60 Hz.
    // Two columns because two things climb: `weapon` is the offset this file
    // owns, `view` adds the 30% of each kick that CameraRig.RECOIL_KEEP folds
    // permanently into the aim, and `view` is what the player must pull back.
    //
    //   shot     4      6      10     20     30
    //   weapon  0.51   0.79   1.19   1.69   1.91  deg
    //   view    0.66   1.03   1.55   2.22   2.53  deg
    //
    // So the kill burst ends 0.66 deg high — inside the 0.93 deg half-budget —
    // and a held magazine tops out around 2.5 deg, which is a bias to pull
    // against rather than a runaway. Horizontal stays under 0.1 deg throughout:
    // §3.5 [stated] wants "a randomised cone with a directional bias, not a
    // memorisable fixed spray pattern", so `yaw` is a third of `pitch` and the
    // per-shot jitter (0.45, x1.6 on yaw) is larger than the pattern's own
    // horizontal term, which never exceeds 0.32.
    //
    // adsScale is 1.0 because CoD4 ships identical hip and ADS view kick
    // [measured]; ADS buys spread, not recoil. `permanent` is 0 because
    // CameraRig already folds 30% of every kick into the aim — carrying a
    // second permanent term double-counted it.
    recoil: {
      pitch: 0.0038, yaw: 0.0013, jitter: 0.45, pattern: RIFLE_PATTERN,
      snap: 38, recovery: 1.2, settle: 6.0, permanent: 0, adsScale: 1,
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
    adsTime: 0.24, eyeRelief: 0.255, adsFovScale: 0.72, adsVmFov: 46,
    // CoD4 AK-47 [measured]: 2.50 s tactical, 3.25 s empty, ammo credited at
    // 1.50 s — 60% of the animation — leaving a 1.00 s free cancel window.
    // magInAt is that credit point, and WeaponSystem lets you fire out of the
    // reload once it passes.
    //
    // chargeAt by the rule on the interface: (0.60 x 2.4 + 0.85) / 3.25 = 0.705.
    // The gun is usable 2.29 s into an empty reload rather than 2.67 s, and both
    // windows land on 0.96 s against the AK-47's measured 1.00 s. Worth 0.38 s
    // per empty reload, and with downtime at 3.4 s the player fights every
    // magazine to empty, so that is ~8 of them a run.
    reloadTime: 2.4, reloadEmptyTime: 3.25, magOutAt: 0.30, magInAt: 0.60, chargeAt: 0.705,
    drawTime: 0.55, holsterTime: 0.35, sprintOutTime: 0.16, inspectTime: 2.4,
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
    // BO6 Kompakt 92 exactly: 20 dmg, 5 shots to kill against 100 HP. 920 RPM
    // -> 65.2 ms per shot -> TTK = 4 x 65.2 = 261 ms, between the Kompakt 92's
    // 220 ms and the PP-919's 288 ms. Max-damage band ends at its stated 11.4 m.
    damage: 20, damageMin: 15, falloffStart: 11.4, falloffEnd: 20,
    headMult: 1.4, chestMult: 1, stomachMult: 1, limbMult: 0.95,
    penetration: 0.55, maxPenetrations: 1, range: 200,
    rpm: 920, pellets: 1,
    modes: ['auto', 'semi'], burstCount: 3, burstDelay: 0.18,
    // 5 shots to kill: 11.1 rounds per kill at the 45% top of the band.
    magSize: 32, reserve: 224, resupplyPerKill: 11, muzzleVelocity: 400, noiseRadius: 38,
    spreadHip: 0.0225, spreadAds: 0, spreadPerShot: 0.0020, spreadMax: 0.060,
    spreadDecay: 0.13, spreadMoveMul: 1.35, spreadCrouchMul: 0.80, spreadJumpMul: 2.0,
    // Budget: 5 shots on the presented torso at the 13 m designed SMG distance.
    // 0.84 m of torso height is 3.70 deg at 13 m, so 1.85 deg of half-budget.
    // Measured open loop as for the M4A1: shot 5 is 0.58 deg weapon-owned /
    // 0.75 deg including CameraRig's 30% fold, and shot 30 tops out at 1.75 /
    // 2.32 deg. Comfortably inside the budget at the range this weapon is for.
    recoil: {
      pitch: 0.0034, yaw: 0.0012, jitter: 0.50, pattern: SMG_PATTERN,
      snap: 42, recovery: 1.4, settle: 6.0, permanent: 0, adsScale: 1,
      kickBack: 0.010, kickUp: 0.042, kickRoll: 0.026, visualSnap: 30,
    },
    adsTime: 0.21, eyeRelief: 0.235, adsFovScale: 0.80, adsVmFov: 50,
    // CoD4 MP5 [measured]: 2.33 s tactical, 3.30 s empty, ammo at 1.77 s (76%).
    // chargeAt = (0.76 x 2.35 + 0.95) / 3.30 = 0.829. Both windows 0.56 s — the
    // MP5's measured credit point genuinely is late, so the empty reload's is
    // too, and the derivation preserves that rather than flattening it.
    reloadTime: 2.35, reloadEmptyTime: 3.30, magOutAt: 0.28, magInAt: 0.76, chargeAt: 0.829,
    drawTime: 0.50, holsterTime: 0.28, sprintOutTime: 0.15, inspectTime: 2.2,
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
    // BO6 LR 7.62 exactly: 104 / 102 / 95 by band, one shot to the torso.
    // §2.3 [stated]: a one-shot weapon kills in 0 ms — the first round leaves
    // the barrel instantly. §2.4: snipers carry extra torso multipliers so a
    // body hit at range still resolves in one or two.
    damage: 104, damageMin: 95, falloffStart: 63.5, falloffEnd: 88.9,
    headMult: 1.5, chestMult: 1.5, stomachMult: 1.1, limbMult: 0.9,
    penetration: 2.4, maxPenetrations: 3, range: 600,
    // CoD4 M40A3 [measured]: 0.05 s fire + 0.866 s rechamber ~= 65 RPM.
    rpm: 62, pellets: 1,
    modes: ['semi'], burstCount: 1, burstDelay: 0,
    // One shot to kill, so 2.2 rounds per kill even at the 45% top of the band.
    // 2 keeps a sniper who is hitting roughly self-sufficient, which is the
    // right bargain for a weapon that punishes a miss with a full rechamber.
    magSize: 7, reserve: 42, resupplyPerKill: 2, muzzleVelocity: 915, noiseRadius: 90,
    spreadHip: 0.085, spreadAds: 0, spreadPerShot: 0.010, spreadMax: 0.12,
    spreadDecay: 0.20, spreadMoveMul: 2.2, spreadCrouchMul: 0.60, spreadJumpMul: 3.0,
    // One round per second, so the centre speed has 0.97 s to recentre: the
    // scope is back on the aim point well before the next shot is chambered.
    recoil: {
      pitch: 0.030, yaw: 0.008, jitter: 0.25, pattern: SNIPER_PATTERN,
      snap: 30, recovery: 4.0, settle: 4.0, permanent: 0, adsScale: 1,
      kickBack: 0.040, kickUp: 0.150, kickRoll: 0.045, visualSnap: 15,
    },
    adsTime: 0.50, eyeRelief: 0.300, adsFovScale: 0.30, adsVmFov: 40,
    // chargeAt = (0.62 x 2.7 + 0.5) / 3.2 = 0.679. Both windows 1.03 s.
    reloadTime: 2.7, reloadEmptyTime: 3.2, magOutAt: 0.28, magInAt: 0.62, chargeAt: 0.679,
    drawTime: 0.85, holsterTime: 0.50, sprintOutTime: 0.30, inspectTime: 2.8,
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
    // CoD4 M9 [measured]: 40 -> 20 damage, 3 shots close / 5 far, max damage to
    // 6.35 m. 34 dmg keeps the 3-shot kill against 100 HP with headroom for the
    // AI's chest multiplier. CoD4 patch 1.40 clamped semi-autos to 444-566 RPM;
    // 480 RPM -> 125 ms per shot -> TTK = 2 x 125 = 250 ms, inside the 210-270
    // ms the same source derives for a 3-shot kill.
    damage: 34, damageMin: 20, falloffStart: 6.35, falloffEnd: 12.7,
    headMult: 1.4, chestMult: 1, stomachMult: 1, limbMult: 0.95,
    penetration: 0.5, maxPenetrations: 1, range: 140,
    rpm: 480, pellets: 1,
    modes: ['semi', 'burst'], burstCount: 3, burstDelay: 0.22,
    // 3 shots to kill: 6.7 rounds per kill at the 45% top of the band.
    magSize: 17, reserve: 68, resupplyPerKill: 7, muzzleVelocity: 360, noiseRadius: 32,
    spreadHip: 0.0230, spreadAds: 0, spreadPerShot: 0.0045, spreadMax: 0.070,
    spreadDecay: 0.16, spreadMoveMul: 1.4, spreadCrouchMul: 0.78, spreadJumpMul: 2.2,
    recoil: {
      pitch: 0.0098, yaw: 0.0026, jitter: 0.50, pattern: PISTOL_PATTERN,
      snap: 44, recovery: 2.4, settle: 5.0, permanent: 0, adsScale: 1,
      kickBack: 0.012, kickUp: 0.075, kickRoll: 0.020, visualSnap: 32,
    },
    adsTime: 0.13, eyeRelief: 0.320, adsFovScale: 0.82, adsVmFov: 50,
    // CoD4 M9 [measured]: 1.63 s tactical, 1.92 s empty, ammo at 1.20 s (74%).
    // The M9 is the cleanest check on the chargeAt rule: its empty reload is
    // only 0.29 s longer than its tactical one, so the slide drop must follow
    // the magazine almost immediately, and the rule says 0.779 — a 75 ms gap.
    // Both windows 0.42 s.
    reloadTime: 1.63, reloadEmptyTime: 1.92, magOutAt: 0.26, magInAt: 0.74, chargeAt: 0.779,
    drawTime: 0.45, holsterTime: 0.28, sprintOutTime: 0.10, inspectTime: 2.0,
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
