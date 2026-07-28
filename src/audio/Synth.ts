import type { Rand } from '../core/Rand'

/**
 * Offline synthesis toolkit.
 *
 * Everything the game hears is built here as raw PCM and handed to the mixer as
 * an AudioBuffer. Doing the DSP in plain JS rather than through an
 * OfflineAudioContext graph buys three things that matter for this project:
 * the output is bit-for-bit deterministic from the seed, nothing is async so
 * the build can be chopped into per-frame slices, and per-sample control makes
 * layered transients (the thing that separates a gunshot from a noise burst)
 * actually achievable.
 *
 * Convention: source functions ADD into a destination buffer at a time offset;
 * processors MULTIPLY or filter in place. Build each layer in its own scratch
 * buffer, shape it, then mix it down.
 */

/** A block of PCM. `ch.length` is 1 for mono, 2 for stereo. */
export interface Clip {
  sr: number
  ch: Float32Array[]
}

/** One resonant partial of a struck body. */
export interface Mode {
  freq: number
  /** Time constant of the exponential ring-down, in seconds. */
  decay: number
  gain: number
  /** Fractional upward pitch offset at strike time that relaxes away. */
  drift?: number
  phase?: number
}

/** A delayed, attenuated copy of a signal — early reflections and slapback. */
export interface Tap {
  t: number
  g: number
  /** Optional lowpass applied to this tap only. */
  lp?: number
}

export type FilterKind =
  | 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  | 'peaking' | 'lowshelf' | 'highshelf' | 'allpass'

export type Wave = 'sine' | 'tri' | 'saw' | 'square'

const TAU = Math.PI * 2

/** Direct-form-I biquad using the RBJ cookbook coefficients. */
export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  reset(): void {
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }

  set(kind: FilterKind, sr: number, freq: number, q: number, gainDb = 0): void {
    const f = Math.min(Math.max(freq, 6), sr * 0.492)
    const Q = Math.max(q, 0.02)
    const w = (TAU * f) / sr
    const cw = Math.cos(w)
    const sw = Math.sin(w)
    const alpha = sw / (2 * Q)
    const A = Math.pow(10, gainDb / 40)
    const sqA = Math.sqrt(A)

    let b0 = 1
    let b1 = 0
    let b2 = 0
    let a0 = 1
    let a1 = 0
    let a2 = 0

    switch (kind) {
      case 'lowpass':
        b0 = (1 - cw) * 0.5; b1 = 1 - cw; b2 = b0
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'highpass':
        b0 = (1 + cw) * 0.5; b1 = -(1 + cw); b2 = b0
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'allpass':
        b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A
        break
      case 'lowshelf':
        b0 = A * ((A + 1) - (A - 1) * cw + 2 * sqA * alpha)
        b1 = 2 * A * ((A - 1) - (A + 1) * cw)
        b2 = A * ((A + 1) - (A - 1) * cw - 2 * sqA * alpha)
        a0 = (A + 1) + (A - 1) * cw + 2 * sqA * alpha
        a1 = -2 * ((A - 1) + (A + 1) * cw)
        a2 = (A + 1) + (A - 1) * cw - 2 * sqA * alpha
        break
      case 'highshelf':
        b0 = A * ((A + 1) + (A - 1) * cw + 2 * sqA * alpha)
        b1 = -2 * A * ((A - 1) + (A + 1) * cw)
        b2 = A * ((A + 1) + (A - 1) * cw - 2 * sqA * alpha)
        a0 = (A + 1) - (A - 1) * cw + 2 * sqA * alpha
        a1 = 2 * ((A - 1) - (A + 1) * cw)
        a2 = (A + 1) - (A - 1) * cw - 2 * sqA * alpha
        break
    }

    const inv = 1 / a0
    this.b0 = b0 * inv
    this.b1 = b1 * inv
    this.b2 = b2 * inv
    this.a1 = a1 * inv
    this.a2 = a2 * inv
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  run(buf: Float32Array, from = 0, to = -1): void {
    const end = to < 0 ? buf.length : to
    for (let i = from; i < end; i++) buf[i] = this.process(buf[i])
  }
}

