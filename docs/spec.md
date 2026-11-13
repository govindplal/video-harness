# Anime Video Harness: Build Spec

Source: build spec by the project owner, 2026-11-13. Reference video the owner wants to approach: `C:/Users/govin/Downloads/car.mp4` (53 s, painted-anime look, green coupe drifting through San Francisco hill streets; characters are out of scope until M5).

## 1. Goal and scope
A command-line harness that turns a shot spec (JSON) into a finished anime-style video by driving Blender, Krita and ffmpeg with no screen attached. The AI's only job is to write and revise the spec; ordinary code does everything else.

Version 1 output: 15-20 s video, 1920x1080, 24 fps, 4-6 shots, painted or toon-shaded environments, one car, camera moves, smoke and motion blur, mixed soundtrack.

Out of scope for v1: character acting and lip sync (M5), any UI beyond the CLI, training a language model, cloud deployment.

Principles:
1. **Spec, not code.** At run time the AI emits spec fields. It never writes Blender or Krita scripts on the fly.
2. **Every stage is cached.** Changing one field re-runs only the stages that depend on it.
3. **Every render is checked.** No output is reported done until the automatic checks pass and a contact sheet exists.

## 2. Architecture
Director (M4, optional) -> Validator -> Planner -> Adapters (Krita, Blender, SoX, ffmpeg) -> Checkers -> Assembler -> Report.

- Orchestrator, validator, planner, checkers, CLI: TypeScript on Node.
- Tool scripts: Python, fixed files in the repo, read a job file, never contain shot-specific logic.
- Boundary rule: adapters are the only code allowed to start a tool.

## 3. Tools
| Tool | Used for | Smoke test |
|---|---|---|
| Blender (LTS) | sets, cars, cameras, toon shading/outlines, Grease Pencil, particles, compositing, rendering | render one 1920x1080 PNG of a cube with no display |
| Krita | painting backgrounds/textures in layers | 2-layer doc, paint one stroke, export PNG + layered file |
| Inkscape | vector titles and overlays | SVG -> PNG |
| ffmpeg | encode, join, subtitles, loudness | encode a 1 s clip with sound |
| SoX | SFX synthesis, simple mixing | 1 s tone as WAV |
| Rhubarb Lip Sync | mouth shapes (M5) | print mouth cues for a short WAV |

Install rules: one install script, official sources only, install into `.tools/`, ask before admin, record version + checksum in `tools.lock.json`, never upgrade a pin unasked, read current docs before writing an adapter. If headless rendering fails: try a virtual display, then Blender's CPU renderer, and report which worked.

## 4. Repo layout
```
CLAUDE.md, tools.lock.json, scripts/install-tools.sh
src/ cli/ spec/ planner/ adapters/ checkers/ assemble/ director/
toolscripts/ blender/ krita/
assets/ vehicles/ locations/ styles/ characters/ sounds/ ASSETS.md
projects/<name>/project.json, projects/<name>/out/
.cache/ (not committed), .tools/ (not committed), tests/
```

## 5. Shot spec
Project fields: `size` (1920x1080 or 1080x1920), `fps` (24), `style` (must exist in assets/styles), `seed` (int), `subtitles` ([start,end,text], inside video), `music` (file or named synthesized bed), `shots` (1-40).

Shot fields: `id`, `duration` (0.3-12 s), `location` {name, time}, `camera` (move: static|drift|track|chase|orbit|top-down; start/end pose or follow target; lens 15-80 deg; roll; shake; speed capped per move), `actors` (asset, name, path = named path or points with times, action, drift amount; path must stay on drivable ground), `effects` (smoke, speedLines, motionBlur, tyreMarks; 0-1), `sound` (cues engine|screech|whoosh|thump|click with start time).

```json
{
  "id": "chase-01",
  "duration": 2.5,
  "location": { "name": "hill-street", "time": "afternoon" },
  "camera": { "move": "chase", "follow": "car", "distance": 7, "height": 2.2, "lens": 50 },
  "actors": [ { "asset": "coupe-green", "name": "car", "path": "lane-right", "speed": 24 } ],
  "effects": { "motionBlur": 0.6 },
  "sound": [ { "cue": "engine", "at": 0, "level": "high" } ]
}
```
Assets are folders with a manifest. Vehicles: model + scale, wheel names, colour slots. Locations: Blender set script or painted background with depth layers; manifest lists named paths and drivable areas. Styles: palette, outline width, shading steps, grain. Named paths keep specs short: the AI picks `lane-right`, it does not invent coordinates.

