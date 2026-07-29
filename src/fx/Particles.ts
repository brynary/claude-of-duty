import * as THREE from 'three'
import { SMOKE_MASK_FILL, type FxTextureSet } from './FxTextures'

/**
 * One GPU-driven, pooled, instanced particle system.
 *
 * Simulation is analytic and lives entirely in the vertex shader: a particle's
 * whole trajectory is a closed-form function of `uTime - spawnTime`, given
 * initial velocity, linear drag, gravity and a turbulence amplitude. The CPU
 * therefore does *no* per-frame work at all — it writes seven vec4s once when a
 * particle is born and never touches it again. That is what makes tens of
 * thousands of particles free.
 *
 * Storage is a ring buffer, so exceeding the budget recycles the oldest
 * particle, which is exactly the behaviour we want under sustained fire.
 */

export type GroupKey = 'smoke' | 'smokeAdd' | 'sprite' | 'spriteAdd'

/**
 * Shared, mutable spawn description. Callers do `params.reset()`, fill in what
 * they care about and call `emit()`. Nothing is allocated on the hot path.
 */
export class ParticleParams {
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  readonly colorStart = new THREE.Color(1, 1, 1)
  readonly colorEnd = new THREE.Color(1, 1, 1)
  alphaStart = 1
  alphaEnd = 0
  life = 1
  sizeStart = 0.2
  sizeEnd = 0.4
  /** Linear drag coefficient, 1/s. Air is roughly 0.6, dense smoke 3+. */
  drag = 1.2
  /** Multiplier on world gravity. Negative makes hot gas rise. */
  gravity = 0
  rotation = 0
  rotationSpeed = 0
  /** Metres of curl displacement per second of life. */
  turbulence = 0
  /** Velocity-aligned elongation; 0 keeps the quad round. */
  stretch = 0
  /** Sprite atlas tile, or first frame for animated sheets. */
  tile = 0
  /** Frames consumed over the particle's life. 1 = static sprite. */
  frames = 1
  /** Soft-particle fade distance in metres. 0 disables the depth fade. */
  soft = 0.4
  /** Dissolve strength: the alpha threshold climbs to this over the life. */
  erode = 0

  reset(): this {
    this.position.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
    this.colorStart.setRGB(1, 1, 1)
    this.colorEnd.setRGB(1, 1, 1)
    this.alphaStart = 1
    this.alphaEnd = 0
    this.life = 1
    this.sizeStart = 0.2
    this.sizeEnd = 0.4
    this.drag = 1.2
    this.gravity = 0
    this.rotation = 0
    this.rotationSpeed = 0
    this.turbulence = 0
    this.stretch = 0
    this.tile = 0
    this.frames = 1
    this.soft = 0.4
    this.erode = 0
    return this
  }
}

const VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3  uGravity;
uniform vec2  uSheet;
/**
 * x = projected half-extent (in NDC half-height units) at which a card starts
 * fading, y = the extent it may never exceed. Set y to 0 to disable. This is
 * what stops a single billboard from becoming a full-screen wash when the
 * camera walks into it, which is the failure that veils the near field and
 * flattens local contrast across half the frame.
 */
uniform vec2  uScreenLimit;
/**
 * Global opacity for this group, 0..1. The coverage ledger drives it every
 * frame so the *rendered* smoke load is clamped rather than merely discouraged.
 * A spawn-time throttle cannot undo a veil that has already accumulated — and
 * because a card lives for seconds, a spawn-time throttle is a proportional
 * controller with a two-second transport delay, which limit-cycles: the frame
 * gets captured at whatever point in the cycle it lands on. This is the same
 * budget applied where it cannot be late.
 */
uniform float uOpacity;
/**
 * x = distance at which a cloud card is fully gone, y = fully present. Cloud
 * cards spawned inside arm's reach are never readable as volume and are the
 * single largest contributor to near-field haze, so they are simply not drawn.
 */
uniform vec2  uNearFade;

attribute vec4 aOrigin;   // xyz spawn position, w spawn time
attribute vec4 aVelLife;  // xyz initial velocity, w lifetime
attribute vec4 aParamA;   // drag, gravityScale, sizeStart, sizeEnd
attribute vec4 aParamB;   // rotation, rotationSpeed, turbulence, stretch
attribute vec4 aParamC;   // tile, frames, soft, erode
attribute vec4 aColA;     // rgb start, a start
attribute vec4 aColB;     // rgb end, a end

