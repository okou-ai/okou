#!/usr/bin/env python3
"""Smoke-test a signed Release APK from the host on a disposable API 35 emulator."""

import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from xml.etree import ElementTree

PACKAGE = "ai.okou.android"
SERIAL = "emulator-5580"
IMAGE = "system-images;android-35;default;x86_64"
UI_DUMP = "/data/local/tmp/okou-release-smoke.xml"


def has_public_auth_surface(output):
    try:
        root = ElementTree.fromstring(output)
    except ElementTree.ParseError:
        return False
    return any(
        node.get("package") == PACKAGE and node.get("text") in {"Welcome to Okou", "Okou"}
        for node in root.iter("node")
    )


def wait_until(emulator, check, description, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if emulator.poll() is not None:
            raise RuntimeError("Emulator exited before " + description)
        try:
            if check():
                return
        except subprocess.TimeoutExpired:
            # Device commands can time out during boot or UI transitions.
            # Keep polling until the readiness deadline.
            pass
        time.sleep(1)
    raise TimeoutError("Timed out waiting for " + description)


def run(apk, artifacts, avd_home):
    sdk = Path(os.environ["ANDROID_HOME"])
    adb = sdk / "platform-tools" / "adb"
    manager = sdk / "cmdline-tools" / "13114758" / "bin" / "avdmanager"
    devices = subprocess.check_output([adb, "devices"], text=True, timeout=15)
    if any(line.split()[:1] == [SERIAL] for line in devices.splitlines()):
        raise RuntimeError(f"{SERIAL} is already in use")
    environment = dict(os.environ, ANDROID_AVD_HOME=str(avd_home))
    subprocess.run(
        [manager, "create", "avd", "-n", "release-smoke", "-k", IMAGE, "-d", "pixel_2"],
        input="no\n", text=True, env=environment, check=True, timeout=60,
    )

    def device(*args, check=True, timeout=15):
        result = subprocess.run(
            [adb, "-s", SERIAL, *args], capture_output=True, text=True, timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(f"adb {' '.join(args)} failed: {result.stdout}{result.stderr}")
        return result

    def auth_surface():
        dumped = device("shell", f"rm -f {UI_DUMP} && uiautomator dump {UI_DUMP}", check=False)
        if dumped.returncode:
            return False
        output = device("exec-out", "cat", UI_DUMP, check=False)
        if output.returncode:
            return False
        (artifacts / "release-smoke-ui.xml").write_text(output.stdout)
        return has_public_auth_surface(output.stdout)

    with (artifacts / "release-smoke-emulator.log").open("w") as log:
        emulator = subprocess.Popen(
            [sdk / "emulator" / "emulator", "-avd", "release-smoke", "-port", "5580",
             "-no-window", "-no-audio", "-no-snapshot", "-gpu", "swiftshader_indirect"],
            env=environment, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            wait_until(emulator, lambda: device(
                "shell", "getprop", "sys.boot_completed", check=False,
            ).stdout.strip() == "1", "Android boot", 180)
            device("shell", "input", "keyevent", "KEYCODE_WAKEUP")
            device("shell", "wm", "dismiss-keyguard")
            device("shell", "cmd", "connectivity", "airplane-mode", "enable")
            device("shell", "svc", "wifi", "disable")
            device("install", str(apk), timeout=90)
            launcher = ("-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
            component = device(
                "shell", "cmd", "package", "resolve-activity", "--components", *launcher, "-p", PACKAGE,
            ).stdout.strip()
            if not component.startswith(f"{PACKAGE}/"):
                raise RuntimeError(f"No launcher activity for {PACKAGE}: {component}")
            for journey in ("cold start", "relaunch after process stop"):
                device("shell", "am", "force-stop", PACKAGE)
                started = device(
                    "shell", "am", "start", "-W", *launcher, "-n", shlex.quote(component), timeout=45,
                )
                if "Status: ok" not in started.stdout:
                    raise RuntimeError(f"Launcher failed: {started.stdout} {started.stderr}")
                wait_until(emulator, auth_surface, journey + " auth surface", 45)
                print(f"Release smoke passed: {journey}", flush=True)
            crashes = device("logcat", "-d", "-b", "crash").stdout
            if re.search(rf"^.*Process: {re.escape(PACKAGE)}, PID:", crashes, re.MULTILINE):
                raise RuntimeError("Release app crashed during startup smoke")
        finally:
            try:
                diagnostics = device("logcat", "-d", "-b", "main", "-b", "system", "-b", "crash", check=False)
                (artifacts / "release-smoke-logcat.log").write_text(
                    diagnostics.stdout + diagnostics.stderr
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                print(f"Could not collect emulator logcat: {error}", file=sys.stderr)
            finally:
                if emulator.poll() is None:
                    emulator.terminate()
                    try:
                        emulator.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        emulator.kill()
                        emulator.wait()


def terminate(_signum, _frame):
    raise SystemExit(143)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    with tempfile.TemporaryDirectory(prefix="okou-release-smoke-") as temporary:
        run(Path(sys.argv[1]), Path(sys.argv[2]), Path(temporary))
