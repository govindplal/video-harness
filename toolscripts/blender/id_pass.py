"""ID pass: render every frame as flat unique colours so checkers can count pixels per object class.

Colours (pure 8-bit channels, no anti-aliasing, no lighting):
  actor 0 = (255,0,0)  actor 1 = (0,255,0)  actor 2 = (255,255,0)  actor 3 = (0,255,255)
  ground  = (0,0,255)  (objects with harness_role == "ground": road, sidewalks, markings)
  everything else (buildings, trees, sky) = (0,0,0); effects (smoke, tyre marks) are hidden.

Job: {"resultPath", "blend", "outDir", "scale": 0.25..1, "frames": null | [int, ...]}
Writes outDir/id_NNNN.png. Result: {"frames": n, "colors": {...}, "size": [w, h]}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402

ACTOR_COLORS = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 1.0)]
GROUND_COLOR = (0.0, 0.0, 1.0)
OTHER_COLOR = (0.0, 0.0, 0.0)


def main():
    job = hjob.load_job()
    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    scene = bpy.context.scene
    os.makedirs(job["outDir"], exist_ok=True)

    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.use_freestyle = False
    scene.render.use_motion_blur = False
    scene.render.resolution_percentage = int(round(job.get("scale", 0.5) * 100))
    scene.render.film_transparent = False
    scene.render.dither_intensity = 0.0
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "OBJECT"
    sh.show_shadows = False
    sh.show_cavity = False
    sh.show_object_outline = False
    sh.show_specular_highlight = False
    scene.display.render_aa = "OFF"
    if scene.world:
        scene.world.color = (0.0, 0.0, 0.0)

    for ob in scene.objects:
        role = ob.get("harness_role", "scenery")
        if role == "effect":
            ob.hide_render = True
        elif role == "actor":
            ob.color = ACTOR_COLORS[int(ob.get("harness_actor_index", 0)) % len(ACTOR_COLORS)] + (1.0,)
        elif role == "ground":
            ob.color = GROUND_COLOR + (1.0,)
        else:
            ob.color = OTHER_COLOR + (1.0,)

    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    for attr in ("use_stamp", "use_stamp_date", "use_stamp_time", "use_stamp_render_time", "use_stamp_frame", "use_stamp_frame_range",
                 "use_stamp_memory", "use_stamp_hostname", "use_stamp_camera", "use_stamp_lens", "use_stamp_scene", "use_stamp_marker",
                 "use_stamp_filename", "use_stamp_sequencer_strip", "use_stamp_note", "use_stamp_labels"):
        if hasattr(scene.render, attr):
            setattr(scene.render, attr, False)

    frames = job.get("frames")
    if frames is None:
        scene.render.filepath = os.path.join(job["outDir"], "id_")
        bpy.ops.render.render(animation=True)
        n = scene.frame_end - scene.frame_start + 1
    else:
        for f in frames:
            scene.frame_set(int(f))
            scene.render.filepath = os.path.join(job["outDir"], "id_%04d.png" % int(f))
            bpy.ops.render.render(write_still=True)
        n = len(frames)
    pct = scene.render.resolution_percentage / 100
    hjob.write_result(job, {
        "frames": n,
        "colors": {"actors": [list(c) for c in ACTOR_COLORS], "ground": list(GROUND_COLOR), "other": list(OTHER_COLOR)},
        "size": [int(scene.render.resolution_x * pct), int(scene.render.resolution_y * pct)],
    })


main()
