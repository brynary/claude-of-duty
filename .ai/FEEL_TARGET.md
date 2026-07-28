# Feel Target: Measured Numbers from Modern Call of Duty

Reference data for tuning a three.js FPS against measured targets instead of adjectives.

Compiled 2026-07-28.

---

## How to read this document

Every number carries a confidence marker:

| Marker | Meaning |
| --- | --- |
| `[stated]` | From a developer, official patch notes, or a shipped engine config file. Highest confidence. |
| `[measured]` | Datamined from game files, or frame-counted / high-FPS-tested by the community. Reliable but second-hand. |
| `[estimated]` | My inference from related data. The derivation is always shown. Treat as a starting point, not a fact. |

**Two eras, two data sources.** Modern Call of Duty (MW2019 → BO6) ships almost no engine internals, but Activision publishes unusually detailed patch notes with exact millisecond and metre values. Classic Call of Duty (CoD4 / World at War / Black Ops, 2007–2010) shipped mod tools, so its complete engine constants and weapon files are public. Where a modern number does not exist, the classic engine constant is given instead and labelled as such. The classic values are the origin of the series' feel and most of them were never fundamentally re-tuned.

**Unit conversion.** The Call of Duty engine uses inches as its world unit.

> 1 unit = 1 inch = 0.0254 m. "500 meters is about 20000 units."
> — [CoD Modding & Mapping Wiki, *Call of Duty 5: Gameplay standards*](https://wiki.zeroy.com/index.php?title=Call_of_Duty_5:_Gameplay_standards) `[stated]`

Every metre figure derived from a unit figure in this document uses that factor. Modern titles state metres and milliseconds directly in patch notes, so no conversion is needed there.

---

## 1. Summary: the highest-value targets

If you tune only ten things, tune these.

| Quantity | Target | Confidence | Source |
| --- | --- | --- | --- |
| Player health | **100 HP** | `[stated]` | Engine dvar `scr_player_maxhealth "100"`; BO6, MWII, MW2019 all 100. MWIII is the outlier at 150. |
| Time to kill, close range | **200–300 ms** | `[measured]` | MW2019 tops out just under 200 ms; BO6 SMGs 220–288 ms; MWIII ARs just over 300 ms. |
| Shots to kill, primary weapon | **4–5** | `[stated]` | BO6 XM4 = 23 dmg × 5; CoD4 AK-47 = 40 dmg × 3 close / 4 far. |
| Assault rifle fire rate | **700–810 RPM** | `[measured]` | CoD4 AK-47 706 RPM; BO6 XM4 ≈ 810 RPM derived from stated TTK. |
| ADS time, assault rifle | **225–260 ms** | `[stated]` | MWIII FR 5.56 240→260 ms; BO6 GPR 91 225 ms. |
| Sprint-out time (release sprint → able to fire) | **160–230 ms** | `[stated]` | BO6 160–215 ms; MWIII 206–231 ms. |
| Walk speed | **4.7–5.4 m/s** | `[stated]` | BO6 Feng 82 4.7 m/s; MWIII pistols 5.3–5.5 m/s. Classic engine 4.83 m/s. |
| Sprint speed | **6.0–6.7 m/s** | `[stated]` | BO6 5.4–6.7 m/s by weapon; classic engine 7.24 m/s (1.5×). |
| ADS movement speed | **2.5–2.9 m/s** | `[stated]` | BO6 2.5→2.7 m/s; MWIII 2.7→2.9 m/s. |
| Health regen: delay / rate | **3 s / 75 HP/s** | `[stated]` | MWIII Season 2 official patch notes. Classic engine: 5 s delay, then instant-to-full. |

Two more that shape the game as much as any of the above:

| Quantity | Target | Confidence | Source |
| --- | --- | --- | --- |
| Designed engagement distance | **13 m (SMG), 26 m (rifle)** | `[stated]` | Official CoD5 level-design standards: "SMG distance: 512 units. Rifle distance: 1024 units." |
| Concurrent AI attackers | **2** | `[stated]` | Engine dvar `ai_maxAttackerCount "2"`. Only two AI shoot at the player at once regardless of how many are present. |

---

## 2. Time to kill

### 2.1 TTK by title — the spread

Call of Duty's TTK has moved by more than 100 ms across recent titles, and the community treats this as the single biggest lever on how a title feels.

| Title | Health | AR TTK | SMG TTK | Confidence | Source |
| --- | --- | --- | --- | --- | --- |
| MW2019 | 100 | "maxed out at just below 200 ms" | — | `[measured]` | XclusiveAce frame testing, [via Dexerto](https://www.dexerto.com/call-of-duty/modern-warfare-3-ttk-how-does-it-compare-to-mw2-mw2019-older-cod-games-2328576/) |
| MW2019 (general) | 100 | 200–300 ms typical, ~4 STK | ditto | `[measured]` | [DenKirson forums, MW2019 damage/RPM thread](https://denkirson.proboards.com/thread/8482/modern-warfare-2019-gun-damage) |
| MWII (2022) | 100 | Kastov 762 ≈ 200 ms; Lachmann-556 ≈ 249 ms | Fennec 45 fastest | `[measured]`, weak sourcing | Secondary aggregators only — see §9 |
| MWIII (2023) | **150** | "just over 300 ms" | "around 280 ms" | `[measured]` | XclusiveAce via Dexerto |
| BO6 (2024) | 100 | 260–340 ms | 220–288 ms | `[measured]` | [Dexerto TTK rankings, BO6 S5](https://www.dexerto.com/call-of-duty/fastest-time-to-kill-weapons-in-black-ops-6-ranked-2968079/), [wzstats.gg](https://wzstats.gg/bo6/meta/close-range-meta) |

Explicitly stated ordering, from the same XclusiveAce analysis: MWIII is "one of the slowest TTKs in Call of Duty history, faster only than Black Ops 4 and, in some situations, Cold War." MW2019 is at the fast end. `[measured]`

**Recommendation:** target the MW2019/BO6 band — **200–300 ms** at close range. That is where the series' identity sits; MWIII's 300 ms+ was widely disliked and MWIII is the only recent title at 150 HP.

### 2.2 BO6 TTK by weapon (100 HP)

From [Dexerto's Season 5 ranking](https://www.dexerto.com/call-of-duty/fastest-time-to-kill-weapons-in-black-ops-6-ranked-2968079/) `[measured]`:

| Class | Weapon | TTK | Notes |
| --- | --- | --- | --- |
| Assault rifle | Goblin Mk2 | 260 ms | semi-auto, trigger-limited |
| Assault rifle | AS VAL | 268 ms | fastest full-auto AR |
| SMG | Kompakt 92 | 220 ms | within ~11 m |
| SMG | KSV | 225 ms | up to ~10.2 m |
| SMG | C9 | 246 ms | |
| SMG | PP-919 | 288 ms | slowest SMG |
| LMG | PU-21 | 240 ms (260 ms incl. pre-fire delay) | |
| LMG | GPMG-7 | 264 ms | |
| Marksman | DM-10 | 200 ms | fastest non-one-shot weapon in BO6, ~25 m |
| Marksman | AEK-973 | 351 ms | |

Cross-checked against [wzstats.gg](https://wzstats.gg/bo6/meta/close-range-meta) and [long-range meta](https://wzstats.gg/bo6/meta/long-range-meta), which agree for KSV (225), C9 (246), Kompakt 92 (220), PP-919 (288), AS VAL (268 vs 283), and add: XM4 296 ms, AMES 85 320 ms, AK-74 302 ms, GPR 91 340 ms, XMG 258 ms, Model L 300 ms.

**Sources disagree on the Tanto .22.** Dexerto says 272 ms; wzstats says 174 ms. wzstats also lists sub-200 ms figures for pistols (GS45 195 ms) that look like best-case or headshot-inclusive numbers. Treat wzstats' outliers with caution; the two sites agree closely everywhere else.

### 2.3 Damage per shot, shots to kill, fire rate — representative weapon per class

#### Modern (BO6, 100 HP) — all damage/range figures `[stated]` from official patch notes

| Weapon | Class | Damage by range band | STK | RPM | TTK |
| --- | --- | --- | --- | --- | --- |
| XM4 | AR | 23 (0–16.5 m) / 22 (16.6–40.6 m) / 19 (>40.6 m) | 5 / 5 / 6 | ≈810 `[estimated]` | 296 ms `[measured]` |
| GPR 91 | AR | 23 (0–22.2 m) / 22 (22.3–45.7 m) / 19 (>45.7 m) | 5 / 5 / 6 | ≈706 `[estimated]` | 340 ms `[measured]` |
| AS VAL | AR | 22 (0–12.7 m) / 18 (12.8–43.2 m) / 16 (>43.2 m) | 5 / 6 / 7 | ≈896 `[estimated]` | 268 ms `[measured]` |
| Kompakt 92 | SMG | 20 (0–11.4 m) / 17 (11.4–15.2 m) | 5 / 6 | ≈1090 `[estimated]` | 220 ms `[measured]` |
| LR 7.62 | Sniper | 104 (0–63.5 m) / 102 (63.6–88.9 m) / 95 (>88.9 m) | 1 | — | one-shot |

RPM figures marked `[estimated]` are derived, not found: `RPM = 60000 / (TTK ÷ (STK − 1))`. Worked example for the Kompakt 92 — 20 damage against 100 HP is 5 shots to kill; a 220 ms TTK spans 4 inter-shot gaps, so each gap is 55 ms, so 1090 RPM. One secondary source lists the Kompakt 92 at 909 RPM, which is **inconsistent** with the widely-reported 220 ms TTK (909 RPM would give 264 ms). I could not resolve this; the derived figure is internally consistent with two independent TTK sources.

**This arithmetic is also how BO6's health pool was confirmed.** BO6 base health is 100, not 150. Independent confirmation: a weapon database describes the Kompakt 92 as "a five-shot kill, as each hit does 20 damage" — 5 × 20 = 100 exactly. And 150 HP would require the Kompakt 92 to fire at 1900 RPM to hit its measured TTK, which is impossible. Some secondary sources incorrectly carry MWIII's 150 forward to BO6.

#### Classic (CoD4, 100 HP) — all figures `[measured]`, read from the shipped weapon files

Read from stock CoD4 multiplayer weapon files ([community mirror](https://github.com/doctorluk/cod4-baserace/tree/master/weapons/mp)). Cross-checked against independently published figures: AK-47 706 RPM, MP5 800 RPM, sniper base damage 70, health 100 — all match, so treat as stock. The one disagreement is the SAW (file says 923 RPM, the [CoD Wiki](https://callofduty.fandom.com/wiki/M249_SAW) says 937 RPM), so allow ±2% on any single value.

| Weapon | Class | Damage | Max/min damage range | RPM (`fireTime`) | STK close / far | TTK close / far |
| --- | --- | --- | --- | --- | --- | --- |
| AK-47 | AR | 40 → 30 | 38.1 m / 50.8 m | 706 (0.085 s) | 3 / 4 | 170 ms / 255 ms |
| MP5 | SMG | 40 → 20 | 19.1 m / 25.4 m | 800 (0.075 s) | 3 / 5 | 150 ms / 300 ms |
| M249 SAW | LMG | 30 flat | 38.1 m / 50.8 m | 923 (0.065 s) | 4 / 4 | 195 ms |
| M40A3 | Sniper | 70 flat | 101.6 m / 127 m | ≈65 (0.05 s fire + 0.866 s rechamber) | 2 body, 1 head | ~916 ms / 0 ms |
| W1200 | Shotgun | 40 → 10 **per pellet** | 7.6 m / 12.7 m | 212 (0.283 s) | pellet count not extracted | — |
| M9 Beretta | Pistol | 40 → 20 | 6.35 m / 12.7 m | 1200 cap, trigger-limited | 3 / 5 | trigger-dependent — see note |

TTK formula, [stated on the CoD Wiki](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics): `TTK = d × (s − 1)` where `d` is the inter-shot delay and `s` is shots to kill. The first shot leaves the barrel instantly, so a one-shot weapon kills in 0 ms. `[stated]`

Semi-automatic weapons cannot be given a meaningful TTK from `fireTime` alone: the M9's 0.05 s only sets the engine's 1200 RPM ceiling, and the real rate is whatever the player's trigger finger achieves. CoD4 console patch 1.40 clamped semi-autos to **444–566 RPM** `[measured]`, which for a 3-shot kill gives roughly **210–270 ms**.

### 2.4 Hitbox damage multipliers

Multipliers are **per-weapon** in every title from CoD4 onward, not global. The ranges below are the observed spread.

#### Modern titles — `[stated]`, from official patch notes

| Region | MWIII | BO6 | Notes |
| --- | --- | --- | --- |
| Head | 1.2 – 1.5 (typically 1.3–1.4) | 1.1 – 1.5 (XM4 1.15, AEK-973 1.28, AMES 85 1.12) | BO6 nerfed headshots hard: XM4 1.3 → 1.15, AMES 85 1.25 → 1.12 |
| Neck | 1.0 – 1.4 | grouped with upper torso | MWIII DG-58 neck 1.4 → 1.1; Holger 26 neck 1.1 → 1.2 |
| Upper torso / upper arm | 1.0 – 1.2 | 1.0 – 1.1 | BO6 LR 7.62 sniper 1.1 → 1.0 |
| Lower torso / lower arm | 0.95 – 1.15 | 0.9 – 0.98 | BO6 LR 7.62 0.9 → 0.98 |
| Arms / hands | 0.8 – 1.16 | ~0.98 – 1.0 | MWIII .410 slug arms 0.8 |
| Legs / feet | 0.8 – 1.05 | 0.95 – 1.0 | MWIII FR 5.56 legs 1.0 → 0.9; MORS 1.0 → 0.95 |

Concrete stated examples:
- MWIII Holger 556 (AR): head 1.4 → **1.3**; neck, upper-torso, arm, hand 1.1 → **1.0**. `[stated]`
- MWIII FR 5.56 (AR): head 1.5 → **1.4**; leg and foot 1.0 → **0.9**. `[stated]`
- BO6 XM4 (AR): head 1.3 → **1.15** (CHF barrel 1.42 → 1.25). `[stated]`
- BO6 LR 7.62 (sniper): upper torso and upper arm 1.1 → **1.0**; lower torso and lower arm 0.9 → **0.98**. `[stated]`
- MWIII .410 Gauge Slug: neck and upper torso 1.1, lower torso 1.0, arms/hands 0.8, legs/feet 0.8. `[stated]`

#### Classic titles — `[measured]`, from the [CoD Wiki Damage Multiplier page](https://callofduty.fandom.com/wiki/Damage_Multiplier)

Original *Call of Duty* / *United Offensive* used one global table — the only title in the series that did, and a useful clean starting point:

| Region | Multiplier |
| --- | --- |
| Helmet / head / neck | 1.5 |
| Upper torso | 0.9 |
| Lower torso | 0.8 |
| Upper arms / upper legs | 0.6 |
| Lower arms / lower legs | 0.5 |
| Hands / feet | 0.4 |
| Weapon model | 0.0 |

CoD4 through MW3: ARs, SMGs, LMGs and handguns get **1.4** to head and helmet, **1.0 everywhere else including limbs**. Exceptions: SCAR-L and SMGs in MW3 1.5, FAD 1.7, Skorpion and MP9 2.0. Shotguns have **no multipliers at all**. Sniper rifles get extra torso multipliers so they can two-shot: e.g. CoD4 R700 and Barrett get 1.5 to helmet, head, neck **and upper torso**, 1.1 to lower torso. `[measured]`

Note the direction of travel: classic CoD gave limbs a flat 1.0 (limb shots cost you nothing). Modern CoD reintroduced sub-1.0 limb multipliers, typically 0.9–0.98.

### 2.5 Damage falloff

Falloff is **stepwise, not linear**. Damage holds flat inside a band and drops instantly at the boundary. Typically 3 bands (max / medium / minimum), occasionally 4–5.

Stated band boundaries, BO6 `[stated]`:

| Weapon | Class | Band 1 | Band 2 | Band 3 |
| --- | --- | --- | --- | --- |
| XM4 | AR | 23 dmg, 0–16.5 m | 22 dmg, 16.6–40.6 m | 19 dmg, >40.6 m |
| GPR 91 | AR | 23 dmg, 0–22.2 m | 22 dmg, 22.3–45.7 m | 19 dmg, >45.7 m |
| AS VAL | AR | 22 dmg, 0–12.7 m | 18 dmg, 12.8–43.2 m | 16 dmg, >43.2 m |
| Kompakt 92 | SMG | 20 dmg, 0–11.4 m | 17 dmg, 11.4–15.2 m | — |
| Kompakt 92 + burst | SMG | 23 dmg, 0–17.1 m | — | — |
| LR 7.62 | Sniper | 104 dmg, 0–63.5 m | 102 dmg, 63.6–88.9 m | 95 dmg, >88.9 m |
| (unnamed AR, S2) | AR | — | — | 30 dmg, >41.3 m |

MWIII `[stated]`: Striker SMG maximum damage range increased 9 m → **19 m**. MTZ Interceptor marksman rifle maximum damage range decreased 38.1 m → **30.5 m**.

Classic CoD4 `[measured]`, converted from units:

| Weapon | Max damage out to | Min damage from |
| --- | --- | --- |
| AK-47 (AR) | 38.1 m (1500 u) | 50.8 m (2000 u) |
| MP5 (SMG) | 19.1 m (750 u) | 25.4 m (1000 u) |
| M249 SAW (LMG) | 38.1 m (1500 u) | 50.8 m (2000 u) |
| M40A3 (sniper) | 101.6 m (4000 u) | 127 m (5000 u) |
| W1200 (shotgun) | 7.6 m (300 u) | 12.7 m (500 u) |
| M9 (pistol) | 6.35 m (250 u) | 12.7 m (500 u) |

CoD4 interpolates linearly *between* max and min range; modern titles use hard steps. `[estimated]` — inferred from CoD4 having exactly two range values per weapon versus modern patch notes listing discrete bands with damage constant inside each.

**Design pattern worth copying:** the max-damage band for an SMG ends around 11–19 m and for an AR around 16–22 m — which lands almost exactly on the official 13 m / 26 m designed engagement distances in §6.3. Falloff boundaries are placed to make weapon class matter at the distances the maps actually produce.

---

## 3. Weapon handling

### 3.1 ADS time

**Modern** `[stated]`, from official patch notes:

| Class | ADS time | Examples |
| --- | --- | --- |
| Pistol | 110–165 ms | BO6 9mm PM 110 ms, GS45 125 ms `[measured]`, wzstats |
| SMG | 165–240 ms | BO6 Tanto .22 165, Jackal PDW 195, C9 210, KSV 220, Kompakt 92 225, PP-919 240; MWIII Striker 240→230, Striker 9 275→225 |
| Assault rifle | 225–290 ms | BO6 GPR 91 225, AS VAL 230, Goblin Mk2 245, XM4 260, AMES 85 265, Model L 270, AK-74 290; MWIII FR 5.56 240→260 |
| Marksman rifle | 315–340 ms | BO6 SWAT 5.56 340→315 |
| LMG | 310–460 ms | BO6 PU-21 310, Feng 82 400→370, XMG 450, GPMG-7 460; MWIII TAQ Eradicator 340→330 |
| Sniper rifle | 400–580 ms | BO6 LW3A1 550→535, launchers 400→325; MWIII MORS 560→580 |

**Classic** `[measured]`, `adsTransInTime` from the CoD4 weapon files:

| Weapon | ADS in | ADS out |
| --- | --- | --- |
| M9 Beretta (pistol) | 100 ms | 100 ms |
| MP5 (SMG) | 200 ms | 200 ms |
| W1200 (shotgun) | 200 ms | 200 ms |
| AK-47 (AR) | 250 ms | 250 ms |
| M249 SAW (LMG) | 350 ms | 350 ms |
| M40A3 (sniper) | 400 ms | 600 ms |

Black Ops 2 `[measured]`, from [community frame testing](https://denkirson.proboards.com/thread/6176/sprint-out-times-ads): SMGs 200 ms, shotguns 200–250 ms, LMGs 450 ms. Quickdraw attachment applies a 0.5× multiplier (0.6× on shotguns).

**Hip → ADS versus sprint-out → ADS.** These are separate timers that run concurrently, not additively. The critical rule, from Black Ops 2 frame testing `[measured]`:

- If ADS time == sprint-out time: you cannot shoot until the sights are fully up.
- If ADS time < sprint-out time: the ADS animation is **stretched** to match sprint-out time.
- If ADS time > sprint-out time: you can shoot before the sights finish rising.

So the effective delay coming out of a sprint is `max(ADS time, sprint-out time)`, not their sum. This is one of the least obvious and most important feel details in the series.

### 3.2 Sprint-out time (release sprint → able to fire)

This is the number that determines whether a game feels twitchy or committed. `[stated]` from official patch notes:

| Title / class | Sprint-out | Tactical sprint-out |
| --- | --- | --- |
| BO6 AR (XM4-tier) | 160–175 ms | 270–285 ms |
| BO6 marksman | 205–215 ms | 315–325 ms |
| BO6 shotgun | 190–245 ms | 300–330 ms |
| BO6 sniper | 290–310 ms | 430–470 ms |
| MWIII AR | 210 → 231 ms | — |
| MWIII SMG (AMR9) | 294 → 206 ms | — |
| MWIII LMG (TAQ Eradicator) | 252 → 210 ms | — |
| MWIII pistol | 80 → 100 ms | — |

**Tactical sprint costs roughly 105–160 ms of extra sprint-out on top of regular sprint** — derived from the BO6 pairs above (e.g. 160/270, 175/285, 205/315, 245/335, 290/430). `[estimated]` from stated pairs. A secondary source describes this as "a flat 100–200 ms delay," which is consistent.

BO6 also exposes two more, both `[stated]`:
- **Slide to fire**: 330–410 ms (Feng 82 410 → 380; AR 370 → 330).
- **Dive to fire**: 420–490 ms (Feng 82 490 → 460; AR 450 → 420).

Classic CoD4 `[measured]`: `sprintOutTime` is **300 ms for every weapon** except the SAW at 400 ms. There was no per-weapon differentiation. `sprintInTime` 300 ms, `sprintLoopTime` 700 ms.

### 3.3 Reload times and the reload-cancel window

Classic CoD4 `[measured]`. `reloadTime` is the full animation; `reloadAddTime` is when the ammo is actually credited. The gap between them is the free cancel window — sprint, melee or swap after `reloadAddTime` and you keep the ammo.

| Weapon | Tactical reload | Empty reload | Ammo credited at | Cancel window |
| --- | --- | --- | --- | --- |
| M9 Beretta | 1.63 s | 1.92 s | 1.20 s | 0.43 s |
| MP5 | 2.33 s | 3.30 s | 1.77 s | 0.56 s |
| AK-47 | 2.50 s | 3.25 s | 1.50 s | **1.00 s** |
| M249 SAW | 6.45 s | 6.45 s | 5.23 s | 1.22 s |
| W1200 | 0.567 s per shell | per shell | 0.25 s | 0.32 s |

DenKirson's independent summary agrees: "Reload canceling via sprint/melee/weapon switch can save up to 1 second." `[measured]`

Modern titles do not publish base reload times, but do publish deltas and some absolute animation timings `[stated]`:
- BO6 Season 2: Fast Mag I/II/III and Flip Mag reload times improved **10%** on all classes except pistols (**5%** on pistols); all LMG magazines of ≤50 rounds improved **5%**.
- BO6 absolute "ammo add times" (the reload-cancel threshold, same concept as CoD4's `reloadAddTime`): C9 Extended Mag I **2.267 s**; Model L Extended Mag II **2.433 s**; SVD Extended Mag 2 **3.0 s**; GPMG-7 Extended Mag II **5.6 s**, Mag III **6.07 s**, Mag IV **6.47 s**. Patch notes state "the overall reload times and interrupt times remain the same," so these sit inside a longer full animation.
- MWIII added the ability to **cancel a reload using Tactical Sprint** (Season 3), and fixed reloads being cancelled by movement when Automatic Tactical Sprint is on.

**Recommendation:** AR tactical reload ~2.3–2.5 s, empty ~3.2–3.3 s, ammo credited at ~60% of the animation, cancellable after that. LMG 5–6.5 s. Pistol ~1.6 s.

### 3.4 Weapon swap time

Classic CoD4 `[measured]`. A swap is `dropTime` of the outgoing weapon plus `raiseTime` of the incoming one.

| Weapon | Drop | Raise | First raise (spawn) | Quick drop | Quick raise |
| --- | --- | --- | --- | --- | --- |
| MP5 | 0.25 s | 0.666 s | 0.666 s | 0.25 s | 0.25 s |
| M249 SAW | 0.25 s | 0.66 s | 0.50 s | 0.325 s | 0.35 s |
| W1200 | 0.33 s | 0.625 s | — | — | — |
| M9 Beretta | 0.45 s | 0.55 s | 0.25 s | 0.25 s | 0.25 s |
| AK-47 | 0.60 s | 0.95 s | 1.40 s | 0.25 s | 0.75 s |
| M40A3 | 0.66 s | 0.90 s | 0.90 s | 0.25 s | 0.75 s |

So AR → pistol is 0.60 + 0.55 = **1.15 s** normally, and 0.25 + 0.25 = **0.50 s** with the fast-hands perk. The `quick*` values are the perk-modified path.

BO6 `[stated]`, for launchers (the slowest class):
- Raise 1000 → **800 ms**; with Fast Hands 750 → **550 ms**
- Drop 600 → **450 ms**; with Fast Hands 300 → **200 ms**
- **Raise interrupt time** 750 → **250 ms** (Fast Hands 500 → 100 ms) — how soon into a raise you can cancel it and do something else. Modern CoD added this specifically to stop the raise animation feeling like a lockout.

BO6 preseason also states "Improved Pistol and Dedicated Melee swap speeds" and that "weapon raise animations that play on respawn are now fully interruptible."

### 3.5 Recoil

**Model.** CoD splits recoil into two independent systems, [stated on the CoD Wiki](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics):

- **View kick** moves the camera. Five parameters: max/min horizontal, max/min vertical, and centre speed.
- **Gun kick** moves the weapon model relative to the screen — visual only, and entirely removed when using a scope with no weapon model.
- Each shot picks **two independent random values**, one vertical and one horizontal, uniformly between that weapon's min and max. Positive is up/right, negative is down/left. A weapon with a positive minimum always kicks in that direction.
- **Centre speed** is how fast the view returns between shots. It applies immediately on firing, but during full-auto fire there is usually too much kick to fully recentre before the next shot. "Low recoil is a result of a high center speed, minimum and maximum numbers having low absolute values *and* balanced values on all sides, and the weapon's rate of fire."

**Pattern shape:** this is a *randomised cone with a directional bias*, not a memorisable fixed spray pattern like CS or Battlefield. Two shots from the same weapon never trace the same path. Recoil control in CoD is about pulling against a bias, not learning a curve.

Classic CoD4 view-kick values `[measured]`:

| Weapon | Pitch min → max | Yaw min → max | Centre speed |
| --- | --- | --- | --- |
| AK-47 (hip and ADS) | −30 → 60 | 60 → −60 | 1500 |
| MP5 (hip and ADS) | −30 → 70 | 70 → −80 | 1700 |
| M249 SAW | reported 60 up / 40 down / 70 left / 70 right | | 1700 |

**The engine unit for these numbers is not publicly documented** — they are not degrees. `bg_viewKickScale "0.2"` and `bg_viewKickMax "90"` / `bg_viewKickMin "5"` scale them, but the full conversion is not published. Use the modern metric figures below as your degree anchor instead.

Modern recoil in real units `[stated]`, MWIII patch notes:
- DG-58 LSW (LMG): horizontal recoil **7.28 → 6.35 deg/s**; vertical recoil **52.65 → 47.89 deg/s**.

That gives a usable ratio: **vertical recoil is roughly 7–8× horizontal** for a heavy weapon, with vertical in the ~50 deg/s band.

Attachment penalties, stated as percentages of base `[stated]`, BO6: CHF Barrel vertical recoil penalty 40–55%, horizontal 20–25%; Rapid Fire horizontal penalty 25–30%; AEK-973 Rapid Fire gun kick, vertical and horizontal penalties all 50%.

**First-shot recoil multiplier:** not published for any Call of Duty title. See §9.

**Recovery time:** derivable only for classic titles from centre speed, whose unit is undocumented. See §9. The observable behaviour is that recoil visibly recentres between shots at low fire rates and accumulates at high ones.

### 3.6 Spread — hipfire versus ADS

**ADS spread is zero.** This is the single most important accuracy fact about Call of Duty. From the [CoD Wiki](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics) `[stated]`, corroborated by the weapon files (`adsSpread 0` on every weapon inspected) `[measured]`:

> All weapons in Call of Duty, excluding weapons that obviously do not use hitscans, are perfectly accurate at an infinite range while aiming down the sights. Misses are caused by idle sway, recoil, misaligned sights, spread, and lag.

DenKirson, independently: "Every single weapon is pinpoint accurate when aiming down the sights, shotguns excluded." `[measured]`

MW2019 changed weapons from hitscan to projectiles with travel time, but ADS spread remained ~0 — hence patch notes quoting bullet velocity (168–770 m/s across MWIII weapons) `[stated]` rather than ADS spread.

**Hipfire spread, classic CoD4** `[measured]`, in **degrees** (cone half-angle):

| Weapon | Stand min → max | Crouch min → max | Prone min → max | Per-shot add | Move add | Decay |
| --- | --- | --- | --- | --- | --- | --- |
| MP5 (SMG) | 2.0 → 5.0 | 1.75 → 4.5 | 1.5 → 4.0 | +0.52 | +4.0 | 4.0 °/s |
| AK-47 (AR) | 3.0 → 7.0 | 2.5 → 6.0 | 2.0 → 5.0 | +0.60 | +5.0 | 4.0 °/s |
| M249 SAW (LMG) | 4.0 → 10.0 | 3.5 → 8.0 | 3.0 → 6.0 | +0.60 | +5.0 | 4.0 °/s |
| M40A3 (sniper) | 10.0 → 15.0 | 9.5 → 14.0 | 9.0 → 13.0 | +1.00 | +5.0 | 5.0 °/s |

**Spread growth under sustained fire, worked example** `[estimated]` from the stated parameters: the AK-47 starts at 3.0°, adds 0.60° per shot, and caps at 7.0°. That is `(7.0 − 3.0) / 0.6 = 6.7` shots to reach the cap — at 706 RPM, about **570 ms of held trigger**. Recovery from cap back to minimum at 4.0 °/s takes **1.0 s**. Movement adds a flat +5.0° while moving, which is larger than the entire fire-growth range: **moving is far more punishing to hipfire than sustained fire is.**

Other stated modifiers: jumping adds `jump_spreadAdd "64"` `[stated]`; the Steady Aim perk reduces hip spread diameter by 65% `[measured]`.

**Hipfire spread, modern MWIII** `[stated]`, patch notes (written as "deg/s" but functionally the cone):

| Parameter | Range across weapons |
| --- | --- |
| Standing hipfire spread minimum | 2.3 – 3.4° |
| Standing hipfire spread maximum | 5.5 – 7.8° |
| Moving hipfire spread maximum | 4.7 – 5.8° |
| Akimbo pistol minimum | 1.7 – 2.4° |

These sit almost exactly on the classic CoD4 AR values (3.0 → 7.0). **Hipfire spread has barely changed in seventeen years.**

BO6 states relative changes only: "All Hipfire Spread angles improved by 0.5 degrees"; 12 Gauge Slug "increases hip spread by 20%." `[stated]`

**Idle sway** (the ADS-only accuracy cost) `[stated]`, MWIII Season 2: sway now starts after a delay "generally 5 ms long but varies by weapon," then "gradually increases over a 3 s period before reaching peak speed, rather than beginning at full speed." BO6 snipers: "1 second of 50% Idle Sway scaling at the beginning of Aim Down Sight."

Classic CoD4 idle values `[measured]`: `adsIdleAmount` 40 (AK-47) / 2 (MP5), `hipIdleAmount` 30, `adsIdleSpeed` 0.8–0.9. DenKirson notes the G36c's idle amount and speed drop with stance: standing 28 / 0.8, crouched 21 / 0.6, prone 11 / 0.3.

### 3.7 Aim assist (controller) — as a design reference

Modern titles publish no strength values. Classic titles publish all of them as dvars.

**Classic engine aim assist** `[stated]`, from the CoD5 dvar list:

| Dvar | Value | Meaning |
| --- | --- | --- |
| `aim_slowdown_enabled` | 1 | Slowdown on |
| `aim_slowdown_yaw_scale` | 0.4 | Hipfire: stick input multiplied by 0.4 while reticle is on target |
| `aim_slowdown_pitch_scale` | 0.4 | ditto, vertical |
| `aim_slowdown_yaw_scale_ads` | 0.5 | ADS: multiplied by 0.5 |
| `aim_slowdown_pitch_scale_ads` | 0.5 | ditto, vertical |
| `aim_slowdown_region_width` / `_height` | 90 / 90 | Screen-space slowdown box |
| `aim_lockon_enabled` | 1 | Rotational assist on |
| `aim_lockon_strength` | 0.6 | Rotational assist strength |
| `aim_lockon_deflection` | 0.05 | Minimum stick deflection to engage |
| `aim_lockon_region_width` / `_height` | 90 / 90 | Screen-space lock-on box |
| `aim_autoaim_enabled` | 0 | Hard auto-aim off |
| `aim_turnrate_yaw` | 260 °/s | Max horizontal turn rate, hipfire |
| `aim_turnrate_yaw_ads` | 90 °/s | Max horizontal turn rate, ADS |
| `aim_turnrate_pitch` | 90 °/s | Max vertical turn rate, hipfire |
| `aim_turnrate_pitch_ads` | 55 °/s | Max vertical turn rate, ADS |
| `aim_accel_turnrate_lerp` | 1200 ms | Time to ramp to max turn rate |
| `aim_target_sentient_half_height` | 32 u (0.81 m) | Aim-assist target capsule is 1.63 m tall |
| `aim_target_sentient_radius` | 10 u (0.254 m) | ...and 0.51 m wide |
| `aim_automelee_enabled` / `_range` | 1 / 128 u (3.25 m) | Melee auto-target within 3.25 m |
| `aim_automelee_region_width` / `_height` | 320 / 240 | Melee auto-target covers most of the screen |

The three components are: **slowdown** (stick sensitivity multiplied by 0.4–0.5 when the reticle is over a target), **rotational assist** (the view is dragged to follow a moving target, strength 0.6), and **bullet magnetism** (not exposed as a dvar in these lists).

**Modern behaviour** `[stated]`, from Treyarch's BO7 patch notes — describes structure but publishes no absolute strengths:
- "In Black Ops 6, we updated Rotational Aim Assist strength at close range to scale over a short distance. In Black Ops 7, we are increasing the range before full Rotational Aim Assist strength is achieved."
- "We have slightly increased Rotational Aim Assist strength at very long ranges."
- New requirement: "the player's right stick movement must be tracking an enemy target for Rotational Aim Assist to activate at full strength. If the conditions are not met, Rotational Aim Assist strength will be reduced."
- The penalty for not meeting that requirement: **35%** reduction at launch, tuned to **25%**. `[stated]` — the only absolute aim-assist figure published for a modern title.
- Stated rationale: "controller is slightly favored to win at close ranges and KBM is favored at long ranges."

**Relevance to a mouse game:** the numbers that transfer are the *target capsule* (1.63 m × 0.51 m — the hitbox that matters is generous relative to the model) and the *turn rate ceiling* (260 °/s hip, 90 °/s ADS — this is what ADS sensitivity scaling should feel like). The slowdown and rotation values are controller-only crutches; do not port them to a mouse.

---

## 4. Movement

### 4.1 Speeds

**Modern, in metres per second, stated directly in patch notes** `[stated]`:

| Quantity | Value | Source |
| --- | --- | --- |
| Walk (BO6 Feng 82, LMG) | 4.6 → **4.7 m/s** | BO6 S2 |
| Crouch (BO6 Feng 82) | 2.1 → **4.3 m/s** | BO6 S2 — a deliberate large buff; see note |
| Sprint (BO6 Feng 82) | 6.1 → **6.3 m/s** | BO6 S2 |
| ADS movement (BO6 Feng 82) | 2.5 → **2.7 m/s** | BO6 S2 |
| ADS movement (MWIII) | 2.7 → **2.9 m/s** | MWIII S3 |
| Walk (MWIII pistols) | **5.1 – 5.5 m/s** | MWIII S3, seven weapons |
| Sprint (MWIII pistols) | **5.7 – 6.1 m/s** | MWIII S3 |
| Aim-walking bonus from stock attachments (BO6 snipers) | **+0.20 – 0.58 m/s** | BO6 S1 |

Per-weapon sprint speeds `[measured]`, from [wzstats.gg](https://wzstats.gg/bo6/meta/close-range-meta):

| Class | BO6 sprint speed |
| --- | --- |
| SMG | 6.6 – 6.7 m/s |
| Assault rifle | 5.7 – 6.6 m/s |
| LMG | 5.4 – 6.1 m/s |
| Pistol | 6.0 m/s |

**Tactical sprint** `[stated]`, official BO6 blog: "Tactical sprint moves you slightly faster than regular sprint (roughly **+1 m/s**), but your weapon's sprint-to-fire delay is substantially increased." That puts tac sprint at roughly **6.4–7.7 m/s**. A reported MWII figure of **7.67 m/s** for the BAS-P SMG is consistent `[measured]`, weak sourcing.

Tactical sprint is also the only movement in BO6's Omnimovement that **cannot** be done in all directions — sprint, slide and dive are omnidirectional; tac sprint is forward only. `[stated]`

**Classic engine, exact** `[stated]`, from the shipped dvar defaults (identical in CoD5 and CoD7):

| Dvar | Value | In m/s |
| --- | --- | --- |
| `g_speed` | 190 u/s | **4.826 m/s** forward walk |
| `player_sprintSpeedScale` | 1.5 | **7.239 m/s** sprint |
| `player_strafeSpeedScale` | 0.8 | **3.861 m/s** strafe |
| `player_backSpeedScale` | 0.7 | **3.378 m/s** backpedal |
| `player_sprintStrafeSpeedScale` | 0.667 | **4.828 m/s** strafing while sprinting |
| `player_sprintTime` | 4 s | Sprint duration |
| `player_sprintMinTime` | 1 s | Minimum sprint commitment |
| `player_sprintForwardMinimum` | 105 u/s | Must exceed 2.67 m/s to hold sprint |
| `player_waterSpeedScale` | 1.3 | |
| `perk_sprintMultiplier` | 2 | Extreme Conditioning / Marathon doubles sprint duration |
| `compassEnemyFootstepMinSpeed` | 140 u/s | Move faster than **3.556 m/s** and you appear on enemy radar |
| `bg_aimSpreadMoveSpeedThreshold` | 11 u/s | Move faster than **0.279 m/s** and movement spread applies |

Stance multipliers `[measured]`, [CoD Wiki](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics): crouch **60%** of base (2.90 m/s), prone **15%** (0.72 m/s).

Weapon-class multipliers, CoD4 `[measured]`:

| Primary weapon | Walk | ADS walk |
| --- | --- | --- |
| SMG / pistol / W1200 | 100% (4.83 m/s) | 80% (3.86 m/s) |
| Shotgun (other) | 100% | 40% (1.93 m/s) |
| Assault rifle / sniper | 95% (4.58 m/s) | 38% (1.83 m/s) |
| LMG | 87.5% (4.22 m/s) | 35% (1.69 m/s) |

**Note two structural differences between eras**, worth deciding on deliberately:

1. **Sprint multiplier collapsed.** Classic sprint is a clean **1.5×** walk. Modern sprint is only **1.15–1.35×** walk (BO6 Feng 82: 6.3 / 4.7 = 1.34×; MWIII X12 pistol: 6.1 / 5.4 = 1.13×). Modern CoD raised the *walk* speed and added tac sprint on top rather than making sprint dramatic.
2. **ADS movement got much better.** Classic AR ADS movement is 38% of walk (1.83 m/s). Modern is roughly 2.7 / 4.7 = **57%** of walk. Modern CoD is far more mobile while aiming.

The BO6 crouch figure of 4.3 m/s (91% of walk) is anomalously high and was an explicit buff to one weapon. Classic 60% is the better default; the BO6 number is included because it is the only directly stated modern crouch speed.

### 4.2 Slide, dive and their cancel windows

`[stated]`, modern:
- BO6 **slide to fire**: 330–410 ms. **Dive to fire**: 420–490 ms. These are the effective slide/dive "lockout" from a weapon perspective.
- MWIII: "Sprint input while sliding will now cancel the slide animation." Slide cancel is an intentional mechanic in MWIII, not an exploit.
- MWIII launch introduced a Tac Sprint refresh delay after sliding, then reduced it by **75%**, and reduced the sprint delay after sliding by **53%**, "to improve movement fluidity without making slide and Tac Sprint repetition the only viable choice."
- MWIII: "Increased slide velocity, replacing the slide distance advantage."
- BO6: "Reduced the minimum sprint time required to perform... dive-to-prone or slide," to reduce cases where the player crouches instead.
- BO6 added a configurable hold time for dive versus slide, and MWIII added "Tap to slide, disables the dive" / "Tap to dive, disables the slide."

`[stated]`, classic Black Ops dive-to-prone (the ancestor of the slide):
- `dtp_max_slide_duration "300"` — **300 ms** of slide at the end of a dive.
- `dive_recharge "1000"` — **1000 ms** cooldown before you can dive again.
- `player_sliding_friction "1.5"` — versus the standing `friction "5.5"`, so a slide decelerates at roughly **27%** the rate of a walk stop.

**Slide duration and slide cooldown for MW2019/MWII/MWIII/BO6 are not published and I could not find a credible frame count.** See §9. The 330–410 ms slide-to-fire figure is the closest usable proxy and is `[stated]`.

MW2019's original "slide cancel" was an unintended interaction, patched out 22 January 2020 `[measured]`; the mechanic was later reinstated deliberately in MWIII.

### 4.3 Mantle and vault

`[stated]`, classic engine dvars:

| Dvar | Value | Meaning |
| --- | --- | --- |
| `mantle_enable` | 1 | |
| `mantle_check_range` | 20 u = **0.508 m** | Forward reach for a mantle candidate |
| `mantle_check_angle` | 60° | Max angle off the surface normal |
| `mantle_check_radius` | 0.1 | |
| `mantle_view_yawcap` | 60° | View turn allowed mid-mantle |
| `mantle_weapon_height` | 39 u = 0.99 m | Weapon lowers above this ledge height |
| `mantle_weapon_anim_height` | 32 u = 0.81 m | |
| `mantle_check_glass_extra_range` | 10 u = 0.254 m | Extra reach through glass |
| `g_mantleBlockTimeBuffer` | 500 ms | Mantle blocks other actions for this long |
| `perk_mantleReduction` | 0.5 | Lightweight halves mantle time |
| `jump_stepSize` | 18 u = **0.457 m** | Auto step-up height; below this, no mantle needed |

`[stated]`, BO6 Season 1: "Increased all mantle speeds" and specifically "**High Mantle Speed** — the speed at which players pull themselves over (mantle) high ledges or walls has been increased." BO6 also added an "Intelligent Movement option to set Mantle Assist Angle from tight, medium, or wide."

**Absolute mantle and vault animation durations are not published for any title.** See §9. What the dvars do give you is the geometry: anything up to 0.457 m is walked over with no animation at all; a mantle triggers within 0.508 m of forward reach at up to 60° off-normal; the whole action locks other input for on the order of 500 ms.

### 4.4 Jump height, gravity and air time

`[stated]`, classic engine dvars (identical in CoD5 and CoD7):

| Dvar | Value | In metric |
| --- | --- | --- |
| `g_gravity` / `bg_gravity` | 800 u/s² | **20.32 m/s²** — 2.07× real gravity |
| `jump_height` | 39 u | **0.991 m** apex |
| `jump_slowdownEnable` | 1 | Movement slows in air |
| `jump_spreadAdd` | 64 | Large hipfire spread penalty while airborne |
| `jump_stepSize` | 18 u | 0.457 m auto step-up |
| `jump_ladderPushVel` | 128 u/s | 3.25 m/s push off a ladder |

Corroborated by the CoD5 level-design standards: "Jump height: **38 units high**" (0.965 m) as the clearance a player can jump onto. `[stated]`

Derived jump kinematics `[estimated]`, from the two stated constants:
- Launch velocity `v₀ = √(2 × 20.32 × 0.991) = 6.345 m/s`
- Time to apex `= 6.345 / 20.32 = 0.312 s`
- **Total air time ≈ 0.625 s**

That doubled gravity is the reason CoD jumps feel snappy and non-floaty despite a near-1-metre apex. If you use Earth gravity with a 1 m jump you get 0.90 s of air time and it will feel wrong.

**Air control is not exposed in any published dvar list.** See §9. Observable behaviour: `jump_slowdownEnable "1"` confirms air movement is *slowed*, not free, and `jump_spreadAdd "64"` confirms jump-shooting is heavily penalised — Call of Duty deliberately does not reward air movement.

### 4.5 Acceleration and stopping

The engine is an id Tech 3 derivative and uses the Quake friction model, with the same dvar names.

`[stated]`:
- `friction "5.5"` (Quake 3 default is 6)
- `stopspeed "100"` u/s = 2.54 m/s (Quake 3 default is 100)
- `player_meleeChargeFriction "1200"`
- `phys_frictionScale "1"`

**Stopping time, derived** `[estimated]` — the derivation assumes the standard Quake friction model, which is a safe assumption given the identical dvar names and engine lineage:

The model is `drop = max(speed, stopspeed) × friction × dt`. Above `stopspeed` this is exponential decay at rate 5.5 s⁻¹; below it, constant deceleration at `100 × 5.5 = 550 u/s²`.

- 190 → 100 u/s: `ln(1.9) / 5.5 = 0.117 s`
- 100 → 0 u/s: `100 / 550 = 0.182 s`
- **Full walk to full stop ≈ 0.30 s**, with **half the speed shed in the first 0.126 s**

That front-loaded curve is exactly what "snappy but not instant" feels like: you lose most of your momentum immediately and then coast to a halt.

**Acceleration is not published.** No `g_accel` or `pm_accelerate` appears in either dvar list I examined. The Quake 3 default is `pm_accelerate 10`, which under the same model gives `dv/dt = 10 × wishspeed = 1900 u/s²` — full speed in **0.1 s**. That is a defensible starting point `[estimated]` but it is a genuine guess; see §9.

### 4.6 Player and world dimensions

From the official CoD5 level-design standards `[stated]`, converted at 1 u = 0.0254 m:

| Measure | Units | Metres |
| --- | --- | --- |
| Player clearance, standing | (implied by 112 u wall) | — |
| Player clearance, crouch | 52 u | 1.321 m |
| Player clearance, prone | 32 u | 0.813 m |
| Player clearance, jump | 38 u | 0.965 m |
| Cover height, standing | 48 u | 1.219 m |
| Cover height, crouch | 36 u | 0.914 m |
| Cover height, prone | 16 u | 0.406 m |
| Aim-assist target capsule height | 64 u | 1.626 m |
| Aim-assist target capsule radius | 10 u | 0.254 m |
| Melee range | 64 u | 1.626 m |
| Melee charge (lunge) range | 128 u | 3.251 m |
| Doorway, single | 54 × 92 u | 1.372 × 2.337 m |
| Doorway, double | 108 × 92 u | 2.743 × 2.337 m |
| Window frame | 52 × 68 u, sill at 32 u | 1.321 × 1.727 m, sill 0.813 m |
| Stair step | 6 u rise, 8 u run, 64 u min width | 0.152 / 0.203 / 1.626 m |
| One-storey wall | 112 u | 2.845 m |
| Street, large (four cars) | 512 u | 13.00 m |
| Street, small (two tanks) | 320 u | 8.13 m |
| Alleyway | 192 u | 4.88 m |
| Sidewalk, small / medium / large | 128 / 192 / 256 u | 3.25 / 4.88 / 6.50 m |

Melee range corroborated by dvars `player_meleeRange "64"` and `ai_meleeRange "64"`, and by DenKirson: "Regular attack: 64 inches, 10-degree radius. Charge (stab): 128 inches, auto-targets center half of screen." `[measured]`

---

## 5. Survivability

### 5.1 Health pool

`[stated]` unless noted:

| Title / mode | Health |
| --- | --- |
| Classic engine default (`scr_player_maxhealth`) | **100** |
| MW2019, MWII, BO6 core multiplayer | **100** |
| MWIII core multiplayer | **150** |
| Hardcore ("Miniscule") | **30** |
| Old School / Double Health | **200** |
| Ghosts Heavy Duty | **130** |
| BO3 / BO4 Zombies | 150 / 200 |

MWIII's 150 was an explicit design decision: "Modern Warfare 3 raised the base health to 150 in multiplayer, up from the 100 seen in Modern Warfare 2. The result is a TTK that feels slower and makes gunfights last longer." Corroborated by an MWIII patch note: "Dummy targets in the Firing Range now have **150 health**, aligned with Core Multiplayer." `[stated]`

Also stated, MWIII: "Incoming explosive damage is now properly clamped at **80% of the player's maximum health**" — explosives cannot one-shot at full health.

### 5.2 Health regeneration

`[stated]`, MWIII Season 2 official patch notes — the clearest published regen numbers in the series:

> Decreased delay before health regeneration begins from **4 s to 3 s** (−25%).
> Increased health regeneration rate from **40 hp/s to 75 hp/s** (+88%).
> Now, for example, it'll only take **~5 s** to heal from 1 to 150 health, down from the previous **~7.7 s**.

BO6: reported at **3.5 s delay, 40 HP/s**, with the Guardian perk cutting the delay to 1.1 s on an objective and the Stim Shot having a 550 ms animation. `[measured]`, **weak sourcing** — this comes from secondary guide sites, not patch notes, and I could not confirm it. See §9.

**Classic engine** `[stated]`:
- `scr_player_healthregentime "5"` — **5 second** delay
- `hud_healthOverlay_regenPauseTime "8000"` — 8 s HUD pause
- `perk_healthRegenMultiplier "1.5"` (Black Ops)
- CoD4 / World at War behaviour `[measured]`: above 55 HP, **all health restores instantly** 5 s after last damage. At or below 55 HP, health regenerates in **chunks of 10 every 0.05 s** (= 200 HP/s) until full or interrupted. Regeneration is disabled entirely in Hardcore and Old School.

The evolution: classic CoD snapped you back to full; modern CoD made regen a visible, interruptible ~2 s ramp. **Recommendation: 3 s delay, 75 HP/s** (a 100 HP player fully heals in 1.33 s of ramp, 4.33 s total from last hit).

---

## 6. Pacing and space

This section has the weakest sourcing in the document. Read the confidence markers carefully.

### 6.1 Time between engagements

**No published figure exists.** Derived `[estimated]` from stated mode rules:

MWIII Team Deathmatch: **100 kills**, **10 minute** limit, **6v6** (score limit raised from 75 to 100 in the November 15 patch). `[stated]`

If a match runs the full 10 minutes to 100 kills, that is 10 kills/min across 12 players — each player averages 0.83 deaths/min, i.e. **one death every ~72 s** and, symmetrically, one kill every ~72 s. Combining, a player *resolves* an engagement roughly every **36 s**. Most TDM games end faster than the time limit; at 8 minutes the figure drops to **~29 s**. Add the engagements you disengage from or that end in a trade, and the practical rhythm is:

> **An engagement every 25–45 seconds.** `[estimated]`

The derivation is sound but the input assumption (that kills distribute evenly across players) is not — real CoD lobbies are heavily skewed. Treat 25–45 s as the *average* pacing target, not a per-player experience.

### 6.2 Time from spawn to first contact

**No published figure exists.** `[estimated]`: with sprint at ~6.3 m/s and typical 6v6 map dimensions (§6.4), spawn to the contested middle of the map is roughly 30–60 m of travel, giving **5–10 seconds**. Shipment — the series' smallest map — is described as taking "a mere ten seconds" to cross end to end `[measured]`, which bounds the low end.

### 6.3 Engagement distance

This one *is* stated, from the official CoD5 level-design standards `[stated]`:

> SMG distance: **512 units** (13.0 m)
> Rifle distance: **1024 units** (26.0 m)

These are the distances the level designers were told to build sightlines at. They are the most authoritative engagement-distance figures available for the series.

Corroborated by weapon tuning `[stated]`: BO6 SMG max-damage bands end at **11.4–17.1 m**, AR max-damage bands end at **12.7–22.2 m** and medium bands end at **40.6–45.7 m**. The falloff thresholds are placed to make class choice matter at exactly the designed distances.

**Recommendation:** build for 13 m as the SMG-favouring distance, 26 m as the rifle-favouring distance, and treat 40–65 m as the long-sightline case (BO6's LR 7.62 holds max damage to 63.5 m).

### 6.4 Map size

| Map | Size | Confidence |
| --- | --- | --- |
| Nuketown, playspace only | 2,972 m² | `[measured]` — Drift0r's calculation |
| Nuketown, entire map | 4,950 m² | `[measured]` — Drift0r |
| Typical BO6 6v6 map | 2–3× Nuketown | `[measured]` — XclusiveAce, who measured Nuketown and Raid in BO Cold War and scaled BO6 maps against them |
| Shipment | smallest in series; ~10 s to cross | `[measured]`, qualitative |

Derived `[estimated]`: a typical BO6 map at 2–3× Nuketown's 4,950 m² is **10,000–15,000 m²**. If roughly 2:1 in aspect, that is about **140 × 75 m** to **170 × 90 m**, with a longest axis in the **120–170 m** range. Nuketown itself at 4,950 m² and roughly 2:1 is about **100 × 50 m**.

That derivation assumes a rectangular footprint and a 2:1 aspect ratio, neither of which is sourced. Use it to size a prototype, not to make claims.

---

## 7. AI opponents

This section is the strongest-sourced part of the document for *classic* Call of Duty and the weakest for modern, because Infinity Ward and Treyarch shipped mod tools through 2010 and stopped afterwards. Every value below is from a shipped engine config file.

### 7.1 Enemy accuracy against the player

`[stated]`, CoD5 (World at War) dvar defaults:

| Dvar | Value | Meaning |
| --- | --- | --- |
| `ai_playerNearAccuracy` | **0.5** | 50% hit chance at near range |
| `ai_playerNearRange` | 800 u = **20.32 m** | Near range boundary |
| `ai_playerFarAccuracy` | **0.1** | 10% hit chance at far range |
| `ai_playerFarRange` | 2000 u = **50.8 m** | Far range boundary |

This is the whole model: **AI hit chance against the player interpolates from 50% at 20 m down to 10% at 51 m.** It is an explicit dice roll, separate from the AI's aim. Shots that "miss" are deliberately deflected — so yes, CoD AI absolutely does miss on purpose, and the miss rate is a tuned constant, not emergent.

Difficulty presets scale these values. The scaling factors themselves are not in the dvar list; see §9.

### 7.2 The single most important AI constant

`[stated]`, CoD5: `ai_maxAttackerCount "2"`

**Only two AI shoot at the player at a time**, regardless of how many are in the scene. This is the reason a Call of Duty firefight can put a dozen enemies on screen and remain survivable. Everything else — the accuracy roll, the health regen — is secondary to this one clamp.

Also: `ai_threatUpdateInterval "500"` — AI re-evaluate their target every **500 ms**, not every frame. That latency is what gives the player a window to break contact.

### 7.3 AI perception ranges

`[stated]`, CoD5 dvars, converted at 1 u = 0.0254 m. These define what the AI can hear and how far each stimulus propagates:

| Event | Units | Metres |
| --- | --- | --- |
| `ai_eventDistGunShot` | 2048 | **52.0 m** |
| `ai_eventDistSilencedShot` | 128 | **3.25 m** |
| `ai_eventDistDeath` | 1024 | 26.0 m |
| `ai_eventDistExplosion` | 1024 | 26.0 m |
| `ai_eventDistNewEnemy` | 1024 | 26.0 m |
| `ai_eventDistFootstep` | 512 | 13.0 m |
| `ai_eventDistFootstepLite` | 256 | 6.5 m |
| `ai_eventDistGrenadePing` | 512 | 13.0 m |
| `ai_eventDistPain` | 512 | 13.0 m |
| `ai_eventDistProjImpact` | 512 | 13.0 m |
| `ai_eventDistProjPing` | 128 | 3.25 m |
| `ai_eventDistBullet` | 96 | **2.44 m** |
| `ai_eventDistBadPlace` | 256 | 6.5 m |
| `ai_foliageSeeThroughDist` | 128 | 3.25 m |

Note the **16× ratio** between an unsuppressed gunshot (52 m) and a silenced one (3.25 m). That single ratio is the entire stealth system.

`ai_eventDistBullet "96"` is the suppression trigger: a bullet passing within **2.44 m** registers as an event on the AI.

### 7.4 Suppression, cover and flanking

`[stated]`, CoD5 dvars:
- `ai_friendlySuppression "1"` — friendly AI can be suppressed
- `ai_friendlySuppressionDist "128"` = 3.25 m — how close friendly fire must pass to suppress
- `ai_noDodge "0"` — dodging enabled
- `ai_noPathToEnemyGiveupTime "6000"` — after **6 seconds** of being unable to path to the player, the AI gives up and repositions
- `ai_pathMomentum "0.78"` — path smoothing; AI commit to a heading rather than reversing
- `ai_pathNegotiationOverlapCost "300"` — cost penalty for two AI using the same lane, which is what produces spread-out advances rather than conga lines
- `ai_enableBadPlaces "1"` / `ai_eventDistBadPlace "256"` — "bad places" are dynamic no-go volumes (grenades, fire) at 6.5 m radius
- `ai_meleeRange "64"` (1.63 m), `ai_meleeWidth "20"` (0.51 m), `ai_meleeHeight "10"` (0.25 m)
- `ai_corpseCount "5"–"8"` — corpse budget

**Qualitative behaviour** `[measured]`, from modding documentation and analysis: "The Call of Duty engine is heavily data-driven, with much of the gameplay behavior for AI controlled through script — from combat states to animations and one-off vignettes. AI setup files contain character model permutations, weapon loadouts, and **engagement distances for all AI** in the game." Enemies spawn from trigger volumes the player walks through, linked to AI actors that then move to scripted destinations.

Call of Duty campaign AI is widely and fairly criticised as scripted rather than autonomous: "little more than interactive shooting galleries," relying on "scripted events and waypoints to simulate squad behaviour." The tactical *appearance* comes from the level script placing AI at cover points and the `ai_maxAttackerCount "2"` clamp choosing which two of them engage — not from AI agents independently deciding to flank.

**For a three.js implementation this is good news:** the CoD feel is reproducible with a small state machine (idle → alerted → move to cover → engage → suppressed → reposition), an attacker-count clamp of 2, a distance-scaled hit-chance roll, and a 500 ms target-reacquire tick. Nothing here needs behaviour trees or utility AI.

### 7.5 Bot reaction times and behaviour

`[stated]`, Black Ops (CoD7) `sv_bot*` dvars — these govern multiplayer bots and are the only published Call of Duty reaction-time numbers:

| Dvar | Value | Meaning |
| --- | --- | --- |
| `sv_botMinReactionTime` / `sv_botMaxReactionTime` | **500 / 1000 ms** | Sighting → first shot |
| `sv_botMinFireTime` / `sv_botMaxFireTime` | 400 / 600 ms | Burst length before pausing |
| `sv_botMinAdsTime` / `sv_botMaxAdsTime` | 1000 / 1500 ms | How long a bot holds ADS |
| `sv_botFov` | **65°** | Vision cone |
| `sv_botCloseDistance` | 256 u = 6.5 m | "Close" behaviour threshold |
| `sv_botSprintDistance` | 512 u = 13.0 m | Sprints when further than this from its goal |
| `sv_botCrouchDistance` | 32 u = 0.81 m | |
| `sv_botGoalRadius` | 128 u = 3.25 m | Goal-reached tolerance |
| `sv_botMinCrouchTime` / `Max` | 2000 / 4000 ms | |
| `sv_botMinStrafeTime` / `Max` | 3000 / 6000 ms | |
| `sv_botStrafeChance` | 0.1 | 10% chance to strafe |
| `sv_botMinPitchTime` / `Max` | 500 / 1000 ms | |
| `sv_botMinGrenadeTime` / `Max` | 500 / 1000 ms | |
| `sv_botMinDeathTime` / `Max` | 500 / 1000 ms | Delay before a bot reacts to a teammate's death |
| `sv_botYawSpeed` / `sv_botYawSpeedAds` | 4 / 5 | Turn rate (engine units, not degrees) |
| `sv_botPitchSpeed` / `sv_botPitchSpeedAds` | 2 / 5 | |
| `sv_botPitchUp` / `sv_botPitchDown` | −10 / 20 | Aim pitch limits, degrees |
| `sv_botTargetLeadBias` | 4 | Target leading |
| `sv_botAllowGrenades` | 1 | |
| `bot_enemies` / `bot_friends` | 6 / 6 | Default fill |

**The headline number: 500–1000 ms from sighting to first shot.** Compare that to the 200–300 ms TTK in §2 — the player, once *they* see the bot, kills it faster than the bot's own reaction window. That asymmetry is deliberate and is the reason CoD combat feels aggressive rather than defensive. If you want the player to feel like the protagonist, this ratio is the lever.

### 7.6 Difficulty presets — what they actually change

`[measured]`, [CoD Wiki Difficulty Levels](https://callofduty.fandom.com/wiki/Difficulty_Levels). Three variables move across every preset: **enemy accuracy, damage dealt to the player, and the player's health pool.**

| Preset | In-game description | What changes |
| --- | --- | --- |
| **Recruit** | "For players new to first person action games" | Player takes small damage; AI "generally inaccurate"; death extremely unlikely |
| **Regular** | "Your abilities in combat will be tested." | Average damage; AI slightly more accurate than Recruit. The intended baseline. |
| **Hardened** | "Your skills will be strained." | Player has less health; AI "slightly more accurate and effective"; enemies deal more damage |
| **Veteran** | "You will not survive." | "Much more damage and very low health, with enemies having increased accuracy and **deadly reaction time**" |
| **Realism** (MW2019, BOCW, MWII) | — | "Works in similar fashion as the Veteran difficulty but with a limited HUD" |
| **Realistic** (BO3) | "Brutally difficult and entirely unforgiving." | One shot or explosion kills; limited HUD; "AI is said to be independent... more aggressive and smarter than on Veteran" |

Earlier names: Recruit was "Greenhorn" in CoD1/UO and "Easy" in Finest Hour, Big Red One, CoD2 and CoD3.

**The numeric multipliers per preset are not published.** See §9. What *is* certain is which dvars the presets scale — `ai_playerNearAccuracy` / `ai_playerFarAccuracy` for accuracy, and the AI weapons' `playerDamage` field (a separate value from the `damage` used against other AI) `[measured]` for incoming damage.

A defensible preset ladder built from the stated Regular baseline of `nearAccuracy 0.5 / farAccuracy 0.1` and 500–1000 ms reaction `[estimated]`:

| Preset | Near accuracy | Far accuracy | Reaction time | Incoming damage |
| --- | --- | --- | --- | --- |
| Recruit | 0.20 | 0.04 | 900–1500 ms | 0.4× |
| Regular | **0.50** | **0.10** | **500–1000 ms** | 1.0× |
| Hardened | 0.65 | 0.15 | 350–700 ms | 1.5× |
| Veteran | 0.85 | 0.25 | 200–400 ms | 2.5× |

Only the Regular row is sourced. The others are a monotonic ladder I constructed around it and are explicitly a guess — labelled here so nobody mistakes them for measurements.

---

## 8. Source list

**Official / developer**
- [MWIII Launch Patch Notes](https://www.callofduty.com/patchnotes/2023/11/call-of-duty--modern-warfare-iii-launch-patch-notes.html)
- [MWIII Season 1](https://www.callofduty.com/patchnotes/2023/12/call-of-duty-modern-warfare-iii-season-1-patch-notes), [Season 2](https://www.callofduty.com/patchnotes/2024/02/call-of-duty-modern-warfare-iii-season-2-patch-notes), [Season 3](https://www.callofduty.com/patchnotes/2024/04/call-of-duty-modern-warfare-iii-season-3-patch-notes)
- [BO6 Preseason](https://www.callofduty.com/patchnotes/2024/10/bo6-preseason-patch-notes), [Season 01](https://www.callofduty.com/patchnotes/2024/11/call-of-duty-black-ops-6-season-01-patch-notes), [Season 02](https://www.callofduty.com/patchnotes/2025/01/call-of-duty-black-ops-6-season-02-patch-notes)
- [BO7 Preseason Patch Notes](https://www.callofduty.com/patchnotes/2025/11/call-of-duty-black-ops-7-preseason-patch-notes) — aim assist
- [Call of Duty NEXT: BO6 Global Systems](https://www.callofduty.com/blog/2024/08/call-of-duty-next-black-ops-6-reveal-global-systems-key-innovations-announcement) — Omnimovement, tac sprint +1 m/s

**Engine config files (shipped with mod tools)**
- [CoD5 Dvars List](https://wiki.zeroy.com/index.php?title=Call_of_Duty_5:_Dvars_List) — movement, AI, aim assist
- [CoD7 Dvars List](https://wiki.zeroy.com/index.php?title=Call_of_Duty_7:_Dvars_List) — movement, dive, mantle, bots
- [CoD5 Gameplay Standards](https://wiki.zeroy.com/index.php?title=Call_of_Duty_5:_Gameplay_standards) — unit conversion, world dimensions, engagement distances
- [CoD4 stock weapon files (community mirror)](https://github.com/doctorluk/cod4-baserace/tree/master/weapons/mp) — per-weapon handling data

**Community measurement**
- [DenKirson blog — CoD4](http://denkirson.blogspot.com/2012/09/call-of-duty-4_12.html) and [forums](https://denkirson.proboards.com/) — the canonical CoD frame-data source
- [DenKirson forums — sprint-out and ADS times](https://denkirson.proboards.com/thread/6176/sprint-out-times-ads)
- [DenKirson forums — MW2019 damage and RPM](https://denkirson.proboards.com/thread/8482/modern-warfare-2019-gun-damage)
- XclusiveAce (frame-count testing; accessed via [Dexerto](https://www.dexerto.com/call-of-duty/modern-warfare-3-ttk-how-does-it-compare-to-mw2-mw2019-older-cod-games-2328576/)) — cross-title TTK, map size
- Drift0r — Nuketown area calculation
- [wzstats.gg BO6 close-range](https://wzstats.gg/bo6/meta/close-range-meta) and [long-range meta](https://wzstats.gg/bo6/meta/long-range-meta) — per-weapon TTK, ADS, sprint speed
- [Dexerto BO6 TTK rankings](https://www.dexerto.com/call-of-duty/fastest-time-to-kill-weapons-in-black-ops-6-ranked-2968079/)
- [TrueGameData](https://www.truegamedata.com/) — cited by the above as the underlying testing source; the site itself is a JS app and could not be scraped

**Wiki**
- [CoD Wiki — Game Engine Mechanics](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics), [Health System](https://callofduty.fandom.com/wiki/Health_System), [Damage Multiplier](https://callofduty.fandom.com/wiki/Damage_Multiplier), [Difficulty Levels](https://callofduty.fandom.com/wiki/Difficulty_Levels), [Tactical Sprint](https://callofduty.fandom.com/wiki/Tactical_Sprint)

---

## 9. What we cannot source

Everything below is a genuine gap. If a number here appears elsewhere in this project stated as fact, it did not come from research.

**Weapon handling**
- **First-shot recoil multiplier.** Not published for any Call of Duty title, and no such parameter appears in the classic weapon files. CoD's recoil model is per-shot random within min/max bounds with no documented first-shot special case. It is possible the series simply does not have one — but I cannot confirm that either.
- **Recoil recovery time in seconds.** `hipViewKickCenterSpeed` values exist (1500 for the AK-47, 1700 for the MP5 and SAW) but the engine unit is undocumented, so they cannot be converted to a recovery duration.
- **View-kick and gun-kick engine units.** The raw values (e.g. pitch −30 to 60) are known; their relationship to degrees is not.
- **Base reload times for any modern title.** Only percentage deltas and "ammo add times" are published.
- **Empty-reload cancel windows** in CoD4 — the weapon files carry `reloadAddTime` but no `reloadEmptyAddTime`.
- **Shotgun pellet counts and per-pellet spread** — not extracted from the weapon files.
- **Modern aim-assist absolute strengths.** Only the 35%→25% rotational-minimum penalty in BO7 is published. Slowdown and rotation magnitudes for MW2019 onward are not.
- **Bullet magnetism.** Never exposed as a dvar in any published list, and never quantified officially.

**Movement**
- **Acceleration.** No `g_accel` / `pm_accelerate` in either dvar list. The Quake 3 default of 10 (full speed in ~0.1 s) is offered in §4.5 as a labelled guess.
- **Air control.** Not exposed in any published dvar list. Only the qualitative facts that air movement is slowed (`jump_slowdownEnable`) and jump-shooting is penalised (`jump_spreadAdd 64`) are known.
- **Slide duration and slide cooldown for MW2019 / MWII / MWIII / BO6.** I could not find a credible frame count. Black Ops' `dtp_max_slide_duration 300` and `dive_recharge 1000` are for the older dive-to-prone, not the modern slide. The BO6 slide-to-fire figure (330–410 ms) is the best available proxy and is a *weapon* timer, not the slide's length.
- **Slide-cancel window** in modern titles — the mechanic is confirmed to exist and to be intentional in MWIII, but its timing is unpublished.
- **Mantle and vault animation durations.** No absolute figures for any title. Only the geometry constraints and the 500 ms `g_mantleBlockTimeBuffer` are known.
- **Standing player collision height.** The CoD5 standards give crouch (52 u) and prone (32 u) clearances but not standing. The 64 u aim-assist capsule (1.63 m) is a proxy, not the collision hull.

**Survivability and pacing**
- **BO6 health regeneration delay and rate.** The 3.5 s / 40 HP/s figures circulate on secondary guide sites with no citation and do not appear in any BO6 patch note I examined. Treat as unverified.
- **MW2019 and MWII health regeneration values.** Not found.
- **Time between engagements** — no published telemetry. The 25–45 s figure in §6.1 is derived from TDM score and time limits and assumes even kill distribution, which is false in practice.
- **Time from spawn to first contact** — no published figure. The 5–10 s estimate is derived from sprint speed and estimated map size.
- **Map dimensions in metres.** Only Nuketown's *area* has been calculated (by a YouTuber, method not fully documented), and other maps only as a multiple of it. No official map is published with linear dimensions.

**Weapon data quality**
- **MWII (2022) TTK figures.** Only weak aggregator sources found (Kastov 762 ≈ 200 ms, Lachmann-556 ≈ 249 ms). No frame-counted primary source located.
- **MW2019 per-weapon TTK table.** Only the aggregate "200–300 ms, ~4 shots to kill" and "maxed out just below 200 ms" figures. The per-weapon spreadsheets referenced by the community are behind links I could not retrieve.
- **BO6 published fire rates.** Patch notes state fire-rate *changes* (e.g. 300 → 316 RPM) but rarely absolutes. Every BO6 RPM in §2.3 is derived from damage and TTK, and one secondary source contradicts the Kompakt 92 derivation.
- **CoD4 weapon file provenance.** Read from a community mod repository that mirrors the stock files. Four independent cross-checks matched exactly; one (SAW fire rate) disagrees by 1.5%. Allow ±2% on any single value.

**AI**
- **Numeric difficulty multipliers** for Recruit / Regular / Hardened / Veteran / Realism. The dvars the presets scale are known; the scaling factors are not. The ladder in §7.6 is constructed, not measured.
- **Modern (MW2019+) AI parameters of any kind.** Infinity Ward and Treyarch stopped shipping mod tools after Black Ops. Every AI number in §7 comes from 2008–2010 titles. Whether `ai_maxAttackerCount 2` still holds in BO6 is unknown — though the observable behaviour strongly suggests something like it does.
- **Whether campaign AI first shots deliberately miss.** The `ai_playerNearAccuracy` / `ai_playerFarAccuracy` model proves the AI misses *by design at a tuned rate*. It does **not** prove there is a separate "first shots always miss" grace rule, which is a commonly repeated claim I could not substantiate for any title.
