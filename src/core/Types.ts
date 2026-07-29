import type * as THREE from 'three'
import type { EventBus } from './Events'
import type { Input } from './Input'
import type { Config } from './Config'

/**
 * Surface classification. Drives impact VFX, decals, footstep audio and
 * ballistic penetration. Every collidable mesh should set
 * `mesh.userData.surface` to one of these.
 */
export type Surface =
  | 'concrete'
  | 'metal'
  | 'thinMetal'
  | 'wood'
  | 'dirt'
  | 'sand'
  | 'gravel'
  | 'glass'
  | 'flesh'
  | 'water'
  | 'fabric'
  | 'plaster'
  | 'tile'
  | 'rubber'
  | 'foliage'

export type Team = 'player' | 'enemy'

/** Anything that can take damage. */
export interface Damageable {
  readonly id: number
  readonly team: Team
  health: number
  maxHealth: number
  alive: boolean
  position: THREE.Vector3
  applyDamage(amount: number, hit: HitInfo): void
}

export interface HitInfo {
  point: THREE.Vector3
  normal: THREE.Vector3
  direction: THREE.Vector3
  surface: Surface
  distance: number
  /** Bone/region that was struck, when the target is a character. */
  region?: 'head' | 'chest' | 'stomach' | 'arm' | 'leg'
  target?: Damageable
  /** Whether the ray had already passed through geometry. */
  penetrated?: boolean
}

/**
 * Shared service locator handed to every system. Systems must not reach for
 * globals; everything they need arrives here.
 */
export interface GameContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Separate scene rendered on top for the first-person viewmodel. */
  viewmodelScene: THREE.Scene
  viewmodelCamera: THREE.PerspectiveCamera
  input: Input
  events: EventBus
  config: Config
  /** Seconds since the game started, unaffected by pausing. */
  elapsed: number
  /** Registry of every live damageable entity, keyed by id. */
  entities: Map<number, Damageable>
  /** Set once each subsystem has registered itself. */
  services: Services
}

/**
 * Cross-system service handles. Each is assigned by its owning system during
 * init so other systems can call into it without importing concrete classes.
 */
export interface Services {
  physics?: PhysicsService
  audio?: AudioService
  fx?: FxService
  level?: LevelService
  ai?: AiService
  hud?: HudService
  weapons?: WeaponService
  player?: PlayerService
  materials?: MaterialService
  lighting?: LightingService
  postfx?: PostFxService
  prewarm?: PrewarmService
}

/**
 * Boot-time shader pre-warm.
 *
 * three compiles a material's shader the first time it is actually drawn, and
 * a compile costs tens to hundreds of milliseconds. Anything a system will only
 * put on screen later — pooled debris, a corpse's transparent materials, a
 * dropped magazine — must be handed over here during init, as a stand-in object
 * carrying the real geometry and material. The pre-warm presents them to the
 * compiler before the first frame and then drops them.
 */
export interface PrewarmService {
  /** Stand-ins that will appear in the world scene. */
  world(...objects: THREE.Object3D[]): void
  /** Stand-ins that will appear in the viewmodel scene. */
  viewmodel(...objects: THREE.Object3D[]): void
}

export interface RaycastHit {
  point: THREE.Vector3
  normal: THREE.Vector3
  distance: number
  surface: Surface
  object?: THREE.Object3D
  entity?: Damageable
}

export interface PhysicsService {
  /** Sweep a ray against static world + dynamic bodies. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, filter?: RaycastFilter): RaycastHit | null
  /** Sphere-cast used by the character controller and grenades. */
  sphereCast(origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number): RaycastHit | null
  /** Register a static mesh as world collision. */
  addStatic(mesh: THREE.Mesh, surface: Surface): void
  /** Spawn a dynamic rigid body (debris, ragdoll parts, physics props). */
  addDynamic(mesh: THREE.Mesh, opts: DynamicBodyOptions): DynamicBodyHandle
  removeBody(handle: DynamicBodyHandle): void
  applyRadialImpulse(center: THREE.Vector3, radius: number, strength: number): void
}

export interface RaycastFilter {
  ignore?: THREE.Object3D[]
  /** Skip entities on this team (used so AI does not shoot itself). */
  ignoreTeam?: Team
  characters?: boolean
}

export interface DynamicBodyOptions {
  mass: number
  shape: 'box' | 'sphere' | 'capsule' | 'convex'
  restitution?: number
  friction?: number
  linearDamping?: number
  angularDamping?: number
  ccd?: boolean
}

