import * as THREE from 'three'

/**
 * Named camera setups used by the screenshot harness. Each pose freezes the
 * game at a fixed time and places the camera identically every run, so the
 * visual critic compares like for like across iterations.
 */
export interface Pose {
  name: string
  position: [number, number, number]
  /** Yaw/pitch in degrees. */
  yaw: number
  pitch: number
  fov?: number
  /** Seconds of simulation to run before freezing. */
  freeze?: number
  description: string
}

export const POSES: Record<string, Pose> = {
  alley: {
    name: 'alley',
    position: [6.5, 1.68, 14],
    yaw: 178, pitch: -3,
    freeze: 2.5,
    description: 'Narrow alley looking down a corridor of buildings — tests contact shadows, ambient occlusion, material variety at grazing angles.',
  },
  plaza: {
    name: 'plaza',
    position: [-2, 1.68, -6],
    yaw: 35, pitch: -2,
    freeze: 2.5,
    description: 'Open plaza with direct sun — tests sun shadowing, sky, distant fog and silhouette readability.',
  },
  interior: {
    name: 'interior',
    position: [-14, 1.68, 8],
    yaw: 90, pitch: 0,
    freeze: 3.0,
    description: 'Building interior lit through windows — tests indirect light falloff, volumetric shafts, indoor material response.',
  },
  weapon: {
    name: 'weapon',
    position: [4, 1.68, 6],
    yaw: 200, pitch: -4,
    freeze: 4.0,
    description: 'Weapon held at the low ready, framed against mid-distance cover — tests viewmodel material, geometry density and shading.',
  },
  ads: {
    name: 'ads',
    position: [4, 1.68, 6],
    yaw: 200, pitch: -2,
    freeze: 5.0,
    description: 'Aiming down sights — tests optic rendering, depth of field, and viewmodel alignment.',
  },
  firefight: {
    name: 'firefight',
    position: [1, 1.68, 10],
    yaw: 160, pitch: -1,
    freeze: 6.5,
    description: 'Mid-firefight with enemies, muzzle flash and impact VFX active — tests particles, tracers, lighting response and HUD.',
  },
  vista: {
    name: 'vista',
    position: [18, 4.5, 18],
    yaw: 215, pitch: -8,
    freeze: 2.5,
    description: 'Elevated wide shot of the whole level — tests composition, LOD, atmospheric perspective and skyline.',
  },
  sunset: {
    name: 'sunset',
    position: [-8, 1.68, 16],
    yaw: 250, pitch: 2,
    freeze: 2.5,
    description: 'Looking toward a low sun — tests bloom, lens flare, volumetrics, tone mapping in extreme dynamic range.',
  },
}

/** Applies a pose to a camera. Returns false when the name is unknown. */
export function applyPose(camera: THREE.PerspectiveCamera, name: string): Pose | null {
  const pose = POSES[name]
  if (!pose) return null
  camera.position.set(...pose.position)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = THREE.MathUtils.degToRad(pose.yaw)
  camera.rotation.x = THREE.MathUtils.degToRad(pose.pitch)
  camera.rotation.z = 0
  if (pose.fov) {
    camera.fov = pose.fov
    camera.updateProjectionMatrix()
  }
  return pose
}
