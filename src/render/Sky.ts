import * as THREE from 'three'
import {
  SKY_GLSL, SKY_PARAMS, SKY_SCALE_ENV, SKY_SCALE_VISIBLE, SUN_DISC_RADIANCE,
  betaMie, betaRayleigh, skyRadiance, sunIntensity, type SkyParams,
} from './lighting/SkyModel'

const DOME_RADIUS = 800
const ENV_DOME_RADIUS = 8

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const FRAGMENT = /* glsl */ `
${SKY_GLSL}

uniform float uScale;
uniform float uSunDiscRadiance;
uniform vec3 uSunTint;
uniform vec3 uGroundColor;
uniform float uHorizonFade;

varying vec3 vDir;

void main() {
  vec3 dir = normalize( vDir );

  // Shoulder before anything else, so the circumsolar lobe keeps a gradient
  // instead of landing on flat white.
  vec3 col = skyShoulder( skyRadiance( dir ) * uScale );

  // Below the horizon the dome becomes distant hazy ground. It keeps a memory
  // of the sky it replaces so the seam never reads as a hard line, and it gives
  // the environment map a warm bounce term that a sky-only probe would lack.
  //
  // uGroundColor arrives in the same pre-scale radiance units the model emits,
  // so the ground half of the probe dims with the sky half. Held in visible
  // units it was three times too bright at environment scale, which is what
  // made every downward-facing surface — soffits above all — the warmest and
  // brightest thing in a shot rather than the darkest.
  float below = 1.0 - smoothstep( -uHorizonFade, 0.0, dir.y );
  col = mix( col, mix( col, uGroundColor * uScale, 0.82 ), below );

  // Sun disc, limb darkened. Bounded radiance: an uncapped Preetham disc is
  // ~1e5 and overflows the half-float buffers the post chain runs on.
  float cosTheta = dot( dir, uSunDir );
  float disc = smoothstep( SUN_ANGULAR_COS - 6.0e-5, SUN_ANGULAR_COS + 1.0e-5, cosTheta );
  float r = clamp( ( 1.0 - cosTheta ) / ( 1.0 - SUN_ANGULAR_COS ), 0.0, 1.0 );
  float limb = 0.55 + 0.45 * sqrt( max( 0.0, 1.0 - r * r ) );
  col += uSunTint * uSunDiscRadiance * disc * limb * smoothstep( -0.03, 0.01, uSunDir.y );

  gl_FragColor = vec4( col, 1.0 );

  // Tone mapping belongs to the post chain; only the output transfer runs here,
  // and it is a no-op when the target is the composer's linear buffer.
  #include <colorspace_fragment>
}
`

const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;

