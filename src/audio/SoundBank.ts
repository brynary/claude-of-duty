import { Rand } from '../core/Rand'
import type { Surface } from '../core/Types'
import { Synth, type Clip, type Mode, type Tap } from './Synth'

/**
 * Every sound in the game, authored procedurally.
 *
 * There are no audio files, so this file is the sample library. Sounds are
 * built incrementally — `step()` runs as many authoring tasks as fit in a
 * millisecond budget — so a full bank materialises over the first second of
 * play without ever costing a dropped frame.
 */

export type BusName = 'weapons' | 'world' | 'ambience' | 'ui'

export interface SoundDef {
  id: string
  /** Alternates picked at random per playback so repeats never phase-lock. */
  variants: Clip[]
  gain: number
  bus: BusName
  /** Metres over which the sound stays at full volume. */
  refDistance: number
  maxDistance: number
  rolloff: number
  loop: boolean
  /** Per-playback playback-rate jitter, as a fraction. */
  pitchJitter: number
  /** How much of this sound feeds the reverb send. */
  wet: number
  /** Higher survives voice stealing. */
  priority: number
}

interface DefOpts {
  gain?: number
  bus?: BusName
  refDistance?: number
  maxDistance?: number
  rolloff?: number
  loop?: boolean
  pitchJitter?: number
  wet?: number
  priority?: number
}

function def(id: string, variants: Clip[], o: DefOpts = {}): SoundDef {
  return {
    id,
    variants,
    gain: o.gain ?? 1,
    bus: o.bus ?? 'world',
    refDistance: o.refDistance ?? 3,
    maxDistance: o.maxDistance ?? 140,
    rolloff: o.rolloff ?? 1.1,
    loop: o.loop ?? false,
    pitchJitter: o.pitchJitter ?? 0.03,
    wet: o.wet ?? 0.4,
    priority: o.priority ?? 1,
  }
}

/** Shares another definition's PCM under a second name. */
function alias(id: string, src: SoundDef, o: DefOpts = {}): SoundDef {
  return { ...src, ...o, id }
}

type Task = () => SoundDef | SoundDef[]

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponClass = 'rifle' | 'smg' | 'sniper' | 'pistol' | 'shotgun' | 'lmg'

interface GunParams {
  dur: number
  /** Sub-millisecond spike. Without this a shot reads as a whoosh. */
  transient: number
  transientHp: number
  /** The muzzle blast proper: broadband, fast decay, downward spectral tilt. */
  crack: number
  crackTau: number
  crackHi: number
  crackLo: number
  crackPeak: number
  /** Chest punch. */
  body: number
  bodyF0: number
  bodyF1: number
  bodyTau: number
  sub: number
  subF0: number
  subF1: number
  subTau: number
  /** Bolt and carrier clatter riding on top of the blast. */
  mech: number
  mechModes: Mode[]
  tail: number
  tailTau: number
  tailLp: number
  drive: number
  taps: Tap[]
}

const BOLT_MODES: Mode[] = [
  { freq: 1180, decay: 0.021, gain: 0.5, drift: 0.03 },
  { freq: 2360, decay: 0.013, gain: 0.34 },
  { freq: 3720, decay: 0.009, gain: 0.24 },
  { freq: 5480, decay: 0.006, gain: 0.16 },
]

const GUNS: Record<WeaponClass, GunParams> = {
  rifle: {
    dur: 0.6, transient: 0.95, transientHp: 4200,
    crack: 1, crackTau: 0.0115, crackHi: 9200, crackLo: 1500, crackPeak: 2500,
    body: 0.78, bodyF0: 195, bodyF1: 62, bodyTau: 0.055,
    sub: 0.46, subF0: 96, subF1: 38, subTau: 0.09,
    mech: 0.22, mechModes: BOLT_MODES,
    tail: 0.22, tailTau: 0.09, tailLp: 3400, drive: 2.4,
    taps: [{ t: 0.031, g: 0.2, lp: 2600 }, { t: 0.063, g: 0.12, lp: 1700 }, { t: 0.108, g: 0.07, lp: 1100 }],
  },
  smg: {
    dur: 0.42, transient: 0.9, transientHp: 5400,
    crack: 0.92, crackTau: 0.0072, crackHi: 10800, crackLo: 2200, crackPeak: 3200,
    body: 0.5, bodyF0: 168, bodyF1: 72, bodyTau: 0.034,
    sub: 0.2, subF0: 88, subF1: 46, subTau: 0.05,
    mech: 0.38, mechModes: BOLT_MODES,
    tail: 0.15, tailTau: 0.055, tailLp: 4200, drive: 2,
    taps: [{ t: 0.026, g: 0.17, lp: 3000 }, { t: 0.055, g: 0.09, lp: 1900 }],
  },
  sniper: {
    dur: 1.35, transient: 1, transientHp: 3100,
    crack: 1, crackTau: 0.027, crackHi: 8400, crackLo: 880, crackPeak: 1600,
    body: 1, bodyF0: 152, bodyF1: 42, bodyTau: 0.135,
    sub: 0.88, subF0: 78, subF1: 26, subTau: 0.25,
    mech: 0.16, mechModes: BOLT_MODES,
    tail: 0.46, tailTau: 0.4, tailLp: 2100, drive: 3,
    taps: [
      { t: 0.045, g: 0.28, lp: 2200 }, { t: 0.097, g: 0.2, lp: 1500 },
      { t: 0.174, g: 0.13, lp: 1000 }, { t: 0.295, g: 0.08, lp: 700 },
    ],
  },
  pistol: {
    dur: 0.44, transient: 0.88, transientHp: 4800,
    crack: 0.9, crackTau: 0.0092, crackHi: 9800, crackLo: 1950, crackPeak: 2900,
    body: 0.56, bodyF0: 178, bodyF1: 66, bodyTau: 0.04,
    sub: 0.26, subF0: 92, subF1: 42, subTau: 0.06,
    mech: 0.32, mechModes: BOLT_MODES,
    tail: 0.17, tailTau: 0.07, tailLp: 3600, drive: 2.1,
    taps: [{ t: 0.029, g: 0.18, lp: 2800 }, { t: 0.06, g: 0.1, lp: 1800 }],
  },
  shotgun: {
    dur: 0.95, transient: 0.85, transientHp: 2600,
    crack: 1, crackTau: 0.035, crackHi: 6600, crackLo: 700, crackPeak: 1200,
    body: 0.98, bodyF0: 142, bodyF1: 45, bodyTau: 0.115,
    sub: 0.72, subF0: 84, subF1: 30, subTau: 0.17,
    mech: 0.2, mechModes: BOLT_MODES,
    tail: 0.34, tailTau: 0.19, tailLp: 2400, drive: 2.8,
    taps: [{ t: 0.038, g: 0.24, lp: 2200 }, { t: 0.081, g: 0.15, lp: 1400 }, { t: 0.15, g: 0.08, lp: 900 }],
  },
  lmg: {
    dur: 0.72, transient: 0.95, transientHp: 3800,
    crack: 1, crackTau: 0.0155, crackHi: 8600, crackLo: 1250, crackPeak: 2100,
    body: 0.92, bodyF0: 180, bodyF1: 54, bodyTau: 0.075,
    sub: 0.6, subF0: 88, subF1: 32, subTau: 0.12,
    mech: 0.28, mechModes: BOLT_MODES,
    tail: 0.28, tailTau: 0.13, tailLp: 3000, drive: 2.6,
    taps: [{ t: 0.034, g: 0.22, lp: 2400 }, { t: 0.07, g: 0.13, lp: 1600 }, { t: 0.125, g: 0.075, lp: 1000 }],
  },
}

/**
 * A gunshot is five overlapping events, not one sound:
 *   0.0 ms  a near-instant spike as the muzzle uncorks
 *   0.5 ms  the blast — broadband, saturated, spectrum collapsing downward
 *   1.0 ms  a pitch-dropping low body that you feel more than hear
 *   2.0 ms  the action cycling, bright and metallic
 *  10.0 ms  a short tail plus the first wall reflections
 * Getting the relative timing right matters more than any single layer.
 */
function gunshot(s: Synth, p: GunParams): Clip {
  const out = s.buf(p.dur)

  const spike = s.buf(0.007)
  s.white(spike, 1)
  s.envAD(spike, 0.00004, 0.0009, 1)
  s.filt(spike, 'highpass', p.transientHp, 0.62)
  s.filt(spike, 'peaking', p.transientHp * 1.7, 1.4, 6)
  s.mixInto(out, spike, 0, p.transient)

  const crack = s.buf(Math.min(p.dur, p.crackTau * 14 + 0.06))
  s.white(crack, 1)
  s.sweep(crack, 'lowpass', p.crackHi, p.crackLo, 0.72, p.crackTau * 9)
  s.filt(crack, 'highpass', 165, 0.6)
  s.filt(crack, 'peaking', p.crackPeak, 1.1, 5.5)
  s.filt(crack, 'peaking', p.crackPeak * 0.32, 0.9, 3)
  s.envAD(crack, 0.00035, p.crackTau, 1.15)
  s.saturate(crack, p.drive, 0.85)
  s.mixInto(out, crack, s.n(0.0006), p.crack)

  const body = s.buf(Math.min(p.dur, p.bodyTau * 8 + 0.05))
  s.chirp(body, 0, Math.min(body.length / s.sr, p.bodyTau * 4), p.bodyF0, p.bodyF1, 1, 'sine')
  s.envAD(body, 0.0009, p.bodyTau, 1)
  s.saturate(body, 2.2, 0.55)
  s.mixInto(out, body, s.n(0.0009), p.body)

  const sub = s.buf(Math.min(p.dur, p.subTau * 8 + 0.05))
  s.chirp(sub, 0, Math.min(sub.length / s.sr, p.subTau * 5), p.subF0, p.subF1, 1, 'sine')
  s.envAD(sub, 0.0022, p.subTau, 1)
  s.mixInto(out, sub, s.n(0.0016), p.sub)

  const mech = s.buf(0.13)
  s.modal(mech, 0, p.mechModes)
  s.white(mech, 0.5, 0, s.n(0.003))
  s.filt(mech, 'highpass', 700, 0.7)
  s.envAD(mech, 0.0002, 0.016, 1)
  s.mixInto(out, mech, s.n(0.0022), p.mech)

  const tail = s.buf(Math.max(p.dur * 0.85, 0.1))
  s.white(tail, 1)
  s.filt(tail, 'lowpass', p.tailLp, 0.7)
  s.filt(tail, 'highpass', 110, 0.7)
  s.envAD(tail, 0.0045, p.tailTau, 1)
  s.mixInto(out, tail, s.n(0.008), p.tail)

  s.taps(out, p.taps)
  s.dcBlock(out)
  s.clipTo(out, 1.35)
  return s.widen(out, 0.00035, 0.08, 0.96)
}

