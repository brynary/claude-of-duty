import * as THREE from 'three'
import type { GameContext, System, Damageable } from './Types'
import { emptyScriptedFrame, type ScriptedFrame } from './Input'
import { Rand } from './Rand'

/**
 * A synthetic player.
 *
 * Feel cannot be measured from a fixed input tape: enemy positions vary between
 * builds, so a recorded sequence of keypresses stops hitting anything the
 * moment the AI changes and every downstream metric becomes noise. Instead this
 * plays the game — it looks for targets, aims at them with a human-shaped error
 * model, fires, reloads, takes cover and moves toward objectives — while
 * driving the ordinary `Input` surface. Everything downstream of input is the
 * real game: the same character controller, the same weapon timings, the same
 * ballistics and AI.
 *
 * The skill profiles exist so a change can be judged against more than one
 * standard of play. A tuning change that helps an expert and ruins a novice is
 * a bad change, and only shows up if both are simulated.
 */

export interface SkillProfile {
  name: string
  /** Seconds between a target becoming visible and the bot beginning to aim. */
  reactionTime: number
  /** Degrees of standing aim error at 20m, before tracking. */
  aimError: number
  /** How fast the aim converges on target, in units of 1/s for an exponential. */
  aimSpeed: number
  /** Probability per engagement of aiming down sights rather than hip firing. */
  adsBias: number
  /** Fraction of magazine remaining below which the bot reloads in a lull. */
  reloadThreshold: number
  /** How readily the bot breaks contact when hurt, 0..1. */
  cautiousness: number
  /** Degrees of continuous aim wobble, simulating an unsteady hand. */
  wobble: number
}

export const SKILLS: Record<string, SkillProfile> = {
  novice: { name: 'novice', reactionTime: 0.62, aimError: 7.5, aimSpeed: 5.0, adsBias: 0.45, reloadThreshold: 0.5, cautiousness: 0.8, wobble: 1.4 },
  average: { name: 'average', reactionTime: 0.34, aimError: 3.4, aimSpeed: 9.0, adsBias: 0.75, reloadThreshold: 0.4, cautiousness: 0.5, wobble: 0.7 },
  expert: { name: 'expert', reactionTime: 0.19, aimError: 1.3, aimSpeed: 15.0, adsBias: 0.85, reloadThreshold: 0.3, cautiousness: 0.25, wobble: 0.3 },
}

export type BotGoal =
  /** Move between waypoints engaging whatever appears. */
  | 'patrol'
  /** Hold position and fight from where it stands. */
  | 'hold'
  /** Push aggressively toward the far end of the map. */
  | 'push'
  /** Move without engaging, for movement-only measurement. */
  | 'traverse'

export interface Scenario {
  name: string
  goal: BotGoal
  /** World-space waypoints the bot moves between. */
  route: [number, number, number][]
  description: string
}

/**
 * Scenarios are authored against the level's actual layout. `traverse` exists
 * to measure movement in isolation, with no combat noise in the telemetry.
 */
export const SCENARIOS: Record<string, Scenario> = {
  push: {
    name: 'push',
    goal: 'push',
    route: [[4, 1.7, 12], [2, 1.7, 4], [-2, 1.7, -6], [-10, 1.7, -12]],
    description: 'Advance from spawn through the plaza engaging whatever appears. The default combat measurement.',
  },
  hold: {
    name: 'hold',
    goal: 'hold',
    route: [[6.5, 1.7, 14]],
    description: 'Hold the alley mouth and fight from cover. Measures defensive pacing and enemy pressure.',
  },
  patrol: {
    name: 'patrol',
    goal: 'patrol',
    route: [[4, 1.7, 12], [-8, 1.7, 8], [-14, 1.7, 2], [-2, 1.7, -6], [4, 1.7, 12]],
    description: 'Circuit of the map. Measures encounter spacing and how much of the level is live.',
  },
  traverse: {
    name: 'traverse',
    goal: 'traverse',
    route: [[4, 1.7, 12], [-8, 1.7, 8], [-14, 1.7, 2], [-2, 1.7, -6], [10, 1.7, -2], [4, 1.7, 12]],
    description: 'Movement only, never fires. Measures traversal speed, mantles and stalls with no combat noise.',
  },
}

