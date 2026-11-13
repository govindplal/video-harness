"""Toon (cel) shading helpers shared by set building and asset placement.

A toon material is: Diffuse BSDF -> Shader-to-RGB -> constant colour ramp (N bands) -> mix(shade colour, base colour).
The result goes into an Emission output, so what the ramp says is exactly what is drawn (no extra tone mapping).
Outlines are Freestyle lines (screen-space, constant pixel width) configured by setup_outlines().
"""
import math

import bpy


def hex_rgba(h, alpha=1.0):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    # hex colours are sRGB; Blender colour inputs are linear
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), alpha)


def mix_rgba(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


def shade_of(base, tint, amount=0.42):
    """Shadow colour: the base darkened and pulled toward the palette's shade tint."""
    dark = (base[0] * 0.55, base[1] * 0.55, base[2] * 0.58, base[3])
    return mix_rgba(dark, tint, amount * 0.5)


def mix_node(nt, data_type):
    """A Mix node and its (factor, a, b, result) sockets.

    Looking sockets up by name is a trap: the float, vector and colour variants share the names "A"/"B"/"Result",
    and inputs["A"] returns the float one even when data_type is RGBA. Index them explicitly.
    """
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = data_type
    if data_type == "RGBA":
        return n, n.inputs[0], n.inputs[6], n.inputs[7], n.outputs[2]
    return n, n.inputs[0], n.inputs[2], n.inputs[3], n.outputs[0]


def _ramp(nt, steps):
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    steps = max(2, int(steps))
    # Band edges sit low because Shader-to-RGB of a white diffuse under sun+ambient lands around 0.2-1.5.
    edges = [0.0] + [0.14 + 0.30 * i / max(1, steps - 2) for i in range(steps - 1)]
    while len(els) < steps:
        els.new(0.5)
    for i, e in enumerate(edges[:steps]):
        els[i].position = e
        v = i / (steps - 1)
        els[i].color = (v, v, v, 1.0)
    return ramp


def toon_material(name, base, tint, steps=3, emission=None):
    """Opaque toon material. `emission` (rgba) makes it a flat self-lit colour instead (lights, signs)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    if emission is not None:
        emit.inputs["Color"].default_value = emission
        emit.inputs["Strength"].default_value = 1.0
        nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
        return mat
    diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = _ramp(nt, steps)
    _, fac, a, b, res = mix_node(nt, "RGBA")
    a.default_value = shade_of(base, tint)
    b.default_value = base
    nt.links.new(diffuse.outputs["BSDF"], s2r.inputs["Shader"])
    nt.links.new(s2r.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], fac)
    nt.links.new(res, emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def window_wall_material(name, wall, shade_tint, window_dark, window_light, steps=3, spacing=(3.2, 3.4), size=(1.5, 1.9), z0=1.6):
    """Toon wall with a procedural grid of windows in world space (so every facade gets the same rhythm).

    u runs along the facade (x for faces looking +-Y, y for faces looking +-X), v is world height.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = _ramp(nt, steps)

    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep_p = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep_n = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Position"], sep_p.inputs["Vector"])
    nt.links.new(geo.outputs["Normal"], sep_n.inputs["Vector"])
    absx = nt.nodes.new("ShaderNodeMath"); absx.operation = "ABSOLUTE"
    nt.links.new(sep_n.outputs["X"], absx.inputs[0])
    # facing +-X when |nx| is large: u = y, else u = x (factor rounded so it is exactly 0 or 1)
    _, u_fac, u_a, u_b, u_res = mix_node(nt, "FLOAT")
    rnd = nt.nodes.new("ShaderNodeMath"); rnd.operation = "ROUND"
    nt.links.new(absx.outputs["Value"], rnd.inputs[0])
    nt.links.new(rnd.outputs["Value"], u_fac)
    nt.links.new(sep_p.outputs["X"], u_a)
    nt.links.new(sep_p.outputs["Y"], u_b)

    def cell_mask(src, period, win, offset, label):
        """1 where (src - offset) mod period < win."""
        sub = nt.nodes.new("ShaderNodeMath"); sub.operation = "SUBTRACT"; sub.inputs[1].default_value = offset
        nt.links.new(src, sub.inputs[0])
        wrap = nt.nodes.new("ShaderNodeMath"); wrap.operation = "WRAP"; wrap.inputs[1].default_value = 0.0; wrap.inputs[2].default_value = period
        nt.links.new(sub.outputs["Value"], wrap.inputs[0])
        lt = nt.nodes.new("ShaderNodeMath"); lt.operation = "LESS_THAN"; lt.inputs[1].default_value = win
        nt.links.new(wrap.outputs["Value"], lt.inputs[0])
        return lt.outputs["Value"]

    mu = cell_mask(u_res, spacing[0], size[0], 0.7, "u")
    mv = cell_mask(sep_p.outputs["Z"], spacing[1], size[1], z0, "v")
    both = nt.nodes.new("ShaderNodeMath"); both.operation = "MULTIPLY"
    nt.links.new(mu, both.inputs[0]); nt.links.new(mv, both.inputs[1])
    # no windows on roofs/floors: require a mostly vertical wall (|nz| small)
    absz = nt.nodes.new("ShaderNodeMath"); absz.operation = "ABSOLUTE"
    nt.links.new(sep_n.outputs["Z"], absz.inputs[0])
    wallish = nt.nodes.new("ShaderNodeMath"); wallish.operation = "LESS_THAN"; wallish.inputs[1].default_value = 0.5
    nt.links.new(absz.outputs["Value"], wallish.inputs[0])
    win = nt.nodes.new("ShaderNodeMath"); win.operation = "MULTIPLY"
    nt.links.new(both.outputs["Value"], win.inputs[0]); nt.links.new(wallish.outputs["Value"], win.inputs[1])

    # window colour: dark glass with a lighter pane
    _, p_fac, p_a, p_b, p_res = mix_node(nt, "RGBA")
    p_a.default_value = window_dark
    p_b.default_value = window_light
    p_fac.default_value = 0.2
    _, w_fac, w_a, w_b, w_res = mix_node(nt, "RGBA")
    w_a.default_value = wall
    nt.links.new(win.outputs["Value"], w_fac)
    nt.links.new(p_res, w_b)

    _, s_fac, s_a, s_b, s_res = mix_node(nt, "RGBA")
    s_a.default_value = shade_of(wall, shade_tint)
    nt.links.new(w_res, s_b)
    nt.links.new(diffuse.outputs["BSDF"], s2r.inputs["Shader"])
    nt.links.new(s2r.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], s_fac)
    nt.links.new(s_res, emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def setup_outlines(scene, width_px, color=(0.06, 0.08, 0.16, 1.0)):
    """Freestyle outlines: silhouette + border + crease edges, constant width in pixels."""
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = "ABSOLUTE"
    scene.render.line_thickness = 1.0
    vl = scene.view_layers[0]
    vl.use_freestyle = True
    fs = vl.freestyle_settings
    for ls in list(fs.linesets):
        fs.linesets.remove(ls)
    ls = fs.linesets.new("outline")
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = True
    ls.select_contour = False
    ls.select_external_contour = False
    ls.select_edge_mark = False
    fs.crease_angle = math.radians(115)
    style = ls.linestyle
    style.thickness = float(width_px)
    style.color = color[:3]
    style.alpha = 1.0
    return ls


# Time-of-day lighting: sun elevation/azimuth in degrees, colour, strength.
SUN = {
    "morning": (38, 110, (1.0, 0.92, 0.82), 3.2),
    "noon": (72, 180, (1.0, 0.98, 0.94), 4.2),
    "afternoon": (48, 235, (1.0, 0.95, 0.86), 4.0),
    "golden": (14, 250, (1.0, 0.72, 0.46), 3.4),
    "dusk": (5, 255, (1.0, 0.55, 0.45), 2.2),
    "night": (35, 60, (0.55, 0.65, 1.0), 0.6),
}


def add_sun(scene, time_of_day):
    elev, azim, color, strength = SUN.get(time_of_day, SUN["afternoon"])
    light = bpy.data.lights.new("sun", "SUN")
    light.energy = strength
    light.color = color
    light.angle = math.radians(0.6)  # tiny disc: crisp cel shadow edges
    ob = bpy.data.objects.new("sun", light)
    scene.collection.objects.link(ob)
    # sun shines along -Z rotated: pitch = 90 - elevation about X, then yaw by azimuth about Z
    ob.rotation_euler = (math.radians(90 - elev), 0.0, math.radians(azim))
    return ob


def set_sky(scene, top, horizon, ambient=0.9):
    """World gradient (horizon -> top). Also lights the scene a little, which fills the toon shadow side."""
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = ambient
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    maprange = nt.nodes.new("ShaderNodeMapRange")
    maprange.inputs["From Min"].default_value = -0.05
    maprange.inputs["From Max"].default_value = 0.75
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = horizon
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = top
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], maprange.inputs["Value"])
    nt.links.new(maprange.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    return world
