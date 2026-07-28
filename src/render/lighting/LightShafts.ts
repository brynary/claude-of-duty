import * as THREE from 'three'
import { Rand } from '../../core/Rand'
import type { GameContext } from '../../core/Types'

/**
 * Volumetric sun shafts.
 *
 * Where the shafts go is discovered from the world rather than authored, since
 * the level is built by another system and this one cannot know where its
 * windows are. The probe walks a grid of floor samples, asks physics whether
 * each one can see the sun, and keeps the lit samples that sit inside a
 * shadowed neighbourhood. A lit patch surrounded by shadow is, geometrically, a
 * hole in something -- a window, a doorway, a gap between two buildings -- which
 * is exactly where a shaft belongs.
 *
 * Each shaft then raymarches a Gaussian beam analytically in world space. The
 * mesh is only a proxy hull to generate fragments and to depth-test against the
 * room it lives in.
 */

interface ShaftSpec {
  /** Aperture centre: where the beam enters. */
  origin: THREE.Vector3
  /** Direction of travel, i.e. away from the sun. */
  axis: THREE.Vector3
  length: number
  radius: number
  strength: number
}

const BEAM_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 uOrigin;
uniform vec3 uAxis;
uniform float uRadius;
uniform float uLength;
uniform vec3 uColor;
uniform float uDensity;
uniform float uTime;
uniform float uCamInside;

varying vec3 vWorld;

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

float vnoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = hash13( i );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z );
}

void main() {
  // Only the hull surface facing the viewer contributes, otherwise a two-sided
  // proxy would integrate the same beam twice. Which side that is flips when
  // the camera walks into the beam.
  float faceWeight = gl_FrontFacing ? ( 1.0 - uCamInside ) : uCamInside;
  if ( faceWeight < 0.5 ) discard;

  vec3 ro = cameraPosition;
  vec3 rd = vWorld - ro;
  float toSurface = length( rd );
  rd /= max( toSurface, 1e-5 );

  // Ray against the infinite cylinder that bounds the Gaussian.
  float cutoff = uRadius * 2.6;
  vec3 oc = ro - uOrigin;
  float ad = dot( uAxis, rd );
  float ao = dot( uAxis, oc );
  vec3 pd = rd - uAxis * ad;
  vec3 po = oc - uAxis * ao;
  float a = dot( pd, pd );
  float b = 2.0 * dot( pd, po );
  float c = dot( po, po ) - cutoff * cutoff;
  float disc = b * b - 4.0 * a * c;
  if ( disc <= 0.0 || a < 1e-7 ) discard;

  float sq = sqrt( disc );
  float t0 = ( -b - sq ) / ( 2.0 * a );
  float t1 = ( -b + sq ) / ( 2.0 * a );

  // Clip to the axial extent of the beam.
  if ( abs( ad ) > 1e-5 ) {
    float ta = -ao / ad;
    float tb = ( uLength - ao ) / ad;
    t0 = max( t0, min( ta, tb ) );
    t1 = min( t1, max( ta, tb ) );
  } else if ( ao < 0.0 || ao > uLength ) {
    discard;
  }

  t0 = max( t0, 0.0 );
  if ( t1 <= t0 ) discard;

  const int STEPS = 12;
  float dt = ( t1 - t0 ) / float( STEPS );
  // Interleaved offset breaks the banding a fixed step would otherwise show.
  float jitter = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  float acc = 0.0;
  float invTwoSigmaSq = 1.0 / ( 2.0 * uRadius * uRadius );
  vec3 drift = uAxis * uTime * 0.12;

  for ( int i = 0; i < STEPS; i ++ ) {
    float t = t0 + ( float( i ) + jitter ) * dt;
    vec3 p = ro + rd * t;
    vec3 rel = p - uOrigin;
    float s = dot( rel, uAxis );
    vec3 perp = rel - uAxis * s;
    float radial = exp( -dot( perp, perp ) * invTwoSigmaSq );
    // Bright at the aperture, thinning out as the beam spends its energy.
    float axial = smoothstep( 0.0, uLength * 0.18, s ) * ( 1.0 - 0.75 * smoothstep( uLength * 0.35, uLength, s ) );
    float dust = 0.62 + 0.75 * vnoise( p * 1.35 - drift );
    acc += radial * axial * dust;
  }
  acc *= dt;

  // Forward scattering: a beam viewed head-on into the light is far brighter
  // than the same beam viewed across. This is most of what reads as "volume".
  float forward = clamp( dot( rd, -uAxis ), 0.0, 1.0 );
  acc *= mix( 0.45, 2.1, forward * forward );

  // Fade out where the hull meets whatever it is standing on, so the beam does
  // not terminate in a hard elliptical edge on the floor.
  acc *= smoothstep( 0.0, 1.2, toSurface );

  gl_FragColor = vec4( uColor * acc * uDensity, 1.0 );

  #include <colorspace_fragment>
}
`

const MOTE_VERTEX = /* glsl */ `
attribute vec3 aBase;
attribute vec3 aDrift;
attribute float aPhase;
attribute float aSize;

