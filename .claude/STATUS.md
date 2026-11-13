# Status (rewrite at every checkpoint; snapshot, not a log; under ~40 lines)

Updated: 2026-11-14 (morning)

## Now
- **M0 done** (doctor passes 6/6). **M1 done and verified**: `projects/m1-rooftops` -> 5.000 s, 120 frames, 1080p; checks shot-length / frame-not-empty / repeatable all PASS; e2e `tests/e2e/m1.test.ts` 5/5; unit 32/32. Deliverables in `docs/milestones/M1.md` + `projects/m1-rooftops/out/` (mp4, contact.png, report.json). Eyeballed.
- **M2 started** (not runnable yet): car asset chosen and in repo (`assets/vehicles/coupe-green`: Quaternius CC0 sports car, recorded in assets/ASSETS.md; measured: forward is -Y, wheel radius 0.28, wheel meshes named in vehicle.json). Written but NEVER RUN: `toolscripts/blender/toon.py` (toon material, window-wall material, Freestyle outlines, sun, sky). Nothing else for M2 exists yet.
- Owner away, pre-approved M0-M2 unattended ("until weekly quota is 85%"; I cannot see quota).

## Next (M2: car on a 3D street) - do in this order, test each piece with a small render
1. `assets/locations/hill-street/location.json` (kind "set", ground plane, named paths lane-right / junction-right, marks, drivable polygons) + generic `toolscripts/blender/sets/street.py` builder called from build_set.py for kind "set". Include palette[time] in the build key (src/pipeline/shot.ts shotKeys) and keep render.py's shadow/raytracing off only for painted (unlit) scenes (scene["harness_unlit"]).
2. `place_assets.py` (import glb, rig root empty `actor.<name>`, wheel pivots re-centred, recolour via colourSlots, toon materials) as stage 3.
3. `motion.py` + extend `animate.py`: path sampling, drift slip, wheel spin/steer, cameras chase/track/orbit/top-down, smoke puffs (python-keyed billboards), tyre-mark ribbons, motion blur.
4. `id_pass.py` (Workbench flat object colours, actor / ground / other, effects hidden) in the render stage -> checkers subject-visible and ground-present (config/checks.json has thresholds).
5. Sound: SoX cue synthesis + ffmpeg mix per shot, music bed "drive-pulse", subtitles + loudnorm in assemble (assemble currently refuses subtitles/music/sound with a clear error).
6. 3-shot spec (chase, side drift, top-down) + `tests/e2e/m2.test.ts` + `docs/milestones/M2.md`.

## Open questions / blocked on the user
- None. Reference video (car.mp4) has characters and a painted look; v1 scope is car + street only (spec).

## Learned this project (all recorded in CLAUDE.md Gotchas)
- Krita modal dialog hang; cache race; Blender PNG metadata; per-layer parallax measuring.
