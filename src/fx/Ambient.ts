import * as THREE from 'three'
import { SPRITE, type FxTextureSet } from './FxTextures'
import type { Particles } from './Particles'
import type { GameContext } from '../core/Types'
import { Rand } from '../core/Rand'

/**
 * Ambient life: the stuff that is happening whether or not the player pulls
 * the trigger. A completely still world reads as a diorama; motes catching the
 * sun, litter tumbling down the street and a low haze off hot ground are what
 * make a static frame feel inhabited.
 *
 * Everything here is metered by a fixed-interval accumulator driven from the
 * simulation clock rather than the frame rate, so a given `elapsed` always
 * produces the same number of emissions and captures reproduce.
 */

const PAPER_COUNT = 7

export class Ambient {
  private readonly rand: Rand
  private readonly paper: THREE.InstancedMesh
  private readonly paperMaterial: THREE.MeshStandardMaterial
  private readonly paperGround: number[] = []
  private readonly paperSeed: number[] = []
  private readonly paperProbe: number[] = []

  private moteTimer = 0
  private driftTimer = 0
  private hazeTimer = 0

  private readonly pos = new THREE.Vector3()
  private readonly fwd = new THREE.Vector3()
  private readonly sun = new THREE.Vector3(0.4, 0.72, 0.56).normalize()
  private readonly toSun = new THREE.Vector3()
  private readonly down = new THREE.Vector3(0, -1, 0)
  private readonly m4 = new THREE.Matrix4()
  private readonly quat = new THREE.Quaternion()
  private readonly euler = new THREE.Euler()
  private readonly scaleVec = new THREE.Vector3()
  private readonly windDir = new THREE.Vector3(0.82, 0, -0.57).normalize()

  constructor(scene: THREE.Scene, textures: FxTextureSet, seed: number, private readonly particles: Particles) {
    this.rand = new Rand(seed ^ 0x2ab41d)

    this.paperMaterial = new THREE.MeshStandardMaterial({
      map: textures.paper,
      color: 0xa39a89,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    })
    this.paperMaterial.name = 'fx-litter'
    const geo = new THREE.PlaneGeometry(0.21, 0.29, 2, 2)
    // A slight fold keeps the sheet from disappearing edge-on.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, Math.cos(pos.getX(i) * 9) * 0.018 + Math.sin(pos.getY(i) * 7) * 0.012)
    }
    geo.computeVertexNormals()

    this.paper = new THREE.InstancedMesh(geo, this.paperMaterial, PAPER_COUNT)
    this.paper.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.paper.castShadow = true
    this.paper.receiveShadow = true
    this.paper.frustumCulled = false
    this.paper.name = 'fx-litter'
    scene.add(this.paper)

