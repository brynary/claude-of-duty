import * as THREE from 'three'
import { Pass } from 'postprocessing'

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform highp sampler2D depthBuffer;
uniform mat4 cameraProjectionInverse;
uniform vec2 depthTexelSize;

varying vec2 vUv;

vec3 viewPositionAt(const in vec2 uv) {
  vec4 clip = vec4(vec3(uv, texture2D(depthBuffer, uv).r) * 2.0 - 1.0, 1.0);
  vec4 view = cameraProjectionInverse * clip;
  return view.xyz / view.w;
}

void main() {
  vec3 p = viewPositionAt(vUv);
  vec3 left = viewPositionAt(vUv - vec2(depthTexelSize.x, 0.0));
  vec3 right = viewPositionAt(vUv + vec2(depthTexelSize.x, 0.0));
  vec3 down = viewPositionAt(vUv - vec2(0.0, depthTexelSize.y));
  vec3 up = viewPositionAt(vUv + vec2(0.0, depthTexelSize.y));

  // Take the derivative from whichever neighbour is on the same surface. Using
  // both blindly smears a normal across every silhouette in the frame.
  vec3 dx = abs(left.z - p.z) < abs(right.z - p.z) ? (p - left) : (right - p);
  vec3 dy = abs(down.z - p.z) < abs(up.z - p.z) ? (p - down) : (up - p);

  vec3 c = cross(dx, dy);
  float len = length(c);
  vec3 n = len > 1e-9 ? c / len : vec3(0.0, 0.0, 1.0);
  if (dot(n, p) > 0.0) n = -n;

  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`

/**
 * View-space normals, derived from the depth buffer.
 *
 * The obvious alternative is a second pass over the scene with a normal
 * material, but that draws *everything* — including the volumetric shafts,
 * tracers and smoke, which write no depth and would stamp their own normals
 * over the geometry behind them. Ambient occlusion computed against those is
 * visibly wrong exactly where the frame is most interesting.
 *
 * Reading the depth buffer instead sees only what actually wrote depth, costs
 * one full-screen pass rather than a whole scene, and yields geometric normals
 * — which is what occlusion and reflection want anyway, since normal-map
 * detail has no bearing on either.
 */
export class DepthNormalsPass extends Pass {
  private readonly renderTarget: THREE.WebGLRenderTarget
  private readonly sourceCamera: THREE.PerspectiveCamera

  constructor(camera: THREE.PerspectiveCamera) {
    super('DepthNormalsPass')
    this.needsSwap = false
    this.needsDepthTexture = true
    this.sourceCamera = camera

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    })
    this.renderTarget.texture.name = 'DepthNormals.Target'

    this.fullscreenMaterial = new THREE.ShaderMaterial({
      name: 'DepthNormalsMaterial',
      uniforms: {
        depthBuffer: new THREE.Uniform(null),
        cameraProjectionInverse: new THREE.Uniform(new THREE.Matrix4()),
        depthTexelSize: new THREE.Uniform(new THREE.Vector2()),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })
  }

  /** View-space normals, packed the way `unpackRGBToNormal` expects them. */
  get texture(): THREE.Texture {
    return this.renderTarget.texture
  }

  private get uniforms(): Record<string, THREE.IUniform> {
    return (this.fullscreenMaterial as THREE.ShaderMaterial).uniforms
  }

  setDepthTexture(depthTexture: THREE.Texture, _depthPacking?: THREE.DepthPackingStrategies): void {
    this.uniforms.depthBuffer.value = depthTexture
  }

  render(renderer: THREE.WebGLRenderer): void {
    const uniforms = this.uniforms
    ;(uniforms.cameraProjectionInverse.value as THREE.Matrix4)
      .copy(this.sourceCamera.projectionMatrix)
      .invert()
    renderer.setRenderTarget(this.renderTarget)
    renderer.render(this.scene, this.camera)
  }

  setSize(width: number, height: number): void {
    this.renderTarget.setSize(width, height)
    ;(this.uniforms.depthTexelSize.value as THREE.Vector2).set(1 / width, 1 / height)
  }
}
