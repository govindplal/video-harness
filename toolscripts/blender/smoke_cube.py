"""Doctor smoke test: render one PNG of a cube with no display.

Job: {"out": path.png, "engine": "eevee"|"cycles"|"workbench", "width": int, "height": int, "samples": int}
Result: {"engine": identifier, "gpu": renderer string or null, "seconds": float}
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402

job = hjob.load_job()
scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.active_object
mat = bpy.data.materials.new("smoke_mat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.2, 0.6, 0.35, 1)
cube.data.materials.append(mat)
bpy.ops.mesh.primitive_plane_add(size=20)

bpy.ops.object.light_add(type="SUN", location=(4, -4, 8))
bpy.context.active_object.data.energy = 3
bpy.ops.object.camera_add(location=(6, -6, 4.5))
cam = bpy.context.active_object
direction = cube.location - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

eng = hjob.engine_id(job["engine"])
scene.render.engine = eng
scene.render.resolution_x = job["width"]
scene.render.resolution_y = job["height"]
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = job["out"]
if job["engine"] == "cycles":
    scene.cycles.device = "CPU"
    scene.cycles.samples = job.get("samples", 16)
elif job["engine"] == "eevee":
    scene.eevee.taa_render_samples = job.get("samples", 16)

t0 = time.time()
bpy.ops.render.render(write_still=True)
gpu = None
try:
    import gpu as gpumod
    gpu = gpumod.platform.renderer_get() + " | backend " + gpumod.platform.backend_type_get()
except Exception as e:  # background mode may have no GPU module context
    gpu = "unavailable: %s" % e
hjob.write_result(job, {"engine": eng, "gpu": gpu, "seconds": round(time.time() - t0, 2)})
