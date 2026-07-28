import { Rand } from '../core/Rand'
import type { Clip } from './Synth'
import { resolveSoundId, type BusName, type SoundDef } from './SoundBank'
import { Reverb, type ZoneName } from './Reverb'

/**
 * The live mix.
 *
 * Signal flow:
 *
 *   voice -> gain -> lowpass -> panner ---------------> bus ----.
 *                          \-> send ----------------> reverb ---+-> deaf LP
 *                                                                  |
 *   ui bus ------------------------------------------------.      |
 *   tinnitus oscillators ----------------------------------+------+-> master
 *                                                                     -> limiter -> out
 *
 * The single lowpass per voice carries both air absorption and occlusion (they
 * combine as a minimum, so one filter does the work of two). Propagation delay
 * is scheduled rather than filtered: the source simply starts late, which is
 * both free and exact, and is the reason a distant explosion flashes before it
 * arrives.
 */

export interface SpatialOptions {
  volume?: number
  pitch?: number
  maxDistance?: number
  loop?: boolean
  /** Extra low-pass ceiling in Hz — occlusion, suppression, "through a wall". */
  lowpass?: number
  /** Post-distance gain scale, used for occlusion. */
  attenuation?: number
  /** Skip the speed-of-sound delay (sounds attached to the listener). */
  immediate?: boolean
  /** Extra scheduling delay in seconds. */
  delay?: number
  /** Overrides the definition's reverb send. */
  wet?: number
}

interface VoiceBase {
  gain: GainNode
  filter: BiquadFilterNode
  send: GainNode
  source: AudioBufferSourceNode | null
  bus: GainNode | null
  active: boolean
  priority: number
  startedAt: number
  /** Seconds the next playback must wait for a stolen voice to fade out. */
  stealDelay: number
  release: () => void
}

interface Voice extends VoiceBase {
  panner: PannerNode
}

interface FlatVoice extends VoiceBase {
  /** Stereo placement node, or a plain gain where StereoPanner is missing. */
  out: AudioNode
  pan: StereoPannerNode | null
}

export interface LoopHandle {
  source: AudioBufferSourceNode
  gain: GainNode
}

interface Entry {
  def: SoundDef
  buffers: AudioBuffer[]
}

const SPEED_OF_SOUND = 343
const EMPTY_VARIANTS: Clip[] = []

export class Mixer {
  readonly ctx: AudioContext
  readonly reverb: Reverb

  private master: GainNode
  private limiter: DynamicsCompressorNode
  private deafFilter: BiquadFilterNode
  private gameGain: GainNode
  private buses: Record<BusName, GainNode>
  private ambienceDuck: GainNode
  private reverbSend: GainNode
  private tinnitusGain: GainNode
  private tinnitus: OscillatorNode[] = []

  private entries = new Map<string, Entry>()
  private clipCache = new Map<Clip, AudioBuffer>()
  private resolved = new Map<string, string | null>()

  private voices: Voice[] = []
  private flatVoices: FlatVoice[] = []
  private maxVoices = 40
  private maxFlatVoices = 20

  private rand = new Rand(0xa5f1)

  // Listener state, kept as plain numbers so this file never touches three.js.
  private lx = 0
  private ly = 1.68
  private lz = 0

  // Mix automation state, all driven from update().
  private duckAmount = 0
  private duckRelease = 1
  private fireDuck = 0
  private deaf = 0
  private deafRelease = 3
  private paused = false
  private lastAmbGain = 1
  private lastWorldGain = 1
  private lastGameGain = 1
  private lastDeafHz = 20000
  private lastTinnitus = 0

