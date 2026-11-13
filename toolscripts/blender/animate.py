"""Stage 4: animate. Creates the camera and keys it for every frame; applies motion blur.

Generic: all behaviour comes from the job. Camera paths are sampled once per frame in Python and keyed
frame by frame, so Blender's interpolation never matters. All noise (shake) comes from job["seed"].

Job: {
  "resultPath", "blend": input.blend, "out": output.blend, "fps", "duration",
  "camera": {move, from, follow, direction, speed, distance, height, side, lens, roll, shake},
  "marks": {name: {position, target}}, "frameHorizon": float|null (0 top .. 1 bottom), "effects": {...}, "seed"
}
Coordinates: Z up, camera at the origin looks along +Y. Drift moves along the camera's right vector.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402
from mathutils import Vector  # noqa: E402

DIRECTIONS = {  # camera-space drift directions: right, up, forward (+Y when looking +Y)
    "right": Vector((1, 0, 0)), "left": Vector((-1, 0, 0)),
    "up": Vector((0, 0, 1)), "down": Vector((0, 0, -1)),
    "forward": Vector((0, 1, 0)), "back": Vector((0, -1, 0)),
}


def resolve_pose(pose, marks):
    if isinstance(pose, str):
        m = marks[pose]
        return Vector(m["position"]), Vector(m["target"])
    return Vector(pose["position"]), Vector(pose["target"])


def look_at_euler(position, target, roll_deg):
    direction = target - position
    quat = direction.to_track_quat("-Z", "Y")
    euler = quat.to_euler()
    # roll about the camera's viewing axis
    rot = quat.to_matrix().to_4x4()
    import mathutils
    roll = mathutils.Matrix.Rotation(math.radians(roll_deg), 4, "Z")
    return (rot @ roll).to_euler()


def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    fps = int(job["fps"])
    frames = int(round(job["duration"] * fps))
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = frames

    cam_spec = job["camera"]
    marks = job.get("marks", {})
    rng = random.Random(int(job["seed"]) ^ 0xCA3E)

    cam_data = bpy.data.cameras.new("camera")
    cam_data.sensor_fit = "AUTO"  # for a landscape frame the angle below is the horizontal field of view
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(cam_spec["lens"])
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0
    fh = job.get("frameHorizon")
    if fh is not None:
        # Lens shift keeps vertical planes vertical while moving the horizon down in frame.
        w, h = scene.render.resolution_x, scene.render.resolution_y
        cam_data.shift_y = (fh - 0.5) * h / max(w, h)
    cam = bpy.data.objects.new("camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    move = cam_spec["move"]
    if move not in ("static", "drift"):
        raise NotImplementedError("camera move '%s' arrives in milestone 2" % move)
    start_pos, start_target = resolve_pose(cam_spec["from"], marks)
    forward = (start_target - start_pos).normalized()
    right = forward.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(forward).normalized()
    drift_dir = DIRECTIONS[cam_spec["direction"]]
    drift_world = right * drift_dir.x + forward * drift_dir.y + up * drift_dir.z
    speed = cam_spec["speed"] if move == "drift" else 0.0
    shake = cam_spec["shake"]

    for f in range(1, frames + 1):
        t = (f - 1) / fps
        pos = start_pos + drift_world * (speed * t)
        tgt = start_target + drift_world * (speed * t)
        roll = cam_spec["roll"]
        if shake > 0:
            pos = pos + Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))) * (0.03 * shake)
            roll += rng.gauss(0, 0.25) * shake
        cam.location = pos
        cam.rotation_euler = look_at_euler(pos, tgt, roll)
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)

    fx = job.get("effects", {})
    blur = float(fx.get("motionBlur", 0.0))
    scene.render.use_motion_blur = blur > 0
    if blur > 0:
        scene.render.motion_blur_shutter = 0.5 * blur  # 0.5 = standard 180 degree shutter at amount 1

    bpy.ops.wm.save_as_mainfile(filepath=job["out"], compress=False)
    hjob.write_result(job, {"frames": frames, "fps": fps})


main()
