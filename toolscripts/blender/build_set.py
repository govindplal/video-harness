"""Stage 2: build the set. Painted locations become stacked unlit planes at their manifest depths.

Generic: nothing here knows about a specific location. The camera is NOT created here (animate.py does that);
planes are placed for the location's referenceFov so a painted layer is 1:1 with the frame at rest.

Job: {
  "resultPath", "out": scene.blend, "size": [w, h],
  "location": {...manifest...}, "layersDir": dir, "layers": [{"name","file","depth"}]  (file relative to layersDir)
}
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402

VOID = (0.0, 1.0, 0.5, 1.0)  # (0, 255, 128): never a real colour; the frame-not-empty check looks for it


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)
    return scene


def set_color_management(scene):
    # Painted art must come out exactly as painted: no filmic/AgX tone curve.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.display_settings.display_device = "sRGB"


def set_world_void(scene):
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = VOID
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world


def unlit_texture_material(name, image_path):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    # EEVEE (5.x): sorted alpha blending per object, so planes at different depths composite back to front.
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = False
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(image_path, check_existing=True)
    tex.image.colorspace_settings.name = "sRGB"
    tex.image.alpha_mode = "STRAIGHT"
    tex.interpolation = "Linear"
    tex.extension = "EXTEND"
    emit = nt.nodes.new("ShaderNodeEmission")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mixn = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mixn.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mixn.inputs[1])
    nt.links.new(emit.outputs["Emission"], mixn.inputs[2])
    nt.links.new(mixn.outputs["Shader"], out.inputs["Surface"])
    return mat


def add_layer_plane(name, image_path, depth, plane_w, plane_h, z_center):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)], [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, coord in zip(mesh.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[loop.index].uv = coord
    mesh.update()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(ob)
    # Plane lies in the XZ plane at y=depth, facing the camera at the origin (looking +Y). Scale in X and Z.
    ob.location = (0.0, depth, z_center)
    ob.scale = (plane_w, 1.0, plane_h)
    ob.data.materials.append(unlit_texture_material(name, image_path))
    ob["harness_layer"] = name
    ob["harness_depth"] = depth
    return ob


def main():
    job = hjob.load_job()
    scene = clear_scene()
    set_color_management(scene)
    set_world_void(scene)
    w, h = job["size"]
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100

    loc = job["location"]
    if loc["kind"] != "painted":
        raise NotImplementedError("set locations arrive in milestone 2")
    paint = loc["paint"]
    ref_half_tan = math.tan(math.radians(loc["frame"]["referenceFov"]) / 2.0)
    px_scale = paint["width"] / 1920.0  # painted pixels per frame pixel at rest (frame is 1920 wide in paint space)
    aspect = paint["height"] / paint["width"]
    hz = paint["horizon"]  # painted horizon row as a fraction from the top

    placed = []
    for layer in sorted(job["layers"], key=lambda l: -l["depth"]):
        depth = float(layer["depth"])
        frame_w = 2.0 * depth * ref_half_tan  # world width of the frame at this depth
        plane_w = frame_w * px_scale
        plane_h = plane_w * aspect
        # Put the painted horizon row at z=0 (camera eye level): z_center = plane_h * (hz - 0.5)
        z_center = plane_h * (hz - 0.5)
        add_layer_plane(layer["name"], os.path.join(job["layersDir"], layer["file"]), depth, plane_w, plane_h, z_center)
        placed.append({"name": layer["name"], "depth": depth, "width": plane_w, "height": plane_h, "zCenter": z_center})

    bpy.ops.wm.save_as_mainfile(filepath=job["out"], compress=False)
    hjob.write_result(job, {"layers": placed})


main()
