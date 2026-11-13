// The project spec: every field with its type, default and range (spec section 5).
// Cross-field and asset checks live in validate.ts.
import type { Field } from "./fields.ts";

export const CAMERA_MOVES = ["static", "drift", "track", "chase", "orbit", "top-down"] as const;
export const TIMES_OF_DAY = ["morning", "noon", "afternoon", "golden", "dusk", "night"] as const;
export const SOUND_CUES = ["engine", "screech", "whoosh", "thump", "click"] as const;
export const ACTIONS = ["drive", "drift", "burnout", "idle", "brake", "launch"] as const;
export const DIRECTIONS = ["right", "left", "up", "down", "forward", "back"] as const;
export const LEVELS = ["low", "mid", "high"] as const;
export const SIZES = ["1920x1080", "1080x1920"] as const;
export const ENGINES = ["auto", "eevee", "cycles"] as const;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const pose: Field = {
  kind: "oneOf",
  doc: "Camera pose: a named mark from the location manifest, or an explicit position and look-at target in metres.",
  options: [
    { kind: "string", pattern: ID, doc: "Name of a camera mark in the location manifest" },
    {
      kind: "object", doc: "Explicit pose",
      fields: {
        position: { kind: "vec3", min: -2000, max: 2000, doc: "Camera position [x, y, z] in metres" },
        target: { kind: "vec3", min: -2000, max: 2000, doc: "Point the camera looks at [x, y, z] in metres" },
      },
    },
  ],
};

export const cameraField: Field = {
  kind: "object",
  doc: "Camera move for the shot",
  fields: {
    move: { kind: "string", enum: CAMERA_MOVES, doc: "Move type" },
    from: { ...pose, optional: true, doc: "Start pose (required for static and drift; optional centre for orbit/top-down)" },
    follow: { kind: "string", pattern: ID, optional: true, doc: "Actor name to follow (required for track, chase, orbit; optional for top-down)" },
    direction: { kind: "string", enum: DIRECTIONS, default: "right", doc: "Drift direction in camera space" },
    speed: { kind: "number", min: 0, max: 90, default: 0.5, doc: "Drift: metres per second. Orbit: degrees per second. Capped per move type." },
    distance: { kind: "number", min: 1, max: 60, default: 7, doc: "Distance from the followed actor in metres (track, chase, orbit)" },
    height: { kind: "number", min: 0.2, max: 120, default: 2.2, doc: "Height above the followed actor or ground in metres (top-down: at least 8)" },
    side: { kind: "number", min: -1, max: 1, default: 0, doc: "Sideways offset as a fraction of distance: -1 left, 1 right" },
    lens: { kind: "number", min: 15, max: 80, default: 50, doc: "Horizontal field of view in degrees" },
    roll: { kind: "number", min: -30, max: 30, default: 0, doc: "Camera roll in degrees" },
    shake: { kind: "number", min: 0, max: 1, default: 0, doc: "Handheld shake amount" },
  },
};

const pathPoint: Field = {
  kind: "object", doc: "A timed point on an explicit actor path",
  fields: {
    at: { kind: "number", min: 0, max: 12, doc: "Time in seconds from shot start" },
    x: { kind: "number", min: -2000, max: 2000, doc: "Ground x in metres" },
    y: { kind: "number", min: -2000, max: 2000, doc: "Ground y in metres" },
  },
};

export const actorField: Field = {
  kind: "object",
  doc: "A vehicle (characters arrive in milestone 5)",
  fields: {
    asset: { kind: "string", pattern: ID, doc: "Vehicle asset name in assets/vehicles" },
    name: { kind: "string", pattern: ID, doc: "Name used by camera.follow and the checkers" },
    path: {
      kind: "oneOf", doc: "Named path from the location manifest, or explicit timed points",
      options: [
        { kind: "string", pattern: ID, doc: "Named path" },
        { kind: "array", items: pathPoint, minItems: 2, maxItems: 64, doc: "Explicit timed points" },
      ],
    },
    speed: { kind: "number", min: 0, max: 70, default: 15, doc: "Speed along a named path in metres per second" },
    start: { kind: "number", min: 0, max: 5000, default: 0, doc: "Start distance along the named path in metres" },
    action: { kind: "string", enum: ACTIONS, default: "drive", doc: "Named action" },
    drift: { kind: "number", min: 0, max: 1, default: 0, doc: "Drift (slip) amount: 1 = 45 degree slide" },
  },
};

export const effectsField: Field = {
  kind: "object", doc: "Effect amounts, 0 = off",
  fields: {
    smoke: { kind: "number", min: 0, max: 1, default: 0, doc: "Tyre smoke" },
    speedLines: { kind: "number", min: 0, max: 1, default: 0, doc: "Anime speed lines" },
    motionBlur: { kind: "number", min: 0, max: 1, default: 0, doc: "Motion blur (shutter fraction)" },
    tyreMarks: { kind: "number", min: 0, max: 1, default: 0, doc: "Tyre marks left on the road" },
  },
};

