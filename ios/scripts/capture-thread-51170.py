"""Capture only the disposable simulator showing the native fixture."""
import json
import os
from pathlib import Path
import subprocess
import time

out = Path(os.environ["RUNNER_TEMP"]) / "thread-parity-51170"
out.mkdir(exist_ok=True)
devices = Path.home() / "Library/Developer/CoreSimulator/Devices"
deadline = time.monotonic() + 150
while time.monotonic() < deadline:
    for ready in devices.glob("*/data/Containers/Data/Application/*/Documents/thread-parity-51170/ready"):
        if ready.with_name("captured").exists():
            continue
        device = ready.relative_to(devices).parts[0]
        booted = json.loads(subprocess.check_output(["xcrun","simctl","list","devices","booted","-j"]))
        if not any(d["udid"] == device for group in booted["devices"].values() for d in group):
            continue
        subprocess.run(["xcrun","simctl","status_bar",device,"override","--time","9:41"],check=True)
        time.sleep(1.4)
        for index in range(9):
            subprocess.run(["xcrun","simctl","io",device,"screenshot",str(out / f"thread-{index:02}.png")],check=True)
            time.sleep(.24)
        (out / "device.json").write_text(json.dumps(booted,indent=2))
        ready.with_name("captured").touch()
        raise SystemExit(0)
    time.sleep(.5)
raise SystemExit("The native thread did not announce readiness.")
