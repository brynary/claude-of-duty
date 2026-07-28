import type * as THREE from 'three'
import type { Damageable, HitInfo, Surface } from './Types'

/**
 * The complete set of cross-system messages. Adding a member here is the way
 * to let two systems talk without importing each other.
 */
export interface GameEvents {
  'weapon:fired': { weapon: string; origin: THREE.Vector3; direction: THREE.Vector3; loud: boolean }
  'weapon:hit': HitInfo
  'weapon:reload': { weapon: string; phase: 'start' | 'magOut' | 'magIn' | 'end' }
  'weapon:switch': { from: string; to: string }
  'weapon:ammo': { mag: number; reserve: number }
  'weapon:dryFire': { weapon: string }

  'damage:dealt': { target: Damageable; amount: number; hit: HitInfo }
  'entity:killed': { entity: Damageable; byPlayer: boolean; weapon: string; headshot: boolean }
  'entity:spawned': { entity: Damageable }

  'player:damaged': { amount: number; fromDirection: THREE.Vector3 }
  'player:died': Record<string, never>
  'player:respawn': Record<string, never>
  'player:footstep': { position: THREE.Vector3; surface: Surface; running: boolean }
  'player:land': { position: THREE.Vector3; impact: number }

  'fx:explosion': { point: THREE.Vector3; radius: number; damage: number }

  'game:pause': { paused: boolean }
  'game:started': Record<string, never>
  'quality:changed': { level: string }
}

type Handler<T> = (payload: T) => void

/** Minimal, allocation-free-on-emit typed pub/sub. */
export class EventBus {
  private map = new Map<keyof GameEvents, Set<Handler<never>>>()

  on<K extends keyof GameEvents>(key: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.map.get(key)
    if (!set) {
      set = new Set()
      this.map.set(key, set)
    }
    set.add(fn as Handler<never>)
    return () => this.off(key, fn)
  }

  once<K extends keyof GameEvents>(key: K, fn: Handler<GameEvents[K]>): void {
    const off = this.on(key, (p) => {
      off()
      fn(p)
    })
  }

  off<K extends keyof GameEvents>(key: K, fn: Handler<GameEvents[K]>): void {
    this.map.get(key)?.delete(fn as Handler<never>)
  }

  emit<K extends keyof GameEvents>(key: K, payload: GameEvents[K]): void {
    const set = this.map.get(key)
    if (!set) return
    for (const fn of set) (fn as Handler<GameEvents[K]>)(payload)
  }
}
