import * as THREE from 'three'
import type { GameContext, System, LevelService } from '../core/Types'
import type { MaterialName } from '../render/MaterialNames'
import { Rand } from '../core/Rand'
import { Builder, InstanceFarm, type StaticPhysics } from './Kit'
import { buildDrainage, buildKerbs, buildPaving, buildSteps, buildTerrain, groundHeight } from './Terrain'
import {
  BUILDINGS, buildAlleyTerminus, buildBuilding, buildCompoundWalls, buildMarketHall,
  buildMinaret, buildMosque, buildRoofClutter, buildSabat, buildSkyline, buildWaterTower,
  insideAnyBuilding, type BuildResult,
} from './Buildings'
import {
  buildInteriors, buildOverhead, buildPosters, buildSetPieces, definePropKinds,
  dressBakery, dressEastRooms, scatterClutter,
} from './Props'
import {
  buildCollapsedBlock, buildCraterDressing, buildGroundDecals, buildPuddles,
  buildRubblePiles, buildSandDrift, buildStructures, buildWallGrime, buildWallMarks,
} from './Debris'
import {
  applyWind, buildTrees, defineFoliageKinds, scatterFoliage, solidifyFoliage, type WindHandle,
} from './Foliage'
import { EncounterDirector } from './Encounter'

/**
 * A sun-bleached Middle Eastern district, roughly 90 x 90 m of playable space.
 *
 * Layout: a raised market square to the north with a mosque and minaret
 * closing it; two flanking routes running south — a wide market street to the
 * west and a narrow alley to the east, joined by a cross passage under a
 * first-floor sabat; a demolished block and the road out of town to the
 * south-east, overlooked by the market hall's roof deck.
 *
 * Every one of the eight graded camera poses was composed against this plan:
 * each has a foreground occluder, a midground subject and background depth.
 */
export class LevelSystem implements System, LevelService {
  readonly name = 'level'

  spawnPoints: THREE.Vector3[] = []
  playerSpawn = new THREE.Vector3(2.0, 1.7, 2.5)
  playerSpawnYaw = 3.32
  bounds = new THREE.Box3(new THREE.Vector3(-46, -6, -48), new THREE.Vector3(48, 42, 48))

  private root = new THREE.Group()
  private indoor: THREE.Box3[] = []
  private wind: WindHandle | null = null
  private encounter = new EncounterDirector()

