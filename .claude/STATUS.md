# Status (rewrite at every checkpoint; snapshot, not a log; under ~40 lines)

Updated: 2026-11-14

## Now
- **M0 done, M1 done** (b4c4c11), **M2 done and verified.** Notes: docs/milestones/M1.md, docs/milestones/M2.md.
- M2: `render`, `check` (15/15 pass), `assemble` (156 frames, 6.50 s, -13.7 LUFS) and tests/e2e/m2.test.ts (4/4) all run; 32 unit tests pass; typecheck clean. Video: projects/m2-street/out/m2-street.mp4, contact sheet out/contact.png.
- Repeatable check now renders frames 1..N in order, one Blender process after the other; adapter tolerates the Intel driver's crash at exit (see CLAUDE.md gotchas).
- Cold render is about an hour on this machine (13 s/frame + ~100 s compile per launch).

## Next
1. Re-run M1 e2e (render/build scripts changed since it passed; ~12 min re-render) and M0 e2e.
2. **Review gate:** M3 starts only after the owner has reviewed M2 (only M0-M2 were pre-approved unattended).
3. M3: camera-clear, motion-speed, loudness checkers; `harness clean`; preview polish.

## Known weak spots
- Looks flat toon, not painted like car.mp4; no characters until M5.
- Smoke fades by scale, not alpha.