export class Synth {
  readonly sr: number
  rng: Rand

  private scratchFilter = new Biquad()

  constructor(sr: number, rng: Rand) {
    this.sr = sr
    this.rng = rng
  }

  // --- allocation ---------------------------------------------------------

  n(seconds: number): number {
    return Math.max(1, Math.round(seconds * this.sr))
  }

  buf(seconds: number): Float32Array {
    return new Float32Array(this.n(seconds))
  }

  // --- noise --------------------------------------------------------------

  /** Flat spectrum. The raw material for almost every impulsive sound. */
  white(out: Float32Array, gain = 1, from = 0, to = -1): void {
    const end = to < 0 ? out.length : to
    const r = this.rng
    for (let i = from; i < end; i++) out[i] += (r.next() * 2 - 1) * gain
  }

  /** -3 dB/octave. Reads as "air" and distance rather than hiss. */
  pink(out: Float32Array, gain = 1): void {
    const r = this.rng
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < out.length; i++) {
      const w = r.next() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      out[i] += (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * gain
      b6 = w * 0.115926
    }
  }

  /** -6 dB/octave. Wind, rumble, the low half of an explosion. */
  brown(out: Float32Array, gain = 1): void {
    const r = this.rng
    let y = 0
    for (let i = 0; i < out.length; i++) {
      y += (r.next() * 2 - 1) * 0.022
      if (y > 1) y = 1
      else if (y < -1) y = -1
      out[i] += y * 3.2 * gain
    }
  }

  // --- envelopes (multiply in place) --------------------------------------

  /**
   * Attack/decay. `attack` under a millisecond is what makes a transient read
   * as a hit rather than a swell; `curve` above 1 tightens the decay knee.
   */
  envAD(out: Float32Array, attack: number, tau: number, curve = 1): void {
    const dt = 1 / this.sr
    const ka = attack > 0 ? -dt / attack : -1e9
    const kd = -dt / Math.max(tau, 1e-5)
    let a = 1
    let d = 1
    const ea = Math.exp(ka)
    const ed = Math.exp(kd)
    for (let i = 0; i < out.length; i++) {
      const env = (1 - a) * (curve === 1 ? d : Math.pow(d, curve))
      out[i] *= env
      a *= ea
      d *= ed
    }
  }

  /** Plain exponential ring-down with no attack shaping. */
  envExp(out: Float32Array, tau: number): void {
    const k = Math.exp(-1 / (this.sr * Math.max(tau, 1e-5)))
    let d = 1
    for (let i = 0; i < out.length; i++) {
      out[i] *= d
      d *= k
    }
  }

  /** Piecewise-linear breakpoints as [seconds, level] pairs. */
  envCurve(out: Float32Array, points: readonly (readonly number[])[]): void {
    if (points.length === 0) return
    let seg = 0
    for (let i = 0; i < out.length; i++) {
      const t = i / this.sr
      while (seg < points.length - 2 && t > points[seg + 1][0]) seg++
      const a = points[seg]
      const b = points[Math.min(seg + 1, points.length - 1)]
      const span = b[0] - a[0]
      const f = span > 1e-9 ? Math.min(Math.max((t - a[0]) / span, 0), 1) : 1
      out[i] *= a[1] + (b[1] - a[1]) * f
    }
  }

  fadeIn(out: Float32Array, seconds: number): void {
    const k = Math.min(this.n(seconds), out.length)
    for (let i = 0; i < k; i++) out[i] *= i / k
  }

  fadeOut(out: Float32Array, seconds: number): void {
    const k = Math.min(this.n(seconds), out.length)
    const start = out.length - k
    for (let i = 0; i < k; i++) out[start + i] *= 1 - i / k
  }

  // --- filters ------------------------------------------------------------

  filt(out: Float32Array, kind: FilterKind, freq: number, q = 0.707, gainDb = 0): void {
    const f = this.scratchFilter
    f.reset()
    f.set(kind, this.sr, freq, q, gainDb)
    f.run(out)
  }