void main() {
  float d = length( vUv - 0.5 ) * 2.0;
  if ( d > 1.0 ) discard;
  // Two lobes: a tight core that survives tone mapping as a hard disc, and a
  // wide circumsolar aureole that gives bloom and god rays something to grab.
  float core = pow( max( 0.0, 1.0 - d ), 6.0 );
  float aureole = pow( max( 0.0, 1.0 - d ), 2.4 ) * 0.18;
  gl_FragColor = vec4( uColor * uIntensity * ( core + aureole ), 1.0 );

  #include <colorspace_fragment>
}
`

/**
 * The atmosphere: a Preetham dome centred on the camera, a matching probe scene
 * used to bake the environment map, and a soft solar aureole billboard that
 * doubles as the light source for screen-space god rays.
 */
export class SkyDome {
  readonly params: SkyParams = { ...SKY_PARAMS }

  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  /** Scene containing nothing but a small copy of the dome, for PMREM. */
  readonly probeScene = new THREE.Scene()
  /** Billboard the post chain can use as a god-ray source; named for lookup. */
  readonly sunSource: THREE.Mesh

  private geometry: THREE.SphereGeometry
  private probeMesh: THREE.Mesh
  private glowMaterial: THREE.ShaderMaterial
  private pmrem: THREE.PMREMGenerator | null = null
  private envTarget: THREE.WebGLRenderTarget | null = null

  private readonly betaR = new THREE.Vector3()
  private readonly betaM = new THREE.Vector3()
  private readonly groundDir = new THREE.Vector3()
  private readonly horizonSample = new THREE.Vector3()
  private readonly groundColor = new THREE.Color()

  constructor() {
    this.geometry = new THREE.SphereGeometry(1, 48, 32)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBetaR: { value: new THREE.Vector3() },
        uBetaM: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunE: { value: 1000 },
        uMieG: { value: this.params.mieDirectionalG },
        uScale: { value: SKY_SCALE_VISIBLE },
        uSunDiscRadiance: { value: SUN_DISC_RADIANCE },
        uSunTint: { value: new THREE.Vector3(1, 0.92, 0.8) },
        uGroundColor: { value: new THREE.Vector3(0.06, 0.055, 0.05) },
        uHorizonFade: { value: 0.05 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'skyDome'
    this.mesh.scale.setScalar(DOME_RADIUS)
    this.mesh.frustumCulled = false
    // Ahead of every other opaque draw so it never pays for overdraw twice.
    this.mesh.renderOrder = -1000
    this.mesh.matrixAutoUpdate = true

    this.probeMesh = new THREE.Mesh(this.geometry, this.material)
    this.probeMesh.scale.setScalar(ENV_DOME_RADIUS)
    this.probeMesh.frustumCulled = false
    this.probeScene.add(this.probeMesh)

    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 0.9, 0.76) },
        // Enough to clip the core to white and drive the god-ray pass, but not
        // so much that the aureole swallows the buildings around it.
        uIntensity: { value: 26 },
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })

    this.sunSource = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glowMaterial)
    this.sunSource.name = 'sunLightSource'
    this.sunSource.frustumCulled = false
    this.sunSource.renderOrder = -999
    this.sunSource.matrixAutoUpdate = true
  }

  /** Recomputes every derived uniform. Cheap; call whenever the sun moves. */
  setSun(sunDir: THREE.Vector3, sunTint: THREE.Color): void {
    const u = this.material.uniforms
    ;(u.uSunDir.value as THREE.Vector3).copy(sunDir)
    u.uSunE.value = sunIntensity(sunDir.y)
    u.uMieG.value = this.params.mieDirectionalG
    ;(u.uBetaR.value as THREE.Vector3).copy(betaRayleigh(this.params, this.betaR))
    ;(u.uBetaM.value as THREE.Vector3).copy(betaMie(this.params, this.betaM))
    ;(u.uSunTint.value as THREE.Vector3).set(sunTint.r, sunTint.g, sunTint.b)
    ;(this.glowMaterial.uniforms.uColor.value as THREE.Vector3).set(sunTint.r, sunTint.g, sunTint.b)

    // Ground half: the horizon sky opposite the sun, dimmed and pushed warm, so
    // downward-facing surfaces pick up a plausible bounce from the environment.
    // Kept in pre-scale radiance units — the shader multiplies by uScale — so
    // the ground and the sky halves of the probe stay in the same ratio however
    // the dome is scaled.
    this.groundDir.set(-sunDir.x, 0.03, -sunDir.z).normalize()
    skyRadiance(this.groundDir, sunDir, this.params, this.horizonSample)
    // Ground albedo times the horizontal component of the beam: a dusty street
    // reflects roughly a third of what lands on it, and the sun has to be up
    // for anything to land at all.
    const bounce = Math.max(0.05, sunDir.y) * 0.95
    this.groundColor.setRGB(
      this.horizonSample.x * 0.30 + bounce * sunTint.r,
      this.horizonSample.y * 0.27 + bounce * sunTint.g * 0.85,
      this.horizonSample.z * 0.24 + bounce * sunTint.b * 0.62,
      THREE.LinearSRGBColorSpace,
    )
    ;(u.uGroundColor.value as THREE.Vector3).set(this.groundColor.r, this.groundColor.g, this.groundColor.b)
  }

  /** Keeps the dome and the solar billboard pinned to the camera. */
  follow(cameraPosition: THREE.Vector3, sunDir: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition)
    const dist = DOME_RADIUS * 0.45
    this.sunSource.position.copy(cameraPosition).addScaledVector(sunDir, dist)
    // Billboard: face the camera, which is exactly the -sunDir axis.
    this.sunSource.lookAt(cameraPosition)
    // A touch over two degrees across: wide enough that the aureole reads and
    // the god-ray pass has something to occlude, tight enough that the disc
    // still resolves as a disc.
    this.sunSource.scale.setScalar(dist * 0.038)
  }

  /**
   * Bakes the dome into a PMREM environment map. Generated at the dimmer
   * environment scale so image-based ambient does not swamp the key light.
   */
  generateEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(renderer)
      this.pmrem.compileCubemapShader()
    }
    const u = this.material.uniforms
    const visibleScale = u.uScale.value as number
    u.uScale.value = SKY_SCALE_ENV
    // The disc is a fraction of a texel at probe resolution; leaving it in adds
    // a sun glint to rough metal without meaningfully doubling the key light.
    const previous = this.envTarget
    this.envTarget = this.pmrem.fromScene(this.probeScene, 0, 0.1, 40, { size: 256 })
    u.uScale.value = visibleScale
    previous?.dispose()
    return this.envTarget.texture
  }

  setVisibleScale(scale: number): void {
    this.material.uniforms.uScale.value = scale
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.glowMaterial.dispose()
    this.sunSource.geometry.dispose()
    this.envTarget?.dispose()
    this.pmrem?.dispose()
  }
}