uniform float uTime;
uniform float uProjScale;

varying float vFade;

void main() {
  float t = uTime * 0.35 + aPhase;
  vec3 wobble = aDrift * vec3( sin( t ), sin( t * 0.61 + 1.7 ), cos( t * 0.83 ) );
  vec4 mv = viewMatrix * vec4( aBase + wobble, 1.0 );
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  // aSize is a world diameter in metres; uProjScale converts it to pixels.
  gl_PointSize = clamp( aSize * uProjScale / max( dist, 0.2 ), 1.0, 9.0 );
  // Motes right against the lens read as dirt on the sensor, so fade them in.
  vFade = smoothstep( 0.35, 1.4, dist ) * ( 0.45 + 0.55 * ( 0.5 + 0.5 * sin( t * 1.9 ) ) );
}
`

const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vFade;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d );
  if ( r2 > 0.25 ) discard;
  float falloff = exp( -r2 * 14.0 );
  gl_FragColor = vec4( uColor * falloff * vFade * uIntensity, 1.0 );

  #include <colorspace_fragment>
}
`

const MAX_SHAFTS: Record<string, number> = { low: 0, medium: 3, high: 5, ultra: 6 }
const MOTES_PER_SHAFT = 90

export class LightShafts {
  /** Bounce fill positions the lighting system turns into interior lamps. */
  readonly fillPoints: THREE.Vector3[] = []
  private group = new THREE.Group()
  private meshes: THREE.Mesh[] = []
  private materials: THREE.ShaderMaterial[] = []
  private specs: ShaftSpec[] = []
  private hull: THREE.CylinderGeometry
  private moteGeometry: THREE.BufferGeometry | null = null
  private motePoints: THREE.Points | null = null
  private moteMaterial: THREE.ShaderMaterial | null = null

  private readonly upAxis = new THREE.Vector3(0, 1, 0)
  private readonly tmpQuat = new THREE.Quaternion()
  private readonly tmpVec = new THREE.Vector3()
  private readonly tmpVec2 = new THREE.Vector3()

