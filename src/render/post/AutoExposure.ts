import * as THREE from 'three'
import { Pass } from 'postprocessing'

/**
 * Scene metering: the geometric mean of frame luminance, reduced on the GPU to
 * a single texel and smoothed over time.
 *
 * ## Why the renderer needs this at all
 *
 * The eight capture poses span 3.2 stops of scene luminance — the interior
 * meters at 0.019 and the sunset rooftop at 0.178. A single fixed exposure
 * cannot serve both, and the critique of round 3 asked for the two ends to move
 * in *opposite* directions in the same breath: "raise interior exposure about
 * 1.5 stops" and, for the frame average, "a late-afternoon exterior with real
 * shadow is not a mid-grey image". Those are only reconcilable by metering.
 * Every shipped title does this; three rounds of hand-picking one exposure
 * constant were three rounds of splitting the difference badly.
 *
 * ## Why it cannot oscillate
 *
 * The measurement is taken from the HDR buffer *before* exposure is applied —
 * exposure lives in the grade, which runs after this. So the input to the meter
 * does not depend on the meter's own output and there is no feedback loop. The
 * temporal filter exists only to stop the exposure stepping visibly while the
 * player turns; it is not a stability mechanism.
 *
 * ## Why the reduction is explicit rather than a mip chain
 *
 * Averaging a mipmapped render target down to 1x1 needs an explicit LOD fetch,
 * which is spelled differently in GLSL ES 1.00 and 3.00 and needs an extension
 * in the former. Two fixed reduction passes need no extension, no mipmap
 * generation and no `#version` branch, and 16384 samples put the standard error
 * of the mean at roughly 0.01 EV — far below the precision anything downstream
 * cares about.
 *
 * The luminance is averaged in log2 space, so this is a geometric mean. An
 * arithmetic mean is dominated by whatever is brightest: measured across the
 * eight poses it runs 1.16x the geometric mean on the interior and 2.76x on the
 * rooftop, which would have metered a sunlit frame as if the sun filled it.
 */

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

/** Reduction grid: `TILES`² texels, each averaging `TAPS`² points of the frame. */
const TILES = 16
const TAPS = 8

/**
 * Luminance floor. Not just a guard against `log2(0)`: without it a frame with
 * genuinely black regions — an unlit ceiling, a doorway — drags the geometric
 * mean down by however many stops the floor is set below, and the meter answers
 * by over-exposing everything else. 1e-4 is thirteen stops under the metered
 * mid-point, so nothing an actual surface returns is ever clamped by it.
 */
const MIN_LUMINANCE = 1e-4

// Every sampler here is qualified explicitly. The default precision for a
// sampler in the fragment language is lowp, whose guaranteed range is (-2, 2) —
// which would clamp an EV of -5 to -2 and silently turn the meter into a
// constant.
const REDUCE_FRAGMENT_SHADER = /* glsl */ `
uniform mediump sampler2D inputBuffer;
uniform vec2 tapStep;

varying vec2 vUv;

void main() {
  vec2 origin = vUv - tapStep * ${((TAPS - 1) * 0.5).toFixed(1)};
  float total = 0.0;
  for (int y = 0; y < ${TAPS}; y++) {
    for (int x = 0; x < ${TAPS}; x++) {
      vec2 uv = origin + tapStep * vec2(float(x), float(y));
      vec3 c = max(texture2D(inputBuffer, uv).rgb, vec3(0.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      total += log2(max(l, ${MIN_LUMINANCE.toFixed(6)}));
    }
  }
  gl_FragColor = vec4(total * ${(1 / (TAPS * TAPS)).toFixed(8)}, 0.0, 0.0, 1.0);
}
`

/**
 * Note what this writes: the *correction*, in stops, not the measurement. That
 * is deliberate. The texel is consumed by a shader that cannot check whether
 * this pass ever ran, and storing the correction makes zero — the value a
 * missing or failed read returns — mean "leave the exposure alone". Storing the
 * raw EV instead would make a failed read mean "the scene is at 1.0 luminance",
 * which is a bright reading, and the frame would come back 1.7 stops dark.
 */
const RESOLVE_FRAGMENT_SHADER = /* glsl */ `
uniform highp sampler2D reduceBuffer;
uniform highp sampler2D previousBuffer;
uniform float referenceEv;
uniform float blend;

varying vec2 vUv;

void main() {
  float total = 0.0;
  for (int y = 0; y < ${TILES}; y++) {
    for (int x = 0; x < ${TILES}; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) * ${(1 / TILES).toFixed(8)};
      total += texture2D(reduceBuffer, uv).r;
    }
  }
  float current = referenceEv - total * ${(1 / (TILES * TILES)).toFixed(8)};
  float previous = texture2D(previousBuffer, vec2(0.5)).r;
  // Blended in log space: adaptation is symmetric in stops, which is how an eye
  // and a light meter both behave.
  //
  // A full-weight blend discards the history outright rather than interpolating
  // to it, so the first frame and every frozen capture frame cannot inherit
  // whatever the ping-pong target happened to contain. Interpolating would be
  // algebraically equivalent only if that value is finite.
  float adapted = (blend >= 1.0) ? current : previous + (current - previous) * blend;
  gl_FragColor = vec4(adapted, 0.0, 0.0, 1.0);
}
`

