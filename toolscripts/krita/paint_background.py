"""Paint a layered painted-location background in Krita.

Generic: layer types (sky, clouds, hills, rowhouses) and their parameters come from the location
manifest, colours from the style palette. All randomness comes from job["seed"].

Job: {
  "outDir": dir, "seed": int, "time": "afternoon",
  "paint": {"width", "height", "horizon", "layers": [{"name","type","depth","params"}]},
  "palette": {...one time-of-day palette...}, "grain": float
}
Writes outDir/layers/<name>.png (read back out of the Krita layer), outDir/layers.kra, outDir/preview.png
and returns {"layers": [{"name","file","depth"}], "kra", "preview"}.

Pixel path: QPainter -> QImage (ARGB32 == Krita's BGRA bytes) -> Node.setPixelData; PNGs are written from the
layer's pixel data so the Krita document is the source of truth. Krita's own PNG exporter is never used
(it opens a modal dialog that hangs a headless run).
"""
import math
import os
import random

from krita import Krita
from PyQt5.QtCore import QPointF, QRectF, Qt
from PyQt5.QtGui import (QBrush, QColor, QImage, QLinearGradient, QPainter, QPainterPath, QPen,
                         QPolygonF, QRadialGradient)


def col(hexstr, alpha=1.0):
    c = QColor(hexstr)
    c.setAlphaF(alpha)
    return c


def mix(a, b, t):
    """Blend two hex colours, t=0 -> a, t=1 -> b."""
    ca, cb = QColor(a), QColor(b)
    return QColor(int(ca.red() + (cb.red() - ca.red()) * t),
                  int(ca.green() + (cb.green() - ca.green()) * t),
                  int(ca.blue() + (cb.blue() - ca.blue()) * t))


def new_image(w, h):
    img = QImage(w, h, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    return img


def painter(img):
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing, True)
    p.setRenderHint(QPainter.SmoothPixmapTransform, True)
    return p


# ----------------------------------------------------------------------------- layer painters

def paint_sky(img, rng, pal, horizon_y, params):
    w, h = img.width(), img.height()
    p = painter(img)
    g = QLinearGradient(0, 0, 0, horizon_y + h * 0.08)
    g.setColorAt(0.0, col(pal["skyTop"]))
    g.setColorAt(0.55, col(pal["skyMid"]))
    g.setColorAt(1.0, col(pal["skyBottom"]))
    p.fillRect(QRectF(0, 0, w, h), QBrush(g))
    # below the horizon the sky continues in the haze colour so nothing shows through
    p.fillRect(QRectF(0, horizon_y + h * 0.08, w, h), col(pal["skyBottom"]))
    # soft sun glow
    sx, sy = w * (0.72 + rng.uniform(-0.05, 0.05)), horizon_y * 0.45
    rg = QRadialGradient(sx, sy, w * 0.28)
    rg.setColorAt(0.0, col(pal["sun"], 0.95))
    rg.setColorAt(0.25, col(pal["sun"], 0.35))
    rg.setColorAt(1.0, col(pal["sun"], 0.0))
    p.setPen(Qt.NoPen)
    p.setBrush(QBrush(rg))
    p.drawEllipse(QPointF(sx, sy), w * 0.28, w * 0.28)
    p.end()


def paint_clouds(img, rng, pal, horizon_y, params):
    w, h = img.width(), img.height()
    p = painter(img)
    p.setPen(Qt.NoPen)
    count = int(params.get("count", 9))
    y0, y1 = params.get("yMin", 0.12) * h, params.get("yMax", 0.5) * h
    for _ in range(count):
        cx = rng.uniform(0.04, 0.96) * w
        cy = rng.uniform(y0, y1)
        scale = rng.uniform(0.7, 1.5)
        puffs = rng.randint(5, 9)
        for i in range(puffs):
            px = cx + (i - puffs / 2) * 95 * scale + rng.uniform(-30, 30)
            py = cy + rng.uniform(-35, 25) * scale
            r = rng.uniform(55, 112) * scale
            rg = QRadialGradient(px - r * 0.2, py - r * 0.35, r * 1.25)
            rg.setColorAt(0.0, col(pal["cloudLight"], 0.98))
            rg.setColorAt(0.62, col(pal["cloudLight"], 0.95))
            rg.setColorAt(1.0, col(pal["cloudShade"], 0.92))
            p.setBrush(QBrush(rg))
            p.drawEllipse(QPointF(px, py), r * 1.25, r)
    p.end()


