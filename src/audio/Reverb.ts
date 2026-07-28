import { Rand } from '../core/Rand'
import { Biquad } from './Synth'

/**
 * Procedural convolution reverb.
 *
 * Impulse responses are synthesised rather than sampled: a pattern of discrete
 * early reflections (which carry the geometry — a narrow street slaps, a room
 * clusters) followed by a band-split noise tail whose highs die faster than its
 * lows (which carries the material — plaster is bright, a tunnel is not).
 *
 * Two convolver slots exist so a zone change crossfades instead of cutting.
 */

export type ZoneName = 'outdoor' | 'indoor' | 'tunnel' | 'hall'

interface ZoneSpec {
  duration: number
  predelay: number
  /** RT60-ish time constants per band, in seconds. */
  decayLow: number
  decayMid: number
  decayHigh: number
  /** Discrete early reflections as [seconds, gain]. */
  early: [number, number][]
  /** Seconds over which the tail builds to full density. */
  buildup: number
  /** Flutter comb delay in seconds; 0 for none. */
  flutter: number
  flutterFeedback: number
  /** Top-end limit of the whole IR. */
  brightness: number
  /** Wet level of the return when this zone is active. */
  wet: number
}

const ZONES: Record<ZoneName, ZoneSpec> = {
  // A street between four-storey buildings: a handful of hard, bright,
  // clearly separated slaps and very little diffuse energy.
  outdoor: {
    duration: 2.3,
    predelay: 0.011,
    decayLow: 0.62,
    decayMid: 0.44,
    decayHigh: 0.3,
    early: [
      [0.017, 0.72], [0.029, 0.55], [0.046, 0.62], [0.068, 0.4],
      [0.091, 0.46], [0.124, 0.3], [0.163, 0.26], [0.212, 0.19],
      [0.278, 0.15], [0.351, 0.1], [0.44, 0.07],
    ],
    buildup: 0.06,
    flutter: 0,
    flutterFeedback: 0,
    brightness: 9000,
    wet: 0.26,
  },
  // A plastered room: dense, short, and dark because soft furnishings and
  // rough walls eat the top octave almost immediately.
  indoor: {
    duration: 1,
    predelay: 0.0035,
    decayLow: 0.3,
    decayMid: 0.22,
    decayHigh: 0.1,
    early: [
      [0.004, 0.8], [0.008, 0.62], [0.013, 0.7], [0.018, 0.5],
      [0.024, 0.55], [0.031, 0.42], [0.039, 0.36], [0.049, 0.3],
      [0.061, 0.26], [0.076, 0.2], [0.094, 0.15],
    ],
    buildup: 0.012,
    flutter: 0,
    flutterFeedback: 0,
    brightness: 5200,
    wet: 0.44,
  },
  // Concrete tube: band-limited, long in the low mids, with an audible
  // flutter between the parallel walls.
  tunnel: {
    duration: 2.1,
    predelay: 0.006,
    decayLow: 0.85,
    decayMid: 0.6,
    decayHigh: 0.16,
    early: [
      [0.008, 0.7], [0.019, 0.6], [0.033, 0.55], [0.05, 0.45],
      [0.071, 0.4], [0.098, 0.32], [0.132, 0.26], [0.178, 0.2],
    ],
    buildup: 0.03,
    flutter: 0.0113,
    flutterFeedback: 0.52,
    brightness: 3200,
    wet: 0.62,
  },
  // Big empty hall: long, smooth, and only moderately bright.
  hall: {
    duration: 4,
    predelay: 0.024,
    decayLow: 1.5,
    decayMid: 1.1,
    decayHigh: 0.45,
    early: [
      [0.021, 0.55], [0.034, 0.45], [0.052, 0.5], [0.073, 0.38],
      [0.099, 0.34], [0.131, 0.28], [0.171, 0.24], [0.22, 0.19],
      [0.281, 0.15], [0.356, 0.11],
    ],
    buildup: 0.09,
    flutter: 0,
    flutterFeedback: 0,
    brightness: 7000,
    wet: 0.5,
  },
}

export class Reverb {
  readonly input: GainNode
  readonly output: GainNode

  private ctx: AudioContext
  private rand: Rand
  private slots: { conv: ConvolverNode; pre: DelayNode; gain: GainNode }[] = []
  private active = 0
  private zone: ZoneName = 'outdoor'
  private cache = new Map<ZoneName, AudioBuffer>()

  constructor(ctx: AudioContext, seed: number) {
    this.ctx = ctx
    this.rand = new Rand((seed ^ 0x9e37) >>> 0)
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.output.gain.value = ZONES.outdoor.wet

    for (let i = 0; i < 2; i++) {
      const pre = ctx.createDelay(0.5)
      const conv = ctx.createConvolver()
      conv.normalize = true
      const gain = ctx.createGain()
      gain.gain.value = i === 0 ? 1 : 0
      this.input.connect(pre)
      pre.connect(conv)
      conv.connect(gain)
      gain.connect(this.output)
      this.slots.push({ conv, pre, gain })
    }

    this.applyZone('outdoor', 0, 0)
  }

  get currentZone(): ZoneName {
    return this.zone
  }

  setZone(zone: ZoneName, fadeSeconds = 0.7): void {
    if (zone === this.zone) return
    this.zone = zone
    const next = this.active ^ 1
    this.applyZone(zone, next, fadeSeconds)
  }

