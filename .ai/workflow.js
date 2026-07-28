export const meta = {
  name: 'cod-build-subsystems',
  description: 'Build all ten AAA subsystems of the three.js FPS in parallel, each agent owning disjoint files',
  phases: [{ title: 'Build', detail: 'ten subsystem agents in parallel' }],
}

const BRIEF = `Read /Users/bhelmkamp/p/brynary/claude-of-duty/.ai/AGENT_BRIEF.md FIRST — it is the binding contract (file ownership, no new dependencies, no editing core/, determinism, quality bar). Then read src/core/Types.ts, src/core/Events.ts, src/core/Config.ts, src/core/Rand.ts, src/core/Poses.ts and src/render/MaterialNames.ts before writing anything.

Working directory: /Users/bhelmkamp/p/brynary/claude-of-duty

You are one of ten agents working simultaneously on separate files. Write ONLY the files listed as yours. Verify with \`npx tsc --noEmit\` and fix every error in YOUR files. Do not run vite build or the screenshot harness.

Aim for the visual and tactile quality of a modern Call of Duty. A hostile critic will grade rendered frames against real CoD screenshots. Generic three.js demo quality is a failure.

`

const AGENTS = [
  {
    label: 'materials',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Procedural PBR material library

YOU OWN: \`src/render/Materials.ts\` and any new files under \`src/render/procedural/\`.

Implement \`MaterialSystem\` so \`get(name)\` returns a fully authored PBR material for EVERY name in \`src/render/MaterialNames.ts\`. There are no image files and no network access — every texture must be generated in code into canvases or DataTextures.

Build a real procedural texturing toolkit first (in \`src/render/procedural/\`):
- Value noise, fBm, ridged noise, Worley/cellular, domain warping, Perlin. Seeded via core/Rand so output is identical every run.
- Height-to-normal-map conversion (Sobel), and ambient-occlusion-from-height.
- Tileable generation: all noise must wrap seamlessly at the texture edge, or repeats will show visible seams — this is the single most common giveaway of amateur work.
- Generators for: brick/block courses with mortar, plaster with cracks and patches, corrugated profiles, wood grain with knots, woven fabric, sand ripples, gravel scatter, asphalt aggregate, roof tiles, chainlink, brushed metal, rust blooms.
- Layering/masking utilities: edge wear (curvature-driven), grime accumulation (cavity-driven), water staining (gravity-driven streaks), dust on upward faces, paint chipping revealing substrate.

For each material output albedo + roughness + metalness + normal + AO, packed sensibly (roughness/metalness/AO can share an ORM texture). Set correct colorSpace (SRGBColorSpace for albedo only, NoColorSpace for data maps), anisotropy from ctx.config.anisotropy, and sensible \`repeat\` for real-world texel density — roughly 1 texture tile per 2 metres for walls, per 4 metres for ground.

Critical realism notes: real-world albedo is never pure black or pure white — keep it in 0.03..0.85. Roughness variation is what sells PBR: a uniform roughness value reads as plastic. Every material needs roughness breakup. Concrete is not grey — it is warm grey with colour blotching.

Provide a \`MaterialSystem.getInstanced(name)\` variant returning a material safe for InstancedMesh if that helps other systems, and cache aggressively — texture generation must happen once, at init, and total init time should stay under ~2.5 seconds.`,
  },
  {
    label: 'lighting',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Lighting, sky and atmosphere

YOU OWN: \`src/render/Lighting.ts\`, \`src/render/Sky.ts\`, and new files under \`src/render/lighting/\`.

Implement \`LightingSystem\` (conforming to \`LightingService\`) to deliver the single most important thing for AAA look: believable light.

Required:
- **Physical sky**: an atmospheric scattering shader (Preetham or Hosek-Wilkie) on a large sphere/box, with sun disc, correct horizon gradient, and turbidity. Drive it from \`setTimeOfDay(t)\`.
- **IBL**: generate a PMREM environment map FROM the sky at init (\`PMREMGenerator.fromScene\`) and assign \`scene.environment\`. This is what makes metal and glass read correctly. Regenerate if time of day changes.
- **Cascaded shadow maps**: three ships CSM at \`three/examples/jsm/csm/CSM.js\` — use it, with cascade count and shadow distance from \`ctx.config\`. Tune bias/normalBias carefully; peter-panning and shadow acne are both instant failures. Blend cascades so the transition is invisible.
- **Sun/ambient balance**: physically plausible intensities. Sun ~3-6 in three's units against a hemisphere/IBL ambient roughly 1/8 of that. Warm sun, cool sky-bounce ambient — that colour opposition is most of what makes daylight read as real.
- **Aerial perspective**: exponential-squared fog whose colour matches the sky in the sun direction and shifts cooler away from it, not a flat grey. Distance haze is essential for depth.
- **Volumetric light shafts**: god rays through window openings and between buildings. Either a screen-space radial-blur pass exposed for PostFX to consume, or raymarched billboard cones. Coordinate by exposing what PostFX needs on the service.
- **Local lights**: a small pool of pooled point/spot lights other systems can borrow for muzzle flashes and explosions (\`borrowLight()\` / \`returnLight()\`), since three has a hard uniform limit on lights. Keep max simultaneous dynamic lights around 8.
- **Interior handling**: buildings need light that does not look like an unlit black hole. Use light probes, faked bounce fill lights near window openings, or an interior ambient term.

Choose a specific, deliberate art direction: late-afternoon low sun, warm key, strong long shadows, slight haze — the classic CoD daylight look. Sun elevation around 18-25 degrees gives the most flattering shadows.

Expose \`sunDirection\` accurately (other systems use it). Do NOT set tone mapping — PostFX owns that.`,
  },
  {
    label: 'postfx',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Post-processing and colour

YOU OWN: \`src/render/PostFX.ts\` and new files under \`src/render/post/\`.

Implement \`PostFxSystem\` (conforming to \`PostFxService\`). You own the entire final image and the only calls to render. The \`postprocessing\` package (6.39) is available — read its exports rather than guessing at the API.

Required chain, respecting the toggles in \`ctx.config\`:
- **World pass**, then a **depth-cleared viewmodel pass** so the first-person weapon never intersects level geometry. This must be correct — the weapon clipping through walls is an instant failure.
- **Anti-aliasing**: SMAA at minimum. If you can make a temporal AA work with a velocity buffer, better — but a shimmering, aliased image fails, so correctness beats ambition here.
- **Ambient occlusion**: a good SSAO/GTAO. Tune radius in world units (~0.5m) and keep the intensity subtle — dark halos around everything is a classic amateur tell.
- **Bloom**: mipmap-based, physically motivated, threshold high (only genuinely bright things bloom). Muzzle flashes and sun glints should bloom; white walls should not.
- **Screen-space reflections** on wet/metal surfaces where budget allows.
- **Depth of field**: subtle. Slight background defocus, and stronger when \`setAdsBlur\` is driven by aiming down sights.
- **Motion blur**: per-object or at least camera velocity based.
- **Tone mapping**: AgX or ACES. This single choice dominates the look — test both and pick the one that holds highlight colour without desaturating the whole frame.
- **Colour grading**: a procedurally generated 3D LUT for a deliberate filmic grade — lifted crushed blacks, slight teal in shadows, warm highlights, gentle S-curve contrast. This is what separates "three.js scene" from "shipped game".
- **Lens character**: subtle chromatic aberration at the edges only, fine film grain that scales with darkness, vignette, and a very slight sharpen pass at the end.
- \`setDamageFlash(intensity)\` — red vignette pulse. \`setAdsBlur(fraction)\`.

Everything must be tasteful. The failure mode here is over-processing: crushed contrast, rainbow fringing, and heavy vignette all read as amateur. Reference the restraint of a real CoD frame — the grade is strong but the image stays clean and readable.

Coordinate with the lighting system by reading whatever it exposes for volumetric shafts; if it is not ready, degrade gracefully rather than crashing.`,
  },
  {
    label: 'level',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: The level — architecture, props, environment art

YOU OWN: \`src/world/*.ts\` (Level.ts plus any new files: Buildings.ts, Props.ts, Foliage.ts, Terrain.ts, Debris.ts, Kit.ts).

This is the biggest visual surface in the game. Build a real, deliberately composed Call of Duty style map — a sun-bleached Middle Eastern / Mediterranean urban district, roughly 90x90 metres of playable space.

Requirements:
- **Modular kit**: build a reusable set of wall/floor/roof/opening pieces with correct real-world dimensions (storey 3.2m, door 2.1m, window sill 0.9m, parapet 1.1m). Assemble buildings from the kit rather than hand-placing boxes.
- **Enterable buildings**: at least three with interiors, doorways, windows, stairs to a second floor and roof access. Interiors need furniture, not empty shells.
- **Deliberate layout**: a central plaza/market, two flanking alley routes, an elevated position, and hard cover in the sightlines. Every one of the eight poses in \`src/core/Poses.ts\` must frame a genuinely composed shot — read that file and make each pose look intentional, with foreground occluders, midground subject and background depth.
- **Prop density is what sells it**: market stalls with awnings and hanging fabric, crates, barrels, sandbag emplacements, jersey barriers, a burnt-out car, air conditioning units, satellite dishes, hanging power and laundry lines, drainpipes, wall-mounted conduit, rubble piles, scattered bricks, tyres, oil drums, pallets, signage in a plausible script, tattered posters. Aim for hundreds of props, instanced.
- **Geometric detail**: chamfer and bevel edges — perfectly sharp 90 degree edges catch no light and are the most obvious tell of untextured blockout work. Add trim, cornices, window recesses (real depth, not a flat texture), and door frames.
- **Terrain**: subtly displaced ground, not a flat plane. Kerbs, steps, a slight camber to the road, potholes, sand drift accumulating against walls.
- **Foliage**: instanced dry grass tufts, a few palms/olive trees, weeds growing from cracks. Vertex-animated wind is a strong bonus.
- **Damage and history**: bullet-pocked walls, collapsed sections, exposed rebar, water stains beneath windows, soot above them.

Use \`ctx.services.materials.get(name)\` with names from \`src/render/MaterialNames.ts\` ONLY. Register collision via \`ctx.services.physics\` — use \`addStaticBox\` for boxy geometry (far cheaper than trimesh) and trimesh only for genuinely complex shapes.

Performance: merge static geometry aggressively (BufferGeometryUtils.mergeGeometries), use InstancedMesh for repeated props, and keep draw calls under ~400. Set \`castShadow\`/\`receiveShadow\` deliberately — not everything needs to cast.

Populate \`spawnPoints\`, \`playerSpawn\`, \`playerSpawnYaw\`, \`bounds\`, and implement \`isIndoors()\` properly (it drives reverb and lighting).`,
  },
  {
    label: 'player',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Player movement and camera feel

YOU OWN: \`src/player/*.ts\` (PlayerSystem.ts plus new files: CameraRig.ts, Movement.ts).

Implement \`PlayerSystem\` (conforming to \`PlayerService\`). This subsystem is where the game either feels like Call of Duty or feels like a three.js demo. Feel is the deliverable.

Movement — use Rapier's \`KinematicCharacterController\` (available via \`ctx.services.physics\`; the PhysicsSystem exposes \`world\` and \`rapier\`):
- Capsule collider, eye height 1.68m, crouch height 1.05m. Radius ~0.32m.
- Ground acceleration with high accel and high friction — snappy stops, no ice skating. Air control reduced but present.
- Speeds: walk 3.2 m/s, run 4.8 m/s, sprint 6.6 m/s, tactical sprint 8.2 m/s (double-tap W or Shift+Shift), crouch 2.1 m/s, ADS 2.4 m/s.
- Slide: from sprint + crouch, with momentum, a friction curve, and a camera roll into it. Cancellable into a jump.
- Mantle/vault: automatic when approaching a ledge under ~1.4m while moving forward; a short scripted camera arc that lifts the player over. Detect with sphere casts.
- Jump with coyote time and buffered input. Land with a damped camera dip proportional to fall speed; hard landings hurt.
- Step offset so 0.3m kerbs and stairs are walked over without jumping.
- Slope limits, and slide-down on steep slopes.

Camera rig — this is the craft:
- Mouse look with configurable sensitivity, pitch clamp, and a separate ADS sensitivity multiplier.
- **Head bob** driven by a phase accumulator tied to distance travelled, not time — figure-eight path, amplitude scaled by speed and cut to near zero when aiming. Emit \`player:footstep\` at the bottom of each step cycle, with the surface sampled from a downward raycast.
- **View sway**: the camera lags mouse input very slightly with a spring, and the weapon lags the camera more. Layered lag is the whole trick.
- **Breathing**: a low-amplitude idle oscillation, amplified when hurt or after sprinting.
- **Recoil**: consume \`ctx.services.weapons.recoilPitch/recoilYaw\` additively on top of aim, with recovery that returns most but not all of the kick.
- **FOV kick**: base FOV from config, scaled up while sprinting, down while aiming, with a smooth spring — never a linear lerp.
- **Damage response**: view punch away from the hit direction on \`player:damaged\`.
- Roll the camera slightly when strafing and more when sliding.

Every spring/damper must be framerate independent (use \`1 - Math.exp(-k*dt)\`, never a raw lerp factor). Honour \`ctx.config.pose\` — when a named pose is set the camera must sit exactly where \`Poses.ts\` says and not drift, since screenshots depend on it.

Also handle health: regeneration after a delay out of combat, and emit \`player:died\`.`,
  },
  {
    label: 'weapons',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Weapons, viewmodel and ballistics

YOU OWN: \`src/weapons/*.ts\` (WeaponSystem.ts plus new files: WeaponDefs.ts, Viewmodel.ts, WeaponGeometry.ts, Ballistics.ts, Recoil.ts).

Implement \`WeaponSystem\` (conforming to \`WeaponService\`). The viewmodel occupies a third of the screen at all times — its quality is disproportionately important.

**Weapon geometry**: build detailed weapons procedurally from primitives, in \`ctx.viewmodelScene\`. At minimum an assault rifle; ideally also an SMG, a sniper and a sidearm. Each needs: receiver with correct proportions, barrel, handguard with actual rail slots (individual small boxes, not a texture), magazine with a curve, pistol grip, adjustable stock, charging handle, ejection port, trigger and trigger guard, sights, sling mounts. Chamfer everything. Real dimensions — an M4 is 84cm long. Use gunmetal/metalPainted materials with genuine roughness variation and edge wear on the high-touch areas.

**Optic**: a red dot sight with a housing, glass with a subtle blue anti-reflective tint, and a reticle that stays centred regardless of view angle (render it as a screen-facing sprite anchored to the sight axis, or use a shader — the point is it must be parallax free and must NOT drift off the barrel axis when aiming).

**Viewmodel animation**, all procedural, all framerate independent springs:
- Idle: subtle breathing sway.
- Walk/run bob synced to \`ctx.services.player.speedFraction\`.
- Sprint: weapon canted down and to the side, both hands on it, distinctly different pose.
- **ADS**: the single most important animation. Transition over ~180ms with an ease curve, moving the weapon so the sight line aligns EXACTLY with the camera centre. Get this alignment mathematically right — compute the offset from the sight's local position rather than eyeballing constants. FOV narrows simultaneously.
- Recoil: a per-shot kick with rotational and translational components plus a recovery spring, tuned per weapon.
- Reload: a real sequence — mag release, mag drops out (spawn a physics mag), new mag in, tap, charging handle on empty reload. Roughly 2.1s, 2.6s empty. Emit the \`weapon:reload\` phase events.
- Weapon switch, and an inspect animation on a key.
- Layered additive sway that lags the camera, more when moving.

**Ballistics** (\`Ballistics.ts\`): hitscan with a travel-time tracer visual. Per-weapon damage, damage falloff over distance, headshot/limb multipliers via \`HitInfo.region\`, and material penetration — thin metal, wood and plaster let rounds through with damage reduction, concrete stops them. Spread that grows with fire duration and shrinks when aiming/crouched. Fire modes: auto, burst, semi.

**Recoil patterns**: each weapon gets a deterministic recoil sequence (a shaped path, like a real CoD spray pattern) with a small random component, written into \`recoilPitch\`/\`recoilYaw\` for the camera rig to consume.

Fire the events in \`Events.ts\` — \`weapon:fired\`, \`weapon:hit\`, \`weapon:ammo\`, \`weapon:dryFire\` — and call \`ctx.services.fx\` for muzzle flash, tracers, shells and impacts, and \`ctx.services.audio\` for sound. Degrade gracefully if a service is missing.

For the \`weapon\` and \`ads\` poses in \`Poses.ts\`, make sure the weapon is posed and framed to look its best — those frames are graded directly.`,
  },
  {
    label: 'ai',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Enemy soldiers — characters, animation and AI

YOU OWN: \`src/ai/*.ts\` (AiSystem.ts plus new files: Soldier.ts, SoldierMesh.ts, Navigation.ts, Behaviour.ts, Ragdoll.ts).

Implement \`AiSystem\` (conforming to \`AiService\`). There are no model files — build soldiers procedurally.

**Character mesh**: a properly proportioned 1.8m soldier built from a THREE.Skeleton with real bones (pelvis, spine x2, neck, head, clavicles, upper/lower arms, hands, thighs, shins, feet). Skin a SkinnedMesh to it. Body built from tapered segments with correct human proportions (7.5 heads tall). Kit it out: helmet, plate carrier with pouches, boots, gloves, a rifle in the hands. Use uniform/webbing/helmet/skin materials. Silhouette matters more than surface detail at gameplay distance — make the silhouette read instantly as a soldier.

**Procedural animation** (no clips — drive the bones directly):
- Locomotion: a gait cycle with hip sway, contralateral arm swing, foot placement and knee bend via two-bone IK, blended between idle/walk/run by speed. Feet must plant on the ground with an IK offset from a downward raycast — sliding feet are an instant failure.
- Upper body aims at the target independently of the legs (spine twist + head look-at), so a soldier can run one way while shooting another.
- Weapon recoil pushes through the arms.
- Crouch and prone poses, cover lean-out, and a reload animation.
- Hit reactions: a directional flinch that layers additively over locomotion.

**Navigation** (\`Navigation.ts\`): build a navigation representation from the level — a grid or waypoint graph sampled against physics raycasts is fine, A* over it, plus string-pulling for smooth paths and local steering with obstacle avoidance so soldiers do not grind along walls.

**Behaviour** (\`Behaviour.ts\`): a proper state machine — Idle, Patrol, Investigate, Engage, SeekCover, Suppress, Flank, Reload, Retreat, Dead. Perception with a vision cone, line-of-sight raycasts and hearing driven by \`notifyNoise\`. Cover scoring: evaluate nearby positions for whether they block the line to the player, prefer cover that keeps a firing angle. Squad coordination: not everyone advances at once — some suppress while others flank. An accuracy model that misses deliberately at first contact and tightens over time, with tracers passing near the player rather than being hitscan-perfect.

**Ragdoll** (\`Ragdoll.ts\`): on death, build a Rapier rigid body chain with joints matching the skeleton, hand off the bone transforms, and apply the killing impulse at the hit location so bodies fall in the direction they were shot. Fade and clean up after ~12s.

Register hitboxes with \`physics.registerHitbox()\` so headshots resolve — head, chest, stomach, arms, legs, each mapping to a \`HitInfo.region\`. Implement \`Damageable\`, register in \`ctx.entities\`, and emit \`damage:dealt\` and \`entity:killed\`.

Spawn waves at \`ctx.services.level.spawnPoints\`. Enemies must be alive and visible for the \`firefight\` pose at t=6.5s — make sure that frame has action in it.`,
  },
  {
    label: 'vfx',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Visual effects

YOU OWN: \`src/fx/*.ts\` (FxSystem.ts plus new files: Particles.ts, Decals.ts, Tracers.ts, Impacts.ts, Explosions.ts, Shells.ts).

Implement \`FxSystem\` (conforming to \`FxService\`). Effects are what make shooting feel powerful.

**Particle system** (\`Particles.ts\`): one GPU-driven, pooled, instanced system with a custom shader — position/velocity/life/size/rotation/colour per particle updated on the GPU or in a tight typed-array loop. Budget from \`ctx.config.particleBudget\`. Support soft particles (fade against scene depth — hard intersection lines with geometry are an instant failure), additive and alpha blend modes, animated sprite sheets generated procedurally, and per-particle gravity/drag/turbulence.

**Impacts** (\`Impacts.ts\`), branching on \`Surface\`:
- concrete/plaster: grey dust puff with a hard initial burst, chips flying, a lingering slow-drifting cloud
- metal/thinMetal: bright sparks that bounce and die, a small flash, a ricochet spark spray along the surface tangent
- wood: splinters and a browner dust
- dirt/sand/gravel: a fan of granular debris kicked along the impact normal
- glass: shattering shards, and the glass pane should actually break
- water: a splash crown with droplets and a ripple
- flesh: a directional blood mist cone plus a small spray, no gore excess
- foliage: leaf fragments

Each impact also spawns a **decal** and a puff of the right colour, and hands the impulse to physics debris.

**Decals** (\`Decals.ts\`): projected onto the surface with correct orientation and a slight normal offset to avoid z-fighting. Pooled with a strict budget from \`ctx.config.decalBudget\`, oldest recycled first, fading out before recycling. Bullet holes need a dark centre, a lighter crushed rim, and radial cracking that varies per surface. Also blood pools and scorch marks.

**Tracers** (\`Tracers.ts\`): stretched, additive, hot-cored billboards that travel at plausible speed (not instant), with only a fraction of rounds tracered, and a brief bright flash at the muzzle end. They should light nothing but read clearly against both sky and shadow.

**Muzzle flash**: multi-layered — a hot white core, an orange bloom, a radial star flare, and a puff of propellant smoke — randomised per shot, present for only 2-3 frames, and paired with a real point light borrowed from the lighting system so the flash illuminates the surroundings.

**Shells** (\`Shells.ts\`): physics-driven brass, ejected with spin, bouncing with a metallic ping, pooled and cleaned up.

**Explosions** (\`Explosions.ts\`): a genuine sequence — flash, expanding fireball with turbulent noise, shockwave ring distortion, debris thrown by \`physics.applyRadialImpulse\`, a rising smoke column, dust kicked off nearby surfaces, and a lingering scorch decal. Drive \`postfx.setDamageFlash\` and the audio duck.

Also add ambient life: dust motes drifting in sunbeams, heat shimmer over hot surfaces, and wind-blown paper/sand.

Everything pooled — zero allocation in the update path. Everything must respect \`ctx.config\` budgets.`,
  },
  {
    label: 'audio',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: Audio

YOU OWN: \`src/audio/*.ts\` (AudioSystem.ts plus new files: Synth.ts, SoundBank.ts, Reverb.ts, Mixer.ts).

Implement \`AudioSystem\` (conforming to \`AudioService\`). There are NO audio files and no network access — synthesise everything with the Web Audio API, rendering to AudioBuffers at init via OfflineAudioContext so playback is cheap.

**Synthesis** (\`Synth.ts\`, \`SoundBank.ts\`) — build a proper toolkit (noise generators, ADSR envelopes, biquad filter sweeps, waveshaping/distortion, resonant body models, pitch-shifted layering) and then author:
- **Gunshots**: the hardest and most important. A real gunshot is a very short transient click, a loud broadband crack shaped by a fast decay envelope, a low-frequency body thump, and a tail. Layer at least four elements per weapon and randomise pitch/timing slightly per shot so automatic fire does not sound like a machine-gun loop of one identical sample. Distinct character per weapon — the rifle sharp and punchy, the SMG faster and thinner, the sniper with a deep boom and long tail.
- **Distant gunfire**: the same shot low-passed heavily with a long reverb tail and no transient — this is what sells scale.
- **Mechanical foley**: bolt cycling, mag release, mag seating, charging handle, trigger click, dry fire, safety, weapon raise/lower. Short, bright, metallic, resonant.
- **Footsteps** per surface (concrete, dirt, sand, gravel, wood, tile, metal) with variation, plus running versions.
- **Impacts** per surface, ricochets with a pitch-swept whine, bullet whizby and supersonic crack.
- **Explosions**: sub-bass thump, broadband blast, debris rain, and a long tail.
- **Ambience**: a continuous wind/city bed, distant dogs, occasional distant gunfire and vehicle passes.
- **UI**: hitmarker tick, headshot tick, kill confirm, low ammo.

**Spatialisation** (\`Mixer.ts\`): PannerNodes in HRTF mode, distance attenuation with an inverse curve, air-absorption low-pass that increases with distance, and a propagation delay for distant sounds (you see the flash before you hear it — a huge realism win). Occlusion: raycast from the listener to the source through \`ctx.services.physics\` and low-pass anything occluded.

**Reverb** (\`Reverb.ts\`): generate impulse responses procedurally — a long, bright, slappy IR for outdoor urban canyons, a short dense one for rooms, and a very long one for halls. Switch zones off \`ctx.services.level.isIndoors()\` and crossfade rather than cutting.

**Mix**: a bus structure (weapons, world, ambience, UI) with a limiter on the master, sidechain ducking so gunfire pushes ambience down, and a tinnitus ring plus heavy low-pass after nearby explosions that recovers over a few seconds.

Browsers block audio until a user gesture — start the context suspended and resume on first click/keypress, and never throw or block boot if audio is unavailable. In the screenshot harness there is no gesture, so audio MUST fail silently and must never prevent \`window.__captureReady\`.

Subscribe to the events in \`Events.ts\` rather than requiring other systems to call you where possible.`,
  },
  {
    label: 'hud',
    prompt: `${BRIEF}## YOUR SUBSYSTEM: HUD, menus and interface

YOU OWN: \`src/ui/*.ts\` (HudSystem.ts plus new files: Crosshair.ts, Killfeed.ts, Minimap.ts, Compass.ts, Menus.ts, Indicators.ts).

Implement \`HudSystem\` (conforming to \`HudService\`). The HUD is graded in the same frames as the render — a default-looking HUD drags the whole image down.

Build it in DOM + CSS (with canvas where it earns its keep, e.g. the minimap and compass). Everything must be resolution independent and pointer-events-none except menus.

**Art direction**: modern military UI — thin, precise strokes; a restrained palette of off-white, a desaturated tactical green or amber accent, and red only for damage; subtle drop shadows so it reads over both bright sky and dark shadow; condensed geometric type. Use system font stacks (no network fonts) but pick a genuinely condensed stack and tune letter-spacing. Nothing should be pure white at full opacity — 85-92% opacity keeps it sitting in the image rather than on top of it.

Elements:
- **Crosshair**: four ticks that spread dynamically with the current weapon spread, plus a centre dot, hidden while aiming. Must animate smoothly.
- **Hitmarkers**: a quick X that scales and fades; white for a body hit, a sharper variant for a headshot, red for a kill. Snappy — 120ms.
- **Ammo counter**: bottom right, current magazine large, reserve small, a weapon name, a fire-mode indicator, and a row of magazine pips. Flashes red under 25%.
- **Health**: no bar — CoD uses a damage vignette. Red screen-edge blood effect that intensifies with damage and clears as health regenerates, plus a heartbeat pulse when critical.
- **Damage direction indicators**: arcs around the crosshair pointing at the source, computed from the world direction in \`damageDirection()\`.
- **Compass**: a top-centre scrolling strip with cardinal points and degree ticks, plus enemy/objective markers.
- **Minimap**: top left, a canvas-rendered top-down view of the level (sample \`ctx.services.level.bounds\` and raycast a heightfield once at init), rotating with the player, showing the player arrow, enemy blips when they fire, and the map edge.
- **Killfeed**: top right, stacked entries "KILLER [weapon icon] VICTIM", newest at the bottom, fading after 5s. Draw simple weapon glyphs as inline SVG.
- **Objective/score**: a subtle top-centre readout.
- **Menus** (\`Menus.ts\`): a start screen with the game title, a pause menu, a settings panel that actually drives \`ctx.config\` quality (re-emitting \`quality:changed\`), and a death screen. These need real design — a background blur of the live scene, staggered fade-in animation, and hover states.
- A low-ammo warning, a reload prompt, and a sprint/stamina indicator if useful.

Respect \`ctx.config.hideHud\` (the critic grades some frames with the HUD off) and \`ctx.config.stats\` (a small frame-time/draw-call overlay). Wire up \`ctx.config.autoStart\` so the harness skips the menu.

Animate with CSS transforms and opacity only — never layout properties — so the HUD never costs frame time.`,
  },
]

phase('Build')

const results = await parallel(
  AGENTS.map((a) => () =>
    agent(a.prompt, { label: a.label, phase: 'Build' }).then((r) => ({ agent: a.label, report: r }))),
)

return results.filter(Boolean)
