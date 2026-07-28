# Critique round 3 — iteration 3 lost the blind test

## Blind A/B: iteration 3 lost to iteration 2, 2 wins to 6

Judges saw unlabelled pairs with the key withheld. Iteration 3 won only
`firefight` and `interior`. This is a real regression, not noise.

Absolute score barely moved: 3.00 -> 3.56 -> 3.61.

## What iteration 3 got right

The weapon fix landed. Judges repeatedly noted the rifle is now fully
readable, with receiver, rail, optic, front sight and camo handguard all
distinct. Shadow detail also returned.

## What iteration 3 broke

Read `.ai/TONAL_TARGET.md` first. In short, fixing the crush overshot into a
second wash-out, and the aerial-perspective work brought back near-field haze:

- **The white point was lost.** Max luma fell from 248 to 236. A judge:
  "highlights top out at 237 so nothing ever reaches white ... no true black,
  no true white, nondirectional fill: that combination is the most reliable
  untuned-render tell."
- **Blacks vanished.** Pixels below code 8 fell from 25.9% to 0.42%. The right
  answer was somewhere between the two, not the other extreme.
- **Near-field haze returned.** `nearFieldLift` went 0.012 -> 0.114. A judge:
  "a uniform milky haze is applied even at two meters, veiling near-field
  crates and barrels".
- **Global contrast fell** from std 50 to std 39.

## The finding no round has addressed

`localContrast` has measured 0.017-0.020 in every iteration against a target of
0.030-0.070. That is the numeric form of every "mushy surfaces", "no relief",
"texel density too low" note the critics have filed since round 1. It cannot be
fixed with a tone curve. It needs material and geometric detail.


## weapons (impact 15.2)

- [firefight] Restore the first-person weapon viewmodel. There is no M4A1 geometry anywhere in the frame despite the HUD labelling it - I level-stretched the entire bottom half and found no receiver, barrel, magazine or hands. Check whether the viewmodel camera layer is being cleared by the particle pass, whether the near clip plane is eating it, or whether its material alpha is being driven to zero. Then verify it renders lit, at correct proportion, with no clipping into the barricade at bottom-right.
- [sunset] Rebuild the viewmodel presentation: add gloved first-person hands gripping the pistol grip and handguard (the gun currently floats with only a forearm tube), replace the single stippled noise normal covering the whole weapon with per-part materials, and make the red dot lens a tinted transparent with an emissive reticle instead of an opaque grey disc. Also add an ambient/bounce term to the viewmodel - its lower half currently falls to near-black with no fill.
- [weapon] Rebuild the M4 viewmodel as one correctly parented, watertight hierarchy: seat the magazine in a real magwell (it is currently a detached brick floating off the receiver), merge the fan of intersecting z-fighting handguard planes into a single solid, add the missing trigger guard, pistol grip and stock, and give the optic an actual lens — tinted glass with a screen-space reticle instead of the flat grey disc. Then replace the fingerless capsule support hand with a rigged hand whose fingers wrap the handguard.
- [plaza] Rebuild the viewmodel: model gloved hands (left fingers wrapped over the handguard, right hand on the pistol grip with trigger finger indexed), boolean-merge or offset the interpenetrating box prisms so no coincident faces remain along the handguard and receiver, and rebuild the optic as a transparent tube with a tinted glass plane and an emissive red dot instead of the solid white L-post. Then give the gun its own material set — dark anodized receiver, semi-gloss phosphate barrel, matte polymer furniture — and a dedicated viewmodel key light aligned to the sun so top surfaces catch it.
- [alley] Rebuild the M4 viewmodel. The handguard and magwell are a splay of zero-thickness intersecting quads, the rear ring sight floats unattached and unaligned with the front post, there are no hands or fingers on the weapon at all, and a world-geometry concrete panel at lower right draws over the lower receiver. Model closed solids with chamfered edges, attach rigged hands, and render the viewmodel on its own depth pass.
- [interior] Rebuild the viewmodel: weld the lower receiver into one closed solid with a real trigger guard, pistol grip and mag well (it is currently ~20 disconnected intersecting plates, some see-through to the wall behind at x=1450-1650); add a gloved hand gripping the rail to close the 40px gap where the sleeve currently floats; give it a dark anodized PBR set with a 0.25-0.55 roughness map and an edge-wear mask instead of the flat greys and stucco bump; halve the front sight, add a rear aperture, and align the sight line to screen centre.
- [ads] Rebuild the viewmodel hand/arm mesh: kill the dither-alpha translucent quad with rectangular seams over the glove, unify UV texel density across adjacent facets, close the see-through gaps in the receiver, remove the emissive orange crescent inside the optic tube, and fix the lens so it transmits cleanly instead of ghosting a second copy of the scene.
- [vista] Rebuild the M4A1 viewmodel lower: replace the coplanar zero-thickness plates in the magazine well with a closed chamfered solid to kill the z-fighting, add a glass lens with a reticle to the optic instead of a flat black torus, author a parkerised-receiver / polymer-furniture roughness and normal set, and replace the fingerless camo cylinder with a rigged gloved hand gripping the handguard.