/**
 * The same shot heard from hundreds of metres. The transient is gone — air
 * eats it — leaving a soft thump wrapped in a long, diffuse tail. This is the
 * single most effective cue for the size of a battlefield.
 *
 * Nothing here survives above 3 kHz, so it is synthesised at half the mix rate
 * and left for the browser to resample: half the memory, half the build cost,
 * no audible difference.
 */
function distantShot(s: Synth, p: GunParams, scale: number): Clip {
  const dur = 1.1 + scale * 1.3
  const out = s.buf(dur)

  const thump = s.buf(0.35)
  s.white(thump, 1)
  s.sweep(thump, 'lowpass', 1500 * scale, 380 * scale, 1.1, 0.06)
  s.filt(thump, 'highpass', 70, 0.7)
  s.filt(thump, 'peaking', 320 * scale, 1.5, 6)
  s.envAD(thump, 0.0035, 0.03 + 0.03 * scale, 1)
  s.mixInto(out, thump, 0, 0.9)

  const low = s.buf(0.4)
  s.chirp(low, 0, 0.2, 130 * scale, 52 * scale, 1, 'sine')
  s.envAD(low, 0.004, 0.06 * scale, 1)
  s.mixInto(out, low, s.n(0.004), 0.55)

  // Staggered diffuse layers: the report arriving off nearer, then more
  // distant surfaces, each darker and longer than the last.
  const layers: [number, number, number][] = [
    [0.03, 700 * scale, 0.24 * scale],
    [0.14, 1500 * scale, 0.85 * scale],
  ]
  for (const [at, lp, tau] of layers) {
    const l = s.buf(dur - at)
    s.white(l, 1)
    s.filt(l, 'lowpass', lp, 0.6)
    s.filt(l, 'lowpass', lp * 1.4, 0.6)
    s.filt(l, 'highpass', 95, 0.7)
    s.envAD(l, 0.012 + at * 0.5, tau, 1)
    s.mixInto(out, l, s.n(at), 0.4)
  }

  s.taps(out, [
    { t: 0.09, g: 0.34, lp: 900 },
    { t: 0.23, g: 0.16, lp: 560 },
  ])
  s.filt(out, 'lowpass', 2600 * scale, 0.6)
  s.dcBlock(out)
  s.fadeOut(out, 0.25)
  s.normalize(out, 0.85)
  return s.mono(out)
}

/** A wall reflection of a nearby shot, played from a point in the world. */
function shotReflection(s: Synth, heavy: boolean): Clip {
  const out = s.buf(heavy ? 0.75 : 0.42)
  s.white(out, 1)
  s.sweep(out, 'lowpass', heavy ? 3200 : 4200, heavy ? 700 : 1100, 0.7, 0.09)
  s.filt(out, 'highpass', 140, 0.7)
  s.filt(out, 'peaking', heavy ? 480 : 900, 1.2, 5)
  s.envAD(out, 0.0025, heavy ? 0.1 : 0.05, 1)
  s.taps(out, [{ t: 0.026, g: 0.3, lp: 1800 }, { t: 0.058, g: 0.16, lp: 1200 }])
  s.dcBlock(out)
  s.normalize(out, 0.8)
  return s.mono(out)
}

/** Suppressed fire: gas hiss, a soft thump and a very loud action. */
function suppressedShot(s: Synth): Clip {
  const out = s.buf(0.34)

  const hiss = s.buf(0.16)
  s.white(hiss, 1)
  s.sweep(hiss, 'bandpass', 3800, 1400, 1.2, 0.05)
  s.envAD(hiss, 0.0006, 0.024, 1)
  s.mixInto(out, hiss, 0, 0.75)

  const thump = s.buf(0.18)
  s.chirp(thump, 0, 0.08, 210, 78, 1, 'sine')
  s.envAD(thump, 0.0012, 0.03, 1)
  s.mixInto(out, thump, s.n(0.001), 0.5)

  const mech = s.buf(0.13)
  s.modal(mech, 0, [
    { freq: 1320, decay: 0.026, gain: 0.6, drift: 0.04 },
    { freq: 2480, decay: 0.017, gain: 0.42 },
    { freq: 4100, decay: 0.011, gain: 0.3 },
    { freq: 6300, decay: 0.007, gain: 0.2 },
  ])
  s.white(mech, 0.6, 0, s.n(0.004))
  s.filt(mech, 'highpass', 900, 0.7)
  s.envAD(mech, 0.0002, 0.02, 1)
  s.mixInto(out, mech, s.n(0.004), 0.85)

  s.dcBlock(out)
  return s.widen(out, 0.0004, 0.1, 0.85)
}

// --- mechanical foley ------------------------------------------------------

interface ClackParams {
  modes: Mode[]
  clickHp: number
  clickTau: number
  clickGain: number
  thump?: number
  thumpF?: number
  scrape?: number
  scrapeDur?: number
  scrapeF?: number
  dur: number
}

/**
 * Metal on metal: an optional spring scrape leading into a bright noise click
 * that excites a short modal body. The scrape-then-clack ordering is what makes
 * a magazine seating read as mechanical rather than as a generic tick.
 */
function clack(s: Synth, p: ClackParams): Clip {
  const out = s.buf(p.dur)
  const scrapeDur = p.scrape ? p.scrapeDur ?? 0.07 : 0
  // The body lands near the end of the scrape, not after it.
  const at = scrapeDur * 0.72

  if (p.scrape) {
    const sc = s.buf(scrapeDur)
    s.white(sc, 1)
    s.filt(sc, 'bandpass', p.scrapeF ?? 2600, 2.4)
    s.comb(sc, 1 / (p.scrapeF ?? 2600), 0.4)
    s.envCurve(sc, [[0, 0], [scrapeDur * 0.25, 1], [scrapeDur * 0.8, 0.5], [scrapeDur, 0]])
    s.mixInto(out, sc, 0, p.scrape)
  }

  const click = s.buf(0.012)
  s.white(click, 1)
  s.envAD(click, 0.00006, p.clickTau, 1)
  s.filt(click, 'highpass', p.clickHp, 0.7)
  s.mixInto(out, click, s.n(at), p.clickGain)

  s.modal(out, at + 0.0004, p.modes)

  if (p.thump) {
    const t = s.buf(0.09)
    s.chirp(t, 0, 0.045, (p.thumpF ?? 150) * 1.6, p.thumpF ?? 150, 1, 'sine')
    s.envAD(t, 0.0012, 0.024, 1)
    s.mixInto(out, t, s.n(at), p.thump)
  }

  s.dcBlock(out)
  return s.widen(out, 0.0003, 0.05, 0.9)
}

// --- footsteps -------------------------------------------------------------

interface StepParams {
  dur: number
  thump: number
  thumpF: number
  thumpTau: number
  scuff: number
  scuffHp: number
  scuffLp: number
  scuffTau: number
  grains: number
  grainLo: number
  grainHi: number
  grainGain: number
  modes?: Mode[]
  modeGain?: number
  hollow?: number
}

const STEPS: Record<string, StepParams> = {
  concrete: {
    dur: 0.3, thump: 0.6, thumpF: 96, thumpTau: 0.028,
    scuff: 0.52, scuffHp: 950, scuffLp: 7200, scuffTau: 0.021,
    grains: 3, grainLo: 1600, grainHi: 5200, grainGain: 0.1,
  },
  dirt: {
    dur: 0.32, thump: 0.52, thumpF: 72, thumpTau: 0.045,
    scuff: 0.44, scuffHp: 300, scuffLp: 2600, scuffTau: 0.05,
    grains: 7, grainLo: 240, grainHi: 1700, grainGain: 0.14,
  },
  sand: {
    dur: 0.34, thump: 0.24, thumpF: 82, thumpTau: 0.03,
    scuff: 0.6, scuffHp: 1700, scuffLp: 9500, scuffTau: 0.085,
    grains: 5, grainLo: 2600, grainHi: 8000, grainGain: 0.09,
  },
  gravel: {
    dur: 0.36, thump: 0.4, thumpF: 88, thumpTau: 0.03,
    scuff: 0.3, scuffHp: 700, scuffLp: 6000, scuffTau: 0.03,
    grains: 18, grainLo: 700, grainHi: 5600, grainGain: 0.26,
  },
  wood: {
    dur: 0.36, thump: 0.55, thumpF: 108, thumpTau: 0.04,
    scuff: 0.3, scuffHp: 750, scuffLp: 5200, scuffTau: 0.024,
    grains: 2, grainLo: 900, grainHi: 3400, grainGain: 0.07,
    modes: [
      { freq: 188, decay: 0.09, gain: 0.5 }, { freq: 331, decay: 0.07, gain: 0.3 },
      { freq: 624, decay: 0.05, gain: 0.2 }, { freq: 1082, decay: 0.03, gain: 0.12 },
    ],
    modeGain: 0.5,
  },
  tile: {
    dur: 0.3, thump: 0.36, thumpF: 128, thumpTau: 0.02,
    scuff: 0.5, scuffHp: 1800, scuffLp: 11000, scuffTau: 0.016,
    grains: 3, grainLo: 2600, grainHi: 7800, grainGain: 0.1,
    modes: [
      { freq: 2380, decay: 0.05, gain: 0.3 }, { freq: 3760, decay: 0.035, gain: 0.2 },
      { freq: 5900, decay: 0.022, gain: 0.12 },
    ],
    modeGain: 0.35,
  },
  metal: {
    dur: 0.5, thump: 0.42, thumpF: 118, thumpTau: 0.024,
    scuff: 0.38, scuffHp: 1400, scuffLp: 9000, scuffTau: 0.018,
    grains: 2, grainLo: 2000, grainHi: 6000, grainGain: 0.08,
    modes: [
      { freq: 972, decay: 0.17, gain: 0.42, drift: 0.015 },
      { freq: 1718, decay: 0.13, gain: 0.3 },
      { freq: 2964, decay: 0.1, gain: 0.22 },
      { freq: 4710, decay: 0.07, gain: 0.14 },
      { freq: 6320, decay: 0.05, gain: 0.09 },
    ],
    modeGain: 0.55,
    hollow: 0.0043,
  },
  water: {
    dur: 0.45, thump: 0.3, thumpF: 90, thumpTau: 0.03,
    scuff: 0.7, scuffHp: 400, scuffLp: 5200, scuffTau: 0.07,
    grains: 0, grainLo: 900, grainHi: 3000, grainGain: 0,
  },
  foliage: {
    dur: 0.4, thump: 0.18, thumpF: 70, thumpTau: 0.03,
    scuff: 0.4, scuffHp: 1500, scuffLp: 9000, scuffTau: 0.08,
    grains: 16, grainLo: 1800, grainHi: 8500, grainGain: 0.16,
  },
}