  /**
   * Exponential cutoff sweep. A muzzle blast's spectrum collapses downward as
   * the shock front decays; sweeping the cutoff is what reproduces that.
   * `overSeconds` of 0 sweeps across the whole buffer.
   */
  sweep(
    out: Float32Array,
    kind: FilterKind,
    f0: number,
    f1: number,
    q = 0.707,
    overSeconds = 0,
    gainDb = 0,
  ): void {
    const f = this.scratchFilter
    f.reset()
    const span = overSeconds > 0 ? this.n(overSeconds) : out.length
    const ratio = Math.log(Math.max(f1, 1) / Math.max(f0, 1))
    const block = 16
    for (let i = 0; i < out.length; i += block) {
      const p = Math.min(i / span, 1)
      f.set(kind, this.sr, f0 * Math.exp(ratio * p), q, gainDb)
      const end = Math.min(i + block, out.length)
      f.run(out, i, end)
    }
  }

  /** Adds a resonant band of the buffer back onto itself. */
  resonate(out: Float32Array, freq: number, q: number, gain: number): void {
    const f = new Biquad()
    f.set('bandpass', this.sr, freq, q)
    for (let i = 0; i < out.length; i++) out[i] += f.process(out[i]) * gain
  }

  // --- shaping ------------------------------------------------------------

  /** Soft asymmetric saturation. Adds the mid harmonics that read as "loud". */
  saturate(out: Float32Array, drive: number, mix = 1): void {
    const norm = 1 / Math.tanh(drive)
    for (let i = 0; i < out.length; i++) {
      const x = out[i]
      const bias = x > 0 ? 1 : 0.86
      const y = Math.tanh(x * drive * bias) * norm
      out[i] = x + (y - x) * mix
    }
  }

  clipTo(out: Float32Array, level: number): void {
    for (let i = 0; i < out.length; i++) {
      if (out[i] > level) out[i] = level
      else if (out[i] < -level) out[i] = -level
    }
  }

  normalize(out: Float32Array, peak = 0.95): void {
    let m = 0
    for (let i = 0; i < out.length; i++) {
      const a = out[i] < 0 ? -out[i] : out[i]
      if (a > m) m = a
    }
    if (m < 1e-6) return
    const g = peak / m
    for (let i = 0; i < out.length; i++) out[i] *= g
  }

