# Claude of Duty — shared agent brief

You are building one subsystem of a first-person shooter in three.js whose
target is the visual and tactile quality of a modern Call of Duty title.

## Read these first (they are the contract)

- `src/core/Types.ts` — every cross-system interface. **Do not change it.**
- `src/core/Events.ts` — the typed event bus and the full event list.
- `src/core/Engine.ts` — frame loop, system lifecycle, capture mode.
- `src/core/Config.ts` — quality tiers and URL-driven capture flags.
- `src/core/Rand.ts` — deterministic PRNG. Use it for **all** randomness that
  affects world layout, so screenshots reproduce exactly.
- `src/core/Poses.ts` — the fixed camera poses the visual critic grades.
- `src/physics/Physics.ts` — the physics service you call into.

## Hard rules

1. **Only write the files you own.** Another agent is editing every other file
   at the same time. Touching a file you do not own will be overwritten and may
   break the build.
2. **Do not add dependencies.** Available: `three` (0.185), `postprocessing`
   (6.39), `@dimforge/rapier3d-compat` (0.19), `three-mesh-bvh` (0.9). Nothing
   else. No network fetches at runtime — no CDN textures, no external models.
   Every asset must be generated procedurally in code.
3. **Do not edit** `src/main.ts`, `src/core/*`, `src/physics/Physics.ts`,
   `package.json`, `vite.config.ts`, `index.html`, or `tools/*`. Your system is
   already registered in `main.ts`.
4. **Keep the exported class name and its `System` interface conformance
   identical.** Other systems resolve you through `ctx.services`.
5. **It must typecheck.** Run `npx tsc --noEmit` and fix every error your files
   cause before you finish. Ignore errors originating in files you do not own.
6. **Budget matters.** Target 60fps at 1080p on an Apple M-series GPU. Prefer
   instancing, object pooling and shared geometry over per-object allocation.
   Never allocate in the per-frame update path — hoist temporaries to fields.
7. **Determinism.** Seeded `Rand` for anything structural. `Math.random()` is
   allowed only for purely cosmetic jitter that no screenshot depends on.

## Quality bar

The output is graded by a hostile critic that compares rendered frames against
real Call of Duty screenshots. Generic three.js "demo" look fails. Specifically:

- **No flat untextured surfaces.** Every material needs albedo variation,
  roughness variation, and a normal map. Procedural noise, done well.
- **Grounded objects.** Contact shadows and ambient occlusion where objects
  meet. Nothing floating or intersecting.
- **Wear and history.** Real environments are dirty, chipped, stained, uneven.
  Edge wear, grime in crevices, decals, asymmetry.
- **Scale discipline.** 1 unit = 1 metre. Door 2.1m, storey 3.2m, human 1.8m,
  eye height 1.68m. Wrong scale reads as fake instantly.
- **Silhouette and composition.** Poses in `Poses.ts` must frame something
  deliberate — depth layers, leading lines, foreground occluders.

## Verify before you finish

```bash
npx tsc --noEmit          # must be clean for your files
```

Do **not** run `vite build`, `vite preview` or the screenshot harness. Other
agents are running concurrently and would race on `dist/` and on the port.
Integration and visual grading happen centrally once everyone has finished.

Note that `npx tsc --noEmit` will report errors from other agents' files while
they are mid-write. Filter to your own paths and ignore the rest.

Report back: what you built, the key techniques used, anything you could not
finish, and any assumption another system needs to honour.
