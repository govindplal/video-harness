"""Stage 3: place assets. Imports each actor's vehicle model, rigs it, recolours it from its manifest and puts it at its start pose.

Rig per actor: an empty `actor.<name>` (root; moved and yawed by animate.py) with children
  `actor.<name>.body`, `.wheelF0/.wheelF1` (front, steer + spin), `.wheelR0` (rear axle, spin).
Wheel pivots are re-centred on the wheel so it can spin about its own axle (the model has every origin at 0,0,0).

Job: {
  "resultPath", "blend", "out", "duration",
  "palette": {...time-of-day palette...}, "steps": int, "ground": {"plane": [a, b, c]},
  "actors": [{"name", "index", "modelPath", "vehicle": {...manifest...}, "path": {...trajectory spec...}, "drift": float}]
}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402
import motion  # noqa: E402
import toon  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402


def material_color(mat, fallback=(0.5, 0.5, 0.5, 1.0)):
    if mat and mat.use_nodes:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            return tuple(bsdf.inputs["Base Color"].default_value)
    return fallback


def apply_transform(ob):
    """Bake the object's transform into its mesh so the origin can be moved freely."""
    me = ob.data
    me.transform(ob.matrix_world)
    ob.matrix_world = Matrix.Identity(4)


def recentre(ob):
    """Move the origin to the centre of the mesh's bounding box (so a wheel rotates about its own axle)."""
    vs = [v.co for v in ob.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    c = (lo + hi) / 2.0
    ob.data.transform(Matrix.Translation(-c))
    ob.location = c


def find_new(objs, base_name):
    for ob in objs:
        if ob.name == base_name or ob.name.startswith(base_name + "."):
            return ob
    raise KeyError("model has no object named %s (found: %s)" % (base_name, ", ".join(o.name for o in objs)))


def place_actor(scene, a, palette, steps, plane, duration):
    v = a["vehicle"]
    name = a["name"]
    tint = toon.hex_rgba(palette["shade"])
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=a["modelPath"])
    new = [o for o in scene.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]

    root = bpy.data.objects.new("actor." + name, None)
    root.empty_display_type = "ARROWS"
    scene.collection.objects.link(root)
    root["harness_role"] = "actor"
    root["harness_actor"] = name
    root["harness_actor_index"] = int(a["index"])

    for ob in meshes:
        apply_transform(ob)

    body = find_new(meshes, v["body"])
    wheels_f = [find_new(meshes, n) for n in v["wheels"]["front"]]
    wheels_r = [find_new(meshes, n) for n in v["wheels"]["rear"]]
    for i, w in enumerate(wheels_f):
        recentre(w)
        w.name = "actor.%s.wheelF%d" % (name, i)
    for i, w in enumerate(wheels_r):
        recentre(w)
        w.name = "actor.%s.wheelR%d" % (name, i)
    body.name = "actor.%s.body" % name

    # Materials: manifest colour slots override; light materials glow; everything else keeps its own colour. All toon.
    slot_color = {v["colourSlots"][k]: toon.hex_rgba(c) for k, c in v["colors"].items() if k in v["colourSlots"]}
    made = {}

    def toon_for(src):
        key = src.name if src else "none"
        if key in made:
            return made[key]
        base = slot_color.get(key, material_color(src))
        if key == "Headlights":
            m = toon.toon_material("actor.%s.%s" % (name, key), base, tint, steps, emission=(1.0, 0.85, 0.5, 1.0))
        elif key == "TailLights":
            m = toon.toon_material("actor.%s.%s" % (name, key), base, tint, steps, emission=(1.0, 0.12, 0.1, 1.0))
        else:
            m = toon.toon_material("actor.%s.%s" % (name, key), base, tint, steps)
        made[key] = m
        return m

    for ob in meshes:
        for slot in ob.material_slots:
            slot.material = toon_for(slot.material)
        ob.parent = root
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob["harness_role"] = "actor"
        ob["harness_actor"] = name
        ob["harness_actor_index"] = int(a["index"])
        ob.rotation_mode = "XYZ"
    # Any non-mesh leftovers from the import (empties, cameras) are not part of the rig.
    for ob in new:
        if ob.type != "MESH":
            bpy.data.objects.remove(ob, do_unlink=True)

    root.scale = (v["scale"],) * 3
    traj = motion.Trajectory(a["path"], duration)
    p = motion.pose(traj, 0.0, a["drift"], traj.slip_sign(), v["forward"])
    root.location = (p["x"], p["y"], motion.ground_z(plane, p["x"], p["y"]))
    root.rotation_euler = (0.0, 0.0, p["rootYaw"])
    return {"name": name, "objects": [o.name for o in meshes], "start": [p["x"], p["y"]], "yaw": p["rootYaw"]}


def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    plane = job["ground"]["plane"] if job.get("ground") else [0.0, 0.0, 0.0]
    placed = [place_actor(scene, a, job["palette"], job["steps"], plane, job["duration"]) for a in job["actors"]]
    bpy.ops.wm.save_as_mainfile(filepath=job["out"], compress=False)
    hjob.write_result(job, {"actors": placed})


main()
