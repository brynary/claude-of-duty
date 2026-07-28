# Critique round 1 — aggregated findings

Eight independent critics graded the eight rendered poses against
`.ai/VISUAL_RUBRIC.md`. Every pose scored **3/10, ITERATE**.

Axis means (worst first): Weapon and HUD 2.25 · Material response 2.63 ·
Post-processing 2.75 · Lighting 2.88 · Geometry 3.13 · Storytelling 3.38 ·
Composition 3.63.


## weapons (total impact 23)

- [ads] Rebuild the ADS viewmodel as one welded optic mesh mounted to the receiver rail: eliminate the three floating cylinder primitives, scale the outer tube to ~12% of frame height, align the tube axis to the camera forward vector, and draw a single reticle sprite locked to pixel (960,540). Remove the large semi-transparent grey disc currently washing out everything behind the glass and replace it with a proper scope-glass shader (slight tint, edge vignette, subtle parallax).
- [interior] Rebuild the weapon viewmodel material and framing. Kill the cobalt blue albedo and replace with metalness 1.0, near-black neutral albedo (sRGB ~0.05), and a wear-mask-driven roughness map in the 0.3-0.55 range; remove the uniform noise bump and the mirror-chrome optic. Then reposition the viewmodel to standard low-right carry with the muzzle inside the frame and viewmodel FOV around 60-65 degrees so it stops eating a third of the screen and no longer crops off the right edge.
- [sunset] Rebuild the M4A1 viewmodel as a single correctly parented rig: reattach the exploded receiver/sight/rail components so no part floats free, add first-person arms and hands with a trigger grip and a supporting hand on the handguard, then re-author the hip-fire pose to CoD reference — bore axis parallel to view, receiver below the lower third, total screen coverage under 20% in the bottom-right. Replace the saturated blue-grey bumpy metal with a dark gunmetal albedo plus coloured specular and a smooth roughness, and remove the blown white specular streak on the top rail.
- [weapon] Make the viewmodel opaque and solid: set transparent:false, opacity:1.0, depthWrite:true, depthTest:true on every weapon submaterial, and render the viewmodel on its own layer with a cleared depth buffer so it can never be see-through or intersect world geometry. Then rescale and reposition it to ~30% of frame, entirely below the horizon in the lower-right, with the bore and optic both projecting through screen centre, and add rigged arms and gloves.
- [plaza] Rebuild the M4A1 viewmodel: set the receiver/rail albedo to dark gunmetal (~0.05) and the furniture to matte polymer (~0.12) instead of cobalt blue, drop normal-map strength from its current sandpaper setting to ~0.15, delete the three duplicated rail+optic meshes ghosting toward the bottom-right, add a magazine and first-person hands/forearms with a real grip, give the optic a tinted lens plane and a reticle, chamfer the rail teeth, and reframe the gun to ~55° yaw occupying roughly the lower-right 22% of the frame so it no longer runs off both the right and bottom edges.
- [vista] Rebuild the weapon viewmodel pose and materials: fix the transparent optic housing (opaque blend, depth write on), reduce scale ~25%, re-pose so the bore axis points at the crosshair with the muzzle in frame, clamp albedo to neutral dark polymer with R=G=B, and delete the glitter-scale normal map on the receiver.
- [firefight] Reframe the M4A1 viewmodel — currently only two low-poly hand blobs appear at the bottom-right corner and the weapon body is entirely off-screen. Move it to a standard low-ready hipfire pose with the receiver, magazine, optic and handguard visible in the lower-right quadrant, and replace the faceted salmon hands with gloved hands carrying proper knuckle and finger geometry.
- [alley] Rebuild the viewmodel pass end to end: set the weapon material opaque with depthWrite on (it is currently translucent - the boarded window shows through the receiver), swap the blue chrome PBR for dark gunmetal (albedo ~0.04, metalness 1, roughness 0.35 from a real roughness map), render it in a separate camera layer with its own near clip and its own dimmer weapon-space environment so it stops picking up sky-blue reflections, reframe it to bottom-right occupying ~28% of screen width with the bore axis aligned to the crosshair, and attach hands/arms - there are currently none.

## lighting (total impact 18.8)