export const soundCueField: Field = {
  kind: "object", doc: "A named sound cue",
  fields: {
    cue: { kind: "string", enum: SOUND_CUES, doc: "Cue name" },
    at: { kind: "number", min: 0, max: 12, default: 0, doc: "Start time in seconds from shot start" },
    level: { kind: "string", enum: LEVELS, default: "mid", doc: "Loudness" },
    length: { kind: "number", min: 0.05, max: 12, optional: true, doc: "Length in seconds (default depends on cue)" },
  },
};

export const shotField: Field = {
  kind: "object", doc: "One shot",
  fields: {
    id: { kind: "string", pattern: ID, doc: "Unique shot id" },
    duration: { kind: "number", min: 0.3, max: 12, doc: "Length in seconds" },
    location: {
      kind: "object", doc: "Where the shot happens",
      fields: {
        name: { kind: "string", pattern: ID, doc: "Location asset name in assets/locations" },
        time: { kind: "string", enum: TIMES_OF_DAY, default: "afternoon", doc: "Time of day" },
      },
    },
    camera: cameraField,
    actors: { kind: "array", items: actorField, minItems: 0, maxItems: 4, default: [], doc: "Actors in the shot" },
    effects: effectsField,
    sound: { kind: "array", items: soundCueField, minItems: 0, maxItems: 16, default: [], doc: "Sound cues" },
  },
};

export const projectField: Field = {
  kind: "object", doc: "A video project",
  fields: {
    name: { kind: "string", maxLength: 80, optional: true, doc: "Display name" },
    size: { kind: "string", enum: SIZES, default: "1920x1080", doc: "Output resolution" },
    fps: { kind: "number", min: 24, max: 24, integer: true, default: 24, doc: "Frame rate (24 only in v1)" },
    style: { kind: "string", pattern: ID, doc: "Style profile name in assets/styles" },
    seed: { kind: "number", min: 0, max: 2147483647, integer: true, default: 1, doc: "Seed for all randomness" },
    subtitles: {
      kind: "array", minItems: 0, maxItems: 100, default: [], doc: "Subtitles",
      items: {
        kind: "object", doc: "One subtitle",
        fields: {
          start: { kind: "number", min: 0, max: 480, doc: "Start time in seconds" },
          end: { kind: "number", min: 0, max: 480, doc: "End time in seconds" },
          text: { kind: "string", maxLength: 120, doc: "Text" },
        },
      },
    },
    music: { kind: "string", maxLength: 200, default: "none", doc: "Named synthesized bed (none, drive-pulse) or a sound file in assets/sounds" },
    render: {
      kind: "object", doc: "Render settings",
      fields: {
        engine: { kind: "string", enum: ENGINES, default: "auto", doc: "auto = whatever harness doctor found works headless" },
        samples: { kind: "number", min: 1, max: 256, integer: true, default: 16, doc: "Anti-aliasing samples per pixel" },
        previewScale: { kind: "number", min: 0.25, max: 1, default: 0.5, doc: "Resolution scale for harness preview" },
      },
    },
    shots: { kind: "array", items: shotField, minItems: 1, maxItems: 40, doc: "Ordered shots" },
  },
};

// Types of a validated (defaults applied) spec.
export type Vec3 = [number, number, number];
export type Pose = string | { position: Vec3; target: Vec3 };
export interface Camera {
  move: (typeof CAMERA_MOVES)[number];
  from?: Pose;
  follow?: string;
  direction: (typeof DIRECTIONS)[number];
  speed: number;
  distance: number;
  height: number;
  side: number;
  lens: number;
  roll: number;
  shake: number;
}
export interface PathPoint { at: number; x: number; y: number }
export interface Actor {
  asset: string;
  name: string;
  path: string | PathPoint[];
  speed: number;
  start: number;
  action: (typeof ACTIONS)[number];
  drift: number;
}
export interface Effects { smoke: number; speedLines: number; motionBlur: number; tyreMarks: number }
export interface SoundCue { cue: (typeof SOUND_CUES)[number]; at: number; level: (typeof LEVELS)[number]; length?: number }
export interface Shot {
  id: string;
  duration: number;
  location: { name: string; time: (typeof TIMES_OF_DAY)[number] };
  camera: Camera;
  actors: Actor[];
  effects: Effects;
  sound: SoundCue[];
}
export interface Subtitle { start: number; end: number; text: string }
export interface Project {
  name?: string;
  size: (typeof SIZES)[number];
  fps: number;
  style: string;
  seed: number;
  subtitles: Subtitle[];
  music: string;
  render: { engine: (typeof ENGINES)[number]; samples: number; previewScale: number };
  shots: Shot[];
}

/** Per-move speed caps (drift m/s, orbit deg/s). Other moves follow an actor and ignore speed. */
export const SPEED_CAPS: Partial<Record<Camera["move"], number>> = { drift: 4, orbit: 90 };