## lighting (impact 13.3)

- [firefight] Add contact shadows and fix the ambient colour. No object in the frame has a ground contact darkening - the two oil drums at (1600-1700,770-900) and (1790-1900,790-960) float, and all four enemies at x 1240-1520 cast nothing. Add per-character and per-prop blob or capsule shadows plus a screen-space contact-shadow trace, then tint the ambient/IBL term toward the sky (currently the shadowed pocket at (1640,560) returns warmer than the sky at (1000,30), which is backwards) so you get a warm key against a cool fill.
- [sunset] Rebuild the atmosphere. Fog currently uses the sky colour and starts almost at the player, so the midground and background merge into one cream field from approx x=1100 rightward and all material response beyond ~15m is erased. Move fog start well past the plaza, make density height-driven so haze pools low instead of covering vertical facades, and shift fog colour toward a cool violet as the view direction moves away from the sun so distance planes separate. This single change lifts composition, materials, and colour simultaneously.
- [sunset] Add every skinned character to the directional light's shadow-caster set and confirm cascade 0 covers 0-15m. Right now the friendly at approx (425,620) and both plaza figures cast nothing while nearby crates cast hard shadows, so all three read as sprites pasted onto the ground. With a horizon sun each should throw a long shadow toward camera plus a tight contact darkening under the boots.
- [plaza] Inject a one-frame muzzle-flash point light (radius ~6m, intensity ~3000, color 1.0/0.72/0.35) parented to the muzzle socket for every firing actor including AI, so the flash lights the shooter's arms and chest, the stall frame beside him, and the wall behind him. Add a screen-space bloom threshold low enough that the flash core actually blooms.
- [alley] Give the shaded alley a real indirect term and contact occlusion. Bake or SSGI a warm bounce off the sunlit right wall into the floor and the left brick wall, and add a 15-25cm-radius contact AO under every crate, drum and rubble pile. The foreground floor is presently a single constant ambient value (mean 0.113, standard deviation 0.033) with unshaded prop bases, which is what makes the props read as pasted on.
- [interior] Turn on shadow casting for props and lights. Every prop in the back room — chair, both tables, both rubble piles, the mattress — currently meets the floor with zero darkening and reads as pasted on; add a tight 0-8m shadow cascade plus a grounding AO decal per prop. Then make the two back-room windows real light sources so light pools on the floor beneath them and a shaft falls through the doorway onto the foreground planks, and make the hanging bulb emissive. The foreground room's left wall is presently a constant ambient value (mean 0.153, std 0.039) with no key light whatsoever.
- [ads] Add a real directional sun with a 6:1 or better key-to-fill ratio (warm key, cool sky fill), re-expose so lit facades sit near L=140 instead of L=54, and turn on cascaded shadow maps so buildings, barriers, and the roof soldier cast directional shadows. This single change fixes the flatness, the murk, and the collapsed depth separation simultaneously.
- [vista] Add GTAO plus a short-range screen-space contact-shadow trace (~0.15m) so every prop base darkens where it meets the deck — tank-stand legs, timber stack, manhole rings, crate bases — and add a sunlit-parapet bounce term so the shaded rooftop stops being one flat blue ambient value.

## postfx (impact 9.6)