  constructor(scene: THREE.Object3D) {
    this.group.name = 'lightShafts'
    scene.add(this.group)
    // Capped: an open cylinder has no front face when looked at end-on, and the
    // beam would vanish exactly when the player turns to face down it.
    this.hull = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false)
  }

  get count(): number {
    return this.meshes.length
  }

  /**
   * Probes the world and rebuilds the shafts. Runs once, after the level has
   * registered its collision, and again only if the sun is moved.
   */
  build(ctx: GameContext, sunDir: THREE.Vector3, color: THREE.Color, density: number): void {
    this.clear()
    const budget = MAX_SHAFTS[ctx.config.quality] ?? 4
    if (budget <= 0 || sunDir.y <= 0.02) return

    const specs = this.probe(ctx, sunDir, budget)
    if (specs.length === 0) return
    this.specs = specs

    for (const spec of specs) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uOrigin: { value: spec.origin.clone() },
          uAxis: { value: spec.axis.clone() },
          uRadius: { value: spec.radius },
          uLength: { value: spec.length },
          uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
          uDensity: { value: density * spec.strength },
          uTime: { value: 0 },
          uCamInside: { value: 0 },
        },
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      })

      const mesh = new THREE.Mesh(this.hull, material)
      const cutoff = spec.radius * 2.6
      // Half a metre of slack at each end so the caps are buried in the roof
      // and the floor rather than coplanar with them; the shader clips the
      // march back to the true beam extent regardless.
      mesh.scale.set(cutoff, spec.length + 1, cutoff)
      mesh.position.copy(spec.origin).addScaledVector(spec.axis, spec.length * 0.5)
      mesh.quaternion.copy(this.tmpQuat.setFromUnitVectors(this.upAxis, spec.axis))
      mesh.renderOrder = 12
      mesh.frustumCulled = true
      mesh.name = 'sunShaft'
      this.group.add(mesh)
      this.meshes.push(mesh)
      this.materials.push(material)
    }

    this.buildMotes(ctx, specs, color)
  }

  /**
   * Grid probe. Every sample answers three questions: where is the floor, is
   * there a roof over it, and can it see the sun.
   */
  private probe(ctx: GameContext, sunDir: THREE.Vector3, budget: number): ShaftSpec[] {
    const physics = ctx.services.physics
    if (!physics) return []
    const level = ctx.services.level
    const bounds = level?.bounds ?? new THREE.Box3(
      new THREE.Vector3(-40, -2, -40),
      new THREE.Vector3(40, 30, 40),
    )

    const minX = bounds.min.x
    const minZ = bounds.min.z
    const spanX = Math.max(4, bounds.max.x - minX)
    const spanZ = Math.max(4, bounds.max.z - minZ)
    const step = 2
    const nx = Math.min(56, Math.max(4, Math.round(spanX / step)))
    const nz = Math.min(56, Math.max(4, Math.round(spanZ / step)))
    const dx = spanX / nx
    const dz = spanZ / nz
    const skyY = bounds.max.y + 4

    const cells = nx * nz
    const floorY = new Float32Array(cells)
    const ceilY = new Float32Array(cells)
    const valid = new Uint8Array(cells)
    const lit = new Uint8Array(cells)
    const roofed = new Uint8Array(cells)

    const down = new THREE.Vector3(0, -1, 0)
    const up = new THREE.Vector3(0, 1, 0)
    const from = new THREE.Vector3()

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix
        const x = minX + (ix + 0.5) * dx
        const z = minZ + (iz + 0.5) * dz
        from.set(x, skyY, z)
        const ground = physics.raycast(from, down, skyY - bounds.min.y + 6, { characters: false })
        if (!ground) continue
        valid[i] = 1
        floorY[i] = ground.point.y

        from.set(x, ground.point.y + 0.15, z)
        const blocked = physics.raycast(from, sunDir, 260, { characters: false })
        lit[i] = blocked ? 0 : 1
        if (!blocked) {
          // Only lit samples can become shafts, and only they need a ceiling.
          from.set(x, ground.point.y + 0.2, z)
          const roof = physics.raycast(from, up, 14, { characters: false })
          if (roof) {
            roofed[i] = 1
            ceilY[i] = from.y + roof.distance
          }
        }
      }
    }

    // A shaft is a lit sample whose neighbourhood is mostly in shadow.
    const candidate = new Uint8Array(cells)
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix
        if (!valid[i] || !lit[i]) continue
        let dark = 0
        let seen = 0
        for (let oz = -2; oz <= 2; oz++) {
          for (let ox = -2; ox <= 2; ox++) {
            if (ox === 0 && oz === 0) continue
            const jx = ix + ox
            const jz = iz + oz
            if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue
            const j = jz * nx + jx
            if (!valid[j]) continue
            seen++
            if (!lit[j]) dark++
          }
        }
        if (seen < 6) continue
        const ratio = dark / seen
        // Under a roof the sample is a shaft almost by definition; out in the
        // open it has to be a genuinely narrow slot between buildings.
        candidate[i] = ratio >= (roofed[i] ? 0.35 : 0.62) ? 1 : 0
      }
    }

    // Flood fill into clusters.
    const seen = new Uint8Array(cells)
    const stack: number[] = []
    const clusters: { cx: number; cz: number; y: number; ceiling: number; roofed: boolean; size: number; spread: number }[] = []

    for (let start = 0; start < cells; start++) {
      if (!candidate[start] || seen[start]) continue
      stack.length = 0
      stack.push(start)
      seen[start] = 1
      let sumX = 0
      let sumZ = 0
      let sumY = 0
      let sumCeil = 0
      let ceilCount = 0
      let size = 0
      let minIx = nx
      let maxIx = -1
      let minIz = nz
      let maxIz = -1

      while (stack.length > 0) {
        const i = stack.pop() as number
        const ix = i % nx
        const iz = (i / nx) | 0
        size++
        sumX += minX + (ix + 0.5) * dx
        sumZ += minZ + (iz + 0.5) * dz
        sumY += floorY[i]
        if (roofed[i]) {
          sumCeil += ceilY[i]
          ceilCount++
        }
        if (ix < minIx) minIx = ix
        if (ix > maxIx) maxIx = ix
        if (iz < minIz) minIz = iz
        if (iz > maxIz) maxIz = iz

        const neighbours = [i - 1, i + 1, i - nx, i + nx]
        for (let k = 0; k < 4; k++) {
          const j = neighbours[k]
          if (j < 0 || j >= cells || seen[j] || !candidate[j]) continue
          // Do not wrap around the row edges.
          if (k < 2 && ((j % nx) - (i % nx)) !== (k === 0 ? -1 : 1)) continue
          seen[j] = 1
          stack.push(j)
        }
      }

      if (size < 1) continue
      clusters.push({
        cx: sumX / size,
        cz: sumZ / size,
        y: sumY / size,
        ceiling: ceilCount > 0 ? sumCeil / ceilCount : 0,
        roofed: ceilCount * 2 >= size,
        size,
        spread: Math.max((maxIx - minIx + 1) * dx, (maxIz - minIz + 1) * dz) * 0.5,
      })
    }

    // Interiors first: a shaft cutting through a dark room is worth far more
    // than one more bar of light in an already sunlit street.
    const score = (c: { roofed: boolean; size: number }) => (c.roofed ? 200 : 0) + c.size
    clusters.sort((a, b) => score(b) - score(a))

    const rand = new Rand(ctx.config.seed ^ 0x5ba7)
    const specs: ShaftSpec[] = []
    for (const cluster of clusters) {
      if (specs.length >= budget) break
      // Skip clusters sitting almost on top of one already taken.
      let tooClose = false
      for (const existing of specs) {
        const ddx = existing.origin.x - cluster.cx
        const ddz = existing.origin.z - cluster.cz
        if (ddx * ddx + ddz * ddz < 9) tooClose = true
      }
      if (tooClose) continue

      const floorPoint = this.tmpVec.set(cluster.cx, cluster.y + 0.02, cluster.cz)
      const headroom = cluster.roofed ? Math.max(1.5, cluster.ceiling - cluster.y) : 7
      const length = THREE.MathUtils.clamp(headroom / Math.max(sunDir.y, 0.15), 2.5, 26)
      const origin = floorPoint.clone().addScaledVector(sunDir, length)
      const radius = THREE.MathUtils.clamp(cluster.spread * 0.55, 0.32, 1.5)

      specs.push({
        origin,
        axis: this.tmpVec2.copy(sunDir).negate().clone(),
        length,
        radius,
        strength: (cluster.roofed ? 1 : 0.55) * THREE.MathUtils.lerp(0.8, 1.2, rand.next()),
      })

      if (cluster.roofed) {
        this.fillPoints.push(new THREE.Vector3(cluster.cx, cluster.y + 0.9, cluster.cz))
      }
    }
    return specs
  }

  private buildMotes(ctx: GameContext, specs: ShaftSpec[], color: THREE.Color): void {
    const total = specs.length * MOTES_PER_SHAFT
    if (total === 0) return
    const rand = new Rand(ctx.config.seed ^ 0x2fd3)
    const base = new Float32Array(total * 3)
    const drift = new Float32Array(total * 3)
    const phase = new Float32Array(total)
    const size = new Float32Array(total)
    const position = new Float32Array(total * 3)

    const tangent = new THREE.Vector3()
    const bitangent = new THREE.Vector3()
    const p = new THREE.Vector3()
    let w = 0

    for (const spec of specs) {
      tangent.set(0, 1, 0)
      if (Math.abs(spec.axis.y) > 0.9) tangent.set(1, 0, 0)
      tangent.crossVectors(tangent, spec.axis).normalize()
      bitangent.crossVectors(spec.axis, tangent).normalize()

      for (let i = 0; i < MOTES_PER_SHAFT; i++, w++) {
        const s = rand.range(0.05, 0.95) * spec.length
        const r = Math.sqrt(rand.next()) * spec.radius * 1.5
        const a = rand.next() * Math.PI * 2
        p.copy(spec.origin)
          .addScaledVector(spec.axis, s)
          .addScaledVector(tangent, Math.cos(a) * r)
          .addScaledVector(bitangent, Math.sin(a) * r)
        base[w * 3] = p.x
        base[w * 3 + 1] = p.y
        base[w * 3 + 2] = p.z
        position[w * 3] = p.x
        position[w * 3 + 1] = p.y
        position[w * 3 + 2] = p.z
        drift[w * 3] = rand.range(0.05, 0.22)
        drift[w * 3 + 1] = rand.range(0.05, 0.3)
        drift[w * 3 + 2] = rand.range(0.05, 0.22)
        phase[w] = rand.next() * Math.PI * 2
        size[w] = rand.range(0.005, 0.019)
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('aBase', new THREE.BufferAttribute(base, 3))
    geometry.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3))
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    geometry.computeBoundingSphere()

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProjScale: { value: 600 },
        uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
        uIntensity: { value: 2.6 },
      },
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    })

    const points = new THREE.Points(geometry, material)
    points.name = 'shaftMotes'
    points.renderOrder = 13
    points.frustumCulled = false
    this.group.add(points)
    this.moteGeometry = geometry
    this.motePoints = points
    this.moteMaterial = material
  }

  update(elapsed: number, cameraPosition: THREE.Vector3, projScale: number): void {
    for (let i = 0; i < this.materials.length; i++) {
      const material = this.materials[i]
      const spec = this.specs[i]
      material.uniforms.uTime.value = elapsed
      // Distance from the camera to the beam axis decides which hull face the
      // shader is allowed to integrate.
      this.tmpVec.copy(cameraPosition).sub(spec.origin)
      const along = THREE.MathUtils.clamp(this.tmpVec.dot(spec.axis), 0, spec.length)
      this.tmpVec.addScaledVector(spec.axis, -along)
      const cutoff = spec.radius * 2.6
      material.uniforms.uCamInside.value = this.tmpVec.lengthSq() < cutoff * cutoff ? 1 : 0
    }
    if (this.moteMaterial) {
      this.moteMaterial.uniforms.uTime.value = elapsed
      this.moteMaterial.uniforms.uProjScale.value = projScale
    }
  }

  setDensity(density: number): void {
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].uniforms.uDensity.value = density * this.specs[i].strength
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  clear(): void {
    for (const mesh of this.meshes) this.group.remove(mesh)
    for (const material of this.materials) material.dispose()
    this.meshes.length = 0
    this.materials.length = 0
    this.specs.length = 0
    this.fillPoints.length = 0
    if (this.motePoints) {
      this.group.remove(this.motePoints)
      this.moteGeometry?.dispose()
      this.moteMaterial?.dispose()
      this.motePoints = null
      this.moteGeometry = null
      this.moteMaterial = null
    }
  }

  dispose(): void {
    this.clear()
    this.hull.dispose()
    this.group.removeFromParent()
  }
}