- [ads] Add a directional sun with cascaded shadow maps (3-4 cascades, normal-offset bias to avoid acne) plus a screen-space AO pass at ~0.5m radius. Every prop — the barrel bottom-right, the crates mid-right, the stone blocks — must show a dark contact line where it meets the cobbles, and wall/ground junctions must darken.
- [interior] Give the interior an actual light rig. Make each back window a shadow-casting portal light with a raymarched volumetric shaft landing on the floor, make the hanging bulb a real point light with an emissive cap and a visible falloff pool, and add a GTAO pass (radius ~0.5m, strength 0.8) plus short-range contact shadows so the chair, table and pipe stop floating. Target a warm key from the windows against a cool ambient fill.
- [sunset] Enable SSAO (~0.5m radius) plus per-object contact shadows so props sit in the scene — cones, crates, drums, fountain wall and sandbags currently have zero contact darkening. In the same pass switch cascade shadows to PCSS or distance-scaled PCF so the awning shadows on the facades soften with distance from the caster, and add a warm ambient bounce term so shadowed faces do not multiply to flat near-black.
- [weapon] Add SSAO plus contact-hardening shadows so props stop looking pasted on. Right now the white pebble cluster at the base of the left barrier, every sandbag stack, and every crate meets the ground with no darkening whatsoever. Also add a dedicated viewmodel light rig with warm key matching the scene sun direction and a cool fill, and enable self-shadowing on the weapon.
- [plaza] Enable SSAO plus a short-range contact-shadow pass so props sit in the scene instead of on it. Priority targets: the crates and barrels at frame-right, all stall posts, the base of the centre stone wall, the arched window recesses, and both enemies (neither casts any shadow). Also fix the two wooden posts under the low stone wall at frame-left, which currently float with a visible gap above the cobble.
- [plaza] Invert the fog profile: add exponential height fog that desaturates and lifts the mosque and minaret at ~60m, and remove the near-field milky haze currently washing the foreground ground plane and the bottom third of the right wall to grey-pink. Replace the flat two-stop sky gradient with a physical sky containing a sun disc, a horizon haze band and a cloud layer.
- [vista] Turn on cascaded shadow maps for the directional sun plus SSAO and a screen-space contact-shadow pass, and rebalance so sun diffuse dominates sky ambient instead of the reverse. Nothing in this frame casts a shadow or grounds to a surface, which is the single reason the crate, the sandbags and the whole scene read as pasted-together primitives.
- [firefight] Add a shadow-casting directional light (4 cascades, 2048px, normal-offset bias) plus SSAO and screen-space contact shadows. Verify the awning at (1500,340) casts onto the wall below it and that the enemy at (1560,610) and every crate base gain a dark contact ring — right now nothing in the frame casts or receives a shadow.
- [alley] Add an SSAO pass (radius ~0.4m, intensity 1.0, 16 samples) plus short-range contact shadows, and stop applying the ambient term unoccluded. Validate against three specific spots: the crate base at (900, 800) and the tire/ground interface at (800, 780) must both go visibly dark, and the ceiling soffit at (300-1200, 0-200) must become the darkest region of the frame rather than the warmest.

## postfx (total impact 17.5)

- [ads] Replace the raw sRGB output with a filmic tonemap (ACES or AgX), reduce fog density by roughly 60% so the black point returns, and restrict bloom to emissive sources only — the fire at top right must resolve a coloured core instead of clipping to white. Then add ADS depth of field: focus at reticle depth, near blur on the handguard, far blur beyond ~25m.
- [interior] Fix the grade. Delete the dark-red bands at the top and bottom of the frame outright. Switch to ACES or AgX tone mapping, drop exposure roughly one stop so the two windows and the optic stop clipping to flat white, and set a real black point so interior shadows fall below sRGB 0.1 instead of sitting at 0.25 and reading milky.
- [sunset] Fix the highlight pipeline: replace the current tone curve with AgX or ACES with a real shoulder, drop exposure about 1.5 EV, and raise the bloom threshold while tightening the kernel so it only fires on the sun disc and muzzle flashes. Then cut fog density roughly in half and switch to a height-fog + exponential-distance model so it separates depth planes instead of veiling everything at one value. Target: the sun holds a visible disc with warm orange rolloff, the soldiers stop being solid white blobs, and the midground regains a true black point.
- [weapon] Delete the saturated maroon edge overlay that covers all four borders of the frame (it reads as a permanently-stuck damage vignette) and replace it with a neutral radial vignette at 8-12%. Then add a real ACES/filmic tonemap with a proper shoulder so the frame reaches true black, and restrict bloom to a luminance threshold above ~2.0 so it stops smearing every mid-tone.
- [plaza] Add an ACES or AgX filmic tonemapper with a real shoulder and threshold the bloom above sun-lit stucco luminance — the two enemies at frame centre-right are currently clipped to pure white with heads and torsos entirely erased. Then remove the global softness: render at native 1920x1080 (no upscale) and add a post-TAA sharpen, or move the DOF focal plane so the midground is in focus. Also remove the vignette/haze tint pushing the sky corners to lavender-pink.
- [vista] Replace the flat neutral fog with sun-tinted exponential height fog at roughly half the current near-field density, and grade the result with a filmic curve that restores a true black point and warm/cool split-toning. The frame currently averages 12.9% saturation with a lifted 33/255 black, which is what makes it read as a washed-out browser demo.
- [firefight] Cut the global fog/haze that is filling the left 55% of the frame — reduce exponential fog density about 4x, raise the bloom threshold above 1.0 linear so only genuinely bright sources bloom, then regrade with an ACES/filmic curve whose toe reaches 0.0. Target a scene-region standard deviation above 0.20 and true blacks below 0.02 instead of the current 0.105 and 0.086. Also remove the diagonal straight-line scratch overlay.
- [alley] Replace the raw output with an ACES filmic tone map, halve the fog density and warm the fog colour toward the sun, and reduce gameplay depth-of-field to near zero. The frame currently packs 84% of its pixels into luminance 32-144 and the entire left wall peaks at 136, so nothing reads as sunlit; after the change the beam tops should exceed 200 and the shadowed alley floor should drop below 20.