  constructor(ctx: AudioContext, seed: number) {
    this.ctx = ctx
    const nyquist = ctx.sampleRate * 0.45

    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -7
    this.limiter.knee.value = 3
    this.limiter.ratio.value = 18
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.2
    this.limiter.connect(ctx.destination)

    this.master = ctx.createGain()
    this.master.gain.value = 0.85
    this.master.connect(this.limiter)

    this.deafFilter = ctx.createBiquadFilter()
    this.deafFilter.type = 'lowpass'
    this.deafFilter.frequency.value = Math.min(20000, nyquist)
    this.deafFilter.Q.value = 0.6
    this.deafFilter.connect(this.master)

    this.gameGain = ctx.createGain()
    this.gameGain.connect(this.deafFilter)

    const bus = (gain: number, dest: AudioNode): GainNode => {
      const g = ctx.createGain()
      g.gain.value = gain
      g.connect(dest)
      return g
    }

    this.ambienceDuck = bus(1, this.gameGain)
    this.buses = {
      weapons: bus(1, this.gameGain),
      world: bus(1, this.gameGain),
      ambience: bus(1, this.ambienceDuck),
      // UI sits after the deafness filter so the interface stays legible even
      // when the player has just been shelled.
      ui: bus(1, this.master),
    }

    this.reverb = new Reverb(ctx, seed)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 1
    this.reverbSend.connect(this.reverb.input)
    this.reverb.output.connect(this.gameGain)

    this.tinnitusGain = ctx.createGain()
    this.tinnitusGain.gain.value = 0
    this.tinnitusGain.connect(this.master)
    for (const [freq, level] of [[4680, 1], [7130, 0.45], [3210, 0.3]] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const g = ctx.createGain()
      g.gain.value = level
      osc.connect(g)
      g.connect(this.tinnitusGain)
      try {
        osc.start()
      } catch {
        // An oscillator that will not start simply means no tinnitus.
      }
      this.tinnitus.push(osc)
    }

    this.setListener(0, 1.68, 0, 0, 0, -1, 0, 1, 0)
  }

  // --- registration -------------------------------------------------------

  register(def: SoundDef): void {
    const buffers: AudioBuffer[] = []
    for (const clip of def.variants) {
      // Aliased definitions share PCM, so cache by clip rather than by id.
      const cached = this.clipCache.get(clip)
      if (cached) {
        buffers.push(cached)
        continue
      }
      const buf = this.toAudioBuffer(clip)
      if (!buf) continue
      this.clipCache.set(clip, buf)
      buffers.push(buf)
    }
    if (buffers.length === 0) return
    // Drop the raw PCM: the AudioBuffer is now the only copy that matters, and
    // keeping both would double a thirty-megabyte bank.
    this.entries.set(def.id, { def: { ...def, variants: EMPTY_VARIANTS }, buffers })
    // A newly registered name may satisfy an id that previously fell back.
    this.resolved.clear()
  }

  /** Called once the bank is finished so the clip cache can be released. */
  buildComplete(): void {
    this.clipCache.clear()
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  private toAudioBuffer(clip: Clip): AudioBuffer | null {
    try {
      const buf = this.ctx.createBuffer(clip.ch.length, clip.ch[0].length, clip.sr)
      for (let c = 0; c < clip.ch.length; c++) buf.getChannelData(c).set(clip.ch[c])
      return buf
    } catch {
      return null
    }
  }

  private lookup(id: string): Entry | null {
    const direct = this.entries.get(id)
    if (direct) return direct
    let target = this.resolved.get(id)
    if (target === undefined) {
      target = resolveSoundId(this.entries, id)
      this.resolved.set(id, target)
    }
    return target ? this.entries.get(target) ?? null : null
  }

  // --- listener -----------------------------------------------------------

  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    this.lx = px
    this.ly = py
    this.lz = pz
    const l = this.ctx.listener
    const t = this.ctx.currentTime
    if (l.positionX) {
      // A short ramp rather than a step: stepping the listener every frame
      // makes HRTF panning crackle when the player turns quickly.
      const ahead = t + 0.02
      l.positionX.linearRampToValueAtTime(px, ahead)
      l.positionY.linearRampToValueAtTime(py, ahead)
      l.positionZ.linearRampToValueAtTime(pz, ahead)
      l.forwardX.linearRampToValueAtTime(fx, ahead)
      l.forwardY.linearRampToValueAtTime(fy, ahead)
      l.forwardZ.linearRampToValueAtTime(fz, ahead)
      l.upX.linearRampToValueAtTime(ux, ahead)
      l.upY.linearRampToValueAtTime(uy, ahead)
      l.upZ.linearRampToValueAtTime(uz, ahead)
    } else {
      const legacy = l as unknown as {
        setPosition?: (x: number, y: number, z: number) => void
        setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void
      }
      legacy.setPosition?.(px, py, pz)
      legacy.setOrientation?.(fx, fy, fz, ux, uy, uz)
    }
  }

