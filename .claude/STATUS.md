# Status (rewrite at every checkpoint; snapshot, not a log; under ~40 lines)

Updated: 2026-11-13 (late evening)

## Now
- **M0 done on this machine**: `node src/cli/main.ts doctor` passes all 6 smoke tests (ffmpeg, sox, rhubarb, inkscape, blender, krita). Outputs eyeballed (cube + Krita stroke OK). Not yet verified on a fresh clone.
- Blender 5.2.4 renders headless with **EEVEE on Intel UHD (OpenGL)**: no CPU fallback needed. Cold first render took 25-100 s (shader compile).
- Spec layer written (src/spec: fields.ts, schema.ts, validate.ts, assets.ts) but has no tests and no assets yet.
- Owner is away and pre-approved running M0-M2 unattended ("until weekly quota is 85%"; I cannot see quota, so stop at checkpoints and when work is done). Pacing decision is in CLAUDE.md.

## Next (M1)
1. Validator unit tests (tests/unit/validate.test.ts).
2. assets/styles/anime-afternoon, assets/locations/sf-rooftops (painted: sky + rooftops layers).
3. toolscripts/krita/paint_background.py, toolscripts/blender/{build_set,animate,render}.py, adapters wiring, `validate/paint/build/render/assemble` commands.
4. M1 acceptance: 5 s, 120 frames, parallax visible; shot-length, empty-frame, repeatable checks pass.

## Open questions / blocked on the user
- (none yet). Car model for M2 will be a CC0 download recorded in assets/ASSETS.md.

## Learned this project (not yet in CLAUDE.md)
- (all recorded in CLAUDE.md Gotchas)