- [firefight] Restore contrast and give the grade a split. Measured no-HUD centre: min 0.105, max 0.874, std 0.115 - no true black, no true highlight, no specular. Land the black point at/below 0.02 in shadowed pockets, let sun-facing plaster and muzzle flashes exceed 1.0 linear pre-tonemap so the tonemapper has something to roll off, cut the vignette from its current 33% corner falloff to about 12%, cool the shadow end of the grade (it is currently warmer than the sky), and add a subtle real grain - the frame currently has none, and the only fine detail in it is the particle hatch.
- [weapon] Cut the depth of field back hard: focus at the viewmodel plane and clamp far-field circle of confusion to under 1.5px inside 20m, starting the bokeh ramp only past the midground. Right now the brick wall at 3-4m and the entire plaza are smeared, which reads as a low-resolution render rather than a cinematic one and destroys every texture the material pass is producing.
- [plaza] Fix the frame-wide softness: raise render scale to native and cut the depth-of-field circle-of-confusion so the 1.5m-60m band resolves. Individual cobbles at 2m must be countable and the minaret masonry must be legible; only the viewmodel and the far plane should be soft.
- [interior] Fix the tonal range: only 0.23% of the frame exceeds 50% luminance and the whole-frame mean is 0.130, with the top 15% of the canvas (ceiling and lintel) pinned between RGB 11 and 27. Raise interior exposure about 1.5 stops, re-anchor the black point so the ceiling reaches true black instead of 6% mud, and add bloom/glare on the window openings so the exterior daylight reads brighter than the room. Right now there is no highlight anchor and no black anchor — the image is one narrow grey band.
- [ads] Regrade the tone curve — median luminance is 43/255 with no world pixel above 70 — lifting midtones and extending highlight headroom, and cut the DOF circle-of-confusion by ~70% with the focal plane on the ADS target so the enemy is not the blurriest object in an aiming frame.

## materials (impact 9.1)

- [sunset] Fix material assignment and tiling. The right-hand drum props are wearing a brick-and-mortar albedo wrapped around a cylinder, which means the masonry atlas is the fallback for unassigned meshes - audit for other fallback hits and assign real materials. Then kill the hard rectangular texture-patch seams on the back wall by blending stamps with a height-based mask, and break the cobble and plaster tiling with a large-scale albedo variation layer.
- [weapon] Strip the shared stipple normal map off the weapon and hard-surface props, and author a real two-material split for the gun — phosphate metal (albedo 0.04, metallic 1, roughness 0.28) versus polymer furniture (albedo 0.06, metallic 0, roughness 0.6) — driven by a curvature-based edge-wear mask so the receiver, magazine and stone barriers stop reading as the same cast-sandpaper surface. Enable mips and 16x anisotropic filtering on the arm camo, which is currently moireing into a halftone dither.
- [plaza] Break the stone-facade tiling on the right building: add a second detail-normal at a non-integer UV ratio (~3.7x), multiply a low-frequency macro-variation mask into albedo and roughness, and randomize per-segment UV offset so the repeating block layout and weather streaks stop phase-locking to the window bays. Also fix near-field texel density on the ground so the 0-3m cracked-earth material is the highest-resolution surface in frame, not the lowest.
- [alley] Reassign the right-hand wall material. It is currently sampling the cobblestone/river-rock ground albedo on a vertical face at ground texel density, with hard per-quad texture discontinuities and two stray vertical strips of the window/brick map running through it. Make it one worn-plaster UV island at ~2.5 px/cm, then give the alley floor real albedo and normal variation (it measures 0.033 standard deviation today, which is a flat untextured slab).
- [interior] Break up the floor: every plank is identical width, identical black gap, identical speckle streak in the identical orientation. Randomize per-plank UV offset and flip, vary widths +/-30%, bow and tilt a few, and replace the pure-black gaps with a dirt and AO mask. Same treatment for the left and right concrete walls, whose brick courses are zero-depth painted lines with no normal-map relief and no bevel highlight on the top edge of each course.
- [vista] Normalise texel density to ~512 texels/m across the level, generate full mip chains and enable 16x anisotropic filtering. This fixes three defects at once: the blurred left-building concrete, the shimmering aliased brick on the mid-right facade, and the window interior texture that is magnified until 8-pixel blocks are visible.