function footstep(s: Synth, p: StepParams, running: boolean): Clip {
  const out = s.buf(p.dur)
  const heel = running ? 1.35 : 1
  const r = s.rng

  const thump = s.buf(0.14)
  s.chirp(thump, 0, 0.06, p.thumpF * r.range(1.5, 1.9), p.thumpF * r.range(0.9, 1.1), 1, 'sine')
  s.envAD(thump, 0.0016, p.thumpTau * (running ? 1.25 : 1), 1)
  s.saturate(thump, 1.6, 0.4)
  s.mixInto(out, thump, 0, p.thump * heel)

  const scuff = s.buf(Math.min(p.dur, p.scuffTau * 8 + 0.04))
  s.white(scuff, 1)
  s.filt(scuff, 'highpass', p.scuffHp * r.range(0.88, 1.14), 0.7)
  s.filt(scuff, 'lowpass', p.scuffLp * r.range(0.9, 1.12), 0.7)
  s.envAD(scuff, running ? 0.0004 : 0.0012, p.scuffTau * (running ? 0.8 : 1), 1)
  s.mixInto(out, scuff, s.n(running ? 0.0008 : 0.003), p.scuff * (running ? 1.15 : 1))

  if (p.grains > 0) {
    s.grainCloud(out, Math.round(p.grains * (running ? 1.3 : 1)), 0.001, p.dur * 0.55,
      p.grainLo, p.grainHi, p.grainGain, 7, 2.4)
  }

  if (p.modes) {
    const body = s.buf(p.dur)
    s.modal(body, 0, p.modes.map((m) => ({ ...m, freq: m.freq * r.range(0.96, 1.05) })))
    if (p.hollow) s.comb(body, p.hollow, 0.35)
    s.envAD(body, 0.0004, 0.14, 1)
    s.mixInto(out, body, s.n(0.0012), (p.modeGain ?? 0.4) * heel)
  }

  s.dcBlock(out)
  s.normalize(out, running ? 0.9 : 0.72)
  return s.mono(out)
}

// --- impacts ---------------------------------------------------------------

interface ImpactParams {
  dur: number
  /** Bullet strike transient. */
  snap: number
  snapHp: number
  snapTau: number
  thump: number
  thumpF: number
  thumpTau: number
  puff: number
  puffLp: number
  puffTau: number
  grains: number
  grainLo: number
  grainHi: number
  grainGain: number
  grainSpread: number
  modes?: Mode[]
  modeGain?: number
  comb?: number
  wet?: number
}

const IMPACTS: Record<Surface, ImpactParams> = {
  concrete: {
    dur: 0.5, snap: 0.9, snapHp: 3200, snapTau: 0.0035,
    thump: 0.5, thumpF: 128, thumpTau: 0.028,
    puff: 0.34, puffLp: 1100, puffTau: 0.075,
    grains: 12, grainLo: 900, grainHi: 6000, grainGain: 0.18, grainSpread: 0.22,
  },
  plaster: {
    dur: 0.45, snap: 0.7, snapHp: 2600, snapTau: 0.004,
    thump: 0.42, thumpF: 150, thumpTau: 0.022,
    puff: 0.5, puffLp: 1600, puffTau: 0.09,
    grains: 14, grainLo: 700, grainHi: 4200, grainGain: 0.15, grainSpread: 0.25,
  },
  tile: {
    dur: 0.55, snap: 1, snapHp: 4200, snapTau: 0.003,
    thump: 0.3, thumpF: 190, thumpTau: 0.016,
    puff: 0.16, puffLp: 2200, puffTau: 0.04,
    grains: 20, grainLo: 2200, grainHi: 9500, grainGain: 0.24, grainSpread: 0.3,
    modes: [{ freq: 2650, decay: 0.05, gain: 0.3 }, { freq: 4300, decay: 0.03, gain: 0.2 }],
    modeGain: 0.35,
  },
  metal: {
    dur: 0.8, snap: 1, snapHp: 3600, snapTau: 0.0028,
    thump: 0.32, thumpF: 165, thumpTau: 0.018,
    puff: 0.08, puffLp: 3000, puffTau: 0.03,
    grains: 4, grainLo: 3000, grainHi: 9000, grainGain: 0.1, grainSpread: 0.12,
    modes: [
      { freq: 1420, decay: 0.22, gain: 0.5, drift: 0.02 },
      { freq: 2380, decay: 0.17, gain: 0.36 },
      { freq: 3910, decay: 0.12, gain: 0.26 },
      { freq: 5760, decay: 0.09, gain: 0.18 },
      { freq: 8100, decay: 0.06, gain: 0.1 },
    ],
    modeGain: 0.65,
  },
  thinMetal: {
    dur: 1.1, snap: 1, snapHp: 2800, snapTau: 0.0032,
    thump: 0.5, thumpF: 128, thumpTau: 0.03,
    puff: 0.06, puffLp: 2400, puffTau: 0.03,
    grains: 3, grainLo: 2400, grainHi: 8000, grainGain: 0.08, grainSpread: 0.1,
    modes: [
      { freq: 268, decay: 0.42, gain: 0.5, drift: 0.06 },
      { freq: 447, decay: 0.36, gain: 0.38, drift: 0.05 },
      { freq: 712, decay: 0.3, gain: 0.3 },
      { freq: 1180, decay: 0.24, gain: 0.22 },
      { freq: 1940, decay: 0.17, gain: 0.15 },
      { freq: 3260, decay: 0.11, gain: 0.09 },
    ],
    modeGain: 0.8,
    comb: 0.0071,
    wet: 0.55,
  },
  wood: {
    dur: 0.55, snap: 0.85, snapHp: 2400, snapTau: 0.0035,
    thump: 0.55, thumpF: 112, thumpTau: 0.03,
    puff: 0.14, puffLp: 1400, puffTau: 0.05,
    grains: 16, grainLo: 800, grainHi: 5200, grainGain: 0.2, grainSpread: 0.26,
    modes: [
      { freq: 214, decay: 0.11, gain: 0.4 }, { freq: 386, decay: 0.09, gain: 0.28 },
      { freq: 703, decay: 0.06, gain: 0.18 }, { freq: 1290, decay: 0.04, gain: 0.11 },
    ],
    modeGain: 0.5,
  },
  dirt: {
    dur: 0.45, snap: 0.4, snapHp: 1600, snapTau: 0.005,
    thump: 0.7, thumpF: 78, thumpTau: 0.04,
    puff: 0.5, puffLp: 900, puffTau: 0.1,
    grains: 10, grainLo: 300, grainHi: 2400, grainGain: 0.14, grainSpread: 0.28,
  },
  sand: {
    dur: 0.5, snap: 0.3, snapHp: 2200, snapTau: 0.006,
    thump: 0.55, thumpF: 70, thumpTau: 0.035,
    puff: 0.72, puffLp: 2600, puffTau: 0.14,
    grains: 8, grainLo: 1800, grainHi: 7000, grainGain: 0.1, grainSpread: 0.3,
  },
  gravel: {
    dur: 0.55, snap: 0.55, snapHp: 2400, snapTau: 0.004,
    thump: 0.5, thumpF: 90, thumpTau: 0.03,
    puff: 0.3, puffLp: 1600, puffTau: 0.07,
    grains: 26, grainLo: 700, grainHi: 6500, grainGain: 0.28, grainSpread: 0.34,
  },
  glass: {
    dur: 0.9, snap: 1, snapHp: 5200, snapTau: 0.0022,
    thump: 0.12, thumpF: 240, thumpTau: 0.012,
    puff: 0.06, puffLp: 5000, puffTau: 0.02,
    grains: 60, grainLo: 2800, grainHi: 13000, grainGain: 0.3, grainSpread: 0.55,
    modes: [
      { freq: 3180, decay: 0.16, gain: 0.3 }, { freq: 5230, decay: 0.12, gain: 0.22 },
      { freq: 7940, decay: 0.09, gain: 0.15 }, { freq: 11200, decay: 0.06, gain: 0.09 },
    ],
    modeGain: 0.4,
    wet: 0.5,
  },
  flesh: {
    dur: 0.4, snap: 0.5, snapHp: 900, snapTau: 0.005,
    thump: 0.85, thumpF: 96, thumpTau: 0.035,
    puff: 0.6, puffLp: 1800, puffTau: 0.035,
    grains: 5, grainLo: 300, grainHi: 1600, grainGain: 0.12, grainSpread: 0.1,
    wet: 0.2,
  },
  water: {
    dur: 0.7, snap: 0.45, snapHp: 1400, snapTau: 0.006,
    thump: 0.35, thumpF: 110, thumpTau: 0.03,
    puff: 0.8, puffLp: 4200, puffTau: 0.12,
    grains: 22, grainLo: 900, grainHi: 5200, grainGain: 0.16, grainSpread: 0.38,
  },
  fabric: {
    dur: 0.35, snap: 0.35, snapHp: 1200, snapTau: 0.005,
    thump: 0.6, thumpF: 84, thumpTau: 0.03,
    puff: 0.42, puffLp: 1200, puffTau: 0.06,
    grains: 6, grainLo: 400, grainHi: 2600, grainGain: 0.1, grainSpread: 0.2,
  },
  rubber: {
    dur: 0.3, snap: 0.4, snapHp: 1100, snapTau: 0.004,
    thump: 0.7, thumpF: 118, thumpTau: 0.022,
    puff: 0.18, puffLp: 700, puffTau: 0.035,
    grains: 3, grainLo: 500, grainHi: 2000, grainGain: 0.07, grainSpread: 0.12,
  },
  foliage: {
    dur: 0.45, snap: 0.3, snapHp: 2600, snapTau: 0.005,
    thump: 0.12, thumpF: 90, thumpTau: 0.02,
    puff: 0.3, puffLp: 6000, puffTau: 0.09,
    grains: 34, grainLo: 1600, grainHi: 10000, grainGain: 0.2, grainSpread: 0.32,
  },
}