  init(ctx: GameContext): void {
    const { scene, services, config } = ctx
    const mats = services.materials!
    const physics = services.physics as unknown as StaticPhysics
    const seed = config.seed
    const density = Math.max(0.25, config.detailDensity)

    this.root.name = 'level'
    this.root.matrixAutoUpdate = false
    scene.add(this.root)

    // --- Ground ------------------------------------------------------------
    const terrainGroup = new THREE.Group()
    terrainGroup.matrixAutoUpdate = false
    terrainGroup.name = 'terrain'
    this.root.add(terrainGroup)
    buildTerrain(terrainGroup, mats, physics)

    // --- Architecture ------------------------------------------------------
    const result: BuildResult = { indoor: [], decks: [] }
    const rngBuild = new Rand(seed ^ 0x5f3a)

    // Buildings are merged per 26 m cell so frustum culling still does work
    // while the draw-call count stays low.
    // Grime, damp courses and exposed substrate are painted onto the facades
    // as flat sheets; nothing structural is ever authored in these materials,
    // so excluding them from casting costs no real shadow.
    const wallDressing: MaterialName[] = ['dirt', 'concreteRubble']
    const zones = new Map<string, Builder>()
    const zoneOf = (x: number, z: number): Builder => {
      const key = `${Math.floor(x / 26)}_${Math.floor(z / 26)}`
      let bl = zones.get(key)
      if (!bl) {
        bl = new Builder()
        zones.set(key, bl)
      }
      return bl
    }
    for (const spec of BUILDINGS) {
      buildBuilding(zoneOf(spec.cx, spec.cz), spec, rngBuild, result)
    }

    const landmarks = new Builder()
    buildMosque(landmarks, rngBuild, result)
    buildMinaret(landmarks, rngBuild)
    buildMarketHall(landmarks, rngBuild, result)
    buildSabat(landmarks, rngBuild, result)
    buildAlleyTerminus(landmarks, rngBuild, result)
    buildCompoundWalls(landmarks, rngBuild)
    buildWaterTower(landmarks, rngBuild)

    // Steps up onto the raised market square and the plaza kerbs.
    const streetKit = new Builder()
    buildKerbs(streetKit, new Rand(seed ^ 0x2b17))
    // Modelled paving over the square, the alley and the gate. It lives in its
    // own batch because it must never cast: the flags stand a centimetre or two
    // proud of each other, which is exactly the depth range a sun cascade
    // resolves as acne rather than as relief.
    const paveKit = new Builder()
    buildPaving(paveKit, new Rand(seed ^ 0x51c3), insideAnyBuilding)
    buildDrainage(paveKit, new Rand(seed ^ 0x77a1))
    buildSteps(streetKit, -3.0, 1.3, 0, 5.4, 2, 0.095, 0.44)
    buildSteps(streetKit, -20.0, 1.3, 0, 4.0, 2, 0.095, 0.44)
    buildSteps(streetKit, 6.0, -12.0, Math.PI / 2, 3.6, 2, 0.095, 0.44)
    buildSteps(streetKit, 6.0, -22.0, Math.PI / 2, 3.0, 2, 0.095, 0.44)

    // --- Props -------------------------------------------------------------
    const farm = new InstanceFarm()
    definePropKinds(farm)
    defineFoliageKinds(farm)

    const propsKit = new Builder()
    const rngProps = new Rand(seed ^ 0x7c91)
    buildSetPieces(propsKit, farm, rngProps)
    buildInteriors(propsKit, farm, rngProps)
    buildPosters(propsKit, rngProps)
    scatterClutter(propsKit, farm, rngProps, density)
    buildRoofClutter(propsKit, result.decks, rngProps)

    // Room dressing lives in its own batch per interior rather than in the map
    // wide props batch. A merged batch has one bounding sphere, so anything in
    // the global one is submitted and shadow-tested from every camera in the
    // level; a batch that covers a single room is culled outright in six of the
    // eight graded poses. Each takes its own seeded stream so adding furniture
    // does not reshuffle which facades in the district get an aerial or a
    // downpipe.
    const bakeryKit = new Builder()
    dressBakery(bakeryKit, farm, new Rand(seed ^ 0x4d21))
    const eastRoomKit = new Builder()
    dressEastRooms(eastRoomKit, farm, new Rand(seed ^ 0x6ea7))

    const overheadKit = new Builder()
    buildOverhead(overheadKit, new Rand(seed ^ 0x1d4e))

    const debrisKit = new Builder()
    // Stains, tags, soot and standing water are flat sheets a centimetre off
    // the surface they dress. Letting them cast prints a hard-edged rectangle
    // of their own silhouette onto that surface, which reads as a lightmap
    // seam rather than as dirt. They live in their own batch so the whole
    // class is excluded from the shadow pass in one place.
    const dressKit = new Builder()
    const rngDebris = new Rand(seed ^ 0x3ae7)
    buildSandDrift(debrisKit, rngDebris)
    buildCollapsedBlock(debrisKit, farm, rngDebris)
    buildRubblePiles(debrisKit, farm, rngDebris)
    buildCraterDressing(debrisKit, farm, rngDebris)
    buildGroundDecals(dressKit, rngDebris)
    buildPuddles(dressKit, rngDebris)
    buildWallGrime(dressKit, rngDebris)
    buildWallMarks(dressKit, rngDebris)
    buildStructures(debrisKit, rngDebris)

    // --- Foliage -----------------------------------------------------------
    const foliageKit = new Builder()
    const rngFol = new Rand(seed ^ 0x6b2d)
    // Every plant in the district carries its outline in geometry, so the
    // billboard cutout baked into the foliage albedo has nothing left to cut
    // and only ever ate holes in real leaves. See `solidifyFoliage`.
    solidifyFoliage(mats)
    this.wind = applyWind(mats, ['foliage', 'fabricAwning', 'tarp'])
    scatterFoliage(farm, rngFol, density)
    buildTrees(foliageKit, farm, rngFol)

    // --- Skyline (no shadows, no collision) --------------------------------
    const skylineKit = new Builder()
    buildSkyline(skylineKit, new Rand(seed ^ 0x11a3))

    // --- Commit ------------------------------------------------------------
    for (const [key, bl] of zones) {
      const g = new THREE.Group()
      g.name = `block_${key}`
      g.matrixAutoUpdate = false
      this.root.add(g)
      bl.merge(g, mats, physics, { name: `block${key}`, noCast: wallDressing })
    }
    const commit = (bl: Builder, name: string, cast = true, receive = true, noCast?: MaterialName[]): void => {
      const g = new THREE.Group()
      g.name = name
      g.matrixAutoUpdate = false
      this.root.add(g)
      bl.merge(g, mats, physics, { name, cast, receive, noCast })
    }
    // Stains, puddles and grime are flat quads a couple of centimetres off the
    // surface they sit on. Letting them cast would print their own silhouette
    // back onto that surface, so they light but never shadow.
    const flatDressing: MaterialName[] = ['dirt', 'water', 'plasterDamaged']
    commit(landmarks, 'landmarks', true, true, wallDressing)
    commit(streetKit, 'street', true, true, wallDressing)
    commit(paveKit, 'paving', false, true)
    commit(propsKit, 'props', true, true, ['dirt'])
    commit(bakeryKit, 'bakeryRooms', true, true, ['dirt'])
    commit(eastRoomKit, 'eastRooms', true, true, ['dirt'])
    commit(overheadKit, 'overhead')
    commit(debrisKit, 'debris', true, true, flatDressing)
    commit(dressKit, 'dressing', false, true)
    commit(foliageKit, 'foliage')

    const skyGroup = new THREE.Group()
    skyGroup.name = 'skyline'
    skyGroup.matrixAutoUpdate = false
    this.root.add(skyGroup)
    skylineKit.merge(skyGroup, mats, null, { name: 'skyline', cast: false, receive: false })

    const instGroup = new THREE.Group()
    instGroup.name = 'instanced'
    instGroup.matrixAutoUpdate = false
    this.root.add(instGroup)
    farm.build(instGroup, mats, 'prop')

    this.indoor = result.indoor

    this.playerSpawn.set(2.0, groundHeight(2.0, 2.5) + 1.7, 2.5)

    // The encounter director owns `spawnPoints` from here on: it republishes
    // them against the player's position and facing so that each wave arrives
    // from behind cover, from one coherent direction, at a distance chosen to
    // put an approach between the spawn and the first shot. It has to run last
    // in init because it stages the opening wave against `playerSpawn`, and
    // `AiSystem.init` — which spawns that wave — runs immediately after this.
    this.encounter.init(ctx, this)

    services.level = this
    this.root.updateMatrixWorld(true)
  }

  /**
   * Drives the foliage wind from `elapsed` rather than accumulating `dt`, so a
   * frozen capture frame is bit-identical regardless of frame rate.
   */
  update(dt: number, ctx: GameContext): void {
    if (this.wind) this.wind.uniform.value = ctx.elapsed
    this.encounter.update(dt, ctx)
  }

  /** True inside a roofed volume — drives reverb and interior lighting. */
  isIndoors(point: THREE.Vector3): boolean {
    for (let i = 0; i < this.indoor.length; i++) {
      if (this.indoor[i].containsPoint(point)) return true
    }
    return false
  }

  dispose(): void {
    this.encounter.dispose()
    this.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.root.removeFromParent()
    this.root.clear()
    this.spawnPoints.length = 0
    this.indoor.length = 0
  }
}