## level (impact 6.7)

- [sunset] Clean up broken and placeholder geometry: delete or re-anchor the inverted pyramid hanging point-down at approx (650,760), raise all cylinder props from 12 to 24+ radial segments with a 1-2cm chamfer so rims catch a specular line, give the awnings and hanging banners real thickness instead of single-sided zero-thickness planes, and inset the window meshes on the left facade so the openings have genuine reveal depth.
- [plaza] Recess every window and door opening 0.30-0.40m behind its facade plane with modeled reveals, a chamfered sill and a lintel, and place a dim lit interior volume behind each so the openings stop rendering as flat black quads. Apply to all six arched openings on the right and left buildings and to the minaret slots.
- [plaza] Break the procedural regularity in the plaza props: per-instance yaw jitter of +/-25 degrees and 0.9-1.15 scale variance on all crates and barrels, random UV offset per instance, two hand-placed damaged/toppled variants, and combat marks appropriate to an active firefight — bullet impact decals on the right facade, scorch, spilled produce, shell casings. Delete or retexture the flat near-white debris quads on the cobble; they have no thickness, no AO and no contact shadow.
- [plaza] Restage the shot: move the camera ~1.5m left and 0.4m up so the palm trunk falls on the left third instead of occluding the objective, and the awning edge drops below the firing enemy. Add exponential height fog keyed to sky color so the distant blocks behind the minaret lose ~35% contrast and the depth planes separate.
- [interior] Add depth to the composition: the top 15% of the frame is a featureless ceiling band and the deepest element is a wall about 8m away, so no atmospheric perspective can register. Dress the near walls with a foreground occluder (hanging cable, bent rebar, a collapsed beam), and either open a sightline past the back room to a fog-separated exterior plane or add a haze gradient across the doorway to sell the depth change.
- [ads] Give every window and door opening 200-300mm of modelled recess with real jamb faces, and add 2-3cm chamfers to parapets, barriers, and wall corners so edges read as highlight lines rather than value steps.

## vfx (impact 5.8)

- [firefight] Fix the smoke/dust particle system - it is the single most damaging thing in the frame. The lower-centre 45% of the image (roughly x 400-1400, y 550-1080) is a stack of enormous semi-transparent billboard quads with visible straight polygon boundaries, a diagonal cross-hatch alpha texture instead of an eroded smoke mask, and no per-card rotation variation (the hatch aligns identically across overlapping cards). Some cards brighten and some darken, so the blend mode or sort order is inconsistent. Do four things: cap card world radius to roughly 1.5m so no single card exceeds ~15% of screen width, enable soft-particle depth fade so cards stop cutting hard lines against the ground, replace the striped alpha with a genuine erosion/curl-noise smoke mask, and randomise per-particle rotation 0-360. Also cap total screen coverage so the system can never veil the whole midground.
- [firefight] Rebuild tracers and muzzle flashes. The tracer at (967-1037, 432-470) is a fat curved red capsule with a dark core and a black rim - it reads as a plastic croissant floating in midair, not a round in flight. Make it a thin additive streak (roughly 3px wide, 40-80px long) aligned to the actual velocity vector, warm-white core falling to orange, with a soft head glow. The muzzle flashes at (1250,545), (1350,545), (1475,545) and (785,545) are round cotton-ball puffs larger than the soldiers' torsos, clipped to flat white with no hue held in the core - swap to a directional multi-petal star sprite roughly one-third that size, keep a warm orange-white core through the tonemap, and pair each with a short-lived point light so the flash actually illuminates the shooter and the crates behind them.
- [sunset] Remove or redesign the two red arc shapes floating unattached in mid-air at approx (890,455) and (1000,435). They have grey outlines and a flat red core, no emissive falloff and no visible source, so they read as debug geometry or a direction indicator that was drawn in world space instead of screen space. If they are tracers they need a stretched billboard aligned to the flight path with an emissive core and a short lifetime.
- [interior] Redo the red arc near the crosshair. It is a hard-edged constant-width crescent ribbon with an opaque white core, rendered unlit, floating in space and emitting no light onto the wall or floor behind it — it reads as a debug spline. Make it additive with a soft radial falloff, taper the width along its length, fade opacity over lifetime, and attach a small point light so it illuminates the surfaces it passes.
- [ads] Replace the bullet-impact decals: shrink from ~28cm cream blobs to 4-8cm craters with a normal map and darkened core, clip them at geometry edges (one currently straddles the roofline into sky), and cluster them around cover rather than scattering uniformly.

