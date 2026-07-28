import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute, ShaderPass } from 'postprocessing'

/**
 * Screen-space reflections for wet ground and polished metal.
 *
 * There is no G-buffer to read roughness from, so the effect leans on the two
 * things it can know for certain: the surface normal and the view angle.
 * Reflection strength is Fresnel-weighted — which is physically why a road
 * mirrors the skyline at a grazing angle and nothing at all underfoot — and
 * biased toward up-facing surfaces so walls do not turn into mirrors.
 *
 * The march runs at half resolution into its own buffer. The bilinear upsample
 * that costs nothing also softens the reflection, which is exactly what a
 * rough surface should do to it.
 */
const MARCH_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const MARCH_FRAGMENT_SHADER = /* glsl */ `
uniform mediump sampler2D inputBuffer;
uniform lowp sampler2D normalBuffer;
uniform highp sampler2D depthBuffer;
uniform mat4 cameraProjection;
uniform mat4 cameraProjectionInverse;
uniform mat3 viewToWorld;
uniform vec2 cameraNearFar;
uniform float intensity;
uniform float maxDistance;
uniform float thickness;

varying vec2 vUv;

float viewZAt(const in float depth) {
  return (cameraNearFar.x * cameraNearFar.y) /
    ((cameraNearFar.y - cameraNearFar.x) * depth - cameraNearFar.y);
}

vec3 viewPositionAt(const in vec2 uv, const in float depth) {
  vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  vec4 view = cameraProjectionInverse * clip;
  return view.xyz / view.w;
}

float ssrHash(const in vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float centerDepth = texture2D(depthBuffer, vUv).r;
  if (centerDepth >= 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 origin = viewPositionAt(vUv, centerDepth);
  vec3 normal = normalize(texture2D(normalBuffer, vUv).xyz * 2.0 - 1.0);
  vec3 worldNormal = viewToWorld * normal;

  vec3 view = normalize(origin);
  float facing = max(dot(-view, normal), 0.0);
  float fresnel = pow(1.0 - facing, 5.0);
  float weight = intensity * smoothstep(0.35, 0.8, worldNormal.y) * (0.04 + 0.96 * fresnel);
  if (weight < 0.003) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 ray = normalize(reflect(view, normal));
  float stepLength = maxDistance / float(STEPS);
  float jitter = ssrHash(vUv * 311.7);

  vec2 hitUv = vec2(0.0);
  float hit = 0.0;
  float travelled = 0.0;

  for (int i = 1; i <= STEPS; ++i) {
    float marched = (float(i) + jitter - 0.5) * stepLength;
    vec3 samplePoint = origin + ray * marched;
    if (samplePoint.z > -cameraNearFar.x) break;

    vec4 clip = cameraProjection * vec4(samplePoint, 1.0);
    vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sceneZ = viewZAt(texture2D(depthBuffer, uv).r);
    float behind = sceneZ - samplePoint.z;
    if (behind > 0.0 && behind < thickness + marched * 0.05) {
      hitUv = uv;
      hit = 1.0;
      travelled = marched;
      break;
    }
  }

  if (hit < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Fade at the screen edges, where the reflection simply runs out of data,
  // and with ray length so long marches do not stamp obvious smears.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.14), hitUv) * (1.0 - smoothstep(vec2(0.86), vec2(1.0), hitUv));
  float fade = edge.x * edge.y * (1.0 - smoothstep(0.65, 1.0, travelled / maxDistance));

  vec3 reflected = max(texture2D(inputBuffer, hitUv).rgb, vec3(0.0));
  gl_FragColor = vec4(reflected * weight * fade, 1.0);
}
`

const COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
uniform mediump sampler2D reflectionBuffer;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb + texture2D(reflectionBuffer, uv).rgb, inputColor.a);
}
`

export interface SsrEffectOptions {
  normalBuffer: THREE.Texture
  camera: THREE.PerspectiveCamera
  intensity?: number
  /** Ray length in metres. */
  maxDistance?: number
  /** How thick surfaces are assumed to be, in metres. */
  thickness?: number
  steps?: number
  resolutionScale?: number
}

export class SsrEffect extends Effect {
  private readonly renderTarget: THREE.WebGLRenderTarget
  private readonly marchMaterial: THREE.ShaderMaterial
  private readonly marchPass: ShaderPass
  private readonly resolutionScale: number
  private readonly sourceCamera: THREE.PerspectiveCamera
  private readonly viewToWorld = new THREE.Matrix3()

  constructor({
    normalBuffer,
    camera,
    intensity = 0.34,
    maxDistance = 14,
    thickness = 0.6,
    steps = 20,
    resolutionScale = 0.5,
  }: SsrEffectOptions) {
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      type: THREE.HalfFloatType,
    })
    renderTarget.texture.name = 'SSR.Reflection'

    super('SsrEffect', COMPOSITE_FRAGMENT_SHADER, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['reflectionBuffer', new THREE.Uniform(renderTarget.texture)],
      ]),
    })

    this.renderTarget = renderTarget
    this.resolutionScale = resolutionScale
    this.sourceCamera = camera

    this.marchMaterial = new THREE.ShaderMaterial({
      name: 'SsrMarchMaterial',
      defines: { STEPS: Math.max(4, Math.round(steps)).toFixed(0) },
      uniforms: {
        inputBuffer: new THREE.Uniform(null),
        normalBuffer: new THREE.Uniform(normalBuffer),
        depthBuffer: new THREE.Uniform(null),
        cameraProjection: new THREE.Uniform(new THREE.Matrix4()),
        cameraProjectionInverse: new THREE.Uniform(new THREE.Matrix4()),
        viewToWorld: new THREE.Uniform(new THREE.Matrix3()),
        cameraNearFar: new THREE.Uniform(new THREE.Vector2(0.1, 1000)),
        intensity: new THREE.Uniform(intensity),
        maxDistance: new THREE.Uniform(maxDistance),
        thickness: new THREE.Uniform(thickness),
      },
      vertexShader: MARCH_VERTEX_SHADER,
      fragmentShader: MARCH_FRAGMENT_SHADER,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })

    this.marchPass = new ShaderPass(this.marchMaterial, 'inputBuffer')
  }

  set intensity(value: number) {
    this.marchMaterial.uniforms.intensity.value = value
  }

  get intensity(): number {
    return this.marchMaterial.uniforms.intensity.value as number
  }

  setDepthTexture(depthTexture: THREE.Texture, _depthPacking?: THREE.DepthPackingStrategies): void {
    this.marchMaterial.uniforms.depthBuffer.value = depthTexture
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, _deltaTime?: number): void {
    const camera = this.sourceCamera
    const uniforms = this.marchMaterial.uniforms
    ;(uniforms.cameraProjection.value as THREE.Matrix4).copy(camera.projectionMatrix)
    ;(uniforms.cameraProjectionInverse.value as THREE.Matrix4).copy(camera.projectionMatrix).invert()
    this.viewToWorld.setFromMatrix4(camera.matrixWorld)
    ;(uniforms.viewToWorld.value as THREE.Matrix3).copy(this.viewToWorld)
    ;(uniforms.cameraNearFar.value as THREE.Vector2).set(camera.near, camera.far)

    this.marchPass.render(renderer, inputBuffer, this.renderTarget)
  }

  setSize(width: number, height: number): void {
    this.renderTarget.setSize(
      Math.max(1, Math.round(width * this.resolutionScale)),
      Math.max(1, Math.round(height * this.resolutionScale)),
    )
  }
}
