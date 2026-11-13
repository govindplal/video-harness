"""Developer aid: render smoke-material variants side by side on a plain background, in EEVEE.

Job: {"resultPath", "out": png, "palette": {...}, "variants": [{"mode", "fade"}]}   (builds its own scene)
Each plane gets ob.color = (0.9, 0.9, 0.9, 0.9) and ob["fade"] = 0.9 so every way of reading per-object data can be compared.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import fx  # noqa: E402
import hjob  # noqa: E402


def main():
    job = hjob.load_job()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = hjob.engine_id("eevee")
    variants = job["variants"]
    scene.render.resolution_x, scene.render.resolution_y = 240 * len(variants), 240
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.35, 0.5, 0.75, 1)
    scene.world = world
    mesh = fx.unit_quad_mesh("q")
    n = len(variants)
    for i, v in enumerate(variants):
        me = mesh.copy()
        me.materials.append(fx.puff_material(job["palette"], name="smoke-%s-%s" % (v["mode"], v["fade"]), mode=v["mode"], fade=v["fade"]))
        ob = bpy.data.objects.new("p%d" % i, me)
        scene.collection.objects.link(ob)
        ob.location = ((i - (n - 1) / 2.0) * 2.2, 0, 0)
        ob.scale = (2, 2, 2)
        ob.rotation_euler = (1.5708, 0, 0)  # face the camera at -Y
        ob.color = (0.9, 0.9, 0.9, 0.9)
        ob[fx.FADE_PROP] = 0.9
    cam_data = bpy.data.cameras.new("c")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.2 * n
    cam = bpy.data.objects.new("c", cam_data)
    cam.location = (0, -10, 0)
    cam.rotation_euler = (1.5708, 0, 0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.eevee.taa_render_samples = 8
    scene.render.filepath = job["out"]
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    hjob.write_result(job, {"variants": variants})


main()