## materials (total impact 12.5)

- [ads] Give the weapon a dark anodized metal material (albedo ~0.04, metalness 1.0, roughness 0.35 with a roughness map) instead of the current blue-tinted glossy plastic, and author normal + roughness maps for the brick wall and cobblestone ground so surface relief catches the sun rather than reading as a flat printed image.
- [interior] Raise texel density across the environment by roughly 4x and add detail normals. The plaster wall filling the left half is a blurry low-res decal with hard alpha-cut paint chips that repeats at least three times; the yellow back wall is flat untextured colour. Add a tri-planar detail normal at ~2 tiles/metre over everything, and break the macro tiling with vertex-painted grunge masks.
- [sunset] Author detail normal maps and per-texel roughness variation across all environment materials — there is currently no normal detail anywhere in the frame. Fix the left stone wall specifically: its tile repeats on a ~2m cycle with a visible seam and roughly 4x too-coarse texel density. Break the repeat with triplanar blending or a second UV octave, and add per-instance albedo/roughness jitter to the lumber stacks and sandbags, which are currently identical clones at identical tone.
- [weapon] Re-author the weapon PBR set. Replace the cornflower-blue albedo with parkerized steel (albedo ~0.04, metalness 1.0, roughness 0.35-0.45) and polymer furniture (albedo ~0.025, metalness 0, roughness 0.6). Delete the coarse speckled normal map currently applied at what looks like 100x the correct UV scale — it reads as sandpaper across the rail, stock and receiver — and replace it with a fine machining/bead-blast normal plus a roughness map that varies with wear on edges. Retexture or remove the blurry brown camo wrap on the barrel; it is a completely different material language from the rest of the gun.
- [plaza] Increase ground texel density roughly 4x and add a tiling detail-normal plus roughness breakup to the plaza cobble — the current voronoi cells are about 1m across with no height or grout depth and one flat roughness across half the frame. Break the hard straight seam between the pink dirt patch and the stone with a blend mask and scattered pebble/debris meshes, and add albedo variation plus per-brick colour jitter to the right building's running-bond tile.
- [firefight] Texture the environment. Every building wall, crate and awning is currently a single flat colour with no normal or roughness map. Assign triplanar albedo+normal+roughness materials at roughly 512 texels/m, with per-instance colour variation on crates and grime darkening in the bottom 0.5m of every wall.
- [alley] Author normal + roughness maps for the four hero surfaces - brick, plaster, wood, pebble ground - since none currently has any, which is why the grazing-angle left wall at (0-600, 200-900) reads as printed wallpaper. While in there, break up the pebble field's single flat albedo with per-stone hue/value variation and a cavity dirt layer, and re-tint the tire from navy blue to near-black rubber with a tread pattern.

## level (total impact 8.5)

- [ads] Inset all window and door openings 0.25-0.4m behind the facade with real jamb geometry (the right-hand doorway is currently a flat tan rectangle), chamfer every 90° wall and crate edge by 2-3cm, and break up the plain cuboid building masses with ledges, pipes and roof parapets.
- [ads] Randomize the hanging banners and repeated crates — per-instance width, height, yaw (±8°), colour value, texture variant and wear — so the current uniform grid of identical blue rectangles stops reading as procedural output.
- [interior] Build depth and history into the room. Add a foreground occluder under 1m at the left edge, open a lit space beyond the yellow back wall so the frame has a background plane, model 200mm recessed reveals and sills into both windows and the doorway, chamfer every architectural edge 10-20mm, and scatter asymmetric clutter (rubble, papers, a toppled chair) so the space reads as inhabited rather than as an empty box with three evenly placed props.
- [sunset] Give every window and door opening genuine recessed depth (20-30cm inset with a frame ring and sill) instead of flat coloured quads painted on the facade, and chamfer all building roof and corner edges so they catch a highlight. Delete or re-anchor the red-and-white canopy floating unsupported at frame centre. Then add wall-base grime decals, rust streaks under awning brackets and scattered debris with randomised yaw and tilt to kill the grid-aligned pristine look.
- [plaza] Cut genuine recessed openings into the right-hand stone building instead of the flat grey window decals, with reveals, frames, sills and dark interiors. Then break the pristine finish across the plaza: add grime/rubble/scorch/poster decals, randomise stall module height and rotation, add catenary sag to the awning fabric and the bunting cable, and vary the awning stripe with dirt and wear so it stops reading as a procedural shader.
- [vista] Build a real distance layer: give the skyline two or three silhouette-bearing landmarks (water towers, minaret, antenna masts, taller block) at 150m+, add rooftop clutter and recessed windows to the mid-distance buildings so the LOD chain does not collapse into untextured pale cuboids, and de-clone the sandbag and brick instancing with per-instance jitter.
- [alley] Bevel every crate and beam edge by 1-2cm so silhouettes catch a specular line, convert the painted-on plank divisions to real board geometry with corner battens, randomize per-instance UV offset so the two crates stop sharing identical grain, and settle all props a few centimetres into the rubble surface instead of resting above it.

