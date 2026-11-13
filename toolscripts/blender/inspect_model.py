"""Developer aid: describe a glTF/GLB model (objects, dimensions, materials) so a vehicle manifest can be written.

Job: {"resultPath", "model": path}
Result: {"objects": [{name,type,parent,location,dimensions,vertices,materials}], "materials": [{name, baseColor}], "bounds": {min,max,size}}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import hjob  # noqa: E402
from mathutils import Vector  # noqa: E402


def main():
    job = hjob.load_job()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["model"])
    objs = []
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in bpy.context.scene.objects:
        entry = {
            "name": ob.name, "type": ob.type, "parent": ob.parent.name if ob.parent else None,
            "location": [round(v, 4) for v in ob.matrix_world.translation],
            "dimensions": [round(v, 4) for v in ob.dimensions],
        }
        if ob.type == "MESH":
            entry["vertices"] = len(ob.data.vertices)
            entry["materials"] = [m.name if m else None for m in ob.data.materials]
            # Where each material's faces are (world space): tells which way is forward (headlights) and where wheels are.
            sums = {}
            for poly in ob.data.polygons:
                c = ob.matrix_world @ poly.center
                s = sums.setdefault(poly.material_index, [0.0, 0.0, 0.0, 0])
                s[0] += c.x; s[1] += c.y; s[2] += c.z; s[3] += 1
            entry["materialCentroids"] = {
                (ob.data.materials[i].name if i < len(ob.data.materials) and ob.data.materials[i] else str(i)):
                [round(s[0] / s[3], 3), round(s[1] / s[3], 3), round(s[2] / s[3], 3)] for i, s in sums.items()}
            bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
            entry["bboxCenter"] = [round(sum(v[k] for v in bb) / 8, 3) for k in range(3)]
            for corner in ob.bound_box:
                w = ob.matrix_world @ Vector(corner)
                lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
                hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
        objs.append(entry)
    mats = []
    for m in bpy.data.materials:
        base = None
        if m.use_nodes:
            bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                base = [round(v, 3) for v in bsdf.inputs["Base Color"].default_value]
        mats.append({"name": m.name, "baseColor": base})
    hjob.write_result(job, {"objects": objs, "materials": mats,
                            "bounds": {"min": [round(v, 3) for v in lo], "max": [round(v, 3) for v in hi], "size": [round(v, 3) for v in (hi - lo)]}})


main()
