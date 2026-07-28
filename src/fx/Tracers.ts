import * as THREE from 'three'

/**
 * Bullet tracers.
 *
 * A tracer is a stretched, additive, view-aligned ribbon whose head travels
 * from muzzle to impact at a plausible speed — not an instant line. The ribbon
 * has a hot near-white core and a warm falloff, and it is a pure emitter: it
 * writes no depth and lights nothing, so it reads cleanly against both sky and
 * deep shadow without washing out the scene.
 *
 * Everything is a single instanced draw whose geometry is generated on the GPU
 * from a spawn record, so a tracer costs one attribute write and nothing more.
 */

const VERT = /* glsl */ `
precision highp float;

uniform float uTime;

attribute vec4 aStart;   // xyz muzzle position, w spawn time
attribute vec4 aDir;     // xyz unit direction, w speed (m/s)
attribute vec4 aParams;  // total distance, trail length, half width, life

varying vec2  vUv;
varying float vFade;
varying float vHot;
varying float vDist;
varying vec4  vScreen;
varying float vViewZ;

void main() {
  vUv = uv;
  vFade = 0.0;
  vHot = 0.0;
  vDist = 0.0;
  vScreen = vec4(0.0, 0.0, 1.0, 1.0);
  vViewZ = -1.0;

  float life = aParams.w;
  float t = uTime - aStart.w;
  if (life <= 0.0 || t < 0.0 || t >= life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float total = aParams.x;
  float trail = aParams.y;
  float travel = aDir.w * t;
  if (travel - trail > total) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 head = aStart.xyz + aDir.xyz * min(travel, total);
  vec3 tail = aStart.xyz + aDir.xyz * clamp(travel - trail, 0.0, total);

  vec3 hv = (modelViewMatrix * vec4(head, 1.0)).xyz;
  vec3 tv = (modelViewMatrix * vec4(tail, 1.0)).xyz;

  vec3 axis = hv - tv;
  vec2 planar = axis.xy;
  float len = length(planar);
  vec2 perp = len > 1e-5 ? vec2(-planar.y, planar.x) / len : vec2(1.0, 0.0);

  vec3 p = mix(tv, hv, uv.y);
  // Keep the ribbon a constant apparent thickness rather than shrinking to a
  // sub-pixel line at range, which is what makes a tracer readable at distance.
  float width = aParams.z * (1.0 + 0.028 * (-p.z));
  p.xy += perp * (uv.x - 0.5) * 2.0 * width;

  vec4 mv = vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
  vViewZ = mv.z;

  // Fade in over the first few metres so the tracer does not pop at the muzzle,
  // and out at the end of its flight.
  vFade = smoothstep(0.0, 0.06, t / life) * (1.0 - smoothstep(0.6, 1.0, t / life));
  vFade *= smoothstep(0.0, 0.9, travel);
  vHot = 1.0 - smoothstep(0.0, total * 0.85 + 0.001, travel);
  vDist = -mv.z;
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec3      uCore;
uniform vec3      uEdge;
uniform float     uIntensity;
uniform sampler2D uDepth;
uniform float     uHasDepth;
uniform float     uNear;
uniform float     uFar;

varying vec2  vUv;
varying float vFade;
varying float vHot;
varying float vDist;
varying vec4  vScreen;
varying float vViewZ;

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
  float section = 1.0 - abs(vUv.x - 0.5) * 2.0;
  if (section <= 0.0) discard;
  float core = pow(section, 6.0);
  float body = pow(section, 1.6);

  // Along the ribbon: dim at the tail, brightest just behind the head.
  float along = smoothstep(0.0, 0.42, vUv.y);
  float headGlow = smoothstep(0.72, 1.0, vUv.y);

  float alpha = (body * 0.55 + core * 0.9) * along * vFade * uIntensity;
  vec3 colour = mix(uEdge, uCore, core * 0.85 + headGlow * 0.35);
  colour *= 1.0 + headGlow * 1.4 + vHot * 0.35;

  // A ribbon that runs into a wall must dissolve into it, not stop dead on the
  // polygon edge. Without this a tracer disappearing behind cover is a hard
  // diagonal line terminated mid-air, which is exactly what it looks like.
  // The fade distance is short — a fifth of a metre — because the ribbon is
  // aimed at the surface rather than lying across it, so a long fade would
  // simply shorten every tracer instead of softening where it lands.
  if (uHasDepth > 0.5) {
    vec2 suv = vScreen.xy / vScreen.w * 0.5 + 0.5;
    float d = texture2D(uDepth, suv).x;
    float sceneZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
    float fade = clamp((vViewZ - sceneZ) / 0.22, 0.0, 1.0);
    alpha *= fade * fade * (3.0 - 2.0 * fade);
  }

#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vDist * vDist);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vDist);
  #endif
  alpha *= 1.0 - fogFactor * 0.85;
#endif

  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(colour, alpha);
}
`

