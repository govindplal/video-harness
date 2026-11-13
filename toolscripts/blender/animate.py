"""Stage 4: animate. Keys actors, camera and effects for every frame.

Generic: all behaviour comes from the job. Everything is sampled once per frame in Python and keyed frame by frame, so
Blender's interpolation never matters and the result is deterministic. All noise comes from job["seed"].

Job: {
  "resultPath", "blend", "out", "fps", "duration", "seed",
  "camera": {move, from, follow, direction, speed, distance, height, side, lens, roll, shake},
  "marks": {name: {position, target}}, "frameHorizon": float|null, "effects": {smoke, speedLines, motionBlur, tyreMarks},
  "ground": {"plane": [a,b,c]}|null, "palette": {...}, "steps": int,
  "actors": [{"name", "index", "vehicle": {...manifest...}, "path": {...trajectory spec...}, "drift", "action"}]
}
Coordinates: Z up. Result: {"frames", "fps", "camera": [[x,y,z]...], "actors": {name: [[x,y,z,heading,slip,speed]...]}}
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import fx  # noqa: E402
import geo  # noqa: E402
import hjob  # noqa: E402
import motion  # noqa: E402
import toon  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

DIRECTIONS = {  # camera-space drift directions: right, up, forward
    "right": Vector((1, 0, 0)), "left": Vector((-1, 0, 0)),
    "up": Vector((0, 0, 1)), "down": Vector((0, 0, -1)),
    "forward": Vector((0, 1, 0)), "back": Vector((0, -1, 0)),
}


def resolve_pose(pose, marks):
    if isinstance(pose, str):
        m = marks[pose]
        return Vector(m["position"]), Vector(m["target"])
    return Vector(pose["position"]), Vector(pose["target"])


def key(ob, prop, frame):
    ob.keyframe_insert(prop, frame=frame)


# ----------------------------------------------------------------------------- actors

def animate_actor(a, plane, fps, frames, duration):
    v = a["vehicle"]
    name = a["name"]
    root = bpy.data.objects["actor." + name]
    body = bpy.data.objects["actor.%s.body" % name]
    front = [o for o in (bpy.data.objects.get("actor.%s.wheelF%d" % (name, i)) for i in range(4)) if o]
    rear = [o for o in (bpy.data.objects.get("actor.%s.wheelR%d" % (name, i)) for i in range(4)) if o]
    if v["forward"] not in ("-Y", "+Y"):
        raise NotImplementedError("vehicles must have their nose along +Y or -Y (manifest forward), got %s" % v["forward"])
    roll_dir = 1.0 if v["forward"] == "-Y" else -1.0  # which way about X rolls the wheel toward the nose
    traj = motion.Trajectory(a["path"], duration)
    sign = traj.slip_sign()
    radius = v["wheelRadius"] * v["scale"]
    wheelbase = 2.5 * v["scale"]
    states = []
    prev_yaw = None
    for f in range(1, frames + 1):
        t = (f - 1) / fps
        p = motion.pose(traj, t, a["drift"], sign, v["forward"])
        yaw = p["rootYaw"]
        if prev_yaw is not None:
            yaw = prev_yaw + motion.wrap_pi(yaw - prev_yaw)  # keep the angle continuous across +-pi
        prev_yaw = yaw
        z = motion.ground_z(plane, p["x"], p["y"])
        root.location = (p["x"], p["y"], z)
        root.rotation_euler = (0.0, 0.0, yaw)
        key(root, "location", f)
        key(root, "rotation_euler", f)
        spin = roll_dir * p["dist"] / radius
        steer = math.atan(wheelbase * p["curvature"]) - 0.9 * sign * p["slip"]
        steer = max(-0.6, min(0.6, steer))
        for w in front:
            w.rotation_euler = (spin, 0.0, steer)
            key(w, "rotation_euler", f)
        for w in rear:
            w.rotation_euler = (spin, 0.0, 0.0)
            key(w, "rotation_euler", f)
        # The body leans away from the slide a little.
        body.rotation_euler = (0.0, -0.05 * sign * (p["slip"] / motion.MAX_SLIP), 0.0)
        key(body, "rotation_euler", f)
        p.update({"z": z, "yaw": yaw})
        states.append(p)
    return states


def rear_contacts(state, vehicle):
    """World positions where the rear tyres touch the ground."""
    s = vehicle["scale"]
    rz = Matrix.Rotation(state["yaw"], 3, "Z")
    out = []
    for lp in vehicle["rearWheelPositions"]:
        w = rz @ Vector((lp[0] * s, lp[1] * s, 0.0))
        out.append(Vector((state["x"] + w.x, state["y"] + w.y, state["z"])))
    return out


# ----------------------------------------------------------------------------- camera

def build_camera(scene, spec, marks, frames, fps, plane, frame_horizon, seed, follow_states, duration):
    cam_data = bpy.data.cameras.new("camera")
    cam_data.sensor_fit = "AUTO"  # for a landscape frame the angle below is the horizontal field of view
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(spec["lens"])
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0
    if frame_horizon is not None:
        # Lens shift keeps vertical planes vertical while moving the horizon down in frame (painted locations).
        w, h = scene.render.resolution_x, scene.render.resolution_y
        cam_data.shift_y = (frame_horizon - 0.5) * h / max(w, h)
    cam = bpy.data.objects.new("camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_mode = "XYZ"

    rng = random.Random(int(seed) ^ 0xCA3E)
    move = spec["move"]
    dt = 1.0 / fps
    shake = spec["shake"]
    positions = []
    smooth_pos = smooth_tgt = None
    prev_euler = None

    if move in ("static", "drift") or (move == "top-down" and not spec.get("follow")):
        start_pos, start_target = resolve_pose(spec["from"], marks)
        forward = (start_target - start_pos).normalized()
        right = forward.cross(Vector((0, 0, 1)))
        right = right.normalized() if right.length > 1e-6 else Vector((1, 0, 0))
        up = right.cross(forward).normalized()
        dd = DIRECTIONS[spec["direction"]]
        drift_world = right * dd.x + forward * dd.y + up * dd.z
        speed = spec["speed"] if move == "drift" else 0.0
    else:
        st = follow_states[spec["follow"]]

    for f in range(1, frames + 1):
        t = (f - 1) / fps
        up_hint = Vector((0.0, 0.0, 1.0))
        if move in ("static", "drift") or (move == "top-down" and not spec.get("follow")):
            pos = start_pos + drift_world * (speed * t)
            tgt = start_target + drift_world * (speed * t)
            if move == "top-down":
                up_hint = Vector((0.0, 1.0, 0.0))
        else:
            s = st[f - 1]
            car = Vector((s["x"], s["y"], s["z"]))
            h = motion.heading_vec(s["heading"])
            right = Vector((h.y, -h.x, 0.0))
            d, ht, side = spec["distance"], spec["height"], spec["side"]
            tau = 0.2
            if move == "chase":
                pos = car - h * d + right * (side * d)
                pos.z = motion.ground_z(plane, pos.x, pos.y) + ht
                tgt = car + h * 2.5 + Vector((0, 0, 0.9))
            elif move == "track":
                lateral = d * (side if abs(side) > 0.01 else 1.0)
                pos = car + right * lateral
                pos.z = motion.ground_z(plane, pos.x, pos.y) + ht
                tgt = car + Vector((0, 0, 0.8))
                tau = 0.12
            elif move == "orbit":
                theta = side * math.pi / 2 + math.radians(spec["speed"]) * t
                back = -h
                rot = Matrix.Rotation(theta, 3, "Z")
                pos = car + (rot @ back) * d
                pos.z = motion.ground_z(plane, pos.x, pos.y) + ht
                tgt = car + Vector((0, 0, 0.8))
                tau = 0.0
            elif move == "top-down":
                pos = car + Vector((0, 0, ht))
                tgt = car
                up_hint = h
                tau = 0.3
            else:
                raise NotImplementedError("camera move %s" % move)
            if tau > 0 and smooth_pos is not None:
                k = 1.0 - math.exp(-dt / tau)
                smooth_pos = smooth_pos + (pos - smooth_pos) * k
                smooth_tgt = smooth_tgt + (tgt - smooth_tgt) * k
            else:
                smooth_pos, smooth_tgt = pos, tgt
            pos, tgt = smooth_pos, smooth_tgt
        roll = spec["roll"]
        if shake > 0:
            pos = pos + Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))) * (0.03 * shake)
            roll += rng.gauss(0, 0.25) * shake
        m = motion.look_matrix(pos, tgt, up_hint, roll)
        cam.location = pos
        cam.rotation_euler = m.to_euler("XYZ", prev_euler) if prev_euler is not None else m.to_euler("XYZ")
        prev_euler = cam.rotation_euler.copy()
        key(cam, "location", f)
        key(cam, "rotation_euler", f)
        positions.append([round(pos.x, 4), round(pos.y, 4), round(pos.z, 4)])
    return cam, positions


# ----------------------------------------------------------------------------- effects

def fx_collection(scene):
    coll = bpy.data.collections.new("harness_fx")
    scene.collection.children.link(coll)
    # Keep Freestyle outlines off effect planes (they would draw square borders around smoke).
    if scene.render.use_freestyle:
        for ls in scene.view_layers[0].freestyle_settings.linesets:
            ls.select_by_collection = True
            ls.collection = coll
            ls.collection_negation = "EXCLUSIVE"  # lines for everything except the effects collection
    return coll


def add_smoke(scene, cam, cam_positions, coll, actors, states, amount, palette, steps, fps, frames, rng):
    mat = fx.puff_material(palette, mode="maskonly")
    mesh = fx.unit_quad_mesh("puff")
    mesh.materials.append(mat)
    life = max(10, int(fps * (0.8 + 0.7 * amount)))
    per_frame = 1 if amount < 0.9 else 2
    count = 0
    for a in actors:
        sts = states[a["name"]]
        for si, s in enumerate(sts):
            if (s["slip"] < 0.12 * motion.MAX_SLIP and a.get("action") != "burnout") or (si % 2):
                continue
            f0 = si + 1
            contacts = rear_contacts(s, a["vehicle"])
            vel = Vector((math.cos(s["heading"]), math.sin(s["heading"]), 0.0)) * (-s["speed"] * 0.18)
            for ci, c in enumerate(contacts):
                for _ in range(per_frame):
                    ob = bpy.data.objects.new("puff%d" % count, mesh)
                    coll.objects.link(ob)
                    ob["harness_role"] = "effect"
                    ob.rotation_mode = "XYZ"
                    jitter = Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 0.0))
                    side_v = Vector((rng.gauss(0, 0.9), rng.gauss(0, 0.9), 0.0))
                    p0 = c + jitter + Vector((0, 0, 0.25))
                    size0 = rng.uniform(0.3, 0.5)
                    size1 = size0 + rng.uniform(0.7, 1.3) * (0.5 + 0.5 * amount)
                    count += 1
                    # hidden until it spawns, then keyed every 2 frames for its life
                    ob.hide_render = True
                    ob.keyframe_insert("hide_render", frame=max(1, f0 - 1))
                    ob.hide_render = False
                    ob.keyframe_insert("hide_render", frame=f0)
                    last = min(frames, f0 + life)
                    for j in range(0, life + 1, 2):
                        fr = f0 + j
                        if fr > frames:
                            break
                        u = j / life
                        ob.location = p0 + (vel + side_v * 0.5) * (j / fps) + Vector((0, 0, 1.0 * (j / fps)))
                        grow = min(1.0, u / 0.5)
                        sc = (size0 + (size1 - size0) * (1 - (1 - grow) ** 2)) * (1.0 if u < 0.6 else max(0.0, 1.0 - (u - 0.6) / 0.4)) * min(1.0, 0.3 + j / 3.0)
                        ob.scale = (sc, sc, sc)
                        ob.rotation_euler = motion.look_matrix(Vector(cam_positions[min(fr, frames) - 1]), ob.location).to_euler()
                        ob.keyframe_insert("location", frame=fr)
                        ob.keyframe_insert("rotation_euler", frame=fr)
                        ob.keyframe_insert("scale", frame=fr)
                    if last < frames:
                        ob.hide_render = True
                        ob.keyframe_insert("hide_render", frame=last + 1)
    return count


def add_tyre_marks(scene, coll, actors, states, amount, plane, frames):
    """Dark ribbons behind the rear tyres while sliding. The ribbon is built whole; a shader reveals it as the shot plays."""
    mat = bpy.data.materials.new("tyre-marks")
    mat.use_nodes = True
    mat.surface_render_method = "BLENDED"
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    attr = nt.nodes.new("ShaderNodeAttribute"); attr.attribute_name = "birth"; attr.attribute_type = "GEOMETRY"
    now = nt.nodes.new("ShaderNodeValue"); now.name = "now"; now.label = "now"
    visible = nt.nodes.new("ShaderNodeMath"); visible.operation = "LESS_THAN"  # birth < now + 0.5
    plus = nt.nodes.new("ShaderNodeMath"); plus.operation = "ADD"; plus.inputs[1].default_value = 0.5
    alpha = nt.nodes.new("ShaderNodeMath"); alpha.operation = "MULTIPLY"; alpha.inputs[1].default_value = 0.78 * max(0.2, amount)
    emit = nt.nodes.new("ShaderNodeEmission"); emit.inputs["Color"].default_value = toon.hex_rgba("#16171f")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mixs = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(now.outputs[0], plus.inputs[0])
    nt.links.new(attr.outputs["Fac"], visible.inputs[0])
    nt.links.new(plus.outputs["Value"], visible.inputs[1])
    nt.links.new(visible.outputs["Value"], alpha.inputs[0])
    nt.links.new(alpha.outputs["Value"], mixs.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mixs.inputs[1])
    nt.links.new(emit.outputs["Emission"], mixs.inputs[2])
    nt.links.new(mixs.outputs["Shader"], out.inputs["Surface"])
    made = 0
    for a in actors:
        sts = states[a["name"]]
        n_wheels = len(a["vehicle"]["rearWheelPositions"])
        for wi in range(n_wheels):
            verts, faces, birth = [], [], []
            prev = None
            for si, s in enumerate(sts):
                sliding = s["slip"] >= 0.1 * motion.MAX_SLIP or a.get("action") == "burnout"
                p = rear_contacts(s, a["vehicle"])[wi]
                if prev is not None and sliding and prev[2]:
                    d = Vector((p.x - prev[0].x, p.y - prev[0].y, 0.0))
                    if d.length > 1e-4:
                        n = Vector((-d.y, d.x, 0.0)).normalized() * 0.14
                        a0, a1 = prev[0] + n, prev[0] - n
                        b0, b1 = p + n, p - n
                        base = len(verts)
                        for q in (a0, a1, b1, b0):
                            verts.append((q.x, q.y, motion.ground_z(plane, q.x, q.y) + 0.035))
                        faces.append((base, base + 1, base + 2, base + 3))
                        birth += [float(si), float(si), float(si + 1), float(si + 1)]
                prev = (p, s, sliding)
            if not faces:
                continue
            me = bpy.data.meshes.new("tyre-marks")
            me.from_pydata(verts, [], faces)
            me.update()
            at = me.attributes.new("birth", "FLOAT", "POINT")
            for i, bval in enumerate(birth):
                at.data[i].value = bval
            me.materials.append(mat)
            ob = bpy.data.objects.new("tyre-marks.%s.%d" % (a["name"], wi), me)
            coll.objects.link(ob)
            ob["harness_role"] = "effect"
            made += 1
    if made:
        for f in range(1, frames + 1):
            now.outputs[0].default_value = float(f - 1)
            nt.keyframe_insert(data_path='nodes["now"].outputs[0].default_value', frame=f)
    return made


def add_speed_lines(scene, cam, coll, amount, frames, fps, rng):
    """Anime speed lines: thin white streaks radiating from the middle of the frame, flickering every other frame."""
    mat = bpy.data.materials.new("speed-lines")
    mat.use_nodes = True
    mat.surface_render_method = "BLENDED"
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission"); emit.inputs["Color"].default_value = (1, 1, 1, 1)
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mixs = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(fx.fade_socket(nt), mixs.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mixs.inputs[1])
    nt.links.new(emit.outputs["Emission"], mixs.inputs[2])
    nt.links.new(mixs.outputs["Shader"], out.inputs["Surface"])
    mesh = fx.unit_quad_mesh("streak")
    mesh.materials.append(mat)
    depth = 2.5
    half_w = depth * math.tan(cam.data.angle / 2.0)
    half_h = half_w * 9.0 / 16.0
    n = int(8 + 22 * amount)
    for i in range(n):
        ob = bpy.data.objects.new("streak%d" % i, mesh)
        coll.objects.link(ob)
        ob["harness_role"] = "effect"
        ob.parent = cam
        theta = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.55, 0.95) * math.hypot(half_w, half_h)
        length = rng.uniform(0.5, 1.4) * (0.5 + amount)
        ob.location = (r * math.cos(theta), r * math.sin(theta), -depth)
        ob.rotation_euler = (0.0, 0.0, theta)
        ob.scale = (length, 0.012 + 0.02 * rng.random(), 1.0)
        phase = rng.randint(0, 1)
        for f in range(1, frames + 1, 2):
            al = 0.75 * amount if ((f // 2 + phase) % 2 == 0) else 0.0
            ob.color = (al, al, al, 1.0)
            ob.keyframe_insert("color", frame=f)
    return n


# ----------------------------------------------------------------------------- main

def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    fps = int(job["fps"])
    duration = float(job["duration"])
    frames = int(round(duration * fps))
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = frames
    plane = job["ground"]["plane"] if job.get("ground") else [0.0, 0.0, 0.0]
    effects = job.get("effects", {})
    rng = random.Random(int(job["seed"]) ^ 0xF00D)

    states = {}
    for a in job["actors"]:
        states[a["name"]] = animate_actor(a, plane, fps, frames, duration)

    cam, cam_positions = build_camera(scene, job["camera"], job.get("marks", {}), frames, fps, plane, job.get("frameHorizon"),
                                      job["seed"], states, duration)

    counts = {}
    has_actors = bool(job["actors"])
    if (has_actors and (effects.get("smoke", 0) > 0 or effects.get("tyreMarks", 0) > 0)) or effects.get("speedLines", 0) > 0:
        coll = fx_collection(scene)
        if effects.get("smoke", 0) > 0 and has_actors:
            counts["smoke"] = add_smoke(scene, cam, cam_positions, coll, job["actors"], states, effects["smoke"], job["palette"], job["steps"], fps, frames, rng)
        if effects.get("tyreMarks", 0) > 0 and has_actors:
            counts["tyreMarks"] = add_tyre_marks(scene, coll, job["actors"], states, effects["tyreMarks"], plane, frames)
        if effects.get("speedLines", 0) > 0:
            counts["speedLines"] = add_speed_lines(scene, cam, coll, effects["speedLines"], frames, fps, rng)

    blur = float(effects.get("motionBlur", 0.0))
    scene.render.use_motion_blur = blur > 0
    if blur > 0:
        scene.render.motion_blur_shutter = 0.5 * blur  # 0.5 = standard 180 degree shutter at amount 1

    bpy.ops.wm.save_as_mainfile(filepath=job["out"], compress=False)
    hjob.write_result(job, {
        "frames": frames, "fps": fps, "effects": counts, "camera": cam_positions,
        "actors": {n: [[round(s["x"], 3), round(s["y"], 3), round(s["z"], 3), round(s["heading"], 4), round(s["slip"], 4), round(s["speed"], 3)] for s in sts]
                   for n, sts in states.items()},
    })


main()
