# Critique round 2 — results and the overcorrection

## Blind A/B: iteration 2 beat iteration 1, 8/8, all at high confidence

Judges saw the two frames as A and B with the assignment randomised per pose
and the key withheld. Iteration 2 won every pose. The direction of travel is
right and the round-1 fixes were real.

## But the absolute score barely moved: 3.00 -> 3.56 / 10

Axis means, worst first: Material response 3.00 - Geometry 3.00 -
Weapon and HUD 3.13 - Lighting 3.25 - Post-processing 3.25 -
Storytelling 3.63 - Composition 4.38.

## The blind judges flagged 46 regressions. They cluster into one story.

**Round 1 said "washed out and low contrast". Round 2 overcorrected into
crushed.** This is the most important finding of the round, and it was only
visible because the blind judges were asked what the LOSING image did better.

- **Shadow crush - 18 mentions.** Large regions block up to featureless
  near-black. Walls become "an almost featureless dark mass"; the alley loses
  the brick coursing, lumber stacks and banners that were readable before.
  Material information is destroyed wholesale in shadow.
- **Weapon under-exposed - 5 mentions.** The rifle is "nearly a black
  silhouette", with rail, optic housing and front sight merging into one mass.
  Judges twice named the fix unprompted: shipped FPS games use a dedicated
  viewmodel fill/rim light so the gun stays identifiable in deep shade.
- **Highlight clipping - 6 mentions.** Backlit soldiers "clip to near-pure
  white mannequin shapes with no rim separation, uniform detail or gear
  silhouette".
- **Aerial perspective lost - 7 mentions.** Fog density was halved and distance
  no longer separates: "far-right skyline stays a washed pink that doesn't
  match the warm, contrasty foreground", "far buildings look pasted on".

## The lesson for this round

Contrast is not the goal; **tonal range with detail retained at both ends** is.
A shipped frame has a true black point AND readable texture in shadow, a bright
highlight AND unclipped detail inside it. Do not fix the crush by flattening
the image back toward round 1 — that just re-runs the mistake in the other
direction. Shape the curve instead.


## lighting (impact 9.9)

- [interior] Make the windows actually light the room and add contact occlusion. Attach area/portal lights to both window apertures so a defined light pool falls on the plank floor (floor under the window is currently srgb(2,7,13) vs srgb(1,4,8) 4m away — no contribution at all), add a low-intensity bounce probe so the near room stops being a black void, and add a 20-40cm-radius contact AO term at wall/floor junctions and under the crate stack, which currently floats with no contact darkening.
- [vista] Add AO and a real ambient term: enable SSAO plus a contact-shadow pass so every block, sandbag, wall and prop darkens at its ground junction, and swap the flat blue ambient constant for a sky-irradiance term with a lifted floor. Target: unlit plaza stone at 10-12% luma with visible bounce off the sunlit right wall, instead of the current 30% of the frame crushed below 4%. This single change fixes the pasted-on look on every object in the plaza at once.
- [plaza] Add ambient occlusion and short-range contact shadows. Nothing in the frame is grounded: the basket, crates and cloth bundles on the stall deck around (500-800, 590-620), the awning post bases, the grass tufts in the cobble joints, the sphere at (665,518) and the base of the right-hand wall at (1300,690) all meet their surfaces with zero crevice darkening. Add an SSAO/GTAO pass (roughly 0.5m radius, 0.8 intensity, indirect only) plus a screen-space contact-shadow trace off the sun direction, and tint the ambient with a sky/ground hemisphere so the shadow side stops being one flat value.
- [weapon] Give the viewmodel a dedicated light rig that ignores world shadow casting. The weapon currently measures 0.029 mean luminance against 0.90 on the rooftop enemies — five stops apart in a single frame — so the entire gun is one black silhouette. Add a camera-space key light at roughly 45 degrees up-left, a cool sky-coloured rim along the top of the receiver and barrel, and an ambient floor, targeting 0.18-0.35 mean on the receiver so the rail, optic housing, magazine and stock separate as distinct parts. This is the single largest area of the frame and the named subject of the pose.
- [weapon] Add ambient occlusion at every contact point. There is currently none anywhere: sandbag undersides match their tops in value, the green ammo crates have no darkening where they meet the ground, and the concrete barrier mid-left has no gradient at its base. Enable SSAO at roughly a 0.5m world radius, add a short-range contact-shadow trace for small props, and bake AO into the sandbag and crate textures. This is the cheapest fix that improves every square inch of the environment at once.
- [alley] Restore ambient and indirect fill. Raise sky/IBL ambient so shadowed surfaces sit at 0.10-0.18 linear instead of 0.02, and add a warm fill light aimed back down the alley from the plaza aperture to fake the bounce off the sunlit yellow wall. 68% of the frame is currently below 5% luminance - the crate wood grain, plaster relief, corrugated roofing and pebble ground detail all already exist in the scene and are simply invisible. This one change recovers material, geometry and storytelling detail simultaneously.
- [ads] Add SSAO (≈0.4m radius) plus screen-space contact shadows along the sun vector so the bucket, brick pile, barrier and crate stack stop looking pasted onto the cobblestone, and add a sky-colour indirect fill term to shadowed surfaces so the left wall and lower-right ground carry cool bounce instead of collapsing to a flat multiply.

