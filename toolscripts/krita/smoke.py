"""Doctor smoke test: 2-layer document, one painted stroke, export a PNG and a layered .kra.

Painting goes through PyQt5's QPainter (bundled with Krita) onto a QImage, then into the paint
layer with Node.setPixelData. Krita's RGBA/U8 pixel order is BGRA, which matches QImage
Format_ARGB32 on little-endian machines.
Job: {"outPng": path, "outKra": path}
"""
from krita import Krita, InfoObject
from PyQt5.QtCore import QPointF, Qt
from PyQt5.QtGui import QImage, QPainter, QPen, QColor, QPainterPath


def main(job):
    app = Krita.instance()
    app.setBatchmode(True)
    w, h = 640, 360
    doc = app.createDocument(w, h, "smoke", "RGBA", "U8", "", 72.0)
    root = doc.rootNode()
    # createDocument adds a blank "Background" layer. Reuse it as layer 1: removing the only layer hangs Krita
    # (measured 2026-11-13: every run that called Node.remove() on it timed out).
    bg = root.childNodes()[0]
    bg.setName("background")
    img = QImage(w, h, QImage.Format_ARGB32)
    img.fill(QColor(120, 180, 235))
    bg.setPixelData(bytes(img.constBits().asstring(img.byteCount())), 0, 0, w, h)

    ink = doc.createNode("stroke", "paintlayer")
    root.addChildNode(ink, bg)
    img2 = QImage(w, h, QImage.Format_ARGB32)
    img2.fill(Qt.transparent)
    p = QPainter(img2)
    p.setRenderHint(QPainter.Antialiasing)
    p.setPen(QPen(QColor(30, 40, 60), 14, Qt.SolidLine, Qt.RoundCap))
    path = QPainterPath(QPointF(60, 280))
    path.cubicTo(QPointF(200, 60), QPointF(420, 320), QPointF(580, 90))
    p.drawPath(path)
    p.end()
    ink.setPixelData(bytes(img2.constBits().asstring(img2.byteCount())), 0, 0, w, h)

    doc.refreshProjection()
    doc.waitForDone()
    # Never use doc.exportImage() for PNG: it opens a modal "PNG image" options dialog that blocks a headless
    # run forever (measured 2026-11-13). Write the flattened projection with Qt instead.
    flat = QImage(bytes(doc.projection(0, 0, w, h).constBits().asstring(w * h * 4)), w, h, QImage.Format_ARGB32)
    ok_png = flat.save(job["outPng"], "PNG")
    doc.setBatchmode(True)
    ok_kra = doc.saveAs(job["outKra"])
    layers = [n.name() for n in root.childNodes()]
    doc.close()
    return {"png": bool(ok_png), "kra": bool(ok_kra), "layers": layers}