## hud (impact 0.5)

- [plaza] Drop the killfeed's opaque grey plates for a soft horizontal gradient fade with no hard right edge, take weapon glyphs and the ammo '30' off pure white and full opacity (~0.85 alpha, slightly warm off-white), and redraw the minimap source so its footprints match the actual plaza — palms, stall canopies, the mosque dome — instead of a generic orthogonal city grid.
- [ads] Fade the HUD to ~30% opacity while ADS and add a scrim or drop shadow behind the ammo counter — HUD elements are currently the brightest pixels in the entire frame.

## ai (impact 0.5)

- [firefight] Rebuild the enemy squad presentation. Four identical soldiers stand fully upright, evenly spaced along one line, in the same pose, all firing on the same frame, in the open in front of cover they could be using. Vary height and body scale +/-8%, stagger their depth and spacing, put at least two into crouch/cover-lean states, desync their fire by 100-400ms, and give them varied idle upper-body poses so the group does not read as one mesh instanced four times.

## Blind judge regressions (what iteration 2 did better)

### ads

- Doorway depth: the recessed door on the right building reads correctly in A as a dark interior flanked by two lit jambs. In B that same opening fills with light and becomes a flat bright rectangle brighter than the surrounding wall, with a hard-edged shadow blob pasted across it — it reads as a poster or panel, not a hole. This is the clearest single thing B got worse.
- Shadow crush: ~30% of B's frame falls below 5% luminance (A: 0.6%). The near corrugated shutter on the left, the lower-left plaza floor, and most of the viewmodel go to featureless black. A keeps albedo readable everywhere.
- Viewmodel legibility: A resolves the optic body, rail slots, charging handle, receiver and handguard as distinct parts with readable form. B collapses the M4 to a near-flat silhouette with only two or three specular slivers, so the weapon's shape and material identity are largely lost — most shipped shooters give the viewmodel a dedicated fill light precisely to avoid this.
- Rooftop enemy readability: A's soldiers read as figures with limbs and a compact, restrained muzzle puff. The equivalent rooftop figures in B are pure-white bloom blobs with wide halos and no surviving silhouette. Some of this is flash timing, but the width of the halo and the fully clipped core point at bloom/emissive being too hot rather than just a different frame.
- Close-up concrete response: B's grazing sun on the right facade produces a dense, uniform field of tiny bright specks that reads as glitter or sequins rather than aggregate — the normal/specular response looks over-amplified. A's concrete is mushy and low-detail but at least reads as one continuous surface.
- Foreground/background cohesion: both frames share the same flat, contrastless pale-pink distant skyline. A's uniform flatness lets it blend in; B's high-contrast warm foreground exposes it as a painted backdrop card that never received the grade.
- Highlight discipline: A has zero clipped pixels (nothing above 98%). B blows out around the flashes and on the top-center facade, and much of the left and center collapses into a single warm orange band, reducing the hue separation between brick, plaster and hanging cloth that A still preserves.

### alley