function impact(s: Synth, p: ImpactParams): Clip {
  const out = s.buf(p.dur)
  const r = s.rng

  const snap = s.buf(0.02)
  s.white(snap, 1)
  s.envAD(snap, 0.00005, p.snapTau, 1)
  s.filt(snap, 'highpass', p.snapHp * r.range(0.9, 1.12), 0.65)
  s.mixInto(out, snap, 0, p.snap)

  const thump = s.buf(0.16)
  s.chirp(thump, 0, 0.07, p.thumpF * 2.1, p.thumpF, 1, 'sine')
  s.envAD(thump, 0.0009, p.thumpTau, 1)
  s.saturate(thump, 1.8, 0.5)
  s.mixInto(out, thump, s.n(0.0004), p.thump)

  if (p.puff > 0) {
    const puff = s.buf(Math.min(p.dur, p.puffTau * 7 + 0.03))
    s.white(puff, 1)
    s.sweep(puff, 'lowpass', p.puffLp * 2.2, p.puffLp * 0.6, 0.7, p.puffTau * 3)
    s.filt(puff, 'highpass', 160, 0.7)
    s.envAD(puff, 0.002, p.puffTau, 1)
    s.mixInto(out, puff, s.n(0.0016), p.puff)
  }

  if (p.grains > 0) {
    s.grainCloud(out, p.grains, 0.002, p.grainSpread, p.grainLo, p.grainHi, p.grainGain, 8, 2.2)
  }

  if (p.modes) {
    const body = s.buf(p.dur)
    s.modal(body, 0, p.modes.map((m) => ({ ...m, freq: m.freq * r.range(0.95, 1.07) })))
    if (p.comb) s.comb(body, p.comb, 0.42)
    s.envAD(body, 0.0003, p.dur * 0.4, 1)
    s.mixInto(out, body, s.n(0.0006), p.modeGain ?? 0.5)
  }

  s.dcBlock(out)
  s.normalize(out, 0.9)
  return s.mono(out)
}

/** Deflected round: a hard tick followed by a falling resonant whine. */
function ricochet(s: Synth): Clip {
  const r = s.rng
  const dur = r.range(0.4, 0.75)
  const out = s.buf(dur)

  const tick = s.buf(0.015)
  s.white(tick, 1)
  s.envAD(tick, 0.00005, 0.0026, 1)
  s.filt(tick, 'highpass', 3200, 0.7)
  s.mixInto(out, tick, 0, 0.85)

  const f0 = r.range(2400, 3600)
  const f1 = f0 * r.range(0.16, 0.3)
  const whine = s.buf(dur)
  s.chirp(whine, 0, dur * 0.9, f0, f1, 0.55, 'sine', 0.035, r.range(28, 60))
  s.chirp(whine, 0.001, dur * 0.9, f0 * 2.01, f1 * 2.01, 0.16, 'sine', 0.035, r.range(28, 60))
  s.envCurve(whine, [[0, 0], [0.004, 1], [dur * 0.4, 0.45], [dur, 0]])
  s.mixInto(out, whine, s.n(0.0015), 1)

  const air = s.buf(dur * 0.5)
  s.white(air, 1)
  s.sweep(air, 'bandpass', f0 * 1.2, f1 * 1.6, 4, dur * 0.4)
  s.envAD(air, 0.001, dur * 0.12, 1)
  s.mixInto(out, air, s.n(0.001), 0.3)

  s.dcBlock(out)
  s.normalize(out, 0.85)
  return s.mono(out)
}

/** Round passing close by: a short doppler-shaped hiss. */
function whizby(s: Synth): Clip {
  const r = s.rng
  const dur = r.range(0.07, 0.14)
  const out = s.buf(dur)
  s.white(out, 1)
  s.sweep(out, 'bandpass', r.range(2600, 4200), r.range(500, 900), 1.6, dur)
  s.envCurve(out, [[0, 0], [dur * 0.35, 1], [dur, 0]])
  s.filt(out, 'highpass', 260, 0.7)
  s.dcBlock(out)
  s.normalize(out, 0.8)
  return s.mono(out)
}

/** The supersonic N-wave: two shock edges a fraction of a millisecond apart. */
function supersonicCrack(s: Synth): Clip {
  const out = s.buf(0.12)
  const a = s.buf(0.006)
  s.white(a, 1)
  s.envAD(a, 0.00003, 0.0007, 1)
  s.filt(a, 'highpass', 4200, 0.7)
  s.mixInto(out, a, 0, 1)
  s.mixInto(out, a, s.n(0.0009), -0.7)
  const body = s.buf(0.06)
  s.white(body, 1)
  s.sweep(body, 'lowpass', 9000, 1400, 0.8, 0.02)
  s.envAD(body, 0.0002, 0.0075, 1)
  s.mixInto(out, body, s.n(0.0004), 0.7)
  s.saturate(out, 2.2, 0.6)
  s.dcBlock(out)
  s.normalize(out, 0.95)
  return s.mono(out)
}

// --- explosions ------------------------------------------------------------

function explosion(s: Synth, size: number): Clip {
  const dur = 1.8 + size * 1.7
  const out = s.buf(dur)

  // Sub: the pressure wave. Below 40 Hz you feel it more than hear it.
  const sub = s.buf(1.4)
  s.chirp(sub, 0, 0.9, 62 * size, 21 * size, 1, 'sine')
  s.envAD(sub, 0.006, 0.28 * size, 1)
  s.saturate(sub, 2.4, 0.5)
  s.mixInto(out, sub, 0, 1)

  // Blast: broadband, hard-driven, spectrum collapsing fast.
  const blast = s.buf(1)
  s.white(blast, 1)
  s.sweep(blast, 'lowpass', 7000, 260, 0.8, 0.22)
  s.filt(blast, 'highpass', 45, 0.7)
  s.filt(blast, 'peaking', 140, 1.1, 6)
  s.envAD(blast, 0.0012, 0.16 * size, 1.1)
  s.saturate(blast, 3.4, 0.9)
  s.mixInto(out, blast, s.n(0.0008), 0.95)

  // Crack: the leading edge, only for the first few milliseconds.
  const crack = s.buf(0.06)
  s.white(crack, 1)
  s.envAD(crack, 0.00006, 0.004, 1)
  s.filt(crack, 'highpass', 2600, 0.7)
  s.mixInto(out, crack, 0, 0.5)

  // Debris rain: grains thinning out over a couple of seconds.
  s.grainCloud(out, Math.round(70 * size), 0.12, dur * 0.75, 500, 6500, 0.16, 9, 1.5)

  // Tail: the report rolling around the buildings.
  const tail = s.buf(dur * 0.9)
  s.white(tail, 1)
  s.filt(tail, 'lowpass', 1500, 0.6)
  s.filt(tail, 'lowpass', 900, 0.6)
  s.filt(tail, 'highpass', 70, 0.7)
  s.envAD(tail, 0.05, 0.75 * size, 1)
  s.mixInto(out, tail, s.n(0.02), 0.45)

  s.taps(out, [
    { t: 0.11, g: 0.32, lp: 1400 },
    { t: 0.26, g: 0.19, lp: 850 },
    { t: 0.5, g: 0.1, lp: 560 },
  ])
  s.dcBlock(out)
  s.clipTo(out, 1.4)
  s.fadeOut(out, 0.3)
  return s.widen(out, 0.0018, 0.03, 0.98)
}

function debrisRain(s: Synth): Clip {
  const out = s.buf(2.4)
  s.grainCloud(out, 130, 0.02, 2.1, 400, 7000, 0.22, 10, 1.4)
  s.filt(out, 'highpass', 220, 0.7)
  s.dcBlock(out)
  s.fadeOut(out, 0.4)
  s.normalize(out, 0.6)
  return s.mono(out)
}

// --- ambience --------------------------------------------------------------

/** Seconds of continuous bed, plus the crossfade that makes it loop. */
const BED_SECONDS = 6
const BED_CROSSFADE = 1.5

