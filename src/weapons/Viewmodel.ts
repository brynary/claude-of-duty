import * as THREE from 'three'
import type { GameContext, RaycastFilter } from '../core/Types'
import type { WeaponDef, VmPose } from './WeaponDefs'
import { WeaponMaterials, buildWeaponModel, type WeaponModel } from './WeaponGeometry'
import { Spring1, Spring3, wrapAngle } from './Recoil'

/**
 * The first person weapon rig: lighting, pose blending, procedural animation
 * and the collimated optic reticle.
 *
 * Everything is spring driven and framerate independent. The ADS pose is not
 * hand tuned: it is solved from the sight node's own transform so the optical
 * axis passes exactly through the eye, which is why the dot never drifts off
 * the bore no matter how the weapon is posed.
 */

export interface VmDrive {
  /** 1 while the aim button is held. */
  ads: number
  sprint: number
  speedFraction: number
  crouch: number
  /** Camera yaw/pitch change this frame, radians. */
  yawDelta: number
  pitchDelta: number
  /** Blend toward the weapon-showcase low ready pose. */
  lowReady: number
  elapsed: number
}

interface Key {
  t: number
  p: readonly [number, number, number]
  r: readonly [number, number, number]
}

const RELOAD_WEAPON: readonly Key[] = [
  { t: 0.00, p: [0, 0, 0], r: [0, 0, 0] },
  { t: 0.13, p: [-0.030, -0.020, 0.046], r: [0.05, -0.22, -0.52] },
  { t: 0.30, p: [-0.033, -0.028, 0.049], r: [0.07, -0.25, -0.56] },
  { t: 0.46, p: [-0.030, -0.020, 0.046], r: [0.05, -0.23, -0.52] },
  { t: 0.60, p: [-0.026, -0.012, 0.040], r: [0.03, -0.19, -0.47] },
  { t: 0.76, p: [-0.016, -0.006, 0.026], r: [0.01, -0.12, -0.29] },
  { t: 1.00, p: [0, 0, 0], r: [0, 0, 0] },
]

const RELOAD_HAND: readonly Key[] = [
  { t: 0.00, p: [0, 0, 0], r: [0, 0, 0] },
  { t: 0.16, p: [0.022, -0.094, 0.248], r: [0.2, 0, 0.3] },
  { t: 0.32, p: [0.030, -0.190, 0.256], r: [0.35, 0, 0.4] },
  { t: 0.42, p: [0.052, -0.400, 0.280], r: [0.5, 0, 0.5] },
  { t: 0.50, p: [0.052, -0.390, 0.276], r: [0.5, 0, 0.5] },
  { t: 0.58, p: [0.024, -0.140, 0.250], r: [0.25, 0, 0.35] },
  { t: 0.66, p: [0.022, -0.086, 0.248], r: [0.18, 0, 0.3] },
  { t: 0.74, p: [0.020, -0.104, 0.240], r: [0.2, 0, 0.28] },
  { t: 0.86, p: [0.006, -0.024, 0.070], r: [0.06, 0, 0.08] },
  { t: 1.00, p: [0, 0, 0], r: [0, 0, 0] },
]

const INSPECT_TRACK: readonly Key[] = [
  { t: 0.00, p: [0, 0, 0], r: [0, 0, 0] },
  { t: 0.18, p: [-0.026, -0.026, 0.062], r: [0.16, -0.50, -0.26] },
  { t: 0.44, p: [-0.034, -0.016, 0.078], r: [-0.12, 0.86, 0.34] },
  { t: 0.68, p: [-0.014, -0.040, 0.052], r: [0.38, 0.22, -0.14] },
  { t: 0.86, p: [-0.020, -0.020, 0.058], r: [0.05, -0.30, -0.18] },
  { t: 1.00, p: [0, 0, 0], r: [0, 0, 0] },
]

const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _e = new THREE.Euler(0, 0, 0, 'XYZ')
const _e2 = new THREE.Euler(0, 0, 0, 'XYZ')
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qa = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _fwd = new THREE.Vector3(0, 0, -1)
const _zAxis = new THREE.Vector3(0, 0, 1)

/**
 * Authored intensity of every lamp in the studio rig. `syncToEnvironment`
 * scales the whole set by one factor, so the ratios between key, fill and rim
 * survive whatever the coupling does to the weapon's exposure.
 */
const RIG = { key: 4.1, fill: 0.80, rim: 1.55, sunRim: 1.5, bounce: 0.30 } as const

/**
 * Sky-visibility probe directions, world space, and their weights.
 *
 * Fixed in world space on purpose: a view-dependent probe would change the
 * weapon's exposure as the player turned on the spot, which reads as the rifle
 * pulsing. Shipped engines sample a baked irradiance volume at the weapon's
 * position for the same reason. Weighted toward the zenith because that is
 * where most of an outdoor surface's sky irradiance comes from, and because
 * "is there a roof over me" is the single strongest predictor of whether the
 * frame around the weapon is an enclosed interior or an open exterior.
 */
const PROBE_DIRS: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [[0, 1, 0, 2.0]]
  for (const [polar, weight] of [[0.70, 1.5], [1.18, 1.0]] as const) {
    const sp = Math.sin(polar)
    const cp = Math.cos(polar)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + (polar > 1 ? Math.PI / 4 : 0)
      out.push([Math.cos(a) * sp, cp, Math.sin(a) * sp, weight])
    }
  }
  return out
})()

const PROBE_RANGE = 15
/** Hoisted: the sweep must not allocate a filter per ray. */
const PROBE_FILTER: RaycastFilter = { characters: false }
/** Rig scale when the weapon is fully enclosed, and when it is under open sky. */
const ENV_FLOOR = 0.38
const ENV_CEIL = 1.12