## postfx (impact 9.4)

- [firefight] Kill the full-screen radial ghosting. Every edge in the frame is smeared into 6–10 duplicates fanning from ~(900,200) and a milky additive veil covers the left 60%. Stop running the light-shaft/radial-blur pass over the full lit colour buffer: build a quarter-res occlusion mask from depth (sun disc luminance only, everything else black), clamp the sample radius to ≤0.05 of screen height, composite additively at ≤0.25 weight, and confirm the history/accumulation buffer is cleared every frame. Then raise the tonemap white point — peak RGB in the whole image is 234/238/232 and the 99.9th percentile is 212, so no specular anywhere reaches white.
- [interior] Re-expose and tone map the frame. The entire environment currently spans 0-39/255 (median 5/255, 86% of pixels under 16/255); the key-lit orange wall must land at 140-170/255 and near-room ambient floor at 25-40/255. Replace the exposure multiply with a filmic curve (ACES or AgX) that has a lifted toe (black point ~0.02) so shadow detail survives, cut film grain to ~2% amplitude (it currently exceeds the signal across most of the frame), and dither before the 8-bit write to kill the horizontal banding visible in the rear wall.
- [vista] Tame the atmospheric pass: cut light-shaft density by about two thirds so the midground keeps 20-30% contrast through it, add blue-noise dithering to remove the sky banding, soften the hard boundary where the shaft cuts off against the right building, lift the tone-curve toe off zero, and add an AA resolve so power lines and weapon edges stop stair-stepping.
- [weapon] Kill the flat fog card blocking the alley passage. Behind the market stall there is a uniform ~0.55 luminance quad with a hard straight top edge and a hard vertical right edge that erases the deepest read in the frame. Drive height fog from scene depth with exponential falloff, or reduce the light-shaft volume's density by around 70% and feather its boundaries, so the far end of the alley still resolves as receding geometry rather than a grey rectangle.
- [alley] Add a filmic shadow toe so the black point lands at 0.03-0.06 sRGB rather than zero, re-expose roughly +1.5 to +2 stops (highlights peak at 0.949, so the shoulder has headroom), and make film grain monochrome and luminance-weighted - it is currently per-channel at 43% of signal in dark regions, producing blue/magenta chroma speckle across every shadowed surface.
- [ads] Rebuild the tone curve to stop clipping at both ends: lift the toe so the 22.8% of pixels currently below 0.04 luma retain structure, pull the shoulder so the rooftop fire and the enemy at (1330,140) hold orange/skin hue instead of flattening to 255 white, neutralise the red-tinted vignette (bottom-centre currently 14,4,9) and roughly halve its strength, and scale film grain by luminance so it stops roaring in the black weapon.
- [sunset] Replace the tone curve with a hue-preserving filmic fit (AgX or an ACES variant with a highlight hue path) and drop exposure ~0.7 EV. The sun core at (960,430) is currently R 0.987 / G 0.972 / B 0.960 — neutral white on a sunset frame — with 3.0% of all pixels at or above 0.99. Highlights must desaturate toward amber, not toward paper. In the same pass cut fog density roughly in half and make it height-based and sun-tinted so the 40 m wall (0.42) and the 150 m rooftops (0.63) stop collapsing into the sky, and denoise or temporally accumulate the blotchy SSAO/dither speckle visible across the left wall at (150-500, 300-600).

