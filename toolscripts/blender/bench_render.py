"""Developer aid: time one frame of a scene under several render settings in a single process.

Job: {"resultPath", "blend", "frame", "variants": [{"name", "freestyle": bool, "samples": int, "scale": float, "shadows": bool}]}
Result: {"timings": [{"name", "seconds"}]}   (the first variant also pays shader compilation, so list a throwaway first)
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402


def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    scene.render.engine = hjob.engine_id("eevee")
    scene.frame_set(int(job["frame"]))
    if job.get("shadowsOff") and hasattr(scene.eevee, "use_shadows"):
        scene.eevee.use_shadows = False  # set before the first render so no recompile is mixed into the timings
    out = []
    for v in job["variants"]:
        scene.render.use_freestyle = bool(v.get("freestyle", True))
        scene.eevee.taa_render_samples = int(v.get("samples", 16))
        scene.render.resolution_percentage = int(round(v.get("scale", 1.0) * 100))
        scene.render.filepath = os.path.join(os.path.dirname(job["resultPath"]), "bench_%s.png" % v["name"])
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        out.append({"name": v["name"], "seconds": round(time.time() - t0, 2)})
    hjob.write_result(job, {"timings": out})


main()