- Weapon presentation: B's M4 is fully readable — dark polymer bands, machined gray receiver and rail, front sight block, optic ring, tan camo foregrip all distinct. In A the same weapon collapses into a near-black silhouette with a single oddly-lit warm patch on the foregrip. Shipped shooters light the viewmodel on a dedicated rig precisely so it never disappears; A's does.
- Shadow detail retention: B keeps information in the shadows (0.9% of pixels below code 8, 5% below 16). A crushes 54% below 8 and hard-clips 23% below 4 — over half of A's frame carries no recoverable detail at all. The entire lower-left cover stack, the floor, and the ceiling are a void.
- Grounding: B shows visible ambient occlusion and contact darkening under the crate pallet, the barrels, and the rubble piles, so props read as sitting on the floor. In A the contact zones are at code 0-4, so grounding cannot be read at all — objects merge into black rather than seat into the ground.
- Material response: B differentiates wood grain and plank gaps, brick and mortar, stone aggregate, cracked plaster, corrugated metal, and polymer vs. metal on the weapon. Outside the lit right-hand wall, A shows almost no material identity anywhere in the near field.
- Highlight handling: B's brightest values stop at 237, so the plaza opening and the far windows retain some structure. A blows the opening to a large featureless near-255 blob with heavy bloom.
- Threat readability: the soldier in the alley is legible as a figure in B; in A he is a black mass with only a lit shoulder and head edge. This is a lighting/exposure difference, not the enemy-position noise the brief asks me to ignore.
- Dappled sunlight reads as natural in B: the warm sun patches on the crate faces sit only ~8 code values above their surroundings and look like light through gaps. In A the identical patches (sampled srgb(53,34,17) against srgb(0,1,4) neighbors) become hard-edged isolated orange quads floating on pure black and read as light-leak artifacts rather than as light.
- Atmospheric depth: B's warm inscattering toward the plaza cleanly separates the near alley from the far street and gives a readable depth gradient. A conveys depth almost entirely through brightness contrast, which stops working once the near field clips to zero.
- Ceiling and overhead detail: B resolves the red-and-white striped awning fabric, the support beams, and the blue netting. In A that whole upper band dissolves into a single dark slab.
- Overall playability: B is a frame you could fight in as-is. A is a frame that would send a player to the brightness slider — a legitimate mark against it as a shipped gameplay capture, even though its underlying render is stronger.

### firefight

- Tonal range: A has a real black point and far more range (std 0.191 vs 0.124; 2.9% of pixels below 6% luminance vs 0.01% in B). B has essentially no shadows anywhere — the whole frame sits in a narrow milky midtone band, which reads as missing or broken tonemapping.
- Key light: A has an unmistakable sun — directional key, warm-to-cool split across surfaces, visible shafts and a defined source behind the market stalls. B has no discernible light direction; the scene is lit almost uniformly flat despite being a daylight exterior.
- Sky: A's sky is a clean saturated blue (patch R133/G156/B176). B's is a desaturated grey-violet (R136/G146/B168) that reads overcast and slightly wrong in hue, undercutting the sunny setting.
- Color: A holds noticeably more saturation overall (mean HSL sat 0.183 vs 0.135). B's foreground crates and ground carry an odd mauve/pink cast and the enemy uniforms drift toward khaki-grey instead of olive.
- Cast shadow on the top-right building: A shows a clear, well-defined awning shadow on the facade and a stronger lit/shadow split between the building's two faces. The same facade in B is much flatter with a weaker face-to-face contrast.
- Viewmodel opacity: A's weapon mass is opaque. B's is semi-transparent — the ground, crates and far building are clearly visible straight through it. That's a hard rendering bug A does not have.
- Character separation: A's enemies at least have a strong rim/backlight pushing them off the background. B's soldiers have no rim separation and sit into the haze behind them.
- Haze containment: A's heavy veil is confined to the left side, leaving the right half of the frame comparatively clear. B's veil covers the entire frame including the near foreground, so nothing anywhere is fully sharp.

### interior

