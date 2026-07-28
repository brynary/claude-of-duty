# Claude of Duty

A first-person shooter built in three.js, targeting the visual and tactile
quality of a modern Call of Duty title. Everything is generated in code — there
are no texture files, no model files, no audio files, and no network requests at
runtime.

## Running it

```bash
npm install
npm run dev            # http://127.0.0.1:5173
```

Click the canvas to lock the mouse; `Esc` releases it. Audio is synthesised in
the browser and starts on your first click, because browsers block audio until
a user gesture.

| Action | Input |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint / tactical sprint | `Shift` / double-tap `Shift` |
| Walk | `Alt` |
| Crouch | `Ctrl` (hold) or `C` (toggle) |
| Slide | Sprint + `Ctrl` |
| Jump, mantle | `Space` |
| Fire, aim | Left mouse, right mouse |
| Reload | `R` |
| Fire mode | `B` |
| Inspect | `I` |
| Switch weapon | `1`–`4`, mouse wheel |
| Pause | `Esc` |

Vaulting is automatic when you move into a ledge below about 1.4m.

Quality tiers: append `?quality=low|medium|high|ultra` (default `ultra`).

## Architecture

`src/core/Types.ts` is the contract. Every subsystem implements `System` and
publishes itself on `ctx.services`, so no subsystem imports another's concrete
class. Cross-system messages go through the typed bus in `src/core/Events.ts`.

```
core/       engine, frame loop, typed events, input, config, seeded RNG, capture poses
physics/    Rapier world, raycasts, character controller support, debris
render/     materials, procedural texture toolkit, sky, lighting, shadows, post chain
world/      modular level kit, buildings, props, foliage, terrain
player/     character controller, camera rig, movement feel
weapons/    procedural weapon geometry, viewmodel animation, ballistics, recoil
ai/         skinned soldiers, navigation, cover behaviour, ragdolls
fx/         pooled GPU particles, decals, tracers, impacts, explosions
audio/      Web Audio synthesis, spatialisation, procedural reverb
ui/         HUD, minimap, compass, killfeed, menus
```

Registration order in `src/main.ts` is both init and update order, arranged so a
system is registered before anything that resolves it.

Units are metres, 1 unit = 1m. Eye height 1.68m, storey 3.2m, door 2.1m.

All structural randomness runs through the seeded PRNG in `src/core/Rand.ts`, so
a given seed always produces the same level and screenshots reproduce exactly.

## Measuring the render

Visual quality here is graded, not asserted. Three tools support that.

**Deterministic capture.** `tools/screenshot.mjs` drives the built game to eight
fixed camera poses in headless Chrome, freezes the simulation at a set time,
waits for temporal accumulation to converge, and writes PNGs.

```bash
npm run build
node tools/screenshot.mjs --all --out shots/mybuild
```

**Objective analysis.** `tools/analyze.mjs` measures tonal range, black and white
point, local contrast and near-field haze against the targets in
`.ai/TONAL_TARGET.md`.

```bash
node tools/analyze.mjs shots/mybuild
```

This exists because iterating on adjectives oscillates. Three rounds swung
between "washed out" and "crushed" before the target was written as numbers.

**Blind comparison.** `tools/blind.mjs` pairs the same pose from two builds,
randomises which is shown as A and which as B, and withholds the key — so a
reviewer cannot favour the build they know is newer.

```bash
node tools/blind.mjs --a shots/old --b shots/new --out shots/blind
node tools/blind.mjs --reveal shots/blind
```

Ask the reviewer what the *losing* frame did better. That question has caught
two regressions in this project that scoring the winner alone would have missed.

## Notable implementation details

- **Procedural PBR library** — tileable value/Perlin/ridged/Worley noise, height
  to normal conversion, and a weathering layer set (edge wear, cavity grime,
  gravity streaks, rust). World-space triplanar projection on architecture and
  ground, so texel density is correct in metres regardless of mesh UVs.
- **Lighting** — Preetham sky, PMREM environment baked from that same sky, a
  cascaded shadow map with custom splits, and a sky-visibility volume sampled by
  raycast that gives the ambient term real occlusion.
- **Post chain** — ACES filmic tone mapping with explicit shadow and highlight
  shapers, a procedural 3D LUT grade, SSAO, SSR, bloom keyed to scene luminance,
  and per-pose auto exposure.
- **Weapons** — receivers, rails, optics and magazines built from primitives with
  chamfered edges; the viewmodel is lit by its own studio rig in a separate scene
  so it reads consistently regardless of where the player is standing.
- **Audio** — every sound is synthesised through an `OfflineAudioContext` at
  init: layered gunshots, mechanical foley, surface-dependent footsteps, and
  procedurally generated impulse responses for reverb.

## Development notes

`.ai/` holds the working record: the agent brief, the visual rubric, the tonal
target, and the critique from each round including the regressions each one
introduced. `.ai/CRITIQUE_ROUND3.md` in particular documents a process failure
worth not repeating.
