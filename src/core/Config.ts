/**
 * Runtime tunables. Read from URL query so the screenshot harness can drive
 * deterministic captures, e.g. `?quality=ultra&pose=alley&freeze=3.5`.
 */
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra'

export interface Config {
  quality: QualityLevel
  /** Device pixel ratio cap. */
  maxPixelRatio: number

  // --- Post processing toggles, resolved from `quality` ---
  taa: boolean
  ssao: boolean
  ssr: boolean
  bloom: boolean
  motionBlur: boolean
  volumetricLight: boolean
  depthOfField: boolean
  filmGrain: boolean
  chromaticAberration: boolean
  sharpen: boolean

  shadowMapSize: number
  /** Number of cascades in the shadow cascade. */
  shadowCascades: number
  shadowDistance: number

  anisotropy: number
  /** Instanced foliage/debris density multiplier. */
  detailDensity: number
  particleBudget: number
  decalBudget: number

  // --- Gameplay / capture ---
  fov: number
  adsFovScale: number
  sensitivity: number

  /** Non-empty when the screenshot harness is driving a fixed camera pose. */
  pose: string | null
  /** When set, the sim advances to this time then holds still. */
  freezeAt: number | null
  /** Hide the HUD (used for pure-render critic passes). */
  hideHud: boolean
  /** Skip the menu and drop straight into play. */
  autoStart: boolean
  /** Deterministic seed for all procedural generation. */
  seed: number
  /** Show the frame-time / draw-call overlay. */
  stats: boolean

  // --- Play harness ---
  /**
   * Name of a scripted scenario to run instead of taking human input. The
   * synthetic player in PlayBot drives the ordinary Input surface, so the real
   * controller, weapons and AI all run exactly as they do for a person.
   */
  bot: string | null
  /** Skill profile for the synthetic player. */
  botSkill: string
  /**
   * Advance the simulation by a fixed timestep regardless of wall clock. Real
   * frame times make a run unreproducible; this makes a seed plus an input log
   * replay identically.
   */
  fixedStep: boolean
  /** Simulated seconds to run before reporting telemetry and stopping. */
  runSeconds: number
  /** Record the per-frame input stream for deterministic replay. */
  record: boolean
}

const PRESETS: Record<QualityLevel, Partial<Config>> = {
  low: {
    maxPixelRatio: 1,
    taa: false, ssao: false, ssr: false, bloom: true, motionBlur: false,
    volumetricLight: false, depthOfField: false, filmGrain: false,
    chromaticAberration: false, sharpen: false,
    shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 60,
    anisotropy: 4, detailDensity: 0.35, particleBudget: 1500, decalBudget: 64,
  },
  medium: {
    maxPixelRatio: 1.25,
    taa: true, ssao: true, ssr: false, bloom: true, motionBlur: false,
    volumetricLight: true, depthOfField: false, filmGrain: true,
    chromaticAberration: true, sharpen: true,
    shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 100,
    anisotropy: 8, detailDensity: 0.6, particleBudget: 4000, decalBudget: 128,
  },
  high: {
    maxPixelRatio: 1.5,
    taa: true, ssao: true, ssr: true, bloom: true, motionBlur: true,
    volumetricLight: true, depthOfField: true, filmGrain: true,
    chromaticAberration: true, sharpen: true,
    shadowMapSize: 2048, shadowCascades: 4, shadowDistance: 150,
    anisotropy: 16, detailDensity: 1.0, particleBudget: 8000, decalBudget: 256,
  },
  ultra: {
    maxPixelRatio: 2,
    taa: true, ssao: true, ssr: true, bloom: true, motionBlur: true,
    volumetricLight: true, depthOfField: true, filmGrain: true,
    chromaticAberration: true, sharpen: true,
    shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 220,
    anisotropy: 16, detailDensity: 1.6, particleBudget: 16000, decalBudget: 512,
  },
}

/**
 * Freeze time per pose. Duplicated from Poses.ts rather than imported so that
 * config resolution stays free of three.js and can run before the renderer.
 */
const POSE_FREEZE: Record<string, number> = {
  alley: 2.5, plaza: 2.5, interior: 3.0, weapon: 4.0,
  ads: 5.0, firefight: 6.5, vista: 2.5, sunset: 2.5,
}

export function createConfig(search = globalThis.location?.search ?? ''): Config {
  const q = new URLSearchParams(search)
  const quality = (q.get('quality') as QualityLevel) || 'ultra'

  const base: Config = {
    quality,
    maxPixelRatio: 2,
    taa: true, ssao: true, ssr: true, bloom: true, motionBlur: true,
    volumetricLight: true, depthOfField: true, filmGrain: true,
    chromaticAberration: true, sharpen: true,
    shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 220,
    anisotropy: 16, detailDensity: 1.6, particleBudget: 16000, decalBudget: 512,
    fov: 80,
    adsFovScale: 0.55,
    sensitivity: 0.0022,
    pose: q.get('pose'),
    freezeAt: q.has('freeze') ? Number(q.get('freeze')) : null,
    hideHud: q.get('hud') === '0',
    autoStart: q.get('autostart') === '1' || q.has('pose'),
    seed: q.has('seed') ? Number(q.get('seed')) : 1337,
    stats: q.get('stats') === '1',
    bot: q.get('bot'),
    botSkill: q.get('skill') ?? 'average',
    fixedStep: q.get('fixed') === '1' || q.has('bot'),
    runSeconds: q.has('run') ? Number(q.get('run')) : 60,
    record: q.get('record') === '1',
  }

  Object.assign(base, PRESETS[quality] ?? PRESETS.ultra)
  base.quality = quality in PRESETS ? quality : 'ultra'

  // Explicit overrides win over the preset, e.g. `&ssr=0`.
  const bools: (keyof Config)[] = [
    'taa', 'ssao', 'ssr', 'bloom', 'motionBlur', 'volumetricLight',
    'depthOfField', 'filmGrain', 'chromaticAberration', 'sharpen',
  ]
  for (const k of bools) {
    const v = q.get(k)
    if (v !== null) (base as unknown as Record<string, unknown>)[k] = v === '1' || v === 'true'
  }
  if (q.has('fov')) base.fov = Number(q.get('fov'))
  if (q.has('dpr')) base.maxPixelRatio = Number(q.get('dpr'))

  // A named pose implies its own freeze time unless one was given explicitly.
  if (base.pose && base.freezeAt === null) {
    base.freezeAt = POSE_FREEZE[base.pose] ?? 2.5
  }

  return base
}
