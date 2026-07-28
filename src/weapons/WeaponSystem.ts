import type { GameContext, System, WeaponService } from '../core/Types'

/**
 * Weapon handling: viewmodel, procedural animation, ADS, recoil, ballistics,
 * ammo, reloads and weapon switching.
 *
 * STUB — replaced by the weapons pass.
 */
export class WeaponSystem implements System, WeaponService {
  readonly name = 'weapons'

  currentName = 'M4'
  adsFraction = 0
  recoilPitch = 0
  recoilYaw = 0
  isReloading = false
  isFiring = false

  init(ctx: GameContext): void {
    ctx.services.weapons = this
  }

  update(_dt: number, _ctx: GameContext): void {}
}