const UP = new THREE.Vector3(0, 1, 0)

export class PlayBotSystem implements System {
  readonly name = 'playbot'

  private frame: ScriptedFrame = emptyScriptedFrame()
  private rng!: Rand
  private skill!: SkillProfile
  private scenario!: Scenario
  private enabled = false

  private waypoint = 0
  /** +1 forward along the route, -1 back. The route ping-pongs. */
  private routeDir = 1
  private target: Damageable | null = null
  private targetSince = -1
  private aimYaw = 0
  private aimPitch = 0
  private firingFor = 0
  private burstRest = 0
  private stuckFor = 0
  /**
   * How many waypoints the bot gave up on. Surfaced in the log because a run
   * with several is measuring a route that no longer fits the level, not a
   * player having a bad time, and the two look identical in the metrics.
   */
  private unreachable = 0
  private slideCooldown = 3
  /** Rate limit on reissuing the reload command. See `trigger`. */
  private reloadCooldown = 0
  private lastPos = new THREE.Vector3()
  private wantAds = false
  private t = 0

  /** Exposed so the harness can log exactly what the bot did. */
  readonly log: { t: number; action: string }[] = []

  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()

  init(ctx: GameContext): void {
    const name = ctx.config.bot
    if (!name) return
    this.scenario = SCENARIOS[name] ?? SCENARIOS.push
    this.skill = SKILLS[ctx.config.botSkill] ?? SKILLS.average
    this.rng = new Rand((ctx.config.seed ^ 0xb07) >>> 0)
    this.enabled = true
    ctx.input.scripted = this.frame

    const player = ctx.services.player
    if (player) {
      this.aimYaw = player.yaw
      this.aimPitch = player.pitch
      this.lastPos.copy(player.position)
    }

    // Track ammunition from the event stream rather than reaching into the
    // weapon system, so the bot only ever sees what the HUD shows a player.
    ctx.events.on('weapon:ammo', (p) => {
      this.mag = p.mag
      if (p.mag > this.magSize) this.magSize = p.mag
    })

    this.note(`scenario=${this.scenario.name} skill=${this.skill.name} seed=${ctx.config.seed}`)
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.enabled || dt <= 0) return
    this.t += dt

    const player = ctx.services.player
    const weapons = ctx.services.weapons
    if (!player) return

    this.prevDown.clear()
    for (const k of this.frame.down) this.prevDown.add(k)
    this.frame.down.clear()

    this.chooseTarget(ctx, player.eye)
    this.aim(dt, ctx, player.eye)
    this.move(dt, ctx, player)
    this.trigger(dt, ctx, weapons)