/** One channel of wind: brown noise through a slowly wandering resonant band. */
function windChannel(s: Synth): Float32Array {
  const total = BED_SECONDS + BED_CROSSFADE
  const buf = s.buf(total)
  s.brown(buf, 1)
  s.filt(buf, 'lowpass', 900, 0.6)
  s.filt(buf, 'highpass', 45, 0.6)

  // Gusts: a slow random walk driving both level and the resonant whistle.
  const n = buf.length
  const gust = new Float32Array(n)
  let g = 0.5
  let v = 0
  for (let i = 0; i < n; i++) {
    v += (s.rng.next() - 0.5) * 0.00022
    v *= 0.9995
    g += v
    if (g < 0.18) { g = 0.18; v = Math.abs(v) }
    if (g > 1) { g = 1; v = -Math.abs(v) }
    gust[i] = g
  }

  const band = buf.slice()
  s.sweep(band, 'bandpass', 380, 1500, 2.2, total * 0.5)
  for (let i = 0; i < n; i++) buf[i] = buf[i] * (0.45 + gust[i] * 0.75) + band[i] * gust[i] * 0.5

  // A little air on top so it is not purely low-frequency rumble.
  const hiss = s.buf(total)
  s.pink(hiss, 1)
  s.filt(hiss, 'highpass', 2200, 0.6)
  s.filt(hiss, 'lowpass', 8000, 0.6)
  for (let i = 0; i < n; i++) buf[i] += hiss[i] * 0.1 * gust[i]

  s.dcBlock(buf)
  return buf
}

/** One channel of distant city: traffic rumble, mains hum, unresolved haze. */
function cityChannel(s: Synth): Float32Array {
  const total = BED_SECONDS + BED_CROSSFADE
  const buf = s.buf(total)
  s.brown(buf, 0.9)
  s.filt(buf, 'lowpass', 260, 0.7)
  s.filt(buf, 'highpass', 32, 0.7)

  const mid = s.buf(total)
  s.pink(mid, 1)
  s.filt(mid, 'bandpass', 700, 0.5)
  s.envCurve(mid, [[0, 0.6], [total * 0.5, 1], [total, 0.6]])
  for (let i = 0; i < buf.length; i++) buf[i] += mid[i] * 0.22

  s.tone(buf, 0, total, 50, 0.012)
  s.tone(buf, 0, total, 150, 0.006)

  for (let i = 0; i < 7; i++) {
    const t = s.rng.range(0.2, BED_SECONDS - 0.5)
    const ev = s.buf(s.rng.range(0.6, 1.8))
    s.white(ev, 1)
    s.filt(ev, 'lowpass', s.rng.range(400, 1400), 0.7)
    s.envCurve(ev, [[0, 0], [0.2, 1], [ev.length / s.sr, 0]])
    s.mixInto(buf, ev, s.n(t), s.rng.range(0.05, 0.15))
  }

  s.dcBlock(buf)
  return buf
}

function assembleBed(s: Synth, channels: Float32Array[], peak: number): Clip {
  const looped = s.loopable(channels, BED_CROSSFADE)
  s.normalizeAll(looped, peak)
  return { sr: s.sr, ch: looped }
}

function dogBark(s: Synth): Clip {
  const r = s.rng
  const out = s.buf(1.5)
  const barks = r.int(2, 4)
  let t = 0
  for (let i = 0; i < barks; i++) {
    const f = r.range(190, 300)
    const b = s.buf(0.22)
    s.chirp(b, 0, 0.13, f * 1.5, f * 0.72, 0.7, 'saw')
    s.white(b, 0.35)
    s.filt(b, 'bandpass', r.range(600, 1100), 1.3)
    s.resonate(b, r.range(1500, 2400), 3, 0.5)
    s.envCurve(b, [[0, 0], [0.006, 1], [0.05, 0.45], [0.16, 0]])
    s.filt(b, 'lowpass', 3200, 0.7)
    s.mixInto(out, b, s.n(t), r.range(0.7, 1))
    t += r.range(0.22, 0.42)
  }
  s.dcBlock(out)
  s.normalize(out, 0.7)
  return s.mono(out)
}

/** A vehicle passing on a road you cannot see. */
function vehiclePass(s: Synth): Clip {
  const r = s.rng
  const dur = r.range(3.2, 4.4)
  const out = s.buf(dur)
  const base = r.range(48, 78)

  // Engine order harmonics with a shallow doppler bend through the pass.
  for (let h = 1; h <= 6; h++) {
    const g = 0.5 / (h * 1.35)
    s.chirp(out, 0, dur, base * h * 1.06, base * h * 0.9, g, h === 1 ? 'sine' : 'saw')
  }
  s.saturate(out, 1.8, 0.4)

  // Tyre roar.
  const tyre = s.buf(dur)
  s.white(tyre, 1)
  s.filt(tyre, 'bandpass', 900, 0.55)
  s.filt(tyre, 'lowpass', 2600, 0.7)
  s.mixInto(out, tyre, 0, 0.32)

  s.envCurve(out, [[0, 0], [dur * 0.42, 0.65], [dur * 0.5, 1], [dur * 0.6, 0.6], [dur, 0]])
  s.sweep(out, 'lowpass', 900, 2600, 0.7, dur * 0.5)
  s.dcBlock(out)
  s.normalize(out, 0.7)
  return s.mono(out)
}

function metalCreak(s: Synth): Clip {
  const r = s.rng
  const dur = r.range(0.8, 1.6)
  const out = s.buf(dur)
  const f = r.range(300, 900)
  // Stick-slip: an irregular pulse train through a sharp resonance.
  let phase = 0
  let rate = r.range(40, 90)
  for (let i = 0; i < out.length; i++) {
    phase += rate / s.sr
    if (phase >= 1) {
      phase -= 1
      out[i] += r.range(0.5, 1)
      rate *= r.range(0.985, 1.02)
    }
  }
  s.filt(out, 'bandpass', f, 12)
  s.resonate(out, f * 2.7, 9, 0.5)
  s.envCurve(out, [[0, 0], [dur * 0.15, 1], [dur * 0.7, 0.5], [dur, 0]])
  s.filt(out, 'highpass', 200, 0.7)
  s.dcBlock(out)
  s.normalize(out, 0.5)
  return s.mono(out)
}

// --- UI --------------------------------------------------------------------

function uiTick(s: Synth, f0: number, f1: number, decay: number, bright: number): Clip {
  const out = s.buf(decay * 6 + 0.02)
  s.modal(out, 0, [
    { freq: f0, decay, gain: 0.7, phase: 0 },
    { freq: f1, decay: decay * 0.7, gain: 0.45, phase: 0 },
    { freq: f1 * 1.94, decay: decay * 0.4, gain: 0.2 * bright, phase: 0 },
  ])
  const click = s.buf(0.004)
  s.white(click, 1)
  s.envAD(click, 0.00004, 0.0006, 1)
  s.filt(click, 'highpass', 3000, 0.7)
  s.mixInto(out, click, 0, 0.35 * bright)
  s.envAD(out, 0.0002, decay * 1.6, 1)
  s.dcBlock(out)
  return s.widen(out, 0.0002, 0.05, 0.8)
}

function killConfirm(s: Synth): Clip {
  const out = s.buf(0.5)
  s.modal(out, 0, [
    { freq: 880, decay: 0.09, gain: 0.6, phase: 0 },
    { freq: 1320, decay: 0.07, gain: 0.4, phase: 0 },
  ])
  s.modal(out, 0.07, [
    { freq: 1318, decay: 0.13, gain: 0.6, phase: 0 },
    { freq: 1976, decay: 0.1, gain: 0.35, phase: 0 },
    { freq: 2637, decay: 0.07, gain: 0.18, phase: 0 },
  ])
  const air = s.buf(0.2)
  s.white(air, 1)
  s.filt(air, 'highpass', 5000, 0.7)
  s.envAD(air, 0.0004, 0.02, 1)
  s.mixInto(out, air, 0, 0.15)
  s.envAD(out, 0.0003, 0.22, 1)
  s.dcBlock(out)
  return s.widen(out, 0.0003, 0.08, 0.85)
}

// --- vocal / body ----------------------------------------------------------

/** A breath-driven grunt: noise through moving vowel formants. */
function grunt(s: Synth, pain: number): Clip {
  const r = s.rng
  const dur = 0.35 + pain * 0.4
  const out = s.buf(dur)

  const f0 = r.range(95, 135) * (1 + pain * 0.25)
  for (let h = 1; h <= 14; h++) {
    s.chirp(out, 0, dur * 0.7, f0 * h * 1.08, f0 * h * 0.82, 0.45 / (h * 0.9), 'saw')
  }
  const breath = s.buf(dur)
  s.white(breath, 1)
  s.filt(breath, 'bandpass', 1400, 0.7)
  s.mixInto(out, breath, 0, 0.35 + pain * 0.3)

  // Formants roughly for "uh".
  s.resonate(out, 620, 7, 1.1)
  s.resonate(out, 1180, 6, 0.7)
  s.resonate(out, 2500, 5, 0.35)
  s.filt(out, 'lowpass', 4200, 0.7)
  s.envCurve(out, [[0, 0], [0.02, 1], [dur * 0.35, 0.65], [dur, 0]])
  s.saturate(out, 1.6 + pain, 0.5)
  s.dcBlock(out)
  return s.widen(out, 0.0003, 0.05, 0.8)
}

function bodyFall(s: Synth): Clip {
  const r = s.rng
  const out = s.buf(0.9)
  for (let i = 0; i < 3; i++) {
    const t = i === 0 ? 0 : r.range(0.06, 0.22) * i
    const thud = s.buf(0.3)
    s.chirp(thud, 0, 0.1, r.range(120, 180), r.range(52, 72), 1, 'sine')
    s.envAD(thud, 0.0018, r.range(0.04, 0.075), 1)
    const cloth = s.buf(0.18)
    s.white(cloth, 1)
    s.filt(cloth, 'bandpass', r.range(1400, 3200), 0.9)
    s.envAD(cloth, 0.0006, 0.03, 1)
    s.mixInto(thud, cloth, 0, 0.35)
    s.mixInto(out, thud, s.n(t), i === 0 ? 1 : r.range(0.3, 0.6))
  }
  const gear = s.buf(0.5)
  s.grainCloud(gear, 12, 0.01, 0.35, 1200, 6000, 0.2, 8, 1.8)
  s.mixInto(out, gear, s.n(0.01), 0.4)
  s.dcBlock(out)
  s.normalize(out, 0.85)
  return s.mono(out)
}

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

