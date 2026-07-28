import * as THREE from 'three'
import type { FxTextureSet } from './FxTextures'

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

attribute vec4 aOrigin;   // xyz spawn position, w spawn time
attribute vec4 aVelLife;  // xyz initial velocity, w lifetime
attribute vec4 aParamA;   // drag, gravityScale, sizeStart, sizeEnd
attribute vec4 aParamB;   // rotation, rotationSpeed, turbulence, stretch
attribute vec4 aParamC;   // tile, frames, soft, erode
attribute vec4 aColA;     // rgb start, a start
attribute vec4 aColB;     // rgb end, a end

varying vec2  vUv;
varying vec4  vColor;
varying float vViewZ;
varying float vSoft;
varying float vErode;
varying vec4  vScreen;

void main() {
  vUv = vec2(0.0);
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

  float alpha = mix(aColA.a, aColB.a, u) * smoothstep(0.0, 0.055, u);
  vColor = vec4(mix(aColA.rgb, aColB.rgb, ease), alpha);
  vSoft = aParamC.z;
  vErode = aParamC.w * u;
  vViewZ = mv.z;

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

varying vec2  vUv;
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
  float alpha = shape * vColor.a;
  if (alpha <= 0.003) discard;

  float dist = -vViewZ;

#ifdef SOFT_PARTICLES
  if (vSoft > 0.0) {
    vec2 suv = vScreen.xy / vScreen.w * 0.5 + 0.5;
    float d = texture2D(uDepth, suv).x;
    // Non-linear depth to view space; both values are negative.
    float sceneZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
    alpha *= clamp((vViewZ - sceneZ) / vSoft, 0.0, 1.0);
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
          uTime: { value: 0 },
          uNear: { value: 0.06 },
          uFar: { value: 900 },
          uGravity: { value: new THREE.Vector3(0, -9.81, 0) },
          uSheet: { value: new THREE.Vector2(4, 4) },
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
    this.geometry.instanceCount = this.wrapped ? this.capacity : this.head
    this.material.uniforms.uTime.value = time
  }

  setDepth(depth: THREE.Texture | null, near: number, far: number): void {
    this.material.uniforms.uDepth.value = depth
    this.material.uniforms.uNear.value = near
    this.material.uniforms.uFar.value = far
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

export class Particles {
  /** Shared scratch used by every emitter; never allocate to spawn. */
  readonly p = new ParticleParams()

  private readonly groups = new Map<GroupKey, ParticleGroup>()
  private readonly root = new THREE.Group()
  /** Latest time at which a depth-fading particle is still alive. */
  private softUntil = -1

  constructor(scene: THREE.Scene, budget: number, textures: FxTextureSet, soft: boolean) {
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

  emit(key: GroupKey, time: number): void {
    const g = this.groups.get(key)
    if (!g) return
    g.emit(this.p, time)
    if (this.p.soft > 0) {
      const until = time + this.p.life
      if (until > this.softUntil) this.softUntil = until
    }
  }

  /** True while any depth-fading particle is alive, so the prepass can idle. */
  needsDepth(time: number): boolean {
    return time < this.softUntil
  }

  update(time: number): void {
    for (const g of this.groups.values()) g.flush(time)
  }

  setDepth(depth: THREE.Texture | null, near: number, far: number): void {
    for (const g of this.groups.values()) g.setDepth(depth, near, far)
  }

  setVisible(v: boolean): void {
    this.root.visible = v
  }

  dispose(): void {
    for (const g of this.groups.values()) g.dispose()
    this.root.removeFromParent()
  }
}