function sampleTrack(keys: readonly Key[], t: number, outP: THREE.Vector3, outE: THREE.Euler): void {
  if (t <= keys[0].t) {
    outP.set(keys[0].p[0], keys[0].p[1], keys[0].p[2])
    outE.set(keys[0].r[0], keys[0].r[1], keys[0].r[2])
    return
  }
  const last = keys[keys.length - 1]
  if (t >= last.t) {
    outP.set(last.p[0], last.p[1], last.p[2])
    outE.set(last.r[0], last.r[1], last.r[2])
    return
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (t >= a.t && t <= b.t) {
      const raw = (t - a.t) / Math.max(b.t - a.t, 1e-5)
      const k = raw * raw * (3 - 2 * raw)
      outP.set(
        a.p[0] + (b.p[0] - a.p[0]) * k,
        a.p[1] + (b.p[1] - a.p[1]) * k,
        a.p[2] + (b.p[2] - a.p[2]) * k,
      )
      outE.set(
        a.r[0] + (b.r[0] - a.r[0]) * k,
        a.r[1] + (b.r[1] - a.r[1]) * k,
        a.r[2] + (b.r[2] - a.r[2]) * k,
      )
      return
    }
  }
}

/** Ease used for the ADS transition: fast off the mark, settled at the end. */
function adsEase(t: number): number {
  const c = Math.min(Math.max(t, 0), 1)
  return 1 - Math.pow(1 - c, 2.6)
}

export class Viewmodel {
  readonly rig = new THREE.Group()
  private ctx!: GameContext
  private mats!: WeaponMaterials
  private models = new Map<string, WeaponModel>()
  private model: WeaponModel | null = null
  private def: WeaponDef | null = null

  /** Eased 0..1 aim-down-sights blend, read by the weapon system. */
  adsFraction = 0
  private adsRaw = new Spring1()
  private sprintBlend = new Spring1()
  private lowReadyBlend = new Spring1()

  private swayPos = new Spring3()
  private swayRot = new Spring3()
  private recoilPos = new Spring3()
  private recoilRot = new Spring3()
  private bobPhase = 0
  private landDip = new Spring1()

  // Reload / inspect / switch playback.
  private reloadT = -1
  private reloadDur = 1
  private reloadEmpty = false
  private inspectT = -1
  private inspectDur = 1
  private switchT = 0
  private switchDir = 0
  private switchDur = 0.4

  private magHidden = false
  private magOffset = new THREE.Vector3()
  private magBase = new THREE.Vector3()
  private chargePull = 0
  private boltBack = 0
  private slideLocked = false
  private triggerPull = new Spring1()

  private muzzleLight!: THREE.PointLight
  private muzzleFlash!: THREE.Mesh
  private flashTimer = 0
  private reticle!: THREE.Sprite
  private reticleMat!: THREE.SpriteMaterial
  private scopeMask!: THREE.Mesh
  private scopeMaskMat!: THREE.MeshBasicMaterial
  private keyLight!: THREE.DirectionalLight
  private fillLight!: THREE.DirectionalLight
  private rimLight!: THREE.DirectionalLight
  private bounceLight!: THREE.HemisphereLight
  private sunRim!: THREE.DirectionalLight
  private studioEnv: THREE.Texture | null = null
  private studioTarget: THREE.WebGLRenderTarget | null = null

  // Environment coupling. See `syncToEnvironment`.
  private envScale = 1
  private envTarget = 1
  private envApplied = -1
  private probeIndex = -1
  private probeOpen = 0
  private probeWeight = 0
  private probeTimer = 1e3
  private probed = false
  private readonly probeAt = new THREE.Vector3()
  private readonly probeDir = new THREE.Vector3()
  private aimLocalInv = new THREE.Matrix4()
  private adsPos = new THREE.Vector3()
  private adsQuat = new THREE.Quaternion()

  // Sun-tracking rim scratch. Hoisted: syncToSun runs every frame.
  private readonly keyWarm = new THREE.Color(0xfff2e2)
  private readonly rimWarm = new THREE.Color(0xffd7a4)
  private readonly focusPoint = new THREE.Vector3(0.11, -0.10, -0.62)
  private readonly sunLocal = new THREE.Vector3()
  private readonly rigInv = new THREE.Quaternion()

  init(ctx: GameContext, mats: WeaponMaterials): void {
    this.ctx = ctx
    this.mats = mats
    this.rig.name = 'viewmodelRig'
    this.rig.matrixAutoUpdate = true
    ctx.viewmodelScene.add(this.rig)

    this.setupLighting()
    this.setupOverlays()
  }

  // -- setup ---------------------------------------------------------------

  /**
   * A dedicated three-point studio for the viewmodel, plus its own probe.
   *
   * The viewmodel is the only object in the frame the player looks at every
   * single second, so shipped shooters light it separately and hold it at a
   * constant exposure whatever the world is doing. Round 2 had the right idea
   * and the wrong geometry: the key sat at +X, and because the weapon is held
   * to the right of screen centre the camera sees its *left* flank, which got
   * nothing but a 1.1-intensity rim. Every visible face of the rifle was lit
   * by the weakest light in the rig, which is why it measured five stops under
   * the scene.
   *
   * The rule the rig now follows: the key must light the faces the camera can
   * see. Its direction has a positive component along +Z (back toward the eye)
   * and -X (the flank we look at), and the fill and rim take the two
   * complementary quadrants so no visible face is left with only the probe.
   */
  private setupLighting(): void {
    const ctx = this.ctx
    // The viewmodel pass runs after SSAO and never receives a pixel of it, so
    // the key's own shadow map is the only screen-space occlusion the weapon
    // can get. It is worth a map at every quality level, not just the top two.
    const low = ctx.config.quality === 'low'

    // One shared aim point in the middle of the posed weapon. The viewmodel
    // sits 0.25-1.1m ahead of the eye, so aiming lights at the rig origin
    // points them past it.
    const focus = new THREE.Object3D()
    focus.position.copy(this.focusPoint)
    this.rig.add(focus)

    // Warm key, up and to the camera's left, angled back toward the eye.
    // Direction works out at roughly (0.48, -0.63, -0.61): 0.48 on the left
    // flank, 0.63 on the top faces, 0.61 on everything facing the camera.
    const key = new THREE.DirectionalLight(0xfff2e2, RIG.key)
    key.position.set(-1.05, 1.40, 0.85)
    key.target = focus
    key.castShadow = true
    key.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048)
    {
      // Tight to the posed weapon. The old 1.5m box spread 1024 texels over a
      // volume mostly full of air, which is 1.5mm a texel; at 0.45m it is
      // 0.22mm and the rail ribs and trigger guard finally self-shadow.
      const cam = key.shadow.camera
      cam.left = -0.45; cam.right = 0.45; cam.top = 0.45; cam.bottom = -0.45
      cam.near = 0.5; cam.far = 3.2
      cam.updateProjectionMatrix()
      key.shadow.bias = -0.00035
      key.shadow.normalBias = 0.0012
      key.shadow.radius = 2
    }
    this.rig.add(key)
    this.keyLight = key