const FOOT_SURFACES = ['concrete', 'dirt', 'sand', 'gravel', 'wood', 'tile', 'metal', 'water', 'foliage'] as const

const ALL_SURFACES: Surface[] = [
  'concrete', 'metal', 'thinMetal', 'wood', 'dirt', 'sand', 'gravel', 'glass',
  'flesh', 'water', 'fabric', 'plaster', 'tile', 'rubber', 'foliage',
]

/** Footstep surfaces that reuse another surface's samples. */
const FOOT_ALIASES: Record<string, string> = {
  plaster: 'concrete',
  glass: 'tile',
  thinMetal: 'metal',
  rubber: 'wood',
  fabric: 'dirt',
  flesh: 'dirt',
}

export class SoundBank {
  readonly sr: number
  private synth: Synth
  /**
   * Half-rate synth for sounds with no content above ~10 kHz — distant fire and
   * ambience. The browser resamples on playback, so this is free quality-wise
   * and halves both build time and memory for the largest buffers in the bank.
   */
  private synthLo: Synth
  private tasks: Task[] = []
  private index = 0

  constructor(sr: number, seed: number) {
    this.sr = sr
    const rng = new Rand((seed ^ 0x51ed3f) >>> 0)
    this.synth = new Synth(sr, rng)
    this.synthLo = new Synth(Math.round(sr / 2), rng)
    this.queue()
  }

  get complete(): boolean {
    return this.index >= this.tasks.length
  }

  get progress(): number {
    return this.tasks.length === 0 ? 1 : this.index / this.tasks.length
  }

  /**
   * Authors sounds until the budget runs out, appending finished definitions
   * to `out`. Always completes at least one task so progress cannot stall.
   */
  step(budgetMs: number, out: SoundDef[]): void {
    const t0 = performance.now()
    while (this.index < this.tasks.length) {
      const result = this.tasks[this.index++]()
      if (Array.isArray(result)) out.push(...result)
      else out.push(result)
      if (performance.now() - t0 >= budgetMs) break
    }
    // Release the closures — several hold megabytes of partially built PCM.
    if (this.index >= this.tasks.length) this.tasks.length = 0
  }

  private add(task: Task): void {
    this.tasks.push(task)
  }

  /**
   * Builds each variant in its own task. A single task that synthesises three
   * seconds of audio is a dropped frame; three tasks of one second each are
   * not.
   */
  private addVariants(id: string, count: number, make: (index: number) => Clip, opts: DefOpts): void {
    const variants: Clip[] = []
    for (let i = 0; i < count; i++) {
      this.add(() => {
        variants.push(make(i))
        return []
      })
    }
    this.add(() => def(id, variants, opts))
  }

