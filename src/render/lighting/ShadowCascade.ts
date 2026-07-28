import * as THREE from 'three'
import { CSM } from 'three/examples/jsm/csm/CSM.js'

/**
 * Cascaded shadow maps.
 *
 * Two things about three's CSM addon drive the shape of this wrapper:
 *
 * 1. It creates one directional light per cascade. A material that has not been
 *    through `setupMaterial` sums *all* of them, so anything the level or the
 *    effects systems spawn later must be registered or it renders several times
 *    over-lit. Since those systems own their own files, the registration is a
 *    scene sweep rather than a call they have to remember to make.
 * 2. `setupMaterial` overwrites `onBeforeCompile`. Material authoring is another
 *    system's job and it is entitled to that hook, so the existing one is
 *    chained rather than clobbered.
 */

type CompileHook = THREE.Material['onBeforeCompile']

interface LitMaterial extends THREE.Material {
  isMeshStandardMaterial?: boolean
  isMeshPhysicalMaterial?: boolean
  isMeshPhongMaterial?: boolean
  isMeshLambertMaterial?: boolean
  isMeshToonMaterial?: boolean
}

/**
 * Split scheme.
 *
 * CSM's stock schemes derive the splits from `camera.near`, which is six
 * centimetres here. That hands the first cascade a range starting at almost
 * nothing and, once the practical blend is applied, leaves it spanning the
 * first thirty metres -- a four centimetre shadow texel at the player's feet,
 * which is exactly where a shadow needs to be sharp. Splitting from a synthetic
 * one metre near plane and leaning hard towards logarithmic pulls that back to
 * roughly two centimetres.
 */
function splitFocusedNear(cascades: number, far: number, breaks: number[]): void {
  const near = 1
  const bias = 0.8
  for (let i = 1; i < cascades; i++) {
    const uniform = near + (far - near) * (i / cascades)
    const logarithmic = near * Math.pow(far / near, i / cascades)
    breaks.push(THREE.MathUtils.lerp(uniform, logarithmic, bias) / far)
  }
  breaks.push(1)
}

function receivesDirectLight(material: THREE.Material): boolean {
  const m = material as LitMaterial
  return Boolean(
    m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
    m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial,
  )
}

export class ShadowCascade {
  readonly csm: CSM
  readonly lights: THREE.DirectionalLight[]

  /**
   * Chained onto every material the sweep finds, after the cascade's own hook.
   * The sweep is the only place in the codebase that sees the whole set of lit
   * world materials, so anything else that has to touch all of them — the sky
   * occlusion term, for one — rides along rather than traversing twice.
   */
  materialHook: CompileHook | null = null

  private registered = new WeakSet<THREE.Material>()
  private sweepTimer = 0
  private readonly shadowMapSize: number
  private readonly depthRange: number

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    cascades: number,
    shadowMapSize: number,
    shadowDistance: number,
    lightDirection: THREE.Vector3,
  ) {
    const count = Math.max(1, Math.min(4, cascades))
    // Per cascade, not total. Four 4096 maps is a quarter of a gigabyte and
    // sixty-seven million depth fragments a frame for resolution the splits
    // below already recover.
    this.shadowMapSize = Math.min(shadowMapSize, 2048)
    // The widest cascade's bounding box is roughly the diagonal of the view
    // frustum slice it covers, which at an 80 degree field of view is several
    // times the shadow distance. Clipping it would drop the casters that throw
    // the longest shadows, which at this sun elevation is most of them.
    const lightNear = 1
    const lightFar = shadowDistance * 4 + 200
    this.depthRange = lightFar - lightNear
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: count,
      maxFar: shadowDistance,
      mode: 'custom',
      customSplitsCallback: (n, _near, far, breaks) => splitFocusedNear(n, far, breaks),
      shadowMapSize: this.shadowMapSize,
      shadowBias: 0,
      // CSM points the light *along* this vector, so it is the direction light
      // travels: away from the sun, not towards it.
      lightDirection: lightDirection.clone().normalize(),
      lightIntensity: 1,
      lightNear,
      lightFar,
      lightMargin: 120,
    })
    // Cascade blending. Must be set before any material is registered, since it
    // is compiled in as a define.
    this.csm.fade = true
    this.csm.updateFrustums()
    this.lights = this.csm.lights
    this.tuneBias()
  }

  /**
   * Bias is per cascade because the world size of a shadow texel grows with
   * every split. A single global value either lets the near cascade acne or
   * makes the far cascade peter-pan; scaling with texel size avoids both.
   */
  private tuneBias(): void {
    for (const light of this.csm.lights) {
      const cam = light.shadow.camera
      const texelWorld = (cam.right - cam.left) / this.shadowMapSize
      light.shadow.normalBias = THREE.MathUtils.clamp(texelWorld * 1.4, 0.012, 0.9)
      // Two centimetres of depth bias, expressed in the normalised depth of
      // this cascade's ortho camera. Normal bias does the heavy lifting; a
      // large depth bias is exactly what detaches a shadow from its caster.
      light.shadow.bias = -0.02 / this.depthRange
      light.shadow.camera.updateProjectionMatrix()
      light.shadow.needsUpdate = true
    }
  }

  setLightDirection(direction: THREE.Vector3): void {
    this.csm.lightDirection.copy(direction).normalize()
  }

  setColor(color: THREE.Color, intensity: number): void {
    for (const light of this.csm.lights) {
      light.color.copy(color)
      light.intensity = intensity
    }
  }

  /** Sweeps the scene for materials that have not been told about the cascade. */
  registerMaterials(scene: THREE.Object3D): void {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material
      if (!material) return
      if (Array.isArray(material)) {
        for (const m of material) this.register(m)
      } else {
        this.register(material)
      }
    })
  }

  private register(material: THREE.Material): void {
    if (this.registered.has(material) || !receivesDirectLight(material)) return
    this.registered.add(material)

    const previous: CompileHook = material.onBeforeCompile
    this.csm.setupMaterial(material)
    const csmHook: CompileHook = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      csmHook.call(material, shader, renderer)
      this.materialHook?.call(material, shader, renderer)
    }
    material.needsUpdate = true
  }

  update(dt: number, scene: THREE.Object3D): void {
    this.sweepTimer -= dt
    if (this.sweepTimer <= 0) {
      this.sweepTimer = 0.25
      this.registerMaterials(scene)
    }
    this.csm.update()
  }

  /** Camera projection changed; the splits are derived from it. */
  refresh(): void {
    this.csm.updateFrustums()
    this.tuneBias()
  }

  dispose(): void {
    this.csm.remove()
    this.csm.dispose()
  }
}