varying vec2  vUv;
varying vec2  vQuad;
varying vec4  vColor;
varying float vViewZ;
varying float vSoft;
varying float vErode;
varying vec4  vScreen;

void main() {
  vUv = vec2(0.0);
  vQuad = vec2(0.0);
  vColor = vec4(0.0);
  vViewZ = -1.0;
  vSoft = 0.0;
  vErode = 0.0;
  vScreen = vec4(0.0, 0.0, 1.0, 1.0);

  float life = aVelLife.w;
  float t = uTime - aOrigin.w;
  if (life <= 0.0 || t < 0.0 || t >= life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float u = t / life;

  // Closed-form integration of dv/dt = -k v + g.
  float k = max(aParamA.x, 0.0025);
  float decay = (1.0 - exp(-k * t)) / k;
  vec3 g = uGravity * aParamA.y;
  vec3 p = aOrigin.xyz + aVelLife.xyz * decay + g * ((t - decay) / k);

  float turb = aParamB.z;
  if (turb > 0.0) {
    vec3 q = p * 1.15 + uTime * 0.31 + aOrigin.w;
    vec3 curl = vec3(
      sin(q.y * 1.7) + 0.5 * sin(q.z * 3.1 + 1.7),
      sin(q.z * 1.9) + 0.5 * sin(q.x * 2.7 + 0.9),
      sin(q.x * 2.1) + 0.5 * sin(q.y * 3.3 + 2.3));
    p += curl * (turb * t * 0.34);
  }

  float ease = u * u * (3.0 - 2.0 * u);
  float size = mix(aParamA.z, aParamA.w, ease);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // --- screen coverage limit ------------------------------------------------
  // Projected half-extent as a fraction of half the viewport height. A card
  // thins out as it grows past the fade point and is gone by the cap, so a puff
  // the camera walks into disappears instead of smearing a translucent sheet
  // over the whole frame.
  float viewDist = max(-mv.z, 1e-4);
  float cover = uOpacity;
  if (uScreenLimit.y > 0.0) {
    float projHalf = size * 0.5 * projectionMatrix[1][1] / viewDist;
    cover *= 1.0 - smoothstep(uScreenLimit.x, uScreenLimit.y, projHalf);
  }
  if (uNearFade.y > uNearFade.x) {
    cover *= smoothstep(uNearFade.x, uNearFade.y, viewDist);
  }
  if (cover <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 corner = position.xy;
  float rot = aParamB.x + aParamB.y * t;
  float cr = cos(rot);
  float sr = sin(rot);
  vec2 rc = vec2(corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr) * size;

  float stretch = aParamB.w;
  if (stretch > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(aVelLife.xyz * exp(-k * t), 0.0)).xyz;
    float len = length(vv.xy);
    if (len > 1e-4) {
      vec2 dir = vv.xy / len;
      vec2 c2 = vec2(corner.x, corner.y * (1.0 + stretch * min(len, 60.0))) * size;
      rc = vec2(c2.x * dir.y + c2.y * dir.x, -c2.x * dir.x + c2.y * dir.y);
    }
  }
  mv.xy += rc;

  float cells = uSheet.x * uSheet.y;
  float frames = aParamC.y;
  float tf = aParamC.x;
  if (frames > 1.0) tf = min(tf + floor(u * frames), cells - 1.0);
  vec2 cell = vec2(mod(tf, uSheet.x), floor(tf / uSheet.x));
  vUv = vec2((uv.x + cell.x) / uSheet.x, 1.0 - (cell.y + 1.0 - uv.y) / uSheet.y);

  // Fade in at birth and out at death. The tail fade is unconditional: solid
  // debris is authored to stay opaque for its whole life so it reads as a
  // fragment rather than a ghost, and without this it simply blinks out — which
  // in a frozen capture means a frame full of full-opacity flecks.
  float alpha = mix(aColA.a, aColB.a, u)
    * smoothstep(0.0, 0.055, u)
    * (1.0 - smoothstep(0.74, 1.0, u))
    * cover;
  vColor = vec4(mix(aColA.rgb, aColB.rgb, ease), alpha);
  // A big card needs a correspondingly long depth fade, otherwise a 1.5m puff
  // still cuts a visible line where it meets the floor.
  vSoft = aParamC.z > 0.0 ? aParamC.z + size * 0.45 : 0.0;
  vErode = aParamC.w * u;
  vViewZ = mv.z;
  vQuad = uv - 0.5;

  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D map;
uniform sampler2D uDepth;
uniform float uNear;
uniform float uFar;
uniform float uHasDepth;

varying vec2  vUv;
varying vec2  vQuad;
varying vec4  vColor;
varying float vViewZ;
varying float vSoft;
varying float vErode;
varying vec4  vScreen;

#ifdef USE_FOG
uniform vec3 fogColor;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif

void main() {
  vec4 texel = texture2D(map, vUv);
  float mask = texel.a;
  // Dissolve: raising the threshold over life eats the puff from its thin
  // edges inward, which is how real smoke thins out.
  float shape = (vErode > 0.0) ? smoothstep(vErode, vErode + 0.34, mask) : mask;
  // Guarantee the card silhouette is never the quad. Mip bleed, anisotropic
  // taps across atlas cells and a mask that survives to the tile border all
  // end in the same tell: a straight polygon edge across the scene.
  shape *= 1.0 - smoothstep(0.46, 0.5, length(vQuad));
  float alpha = shape * vColor.a;
  if (alpha <= 0.003) discard;

  float dist = -vViewZ;

#ifdef SOFT_PARTICLES
  if (vSoft > 0.0 && uHasDepth > 0.5) {
    vec2 suv = vScreen.xy / vScreen.w * 0.5 + 0.5;
    float d = texture2D(uDepth, suv).x;
    // Non-linear depth to view space; both values are negative.
    float sceneZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
    // Squared so the card leans hard away from the surface it is crossing;
    // a linear ramp still leaves a readable seam on a large puff.
    float fade = clamp((vViewZ - sceneZ) / vSoft, 0.0, 1.0);
    alpha *= fade * fade * (3.0 - 2.0 * fade);
  }
#endif

  // Never let a particle slam into the near plane as a full-screen wash.
  alpha *= smoothstep(0.0, 0.28, dist - uNear * 2.0);

  vec3 colour = vColor.rgb * texel.rgb;

#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, dist);
  #endif
  #ifdef ADDITIVE_BLEND
    alpha *= 1.0 - fogFactor;
  #else
    colour = mix(colour, fogColor, fogFactor);
  #endif
#endif

  gl_FragColor = vec4(colour, alpha);
}
`

const STRIDE = 4

/** One instanced draw call: a texture, a blend mode and a ring of slots. */
class ParticleGroup {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly attrs: THREE.InstancedBufferAttribute[] = []
  private readonly data: Float32Array[] = []
  readonly capacity: number
  private head = 0
  private wrapped = false
  private dirtyMin = Infinity
  private dirtyMax = -Infinity

  constructor(capacity: number, map: THREE.Texture, additive: boolean, soft: boolean, renderOrder: number) {
    this.capacity = capacity

    const quad = new THREE.PlaneGeometry(1, 1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    geo.instanceCount = 0

    const names = ['aOrigin', 'aVelLife', 'aParamA', 'aParamB', 'aParamC', 'aColA', 'aColB']
    for (const name of names) {
      const arr = new Float32Array(capacity * STRIDE)
      const attr = new THREE.InstancedBufferAttribute(arr, STRIDE)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, attr)
      this.attrs.push(attr)
      this.data.push(arr)
    }
    // The ring never has a meaningful bounding volume; cull manually instead.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometry = geo

    const defines: Record<string, string> = {}
    if (additive) defines.ADDITIVE_BLEND = ''
    if (soft) defines.SOFT_PARTICLES = ''

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          map: { value: null },
          uDepth: { value: null },
          uHasDepth: { value: 0 },
          uTime: { value: 0 },
          uNear: { value: 0.06 },
          uFar: { value: 900 },
          uGravity: { value: new THREE.Vector3(0, -9.81, 0) },
          uSheet: { value: new THREE.Vector2(4, 4) },
          uScreenLimit: { value: new THREE.Vector2(0, 0) },
          uOpacity: { value: 1 },
          uNearFade: { value: new THREE.Vector2(0, 0) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    })
    this.material.uniforms.map.value = map

    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
    this.mesh.matrixAutoUpdate = false
    this.mesh.name = 'fx-particles'
  }

  emit(p: ParticleParams, time: number): void {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    if (this.head === 0) this.wrapped = true
    const o = i * STRIDE
    const d = this.data

    d[0][o] = p.position.x; d[0][o + 1] = p.position.y; d[0][o + 2] = p.position.z; d[0][o + 3] = time
    d[1][o] = p.velocity.x; d[1][o + 1] = p.velocity.y; d[1][o + 2] = p.velocity.z; d[1][o + 3] = p.life
    d[2][o] = p.drag; d[2][o + 1] = p.gravity; d[2][o + 2] = p.sizeStart; d[2][o + 3] = p.sizeEnd
    d[3][o] = p.rotation; d[3][o + 1] = p.rotationSpeed; d[3][o + 2] = p.turbulence; d[3][o + 3] = p.stretch
    d[4][o] = p.tile; d[4][o + 1] = p.frames; d[4][o + 2] = p.soft; d[4][o + 3] = p.erode
    d[5][o] = p.colorStart.r; d[5][o + 1] = p.colorStart.g; d[5][o + 2] = p.colorStart.b; d[5][o + 3] = p.alphaStart
    d[6][o] = p.colorEnd.r; d[6][o + 1] = p.colorEnd.g; d[6][o + 2] = p.colorEnd.b; d[6][o + 3] = p.alphaEnd

    if (i < this.dirtyMin) this.dirtyMin = i
    if (i > this.dirtyMax) this.dirtyMax = i
  }

  flush(time: number): void {
    if (this.dirtyMax >= this.dirtyMin) {
      const start = this.dirtyMin * STRIDE
      const count = (this.dirtyMax - this.dirtyMin + 1) * STRIDE
      for (const a of this.attrs) {
        a.clearUpdateRanges()
        a.addUpdateRange(start, count)
        a.needsUpdate = true
      }
      this.dirtyMin = Infinity
      this.dirtyMax = -Infinity
    }
    this.geometry.instanceCount = Math.max(this.wrapped ? this.capacity : this.head, this.warmHold ? 1 : 0)
    this.material.uniforms.uTime.value = time
  }

  /**
   * Holds one instance in the draw while the boot screen is up. The pipeline
   * for this group is created on its first executed draw, not at compile, and
   * a pool that idles at instanceCount 0 never executes one until the first
   * shot of the match — which is the frame that then pays 15-80ms of pipeline
   * creation. Slot 0 is zero-filled, so the held instance has life 0 and the
   * vertex shader parks it outside clip space: no fragment is ever produced.
   */
  private warmHold = false
  warmDraw(on: boolean): void {
    this.warmHold = on
  }

  setDepth(depth: THREE.Texture | null, near: number, far: number): void {
    this.material.uniforms.uDepth.value = depth
    this.material.uniforms.uHasDepth.value = depth ? 1 : 0
    this.material.uniforms.uNear.value = near
    this.material.uniforms.uFar.value = far
  }

  setScreenLimit(fadeStart: number, cap: number): void {
    ;(this.material.uniforms.uScreenLimit.value as THREE.Vector2).set(fadeStart, cap)
  }

  setOpacity(v: number): void {
    this.material.uniforms.uOpacity.value = v
  }

  setNearFade(hidden: number, visible: number): void {
    ;(this.material.uniforms.uNearFade.value as THREE.Vector2).set(hidden, visible)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * Slots in the coverage ledger. Every live cloud card needs one: a slot that
 * gets recycled while its card is still alive is coverage the ledger stops
 * seeing, and undercounting is exactly the failure mode that lets a veil build.
 * Five seconds of a seven-shooter firefight fits inside this.
 */
const LEDGER = 4096
/**
 * Cards covering less of the frame than this are not tracked. It exists to keep
 * the ledger's slots for the cards that can actually veil the frame: a 2cm chip
 * at 2.5m is 4e-6 of the frame and there are hundreds of them, while a 0.5m
 * dust puff at 5m is 8e-5 and there are hundreds of those too — one group is
 * the problem and the other is rounding error.
 */
const LEDGER_FLOOR = 2e-6
/** Groups the coverage budget governs. Hard effects are not clouds. */
const CLOUD_GROUPS: readonly GroupKey[] = ['smoke', 'smokeAdd']

export class Particles {
  /** Shared scratch used by every emitter; never allocate to spawn. */
  readonly p = new ParticleParams()

  private readonly groups = new Map<GroupKey, ParticleGroup>()
  private readonly root = new THREE.Group()
  /** Latest time at which a depth-fading particle is still alive. */
  private softUntil = -1

  // --- screen coverage ledger ------------------------------------------------
  // `uScreenLimit` stops one card from owning the frame. Nothing stopped a
  // thousand of them from owning it together, which is exactly what a squad
  // firing twenty rounds a second produces: every round spawns a fresh handful
  // of half-metre dust puffs, they pool, and the frame ends up behind a
  // translucent sheet with no blacks and no white point. This tracks how much
  // of the frame live translucent cards already cover so emitters can back off.
  private readonly ledgerExpiry = new Float32Array(LEDGER)
  private readonly ledgerAmount = new Float32Array(LEDGER)
  private ledgerHead = 0
  private coverage = 0
  /** Low-passed `coverage`, so the spawn throttle cannot chase its own tail. */
  private smoothed = 0
  /** Live opacity multiplier on the cloud groups. */
  private gain = 1
  private readonly viewpoint = new THREE.Vector3()
  /** projectionMatrix[1][1], i.e. 1 / tan(vfov / 2). */
  private focal = 1.19
  private aspect = 16 / 9
  private readonly budget: number
  private screenFade = 0
  private screenCap = 0

  constructor(scene: THREE.Scene, budget: number, textures: FxTextureSet, soft: boolean, coverageBudget = 0.030) {
    this.budget = Math.max(1e-4, coverageBudget)
    const clamp = (n: number) => Math.max(48, Math.floor(n))
    const specs: [GroupKey, THREE.Texture, boolean, number, number][] = [
      ['smoke', textures.smokeSheet, false, clamp(budget * 0.30), 10],
      ['sprite', textures.sprites, false, clamp(budget * 0.34), 11],
      ['spriteAdd', textures.sprites, true, clamp(budget * 0.28), 13],
      ['smokeAdd', textures.smokeSheet, true, clamp(budget * 0.08), 12],
    ]
    for (const [key, map, additive, cap, order] of specs) {
      const g = new ParticleGroup(cap, map, additive, soft, order)
      this.groups.set(key, g)
      this.root.add(g.mesh)
    }
    this.root.name = 'fx-particle-root'
    this.root.matrixAutoUpdate = false
    scene.add(this.root)
  }

  /** Resets and returns the shared spawn description. */
  get params(): ParticleParams {
    return this.p.reset()
  }

  /** See ParticleGroup.warmDraw: one dead instance per group during boot. */
  warmDraw(on: boolean): void {
    for (const g of this.groups.values()) g.warmDraw(on)
  }

  emit(key: GroupKey, time: number): void {
    const g = this.groups.get(key)
    if (!g) return
    const p = this.p
    g.emit(p, time)
    if (p.soft > 0) {
      const until = time + p.life
      if (until > this.softUntil) this.softUntil = until
    }
    // Only cloud cards are costed, because only cloud cards are clamped. The
    // ledger and the clamp have to govern the same population or the clamp
    // corrects for coverage it cannot remove.
    if (key === 'smoke' || key === 'smokeAdd') this.charge(p, time)
  }

  /** True while any depth-fading particle is alive, so the prepass can idle. */
  needsDepth(time: number): boolean {
    return time < this.softUntil
  }

  update(time: number): void {
    for (const g of this.groups.values()) g.flush(time)
    this.settle(time)

    // Clamp what is *drawn*, not just what is spawned. `coverage` is the
    // estimated fraction of the frame live cloud cards will cover; if that is
    // over budget, every cloud card is thinned by exactly the ratio that brings
    // it back. The result is a hard ceiling on the veil that does not depend on
    // guessing an emission rate, and it holds no matter how many emitters exist
    // or how long the fight has been running.
    const want = this.coverage > this.budget ? this.budget / this.coverage : 1
    // Smoothed so the frame does not pulse; converges inside the frozen tail
    // the capture harness renders before it reads pixels.
    this.gain += (want - this.gain) * 0.3
    this.smoothed += (this.coverage - this.smoothed) * 0.2
    for (const key of CLOUD_GROUPS) this.groups.get(key)?.setOpacity(this.gain)
  }

  // --- screen coverage ledger ------------------------------------------------

  /**
   * Where the frame is being viewed from, so a card's screen coverage can be
   * costed at the moment it is spawned. One call per frame; being a frame stale
   * is irrelevant at these magnitudes.
   */
  setViewpoint(position: THREE.Vector3, focal: number, aspect: number): void {
    this.viewpoint.copy(position)
    this.focal = focal
    this.aspect = aspect
  }

  /**
   * The fraction of the frame this card will cover, averaged over its life —
   * that is, its contribution to the frame's mean alpha.
   *
   * The quad spans `size` metres, so at distance `d` it spans `size * f / d` in
   * NDC half-height units, of a box whose area in those units is `4 * aspect`.
   * `SMOKE_MASK_FILL` is the measured mean alpha of a smoke cell — the mask is
   * nowhere near solid across its own quad and assuming it is over-costs every
   * card by a factor of two. `0.82` is the integral of the birth and death
   * fades the vertex shader applies. The screen-size cap is folded in as well,
   * so a card the cap is already erasing is not charged for coverage it never
   * gets to draw.
   */
  private coverageOf(p: ParticleParams): number {
    const dist = this.viewpoint.distanceTo(p.position)
    if (dist < 0.05) return 0
    const size = (p.sizeStart + p.sizeEnd) * 0.5
    const span = size * this.focal / dist
    let cover = 1
    if (this.screenCap > this.screenFade) {
      const t = (span * 0.5 - this.screenFade) / (this.screenCap - this.screenFade)
      const c = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
      cover = 1 - c
      if (cover <= 0) return 0
    }
    const alpha = (p.alphaStart + p.alphaEnd) * 0.5 * 0.82
    return (span * span) / (4 * this.aspect) * alpha * SMOKE_MASK_FILL * cover
  }

  private charge(p: ParticleParams, time: number): void {
    const amount = this.coverageOf(p)
    if (amount < LEDGER_FLOOR) return
    const i = this.ledgerHead
    this.ledgerHead = (this.ledgerHead + 1) % LEDGER
    this.coverage += amount - this.ledgerAmount[i]
    this.ledgerAmount[i] = amount
    this.ledgerExpiry[i] = time + p.life
  }

  /** Retires expired entries. Fixed cost, no allocation, once per frame. */
  private settle(time: number): void {
    let sum = 0
    for (let i = 0; i < LEDGER; i++) {
      if (this.ledgerAmount[i] === 0) continue
      if (this.ledgerExpiry[i] <= time) {
        this.ledgerAmount[i] = 0
        continue
      }
      sum += this.ledgerAmount[i]
    }
    this.coverage = sum
  }

  /** How much of the frame live translucent cards already cover, 0..n. */
  get load(): number {
    return this.coverage
  }

  /**
   * The multiplier an emitter should fold into the count of any *cloud* layer —
   * dust, propellant smoke, haze. It is 1 while the frame is clear and reaches
   * zero once the budget is full, so a firefight with seven shooters produces a
   * scene with smoke in it rather than a scene behind smoke. Hard effects
   * (sparks, chips, decals) ignore it: they are what makes the impact read, and
   * they cost almost nothing in coverage.
   *
   * It reads the *smoothed* load rather than the instantaneous one. A cloud
   * card lives for seconds, so throttling on the raw figure is a proportional
   * controller with a multi-second transport delay and it limit-cycles — the
   * frame ends up either bare or buried depending on where in the cycle the
   * shutter falls. The rendered clamp in `update` is what actually guarantees
   * the ceiling; this only keeps the fill rate sensible.
   */
  allowance(): number {
    const k = 1 - this.smoothed / this.budget
    return k < 0 ? 0 : k > 1 ? 1 : k
  }

  setDepth(depth: THREE.Texture | null, near: number, far: number): void {
    for (const g of this.groups.values()) g.setDepth(depth, near, far)
  }

  /**
   * Caps how much of the frame any one card may cover, in NDC half-height
   * units — 0.36 is roughly a fifth of the screen width at 16:9. Pass a cap of
   * 0 to disable, which is what the viewmodel scene wants: its muzzle flash
   * lives 40cm from the lens and is *supposed* to be large.
   */
  setScreenLimit(fadeStart: number, cap: number): void {
    this.screenFade = fadeStart
    this.screenCap = cap
    for (const g of this.groups.values()) g.setScreenLimit(fadeStart, cap)
  }

  /**
   * Distance band over which cloud cards fade in. Everything closer than
   * `hidden` is not drawn at all: a dust puff one metre from the lens is never
   * legible as volume, it is only a translucent sheet across the sharpest part
   * of the frame, and it is the dominant term in the near-field haze figure.
   */
  setCloudNearFade(hidden: number, visible: number): void {
    for (const key of CLOUD_GROUPS) this.groups.get(key)?.setNearFade(hidden, visible)
  }

  setVisible(v: boolean): void {
    this.root.visible = v
  }

  dispose(): void {
    for (const g of this.groups.values()) g.dispose()
    this.root.removeFromParent()
  }
}
