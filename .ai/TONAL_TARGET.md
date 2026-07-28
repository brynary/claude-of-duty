# Tonal target — measured, not described

Three rounds oscillated between "washed out" and "crushed" because each round
was handed a *direction to move* rather than a *target to hit*. Round 1 was
told it was washed out, so round 2 crushed the blacks. Round 2 was told the
blacks were crushed, so round 3 washed it out again — and lost the white point
and the near-field clarity as well.

`node tools/analyze.mjs shots/<dir>` measures a shot directory. Hit these
numbers. Do not move a value "in the right direction"; land it inside range.

| Metric | Target | iter1 | iter2 | iter3 |
|---|---|---|---|---|
| `mean` luma | 32–55 | 116 HIGH | 57 | 75 HIGH |
| `std` (global contrast) | 45–65 | 39 LOW | 50 ok | 39 LOW |
| `pctBelow8` (true blacks) | 1.5–10 | 0 LOW | 25.9 HIGH | 0.42 LOW |
| `pctAbove247` (true whites) | 0.05–3 | 0.56 ok | 1.43 ok | 0.41 ok |
| `max` (white point) | 250–255 | 252 ok | 248 | 236 LOW |
| `localContrast` | 0.030–0.070 | 0.017 LOW | 0.020 LOW | 0.017 LOW |
| `nearFieldLift` (near haze) | 0–0.06 | 0.157 HIGH | 0.012 ok | 0.114 HIGH |

## What each metric means

- **`mean`** — average luma of the frame with HUD margins excluded. A
  late-afternoon exterior with real shadow sits well below mid-grey.
- **`std`** — global spread. This is "does the frame use its range".
- **`pctBelow8` / `pctAbove247`** — the frame must contain *some* true black and
  *some* true white, but neither may dominate. Both prior failures live here:
  iter2 put a quarter of the frame at black, iter1 and iter3 had none at all.
- **`max`** — the brightest pixel. Below 250 means the frame never reaches
  white, which reads as veiled. Speculars and the sun must clip.
- **`localContrast`** — mean absolute deviation within 8px blocks. This is the
  numeric form of "micro-contrast", "surface relief" and "texel density".
  **It has been roughly half target in every single round.** No amount of tone
  curve fixes it — it comes from material detail and geometric detail. This is
  now the most valuable number on the page.
- **`nearFieldLift`** — the 2nd-percentile luma of the closest ground. High
  means haze is veiling geometry a few metres from the camera, which a judge
  described as "a uniform milky haze applied even at two metres". Distance
  haze belongs in the distance.

## Every pose must comply, not the average

Iteration 5 landed all seven metrics in range **on the mean across the eight
poses** and still drew 17 separate shadow-crush complaints from blind judges.
Averaging hid it: the poses that crush are averaged against poses that do not.

A metric is only satisfied when **every pose** is inside range. Read the
per-pose rows in `analyze.mjs`, not the MEAN row. Judges measuring whole frames
rather than the analysed crop reported figures as extreme as "42% of pixels
below 4/255 and 76% below 8/255 — that is destroyed data, not compressed
shadow" on individual poses whose averaged numbers looked acceptable.

## The rule for this round

`localContrast` and `std` must both come up while `nearFieldLift` comes down.
Those three moving together is the difference between a graded frame and a
detailed one. If you find yourself trading one against another, you are tuning
the curve when you should be adding detail.
