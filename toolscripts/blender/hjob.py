"""Shared helpers for harness Blender scripts: job loading and result writing.

Every script is run as: blender --factory-startup -b [file.blend] --python-exit-code 3 -P <script> -- <job.json>
"""
import json
import sys


def load_job():
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("hjob: expected '-- <job.json>' after the script")
    path = argv[argv.index("--") + 1]
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_result(job, result):
    with open(job["resultPath"], "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


def eevee_id():
    """Engine identifier for EEVEE in this Blender build ('BLENDER_EEVEE' in 5.x, '..._NEXT' in 4.2-4.5)."""
    import bpy
    ids = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    for cand in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        if cand in ids:
            return cand
    return None


def engine_id(name):
    """Map a harness engine name (eevee|cycles|workbench) to this build's identifier."""
    if name == "eevee":
        return eevee_id()
    return {"cycles": "CYCLES", "workbench": "BLENDER_WORKBENCH"}[name]
