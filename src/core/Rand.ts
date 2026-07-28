/**
 * Deterministic PRNG (mulberry32). Every procedural generator takes one of
 * these so a given `seed` always produces the identical level, and screenshots
 * are reproducible frame for frame.
 */
export class Rand {
  private state: number

  constructor(seed = 1337) {
    this.state = seed >>> 0
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** Symmetric noise in [-amount, amount]. */
  spread(amount: number): number {
    return (this.next() * 2 - 1) * amount
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  }

  /** Approximately normal, mean 0, std 1. */
  gaussian(): number {
    let u = 0
    let v = 0
    while (u === 0) u = this.next()
    while (v === 0) v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** Shared instance for non-deterministic cosmetic jitter. */
export const rand = new Rand(1337)