export type DynamicBodyHandle = { readonly _id: number }

export interface AudioService {
  /** Fire-and-forget positional one-shot. */
  play(id: string, position?: THREE.Vector3, opts?: PlayOptions): void
  /** Non-positional (UI, player weapon, music). */
  play2D(id: string, opts?: PlayOptions): void
  setListener(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void
  /** Ducks the mix for explosions / tinnitus. */
  duck(amount: number, seconds: number): void
  setReverbZone(zone: 'outdoor' | 'indoor' | 'tunnel' | 'hall'): void
}

export interface PlayOptions {
  volume?: number
  pitch?: number
  /** Distance in metres past which the sound is inaudible. */
  maxDistance?: number
  loop?: boolean
}

export interface FxService {
  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface): void
  bulletTracer(from: THREE.Vector3, to: THREE.Vector3, speed?: number): void
  muzzleFlash(matrix: THREE.Matrix4, scale: number, inViewmodelScene: boolean): void
  ejectShell(position: THREE.Vector3, velocity: THREE.Vector3, inViewmodelScene: boolean): void
  explosion(point: THREE.Vector3, radius: number): void
  blood(point: THREE.Vector3, normal: THREE.Vector3, amount: number): void
  smokePuff(point: THREE.Vector3, radius: number): void
}

export interface LevelService {
  /** Valid spawn points for enemies, in world space. */
  spawnPoints: THREE.Vector3[]
  playerSpawn: THREE.Vector3
  playerSpawnYaw: number
  /** Axis-aligned playable bounds; used to cull and to clamp the player. */
  bounds: THREE.Box3
  /** True when the point is inside a roofed volume (drives reverb + lighting). */
  isIndoors(point: THREE.Vector3): boolean
}

export interface AiService {
  enemies: Damageable[]
  spawnWave(count: number): void
  /** Called by the weapon system so AI can react to gunfire. */
  notifyNoise(position: THREE.Vector3, radius: number): void
}

export interface HudService {
  hitmarker(kind: 'normal' | 'headshot' | 'kill'): void
  killfeed(killer: string, victim: string, weapon: string, headshot: boolean): void
  damageDirection(worldDir: THREE.Vector3): void
  setAmmo(mag: number, reserve: number): void
  setWeaponName(name: string): void
  setHealth(fraction: number): void
  showMessage(text: string, seconds?: number): void
}

export interface WeaponService {
  currentName: string
  /** Fraction 0..1 of how far into aim-down-sights the player is. */
  adsFraction: number
  /** Additive camera recoil in radians, consumed by the camera rig. */
  recoilPitch: number
  recoilYaw: number
  isReloading: boolean
  isFiring: boolean
}

export interface PlayerService {
  position: THREE.Vector3
  velocity: THREE.Vector3
  /** Eye position used for raycasting and audio listener placement. */
  eye: THREE.Vector3
  yaw: number
  pitch: number
  onGround: boolean
  isSprinting: boolean
  isCrouching: boolean
  isSliding: boolean
  health: number
  /** Speed as a fraction of max run speed; drives head bob and FOV. */
  speedFraction: number
}

export interface MaterialService {
  /** Returns a cached, fully authored PBR material by name. */
  get(name: string): THREE.Material
  /** Every material the library can produce, for the material preview scene. */
  names(): string[]
}

export interface LightingService {
  sun: THREE.DirectionalLight
  /** Direction the sun points, normalised. */
  sunDirection: THREE.Vector3
  /** Sets time of day 0..1 where 0.25 is dawn and 0.75 is dusk. */
  setTimeOfDay(t: number): void
  environment: THREE.Texture | null
}

export interface PostFxService {
  render(dt: number): void
  resize(width: number, height: number): void
  /** Camera shake / hit flash hooks. */
  setDamageFlash(intensity: number): void
  setAdsBlur(fraction: number): void
}

/** Every subsystem implements this and is registered with the Engine. */
export interface System {
  readonly name: string
  init(ctx: GameContext): Promise<void> | void
  /**
   * Runs once after every system has finished `init`, before the first frame.
   * For work that needs the finished world rather than just the systems that
   * happen to be registered earlier — the shader pre-warm is the only user.
   */
  postInit?(ctx: GameContext): Promise<void> | void
  update?(dt: number, ctx: GameContext): void
  /** Runs after all update() passes; use for camera-dependent work. */
  lateUpdate?(dt: number, ctx: GameContext): void
  resize?(width: number, height: number): void
  dispose?(): void
}
