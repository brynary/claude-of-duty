import * as THREE from 'three'
import { Pass } from 'postprocessing'

const BLEND_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const BLEND_FRAGMENT_SHADER = /* glsl */ `
uniform mediump sampler2D currentBuffer;
uniform mediump sampler2D historyBuffer;
uniform float blendWeight;

varying vec2 vUv;

void main() {
  vec4 current = texture2D(currentBuffer, vUv);
  vec4 history = texture2D(historyBuffer, vUv);
  gl_FragColor = mix(history, current, blendWeight);
}
`

const COPY_FRAGMENT_SHADER = /* glsl */ `
uniform mediump sampler2D currentBuffer;

varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(currentBuffer, vUv);
}
`

/**
 * Progressive temporal supersampling for the fixed capture poses.
 *
 * When the simulation is frozen the camera projection is jittered by a
 * sub-pixel Halton offset every frame and the results are averaged here. After
 * a couple of dozen frames the frame is genuinely supersampled: edges,
 * SSAO dither, SSR jitter and bokeh sampling all resolve to something no
 * single-frame technique can match.
 *
 * This deliberately does *not* run during play. Real TAA needs reprojection
 * and neighbourhood clamping to avoid ghosting behind moving enemies; SMAA
 * covers live frames instead, and a shimmering image would be worse than a
 * soft one.
 */
export class AccumulationPass extends Pass {
  private readonly history: THREE.WebGLRenderTarget
  private readonly blendMaterial: THREE.ShaderMaterial
  private readonly copyMaterial: THREE.ShaderMaterial
  private accumulated = 0

  constructor() {
    super('AccumulationPass')

    this.history = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      type: THREE.HalfFloatType,
    })
    this.history.texture.name = 'Accumulation.History'

    const shared = {
      vertexShader: BLEND_VERTEX_SHADER,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    }

    this.blendMaterial = new THREE.ShaderMaterial({
      ...shared,
      name: 'AccumulationBlendMaterial',
      uniforms: {
        currentBuffer: new THREE.Uniform(null),
        historyBuffer: new THREE.Uniform(this.history.texture),
        blendWeight: new THREE.Uniform(1),
      },
      fragmentShader: BLEND_FRAGMENT_SHADER,
    })

    this.copyMaterial = new THREE.ShaderMaterial({
      ...shared,
      name: 'AccumulationCopyMaterial',
      uniforms: { currentBuffer: new THREE.Uniform(null) },
      fragmentShader: COPY_FRAGMENT_SHADER,
    })

    this.fullscreenMaterial = this.blendMaterial
  }

  /** How many jittered frames are already folded into the history. */
  get sampleIndex(): number {
    return this.accumulated
  }

  reset(): void {
    this.accumulated = 0
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (inputBuffer === null) return
    const target = this.renderToScreen ? null : outputBuffer

    this.blendMaterial.uniforms.currentBuffer.value = inputBuffer.texture
    this.blendMaterial.uniforms.blendWeight.value =
      this.accumulated === 0 ? 1 : 1 / (this.accumulated + 1)
    this.fullscreenMaterial = this.blendMaterial
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.camera)

    if (target === null) return

    this.copyMaterial.uniforms.currentBuffer.value = target.texture
    this.fullscreenMaterial = this.copyMaterial
    renderer.setRenderTarget(this.history)
    renderer.render(this.scene, this.camera)

    this.accumulated++
  }

  setSize(width: number, height: number): void {
    this.history.setSize(width, height)
    this.reset()
  }
}
