# Status (rewrite at every checkpoint; snapshot, not a log; under ~40 lines)

Updated: 2026-11-14

## Now
- **M0 done, M1 done** (committed b4c4c11). M1 deliverables in docs/milestones/M1.md.
- **M2 code complete, not yet rendered/verified.** Written and smoke-tested with single frames (dev-street project): street set builder (sets/street.py), car placement (place_assets.py), animate.py (drift, chase/track/orbit/top-down cameras, smoke puffs, tyre marks, speed lines, motion blur), ID pass (id_pass.py), checkers subject-visible/ground-present (src/checkers/idpass.ts), sound (src/adapters/audio.ts, src/pipeline/sound.ts), assemble with music bed, subtitles, loudnorm. Spec: projects/m2-street (3 shots, 6.5 s). e2e: tests/e2e/m2.test.ts (never run).
- **The full M2 render was killed by Claude Code for low system memory** (not a harness error). Cache state: chase-01 animated, drift-02/top-03 built. Rerun `node src/cli/main.ts render m2-street` (resumes from cache) only when memory allows; consider closing other apps first.
- Measured: set renders ~13 s/frame at 1080p/8 spp + ~100 s first-frame compile per Blender launch (OpenGL and Vulkan alike; --gpu-compilation-subprocesses does not help).

## Next
1. `render m2-street`, then `check`, `assemble`, `node --test tests/e2e/m2.test.ts`; eyeball contact.png and the mp4; write docs/milestones/M2.md; commit.
2. Re-run M1 e2e (render/build scripts changed, so M1 re-renders ~12 min).
3. Smoke puffs: verify the 0.2 disc threshold looks round (last frame showed square puffs at 0.39).

## Gotchas found in M2 (add to CLAUDE.md)
- Object Info Color/Alpha fades and Attribute(Object) custom props were unreliable for per-object alpha in EEVEE here; smoke now fades by scale with constant-alpha material.
- Track-To constraint billboards did not render; puffs are now keyed to face the camera per frame.
- Freestyle draws lines through geometry below the ground: building boxes now follow the ground plane.
- Freestyle lineset attr is `collection_negation = "EXCLUSIVE"` (not exclude_collection).
