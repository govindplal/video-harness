"""Generic street set builder: a road along +Y with sidewalks, rowhouses, trees, poles, rails and optional cross streets.

Everything specific (lengths, widths, building sizes, spacing, the cross street) comes from the location manifest's
set.params. Colours come from the style palette for the time of day. All randomness comes from `seed`.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bpy  # noqa: E402
import geo  # noqa: E402
import toon  # noqa: E402


def build(scene, params, palette, steps, seed, plane):
    rng = random.Random(int(seed) * 7919 + 17)
    hexc = toon.hex_rgba
    tint = hexc(palette["shade"])
    y0, y1 = params["yRange"]
    rw = float(params["roadWidth"])
    sw = float(params["sidewalk"])
    half = rw / 2.0
    cross = params.get("crossStreets", [])
    bp = params["buildings"]
    stats = {"buildings": 0, "trees": 0, "poles": 0}

    def tm(name, color, emission=None):
        return toon.toon_material(name, hexc(color) if isinstance(color, str) else color, tint, steps, emission)

    m_road = tm("road", "#5b6275")
    m_walk = tm("sidewalk", "#d9cfc0")
    m_curb = tm("curb", "#b8afa2")
    m_line_y = tm("line-yellow", "#f2c744")
    m_line_w = tm("line-white", "#f4f1ea")
    m_rail = tm("rail", "#8c95a8")
    m_slot = tm("slot", "#2a2f3c")
    m_trunk = tm("trunk", "#5a3d2e")
    m_trim = tm("trim", palette["trim"])
    m_pole = tm("pole", "#5c4a3a")
    m_door = tm("door", "#3a2a2a")
    m_leaf = [tm(f"leaf{i}", c) for i, c in enumerate(palette["tree"])]
    m_roof = [tm(f"roof{i}", c) for i, c in enumerate(palette["roofs"])]
    m_wall = [toon.window_wall_material(f"wall{i}", hexc(c), tint, hexc(palette["windowDark"]), hexc(palette["windowLight"]), steps)
              for i, c in enumerate(palette["walls"])]

    # ------------------------------------------------------------------ surfaces
    bands = [(c["y"] - c["width"] / 2.0, c["y"] + c["width"] / 2.0, c.get("xEnd", half + sw)) for c in cross]
    geo.quad_on_plane("road", -half, half, y0, y1, plane, m_road)
    for i, (b0, b1, xe) in enumerate(bands):
        geo.quad_on_plane(f"cross-road-{i}", half, xe, b0, b1, plane, m_road)

    def segments(lo, hi, cuts):
        """[lo,hi] minus the cut intervals."""
        out, cur = [], lo
        for a, b in sorted(cuts):
            if a > cur:
                out.append((cur, min(a, hi)))
            cur = max(cur, b)
        if cur < hi:
            out.append((cur, hi))
        return [s for s in out if s[1] - s[0] > 0.5]

    # Main-street sidewalks: left is continuous; right is cut where a cross street joins.
    left_walk = [(y0, y1)]
    right_walk = segments(y0, y1, [(b0, b1) for b0, b1, _ in bands])
    for i, (a, b) in enumerate(left_walk):
        geo.quad_on_plane(f"walk-L{i}", -half - sw, -half, a, b, plane, m_walk, lift=0.16)
        geo.curb_face(f"curb-L{i}", -half, a, b, plane, 0.16, m_curb, facing=-1)
    for i, (a, b) in enumerate(right_walk):
        geo.quad_on_plane(f"walk-R{i}", half, half + sw, a, b, plane, m_walk, lift=0.16)
        geo.curb_face(f"curb-R{i}", half, a, b, plane, 0.16, m_curb, facing=1)
    # Cross-street sidewalks (both sides, from the main sidewalk to the end).
    for i, (b0, b1, xe) in enumerate(bands):
        geo.quad_on_plane(f"cross-walk-N{i}", half + sw, xe, b1, b1 + sw, plane, m_walk, lift=0.16)
        geo.quad_on_plane(f"cross-walk-S{i}", half + sw, xe, b0 - sw, b0, plane, m_walk, lift=0.16)

    # ------------------------------------------------------------------ road markings
    def strip(name, x_a, x_b, ya, yb, mat):
        geo.quad_on_plane(name, x_a, x_b, ya, yb, plane, mat, role="ground", lift=0.02)

    if params.get("cableSlot", True):
        for i, (a, b) in enumerate(segments(y0, y1, [(b0, b1) for b0, b1, _ in bands])):
            strip(f"slot{i}", -0.1, 0.1, a, b, m_slot)
            strip(f"rail-L{i}", -0.55, -0.47, a, b, m_rail)
            strip(f"rail-R{i}", 0.47, 0.55, a, b, m_rail)
            strip(f"yellow-L{i}", -1.25, -1.13, a, b, m_line_y)
            strip(f"yellow-R{i}", 1.13, 1.25, a, b, m_line_y)
    for i, (b0, b1, xe) in enumerate(bands):
        # Crosswalks on the main street, just outside the cross street, and a stop line each side.
        for side, (ya, yb) in enumerate([(b0 - 3.4, b0 - 1.2), (b1 + 1.2, b1 + 3.4)]):
            n = int(rw / 1.2)
            for k in range(n):
                xa = -half + 0.4 + k * (rw - 0.8) / n
                strip(f"zebra-{i}-{side}-{k}", xa, xa + 0.55, ya, yb, m_line_w)
        # Dashed centre line on the cross street.
        x = half + 3.0
        j = 0
        while x < xe - 3:
            strip(f"dash-{i}-{j}", x, x + 2.0, (b0 + b1) / 2 - 0.07, (b0 + b1) / 2 + 0.07, m_line_y)
            x += 4.5
            j += 1

    # ------------------------------------------------------------------ buildings
    def house(name, fx, fy, axis, sign, t, width, depth, height):
        """One rowhouse. `axis` is the street axis ('y' main street, 'x' cross street), `sign` points away from the road."""
        wall = rng.choice(m_wall)
        if axis == "y":
            xa, xb = sorted((fx, fx + sign * depth))
            ya, yb = t, t + width
            base = geo.ground_z(plane, fx, (ya + yb) / 2.0) - 0.1
        else:
            ya, yb = sorted((fy, fy + sign * depth))
            xa, xb = t, t + width
            base = geo.ground_z(plane, (xa + xb) / 2.0, fy) - 0.1
        z0, z1 = base, base + height
        geo.box(name, xa, xb, ya, yb, z0, z1, wall, plane=plane)  # walls follow the slope: nothing below the surface
        # cornice and roof
        geo.box(name + "-cornice", xa - 0.25, xb + 0.25, ya - 0.25, yb + 0.25, z1, z1 + 0.4, m_trim)
        kind = rng.random()
        if kind < 0.38:
            geo.prism_gable(name + "-gable", xa - 0.2, xb + 0.2, ya - 0.2, yb + 0.2, z1 + 0.4, min(width, depth) * 0.28,
                            "x" if axis == "y" else "y", rng.choice(m_roof))
        elif kind < 0.6:
            geo.box(name + "-attic", xa + 1.0, xb - 1.0, ya + 1.0, yb - 1.0, z1 + 0.4, z1 + 2.2, rng.choice(m_wall))
        # front door
        if axis == "y":
            dx = fx - 0.05 if sign > 0 else fx - 0.05
            cy = (ya + yb) / 2.0
            geo.box(name + "-door", min(fx, fx - 0.05 * sign) - 0.02, max(fx, fx - 0.05 * sign) + 0.02, cy - 0.7, cy + 0.7, base + 0.1, base + 2.3, m_door)
        else:
            cx = (xa + xb) / 2.0
            geo.box(name + "-door", cx - 0.7, cx + 0.7, min(fy, fy - 0.05 * sign) - 0.02, max(fy, fy - 0.05 * sign) + 0.02, base + 0.1, base + 2.3, m_door)
        stats["buildings"] += 1

    def row(axis, fx, fy, sign, start, end):
        t = start
        n = 0
        while t < end - bp["minWidth"]:
            w = rng.uniform(bp["minWidth"], bp["maxWidth"])
            w = min(w, end - t)
            h = rng.uniform(bp["minHeight"], bp["maxHeight"])
            house(f"house-{axis}{'+' if sign > 0 else '-'}{n}", fx, fy, axis, sign, t, w, bp["depth"], h)
            t += w + bp["gap"]
            n += 1

    # Main street, both sides. The right side stops at each cross street's sidewalk edge (corner buildings belong to
    # the main row); cross-street rows start beyond the main row's depth so the two never overlap.
    for a, b in left_walk:
        row("y", -half - sw, 0.0, -1, a, b)
    for a, b in segments(y0, y1, [(b0 - sw, b1 + sw) for b0, b1, _ in bands]):
        row("y", half + sw, 0.0, 1, a, b)
    for b0, b1, xe in bands:
        xs = half + sw + bp["depth"] + bp["gap"]
        row("x", 0.0, b1 + sw, 1, xs, xe)
        row("x", 0.0, b0 - sw, -1, xs, xe)

    # ------------------------------------------------------------------ trees and poles
    sp = float(params.get("treeSpacing", 15))
    y = y0 + 6
    k = 0
    cut = [(b0 - sw - 2, b1 + sw + 2) for b0, b1, _ in bands]
    while y < y1 - 6:
        if not any(a < y < b for a, b in cut):
            side = -1 if k % 2 == 0 else 1
            x = side * (half + 0.9)
            zb = geo.ground_z(plane, x, y) + 0.16
            geo.cylinder(f"trunk{k}", x, y, zb, zb + 2.6, 0.16, m_trunk)
            leaf = rng.choice(m_leaf)
            r = rng.uniform(1.5, 2.1)
            geo.ellipsoid(f"crown{k}", x, y, zb + 3.7, r, r, r * 1.05, leaf)
            geo.ellipsoid(f"crown{k}b", x + rng.uniform(-0.8, 0.8), y + rng.uniform(-0.8, 0.8), zb + 4.6, r * 0.7, r * 0.7, r * 0.7, rng.choice(m_leaf))
            stats["trees"] += 1
        y += sp * rng.uniform(0.8, 1.2)
        k += 1
    ps = float(params.get("poleSpacing", 32))
    y = y0 + 12
    while y < y1 - 6:
        if not any(a < y < b for a, b in cut):
            x = half + 0.5
            zb = geo.ground_z(plane, x, y) + 0.16
            geo.cylinder(f"pole{stats['poles']}", x, y, zb, zb + 9.5, 0.13, m_pole)
            geo.box(f"arm{stats['poles']}", x - 1.2, x + 0.3, y - 0.07, y + 0.07, zb + 8.6, zb + 8.8, m_pole)
            stats["poles"] += 1
        y += ps

    # ------------------------------------------------------------------ backdrop beyond the end of the street
    zfar = geo.ground_z(plane, 0, y1) - 9
    haze = hexc(palette["haze"])
    sea = toon.toon_material("sea", toon.mix_rgba(hexc(palette["skyBottom"]), hexc(palette["hills"][0]), 0.55), tint, steps, emission=toon.mix_rgba(hexc(palette["skyBottom"]), hexc(palette["hills"][0]), 0.55))
    geo.mesh_object("sea", [(-1500, y1 - 20, zfar), (1500, y1 - 20, zfar), (1500, y1 + 1800, zfar), (-1500, y1 + 1800, zfar)], [(0, 1, 2, 3)], sea, role="scenery")
    for i, c in enumerate(palette["hills"]):
        col = toon.mix_rgba(hexc(c), haze, 0.6)
        hm = toon.toon_material(f"hills{i}", col, tint, steps, emission=col)
        geo.ellipsoid(f"hills{i}", (-420 if i == 0 else 480), y1 + 900 + i * 200, zfar - 40, 560, 420, 50 + 15 * i, hm, rings=6, segs=14)
    return stats
