import * as THREE from 'three'
import type { GameContext } from '../core/Types'
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
  private aimLocalInv = new THREE.Matrix4()
  private adsPos = new THREE.Vector3()
  private adsQuat = new THREE.Quaternion()

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

  private setupLighting(): void {
    const ctx = this.ctx
    const shadows = ctx.config.quality === 'high' || ctx.config.quality === 'ultra'

    // View-space key light: the weapon always reads well regardless of where
    // the player is looking, which is what shipped shooters do.
    const key = new THREE.DirectionalLight(0xfff0dd, 3.1)
    key.position.set(0.55, 0.85, 0.35)
    const target = new THREE.Object3D()
    target.position.set(0.02, -0.06, -0.34)
    this.rig.add(target)
    key.target = target
    if (shadows) {
      key.castShadow = true
      key.shadow.mapSize.set(1024, 1024)
      const cam = key.shadow.camera
      cam.left = -0.5; cam.right = 0.5; cam.top = 0.5; cam.bottom = -0.5
      cam.near = 0.05; cam.far = 3.2
      cam.updateProjectionMatrix()
      key.shadow.bias = -0.0006
      key.shadow.normalBias = 0.0025
      key.shadow.radius = 2
    }
    this.rig.add(key)
    this.keyLight = key

    // Cool rim from behind the shoulder separates the weapon from the world.
    const rim = new THREE.DirectionalLight(0x9fc0ff, 1.7)
    rim.position.set(-0.7, 0.35, 0.6)
    const rimTarget = new THREE.Object3D()
    rimTarget.position.set(0, -0.05, -0.3)
    this.rig.add(rimTarget)
    rim.target = rimTarget
    this.rig.add(rim)

    // Sky/ground bounce. World oriented, so it flips as the player looks around.
    const fill = new THREE.HemisphereLight(0xa8c4e8, 0x2a241c, 0.75)
    ctx.viewmodelScene.add(fill)

    const env = this.ctx.services.lighting?.environment
    if (env) {
      this.ctx.viewmodelScene.environment = env
    } else {
      this.ctx.viewmodelScene.environment = this.makeStudioEnvironment()
    }
    this.ctx.viewmodelScene.environmentIntensity = 0.85
  }

  /** Fallback IBL so metal still has something to reflect. */
  private makeStudioEnvironment(): THREE.Texture | null {
    try {
      const pmrem = new THREE.PMREMGenerator(this.ctx.renderer)
      const scene = new THREE.Scene()
      const panel = (color: number, intensity: number, pos: [number, number, number], size: [number, number, number]) => {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(size[0], size[1], size[2]),
          new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }),
        )
        m.material.color.multiplyScalar(intensity)
        m.position.set(pos[0], pos[1], pos[2])
        scene.add(m)
      }
      panel(0x9fc4ff, 1.0, [0, 0, 0], [20, 20, 20])
      panel(0xfff2d8, 3.2, [4, 6, -3], [5, 3, 5])
      panel(0x243040, 0.5, [0, -8, 0], [20, 2, 20])
      const rt = pmrem.fromScene(scene, 0.02)
      pmrem.dispose()
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
        }
      })
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
    this.reticleMat.color.set(model.reticleKind === 'cross' ? 0xffffff : 0xff2a12)
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

  /** Tints the key light toward the world sun so the weapon matches the scene. */
  syncToSun(): void {
    const lighting = this.ctx.services.lighting
    if (!lighting?.sun) return
    this.keyLight.color.copy(lighting.sun.color).lerp(new THREE.Color(0xfff0dd), 0.45)
  }

  dispose(): void {
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