- Material response on the weapon: B shows crisp specular glints on the rail pins, scope tube and charging handle and clearly separates dark gunmetal from the warm camo handguard. A's weapon is uniformly matte light-gray — receiver, rail, magazine and handguard all sit within ~10 levels of each other and of the concrete wall behind them, so nothing reads as metal.
- Directional lighting: B has a defined light pool on the far ochre wall with a bright warm rim along its left edge and visible falloff away from it. A floods the same wall nearly uniformly (mean 49, sd 9) with no shaft, no falloff and no readable light direction.
- Light-source believability across the space: in A the unlit near concrete (mean 50) is as bright as the sunlit far room (mean 49) — an ambient/fog flood with no differential between an interior and the lit room beyond it. B preserves a strong differential (15 vs 12 at its own exposure, and a much steeper gradient when normalized).
- Color separation: B has a warm ochre key against cool blue shadow and fill. A is near-monochrome gray-brown across the entire frame, including the weapon.
- Wall falloff: B's left wall has a pronounced left-to-right gradient consistent with an off-screen source. A's is almost uniform (mean 50, sd 11), which is the classic flat-ambient look.
- Black point and range span: B reaches true black (p1=0) while still holding a highlight at 244. A's darkest scene pixels sit at 9 and 99% of the image falls between 9 and 86 — lifted, milky shadows and no real contrast anywhere.
- Contact and occlusion darkening: B shows darkening at the door jamb, the wall/floor junction and beneath the weapon. A shows essentially no contact shadowing — nothing in the frame casts, so props read as pasted onto the floor rather than sitting on it.
- Concealment of a shared asset bug: both builds render the same broken viewmodel (z-fighting, intersecting translucent planes, exploded rail geometry). B's exposure largely hides it; A presents it bright, centered and unmissable, making A's weapon the single most obviously non-shipped element in either frame.
- Shadow grain: B carries a fine grain in the darks that reads as a film-grain pass; A is clean in a way that adds to its flat CG look. Minor, and the grain becomes objectionable if B's exposure is raised.

### plaza

- Weapon presentation: A's viewmodel is crushed to a near-black silhouette — rail slots, optic body, charging handle, magazine, and camo handguard are all lost. B renders the full hero asset with readable metal, plastic, and camo. A shipped FPS lights the viewmodel separately so it never goes fully black; A appears to have no viewmodel fill light.
- Shadow-detail retention: 13.3% of A's frame sits below 4% luminance versus 0.08% in B. A loses the base of the right stone wall, the market stall interior, and the left palm foliage into solid black; B keeps all of it readable.
- Enemy readability under the muzzle flash: in A the flash-lit soldier at right is blown into a featureless white/yellow blob with a large glow halo. This is flash intensity and bloom response, not particle timing — the same soldier at the same spot in B keeps a readable silhouette, camo, and weapon. A also blows a second soldier in the archway into pure darkness while B keeps him identifiable.
- Litter decals: A's pavement carries flat, vivid-blue quads that take no scene lighting — pure albedo sitting on the cobbles with no shading or contact, reading as broken decals. B's equivalent litter is neutral-toned and integrates with the ground.
- Frame-edge falloff: A applies a heavy corner darkening/vignette at the bottom and right edges that crushes those corners to black; B keeps the full frame legible.
- Thin-geometry aliasing: A's crisper resolve shows stair-stepping on the bunting wires and palm frond edges against the sky; B's softer resolve has none.

### sunset

- Weapon material legibility: B's M4A1 shows the receiver, rail slots, optic body, magazine, handguard texture and camo pattern clearly. A crushes large parts of the same weapon to near-flat black, and the top edge of the receiver/optic blows to a hard clipped white — you lose both ends of the gun's material read.
- Shadow-detail retention: the foreground objects on the right side of frame are stone/brick cylinders with visible masonry courses in B. In A they clip to flat near-black silhouettes with almost no texture, reading as untextured geometry rather than dark material.
- Noise/dither artifacts: A has visible high-frequency grain across the walls, the haze, and the sky — it looks like dithering or an undersampled volumetric. B's gradients are clean and smooth with no such speckle.
- Sun rendering: B resolves an actual sun disc with a defined shape and position. A's sun is an undifferentiated white blowout occupying a large wedge of the frame, so the light source has no form.
- Bloom restraint and mid-ground readability: A's glare veils the center of the image, swallowing the building edges, the awning, and the enemy figures. B keeps those legible — the two figures near center and the architecture behind them are far easier to pick out.
- Gameplay clarity: consequence of the above — a player would have a much easier time acquiring targets and reading cover placement in B.
- Sky gradient: B has a smoother, more coherent warm-to-pale falloff toward the horizon. A's upper sky is a fairly flat gray-white with a cool cast that sits slightly at odds with the warm sunset grade below it.
- Edge quality on thin geometry: A's hanging laundry shows harder aliased edges and a visible dot/moire pattern on the blue tarp weave. B's cloth edges and weave are cleaner.
- Left-building window legibility: the window recesses and frames on the sunlit left facade are better preserved in B; several are washed toward white in A.

