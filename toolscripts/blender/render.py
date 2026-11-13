"""Stage 5: render frames from an animated scene.

Job: {
  "resultPath", "blend", "outDir", "engine": "eevee"|"cycles"|"workbench", "samples", "scale": 0.25..1,
  "frames": null | [int, ...]   (null = whole animation; a list renders only those frames as frame_NNNN.png)
}
Writes frame_0001.png ... into outDir (8-bit RGB PNG, no alpha).
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
    os.makedirs(job["outDir"], exist_ok=True)

    scene.render.engine = hjob.engine_id(job["engine"])
    scene.render.resolution_percentage = int(round(job.get("scale", 1.0) * 100))
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    # Determinism: by default Blender writes Date, Time, RenderTime, Memory and the absolute .blend path into the
    # PNG's text chunks, so identical pixels give different files. Output must contain pixels only.
    scene.render.use_stamp = False
    for attr in ("use_stamp_date", "use_stamp_time", "use_stamp_render_time", "use_stamp_frame", "use_stamp_frame_range",
                 "use_stamp_memory", "use_stamp_hostname", "use_stamp_camera", "use_stamp_lens", "use_stamp_scene",
                 "use_stamp_marker", "use_stamp_filename", "use_stamp_sequencer_strip", "use_stamp_note", "use_stamp_labels"):
        if hasattr(scene.render, attr):
            setattr(scene.render, attr, False)
    samples = int(job.get("samples", 16))
    if job["engine"] == "eevee":
        scene.eevee.taa_render_samples = samples
        if scene.get("harness_unlit", False):
            # Flat unlit layers need none of EEVEE's lighting passes; switch the expensive ones off.
            for attr, val in (("use_raytracing", False), ("use_shadows", False), ("use_volumetric_shadows", False)):
                if hasattr(scene.eevee, attr):
                    setattr(scene.eevee, attr, val)
        else:
            if hasattr(scene.eevee, "use_raytracing"):
                scene.eevee.use_raytracing = False  # toon shading does not use reflections; keeps frames fast
    elif job["engine"] == "cycles":
        scene.cycles.device = "CPU"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = False
        scene.cycles.seed = 0

    # Per-frame wall time, so a slow first frame (shader compilation) can be told apart from a slow steady state.
    frame_seconds = []
    clock = {"t": time.time()}

    def on_pre(*_args):
        clock["t"] = time.time()

    def on_post(*_args):
        frame_seconds.append(round(time.time() - clock["t"], 2))

    bpy.app.handlers.render_pre.append(on_pre)
    bpy.app.handlers.render_post.append(on_post)

    t0 = time.time()
    frames = job.get("frames")
    if frames is None:
        scene.render.filepath = os.path.join(job["outDir"], "frame_")
        bpy.ops.render.render(animation=True)
        count = scene.frame_end - scene.frame_start + 1
    else:
        for f in frames:
            scene.frame_set(int(f))
            scene.render.filepath = os.path.join(job["outDir"], "frame_%04d.png" % int(f))
            bpy.ops.render.render(write_still=True)
        count = len(frames)
    hjob.write_result(job, {"frames": count, "seconds": round(time.time() - t0, 2),
                            "frameSeconds": frame_seconds,
                            "engine": scene.render.engine,
                            "size": [int(scene.render.resolution_x * scene.render.resolution_percentage / 100),
                                     int(scene.render.resolution_y * scene.render.resolution_percentage / 100)]})


main()