  /** Scales a channel set by one shared factor, preserving stereo balance. */
  normalizeAll(channels: Float32Array[], peak = 0.95): void {
    let m = 0
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i]
        if (a > m) m = a
      }
    }
    if (m < 1e-6) return
    const g = peak / m
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) ch[i] *= g
    }
  }

  gainAll(out: Float32Array, g: number): void {
    for (let i = 0; i < out.length; i++) out[i] *= g
  }

  /** One-pole DC blocker; sub-bass sweeps and asymmetric drive both need it. */
  dcBlock(out: Float32Array): void {
    let x1 = 0
    let y1 = 0
    const r = 1 - 40 / this.sr
    for (let i = 0; i < out.length; i++) {
      const x = out[i]
      const y = x - x1 + r * y1
      x1 = x
      y1 = y
      out[i] = y
    }
  }

  // --- sources (additive) -------------------------------------------------

  /**
   * Modal synthesis: a struck body is a sum of exponentially decaying
   * sinusoids. This is what makes metal sound like metal rather than like
   * filtered noise.
   */
  modal(out: Float32Array, atSeconds: number, modes: readonly Mode[]): void {
    const start = this.n(atSeconds)
    const dt = 1 / this.sr
    for (const m of modes) {
      const decay = Math.max(m.decay, 1e-4)
      const kd = Math.exp(-dt / decay)
      const driftK = Math.exp(-dt / (decay * 0.28))
      let amp = m.gain
      let phase = m.phase ?? this.rng.next() * TAU
      let drift = m.drift ?? 0
      for (let i = start; i < out.length; i++) {
        out[i] += Math.sin(phase) * amp
        phase += TAU * m.freq * (1 + drift) * dt
        amp *= kd
        drift *= driftK
        if (amp < 1e-5) break
      }
    }
  }

  /** Exponential pitch sweep. Body thumps, ricochet whines, sub drops. */
  chirp(
    out: Float32Array,
    atSeconds: number,
    durSeconds: number,
    f0: number,
    f1: number,
    gain: number,
    wave: Wave = 'sine',
    vibrato = 0,
    vibratoRate = 0,
  ): void {
    const start = this.n(atSeconds)
    const len = this.n(durSeconds)
    const end = Math.min(start + len, out.length)
    const dt = 1 / this.sr
    const ratio = Math.log(Math.max(f1, 0.5) / Math.max(f0, 0.5))
    let phase = this.rng.next() * TAU
    let vphase = 0
    for (let i = start; i < end; i++) {
      const p = (i - start) / len
      let f = f0 * Math.exp(ratio * p)
      if (vibrato > 0) {
        f *= 1 + Math.sin(vphase) * vibrato
        vphase += TAU * vibratoRate * dt
      }
      out[i] += waveAt(wave, phase) * gain
      phase += TAU * f * dt
      if (phase > TAU) phase -= TAU
    }
  }

  tone(out: Float32Array, atSeconds: number, durSeconds: number, freq: number, gain: number, wave: Wave = 'sine'): void {
    this.chirp(out, atSeconds, durSeconds, freq, freq, gain, wave)
  }

  /**
   * One short band-limited noise click. Gravel, glass and debris are just
   * clouds of these with randomised pitch and spacing.
   */
  grain(out: Float32Array, atSeconds: number, durSeconds: number, freq: number, q: number, gain: number): void {
    const start = this.n(atSeconds)
    const len = this.n(durSeconds)
    const end = Math.min(start + len, out.length)
    if (end <= start) return
    const f = new Biquad()
    f.set('bandpass', this.sr, freq, q)
    const kd = Math.exp(-1 / (this.sr * Math.max(durSeconds * 0.3, 1e-4)))
    let amp = gain
    const r = this.rng
    for (let i = start; i < end; i++) {
      out[i] += f.process(r.next() * 2 - 1) * amp
      amp *= kd
    }
  }

  /** A burst of grains whose density decays across the window. */
  grainCloud(
    out: Float32Array,
    count: number,
    t0: number,
    t1: number,
    fMin: number,
    fMax: number,
    gain: number,
    q = 6,
    clumping = 2,
  ): void {
    const r = this.rng
    for (let i = 0; i < count; i++) {
      // Bias placement toward the start so the cloud thins out over time.
      const u = Math.pow(r.next(), clumping)
      const t = t0 + u * (t1 - t0)
      const f = fMin * Math.pow(fMax / fMin, r.next())
      const g = gain * (0.35 + r.next() * 0.65) * (1 - u * 0.6)
      this.grain(out, t, 0.004 + r.next() * 0.02, f, q, g)
    }
  }

  // --- routing ------------------------------------------------------------

  mixInto(dst: Float32Array, src: Float32Array, offsetSamples: number, gain = 1): void {
    const start = Math.max(0, offsetSamples)
    const n = Math.min(src.length, dst.length - start)
    const skip = start - offsetSamples
    for (let i = 0; i < n; i++) dst[start + i] += src[i + skip] * gain
  }

  /**
   * Mixes a resampled (pitch-shifted) copy in. Layering a shot with a copy of
   * itself an octave down and a few milliseconds late is the cheapest way to
   * add weight without muddying the transient.
   */
  resampleMix(dst: Float32Array, src: Float32Array, offsetSamples: number, ratio: number, gain = 1): void {
    let pos = 0
    for (let i = Math.max(0, offsetSamples); i < dst.length; i++) {
      const idx = pos | 0
      if (idx + 1 >= src.length) break
      const f = pos - idx
      dst[i] += (src[idx] * (1 - f) + src[idx + 1] * f) * gain
      pos += ratio
    }
  }

  /** Mixes delayed copies of the buffer back onto itself. */
  taps(out: Float32Array, taps: readonly Tap[]): void {
    const src = out.slice()
    for (const tap of taps) {
      const d = this.n(tap.t)
      if (d >= out.length) continue
      if (tap.lp) {
        const tmp = src.slice(0, out.length - d)
        this.filt(tmp, 'lowpass', tap.lp, 0.6)
        for (let i = 0; i < tmp.length; i++) out[d + i] += tmp[i] * tap.g
      } else {
        for (let i = 0; i + d < out.length; i++) out[d + i] += src[i] * tap.g
      }
    }
  }

  /** Feedback comb — flutter echo, tube resonance, corrugated-metal ring. */
  comb(out: Float32Array, delaySeconds: number, feedback: number, mix = 1): void {
    const d = this.n(delaySeconds)
    if (d < 1 || d >= out.length) return
    for (let i = d; i < out.length; i++) out[i] += out[i - d] * feedback * mix
  }

  /** Schroeder allpass — smears transients into diffuse density. */
  allpass(out: Float32Array, delaySeconds: number, g: number): void {
    const d = this.n(delaySeconds)
    if (d < 1 || d >= out.length) return
    const buf = new Float32Array(d)
    let idx = 0
    for (let i = 0; i < out.length; i++) {
      const bufOut = buf[idx]
      const x = out[i]
      const v = x + bufOut * g
      buf[idx] = v
      out[i] = bufOut - v * g
      idx = idx + 1 === d ? 0 : idx + 1
    }
  }

  // --- finishing ----------------------------------------------------------

  mono(data: Float32Array): Clip {
    return { sr: this.sr, ch: [data] }
  }

  stereo(l: Float32Array, r: Float32Array): Clip {
    return { sr: this.sr, ch: [l, r] }
  }

  /**
   * Turns a mono layer into a wide stereo pair via a sub-millisecond Haas
   * offset plus allpass decorrelation, so close sounds fill the head instead of
   * collapsing to a point between the speakers.
   */
  widen(data: Float32Array, spreadSeconds = 0.0007, tilt = 0.12, peak = 0.92): Clip {
    const l = data.slice()
    const r = new Float32Array(data.length)
    const d = this.n(spreadSeconds)
    for (let i = 0; i < data.length; i++) r[i] = i >= d ? data[i - d] : 0
    this.allpass(r, 0.0031, 0.62)
    this.allpass(l, 0.0019, -0.55)
    this.filt(l, 'highshelf', 4200, 0.7, tilt * 6)
    this.filt(r, 'highshelf', 4200, 0.7, -tilt * 6)
    // Decorrelation adds gain, so the final trim happens here rather than
    // before — otherwise every stereo clip lands above full scale.
    this.normalizeAll([l, r], peak)
    return { sr: this.sr, ch: [l, r] }
  }

  /**
   * Crossfades the tail of a bed onto its head so it loops without a seam.
   * Generate `duration + crossfade` seconds and pass it here.
   */
  loopable(channels: Float32Array[], crossfadeSeconds: number): Float32Array[] {
    const cn = this.n(crossfadeSeconds)
    const outLen = channels[0].length - cn
    if (outLen <= cn) return channels
    return channels.map((src) => {
      const out = src.slice(0, outLen)
      for (let i = 0; i < cn; i++) {
        const x = (i / cn) * Math.PI * 0.5
        out[i] = out[i] * Math.sin(x) + src[outLen + i] * Math.cos(x)
      }
      return out
    })
  }
}

function waveAt(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase)
    case 'tri': {
      const p = (phase / TAU) % 1
      return 4 * Math.abs(p - 0.5) - 1
    }
    case 'saw': {
      const p = (phase / TAU) % 1
      return p * 2 - 1
    }
    case 'square':
      return Math.sin(phase) >= 0 ? 1 : -1
  }
}