  /**
   * Build order is priority order: the player can shoot and walk within a few
   * frames of the audio context waking up; ambience arrives a moment later.
   */
  private queue(): void {
    const s = this.synth
    const lo = this.synthLo

    // --- UI (tiny, and needed by the menu immediately) ---
    this.add(() => [
      def('ui.hitmarker', [uiTick(s, 2250, 3300, 0.014, 1)], { bus: 'ui', wet: 0, gain: 0.5, pitchJitter: 0.01, priority: 3 }),
      def('ui.headshot', [uiTick(s, 3100, 4650, 0.02, 1.3)], { bus: 'ui', wet: 0, gain: 0.6, pitchJitter: 0.01, priority: 3 }),
      def('ui.click', [uiTick(s, 1500, 2600, 0.008, 0.7)], { bus: 'ui', wet: 0, gain: 0.35, priority: 2 }),
      def('ui.select', [uiTick(s, 1050, 1580, 0.03, 0.6)], { bus: 'ui', wet: 0, gain: 0.4, priority: 2 }),
    ])
    this.add(() => [
      def('ui.kill', [killConfirm(s)], { bus: 'ui', wet: 0, gain: 0.55, pitchJitter: 0, priority: 4 }),
      def('ui.lowAmmo', [uiTick(s, 700, 1050, 0.05, 0.5)], { bus: 'ui', wet: 0, gain: 0.4, priority: 2 }),
    ])

    // --- Weapons ---
    for (const cls of Object.keys(GUNS) as WeaponClass[]) {
      const heavy = cls === 'sniper' || cls === 'shotgun' || cls === 'lmg'
      this.addVariants(
        `weapon.${cls}.fire`, 3,
        (i) => gunshot(s, i === 0 ? GUNS[cls] : jitterGun(GUNS[cls], s.rng)),
        {
          bus: 'weapons',
          gain: cls === 'sniper' ? 1 : cls === 'smg' ? 0.78 : cls === 'pistol' ? 0.72 : 0.9,
          refDistance: heavy ? 11 : 8,
          maxDistance: 260,
          rolloff: 0.85,
          pitchJitter: cls === 'smg' ? 0.05 : 0.035,
          wet: 0.9,
          priority: 6,
        },
      )
    }
    for (const cls of Object.keys(GUNS) as WeaponClass[]) {
      const scale = cls === 'sniper' || cls === 'shotgun' ? 0.75 : cls === 'smg' ? 1.2 : 1
      this.addVariants(
        `weapon.${cls}.distant`, 2,
        (i) => distantShot(lo, i === 0 ? GUNS[cls] : jitterGun(GUNS[cls], lo.rng), scale),
        {
          bus: 'weapons',
          gain: 0.55,
          refDistance: 40,
          maxDistance: 700,
          rolloff: 0.55,
          pitchJitter: 0.06,
          wet: 0.75,
          priority: 3,
        },
      )
    }
    this.add(() => [
      def('weapon.tail.light', [shotReflection(lo, false), shotReflection(lo, false)], {
        bus: 'weapons', gain: 0.4, refDistance: 14, maxDistance: 200, rolloff: 0.7, pitchJitter: 0.08, wet: 0.6, priority: 2,
      }),
      def('weapon.tail.heavy', [shotReflection(lo, true), shotReflection(lo, true)], {
        bus: 'weapons', gain: 0.5, refDistance: 18, maxDistance: 260, rolloff: 0.6, pitchJitter: 0.08, wet: 0.6, priority: 2,
      }),
    ])
    this.add(() => def('weapon.suppressed', [suppressedShot(s), suppressedShot(s)], {
      bus: 'weapons', gain: 0.6, refDistance: 4, maxDistance: 70, pitchJitter: 0.04, wet: 0.5, priority: 5,
    }))

    // --- Weapon foley ---
    this.add(() => {
      const light: Mode[] = [
        { freq: 1650, decay: 0.03, gain: 0.55, drift: 0.04 },
        { freq: 3120, decay: 0.019, gain: 0.35 },
        { freq: 5240, decay: 0.012, gain: 0.22 },
        { freq: 7800, decay: 0.008, gain: 0.13 },
      ]
      const heavy: Mode[] = [
        { freq: 720, decay: 0.055, gain: 0.5, drift: 0.05 },
        { freq: 1380, decay: 0.04, gain: 0.4 },
        { freq: 2460, decay: 0.026, gain: 0.28 },
        { freq: 4200, decay: 0.016, gain: 0.17 },
      ]
      const foley: SoundDef[] = [
        def('weapon.bolt', [
          clack(s, { modes: heavy, clickHp: 2600, clickTau: 0.0016, clickGain: 0.7, dur: 0.18, scrape: 0.35, scrapeDur: 0.05, scrapeF: 2200 }),
          clack(s, { modes: light, clickHp: 3000, clickTau: 0.0014, clickGain: 0.65, dur: 0.18, scrape: 0.3, scrapeDur: 0.045, scrapeF: 2600 }),
        ], { bus: 'weapons', gain: 0.5, refDistance: 3, maxDistance: 45, wet: 0.35, priority: 4 }),
        def('weapon.chargingHandle', [
          clack(s, { modes: heavy, clickHp: 2200, clickTau: 0.002, clickGain: 0.8, dur: 0.3, scrape: 0.6, scrapeDur: 0.13, scrapeF: 1800, thump: 0.25, thumpF: 180 }),
        ], { bus: 'weapons', gain: 0.55, refDistance: 3, maxDistance: 45, wet: 0.35, priority: 4 }),
        def('weapon.magRelease', [
          clack(s, { modes: light, clickHp: 4200, clickTau: 0.0009, clickGain: 0.8, dur: 0.1 }),
        ], { bus: 'weapons', gain: 0.4, refDistance: 3, maxDistance: 35, wet: 0.3, priority: 3 }),
        def('weapon.magOut', [
          clack(s, { modes: light, clickHp: 2800, clickTau: 0.0018, clickGain: 0.6, dur: 0.22, scrape: 0.5, scrapeDur: 0.09, scrapeF: 3100 }),
          clack(s, { modes: light, clickHp: 3200, clickTau: 0.0016, clickGain: 0.55, dur: 0.22, scrape: 0.45, scrapeDur: 0.08, scrapeF: 2700 }),
        ], { bus: 'weapons', gain: 0.45, refDistance: 3, maxDistance: 35, wet: 0.3, priority: 3 }),
        def('weapon.magIn', [
          clack(s, { modes: heavy, clickHp: 2000, clickTau: 0.0022, clickGain: 0.85, dur: 0.26, thump: 0.55, thumpF: 128, scrape: 0.25, scrapeDur: 0.05, scrapeF: 1900 }),
        ], { bus: 'weapons', gain: 0.55, refDistance: 3, maxDistance: 40, wet: 0.35, priority: 4 }),
        def('weapon.trigger', [
          clack(s, { modes: light, clickHp: 5200, clickTau: 0.0005, clickGain: 0.6, dur: 0.05 }),
        ], { bus: 'weapons', gain: 0.28, refDistance: 2, maxDistance: 20, wet: 0.2, priority: 2 }),
        def('weapon.dryFire', [
          clack(s, { modes: light, clickHp: 3600, clickTau: 0.0011, clickGain: 0.9, dur: 0.09, thump: 0.15, thumpF: 260 }),
        ], { bus: 'weapons', gain: 0.45, refDistance: 2, maxDistance: 22, wet: 0.25, priority: 4 }),
        def('weapon.safety', [
          clack(s, { modes: light, clickHp: 6000, clickTau: 0.0004, clickGain: 0.55, dur: 0.04 }),
        ], { bus: 'weapons', gain: 0.3, refDistance: 2, maxDistance: 18, wet: 0.2, priority: 2 }),
        def('weapon.raise', [
          clack(s, { modes: heavy, clickHp: 1600, clickTau: 0.0025, clickGain: 0.4, dur: 0.3, scrape: 0.55, scrapeDur: 0.16, scrapeF: 1200, thump: 0.3, thumpF: 110 }),
        ], { bus: 'weapons', gain: 0.4, refDistance: 2, maxDistance: 25, wet: 0.3, priority: 3 }),
        def('weapon.lower', [
          clack(s, { modes: heavy, clickHp: 1400, clickTau: 0.003, clickGain: 0.3, dur: 0.34, scrape: 0.5, scrapeDur: 0.2, scrapeF: 900, thump: 0.25, thumpF: 95 }),
        ], { bus: 'weapons', gain: 0.35, refDistance: 2, maxDistance: 25, wet: 0.3, priority: 3 }),
      ]
      // Sights up/down reuse the handling foley at a whisper.
      foley.push(alias('weapon.adsIn', foley[8], { gain: 0.2 }))
      foley.push(alias('weapon.adsOut', foley[9], { gain: 0.18 }))
      return foley
    })

    this.add(() => def('weapon.shell', [0, 1, 2].map(() => shellBounce(s)), {
      bus: 'weapons', gain: 0.3, refDistance: 2, maxDistance: 28, pitchJitter: 0.12, wet: 0.45, priority: 1,
    }))

    // --- Footsteps ---
    for (const surf of FOOT_SURFACES) {
      this.add(() => {
        const p = STEPS[surf]
        const walk = [0, 1, 2].map(() => footstep(s, p, false))
        const run = [0, 1, 2].map(() => footstep(s, p, true))
        const out: SoundDef[] = [
          def(`foot.${surf}.walk`, walk, { gain: 0.42, refDistance: 1.6, maxDistance: 34, rolloff: 1.5, pitchJitter: 0.09, wet: 0.35, priority: 1 }),
          def(`foot.${surf}.run`, run, { gain: 0.58, refDistance: 2, maxDistance: 46, rolloff: 1.4, pitchJitter: 0.08, wet: 0.4, priority: 2 }),
        ]
        for (const [from, to] of Object.entries(FOOT_ALIASES)) {
          if (to !== surf) continue
          out.push(alias(`foot.${from}.walk`, out[0]))
          out.push(alias(`foot.${from}.run`, out[1]))
        }
        return out
      })
    }

    this.add(() => {
      const soft = footstep(s, STEPS.concrete, true)
      const hardParams: StepParams = { ...STEPS.concrete, thump: 1, thumpTau: 0.05, scuff: 0.7, dur: 0.45 }
      return [
        def('foot.land.soft', [soft, footstep(s, STEPS.concrete, true)], { gain: 0.5, refDistance: 2, maxDistance: 40, wet: 0.4, priority: 2 }),
        def('foot.land.hard', [footstep(s, hardParams, true), footstep(s, hardParams, true)], { gain: 0.85, refDistance: 3, maxDistance: 55, wet: 0.5, priority: 3 }),
        def('foot.jump', [footstep(s, { ...STEPS.concrete, thump: 0.4, scuff: 0.7 }, false)], { gain: 0.4, refDistance: 2, maxDistance: 30, wet: 0.35, priority: 1 }),
      ]
    })

    // --- Impacts ---
    for (const surf of ALL_SURFACES) {
      this.addVariants(`impact.${surf}`, 3, () => impact(s, IMPACTS[surf]), {
        gain: surf === 'flesh' ? 0.6 : 0.72,
        refDistance: 3,
        maxDistance: 90,
        rolloff: 1.2,
        pitchJitter: 0.1,
        wet: IMPACTS[surf].wet ?? 0.45,
        priority: 3,
      })
    }

    this.addVariants('ricochet', 4, () => ricochet(s), {
      gain: 0.5, refDistance: 4, maxDistance: 120, pitchJitter: 0.1, wet: 0.7, priority: 3,
    })
    this.add(() => [
      def('whizby', [0, 1, 2, 3].map(() => whizby(s)), { bus: 'weapons', gain: 0.45, refDistance: 1.2, maxDistance: 14, rolloff: 2, pitchJitter: 0.14, wet: 0.2, priority: 4 }),
      def('crack.supersonic', [0, 1].map(() => supersonicCrack(s)), { bus: 'weapons', gain: 0.55, refDistance: 2, maxDistance: 24, rolloff: 1.8, pitchJitter: 0.08, wet: 0.4, priority: 4 }),
    ])

    // --- Explosions (multi-second buffers: one variant per task) ---
    this.add(() => def('explosion.large', [explosion(s, 1.25)], {
      bus: 'weapons', gain: 1, refDistance: 16, maxDistance: 400, rolloff: 0.7, pitchJitter: 0.08, wet: 1, priority: 8,
    }))
    this.add(() => def('explosion.grenade', [explosion(s, 0.85)], {
      bus: 'weapons', gain: 0.92, refDistance: 12, maxDistance: 320, rolloff: 0.8, pitchJitter: 0.09, wet: 0.95, priority: 8,
    }))
    this.add(() => def('debris.rain', [debrisRain(s)], {
      gain: 0.5, refDistance: 8, maxDistance: 120, pitchJitter: 0.08, wet: 0.6, priority: 2,
    }))

    // --- Bodies and voices ---
    this.addVariants('body.fall', 2, () => bodyFall(s), {
      gain: 0.7, refDistance: 3, maxDistance: 60, pitchJitter: 0.07, wet: 0.5, priority: 4,
    })
    this.addVariants('player.hurt', 3, (i) => grunt(s, 0.4 + i * 0.15), {
      bus: 'ui', gain: 0.55, wet: 0.1, pitchJitter: 0.06, priority: 6,
    })
    this.add(() => def('player.death', [grunt(s, 1)], {
      bus: 'ui', gain: 0.7, wet: 0.15, pitchJitter: 0, priority: 9,
    }))
    this.addVariants('enemy.hurt', 2, (i) => grunt(s, 0.6 + i * 0.25), {
      gain: 0.6, refDistance: 3, maxDistance: 50, pitchJitter: 0.08, wet: 0.4, priority: 4,
    })

    // --- Ambience (largest buffers, built last, all at half rate) ---
    this.add(() => [
      def('amb.dog', [dogBark(lo), dogBark(lo)], { bus: 'ambience', gain: 0.35, refDistance: 30, maxDistance: 400, rolloff: 0.5, pitchJitter: 0.09, wet: 0.85, priority: 1 }),
      def('amb.creak', [metalCreak(lo), metalCreak(lo)], { bus: 'ambience', gain: 0.3, refDistance: 8, maxDistance: 90, pitchJitter: 0.12, wet: 0.7, priority: 1 }),
    ])
    this.add(() => def('amb.vehicle', [vehiclePass(lo)], {
      bus: 'ambience', gain: 0.4, refDistance: 25, maxDistance: 350, rolloff: 0.6, pitchJitter: 0.1, wet: 0.7, priority: 1,
    }))

    // The beds are the largest buffers in the bank, so each channel is its own
    // task; one frame must never have to synthesise thirteen seconds of audio.
    const wind: Float32Array[] = []
    this.add(() => { wind.push(windChannel(lo)); return [] })
    this.add(() => { wind.push(windChannel(lo)); return [] })
    this.add(() => def('amb.wind', [assembleBed(lo, wind, 0.55)], {
      bus: 'ambience', gain: 0.5, loop: true, pitchJitter: 0, wet: 0.15, priority: 0,
    }))

    const city: Float32Array[] = []
    this.add(() => { city.push(cityChannel(lo)); return [] })
    this.add(() => { city.push(cityChannel(lo)); return [] })
    this.add(() => def('amb.city', [assembleBed(lo, city, 0.45)], {
      bus: 'ambience', gain: 0.42, loop: true, pitchJitter: 0, wet: 0.2, priority: 0,
    }))
  }
}

function shellBounce(s: Synth): Clip {
  const r = s.rng
  const out = s.buf(0.7)
  const f = r.range(2600, 4200)
  let t = 0
  let g = 1
  for (let i = 0; i < 4; i++) {
    const modes: Mode[] = [
      { freq: f * r.range(0.95, 1.06), decay: 0.055 * g, gain: 0.5 },
      { freq: f * 1.87, decay: 0.035 * g, gain: 0.3 },
      { freq: f * 3.1, decay: 0.022 * g, gain: 0.18 },
      { freq: f * 0.54, decay: 0.07 * g, gain: 0.22 },
    ]
    const hit = s.buf(0.24)
    s.modal(hit, 0, modes)
    const click = s.buf(0.004)
    s.white(click, 1)
    s.envAD(click, 0.00004, 0.0005, 1)
    s.filt(click, 'highpass', 4000, 0.7)
    s.mixInto(hit, click, 0, 0.5)
    s.envAD(hit, 0.0002, 0.05 * g, 1)
    s.mixInto(out, hit, s.n(t), g)
    t += r.range(0.06, 0.13) * (1 + i * 0.3)
    g *= r.range(0.4, 0.62)
  }
  s.dcBlock(out)
  s.normalize(out, 0.55)
  return s.mono(out)
}