  listenerDistance(x: number, y: number, z: number): number {
    const dx = x - this.lx
    const dy = y - this.ly
    const dz = z - this.lz
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  // --- playback -----------------------------------------------------------

  play(id: string, x: number, y: number, z: number, opts: SpatialOptions = {}): void {
    const entry = this.lookup(id)
    if (!entry) return
    const { def } = entry
    const dist = this.listenerDistance(x, y, z)
    const maxDist = opts.maxDistance ?? def.maxDistance
    if (dist > maxDist * 1.05) return

    const voice = this.acquire(def.priority)
    if (!voice) return

    const at = this.ctx.currentTime + voice.stealDelay
    voice.stealDelay = 0

    const buffer = entry.buffers[this.rand.int(0, entry.buffers.length - 1)]
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    const jitter = def.pitchJitter > 0 ? 1 + this.rand.spread(def.pitchJitter) : 1
    src.playbackRate.value = Math.max(0.05, (opts.pitch ?? 1) * jitter)
    const looping = opts.loop ?? def.loop
    src.loop = looping

    const attenuation = opts.attenuation ?? 1
    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.setValueAtTime(def.gain * (opts.volume ?? 1) * attenuation, at)

    const air = airCutoff(dist)
    const ceiling = Math.min(air, opts.lowpass ?? 22050, this.ctx.sampleRate * 0.45)
    voice.filter.frequency.value = ceiling
    voice.filter.Q.value = 0.5

    voice.panner.refDistance = def.refDistance
    voice.panner.maxDistance = maxDist
    voice.panner.rolloffFactor = def.rolloff
    // HRTF is worth its cost only where the head-shadow cue is meaningful.
    voice.panner.panningModel = dist < 34 ? 'HRTF' : 'equalpower'
    setPannerPosition(voice.panner, x, y, z)

    const wet = (opts.wet ?? def.wet) * reverbFalloff(dist) * attenuation
    voice.send.gain.value = wet

    const targetBus = this.buses[def.bus]
    if (voice.bus !== targetBus) {
      voice.panner.disconnect()
      voice.panner.connect(targetBus)
      voice.bus = targetBus
    }

    src.connect(voice.gain)
    src.onended = voice.release
    voice.source = src
    voice.active = true
    voice.priority = def.priority
    voice.startedAt = at

    // Sound travels. Past ~8 m the lag is audible, and seeing a muzzle flash
    // before hearing it is one of the strongest scale cues available.
    const delay = (opts.immediate || dist < 8 ? 0 : Math.min(dist / SPEED_OF_SOUND, 1.6)) + (opts.delay ?? 0)
    try {
      src.start(at + delay)
      // A looping one-shot would never fire `onended` and would leak its
      // voice, so give it a hard ceiling.
      if (looping) src.stop(at + delay + 20)
    } catch {
      voice.release()
    }
  }

  play2D(id: string, opts: SpatialOptions = {}): void {
    const entry = this.lookup(id)
    if (!entry) return
    const { def } = entry
    const voice = this.acquireFlat(def.priority)
    if (!voice) return

    const at = this.ctx.currentTime + voice.stealDelay
    voice.stealDelay = 0

    const buffer = entry.buffers[this.rand.int(0, entry.buffers.length - 1)]
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    const jitter = def.pitchJitter > 0 ? 1 + this.rand.spread(def.pitchJitter) : 1
    src.playbackRate.value = Math.max(0.05, (opts.pitch ?? 1) * jitter)
    const looping = opts.loop ?? def.loop
    src.loop = looping

    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.setValueAtTime(def.gain * (opts.volume ?? 1) * (opts.attenuation ?? 1), at)
    voice.filter.frequency.value = Math.min(opts.lowpass ?? 22050, this.ctx.sampleRate * 0.45)
    voice.send.gain.value = opts.wet ?? def.wet
    if (voice.pan) voice.pan.pan.value = this.rand.spread(0.08)

    const targetBus = this.buses[def.bus]
    if (voice.bus !== targetBus) {
      voice.out.disconnect()
      voice.out.connect(targetBus)
      voice.bus = targetBus
    }

    src.connect(voice.gain)
    src.onended = voice.release
    voice.source = src
    voice.active = true
    voice.priority = def.priority
    voice.startedAt = at

    try {
      src.start(at + (opts.delay ?? 0))
      if (looping) src.stop(at + (opts.delay ?? 0) + 20)
    } catch {
      voice.release()
    }
  }

  /** Starts a looping bed outside the voice pool so it is never stolen. */
  startLoop(id: string, volume = 1): LoopHandle | null {
    const entry = this.lookup(id)
    if (!entry) return null
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    gain.connect(this.buses[entry.def.bus])
    const send = this.ctx.createGain()
    send.gain.value = entry.def.wet
    gain.connect(send)
    send.connect(this.reverbSend)

    const src = this.ctx.createBufferSource()
    src.buffer = entry.buffers[0]
    src.loop = true
    src.connect(gain)
    try {
      src.start(this.ctx.currentTime + 0.02)
    } catch {
      return null
    }
    const now = this.ctx.currentTime
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(entry.def.gain * volume, now + 2.5)
    return { source: src, gain }
  }

  stopLoop(handle: LoopHandle): void {
    const now = this.ctx.currentTime
    handle.gain.gain.cancelScheduledValues(now)
    handle.gain.gain.setValueAtTime(handle.gain.gain.value, now)
    handle.gain.gain.linearRampToValueAtTime(0, now + 0.4)
    try {
      handle.source.stop(now + 0.45)
    } catch {
      // Already stopped.
    }
  }

  // --- voice pool ---------------------------------------------------------

  private acquire(priority: number): Voice | null {
    for (const v of this.voices) {
      if (!v.active) return v
    }
    if (this.voices.length < this.maxVoices) {
      const v = this.createVoice()
      this.voices.push(v)
      return v
    }
    return this.steal(this.voices, priority)
  }

  private acquireFlat(priority: number): FlatVoice | null {
    for (const v of this.flatVoices) {
      if (!v.active) return v
    }
    if (this.flatVoices.length < this.maxFlatVoices) {
      const v = this.createFlatVoice()
      this.flatVoices.push(v)
      return v
    }
    return this.steal(this.flatVoices, priority)
  }

  /** Drops the least important voice, fading it so the swap does not click. */
  private steal<T extends VoiceBase>(pool: T[], priority: number): T | null {
    let victim: T | null = null
    for (const v of pool) {
      if (v.priority > priority) continue
      if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.startedAt < victim.startedAt)) {
        victim = v
      }
    }
    if (!victim) return null
    const now = this.ctx.currentTime
    const old = victim.source
    if (old) {
      // Detach the handler first: its `onended` would otherwise fire after the
      // voice has already been handed to a new sound and tear that one down.
      old.onended = null
      try {
        victim.gain.gain.cancelScheduledValues(now)
        victim.gain.gain.setValueAtTime(victim.gain.gain.value, now)
        victim.gain.gain.linearRampToValueAtTime(0, now + 0.008)
        old.stop(now + 0.01)
      } catch {
        // Fall through — the voice is reused regardless.
      }
    }
    victim.source = null
    victim.active = false
    victim.stealDelay = 0.014
    return victim
  }

  private createVoice(): Voice {
    const ctx = this.ctx
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 22050
    const panner = ctx.createPanner()
    panner.distanceModel = 'inverse'
    panner.panningModel = 'HRTF'
    panner.coneInnerAngle = 360
    const send = ctx.createGain()
    gain.connect(filter)
    filter.connect(panner)
    filter.connect(send)
    send.connect(this.reverbSend)
    panner.connect(this.buses.world)

    const voice: Voice = {
      gain, filter, panner, send,
      source: null, bus: this.buses.world, active: false,
      priority: 0, startedAt: 0, stealDelay: 0,
      release: () => {},
    }
    voice.release = () => {
      if (voice.source) {
        try {
          voice.source.disconnect()
        } catch {
          // Already disconnected.
        }
        voice.source.onended = null
        voice.source = null
      }
      voice.active = false
    }
    return voice
  }

  private createFlatVoice(): FlatVoice {
    const ctx = this.ctx
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 22050
    const send = ctx.createGain()
    gain.connect(filter)
    filter.connect(send)
    send.connect(this.reverbSend)

    let pan: StereoPannerNode | null = null
    let out: AudioNode
    if (typeof ctx.createStereoPanner === 'function') {
      pan = ctx.createStereoPanner()
      out = pan
    } else {
      out = ctx.createGain()
    }
    filter.connect(out)
    out.connect(this.buses.ui)

    const voice: FlatVoice = {
      gain, filter, pan, out, send,
      source: null, bus: this.buses.ui, active: false,
      priority: 0, startedAt: 0, stealDelay: 0,
      release: () => {},
    }
    voice.release = () => {
      if (voice.source) {
        try {
          voice.source.disconnect()
        } catch {
          // Already disconnected.
        }
        voice.source.onended = null
        voice.source = null
      }
      voice.active = false
    }
    return voice
  }

  // --- mix automation -----------------------------------------------------

  /** Broad duck used by explosions and the pause menu. */
  duck(amount: number, seconds: number): void {
    this.duckAmount = Math.min(1, Math.max(this.duckAmount, amount))
    this.duckRelease = Math.max(seconds, 0.05)
  }

  /** Fast sidechain trigger — every shot pushes the ambience bed down. */
  sidechain(amount = 1): void {
    this.fireDuck = Math.min(1, Math.max(this.fireDuck, amount))
  }

  /** Blast overpressure: tinnitus plus a heavy low-pass that recovers. */
  deafen(amount: number, seconds = 4): void {
    this.deaf = Math.min(1, Math.max(this.deaf, amount))
    this.deafRelease = Math.max(seconds, 0.5)
  }

  setZone(zone: ZoneName, fade = 0.7): void {
    this.reverb.setZone(zone, fade)
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(this.master.gain.value, now)
    this.master.gain.linearRampToValueAtTime(paused ? 0.18 : 0.85, now + 0.25)
  }

  setVoiceBudget(spatial: number, flat: number): void {
    this.maxVoices = spatial
    this.maxFlatVoices = flat
  }

  update(dt: number): void {
    if (dt > 0) {
      this.duckAmount = Math.max(0, this.duckAmount - dt / this.duckRelease)
      this.fireDuck *= Math.exp(-dt / 0.16)
      if (this.fireDuck < 0.002) this.fireDuck = 0
      this.deaf = Math.max(0, this.deaf - dt / this.deafRelease)
    }

    const now = this.ctx.currentTime
    const amb = (1 - 0.62 * this.fireDuck) * (1 - 0.8 * this.duckAmount)
    const world = 1 - 0.3 * this.duckAmount
    const game = 1 - 0.5 * this.deaf * this.deaf
    // Recovery is not linear: hearing comes back fast at first, then crawls.
    const deafHz = 20000 * Math.pow(0.017, Math.pow(this.deaf, 0.7))
    const ring = 0.055 * this.deaf * this.deaf

    if (Math.abs(amb - this.lastAmbGain) > 0.004) {
      this.ambienceDuck.gain.setTargetAtTime(amb, now, 0.05)
      this.lastAmbGain = amb
    }
    if (Math.abs(world - this.lastWorldGain) > 0.004) {
      this.buses.world.gain.setTargetAtTime(world, now, 0.06)
      this.lastWorldGain = world
    }
    if (Math.abs(game - this.lastGameGain) > 0.004) {
      this.gameGain.gain.setTargetAtTime(game, now, 0.08)
      this.lastGameGain = game
    }
    if (Math.abs(deafHz - this.lastDeafHz) > 20) {
      this.deafFilter.frequency.setTargetAtTime(Math.min(deafHz, this.ctx.sampleRate * 0.45), now, 0.1)
      this.lastDeafHz = deafHz
    }
    if (Math.abs(ring - this.lastTinnitus) > 0.001) {
      this.tinnitusGain.gain.setTargetAtTime(ring, now, 0.15)
      this.lastTinnitus = ring
    }
  }

  get activeVoices(): number {
    let n = 0
    for (const v of this.voices) if (v.active) n++
    for (const v of this.flatVoices) if (v.active) n++
    return n
  }

  dispose(): void {
    for (const osc of this.tinnitus) {
      try {
        osc.stop()
      } catch {
        // Never started.
      }
    }
    for (const v of this.voices) {
      try {
        v.source?.stop()
      } catch {
        // Already stopped.
      }
    }
    for (const v of this.flatVoices) {
      try {
        v.source?.stop()
      } catch {
        // Already stopped.
      }
    }
    this.reverb.dispose()
    this.entries.clear()
    this.clipCache.clear()
  }
}

/**
 * Air swallows the top end with distance. Roughly a halving of the cutoff every
 * 38 m, which is exaggerated versus physics but reads correctly on speakers.
 */
function airCutoff(dist: number): number {
  if (dist < 2) return 21000
  return Math.max(600, Math.min(21000, 21000 * Math.pow(0.5, dist / 38)))
}

/** Reverb falls off far more slowly than the direct path. */
function reverbFalloff(dist: number): number {
  return 1 / (1 + dist / 45)
}

function setPannerPosition(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    panner.positionX.value = x
    panner.positionY.value = y
    panner.positionZ.value = z
  } else {
    const legacy = panner as unknown as { setPosition?: (x: number, y: number, z: number) => void }
    legacy.setPosition?.(x, y, z)
  }
}