    // Cool fill from the opposite quadrant: camera-right and slightly below,
    // so the shadow flank and the undersides of the handguard and magazine
    // keep readable texture instead of blocking up.
    //
    // Cut back this round against a brighter key. Measured over the eight
    // poses the weapon sat at std 17-20 against a frame target of 45-65: every
    // face of it was receiving light from somewhere, which is a rig with no
    // ratio. Key to fill now runs about 5:1 rather than 2.5:1, which moves the
    // shaded flank down without moving the median -- the trade the round-3
    // brief asks for, rather than another swing of overall exposure.
    const fill = new THREE.DirectionalLight(0x9fb6d6, RIG.fill)
    fill.position.set(1.30, -0.35, 0.95)
    fill.target = focus
    this.rig.add(fill)
    this.fillLight = fill

    // Rim from above and beyond the muzzle. Draws the top edge of the
    // receiver, rail and barrel against whatever is behind them, which is what
    // stops the weapon merging with a dark wall.
    const rim = new THREE.DirectionalLight(0xc6d8f2, RIG.rim)
    rim.position.set(0.55, 1.30, -2.20)
    rim.target = focus
    this.rig.add(rim)
    this.rimLight = rim

    // Second rim, steered onto the real sun direction every frame. A weapon
    // backlit by a low sun with no edge highlight is the tell that the
    // viewmodel is lit by a rig that does not know where it is standing.
    const sunRim = new THREE.DirectionalLight(0xffd7a4, RIG.sunRim)
    sunRim.position.set(0, 2, -2)
    sunRim.target = focus
    this.rig.add(sunRim)
    this.sunRim = sunRim

    // Diffuse floor for the cloth and glove, which the probe alone leaves flat.
    // World oriented on purpose: its position *is* its up axis in three, so it
    // cannot be parented to a rig that rotates. Deliberately weak: a
    // hemisphere term reaches every surface regardless of orientation, so it
    // is the fastest way to flatten an object that is meant to have a ratio.
    const bounce = new THREE.HemisphereLight(0x9db2cb, 0x3a3025, RIG.bounce)
    ctx.viewmodelScene.add(bounce)
    this.bounceLight = bounce