/** Small per-variant deviations so consecutive shots never phase-lock. */
function jitterGun(p: GunParams, r: Rand): GunParams {
  return {
    ...p,
    transient: p.transient * r.range(0.9, 1.06),
    transientHp: p.transientHp * r.range(0.92, 1.1),
    crackTau: p.crackTau * r.range(0.9, 1.12),
    crackHi: p.crackHi * r.range(0.93, 1.08),
    crackLo: p.crackLo * r.range(0.9, 1.12),
    crackPeak: p.crackPeak * r.range(0.9, 1.12),
    bodyF0: p.bodyF0 * r.range(0.93, 1.08),
    bodyF1: p.bodyF1 * r.range(0.92, 1.1),
    bodyTau: p.bodyTau * r.range(0.9, 1.12),
    subF0: p.subF0 * r.range(0.94, 1.07),
    subTau: p.subTau * r.range(0.9, 1.1),
    mech: p.mech * r.range(0.8, 1.25),
    mechModes: p.mechModes.map((m) => ({ ...m, freq: m.freq * r.range(0.94, 1.07), decay: m.decay * r.range(0.85, 1.2) })),
    tailTau: p.tailTau * r.range(0.88, 1.15),
    drive: p.drive * r.range(0.92, 1.1),
  }
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/**
 * Ten systems were written in parallel, so the ids other systems ask for will
 * not all match the ids authored here. Rather than go silent, map anything
 * plausible onto the nearest real sound: normalise, expand synonyms, then score
 * by shared tokens.
 */
const SYNONYMS: Record<string, string> = {
  m4: 'rifle', m16: 'rifle', ak: 'rifle', ak47: 'rifle', ar: 'rifle', assault: 'rifle',
  carbine: 'rifle', scar: 'rifle', g36: 'rifle', famas: 'rifle',
  mp5: 'smg', mp7: 'smg', uzi: 'smg', p90: 'smg', vector: 'smg', submachine: 'smg', smg: 'smg',
  awp: 'sniper', awm: 'sniper', barrett: 'sniper', dragunov: 'sniper', svd: 'sniper',
  r700: 'sniper', intervention: 'sniper', dmr: 'sniper', marksman: 'sniper',
  m1911: 'pistol', glock: 'pistol', deagle: 'pistol', handgun: 'pistol', sidearm: 'pistol', m9: 'pistol',
  spas: 'shotgun', remington: 'shotgun', '870': 'shotgun', shotty: 'shotgun',
  m249: 'lmg', saw: 'lmg', pkm: 'lmg', mg: 'lmg', machinegun: 'lmg',
  shoot: 'fire', shot: 'fire', gunshot: 'fire', bang: 'fire', discharge: 'fire', firing: 'fire',
  gun: 'weapon', wpn: 'weapon',
  step: 'foot', footstep: 'foot', footfall: 'foot', walking: 'walk', running: 'run', sprint: 'run',
  landing: 'land', jumping: 'jump',
  hit: 'impact', bullethole: 'impact', strike: 'impact', splat: 'impact',
  ric: 'ricochet', deflect: 'ricochet',
  boom: 'explosion', blast: 'explosion', explode: 'explosion', grenade: 'grenade', frag: 'grenade',
  nade: 'grenade', rpg: 'large', rocket: 'large',
  reload: 'mag', magazine: 'mag', clip: 'mag', insert: 'in', eject: 'out', release: 'release',
  charging: 'charging handle', chamber: 'bolt', slide: 'bolt', cock: 'bolt',
  dryfire: 'dry fire', empty: 'dry fire', click: 'trigger',
  equip: 'raise', draw: 'raise', holster: 'lower', putaway: 'lower',
  casing: 'shell', brass: 'shell',
  hitmark: 'hitmarker', marker: 'hitmarker', killed: 'kill',
  ammo: 'low ammo',
  ambient: 'amb', ambience: 'amb', atmosphere: 'amb', wind: 'wind', city: 'city',
  far: 'distant', faraway: 'distant', distance: 'distant',
  suppressor: 'suppressed', silencer: 'suppressed', silenced: 'suppressed',
  pain: 'hurt', damage: 'hurt', hurt: 'hurt', death: 'death', die: 'death', died: 'death',
  corpse: 'fall', ragdoll: 'fall',
  concrete: 'concrete', stone: 'concrete', asphalt: 'concrete', brick: 'concrete',
  cement: 'concrete', rock: 'concrete',
  mud: 'dirt', earth: 'dirt', ground: 'dirt', grass: 'foliage', bush: 'foliage', leaves: 'foliage',
  steel: 'metal', iron: 'metal', tin: 'thinMetal', corrugated: 'thinMetal',
  plank: 'wood', crate: 'wood', timber: 'wood',
  window: 'glass', shatter: 'glass',
  body: 'flesh', meat: 'flesh', blood: 'flesh',
  puddle: 'water', splash: 'water',
  cloth: 'fabric', sandbag: 'fabric', tarp: 'fabric',
  drywall: 'plaster', stucco: 'plaster',
  ceramic: 'tile', floor: 'tile',
}

/**
 * Family fallbacks, tried when token scoring finds nothing convincing.
 * Order matters: the most specific pattern has to win, or "hitmarker" gets
 * swallowed by the "hit" rule.
 */
const FALLBACKS: [RegExp, string][] = [
  [/hitmark|marker/, 'ui.hitmarker'],
  [/headshot/, 'ui.headshot'],
  [/whiz|flyby|snap|crack/, 'whizby'],
  [/ricochet|ric/, 'ricochet'],
  [/suppress|silenc/, 'weapon.suppressed'],
  [/dry|empty/, 'weapon.dryFire'],
  [/shell|casing|brass/, 'weapon.shell'],
  [/explo|boom|blast|grenade|rocket/, 'explosion.grenade'],
  [/debris|rubble/, 'debris.rain'],
  [/foot|step|walk|run|land/, 'foot.concrete.walk'],
  [/bolt|charg|chamber|cock/, 'weapon.bolt'],
  [/mag|reload/, 'weapon.magIn'],
  [/distant|far/, 'weapon.rifle.distant'],
  [/impact|hit|bullet/, 'impact.concrete'],
  [/fire|shoot|shot|gun|weapon/, 'weapon.rifle.fire'],
  [/kill/, 'ui.kill'],
  [/ammo/, 'ui.lowAmmo'],
  [/menu|button|click|select|ui/, 'ui.click'],
  [/amb|wind|atmo/, 'amb.wind'],
  [/hurt|pain|grunt|damage/, 'player.hurt'],
  [/death|die|dead/, 'player.death'],
  [/body|corpse|ragdoll|fall/, 'body.fall'],
]

/**
 * Ids common enough to be worth pinning exactly, because token scoring cannot
 * tell "fire" (shoot) from "dry fire" (do not shoot) on shared tokens alone.
 */
const DIRECT: Record<string, string> = {
  fire: 'weapon.rifle.fire',
  shoot: 'weapon.rifle.fire',
  shot: 'weapon.rifle.fire',
  gunshot: 'weapon.rifle.fire',
  gunfire: 'weapon.rifle.fire',
  'weapon fire': 'weapon.rifle.fire',
  'gun fire': 'weapon.rifle.fire',
  'weapon shoot': 'weapon.rifle.fire',
  'weapon shot': 'weapon.rifle.fire',
  'rifle fire': 'weapon.rifle.fire',
  'smg fire': 'weapon.smg.fire',
  'sniper fire': 'weapon.sniper.fire',
  'pistol fire': 'weapon.pistol.fire',
  'shotgun fire': 'weapon.shotgun.fire',
  'lmg fire': 'weapon.lmg.fire',
  reload: 'weapon.magIn',
  bolt: 'weapon.bolt',
  'bolt cycle': 'weapon.bolt',
  'charging handle': 'weapon.chargingHandle',
  hitmarker: 'ui.hitmarker',
  headshot: 'ui.headshot',
  kill: 'ui.kill',
  'low ammo': 'ui.lowAmmo',
  explosion: 'explosion.grenade',
  footstep: 'foot.concrete.walk',
  jump: 'foot.jump',
  land: 'foot.land.soft',
}

function tokenise(id: string): string[] {
  const parts = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0)
  const out: string[] = []
  for (const part of parts) {
    const mapped = SYNONYMS[part]
    if (mapped === undefined) out.push(part)
    else if (mapped.indexOf(' ') < 0) out.push(mapped)
    else for (const t of mapped.split(' ')) out.push(t)
  }
  return out
}

/** Maps an arbitrary id onto the closest authored sound, or null. */
export function resolveSoundId(known: ReadonlyMap<string, unknown>, raw: string): string | null {
  if (known.has(raw)) return raw

  const wanted = tokenise(raw)
  if (wanted.length === 0) return null

  const direct = DIRECT[wanted.join(' ')]
  if (direct && known.has(direct)) return direct

  let best: string | null = null
  let bestScore = 0
  for (const id of known.keys()) {
    const have = tokenise(id)
    let score = 0
    for (const w of wanted) {
      if (have.includes(w)) score += 1 + Math.min(w.length, 6) * 0.1
    }
    if (score === 0) continue
    // Penalise candidates padded out with tokens the caller never mentioned.
    let unmatched = 0
    for (const h of have) if (!wanted.includes(h)) unmatched++
    score -= unmatched * 0.3
    if (score > bestScore) {
      bestScore = score
      best = id
    }
  }
  if (best && bestScore >= 1.2) return best

  const lower = raw.toLowerCase()
  for (const [re, target] of FALLBACKS) {
    if (re.test(lower) && known.has(target)) return target
  }
  return best
}

/** Weapon display names come from the weapon system; bucket them by family. */
export function weaponClassOf(name: string): WeaponClass {
  const tokens = tokenise(name)
  for (const t of tokens) {
    if (t === 'rifle' || t === 'smg' || t === 'sniper' || t === 'pistol' || t === 'shotgun' || t === 'lmg') {
      return t
    }
  }
  return 'rifle'
}