## hud (total impact 3.3)

- [ads] Stop drawing HUD text at pure white full opacity (the '30' ammo readout and compass ribbon): drop to ~0.85 alpha off-white with a 1px dark outline or soft drop shadow so elements stay legible over bright ground, and restyle the minimap, which currently reads as an untreated top-down diagram of flat coloured rectangles.
- [firefight] Add a hipfire reticle at screen centre (currently absent) and bind the magazine pip bar to the same value as the ammo numeral — it reads 00 with seven full pips lit. Also make killfeed team colouring consistent: CPL. HASSAN appears white in row 1 and red in row 2.
- [alley] Give the HUD a legibility scrim: the ammo block at (1780-1900, 940-1050) is pure white at full opacity sitting on a bright tan wall. Drop it to ~0.85 opacity with a soft dark gradient behind, and redesign the minimap at (30-230, 20-215) - it is currently flat grey rectangles on dark grey and reads as a debug top-down view rather than a designed element.

## ai (total impact 1.8)

- [weapon] Fix the two rooftop soldiers at the top of frame (approx x=1065,y=170 and x=1200,y=230) — they are rendering as fully blown-out white humanoid blobs with no shading, no silhouette detail and heavy bloom halos, which is what a broken emissive or an unclamped material would produce. Clamp the character material's emissive to zero and confirm they are lit by the scene directional light so they read as dark rim-lit silhouettes against the pale sky.
- [firefight] Replace the enemy mannequin with a real soldier mesh: helmet, plate carrier, webbing, boots, and a weapon in hand. The current figure at (1560,610) is a capsule-limbed body with a blank sphere head in flat olive drab, which is the single fastest tell that this is a browser demo.

## vfx (total impact 1.5)

- [firefight] Rebuild the firing VFX. Make the muzzle flash a real point light (2-4m radius, inverse-square, one-frame flicker) attached to the muzzle so it rims the enemy and crates, and shrink the smoke card system so it is a localised puff with depth-fade rather than a screen-wide overlay. Replace the curved red banana tracer at (945,445) with a thin additive quad elongated along velocity with a hot white core.

---

# Verification notes — READ BEFORE ACTING

The critics graded rendered frames, so their descriptions of **symptoms** are
reliable. Several of their **diagnoses** are wrong. These were checked against
the source before this document was written:

1. **"Add an SSAO pass" — SSAO already exists.** `PostFX.ts` builds an
   `SSAOEffect` and adds it at line ~138, gated on `config.ssao` (true at
   ultra). The defect is that it is too weak to read in the frame. Tune
   radius/intensity/bias and verify against a rendered frame. Do **not** add a
   second AO pass.

2. **"No surface has a normal map" — normal maps are bound.** `Materials.ts`
   assigns `mat.normalMap` and `mat.normalScale`. The likely cause is the
   world-space triplanar shader patch flattening or mis-transforming the normal,
   or `normalScale` being far too low. Diagnose the shader path before
   authoring anything new.

3. **"The weapon is see-through" — probably a misread.** The only
   `transparent: true` in `WeaponGeometry.ts` is scoped to the optic glass. The
   receiver is opaque. What the critic saw is almost certainly the polished
   chrome mirroring the background. Confirm before changing blend state.

4. **The blue weapon has a known root cause, already partly fixed.** Both
   `Lighting.ts` and `Viewmodel.ts` were assigning `viewmodelScene.environment`.
   Lighting no longer does. `Viewmodel.ts` still prefers the sky PMREM over its
   own unused `makeStudioEnvironment()`. Combined with metalness 0.9-0.94 and
   roughness 0.46-0.52, the weapon becomes a mirror of a blue sky.

## Standing rule

Reproduce a defect in the source before fixing it. If a finding turns out to be
wrong, say so in your report rather than implementing a change that is not
needed — a redundant pass costs frame time and hides the real problem.
