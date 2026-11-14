# harness

Command-line harness that turns a shot spec (`projects/<name>/project.json`) into a finished anime-style video by driving Blender, Krita, SoX and ffmpeg headless. The AI only writes and revises the spec; fixed code does everything else. Full build spec: `docs/spec.md` (read the section you need, not the whole file).

## Architecture (non-negotiable principles)
- **Spec, not code.** At run time the AI emits spec fields. It never writes Blender/Krita scripts on the fly.
- **Every stage is cached.** Cache key = hash(stage spec fields, input file hashes, tool version, tool script hash). One field change re-runs only dependent stages.
- **Every render is checked.** Nothing is reported done until checks pass and a contact sheet exists.
- Flow: validator -> planner -> adapters -> checkers -> assembler -> report. **Adapters (`src/adapters/`) are the only code that starts a tool.**
- Tool scripts (`toolscripts/`) are fixed Python files that read a job JSON. No shot-specific logic in them.

## Built vs still to build
See `.claude/STATUS.md`. Milestones M0-M5 are in `docs/spec.md` section 9.

## Stack (decided)
- Orchestrator/CLI/checkers: TypeScript run directly by Node 25 (type stripping; erasable syntax only: no enums, no parameter properties, no namespaces). `tsc --noEmit` for type checks. Tests: `node --test`.
- Tool scripts: Python inside Blender 5.2 LTS and Krita 5.3. Image analysis: decode frames to raw RGB through the ffmpeg adapter (no image npm packages).
- Tools pinned in `tools.lock.json`, installed in `.tools/` by `scripts/install-tools.sh`.

## Commands
- CLI: `node src/cli/main.ts <command> [args] [--json]` (also `npm run harness -- <command>`)
- Test: `npm test`
- Typecheck: `npm run typecheck`

## Working rules (from spec section 10)
Safety and installs
- Ask before anything that needs admin rights, installs outside the repo, or downloads more than 1 GB.
- Download tools only from the official sources in spec section 3. No mirrors.
- Assets: CC0 (or equivalent, reuse without conditions) only; record source and licence of each in `assets/ASSETS.md`.
- Never commit tool binaries, caches or rendered frames.

How to build
- Follow the milestone order. Don't start a milestone until the previous one is reviewed (owner pre-approved running M0-M2 unattended on 2026-11-13).
- Read each tool's current scripting docs before writing its adapter.
- Tool scripts stay generic. A shot needing something new gets a spec field handled in the script, never a one-off script.
- Every new spec field gets a type, a default, a range and a validator test.
- Each milestone gets an end-to-end test that runs its acceptance test.

How to report
- Don't say a render works without opening its contact sheet and checking the frames.
- When a check fails: report check, shot and spec field, then fix the cause. Never loosen a threshold to make a check pass.
- Same fix fails three times: stop and ask.
- Same visual bug appears twice: add a checker for it.

## Gotchas
- Machine: Windows 11, i7-10750H, 16 GB, Intel UHD only (no NVIDIA). Blender EEVEE works headless on it (OpenGL); cold first render is slow (shader compile).
- **Krita headless (kritarunner) can hang forever on a modal dialog.** `doc.exportImage()` to PNG opens a "PNG image" options window; the process then sits idle (CPU flat). Write PNGs with Qt (`QImage.save` from `doc.projection`) and keep batch mode on (the shim does). Never set `QT_QPA_PLATFORM` (empty hangs, `offscreen` segfaults). Diagnose a hang by listing the process's windows, not by guessing.
- Krita `createDocument` adds a default "Background" layer: reuse it, don't `remove()` it.
- kritarunner.exe is slow to exit; the adapter kills it 10 s after the result file appears.
- Rhubarb 1.14: do NOT pass `--quiet` (it also suppresses the JSON on stdout).
- Piping an installer through `| tail` hides its exit code; redirect to a file and check `$?`.
- **Blender stamps metadata into PNGs by default** (Date, RenderTime, absolute .blend path), so identical pixels gave different files and the repeatable check failed. `toolscripts/blender/render.py` turns every `use_stamp*` off. If repeatable fails again, compare `harness`'s pixel hash first (the check reports whether pixels or only file bytes differ).
- First Blender frame of every launch costs ~96 s (EEVEE shader compile); later frames ~4 s at 1080p/16 spp. Render in one process (`animation=True`), never one process per frame.
- Never start a harness run with a shell `&`, and never run two harness commands that share a stage at once: the cache has per-key locks, but a backgrounded run that outlives its shell is hard to reason about. Use the Bash tool's background mode with a single command.
- Heredocs in this shell halve backslashes (`\\` became `\`). Write code with Write/Edit, not `cat <<EOF`.
- `rm -rf` is denied by project settings; the cache code deletes its own temp dirs.
- **Blender 3D-set gotchas (M2).** Object Info Color/Alpha and Attribute(Object) custom props were unreliable for per-object alpha in EEVEE: fade by scale with a constant-alpha material. Track-To billboards did not render: key rotation per frame. Freestyle draws lines through geometry below the ground: make building boxes follow the ground plane. Freestyle lineset attr is `collection_negation = "EXCLUSIVE"`.
- **Intel GPU limits.** Two Blender processes at once slow each other ~7x (13 s to 95 s per frame): run them one after another. The Intel OpenGL driver can crash (0xC0000005 in `ig9icd64.dll`) during Blender's exit after the result is written; the adapter keeps a result only if the log shows "Blender quit" and a fresh result file exists.
- The repeatable check renders frames 1..N in order, not frame N alone: a lone frame differed from the full render's frame by 1/255 on a couple of pixels.
- Inkscape MSI is extracted with `msiexec /a` (no admin, no registry); files land under `.tools/inkscape/PFiles64/`.
- Git Bash: pass `MSYS_NO_PATHCONV=1` when a Windows exe takes `/flag` arguments (msiexec).

## Workflow
- Explore and plan before non-trivial edits; use `/start-feature` and `/fix-bug`, and `/wrap-up` to end a session.
- Run tests and typecheck and report real results before calling work done.
- **Ship every checkpoint:** commit after each completed milestone step. No remote yet (ask before adding one).

## Current status
@.claude/STATUS.md