    for (let i = 0; i < PAPER_COUNT; i++) {
      this.paperGround.push(0)
      this.paperSeed.push(this.rand.range(0, 1000))
      this.paperProbe.push(this.rand.range(0, 0.4))
      this.paper.setMatrixAt(i, this.m4.makeScale(0, 0, 0))
    }
    this.paper.instanceMatrix.needsUpdate = true
  }

  update(ctx: GameContext, time: number, dt: number): void {
    if (dt <= 0) return

    const lighting = ctx.services.lighting
    if (lighting) this.sun.copy(lighting.sunDirection).negate().normalize()
    this.toSun.copy(this.sun)

    ctx.camera.getWorldDirection(this.fwd)
    // Forward scattering: motes light up when you look into the sun.
    const backlit = THREE.MathUtils.clamp(this.fwd.dot(this.toSun) * 0.5 + 0.5, 0, 1)

    this.motes(ctx, time, dt, backlit)
    this.groundDrift(ctx, time, dt)
    this.haze(ctx, time, dt)
    this.litter(ctx, time, dt)
  }

  /**
   * Fine dust suspended in the air, brightest where a sunbeam reaches it.
   *
   * Motes are sized in *screen* space, not world space: a mote is a couple of
   * pixels whether it is one metre away or twelve. Sizing them in metres is
   * what turned the ones nearest the lens into bright white lozenges with no
   * visible source — the "floating specks" the frames were showing. Real
   * particulate reads as a sparkle at the resolution limit, never as a shape.
   */
  private motes(ctx: GameContext, time: number, dt: number, backlit: number): void {
    const budget = ctx.config.particleBudget
    const interval = budget >= 8000 ? 1 / 34 : budget >= 4000 ? 1 / 18 : 1 / 8
    this.moteTimer -= dt
    let spawned = 0
    const r = this.rand
    const physics = ctx.services.physics
    // Metres of world size per metre of distance that subtends ~3px at 1080p
    // with the default 80 degree vertical FOV.
    const perMetre = 0.0047

    while (this.moteTimer <= 0 && spawned < 6) {
      this.moteTimer += interval
      spawned++

      const cam = ctx.camera.position
      this.pos.set(
        cam.x + this.fwd.x * 5 + r.spread(9),
        cam.y + r.range(-1.6, 4.5),
        cam.z + this.fwd.z * 5 + r.spread(9),
      )
      const dist = this.pos.distanceTo(cam)
      // Anything inside arm's reach is a lens artefact, not atmosphere.
      if (dist < 1.6) continue

      // One cheap shadow probe per mote is affordable at this rate and is what
      // makes the motes gather in shafts instead of filling the whole volume.
      let lit = 1
      if (physics) {
        const hit = physics.raycast(this.pos, this.toSun, 26, { characters: false })
        if (hit) lit = 0.12
      }
      const brightness = (0.2 + backlit * 0.6) * lit

      const p = this.particles.params
      p.position.copy(this.pos)
      p.velocity.set(r.spread(0.12), r.range(-0.02, 0.09), r.spread(0.12))
      p.life = r.range(6, 13)
      p.sizeStart = dist * perMetre * r.range(0.7, 1.25)
      p.sizeEnd = p.sizeStart
      p.drag = 0.5
      p.gravity = 0.004
      p.turbulence = 0.055
      p.colorStart.setRGB(1.15 * brightness, 1.05 * brightness, 0.88 * brightness)
      p.colorEnd.setRGB(0.9 * brightness, 0.82 * brightness, 0.7 * brightness)
      p.alphaStart = 0.4 * lit
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.tile = SPRITE.spark
      p.soft = 0
      this.particles.emit('spriteAdd', time)
    }
  }

  /** Sand and grit skittering along the ground on the wind. */
  private groundDrift(ctx: GameContext, time: number, dt: number): void {
    if (this.particles.allowance() < 0.5) return
    const interval = ctx.config.particleBudget >= 8000 ? 1 / 9 : 1 / 4
    this.driftTimer -= dt
    let spawned = 0
    const r = this.rand
    const physics = ctx.services.physics

    while (this.driftTimer <= 0 && spawned < 3) {
      this.driftTimer += interval
      spawned++

      const cam = ctx.camera.position
      this.pos.set(cam.x + this.fwd.x * 9 + r.spread(11), cam.y + 3, cam.z + this.fwd.z * 9 + r.spread(11))
      // Drift belongs in the middle distance. Close in it is a translucent
      // sheet over the one part of the frame that has to be the sharpest.
      if (Math.abs(this.pos.x - cam.x) + Math.abs(this.pos.z - cam.z) < 4.5) continue
      let groundY = 0
      if (physics) {
        const hit = physics.raycast(this.pos, this.down, 14, { characters: false })
        if (!hit) continue
        groundY = hit.point.y
      }
      this.pos.y = groundY + r.range(0.02, 0.35)

      const p = this.particles.params
      p.position.copy(this.pos)
      p.velocity.copy(this.windDir).multiplyScalar(r.range(1.6, 4.4))
      p.velocity.y = r.range(0.05, 0.5)
      p.life = r.range(1.6, 3.4)
      p.sizeStart = r.range(0.04, 0.1)
      p.sizeEnd = r.range(0.22, 0.45)
      p.drag = 1.1
      p.gravity = 0.05
      p.turbulence = 0.34
      p.colorStart.setHex(0xbfb49c, THREE.SRGBColorSpace)
      p.colorEnd.setHex(0x8e8470, THREE.SRGBColorSpace)
      p.alphaStart = 0.11
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.8)
      p.tile = r.int(0, 4)
      p.frames = 16
      p.erode = 0.7
      p.soft = 0.4
      this.particles.emit('smoke', time)
    }
  }

  /** Heat shimmer rising off sun-baked ground in the middle distance. */
  private haze(ctx: GameContext, time: number, dt: number): void {
    if (ctx.config.particleBudget < 4000) return
    // Atmosphere is the first thing to give way when the frame is already
    // carrying combat smoke: it is the layer nobody would miss.
    if (this.particles.allowance() < 0.6) return
    const interval = 1 / 6
    this.hazeTimer -= dt
    let spawned = 0
    const r = this.rand
    const physics = ctx.services.physics

    while (this.hazeTimer <= 0 && spawned < 2) {
      this.hazeTimer += interval
      spawned++

      const cam = ctx.camera.position
      const dist = r.range(9, 30)
      const spreadAngle = r.spread(0.55)
      const cos = Math.cos(spreadAngle)
      const sin = Math.sin(spreadAngle)
      const dx = this.fwd.x * cos - this.fwd.z * sin
      const dz = this.fwd.x * sin + this.fwd.z * cos
      this.pos.set(cam.x + dx * dist, cam.y + 4, cam.z + dz * dist)

      let groundY = 0
      if (physics) {
        const hit = physics.raycast(this.pos, this.down, 20, { characters: false })
        if (!hit) continue
        // Only ground-ish surfaces bake in the sun.
        if (hit.normal.y < 0.7) continue
        groundY = hit.point.y
      }
      this.pos.y = groundY + r.range(0.1, 0.7)

      const p = this.particles.params
      p.position.copy(this.pos)
      p.velocity.set(r.spread(0.15), r.range(0.45, 1.1), r.spread(0.15))
      p.life = r.range(1.8, 3.2)
      p.sizeStart = r.range(0.5, 1.1)
      p.sizeEnd = r.range(1.4, 2.6)
      p.drag = 0.8
      p.gravity = -0.14
      p.turbulence = 1.35
      p.colorStart.setRGB(0.26, 0.23, 0.18)
      p.colorEnd.setRGB(0.1, 0.09, 0.07)
      p.alphaStart = 0.055
      p.alphaEnd = 0
      p.rotation = r.range(0, 6.28)
      p.rotationSpeed = r.spread(0.9)
      p.tile = r.int(0, 8)
      p.frames = 16
      p.erode = 0.8
      p.soft = 1.2
      this.particles.emit('smokeAdd', time)
    }
  }

  /**
   * Wind-blown paper skittering down the street.
   *
   * It stays on the street: an earlier version let each sheet loft nearly a
   * metre and accepted whatever surface the downward probe found, so scraps
   * ended up hovering over awnings and stall roofs as hard-edged white
   * polygons with no shading, no contact and no visible cause. A sheet is only
   * drawn when the ground under it is at least a metre below the eye — i.e.
   * actual ground — and it never lifts more than ankle height.
   */
  private litter(ctx: GameContext, time: number, dt: number): void {
    const physics = ctx.services.physics
    const cam = ctx.camera.position
    const span = 34

    for (let i = 0; i < PAPER_COUNT; i++) {
      const seed = this.paperSeed[i]
      const speed = 1.5 + (i % 3) * 0.55

      // Deterministic path: a wrapping run along the wind with a lateral weave.
      const along = ((time * speed + seed) % span) - span * 0.5
      const lateral = Math.sin(time * 0.7 + seed) * 2.4 + ((seed % 7) - 3) * 1.8

      this.pos.set(
        cam.x + this.windDir.x * along - this.windDir.z * lateral,
        cam.y,
        cam.z + this.windDir.z * along + this.windDir.x * lateral,
      )

      // Probe for the ground at a staggered cadence so the cost is trivial.
      this.paperProbe[i] -= dt
      if (this.paperProbe[i] <= 0) {
        this.paperProbe[i] += 0.35
        if (physics) {
          this.pos.y = cam.y + 3
          const hit = physics.raycast(this.pos, this.down, 16, { characters: false })
          this.paperGround[i] = hit ? hit.point.y : cam.y - 1.68
        } else {
          this.paperGround[i] = cam.y - 1.68
        }
      }

      const ground = this.paperGround[i]
      const bob = Math.abs(Math.sin(time * 1.9 + seed * 1.3))
      this.pos.y = ground + 0.015 + bob * bob * 0.16

      this.euler.set(time * 3.1 + seed, time * 2.2 + seed * 0.7, time * 4.3 + seed * 1.9)
      this.quat.setFromEuler(this.euler)
      const near = this.pos.distanceTo(cam)
      const onStreet = ground < cam.y - 1.0
      // Fade in with distance rather than popping to full size at a hard cut.
      const grow = THREE.MathUtils.smoothstep(near, 2.2, 4.5) * (1 - THREE.MathUtils.smoothstep(near, 16, 22))
      this.scaleVec.setScalar(onStreet ? grow : 0)
      this.m4.compose(this.pos, this.quat, this.scaleVec)
      this.paper.setMatrixAt(i, this.m4)
    }
    this.paper.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.paper.geometry.dispose()
    this.paperMaterial.dispose()
    this.paper.removeFromParent()
  }
}
