import type * as THREE from 'three'
import type { GameContext, System, HudService } from '../core/Types'

/**
 * Heads-up display and menus: crosshair, ammo, health, compass, minimap,
 * hitmarkers, killfeed, damage direction and the pause/start screens.
 *
 * STUB — replaced by the HUD pass.
 */
export class HudSystem implements System, HudService {
  readonly name = 'hud'

  private root!: HTMLDivElement

  init(ctx: GameContext): void {
    this.root = document.createElement('div')
    this.root.id = 'hud'
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
    if (ctx.config.hideHud) this.root.style.display = 'none'
    document.body.appendChild(this.root)
    ctx.services.hud = this
  }

  hitmarker(_kind: 'normal' | 'headshot' | 'kill'): void {}
  killfeed(_killer: string, _victim: string, _weapon: string, _headshot: boolean): void {}
  damageDirection(_worldDir: THREE.Vector3): void {}
  setAmmo(_mag: number, _reserve: number): void {}
  setWeaponName(_name: string): void {}
  setHealth(_fraction: number): void {}
  showMessage(_text: string, _seconds?: number): void {}

  dispose(): void {
    this.root?.remove()
  }
}