## 6. Commands
`doctor`, `init <project>`, `validate <project>`, `paint <location>`, `build <project> [shot]`, `preview <project> [shot]`, `render <project> [shot]`, `check <project> [shot]`, `assemble <project>`, `status <project>`.
Exit 0 only on success; on failure one line naming what failed and which spec field. `--json` for machine-readable output. `render`/`assemble` refuse if validate fails. M5 exposes the same ten as MCP tools.

## 7. Stages and caching
1 Paint (Krita) -> 2 Build set -> 3 Place assets -> 4 Animate -> 5 Render (+ ID pass) (Blender) -> 6 Sound (SoX, ffmpeg) -> 7 Assemble (ffmpeg).
Cache key = hash(stage spec fields, input file hashes, tool version from tools.lock.json, tool script hash). Key present in `.cache/` -> skip. Camera speed change re-runs 4+5 for that shot only; subtitle change re-runs 7 only; style change re-runs everything. Deterministic: all randomness from the project seed, no clock, no network.

## 8. Checkers
| Check | Measure | Fails when |
|---|---|---|
| Subject visible | ID-pass pixel count per actor | actor < 0.5% of frame for more than half the shot |
| Ground present | ID-pass ground pixels under each actor | no ground under the actor in any frame |
| Camera clear | camera vs set geometry | camera inside or within 10 cm of an object |
| Frame not empty | image variance + missing-texture colour scan | flat frame or missing textures |
| Motion speed | mean pixel motion between frames | background motion over the cap for that move |
| Shot length | frame count vs duration x fps | differ |
| Loudness | ffmpeg loudnorm on final mix | outside -14 LUFS +/- 1, or true peak > -1 dB |
| Repeatable | render one frame twice, compare hashes | differ |
Report: contact sheet (midpoint frame per shot, labelled) + report.json. Thresholds in one config file.

## 9. Milestones (stop for review after each)
- **M0 Tooling**: install script, tools.lock.json, `doctor`, empty adapters. Accept: doctor passes all six smoke tests.
- **M1 One environment shot**: schema + validator; Krita paints layered sky-and-rooftops; Blender places layers at depths, camera drifts; render + encode. Accept: hand-written spec -> 5 s 1080p clip of exactly 120 frames with visible parallax; shot-length, empty-frame, repeatable checks pass.
- **M2 Car on a 3D street**: scripted hill-street set with toon shading + outlines; one car with path animation; smoke, motion blur, tyre marks; SoX cues; assemble. Accept: 3-shot spec (chase, side drift, top-down) -> one video with sound; subject-visible and ground-present pass on all three.
- **M3 Cache, checks, preview**: stage graph + cache keys; all eight checkers; preview/check/status; contact sheet + report.json. Accept: changing only camera speed re-renders one shot only; car off-screen spec is caught.
- **M4 Director**: brief -> spec via Claude API with schema-constrained output; auto retry on validation/check failure; token use logged. Accept: two-sentence brief -> valid 4-6 shot spec and finished 15-20 s video with no hand edits.
- **M5 Agents and characters**: MCP server for the ten commands; rigged character, walk/sit/wave, face sprites, Rhubarb mouth cues. Accept: agent completes M4 test via MCP alone; one shot of a character walking without foot sliding.
Deliver per milestone: demo video, contact sheet, spec, one-page "what was hard", two weakest things in the output.

## 10. Working rules
Copied into CLAUDE.md.

## 11. Open decisions (defaults in force)
- Machine/OS: the one Claude Code runs on (Windows 11, i7-10750H, Intel UHD only, 16 GB).
- Car model: one freely licensed (CC0) model from a public library, recorded in ASSETS.md.
- Backgrounds: Krita script paints simple skies, clouds, flat shapes; existing images can be imported and layered.
- Director model: current Claude model via API, key from environment (M4 only).
- Blender renderer: real-time (EEVEE) where a graphics context exists, otherwise CPU (Cycles) at low samples.

Known risks: headless Krita/EEVEE may need a display; hand-painted look not promised in v1; characters hardest, last; motion blur ~5x render time; scripting details unverified until M0 smoke tests.
