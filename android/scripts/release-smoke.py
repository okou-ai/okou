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
PORT = "5580"
SERIAL = f"emulator-{PORT}"
IMAGE = "system-images;android-35;default;x86_64"
UI_DUMP = "/data/local/tmp/okou-release-smoke.xml"


def has_public_auth_surface(output):
    try:
        root = ElementTree.fromstring(output)
    except ElementTree.ParseError:
        return False
    # Workspace screens also show the app name. Require the authentication heading.
    return any(
        node.get("package") == PACKAGE
        and node.get("text") in {"Welcome to Okou", "Continue to Okou"}
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

    def adb_command(*args, check=True, timeout=15):
        result = subprocess.run(
            [adb, *args], capture_output=True, text=True, timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(f"adb {' '.join(args)} failed: {result.stdout}{result.stderr}")
        return result

    devices = adb_command("devices").stdout
    if any(line.split()[:1] == [SERIAL] for line in devices.splitlines()):
        raise RuntimeError(f"{SERIAL} is already in use")

    avd_name = avd_home.name
    manager = sdk / "cmdline-tools" / "13114758" / "bin" / "avdmanager"
    environment = dict(os.environ, ANDROID_AVD_HOME=str(avd_home))
    subprocess.run(
        [manager, "create", "avd", "-n", avd_name, "-k", IMAGE, "-d", "pixel_2"],
        input="no\n", text=True, env=environment, check=True, timeout=60,
    )

    transport = None

    def booted():
        nonlocal transport
        devices = adb_command("devices", "-l").stdout
        candidate = re.search(
            rf"^{SERIAL}[ \t]+device\b[^\n]*\btransport_id:(\d+)\b", devices, re.MULTILINE,
        )
        if candidate is None:
            return False
        result = adb_command(
            "-t", candidate[1], "shell", "getprop ro.boot.qemu.avd_name && getprop sys.boot_completed",
            check=False,
        )
        properties = result.stdout.splitlines()
        if result.returncode or not properties or not properties[0]:
            return False
        if properties[0] != avd_name:
            raise RuntimeError(f"{SERIAL} belongs to a different AVD")
        transport = candidate[1]
        return properties[1:] == ["1"]

    def device(*args, check=True, timeout=15):
        return adb_command("-t", transport, *args, check=check, timeout=timeout)

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
            [sdk / "emulator" / "emulator", "-avd", avd_name, "-port", PORT,
             "-no-window", "-no-audio", "-no-snapshot", "-gpu", "swiftshader_indirect"],
            env=environment, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            wait_until(emulator, booted, "Android boot", 180)
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
                if transport is not None:
                    diagnostics = device(
                        "logcat", "-d", "-v", "threadtime", "-b", "main", "-b", "system", "-b", "crash",
                        check=False,
                    )
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
