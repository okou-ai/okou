"""Record the actual simulator display, and keep the same thread alive through recording."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

out = Path(os.environ["RUNNER_TEMP"]) / "thread-parity-51170"
out.mkdir(exist_ok=True)
inventory = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "booted", "-j"]))
devices = [device for group in inventory["devices"].values() for device in group if device["name"] == "iPhone 18 Pro"]
assert len(devices) == 1, devices
device = devices[0]["udid"]
(out / "device.json").write_text(json.dumps(inventory, indent=2))

def folder():
    result = subprocess.run(["xcrun", "simctl", "get_app_container", device, "ai.okou.ios", "data"], capture_output=True, text=True)
    if result.returncode == 0:
        return Path(result.stdout.strip()) / "Documents" / "thread-parity-51170"

if "--collect" in sys.argv:
    source = folder()
    frames = sorted(source.glob("ui-??.png")) if source else []
    assert len(frames) == 9, frames
    for index, path in enumerate(frames):
        shutil.copy2(path, out / f"thread-{index:02}.png")
    print("Collected nine sequential native window frames.", flush=True)
    sys.exit(0)

started = time.time()
subprocess.run(["xcrun", "simctl", "spawn", device, "defaults", "write", "ai.okou.ios", "AppleLanguages", "-array", "zh-Hans", "en"], check=True)
subprocess.run(["xcrun", "simctl", "status_bar", device, "override", "--time", "9:41"], check=True)
deadline = time.monotonic() + 130
while time.monotonic() < deadline:
    directory = folder()
    marker = directory / "ready" if directory else None
    if marker and marker.exists() and marker.stat().st_mtime >= started:
        break
    time.sleep(0.3)
else:
    raise SystemExit("No fresh ready marker on the selected simulator.")

try:
    video = out / "thread.mp4"
    recorder = subprocess.Popen(["xcrun", "simctl", "io", device, "recordVideo", "--codec=h264", "--force", str(video)])
    time.sleep(8)
    recorder.send_signal(signal.SIGINT)
    recorder.wait(timeout=45)
    assert video.is_file() and video.stat().st_size > 10000, "Missing simulator frames"
    (out / "capture.txt").write_text("Native iPhone screen recording and native window frames.")
    print("Saved native video", video.stat().st_size, flush=True)
finally:
    (directory / "recorded").write_text("finished")