const STRIDE = 4

export class Tracers {
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly mesh: THREE.Mesh
  private readonly capacity: number
  private readonly start: Float32Array
  private readonly dir: Float32Array
  private readonly params: Float32Array
  private readonly attrs: THREE.InstancedBufferAttribute[] = []
  private head = 0
  private wrapped = false
  private dirtyMin = Infinity
  private dirtyMax = -Infinity
  private liveUntil = -1

  private readonly d = new THREE.Vector3()

  constructor(scene: THREE.Scene, capacity: number) {
    this.capacity = Math.max(16, capacity)

    const quad = new THREE.PlaneGeometry(1, 1)
    // PlaneGeometry uv runs 0..1 in both axes, which the shader relies on.
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    geo.instanceCount = 0
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.start = new Float32Array(this.capacity * STRIDE)
    this.dir = new Float32Array(this.capacity * STRIDE)
    this.params = new Float32Array(this.capacity * STRIDE)
    const names: [string, Float32Array][] = [
      ['aStart', this.start],
      ['aDir', this.dir],
      ['aParams', this.params],
    ]
    for (const [name, arr] of names) {
      const attr = new THREE.InstancedBufferAttribute(arr, STRIDE)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, attr)
      this.attrs.push(attr)
    }
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCore: { value: new THREE.Color().setRGB(3.4, 2.5, 1.35) },
          uEdge: { value: new THREE.Color().setRGB(1.5, 0.42, 0.09) },
          uIntensity: { value: 1 },
          uDepth: { value: null },
          uHasDepth: { value: 0 },
          uNear: { value: 0.06 },
          uFar: { value: 900 },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: true,
    })

    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 14
    this.mesh.matrixAutoUpdate = false
    this.mesh.name = 'fx-tracers'
    scene.add(this.mesh)
  }

  /**
   * `bright` selects a full tracer round; the dim variant stands in for the
   * ordinary rounds between them so sustained fire still reads as a stream.
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3, speed: number, time: number, bright: boolean): void {
    this.d.copy(to).sub(from)
    const total = this.d.length()
    if (total < 0.15) return
    this.d.multiplyScalar(1 / total)

    const i = this.head
    this.head = (this.head + 1) % this.capacity
    if (this.head === 0) this.wrapped = true
    const o = i * STRIDE

    const trail = bright ? Math.min(total * 0.55, 7) : Math.min(total * 0.4, 3.2)
    const life = total / speed + trail / speed + 0.02

    this.start[o] = from.x
    this.start[o + 1] = from.y
    this.start[o + 2] = from.z
    this.start[o + 3] = time
    this.dir[o] = this.d.x
    this.dir[o + 1] = this.d.y
    this.dir[o + 2] = this.d.z
    this.dir[o + 3] = speed
    this.params[o] = total
    this.params[o + 1] = trail
    this.params[o + 2] = bright ? 0.028 : 0.014
    this.params[o + 3] = life
    if (time + life > this.liveUntil) this.liveUntil = time + life

    if (i < this.dirtyMin) this.dirtyMin = i
    if (i > this.dirtyMax) this.dirtyMax = i
  }

  update(time: number): void {
    if (this.dirtyMax >= this.dirtyMin) {
      const s = this.dirtyMin * STRIDE
      const c = (this.dirtyMax - this.dirtyMin + 1) * STRIDE
      for (const a of this.attrs) {
        a.clearUpdateRanges()
        a.addUpdateRange(s, c)
        a.needsUpdate = true
      }
      this.dirtyMin = Infinity
      this.dirtyMax = -Infinity
    }
    this.geometry.instanceCount = this.wrapped ? this.capacity : this.head
    this.material.uniforms.uTime.value = time
  }

  setDepth(depth: THREE.Texture | null, near: number, far: number): void {
    const u = this.material.uniforms
    u.uDepth.value = depth
    u.uHasDepth.value = depth ? 1 : 0
    u.uNear.value = near
    u.uFar.value = far
  }

  /** True while any tracer is alive, so the depth prepass knows to run. */
  active(time: number): boolean {
    return time < this.liveUntil
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}