    // Derive the edge-triggered set from the held set, the way real hardware
    // does. Writing only `down` meant `wasPressed` never fired for anything the
    // bot held: it added ControlLeft every frame while hurt and therefore never
    // produced a single `crouchPressed`, so it never slid once and none of the
    // slide tuning could appear in telemetry.
    for (const k of this.frame.down) {
      if (!this.prevDown.has(k)) this.frame.pressed.add(k)
    }
  }

  private prevDown = new Set<string>()

  // --- target selection ----------------------------------------------------

  private chooseTarget(ctx: GameContext, eye: THREE.Vector3): void {
    if (this.scenario.goal === 'traverse') { this.target = null; return }

    const ai = ctx.services.ai
    const physics = ctx.services.physics
    if (!ai || !physics) return

    if (this.target && (!this.target.alive || !this.visible(physics, eye, this.target))) {
      this.target = null
      this.targetSince = -1
    }

    if (this.target) return

    let best: Damageable | null = null
    let bestScore = Infinity
    for (const e of ai.enemies) {
      if (!e.alive) continue
      const d = e.position.distanceTo(eye)
      if (d > 70) continue
      if (!this.visible(physics, eye, e)) continue
      // Prefer near targets, but not so strongly that the bot ignores a distant
      // enemy already shooting at it.
      const score = d
      if (score < bestScore) { bestScore = score; best = e }
    }
    if (best) {
      this.target = best
      this.targetSince = this.t
      this.wantAds = this.rng.next() < this.skill.adsBias && bestScore > 6
      this.note(`acquired enemy ${best.id} at ${bestScore.toFixed(1)}m ads=${this.wantAds}`)
    }
  }

  private visible(physics: NonNullable<GameContext['services']['physics']>, eye: THREE.Vector3, e: Damageable): boolean {
    this.tmpA.copy(e.position)
    this.tmpA.y += 1.2
    this.tmpB.copy(this.tmpA).sub(eye)
    const dist = this.tmpB.length()
    if (dist < 0.001) return false
    this.tmpB.divideScalar(dist)
    const hit = physics.raycast(eye, this.tmpB, dist - 0.35, { characters: false })
    return hit === null
  }

  // --- aiming --------------------------------------------------------------

  private aim(dt: number, ctx: GameContext, eye: THREE.Vector3): void {
    const player = ctx.services.player!

    let desiredYaw = this.aimYaw
    let desiredPitch = this.aimPitch

    if (this.target) {
      this.tmpA.copy(this.target.position)
      // Aim centre mass, not feet.
      this.tmpA.y += 1.15
      this.tmpB.copy(this.tmpA).sub(eye)
      const dist = this.tmpB.length()
      desiredYaw = Math.atan2(-this.tmpB.x, -this.tmpB.z)
      desiredPitch = Math.asin(THREE.MathUtils.clamp(this.tmpB.y / dist, -1, 1))

      // Error scales down with distance the way a real player's does: the
      // angular error that matters is roughly constant in metres at the target.
      const errRad = THREE.MathUtils.degToRad(this.skill.aimError) * (20 / Math.max(dist, 4))
      desiredYaw += this.rng.gaussian() * errRad * 0.35
      desiredPitch += this.rng.gaussian() * errRad * 0.25
    } else if (this.scenario.goal !== 'hold') {
      const wp = this.currentWaypoint()
      if (wp) {
        this.tmpB.copy(wp).sub(eye)
        desiredYaw = Math.atan2(-this.tmpB.x, -this.tmpB.z)
        desiredPitch = 0
      }
    }

    // Continuous wobble, so the bot is never perfectly still.
    const w = THREE.MathUtils.degToRad(this.skill.wobble)
    desiredYaw += Math.sin(this.t * 2.3) * w * 0.5
    desiredPitch += Math.sin(this.t * 3.1) * w * 0.3

    // Reaction delay: hold the previous aim until the delay has elapsed.
    const reacting = this.target !== null && this.t - this.targetSince < this.skill.reactionTime
    if (!reacting) {
      const k = 1 - Math.exp(-this.skill.aimSpeed * dt)
      this.aimYaw += wrapAngle(desiredYaw - this.aimYaw) * k
      this.aimPitch += (desiredPitch - this.aimPitch) * k
    }

    // Convert the aim delta into mouse movement so the real camera rig, its
    // sensitivity and its recoil handling all stay in the loop.
    //
    // The rig scales sensitivity down while aiming — `sensitivity * (1 - 0.38 *
    // ads)` — so dividing by the raw value delivered only 62% of the requested
    // turn in exactly the situation the bot is trying to aim carefully in, and
    // it converged 38% slower there than anywhere else.
    const dYaw = wrapAngle(this.aimYaw - player.yaw)
    const dPitch = this.aimPitch - player.pitch
    const ads = ctx.services.weapons?.adsFraction ?? 0
    const sens = ctx.config.sensitivity * (1 - 0.38 * ads)
    this.frame.mouseDX = -dYaw / sens
    this.frame.mouseDY = -dPitch / sens

    // How far off target the aim currently is, for the trigger to consult.
    this.aimErrorRad = Math.hypot(dYaw, dPitch)
  }

  /** Angular distance between where the bot is looking and where it wants to. */
  private aimErrorRad = Math.PI

  // --- movement ------------------------------------------------------------

  private currentWaypoint(): THREE.Vector3 | null {
    const r = this.scenario.route
    if (r.length === 0) return null
    const p = r[Math.min(this.waypoint, r.length - 1)]
    return this.tmpVec.set(p[0], p[1], p[2])
  }
  private tmpVec = new THREE.Vector3()

  private move(dt: number, ctx: GameContext, player: NonNullable<GameContext['services']['player']>): void {
    if (this.scenario.goal === 'hold' && this.target) return

    const wp = this.currentWaypoint()
    if (!wp) return

    const dx = wp.x - player.position.x
    const dz = wp.z - player.position.z
    const dist = Math.hypot(dx, dz)

    if (dist < 1.6) {
      // Reaching the end of the route used to pin the bot to its last waypoint,
      // where it then satisfied this test every frame and stood still for the
      // rest of the run. That is why time-spent-sprinting measured near zero:
      // the bot was not moving, so it was never rotating between fights.
      // The route now reverses at each end and the bot keeps working the map.
      this.waypoint += this.routeDir
      const last = this.scenario.route.length - 1
      if (this.waypoint > last) {
        this.waypoint = Math.max(0, last - 1)
        this.routeDir = -1
      } else if (this.waypoint < 0) {
        this.waypoint = Math.min(last, 1)
        this.routeDir = 1
      }
      this.note(`waypoint ${this.waypoint}`)
      return
    }

    // Move in the direction of the waypoint, expressed relative to facing.
    const forward = -Math.cos(player.yaw) * dz - Math.sin(player.yaw) * dx
    const strafe = Math.cos(player.yaw) * dx - Math.sin(player.yaw) * dz
    // Camera convention: yaw 0 looks down -Z.
    const fwd = (dx * -Math.sin(player.yaw)) + (dz * -Math.cos(player.yaw))
    const side = (dx * Math.cos(player.yaw)) + (dz * -Math.sin(player.yaw))
    void forward; void strafe

    if (fwd > 0.35) this.frame.down.add('KeyW')
    else if (fwd < -0.35) this.frame.down.add('KeyS')
    if (side > 0.35) this.frame.down.add('KeyD')
    else if (side < -0.35) this.frame.down.add('KeyA')

    // Sprint whenever the trigger is not down and there is ground to cover.
    //
    // This used to require `target === null`, which sounds reasonable and is
    // far too strict: `chooseTarget` acquires any live enemy within 70m with
    // line of sight and holds it until it dies or the line breaks, so on this
    // map "no enemy anywhere" is almost never true. Measured, the bot held
    // Shift for 0.00% of frames with enemies present and 17.5% with combat
    // disabled entirely — every single refusal downstream was `!sprintHeld`.
    // A real player sprints between bursts and while repositioning under fire;
    // the honest condition is "not currently shooting", not "nothing to shoot".
    //
    // The distance gate was the other half. `dist` is to the *next* waypoint
    // and the route advances at 1.6m, so on 8-11m legs a 6m threshold only
    // held for the first few metres of each leg — which is why even the
    // combat-free ceiling was 17.5% rather than most of the traverse.
    const shooting = this.frame.mouse0 || this.frame.mouse1
    const sprinting = !shooting && dist > 3 && fwd > 0.5
    if (sprinting) this.frame.down.add('ShiftLeft')

    // Slide into contact occasionally, the way a player closing on a fight
    // does. Only from a sprint, and rate-limited so it stays a decision rather
    // than a tic — this exists so slide tuning shows up in telemetry at all.
    this.slideCooldown -= dt
    if (sprinting && player.isSprinting && this.slideCooldown <= 0 && this.rng.next() < 0.6 * dt) {
      this.frame.down.add('ControlLeft')
      this.slideCooldown = 4 + this.rng.next() * 4
      this.note('slide')
    }

    // Take cover when hurt, if the profile is cautious enough. Still keyed on
    // holding a target rather than on the trigger — crouching is about being
    // under threat, not about currently shooting.
    if (this.target !== null && player.health < 55 * this.skill.cautiousness * 2) {
      this.frame.down.add('ControlLeft')
    }

    // Unstick, in two stages.
    //
    // The routes are hardcoded coordinates and the level has been rebuilt many
    // times since they were written, so a waypoint can end up inside geometry
    // and become permanently unreachable. The first version of this only jumped
    // and turned 0.6 rad, which does not help against a wall: a `push` run
    // wedged at t=3.4s and then logged `unstick` every 0.8s for the remaining
    // 87 seconds, spinning on the spot and firing 240 rounds for zero hits
    // while the telemetry recorded it as a legitimately terrible player.
    //
    // A vault or a small ledge deserves a jump. A waypoint the bot cannot reach
    // deserves abandoning, so persistent failure now skips it. The harness has
    // to survive the level changing underneath it, because it always will.
    const moved = player.position.distanceTo(this.lastPos)
    this.lastPos.copy(player.position)
    if (this.frame.down.size > 0 && moved < 0.01) {
      this.stuckFor += dt
      if (this.stuckFor > 0.6 && this.stuckFor - dt <= 0.6) {
        this.frame.pressed.add('Space')
        this.note('unstick: jump')
      }
      if (this.stuckFor > 2.0) {
        this.waypoint += this.routeDir
        const last = this.scenario.route.length - 1
        if (this.waypoint > last) { this.waypoint = Math.max(0, last - 1); this.routeDir = -1 }
        else if (this.waypoint < 0) { this.waypoint = Math.min(last, 1); this.routeDir = 1 }
        this.stuckFor = 0
        this.unreachable++
        this.note(`unstick: abandoning waypoint, now ${this.waypoint}`)
      }
    } else {
      this.stuckFor = 0
    }
  }

  // --- trigger discipline --------------------------------------------------

  private trigger(dt: number, ctx: GameContext, weapons: GameContext['services']['weapons']): void {
    if (this.scenario.goal === 'traverse') return

    // Wait for the aim to arrive before pulling the trigger. Firing on
    // "has a target and has finished reacting" meant the bot emptied magazines
    // while still slewing onto the target, which is not what a player does and
    // it charged every one of those rounds to accuracy. The tolerance is
    // generous — a player fires as the sights sweep on, not after they settle —
    // and it widens close in, where a large angular error is still a hit.
    const reacting = this.target !== null && this.t - this.targetSince < this.skill.reactionTime
    const tolerance = THREE.MathUtils.degToRad(this.target
      ? THREE.MathUtils.clamp(140 / Math.max(this.target.position.distanceTo(ctx.services.player!.eye), 3), 4, 30)
      : 4)
    const onTarget = this.target !== null && !reacting && this.aimErrorRad < tolerance

    this.frame.mouse1 = onTarget && this.wantAds

    if (!onTarget) {
      this.firingFor = 0
      this.frame.mouse0 = false
      // Reload in the lull rather than mid-fight, as a person does.
      //
      // Rate-limited, because the condition is a level and not an edge: when
      // the weapon would not accept the reload — an empty reserve, a switch in
      // flight — this reissued the command every single frame. A playtest run
      // recorded 72 reload commands in two seconds, followed by seven seconds
      // in which the player fired nothing at all while four enemies shot at
      // them. A person presses R once and waits.
      this.reloadCooldown -= dt
      if (weapons && !weapons.isReloading && this.reloadCooldown <= 0
        && this.magFraction(ctx) < this.skill.reloadThreshold) {
        this.frame.pressed.add('KeyR')
        this.reloadCooldown = 1.2
        this.note('reload in lull')
      }
      return
    }

    // Fire in bursts. Continuous fire is both unrealistic and hides recoil
    // recovery behaviour, which is one of the things being measured.
    this.burstRest -= dt
    if (this.burstRest > 0) {
      this.frame.mouse0 = false
      return
    }
    this.firingFor += dt
    this.frame.mouse0 = true
    const burstLen = 0.22 + this.rng.next() * 0.35
    if (this.firingFor > burstLen) {
      this.firingFor = 0
      this.burstRest = 0.10 + this.rng.next() * 0.22 + this.skill.reactionTime * 0.3
    }
  }

  private mag = 30
  private magSize = 30

  private magFraction(_ctx: GameContext): number {
    return this.magSize > 0 ? this.mag / this.magSize : 1
  }

  private note(action: string): void {
    this.log.push({ t: +this.t.toFixed(3), action })
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
