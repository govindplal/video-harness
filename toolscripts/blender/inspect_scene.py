"""Developer aid: summarise objects of a scene at a given frame (position, scale, colour, visibility).

Job: {"resultPath", "blend", "frame", "prefix": "puff", "limit": 12}
Result: {"total": n, "visibleAtFrame": n, "samples": [...], "camera": {...}}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402


def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    scene.frame_set(int(job["frame"]))
    dg = bpy.context.evaluated_depsgraph_get()
    objs = [o for o in scene.objects if o.name.startswith(job["prefix"])]
    visible = [o for o in objs if not o.hide_render]
    samples = []
    for o in visible[: int(job.get("limit", 12))]:
        ev = o.evaluated_get(dg)
        samples.append({
            "name": o.name, "world": [round(v, 2) for v in ev.matrix_world.translation], "scale": [round(v, 2) for v in ev.scale],
            "color": [round(v, 2) for v in o.color], "hide_render": o.hide_render,
            "materials": [m.name for m in o.data.materials] if o.type == "MESH" else [],
        })
    cam = scene.camera
    in_view = []
    if cam is not None:
        from bpy_extras.object_utils import world_to_camera_view
        for o in visible:
            c = world_to_camera_view(scene, cam, o.evaluated_get(dg).matrix_world.translation)
            if 0.0 <= c.x <= 1.0 and 0.0 <= c.y <= 1.0 and c.z > 0:
                in_view.append({"name": o.name, "uv": [round(c.x, 2), round(c.y, 2)], "depth": round(c.z, 1), "alpha": round(o.color[3], 2), "scale": round(o.scale[0], 2)})
    hjob.write_result(job, {
        "inView": len(in_view), "inViewSamples": in_view[:10],
        "total": len(objs), "visibleAtFrame": len(visible), "samples": samples,
        "camera": {"world": [round(v, 2) for v in cam.matrix_world.translation]} if cam else None,
        "collections": [c.name for c in bpy.data.collections],
    })


main()