    // Weapon space gets its own probe, always. Handing the sky PMREM to a
    // metalness-0.9 surface makes the weapon a mirror of the sky, and no amount
    // of albedo tuning fixes it: at that metalness the albedo *is* the tint on
    // a reflection of whatever the probe contains.
    this.studioEnv = this.makeStudioEnvironment()
    this.mats.setEnvironment(this.studioEnv)
    ctx.viewmodelScene.environment = this.studioEnv
    ctx.viewmodelScene.environmentIntensity = 1
  }

  /**
   * Studio probe: an elevation-only gradient — warm bright band at the
   * horizon, cool bright zenith, dark warm ground.
   *
   * Two properties matter more than the colours. First, it carries real
   * energy: at metalness 0.88 the probe, not the lights, supplies most of what
   * the eye reads as the finish, and round 2's near-black box contributed
   * about 0.1% of the frame's linear value. Second, it is invariant about the
   * vertical axis. The probe is sampled in world space, so any bright lobe at
   * a fixed azimuth sweeps across the weapon as the player turns and the
   * rifle appears to change finish mid-turn. A gradient that only varies with
   * elevation cannot do that, and it also gives every horizontal face — the
   * rail ladder above all — a brighter reflection than the vertical flanks,
   * which is the specular line that describes the weapon's spine.
   */
  private makeStudioEnvironment(): THREE.Texture | null {
    try {
      const pmrem = new THREE.PMREMGenerator(this.ctx.renderer)
      const scene = new THREE.Scene()
      const geom = new THREE.SphereGeometry(10, 48, 32)
      const pos = geom.getAttribute('position')
      const col = new Float32Array(pos.count * 3)
      for (let i = 0; i < pos.count; i++) {
        // -1 straight down, +1 straight up.
        const t = pos.getY(i) / 10
        const up = Math.max(0, t)
        // 1 at and above the horizon, falling to 0 at the nadir.
        const ground = 1 - Math.max(0, -t)
        // Warm haze band hugging the horizon, gone within ~20 degrees of it.
        const band = Math.exp(-(t * t) / 0.045)
        col[i * 3] = 0.045 + 0.115 * ground + 0.60 * up * up + band * 0.200
        col[i * 3 + 1] = 0.040 + 0.120 * ground + 0.66 * up * up + band * 0.155
        col[i * 3 + 2] = 0.035 + 0.130 * ground + 0.80 * up * up + band * 0.105
      }
      geom.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }),
      )
      scene.add(mesh)
      const rt = pmrem.fromScene(scene, 0.04)
      pmrem.dispose()
      geom.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.studioTarget = rt
      return rt.texture
    } catch {
      return null
    }
  }

  private setupOverlays(): void {
    // Muzzle light lives in the viewmodel scene so the weapon lights itself.
    this.muzzleLight = new THREE.PointLight(0xffd39a, 0, 2.4, 2)
    this.muzzleLight.castShadow = false
    this.rig.add(this.muzzleLight)

    const flashGeom = new THREE.PlaneGeometry(0.16, 0.16)
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    })
    this.muzzleFlash = new THREE.Mesh(flashGeom, flashMat)
    this.muzzleFlash.renderOrder = 18
    this.muzzleFlash.frustumCulled = false
    this.muzzleFlash.visible = false
    this.rig.add(this.muzzleFlash)

    this.reticleMat = new THREE.SpriteMaterial({
      map: this.mats.dotTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      sizeAttenuation: true,
    })
    this.reticle = new THREE.Sprite(this.reticleMat)
    this.reticle.renderOrder = 22
    this.reticle.frustumCulled = false
    this.reticle.visible = false
    this.rig.add(this.reticle)

    this.scopeMaskMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.scopeMask = new THREE.Mesh(new THREE.RingGeometry(1, 12, 64), this.scopeMaskMat)
    this.scopeMask.renderOrder = 20
    this.scopeMask.frustumCulled = false
    this.scopeMask.visible = false
    this.rig.add(this.scopeMask)
  }

  // -- weapon lifecycle ----------------------------------------------------

  equip(def: WeaponDef): void {
    if (this.model) this.model.root.visible = false
    let model = this.models.get(def.id)
    if (!model) {
      model = buildWeaponModel(def.kind, this.mats)
      this.rig.add(model.root)
      this.models.set(def.id, model)
    }
    model.root.visible = true
    this.model = model
    this.def = def

    // Solve the ADS transform from the sight node once per weapon.
    model.root.position.set(0, 0, 0)
    model.root.quaternion.identity()
    model.root.updateMatrixWorld(true)
    _m1.copy(model.root.matrixWorld).invert().multiply(model.aim.matrixWorld)
    this.aimLocalInv.copy(_m1).invert()

    this.reticleMat.map = model.reticleKind === 'cross' ? this.mats.crossTexture : this.mats.dotTexture
    this.reticleMat.blending = model.reticleKind === 'cross' ? THREE.NormalBlending : THREE.AdditiveBlending
    if (model.reticleKind === 'cross') {
      this.reticleMat.color.set(0xffffff)
    } else {
      // Well above 1.0 in linear working space so the core clips through the
      // tonemapper and blooms, which is how a red dot actually looks against a
      // daylit target: a white-hot centre with a red bleed, not a red decal.
      // It is also one of the few honestly emissive things in frame, so it is
      // allowed to be part of the white point.
      this.reticleMat.color.setRGB(7.5, 0.85, 0.32, THREE.LinearSRGBColorSpace)
    }
    this.reticleMat.needsUpdate = true
    this.reticle.visible = model.reticleKind !== 'none'
    this.scopeMask.visible = model.reticleKind === 'cross'

    this.muzzleLight.position.copy(model.muzzle.position)
    this.muzzleFlash.position.copy(model.muzzle.position)
    this.magBase.copy(model.magazine.position)
    this.magHidden = false
    this.magOffset.set(0, 0, 0)
    this.chargePull = 0
    this.boltBack = 0
    this.reloadT = -1
    this.inspectT = -1
  }

  beginSwitch(out: boolean, seconds: number): void {
    this.switchDir = out ? 1 : -1
    this.switchDur = Math.max(seconds, 0.05)
    this.switchT = out ? 0 : 1
  }

  beginReload(seconds: number, empty: boolean): void {
    this.reloadT = 0
    this.reloadDur = seconds
    this.reloadEmpty = empty
    this.inspectT = -1
  }

  cancelReload(): void {
    this.reloadT = -1
    this.magHidden = false
    this.magOffset.set(0, 0, 0)
  }

  beginInspect(seconds: number): void {
    if (this.reloadT >= 0) return
    this.inspectT = 0
    this.inspectDur = seconds
  }

  get reloadProgress(): number {
    return this.reloadT < 0 ? -1 : this.reloadT / this.reloadDur
  }

  get isBusy(): boolean {
    return this.reloadT >= 0
  }

  setMagVisible(v: boolean): void {
    this.magHidden = !v
  }

  /** Holds the slide back while the chamber is empty. */
  setSlideLocked(v: boolean): void {
    this.slideLocked = v
  }

  /** Per-shot kick, shell cycle and flash. */
  onFire(def: WeaponDef, adsAmount: number): void {
    const scale = 1 - adsAmount * 0.25
    this.recoilPos.nudge(0, 0.10 * def.recoil.kickBack * 60, def.recoil.kickBack * 60 * scale)
    this.recoilRot.nudge(def.recoil.kickUp * 60 * scale, def.recoil.kickUp * 12 * scale, def.recoil.kickRoll * 60 * scale)
    this.triggerPull.set(1)
    this.flashTimer = 0.045
    this.muzzleLight.intensity = 9 * def.muzzleFlashScale
    if (def.boltTravel > 0) this.boltBack = 1
    this.muzzleFlash.visible = true
    // Deterministic per-shot roll: varies the flash without breaking captures.
    this.muzzleFlash.rotation.z += 2.399963
  }

  /** Vertical landing impulse; drives the weapon dip on touchdown. */
  onLand(strength: number): void {
    this.landDip.nudge(-strength * 3.2)
  }

  // -- accessors used by the weapon system ---------------------------------

  get current(): WeaponModel | null {
    return this.model
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.copy(this.rig.position)
    return out.setFromMatrixPosition(this.model.muzzle.matrixWorld)
  }

  muzzleMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    if (!this.model) return out.identity()
    return out.copy(this.model.muzzle.matrixWorld)
  }

  portWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.copy(this.rig.position)
    return out.setFromMatrixPosition(this.model.ejectPort.matrixWorld)
  }

  /** Weapon-space direction to world space, for shell ejection velocity. */
  weaponDirToWorld(v: readonly [number, number, number], out: THREE.Vector3): THREE.Vector3 {
    out.set(v[0], v[1], v[2])
    if (this.model) out.applyQuaternion(this.model.root.getWorldQuaternion(_q2))
    return out
  }

  magWorld(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    if (!this.model) return
    this.model.magazine.matrixWorld.decompose(outPos, outQuat, _scale)
  }

  magDropPrototype(): THREE.Mesh | null {
    return this.model ? this.model.magDrop : null
  }

  // -- per-frame -----------------------------------------------------------

  update(dt: number, drive: VmDrive): void {
    const def = this.def
    const model = this.model
    if (!def || !model) return

    const step = dt > 0 ? dt : 1 / 240
    const settling = dt <= 0

    // The rig follows the camera, so the sun rim has to be re-solved into rig
    // space every frame. Everything it touches is hoisted; this allocates
    // nothing. Level comes first: the sun rim is scaled by it.
    this.syncToEnvironment(dt)
    this.syncToSun()

    // --- blends -----------------------------------------------------------
    const sprintTarget = drive.sprint > 0.5 && drive.ads < 0.5 && this.reloadT < 0 ? 1 : 0
    this.sprintBlend.step(sprintTarget, step, 11 / Math.max(def.sprintOutTime * 6, 0.2))
    this.lowReadyBlend.step(drive.lowReady, step, 8)

    const adsAllowed = drive.ads > 0.5 && this.sprintBlend.value < 0.6 && this.reloadT < 0 && this.switchT < 0.5
    // A fixed-duration ease reads far crisper than a spring for ADS.
    const rate = 1 / Math.max(def.adsTime, 0.02)
    const rawTarget = adsAllowed ? 1 : 0
    const cur = this.adsRaw.value
    this.adsRaw.set(cur + Math.max(-rate * step, Math.min(rate * step, rawTarget - cur)))
    this.adsFraction = adsEase(this.adsRaw.value)

    // --- base pose --------------------------------------------------------
    poseToQuat(def.hip, _p, _q1)
    if (this.lowReadyBlend.value > 0.001) {
      poseToQuat(def.lowReady, _p2, _q2)
      _p.lerp(_p2, this.lowReadyBlend.value)
      _q1.slerp(_q2, this.lowReadyBlend.value)
    }
    if (this.sprintBlend.value > 0.001) {
      poseToQuat(def.sprint, _p2, _q2)
      _p.lerp(_p2, this.sprintBlend.value)
      _q1.slerp(_q2, this.sprintBlend.value)
    }
    if (this.adsFraction > 0.0001) {
      this.solveAdsPose(def)
      _p.lerp(this.adsPos, this.adsFraction)
      _q1.slerp(this.adsQuat, this.adsFraction)
    }

    // --- additive layers --------------------------------------------------
    const ads = this.adsFraction
    const sprintAmt = this.sprintBlend.value
    let addX = 0, addY = 0, addZ = 0
    let rotX = 0, rotY = 0, rotZ = 0

    // Breathing: always present, damped hard while aiming.
    const breathe = (1 - ads * 0.72) * (1 - sprintAmt * 0.6)
    addX += Math.sin(drive.elapsed * 0.9) * 0.0018 * breathe
    addY += Math.sin(drive.elapsed * 1.37 + 1.1) * 0.0024 * breathe
    rotX += Math.sin(drive.elapsed * 1.12 + 0.4) * 0.0075 * breathe
    rotY += Math.sin(drive.elapsed * 0.73 + 2.0) * 0.0090 * breathe

    // Walk / run bob, synced to actual movement speed.
    const speed = Math.min(drive.speedFraction, 1.4)
    const bobFreq = sprintAmt > 0.5 ? 7.4 : 9.6
    if (!settling) this.bobPhase += step * bobFreq * (0.35 + speed)
    const bobAmp = speed * def.bobScale * (1 - ads * 0.86) * (1 + sprintAmt * 0.9)
    addX += Math.sin(this.bobPhase) * 0.0105 * bobAmp
    addY += Math.sin(this.bobPhase * 2) * 0.0062 * bobAmp
    addZ += Math.abs(Math.sin(this.bobPhase)) * 0.0038 * bobAmp
    rotZ += Math.sin(this.bobPhase) * 0.030 * bobAmp
    rotX += Math.sin(this.bobPhase * 2 + 0.6) * 0.016 * bobAmp

    // Sway lags the camera; more when moving, much less when aiming.
    const invDt = 1 / step
    const yawVel = Math.max(-7, Math.min(7, wrapAngle(drive.yawDelta) * invDt))
    const pitchVel = Math.max(-7, Math.min(7, drive.pitchDelta * invDt))
    const swayGain = def.swayScale * (1 - ads * 0.78) * (1 + speed * 0.55)
    this.swayPos.step(
      -yawVel * 0.0064 * swayGain,
      pitchVel * 0.0053 * swayGain,
      Math.abs(yawVel) * 0.0017 * swayGain,
      step, 13,
    )
    this.swayRot.step(
      -pitchVel * 0.022 * swayGain,
      yawVel * 0.026 * swayGain,
      -yawVel * 0.021 * swayGain,
      step, 11,
    )
    addX += this.swayPos.x
    addY += this.swayPos.y
    addZ += this.swayPos.z
    rotX += this.swayRot.x
    rotY += this.swayRot.y
    rotZ += this.swayRot.z

    // Landing dip.
    this.landDip.step(0, step, 22)
    addY += this.landDip.value * 0.012
    rotX += this.landDip.value * 0.05

    // Recoil springs return to rest; the impulses are applied in onFire.
    this.recoilPos.step(0, 0, 0, step, def.recoil.visualSnap)
    this.recoilRot.step(0, 0, 0, step, def.recoil.visualSnap * 0.92)
    addY += this.recoilPos.y
    addZ += this.recoilPos.z
    rotX += this.recoilRot.x
    rotY += this.recoilRot.y
    rotZ += this.recoilRot.z

    // Weapon switch: drop out of frame and rotate away.
    if (this.switchDir !== 0 && !settling) {
      this.switchT = Math.min(1, Math.max(0, this.switchT + this.switchDir * dt / this.switchDur))
      if ((this.switchDir > 0 && this.switchT >= 1) || (this.switchDir < 0 && this.switchT <= 0)) this.switchDir = 0
    }
    if (this.switchT > 0.001) {
      const s = this.switchT * this.switchT
      addY -= 0.26 * s
      addZ += 0.06 * s
      rotX -= 0.95 * s
      rotY += 0.35 * s
      rotZ += 0.30 * s
    }

    // --- scripted sequences ----------------------------------------------
    // Sequences run on real time so a frozen capture holds its exact frame.
    this.updateReload(settling ? 0 : dt, def, model, drive)
    this.updateInspect(settling ? 0 : dt)
    if (this.reloadT >= 0 || this.inspectT >= 0) {
      const keys = this.reloadT >= 0 ? RELOAD_WEAPON : INSPECT_TRACK
      const t = this.reloadT >= 0 ? this.reloadT / this.reloadDur : this.inspectT / this.inspectDur
      sampleTrack(keys, t, _v, _e)
      addX += _v.x; addY += _v.y; addZ += _v.z
      rotX += _e.x; rotY += _e.y; rotZ += _e.z
    }

    // --- compose ----------------------------------------------------------
    _e2.set(rotX, rotY, rotZ, 'XYZ')
    _qa.setFromEuler(_e2)
    const pivot = def.recoilPivot
    // Rotate about the shoulder pocket rather than the model origin, so the
    // muzzle climbs while the stock stays planted.
    _v2.set(pivot[0], pivot[1], pivot[2])
    _v.copy(_v2).applyQuaternion(_qa)
    _v2.sub(_v)
    _v2.x += addX
    _v2.y += addY
    _v2.z += addZ
    _v2.applyQuaternion(_q1)

    model.root.position.copy(_p).add(_v2)
    model.root.quaternion.copy(_q1).multiply(_qa)

    // --- animated sub parts ----------------------------------------------
    this.triggerPull.step(0, step, 45)
    model.trigger.rotation.x = -this.triggerPull.value * 0.28
    model.magazine.visible = !this.magHidden
    model.magazine.position.copy(this.magBase).add(this.magOffset)

    model.charging.position.z = this.chargePull * 0.075
    if (def.boltTravel > 0 && model.slide) {
      this.boltBack = Math.max(0, this.boltBack - step * 26)
      const t = Math.sin(Math.min(this.boltBack, 1) * Math.PI)
      // Locked back on empty until the reload seats a fresh magazine.
      model.slide.position.z = this.slideLocked && this.reloadT < 0 ? def.boltTravel : t * def.boltTravel
    } else if (def.boltTravel > 0) {
      this.boltBack = Math.max(0, this.boltBack - step * 12)
      model.charging.position.z += Math.sin(Math.min(this.boltBack, 1) * Math.PI) * def.boltTravel
    }

    // Left hand offset during reload.
    if (this.reloadT >= 0) {
      sampleTrack(RELOAD_HAND, this.reloadT / this.reloadDur, _v, _e)
      model.leftHand.position.copy(_v)
      model.leftHand.rotation.set(_e.x, _e.y, _e.z)
    } else if (model.leftHand.position.lengthSq() > 1e-8) {
      model.leftHand.position.multiplyScalar(Math.exp(-14 * step))
      model.leftHand.rotation.set(
        model.leftHand.rotation.x * Math.exp(-14 * step),
        model.leftHand.rotation.y * Math.exp(-14 * step),
        model.leftHand.rotation.z * Math.exp(-14 * step),
      )
    }

    // --- flash + optic ----------------------------------------------------
    if (this.flashTimer > 0 && !settling) {
      this.flashTimer -= step
      const k = Math.max(this.flashTimer, 0) / 0.045
      this.muzzleLight.intensity = 9 * def.muzzleFlashScale * k * k
      ;(this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = 0.85 * k
      this.muzzleFlash.scale.setScalar(def.muzzleFlashScale * (0.7 + (1 - k) * 0.5))
      if (this.flashTimer <= 0) {
        this.muzzleLight.intensity = 0
        this.muzzleFlash.visible = false
      }
    }
    this.muzzleLight.position.copy(model.muzzle.position).applyQuaternion(model.root.quaternion).add(model.root.position)
    this.muzzleFlash.position.copy(this.muzzleLight.position)

    this.updateReticle(model, def)

    // Keep world matrices current so muzzle and port queries next frame are
    // taken from the pose that was actually rendered.
    this.rig.updateMatrixWorld(true)
  }

  /** Root transform that places the sight axis exactly on the eye line. */
  private solveAdsPose(def: WeaponDef): void {
    _m1.makeTranslation(0, 0, -def.eyeRelief)
    _m2.multiplyMatrices(_m1, this.aimLocalInv)
    _m2.decompose(this.adsPos, this.adsQuat, _scale)
  }

  private updateReload(dt: number, def: WeaponDef, model: WeaponModel, _drive: VmDrive): void {
    if (this.reloadT < 0) return
    const prev = this.reloadT / this.reloadDur
    this.reloadT += dt
    const t = this.reloadT / this.reloadDur

    // Magazine: falls away at magOut, a fresh one rides up before magIn.
    if (t >= def.magOutAt && t < def.magInAt - 0.06) {
      const k = Math.min((t - def.magOutAt) / 0.13, 1)
      this.magOffset.set(0, -0.30 * k * k, 0.012 * k)
      if (k >= 1) this.magHidden = true
    } else if (t >= def.magInAt - 0.06 && t < def.magInAt) {
      this.magHidden = false
      const k = (def.magInAt - t) / 0.06
      this.magOffset.set(0, -0.16 * k * k, 0.006 * k)
    } else if (t >= def.magInAt) {
      this.magHidden = false
      // Seat, then a small settle bounce.
      const k = Math.max(0, 1 - (t - def.magInAt) / 0.05)
      this.magOffset.set(0, -0.004 * k, 0)
    } else {
      this.magHidden = false
      this.magOffset.set(0, 0, 0)
    }

    // Charging handle on an empty reload.
    if (this.reloadEmpty) {
      const c0 = def.chargeAt
      if (t > c0 && t < c0 + 0.05) this.chargePull = (t - c0) / 0.05
      else if (t >= c0 + 0.05 && t < c0 + 0.10) this.chargePull = 1 - (t - c0 - 0.05) / 0.05
      else this.chargePull = 0
    }

    // Mag-seat jolt.
    if (prev < def.magInAt && t >= def.magInAt) {
      this.recoilPos.nudge(0, -0.5, 0.4)
      this.recoilRot.nudge(-0.7, 0, 0)
    }
    if (this.reloadEmpty && prev < def.chargeAt + 0.05 && t >= def.chargeAt + 0.05) {
      this.recoilPos.nudge(0, 0.3, 0.5)
      this.recoilRot.nudge(0.5, 0, 0.3)
    }

    if (t >= 1) {
      this.reloadT = -1
      this.magHidden = false
      this.magOffset.set(0, 0, 0)
      this.chargePull = 0
      model.magazine.visible = true
    }
  }

  private updateInspect(dt: number): void {
    if (this.inspectT < 0) return
    this.inspectT += dt
    if (this.inspectT >= this.inspectDur) this.inspectT = -1
  }

  /**
   * Collimated reticle. It is placed on the ray from the eye along the sight
   * axis, so it is parallax free by construction: at full ADS that ray is the
   * screen centre, and off-axis it slides out of the window and fades, exactly
   * like a real red dot.
   */
  private updateReticle(model: WeaponModel, def: WeaponDef): void {
    if (model.reticleKind === 'none') {
      this.reticle.visible = false
      this.scopeMask.visible = false
      return
    }
    // Sight axis in rig (camera) space.
    _axis.copy(_fwd).applyQuaternion(model.root.quaternion).normalize()
    // Glass centre in rig space.
    _v.copy(model.glassOffset).applyQuaternion(model.root.quaternion).add(model.root.position)
    const dist = Math.max(_v.length(), 0.02)
    _v2.copy(_v).divideScalar(dist)
    const cosOff = Math.max(-1, Math.min(1, _v2.dot(_axis)))
    const offAngle = Math.acos(cosOff)
    const halfAngle = Math.atan2(model.windowRadius, dist)

    const vis = 1 - Math.min(1, Math.max(0, (offAngle - halfAngle * 0.45) / (halfAngle * 0.75)))
    const alpha = vis * vis * (model.reticleKind === 'cross' ? 1 : 0.95)
    this.reticle.visible = alpha > 0.01
    this.reticleMat.opacity = alpha
    if (this.reticle.visible) {
      const d = def.eyeRelief
      this.reticle.position.copy(_axis).multiplyScalar(d)
      const size = d * model.reticleAngle
      this.reticle.scale.set(size, size, 1)
    }

    if (model.reticleKind === 'cross') {
      const maskAlpha = Math.min(1, Math.max(0, (this.adsFraction - 0.72) / 0.24))
      this.scopeMask.visible = maskAlpha > 0.01
      this.scopeMaskMat.opacity = maskAlpha
      if (this.scopeMask.visible) {
        const d = dist
        const inner = model.windowRadius + 0.006
        this.scopeMask.position.copy(_axis).multiplyScalar(d)
        this.scopeMask.quaternion.setFromUnitVectors(_zAxis, _v2.copy(_axis).negate())
        this.scopeMask.scale.set(inner, inner, 1)
      }
    }
  }

  /** Rig follows the viewmodel camera exactly; called from lateUpdate. */
  followCamera(): void {
    const cam = this.ctx.viewmodelCamera
    // Safety net: if nothing has synced the viewmodel camera yet, follow the
    // world camera so the weapon is never stranded at the origin.
    if (cam.position.lengthSq() < 1e-8 && this.ctx.camera.position.lengthSq() > 1e-8) {
      cam.position.copy(this.ctx.camera.position)
      cam.quaternion.copy(this.ctx.camera.quaternion)
    }
    cam.updateMatrixWorld(true)
    cam.matrixWorld.decompose(_p, _q1, _scale)
    this.rig.position.copy(_p)
    this.rig.quaternion.copy(_q1)
    this.rig.updateMatrixWorld(true)
  }

  /**
   * Ties the studio rig's colour and its sun rim to the world it stands in.
   * Overall level is handled separately, in `syncToEnvironment`.
   */
  syncToSun(): void {
    const lighting = this.ctx.services.lighting
    if (!lighting?.sun) return
    this.keyLight.color.copy(lighting.sun.color).lerp(this.keyWarm, 0.5)
    this.sunRim.color.copy(lighting.sun.color).lerp(this.rimWarm, 0.3)

    // World sun direction into rig (camera) space, so a backlit weapon rims on
    // the side the sun is actually on.
    const dir = lighting.sunDirection
    if (dir.lengthSq() < 1e-6) return
    this.rigInv.copy(this.rig.quaternion).invert()
    this.sunLocal.copy(dir).applyQuaternion(this.rigInv).normalize()
    this.sunRim.position.copy(this.sunLocal).multiplyScalar(2.4).add(this.focusPoint)
    // Fades out rather than swinging under the weapon once the sun sets.
    const elev = Math.min(1, Math.max(0, (dir.y + 0.04) / 0.18))
    // -Z is forward, so a negative local z means the player is looking into the
    // sun and the weapon is backlit -- the case that needs the edge. Facing
    // away, the same light would land on the camera side and act as a second
    // key, so it is held down to a trim. The weapon's overall exposure stays
    // put while the sun still tells you which way it is coming from.
    const backlit = Math.min(1, Math.max(0, -this.sunLocal.z))
    this.sunRim.intensity =
      RIG.sunRim * elev * elev * (3 - 2 * elev) * (0.35 + 0.65 * backlit) * this.envScale
  }

  /**
   * Partial coupling between the studio rig and the world's light level.
   *
   * Round 2 shipped a viewmodel whose rig was modulated by scene brightness and
   * got a black silhouette in the alley; round 3 answered it by nailing the rig
   * to a constant and got a chalk-white rifle in the same alley. Both are the
   * same mistake at opposite ends: a viewmodel needs to *track* the light it
   * stands in, between a floor and a ceiling, never all the way to either.
   *
   * The frames make the mechanism explicit. The post chain meters the frame and
   * compensates exposure, so a fixed-radiance weapon is graded up in an
   * enclosed shot and down in an open one — measured over the eight poses the
   * weapon's screen luma ran 54.6 in the alley against a 47.6 scene, and 17.8
   * in the plaza against a 68.3 scene. That is the *inverse* of the correct
   * relationship, and it is not something a tone curve can undo: the weapon has
   * to emit less light in a dark place so that the meter lifts weapon and world
   * together instead of prising them apart.
   *
   * `PostFxService` exposes no meter reading, so the level is estimated from
   * the world instead, by how much sky the player can see: rays into the upper
   * hemisphere plus the level's own indoor volumes. Sky visibility is what
   * actually separates the enclosed poses from the open ones, and unlike a
   * sun-shadow test it does not collapse when the player stands in the shadow
   * of a building on an open plaza — which is exactly the plaza pose.
   *
   * The sweep is one ray per frame and only runs when the player has moved or
   * on a slow heartbeat, so the steady-state per-frame cost is zero.
   */
  syncToEnvironment(dt: number): void {
    const first = !this.probed
    this.stepProbe(dt)

    // Snap on the first result so a capture that freezes early is never graded
    // mid-blend, then follow slowly enough that walking through a doorway reads
    // as an eye adapting rather than as a light switch.
    if (first || dt <= 0) this.envScale = this.envTarget
    else this.envScale += (this.envTarget - this.envScale) * (1 - Math.exp(-2.2 * dt))

    if (Math.abs(this.envScale - this.envApplied) < 0.002) return
    this.envApplied = this.envScale
    this.keyLight.intensity = RIG.key * this.envScale
    this.fillLight.intensity = RIG.fill * this.envScale
    this.rimLight.intensity = RIG.rim * this.envScale
    this.bounceLight.intensity = RIG.bounce * this.envScale
    this.mats.setEnvironmentScale(this.envScale)
  }

  /**
   * Advances the sky-visibility sweep by at most one ray.
   *
   * `PhysicsService.raycast` allocates its hit record, so this is deliberately
   * not a per-frame path: a sweep starts only when the eye has moved 0.35m or
   * once a second, and then retires one direction per frame. Standing still —
   * which is every captured pose — it does nothing at all.
   */
  private stepProbe(dt: number): void {
    const ctx = this.ctx
    const eye = ctx.camera.position

    if (this.probeIndex < 0) {
      this.probeTimer += dt > 0 ? dt : 0
      const moved = this.probed && this.probeAt.distanceToSquared(eye) > 0.1225
      if (this.probed && !moved && this.probeTimer < 1) return
      this.probeIndex = 0
      this.probeOpen = 0
      this.probeWeight = 0
      this.probeTimer = 0
      this.probeAt.copy(eye)
      return
    }

    const phys = ctx.services.physics
    const d = PROBE_DIRS[this.probeIndex]
    if (phys) {
      this.probeDir.set(d[0], d[1], d[2])
      const hit = phys.raycast(this.probeAt, this.probeDir, PROBE_RANGE, PROBE_FILTER)
      // Any hit means no sky down that direction, so a blocked ray is worth
      // little however far away the thing blocking it is -- the small residual
      // is the bounce off the surface it hit. Softening by distance only stops
      // the estimate snapping as the player walks past a wall.
      const open = hit ? 0.10 + 0.45 * Math.min(1, hit.distance / PROBE_RANGE) : 1
      this.probeOpen += open * d[3]
    } else {
      this.probeOpen += d[3]
    }
    this.probeWeight += d[3]
    this.probeIndex++

    if (this.probeIndex < PROBE_DIRS.length) return
    this.probeIndex = -1
    let open = this.probeWeight > 0 ? this.probeOpen / this.probeWeight : 1
    // A roofed volume the level has declared is authoritative: a room with a
    // window can leak enough rays to read as open sky, and it is never lit
    // like it.
    if (ctx.services.level?.isIndoors(this.probeAt)) open = Math.min(open, 0.22)
    const s = open * open * (3 - 2 * open)
    this.envTarget = ENV_FLOOR + (ENV_CEIL - ENV_FLOOR) * s
    this.probed = true
  }

  dispose(): void {
    this.studioTarget?.dispose()
    this.studioTarget = null
    this.studioEnv = null
    for (const model of this.models.values()) {
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      model.magDrop.geometry.dispose()
    }
    this.models.clear()
  }
}

function poseToQuat(pose: VmPose, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
  outP.set(pose.pos[0], pose.pos[1], pose.pos[2])
  _e.set(pose.rot[0], pose.rot[1], pose.rot[2], 'XYZ')
  outQ.setFromEuler(_e)
}