def ridge_y(x, w, base, amp, phases):
    t = x / w
    v = 0.0
    for k, (freq, weight, ph) in enumerate(phases):
        v += math.sin((t * freq + ph) * 2 * math.pi) * weight
    return base - amp * v


def paint_hills(img, rng, pal, horizon_y, params):
    w, h = img.width(), img.height()
    p = painter(img)
    base = params.get("baseY", 0.57) * h
    amp = params.get("amplitude", 0.07) * h
    for band, colr in enumerate(pal["hills"]):
        phases = [(rng.uniform(0.7, 1.4) * (1 + band * 0.6), rng.uniform(0.35, 0.6), rng.random()),
                  (rng.uniform(2.2, 3.4), rng.uniform(0.12, 0.25), rng.random()),
                  (rng.uniform(5.0, 7.5), rng.uniform(0.03, 0.08), rng.random())]
        path = QPainterPath(QPointF(0, h))
        step = 8
        for x in range(0, w + step, step):
            path.lineTo(x, ridge_y(x, w, base + band * h * 0.035, amp, phases) - band * 0)
        path.lineTo(w, h)
        path.closeSubpath()
        g = QLinearGradient(0, base - amp, 0, base + h * 0.1)
        g.setColorAt(0.0, QColor(colr))
        g.setColorAt(1.0, mix(colr, pal["haze"], 0.55))
        p.fillPath(path, QBrush(g))
    # water strip between the hills and the horizon haze
    p.end()


def draw_tree(p, rng, pal, x, base_y, size):
    trunk = QRectF(x - size * 0.05, base_y - size * 0.35, size * 0.1, size * 0.4)
    p.fillRect(trunk, col("#5a3d2e"))
    for _ in range(5):
        r = size * rng.uniform(0.22, 0.34)
        px = x + rng.uniform(-0.28, 0.28) * size
        py = base_y - size * rng.uniform(0.45, 0.85)
        c = QColor(rng.choice(pal["tree"]))
        p.setBrush(c)
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(px, py), r, r * 0.9)
        p.setBrush(QColor(255, 255, 255, 38))
        p.drawEllipse(QPointF(px - r * 0.25, py - r * 0.3), r * 0.55, r * 0.45)