export interface AutoExposureOptions {
  /** Geometric mean scene luminance at which the correction is zero. */
  referenceLuminance: number
  /**
   * Adaptation rate, in reciprocal seconds. The weight applied to a new
   * measurement is `1 - exp(-dt * rate)`, so 2.5 closes 92% of a step in one
   * second — quick enough not to feel like a bug when stepping out of a
   * doorway, slow enough not to pump while a muzzle flash is on screen.
   */
  rate?: number
}

/**
 * Not registered with the composer. {@link GradeEffect} drives it from its own
 * `update`, which is the hook that runs with the pass input buffer bound and
 * before the merged effect shader samples it — the same place the library's own
 * `ToneMappingEffect` drives its luminance passes from.
 */
export class AutoExposure extends Pass {
  private readonly reduceTarget: THREE.WebGLRenderTarget
  private readonly adapted: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly reduceMaterial: THREE.ShaderMaterial
  private readonly resolveMaterial: THREE.ShaderMaterial
  private readonly rate: number
  private index = 0
  private settled = false

  constructor({ referenceLuminance, rate = 2.5 }: AutoExposureOptions) {
    super('AutoExposure')
    this.rate = rate
    this.needsSwap = false

    this.reduceTarget = new THREE.WebGLRenderTarget(TILES, TILES, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.HalfFloatType,
    })
    this.reduceTarget.texture.name = 'AutoExposure.Reduce'
    this.reduceTarget.texture.generateMipmaps = false

    const single = (): THREE.WebGLRenderTarget => {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        type: THREE.HalfFloatType,
      })
      rt.texture.name = 'AutoExposure.Adapted'
      rt.texture.generateMipmaps = false
      return rt
    }
    this.adapted = [single(), single()]

    const shared = {
      vertexShader: VERTEX_SHADER,
      blending: THREE.NoBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    }

    this.reduceMaterial = new THREE.ShaderMaterial({
      ...shared,
      name: 'AutoExposureReduceMaterial',
      uniforms: {
        inputBuffer: new THREE.Uniform(null),
        // One tap apart in UV, so the `TILES * TAPS` grid tiles the frame
        // exactly with no gap and no overlap.
        tapStep: new THREE.Uniform(new THREE.Vector2(1 / (TILES * TAPS), 1 / (TILES * TAPS))),
      },
      fragmentShader: REDUCE_FRAGMENT_SHADER,
    })

    this.resolveMaterial = new THREE.ShaderMaterial({
      ...shared,
      name: 'AutoExposureResolveMaterial',
      uniforms: {
        reduceBuffer: new THREE.Uniform(this.reduceTarget.texture),
        previousBuffer: new THREE.Uniform(null),
        referenceEv: new THREE.Uniform(Math.log2(referenceLuminance)),
        blend: new THREE.Uniform(1),
      },
      fragmentShader: RESOLVE_FRAGMENT_SHADER,
    })

    this.fullscreenMaterial = this.reduceMaterial
  }

  /**
   * 1x1, red channel: the adapted exposure correction in stops, relative to
   * {@link AutoExposureOptions.referenceLuminance}. Zero means "no correction",
   * which is also what a missing texture reads as.
   */
  get texture(): THREE.Texture {
    return this.adapted[this.index].texture
  }

  /** Discards the adaptation history, so the next measurement is taken whole. */
  reset(): void {
    this.settled = false
  }

  /**
   * @param snap - Take the measurement outright instead of easing into it. The
   *   capture harness freezes the simulation and then averages two dozen
   *   frames; easing would fold a different exposure into each of them and make
   *   the result depend on the machine's frame rate. Snapping is safe precisely
   *   because there is no feedback loop.
   */
  measure(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    snap: boolean,
  ): void {
    const previous = this.adapted[this.index]
    const next = this.adapted[this.index ^ 1]

    this.reduceMaterial.uniforms.inputBuffer.value = inputBuffer.texture
    this.fullscreenMaterial = this.reduceMaterial
    renderer.setRenderTarget(this.reduceTarget)
    renderer.render(this.scene, this.camera)

    this.resolveMaterial.uniforms.previousBuffer.value = previous.texture
    this.resolveMaterial.uniforms.blend.value =
      snap || !this.settled ? 1 : 1 - Math.exp(-Math.max(deltaTime, 0) * this.rate)
    this.fullscreenMaterial = this.resolveMaterial
    renderer.setRenderTarget(next)
    renderer.render(this.scene, this.camera)

    this.index ^= 1
    this.settled = true
  }

  dispose(): void {
    this.reduceTarget.dispose()
    this.adapted[0].dispose()
    this.adapted[1].dispose()
    this.reduceMaterial.dispose()
    this.resolveMaterial.dispose()
  }
}