  private applyZone(zone: ZoneName, slotIndex: number, fade: number): void {
    const spec = ZONES[zone]
    const slot = this.slots[slotIndex]
    slot.conv.buffer = this.irFor(zone)
    slot.pre.delayTime.value = spec.predelay

    const now = this.ctx.currentTime
    const other = this.slots[slotIndex ^ 1]
    if (fade <= 0) {
      slot.gain.gain.value = 1
      other.gain.gain.value = 0
    } else {
      // Equal-power-ish crossfade; a linear one dips audibly in the middle.
      slot.gain.gain.cancelScheduledValues(now)
      other.gain.gain.cancelScheduledValues(now)
      slot.gain.gain.setValueAtTime(slot.gain.gain.value, now)
      other.gain.gain.setValueAtTime(other.gain.gain.value, now)
      slot.gain.gain.linearRampToValueAtTime(1, now + fade)
      other.gain.gain.linearRampToValueAtTime(0, now + fade)
    }
    this.output.gain.cancelScheduledValues(now)
    this.output.gain.setValueAtTime(this.output.gain.value, now)
    this.output.gain.linearRampToValueAtTime(spec.wet, now + Math.max(fade, 0.01))
    this.active = slotIndex
  }

  private irFor(zone: ZoneName): AudioBuffer {
    const cached = this.cache.get(zone)
    if (cached) return cached
    const buffer = this.buildIr(ZONES[zone])
    this.cache.set(zone, buffer)
    return buffer
  }

  private buildIr(spec: ZoneSpec): AudioBuffer {
    const sr = this.ctx.sampleRate
    const len = Math.max(64, Math.round(spec.duration * sr))
    const buffer = this.ctx.createBuffer(2, len, sr)
    const rand = this.rand

    for (let c = 0; c < 2; c++) {
      const out = buffer.getChannelData(c)

      // Late tail: white noise split into three bands, each decaying at its
      // own rate, then summed. Highs vanishing first is the whole trick.
      const noise = new Float32Array(len)
      for (let i = 0; i < len; i++) noise[i] = rand.next() * 2 - 1

      const bands: [number, number, Biquad][] = [
        [spec.decayLow, 1, filterFor('lowpass', sr, 320, 0.7)],
        [spec.decayMid, 1, filterFor('bandpass', sr, 1400, 0.55)],
        [spec.decayHigh, 1, filterFor('highpass', sr, 3200, 0.7)],
      ]
      for (const [decay, level, filter] of bands) {
        const k = Math.exp(-1 / (sr * Math.max(decay, 0.01)))
        let env = 1
        for (let i = 0; i < len; i++) {
          out[i] += filter.process(noise[i]) * env * level
          env *= k
        }
      }

      // Density build-up so the tail swells rather than starting flat out.
      const build = Math.max(1, Math.round(spec.buildup * sr))
      for (let i = 0; i < build && i < len; i++) {
        const x = i / build
        out[i] *= x * x * (3 - 2 * x)
      }

      // Discrete early reflections, alternating which ear leads.
      // A 0.4 ms noise smear rather than a bare impulse, so reflections read
      // as surfaces rather than as clicks.
      const smear = Math.max(2, Math.round(0.0004 * sr))
      for (let e = 0; e < spec.early.length; e++) {
        const [t, g] = spec.early[e]
        const jitter = 1 + (c === 0 ? -1 : 1) * (0.03 + rand.next() * 0.05)
        const at = Math.round(t * jitter * sr)
        if (at >= len - smear - 1) continue
        const pan = e % 2 === c ? 1 : 0.62
        for (let i = 0; i < smear; i++) {
          out[at + i] += (rand.next() * 2 - 1) * g * pan * (1 - i / smear)
        }
        out[at] += g * pan * 0.55 * (rand.bool() ? 1 : -1)
      }

      if (spec.flutter > 0) {
        const d = Math.round(spec.flutter * sr)
        for (let i = d; i < len; i++) out[i] += out[i - d] * spec.flutterFeedback
      }

      // Diffusion: two allpasses smear anything still too impulsive.
      allpass(out, Math.round(0.00731 * sr), 0.62)
      allpass(out, Math.round(0.00269 * sr), -0.5)

      const top = filterFor('lowpass', sr, spec.brightness, 0.6)
      const bottom = filterFor('highpass', sr, 55, 0.7)
      for (let i = 0; i < len; i++) out[i] = bottom.process(top.process(out[i]))

      // Hard fade at the end; a truncated IR clicks on every convolution wrap.
      const fade = Math.min(Math.round(0.05 * sr), len)
      for (let i = 0; i < fade; i++) out[len - fade + i] *= 1 - i / fade
    }

    return buffer
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.gain.disconnect()
      slot.conv.disconnect()
      slot.pre.disconnect()
    }
    this.input.disconnect()
    this.output.disconnect()
    this.cache.clear()
  }
}

function filterFor(kind: 'lowpass' | 'highpass' | 'bandpass', sr: number, freq: number, q: number): Biquad {
  const f = new Biquad()
  f.set(kind, sr, freq, q)
  return f
}

function allpass(buf: Float32Array, delay: number, g: number): void {
  if (delay < 1 || delay >= buf.length) return
  const line = new Float32Array(delay)
  let idx = 0
  for (let i = 0; i < buf.length; i++) {
    const old = line[idx]
    const v = buf[i] + old * g
    line[idx] = v
    buf[i] = old - v * g
    idx = idx + 1 === delay ? 0 : idx + 1
  }
}
