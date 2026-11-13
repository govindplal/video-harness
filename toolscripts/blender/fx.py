"""Effect building blocks shared by animate.py and the developer probes."""
import bpy

import toon


def unit_quad_mesh(name):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for loop, c in zip(me.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[loop.index].uv = c
    me.update()
    return me


FADE_PROP = "fade"  # custom property on an effect object: 0 = invisible, 1 = opaque (keyed by animate.py)


def fade_socket(nt, fade="objcolor"):
    """Output socket that carries the per-object fade value into a material.

    Default "objcolor": Object Info > Color, with the fade stored as ob.color = (a, a, a, 1) (verified in EEVEE with
    material_probe.py). "attr" (Attribute node reading ob["fade"]) rendered as invisible in the same probe, so it is
    kept only for probing.
    """
    if fade == "attr":
        att = nt.nodes.new("ShaderNodeAttribute")
        att.attribute_type = "OBJECT"
        att.attribute_name = '["%s"]' % FADE_PROP
        return att.outputs["Fac"]
    info = nt.nodes.new("ShaderNodeObjectInfo")
    return info.outputs["Color" if fade == "objcolor" else "Alpha"]


def puff_material(palette, name="smoke", mode="full", fade="objcolor"):
    """Cartoon smoke: a wobbly disc with a light top and a shaded underside.

    Alpha = shape mask x the object's fade (animate.py keys ob.color = (a, a, a, 1) to fade a puff in and out).
    `mode` is for debugging: "full", "nomask" (alpha = fade only), "maskonly" (alpha = shape only), "solid" (alpha 1).
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = False
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    uv = nt.nodes.new("ShaderNodeTexCoord")
    dist = nt.nodes.new("ShaderNodeVectorMath"); dist.operation = "DISTANCE"
    dist.inputs[1].default_value = (0.5, 0.5, 0.0)
    noise = nt.nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 3.2
    sub = nt.nodes.new("ShaderNodeMath"); sub.operation = "SUBTRACT"
    wob = nt.nodes.new("ShaderNodeMath"); wob.operation = "MULTIPLY"; wob.inputs[1].default_value = 0.34
    shape = nt.nodes.new("ShaderNodeMath"); shape.operation = "LESS_THAN"; shape.inputs[1].default_value = 0.2
    alpha = nt.nodes.new("ShaderNodeMath"); alpha.operation = "MULTIPLY"
    sepuv = nt.nodes.new("ShaderNodeSeparateXYZ")
    lit = nt.nodes.new("ShaderNodeMath"); lit.operation = "GREATER_THAN"; lit.inputs[1].default_value = 0.42
    nt.links.new(uv.outputs["UV"], dist.inputs[0])
    nt.links.new(uv.outputs["UV"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], wob.inputs[0])
    nt.links.new(dist.outputs["Value"], sub.inputs[0])
    nt.links.new(wob.outputs["Value"], sub.inputs[1])
    nt.links.new(sub.outputs["Value"], shape.inputs[0])
    if mode == "nomask":
        shape.inputs[0].default_value = 0.0  # unlinked: 0 < 0.39 -> 1
        nt.links.remove(shape.inputs[0].links[0]) if shape.inputs[0].links else None
    nt.links.new(shape.outputs["Value"], alpha.inputs[0])
    nt.links.new(fade_socket(nt, fade), alpha.inputs[1])
    if mode == "maskonly":
        alpha.inputs[1].default_value = 1.0
        for lk in list(alpha.inputs[1].links):
            nt.links.remove(lk)
    nt.links.new(uv.outputs["UV"], sepuv.inputs["Vector"])
    nt.links.new(sepuv.outputs["Y"], lit.inputs[0])
    light, shade = toon.hex_rgba(palette["cloudLight"]), toon.hex_rgba(palette["cloudShade"])
    _, fac, a_in, b_in, res = toon.mix_node(nt, "RGBA")
    a_in.default_value, b_in.default_value = shade, light
    nt.links.new(lit.outputs["Value"], fac)
    emit = nt.nodes.new("ShaderNodeEmission")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mixs = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(res, emit.inputs["Color"])
    if mode == "solid":
        mixs.inputs["Fac"].default_value = 1.0
    else:
        nt.links.new(alpha.outputs["Value"], mixs.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mixs.inputs[1])
    nt.links.new(emit.outputs["Emission"], mixs.inputs[2])
    nt.links.new(mixs.outputs["Shader"], out.inputs["Surface"])
    return mat
