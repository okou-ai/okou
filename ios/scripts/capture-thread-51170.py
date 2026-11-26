"""Capture the iPhone which owns this fixture, after the current test presents it."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

out = Path(os.environ["RUNNER_TEMP"]) / "thread-parity-51170"
out.mkdir(exist_ok=True)
inventory = json.loads(subprocess.check_output(["xcrun","simctl","list","devices","booted","-j"]))
devices = [d for group in inventory["devices"].values() for d in group if d["name"]=="iPhone 18 Pro"]
assert len(devices) == 1, devices
device = devices[0]["udid"]
def folder():
    proc = subprocess.run(["xcrun","simctl","get_app_container",device,"ai.okou.ios","data"],capture_output=True,text=True)
    if proc.returncode: return None
    return Path(proc.stdout.strip())/"Documents"/"thread-parity-51170"
if "--collect" in sys.argv:
    if len(list(out.glob("thread-??.png"))) == 9:
        sys.exit(0)
    source = folder()
    assert source and len(list(source.glob("ui-??.png"))) == 9, source
    for i,p in enumerate(sorted(source.glob("ui-??.png"))):
        shutil.copy2(p,out/f"thread-{i:02}.png")
    (out/"capture.txt").write_text("UIKit simulator window")
    (out/"device.json").write_text(json.dumps(inventory,indent=2))
    sys.exit(0)

started = time.time()
subprocess.run(["xcrun","simctl","spawn",device,"defaults","write","ai.okou.ios","AppleLanguages","-array","zh-Hans","en"],check=True)
subprocess.run(["xcrun","simctl","status_bar",device,"override","--time","9:41"],check=True)
deadline=time.monotonic()+100
while time.monotonic()<deadline:
    directory=folder()
    marker=directory/"ready" if directory else None
    if marker and marker.exists() and marker.stat().st_mtime >= started:
        for i in range(9):
            subprocess.run(["xcrun","simctl","io",device,"screenshot",str(out/f"thread-{i:02}.png")],check=True)
            time.sleep(.25)
        (out/"capture.txt").write_text("simctl full device screen")
        (out/"device.json").write_text(json.dumps(inventory,indent=2))
        sys.exit(0)
    time.sleep(.3)
raise SystemExit("No fresh ready marker on the selected simulator.")