## weapons (impact 9.0)

- [firefight] Light the viewmodel with its own rig. The weapon body measures mean luminance 21 with standard deviation 5 while the scene median is 99 — it is a featureless black hole over the lower-centre third of the frame. Add a view-space three-light setup (warm key upper-left, cool rim upper-right at ~0.4, ambient fill 0.15), exclude the viewmodel from world fog and auto-exposure, and floor its shadow term at 0.12. Then rebuild the sight: the two floating red crescents at (965,445) and (1010,620) need to be attached to visible front and rear posts aligned to screen centre.
- [interior] De-blue and rebuild the viewmodel. Receiver/barrel/rail pixels read srgb(7,10,21) and srgb(1,6,15) — blue is 2-3x red, so the blue chrome was darkened, not fixed. Set metal base colour to neutral gunmetal, add a dedicated viewmodel rim and fill light so the silhouette separates from the black background, then replace the torus-plus-cylinder-nubs optic with a real tube (recessed lens, emissive reticle), chamfer the identical un-bevelled rail cubes, and delete the cluster of intersecting flat plates under the receiver that reads as broken geometry.
- [vista] Rebuild the M4A1 viewmodel: merge the receiver into one watertight mesh to kill the intersecting boxes and z-fight shards, replace the flat grey slab magazine with a correctly shaped curved mag in the same dark metal material, add gloved hands and forearms so the weapon is held, and give the viewmodel a dedicated fill light plus sun rim so it sits at 15-25% luma. Right now the single most-looked-at object in the frame is unreadable black geometry soup.
- [plaza] Rebuild the viewmodel so it reads as a weapon rather than a hole in the frame. Three concrete steps: (1) model gloved hands — the left forearm currently ends in a flat cap at ~(1180,690) with nothing gripping the gun; (2) raise the weapon albedo off near-black (its dominant pixels are #000105-#020408) to a ~0.05 linear polymer/parkerised value and add a dedicated viewmodel fill light plus a rim keyed to the sun so the rail, optic body, magazine and ejection port resolve; (3) fix the coplanar interpenetrating boxes around (1250-1400, 700-850) and chamfer the hard 90-degree edges on the receiver and sight ring.
- [weapon] Rebuild the M4A1 viewmodel as a single welded mesh. Boosted inspection shows a slab passing straight through the receiver, a hatched z-fight band across the magwell from coincident faces, a flat grey noise-normal plate floating where the right hand should be, and an orphan cylinder connecting to nothing. Weld the hands to real grip and handguard sockets, chamfer the receiver and rail edges so they catch the new key light, and remove all coincident geometry. Without this, fixing the exposure only makes the broken construction visible.
- [alley] Give the viewmodel its own lighting rig decoupled from scene exposure: key from upper-left plus a rim driven by the forward plaza backlight, targeting sRGB 70-110 on the shadowed receiver. Add a specular rim along the top rail, barrel and optic tube. The entire lower-right quadrant is currently an unreadable black mass with one camo patch, and a backlit weapon with no edge highlight is physically wrong.
- [ads] Make the viewmodel readable: dedicated viewmodel light rig at ~+1.5 EV over world with a sun-vector rim light, 1-2mm chamfers on every hard edge so the low sun draws specular lines along the receiver and handguard, higher segment count on the optic tube, and delete the stray black triangle at ~(1120,790). Also add the missing charging handle, ejection port and selector — at 5x boost the gun has one stamped dimple pattern and nothing else.
- [sunset] Light and reframe the viewmodel. The receiver at (1100,700) sits at 0.166 mean against a 0.89 sky and reads as a featureless black mass filling the lower-right third. Add a dedicated viewmodel light rig — fill from camera-right plus a sun-side rim — and a separate viewmodel exposure so the receiver lands at 0.32-0.45 with the shadow side near 0.12, making the rail, ejection port, charging handle and mag well readable. Then pull the pose in: reduce viewmodel FOV/scale so the receiver stops running off the bottom edge, reduce the roll, and fix the optic riser interpenetrating the handguard and the floating plate under the receiver.

## materials (impact 7.6)

- [firefight] Give enemy characters real shaded materials. The three figures at x≈1270–1430 measure mean 185 with standard deviation 10 across an entire body — flat, unlit, near-white cards. They are almost certainly on an unlit/basic material or missing normals, and they are excluded from the shadow sets. Swap to a lit PBR material with a dark fatigue albedo (0.10–0.18, not 0.72), add a normal map and a roughness map, register them as shadow casters and receivers on the sun light, and add a capsule contact shadow at the feet so they stop floating above the crate row.
- [vista] Break the texture repeat: drive per-instance UV scale, rotation and hue/value jitter from an instance attribute so the same brick does not tile identically across both the 6m building and the 1m parapet, layer a large-scale macro-variation multiply over the albedo, and clamp all albedo to 0.03-0.85 to kill the pure-white stall canopy.
- [plaza] Stop the enemy soldier at (1190,560) rendering as a clipped white silhouette. He is at or near 1.0 in all channels across helmet, face, vest and rifle with a bloom halo, while a second soldier at (1055,545) at effectively the same depth and same light renders correctly. Audit the character material for an emissive term, an unlit/basic material fallback, or a per-character point light left at a huge intensity — then clamp the character shader to the same lit PBR path as the rest of the scene and verify both soldiers land in the same exposure band. This is the single worst defect in the frame: the thing the player is meant to aim at is the one object with no shape, no colour and no readable silhouette.
- [plaza] Break the single tiling checker/waffle fabric texture that is reused at identical on-screen scale across the red/white awning (200-900, 400-490), the blue tarp (500-900, 505-660), the small stall canopy (1050-1130, 500-560) and the player's own sleeve. Give each cloth a world-unit UV scale targeting ~512 px/m, overlay a low-frequency mottle to break the repeat, and move the weave into the normal/roughness channels instead of albedo. Also replace the untextured faceted sphere prop at (665,518) and the pebbled gravel normal map currently on the weapon receiver.
- [weapon] Fix the enemy character material. Both rooftop soldiers render as pure-white clipping mannequins (mean 0.896 and 0.781, pixels at 1.0) while backlit against a darker sky, which is a physical impossibility and the loudest amateur tell in the frame. Set albedo to a desaturated olive/tan in the 0.10-0.20 range, add plate-carrier and webbing albedo breakup, set roughness near 0.7, and clamp their radiance below the bloom threshold so backlit figures resolve as dark silhouettes with a warm sun rim.
- [alley] Break up the left crate stack: randomise yaw +/-15 degrees, add three or four mesh variants including a broken and an open crate, tilt one off the pile, and drive per-instance albedo tint and roughness. Chamfer the crate silhouette edges by 1-2cm so they catch a highlight. Replace the pure-black flat graffiti shapes on the right plaster wall with real decals (albedo 0.04-0.08, spray-edge alpha noise, roughness delta) and add bullet-impact, scorch and water-stain decals to that wall.
- [sunset] Stop the enemy soldiers rendering as clipped white ghosts. The figure at (1160,555) measures 0.980 mean luma with pixels at 1.000 and the one at (1035,570) at 0.765 — brighter than the wall behind them. Clamp character base colour to 0.10-0.35 sRGB, remove any emissive contribution, confirm the character material runs through the same tone-map pass as the world (a basic/unlit or post-tonemap forward pass gives exactly this signature), and verify it samples the shadow map. Target: backlit enemies read as dark silhouettes with a warm sun rim, around 0.15-0.30 luma against the 0.85 sky.

## level (impact 2.7)

- [vista] Give building openings and edges genuine depth: inset every window 200mm with modelled reveal, sill and lintel and a dark interior box, cap the right-hand brick building with a roof plane and a 300mm parapet with a return face so it stops being a zero-thickness card, and chamfer barrier blocks and parapet caps 15-25mm to catch the backlight.
- [vista] Scatter and jitter the props: +/-8 degree yaw and +/-6% scale variation per sandbag instance with per-instance dirt tint, 30-50 debris and litter props through the plaza on a Poisson-disc distribution, and decal passes for impact craters, soot and drip streaks. Delete or attach the unmotivated red arc floating in the sky at x=940,y=440.
- [plaza] Cut real recessed openings into the buildings. The three arched windows at (560-810, 290-395) and the row at (370-830, 440-510) on the tan facade are flat black quads coplanar with the wall, filled with a grey smoke smear. Inset each opening 25-30cm, add sill and lintel geometry with a 2-3cm chamfer, and place a dark interior volume behind it with a small ambient value. Same treatment for the arches on the right-hand stone wall at (1280-1440, 300-360). While in the level, chamfer the minaret's box stack at (960-1090, 130-560) and give the dome at (890-990, 260-350) ribs or tiling so its silhouette stops reading as a low-poly hemisphere.
- [weapon] Break up the procedural regularity in the sandbag and crate placement. Every sandbag is an identical clone on a perfect grid and every crate stack is axis-aligned. Apply per-instance yaw jitter of plus or minus 15 degrees, non-uniform scale jitter of plus or minus 10%, vertical settle variation, two or three burst or spilled bags, and one row knocked out of alignment. Also cluster the bullet-pock decals on the right building around the window opening and corner instead of scattering them at even density.

## ai (impact 0.8)

- [alley] Fix character rendering. The mid-alley enemy is a stack of disconnected rectangular boxes floating above the stone barrier with no legs; the NPC under the crosshair is a featureless matte-black capsule with one lit skin patch. Use a jointed humanoid mesh with connected limbs and ground contact, clamp character albedo to a floor of 0.06-0.12 (never 0.0) for dark fabric, and add a rim-light pass keyed off the sun so silhouettes separate against the bright aperture.

## vfx (impact 0.7)

- [ads] Replace the tracer at x≈1345 with a real one: short segment (8-15m) rather than a full-screen rod, width tapering toward the far end, opacity falling off with distance and age, spawned from the muzzle so it converges toward the reticle instead of running dead vertical, with an impact spark and a muzzle flash at the near end. Clamp its emissive so bloom halos it rather than clipping the core to white.

## hud (impact 0.5)

- [vista] Take the HUD off pure white: drop the ammo counter, compass ribbon and objective text to ~0.85 alpha off-white with a soft dark scrim or drop shadow, and normalise the killfeed rows to one width and one scrim opacity (the middle row currently has a stray green edge bar).

## Full regression list from the blind judges


### ads

- Shadow detail: A never blocks up, while B crushes large areas to near-black. B's left-hand tiled wall becomes an almost featureless dark mass, and the lower half of the weapon (receiver, magazine, handguard) loses most of its form to the shadow. A keeps that geometry readable throughout.
- Mid-to-far background legibility: A resolves the full depth of the street — awnings, hanging banners, the far plaza, and the rooftop structures all read. In B the area just behind and around the sight collapses into a flat, pale, low-detail panel, and the distant buildings behind it lose nearly all texture.
- Depth consistency: A's haze is applied evenly with distance, so near/mid/far separate cleanly. In B the far-right skyline stays a washed pink that doesn't match the warm, contrasty foreground, reading as a separate layer rather than the same atmosphere.
- B has a diffuse warm-red glow smeared across the lower-left ground with no visible source in frame; A's ground is free of unexplained color casts.
- B's tracer is a hard-edged stripe of nearly uniform width and brightness with no bloom, taper, or falloff along its length — it reads more like a solid rod than a round. A has no equivalent hard-edged element. (Noted with the caveat that whether a tracer is present at all is timing, not quality.)

### alley

- Scene legibility: B shows the whole alley clearly — the flag overhead, brick coursing, the lumber stacks, the boarded storefront, the banners strung across the street. A crushes most of the left half and the foreground into near-black, so a player would struggle to read cover and navigable space in the near field.
- Viewmodel readability: B's rifle is fully readable — receiver, rail, optic and magwell all distinguishable. A's weapon is close to a pure silhouette; shipped FPS games almost always add a dedicated viewmodel fill/rim light so the gun stays identifiable even in deep shade, and A doesn't quite do that.
- Midtone texture detail survives in B: the plaster pitting on the right wall, the wood grain on the planks, and the individual stones in the rubble all hold form. A loses that detail wholesale to shadow, so parts of the frame carry no material information at all.
- B has no hard geometry/lighting seams. A has a suspicious solid black band across the ceiling/overhang and a hard rectangular shadow edge on the right wall that look more like a lightmap or geometry seam than a real cast shadow.
- B's debris particles are absent/subtle; A's floating leaf-debris sprites are lit far brighter than their surroundings and read as flat white cutouts against the black, which is its own artifact.
- B's HUD sits on a consistently lit background; in A the white HUD text and minimap float against near-black and the contrast is harsher than a shipped game would typically allow.

### firefight

- Weapon presentation: A still shows a readable first-person viewmodel (gloved hands/handguard) at lower right; in B the entire lower-center foreground is swallowed by a near-black plume and no weapon or hands are discernible at all.
- Smoke shading: B's dark plume crushes to near-black (frame minimum ~0.008) and is flat inside — no scattering, no self-shadow gradient, no light bleeding through from the sun behind it. A's smoke is far too opaque, but it does pick up scene light and reads as a lit volume rather than a hole in the image.
- Particle blending artifacts: B shows hard billboard edges — a straight vertical seam down the left wall and sharply terminated diagonal streak quads over the masonry — which is a visible tell that the smoke is camera-facing cards. A's haze blends smoothly with no visible card boundaries.
- Character readability under bloom: B's three backlit figures clip to near-pure white mannequin shapes with no rim separation, uniform detail or gear silhouette; A's soldier on the right retains helmet, vest and uniform hue even through the haze.
- Minimap terrain: A's minimap uses color to separate buildings, streets and open ground, which parses faster than B's near-uniform monochrome plate (B's frame styling, scale bar and radar sweep are otherwise the better HUD).

### interior

- Exposure and readability: B is actually playable. A is crushed to near-black over 83% of the frame, with only 0.18% of pixels above mid-gray — the right half of the image is unreadable mush and the player's own weapon is barely locatable.
- Tonal range: B spans a usable histogram (std 0.124) while A has almost none (std 0.056). A has no highlight structure anywhere outside the small doorway rectangle, so the image has no upper register at all.
- Scene legibility: B clearly shows the level content — plaster peel and brick coursing on the near wall, the tiled floor, and back-room props (chair, workbench, hanging bulb, stacked block wall) that are completely invisible in A. A player can read the space and plan a route in B; in A they cannot.
- Weapon silhouette readability: despite its broken material, B's viewmodel reads as a recognizable rifle with a legible optic, handguard, and grip. A's weapon is a black mass identifiable only by a few specular flecks — poor for a frame where the gun is the player's primary anchor.
- Focus and depth: B shows deliberate depth-of-field, with the near wall softened and the mid-distance doorway sharp, which gives some photographic separation. A shows no focus falloff — everything is uniformly sharp where it's visible at all.
- Floor material response: B's tile shows sheen and grout definition across the near floor, indicating some specular model is running. A's near floor is entirely black, so no material behavior is demonstrated there at all.
- HUD integration: B's minimap and killfeed sit legibly against the scene. In A the minimap is so dark it nearly vanishes into the wall behind it, which reads as a bug in its own right.

### plaza

- Shadow detail is crushed in B. Large regions go to near-black with nothing readable — the left palm foliage becomes a dark clump, the shadow side of the right stone wall loses its brick detail, and the deep corners of the arcade are solid. A retains detail everywhere, even if at the cost of looking flat.
- Weapon readability is worse in B. Even though B's gun is tonally more believable, it is nearly a black silhouette — the rail, optic housing, and front sight merge into one mass. A's weapon, wrong-colored as it is, at least shows its full geometry and optic clearly. Most shipped FPS games use a dedicated viewmodel fill light so the gun never goes this dark.
- A has more atmospheric perspective. Its haze gives some depth separation between the mid-ground stalls and the far minaret. B has essentially no aerial perspective, so distant geometry sits at nearly the same contrast as near geometry and the far buildings look a bit pasted on.
- A's mid-ground clutter is more legible — the market stall goods, the awning stripes, and the second stall on the right are all easier to parse, which helps the plaza feel inhabited. B's contrast swallows several of those props into shadow.
- B exposes flat, untextured props that A's low contrast conceals: the saturated blue tarp on the stall and the flat blue quads lying on the cobblestone read as unlit cards with no grounding or surface variation. The same assets are far less conspicuous in A.
- Highlight rolloff on B's sunlit minaret and upper plaster is slightly hot and approaching clip, where A never clips those surfaces.

### sunset

- Viewmodel readability: B's rifle is crushed almost entirely to black silhouette with no fill light, so its mechanical detail is lost. A's weapon is fully legible — rail, optic, magazine, handguard all readable. Shipped FPS games light the viewmodel separately for exactly this reason, so B's backlighting is currently over-committed.
- Target visibility: the sun hotspot in B blows out a large area right around the crosshair and the mid-ground contacts nearly vanish into it. A keeps figures separated from the background (though A does it via an unrelated fault — the characters glow like emissive blobs).
- Image noise: B has visible fine grain / dither speckle across wall plaster and mid-tone surfaces, most obvious on the large facade. A's surfaces are clean of that artifact (at the cost of being blurry).
- Color variety: A carries a wider hue range — cool stone, blue awnings and panels, warm lumber — which helps distinguish one material from another. B is close to monochrome amber and loses some of that material separation.
- Texture tiling: B's left-hand brick wall shows a visibly repeating brick pattern. A's softer, blurrier walls hide any tiling.
- HUD legibility: A's minimap has stronger contrast and colored contact markers. B's minimap is desaturated and washed out, harder to parse at a glance.
- Foreground grounding: some of B's crates read as hovering — the center tan crate and the dark crate to its right have no clear contact shadow tying them to the cobbles, which is more noticeable in B precisely because its shadows are otherwise crisp.

### vista

- Shadow detail retention: B keeps readable texture, plaster damage and window-frame geometry on the left building's shaded facade, where A crushes much of that same surface toward black and loses information.
- Weapon readability: despite its bad specular, B's weapon reads as distinct parts (magazine, rail segments, optic body, charging handle); A's weapon is nearly a single black mass with only the camo handguard legible, so the viewmodel silhouette is less informative.
- Atmospheric consistency: B's haze falls off evenly with distance and reads as uniform air, while A's is concentrated into a localized bright plume near the sun that smears over midground geometry and partly hides the plaza edge.
- Midground legibility: distant structures, the far wall and the rooftop objects past the parapet are easier to parse in B; in A several of them are swallowed by either the bloom plume or the shadow.
- Minimap: B's minimap carries color separation (tan blocks, red contacts) and is easier to read at a glance; A's is a low-contrast grey wash.

### weapon

- Weapon readability: B's viewmodel is fully legible — receiver, rail, optic housing, stock and grip all separate clearly. A crushes the rifle to a near-black silhouette; the optic and rear of the weapon lose almost all shape and material information. A shipped game would carry a rim or fill light on the viewmodel so it never goes that flat.
- Shadow detail retention: A clips large areas to pure black — the metal gate on the left wall and the lower-left cobblestones are a featureless void with no recoverable texture. B keeps detail everywhere in the frame, so the gate, the alley floor and the recessed doorways all still read as surfaces.
- Mid-distance legibility: down the alley B shows more usable structure — the far market stalls, the hanging banners, the scaffolding on the right and the sandbag line all stay readable. In A that whole left half and much of the distance is swallowed by shadow, which would hurt target acquisition even if it looks more cinematic.
- Particle sprites: the white flake/bokeh sprites are far more conspicuous in A, where they sit as bright blobs against dark brick and read as obvious billboards. In B they blend into the brighter surroundings and are much less distracting.
- Highlight handling: A's fire/light sources at the top of the frame blow out to hard white clipped cores with fairly crude bloom. B's equivalent highlights roll off more gently and do not clip as aggressively.
