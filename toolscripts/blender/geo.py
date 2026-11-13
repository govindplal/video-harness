"""Small mesh helpers shared by set builders and effects. No operators (they need a UI context); pure data.

Every object gets a custom property harness_role: "ground" (road, sidewalk: counted by the ground-present check),
"scenery" (everything else static), "actor" (set by placement) or "effect" (smoke, tyre marks: hidden in the ID pass).
"""
import math

import bmesh
import bpy
from mathutils import Vector


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_object(name, verts, faces, material=None, role="scenery", location=(0.0, 0.0, 0.0), smooth=False, recalc=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    if material is not None:
        me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    ob.location = location
    ob["harness_role"] = role
    return link(ob)


def box(name, x0, x1, y0, y1, z0, z1, material, role="scenery", plane=None):
    """Axis-aligned box. The object origin is the centre of its base, so object-space coordinates run from z=0 at the base.

    With `plane` (ground z = a*x + b*y + c) the bottom face follows the ground instead of sitting at z0: the walls stand
    on a sloped street with nothing below the surface (hidden geometry makes Freestyle draw stray lines through the road).
    """
    ox, oy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    xs, ys = (x0 - ox, x1 - ox), (y0 - oy, y1 - oy)
    if plane is not None:
        z0 = ground_z(plane, ox, oy) - 0.05
        zb = [ground_z(plane, cx, cy) - 0.05 - z0 for cx, cy in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    else:
        zb = [0.0, 0.0, 0.0, 0.0]
    zt = z1 - z0
    v = [(xs[0], ys[0], zb[0]), (xs[1], ys[0], zb[1]), (xs[1], ys[1], zb[2]), (xs[0], ys[1], zb[3]),
         (xs[0], ys[0], zt), (xs[1], ys[0], zt), (xs[1], ys[1], zt), (xs[0], ys[1], zt)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return mesh_object(name, v, f, material, role, location=(ox, oy, z0))


def ground_z(plane, x, y):
    return plane[0] * x + plane[1] * y + plane[2]


def quad_on_plane(name, x0, x1, y0, y1, plane, material, role="ground", lift=0.0):
    """A flat rectangle that follows the ground plane (so it tilts with a sloped street), facing up."""
    v = [(x0, y0, ground_z(plane, x0, y0) + lift), (x1, y0, ground_z(plane, x1, y0) + lift),
         (x1, y1, ground_z(plane, x1, y1) + lift), (x0, y1, ground_z(plane, x0, y1) + lift)]
    return mesh_object(name, v, [(0, 1, 2, 3)], material, role)


def curb_face(name, x, y0, y1, plane, height, material, facing, role="ground"):
    """Vertical strip along Y at constant x, `height` tall above the road plane, facing +X or -X."""
    z = lambda yy: ground_z(plane, x, yy)  # noqa: E731
    v = [(x, y0, z(y0)), (x, y1, z(y1)), (x, y1, z(y1) + height), (x, y0, z(y0) + height)]
    f = [(0, 1, 2, 3)] if facing > 0 else [(0, 3, 2, 1)]
    return mesh_object(name, v, f, material, role)


def cylinder(name, x, y, z0, z1, radius, material, sides=10, role="scenery"):
    v, f = [], []
    for i in range(sides):
        a = 2 * math.pi * i / sides
        v.append((radius * math.cos(a), radius * math.sin(a), 0.0))
    for i in range(sides):
        a = 2 * math.pi * i / sides
        v.append((radius * math.cos(a), radius * math.sin(a), z1 - z0))
    for i in range(sides):
        j = (i + 1) % sides
        f.append((i, j, sides + j, sides + i))
    f.append(tuple(reversed(range(sides))))
    f.append(tuple(range(sides, 2 * sides)))
    return mesh_object(name, v, f, material, role, location=(x, y, z0), recalc=True)


def ellipsoid(name, x, y, z, rx, ry, rz, material, rings=6, segs=9, role="scenery"):
    v, f = [(0, 0, rz)], []
    for r in range(1, rings):
        phi = math.pi * r / rings
        for s in range(segs):
            th = 2 * math.pi * s / segs
            v.append((rx * math.sin(phi) * math.cos(th), ry * math.sin(phi) * math.sin(th), rz * math.cos(phi)))
    v.append((0, 0, -rz))
    for s in range(segs):
        f.append((0, 1 + s, 1 + (s + 1) % segs))
    for r in range(rings - 2):
        base = 1 + r * segs
        for s in range(segs):
            a, b = base + s, base + (s + 1) % segs
            f.append((a, a + segs, b + segs, b))
    last = len(v) - 1
    base = 1 + (rings - 2) * segs
    for s in range(segs):
        f.append((last, base + (s + 1) % segs, base + s))
    return mesh_object(name, v, f, material, role, location=(x, y, z), recalc=True)


def prism_gable(name, x0, x1, y0, y1, z, rise, along, material, role="scenery"):
    """A gabled roof over the rectangle [x0,x1]x[y0,y1] at height z. `along` is the ridge axis, 'x' or 'y'."""
    if along == "x":
        ym = (y0 + y1) / 2.0
        v = [(x0, y0, z), (x0, y1, z), (x0, ym, z + rise), (x1, y0, z), (x1, y1, z), (x1, ym, z + rise)]
    else:
        xm = (x0 + x1) / 2.0
        v = [(x0, y0, z), (x1, y0, z), (xm, y0, z + rise), (x0, y1, z), (x1, y1, z), (xm, y1, z + rise)]
    f = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (0, 2, 5, 3)]
    return mesh_object(name, v, f, material, role, recalc=True)
