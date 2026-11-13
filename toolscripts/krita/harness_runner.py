"""Fixed shim that kritarunner loads (`kritarunner -s harness_runner -f main`).

The Krita adapter copies this file into Krita's share/krita/pykrita folder. It reads the job path
from HARNESS_KRITA_JOB, runs job["script"]'s main(job) and writes {"ok", "result"|"error"} to
job["resultPath"]. No shot-specific logic lives here.
"""
import importlib.util
import json
import os
import traceback


def main(*_args):
    job_path = os.environ.get("HARNESS_KRITA_JOB", "")
    result_path = None
    try:
        # Batch mode: Krita must never open a dialog (export options, recovery prompts), or a headless run blocks forever.
        from krita import Krita
        Krita.instance().setBatchmode(True)
        with open(job_path, "r", encoding="utf-8") as f:
            job = json.load(f)
        result_path = job["resultPath"]
        spec = importlib.util.spec_from_file_location("harness_job_script", job["script"])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        result = mod.main(job)
        payload = {"ok": True, "result": result}
    except Exception:  # report every failure through the result file
        payload = {"ok": False, "error": traceback.format_exc()}
    if result_path is None:
        result_path = job_path + ".result.json"
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    try:
        from krita import Krita
        Krita.instance().action("file_quit")
    except Exception:
        pass