### vista

- Weapon presentation: B's viewmodel is properly exposed and fully readable (region median 52/255) while A's is essentially a black silhouette (region median 12, 35% of it below 8/255). You cannot identify the receiver, optic or rail in A. A shipped FPS lights the viewmodel so the gun always reads; A fails that outright.
- Shadow detail / black clipping: A crushes 19% of the frame below 8/255 and 48% below 16. The entire left building, the rooftop floor and the near props collapse into one dark mass. B keeps detail everywhere (only 0.5% below 8) and never loses a surface.
- Shade color plausibility: A's shadowed roof samples at 0x08101A, roughly 3:1 blue-to-red, a stylized teal cast that reads closer to a night filter than to sky fill. B's shade (0x384149, about 1.3:1) is much closer to how real sky-lit shadow actually looks.
- Ambient/bounce level: under an open bright sky, a grey concrete wall in shade cannot be 3% of sky luminance. A's shaded wall reads 0x06090C against a 0xBCC7CA sky, which looks like a missing ambient or GI term. B's equivalent wall (0x232629 to 0x62615C) sits at a physically sensible fraction of the sunlit values.
- Material response in shade: in B brick, rusted steel, timber pallets and corrugated roofing all read as distinct materials. In A everything in shadow flattens to the same blue-grey, so the concrete blocks, the brick parapet and the sandbags become indistinguishable.
- Best single material in either frame is B's rusted water tank: convincing pitting, oxide variation and edge wear. A has nothing comparable because its equivalent props are in darkness.
- Sky quality: B's sky is a cleaner blue-to-warm gradient. A's upper sky is a washed pale grey-cyan (0xBCC7CA) and its bloom veils more of the midground silhouette detail near the horizon.
- Readable play space: B's rooftop shows slab seams, drain, surface grain and a legible large-scale value break, so the player can read the geometry they would move through. A's foreground is one undifferentiated dark plane.
- Highlight discipline: A pushes about 1% of pixels above 240 with heavy bloom around the sun; B tops out gently at 0.94 with no clipped highlights.
- A has a local artifact B does not: a bright yellow-green patch on the weapon handguard that reads as an unlit or emissive error against an otherwise black gun. B's handguard camo reads as normal painted fabric.

### weapon

- Weapon presentation is much worse in B and this is the most serious issue. The viewmodel crushes to near-solid black across the receiver, stock, magazine and optic — the whole lower-right quadrant is an unreadable dark mass with only a faint rim on the barrel and the lit camo foregrip separating it from the crates behind it. Shipped shooters almost universally give the first-person weapon its own fill/viewmodel light precisely so it never silhouettes out when the player walks into shade. A's weapon is over-flat, but every part of it is legible: rail, ejection port, mag well, optic housing and suppressor all read.
- General black crush / lost shadow detail in B. The large gate on the left third is a flat black cutout with no internal texture, panel lines or mortar visible; the crates at lower right and the foreground paving in the bottom sixth similarly go to noise-free black. A holds texture and normal-map detail everywhere in those same regions.
- Highlight clipping in B. The streak along the top-left roofline blows to pure white with a hard edge and no roll-off, reading more like a specular seam or lighting artifact than a sunlit surface. A has no clipped highlights anywhere.
- Character readability in B is degraded — the rooftop figures render as blown-out white blobs where A shows readable soldier silhouettes with distinguishable uniform, weapon and posture. Part of this is muzzle-flash timing and should be discounted, but the extent of the blowout beyond the flash suggests bloom is spreading with too little headroom, and that is a real legibility cost.
- Mid-frame haze in B washes over the plaza doorway and market stalls with a milky glare that softens the objective area; A keeps that mid-ground crisp and easy to scan.
- Scene legibility overall favors A. Because A is uniformly lit, the whole space — wall, gate, barriers, distant market, cover positions — is readable at a glance. B's contrast means a meaningful fraction of the playable space sits in shade the player cannot resolve detail in.
- Debris/particle sheets read as distinct paper-like fragments with visible form and shading in A; in B several become bright white specks that read more like dust artifacts than geometry.