def draw_house(p, rng, pal, x, base_y, bw, bh, windows, detail):
    wall = QColor(rng.choice(pal["walls"]))
    roof = QColor(rng.choice(pal["roofs"]))
    shade = QColor(pal["shade"])
    top = base_y - bh
    ext = 900  # walls run far below the baseline so the layer has no gaps at the bottom
    p.setPen(Qt.NoPen)

    # wall + cel shadow on the right third
    p.setBrush(wall)
    p.drawRect(QRectF(x, top, bw, bh + ext))
    sh = QColor(shade)
    sh.setAlpha(70)
    p.setBrush(sh)
    p.drawRect(QRectF(x + bw * 0.72, top, bw * 0.28, bh + ext))

    # roof / cornice
    kind = rng.choice(["flat", "gable", "slant"])
    if kind == "gable":
        poly = QPolygonF([QPointF(x - bw * 0.04, top), QPointF(x + bw * 0.5, top - bw * 0.30), QPointF(x + bw * 1.04, top)])
    elif kind == "slant":
        poly = QPolygonF([QPointF(x - bw * 0.04, top), QPointF(x + bw * 0.1, top - bw * 0.2), QPointF(x + bw * 1.04, top - bw * 0.06), QPointF(x + bw * 1.04, top)])
    else:
        poly = QPolygonF([QPointF(x - bw * 0.03, top), QPointF(x - bw * 0.03, top - bw * 0.07), QPointF(x + bw * 1.03, top - bw * 0.07), QPointF(x + bw * 1.03, top)])
    p.setBrush(roof)
    p.drawPolygon(poly)
    roof_sh = QColor(shade)
    roof_sh.setAlpha(80)
    p.setBrush(roof_sh)
    right_third = QPolygonF([QPointF(x + bw * 0.7, top - bw), QPointF(x + bw * 1.1, top - bw),
                             QPointF(x + bw * 1.1, top + 5), QPointF(x + bw * 0.7, top + 5)])
    p.drawPolygon(poly.intersected(right_third))
    p.setBrush(col(pal["trim"]))
    p.drawRect(QRectF(x - bw * 0.03, top, bw * 1.06, max(3.0, bw * 0.045)))

    if detail > 0:
        # chimney
        if rng.random() < 0.5:
            cx = x + bw * rng.uniform(0.15, 0.75)
            p.setBrush(QColor("#a65a46"))
            p.drawRect(QRectF(cx, top - bw * 0.36, bw * 0.08, bw * 0.3))
        # bay window
        if windows and rng.random() < 0.6:
            bx = x + bw * rng.uniform(0.12, 0.45)
            bwid = bw * 0.34
            p.setBrush(QColor(wall).lighter(108))
            p.drawPolygon(QPolygonF([QPointF(bx - 8, top + bh * 0.3), QPointF(bx + bwid + 8, top + bh * 0.3),
                                     QPointF(bx + bwid, top + bh * 0.3 + bh * 0.5), QPointF(bx, top + bh * 0.3 + bh * 0.5)]))
        # window grid
        if windows:
            cols = max(2, int(bw // 55))
            rows = max(2, int(bh // 80))
            cw, rh = bw / cols, (bh * 0.85) / rows
            for r in range(rows):
                for c in range(cols):
                    wx = x + c * cw + cw * 0.22
                    wy = top + bh * 0.1 + r * rh + rh * 0.15
                    ww, wh = cw * 0.56, rh * 0.62
                    p.setBrush(col(pal["trim"]))
                    p.drawRect(QRectF(wx - 3, wy - 3, ww + 6, wh + 6))
                    g = QLinearGradient(wx, wy, wx, wy + wh)
                    g.setColorAt(0.0, QColor(pal["windowLight"]))
                    g.setColorAt(1.0, QColor(pal["windowDark"]))
                    p.setBrush(QBrush(g))
                    p.drawRect(QRectF(wx, wy, ww, wh))
                    p.setBrush(col("#ffffff", 0.35))
                    p.drawPolygon(QPolygonF([QPointF(wx, wy), QPointF(wx + ww * 0.45, wy), QPointF(wx, wy + wh * 0.6)]))


def paint_rowhouses(img, rng, pal, horizon_y, params):
    w, h = img.width(), img.height()
    p = painter(img)
    base0 = params.get("baseY", 0.7) * h
    slope = params.get("slope", 0.05)
    minw, maxw = params.get("minW", 90), params.get("maxW", 150)
    minh, maxh = params.get("minH", 150), params.get("maxH", 250)
    windows = params.get("windows", True)
    tree_p = params.get("trees", 0.0)
    detail = 1 if windows or maxw > 60 else 0
    x = -rng.uniform(0, minw)
    while x < w:
        bw = rng.uniform(minw, maxw)
        bh = rng.uniform(minh, maxh)
        base_y = base0 + (x / w) * slope * h * 4 + rng.uniform(-0.01, 0.01) * h
        draw_house(p, rng, pal, x, base_y, bw, bh, windows, detail)
        if tree_p and rng.random() < tree_p:
            draw_tree(p, rng, pal, x + bw + rng.uniform(-10, 30), base_y + 10, bh * rng.uniform(0.7, 1.1))
        x += bw + rng.uniform(-6, 10)
    p.end()


PAINTERS = {"sky": paint_sky, "clouds": paint_clouds, "hills": paint_hills, "rowhouses": paint_rowhouses}


# ----------------------------------------------------------------------------- finishing

def apply_haze(img, haze_hex, amount):
    """Tint existing (non-transparent) pixels toward the haze colour: atmospheric perspective."""
    if amount <= 0:
        return
    p = QPainter(img)
    p.setCompositionMode(QPainter.CompositionMode_SourceAtop)
    p.fillRect(QRectF(0, 0, img.width(), img.height()), col(haze_hex, amount))
    p.end()


def make_grain_tile(rng, amount, size=256):
    """Zero-mean grain: random white or black pixels with low alpha, so average colour and saturation are unchanged."""
    tile = QImage(size, size, QImage.Format_ARGB32)
    peak = int(max(0.0, min(1.0, amount)) * 255 * 2)
    for y in range(size):
        for x in range(size):
            v = rng.randint(-255, 255)
            a = abs(v) * peak // 255
            rgb = 0xFFFFFF if v > 0 else 0x000000
            tile.setPixel(x, y, (a << 24) | rgb)
    return tile


def apply_grain(img, tile, amount):
    """Film grain over existing pixels only (SourceAtop keeps transparent areas transparent)."""
    if amount <= 0:
        return
    p = QPainter(img)
    p.setCompositionMode(QPainter.CompositionMode_SourceAtop)
    p.fillRect(QRectF(0, 0, img.width(), img.height()), QBrush(tile))
    p.end()


def qimage_from_bytes(data, w, h):
    buf = bytes(data)  # keep the buffer alive until the deep copy below is done
    return QImage(buf, w, h, QImage.Format_ARGB32).copy()


def main(job):
    app = Krita.instance()
    app.setBatchmode(True)
    paint = job["paint"]
    pal = job["palette"]
    w, h = int(paint["width"]), int(paint["height"])
    horizon_y = paint["horizon"] * h
    out = job["outDir"]
    os.makedirs(os.path.join(out, "layers"), exist_ok=True)
    seed = int(job["seed"])

    doc = app.createDocument(w, h, "background", "RGBA", "U8", "", 72.0)
    doc.setBatchmode(True)
    root = doc.rootNode()
    default_layer = root.childNodes()[0]  # reuse the default layer as the first one (removing it hangs Krita)

    grain_tile = make_grain_tile(random.Random(seed ^ 0x5EED), job.get("grain", 0.0))
    layers = []
    previous = None
    for i, spec in enumerate(paint["layers"]):
        rng = random.Random(seed * 1000 + i * 7919)
        img = new_image(w, h)
        PAINTERS[spec["type"]](img, rng, pal, horizon_y, spec.get("params", {}))
        apply_haze(img, pal["haze"], spec.get("params", {}).get("haze", 0.0))
        apply_grain(img, grain_tile, job.get("grain", 0.0))

        if i == 0:
            node = default_layer
            node.setName(spec["name"])
        else:
            node = doc.createNode(spec["name"], "paintlayer")
            root.addChildNode(node, previous)
        node.setPixelData(bytes(img.constBits().asstring(img.byteCount())), 0, 0, w, h)
        previous = node
        layers.append((spec, node))

    doc.refreshProjection()
    doc.waitForDone()

    result = {"layers": []}
    for spec, node in layers:
        data = node.pixelData(0, 0, w, h)
        qimg = qimage_from_bytes(data, w, h)
        path = os.path.join(out, "layers", spec["name"] + ".png")
        if not qimg.save(path, "PNG"):
            raise RuntimeError("could not write " + path)
        result["layers"].append({"name": spec["name"], "file": path, "depth": spec["depth"]})

    flat = doc.projection(0, 0, w, h)  # a QImage already
    preview = os.path.join(out, "preview.png")
    flat.scaled(w // 2, h // 2, Qt.KeepAspectRatio, Qt.SmoothTransformation).save(preview, "PNG")
    kra = os.path.join(out, "layers.kra")
    if not doc.saveAs(kra):
        raise RuntimeError("could not save " + kra)
    doc.close()
    result["kra"] = kra
    result["preview"] = preview
    return result
