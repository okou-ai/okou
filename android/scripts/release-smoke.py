#!/usr/bin/env python3
"""Smoke-test a signed Release APK from the host on a disposable API 35 emulator."""

import json
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
APP_DATA = f"/data/user/0/{PACKAGE}"
UPDATE_STATE = "files/updates/state.json"
AUTH_HEADINGS = {"Welcome to Okou", "Continue to Okou"}
REQUIRED_HEADING = "Update Okou to continue"


def app_labels(output):
    try:
        root = ElementTree.fromstring(output)
    except ElementTree.ParseError:
        return set()
    return {
        node.get("text", "")
        for node in root.iter("node")
        if node.get("package") == PACKAGE
    }


def isolate_network(device):
    # The SDK setup app can re-enable Wi-Fi after airplane mode and svc wifi disable.
    # Block guest IP egress independently of the radios. ADB uses the emulator transport.
    for tool in ("iptables", "ip6tables"):
        device("shell", "su", "0", tool, "-w", "5", "-I", "OUTPUT", "!", "-o", "lo", "-j", "REJECT")


def seed_required_update(device, version, artifacts):
    major, minor, patch = version.split(".")
    minimum = f"{major}.{minor}.{int(patch) + 1}"
    record = json.dumps({"installedVersion": version, "blocked": True, "minimum": minimum})
    device("shell", "am", "force-stop", PACKAGE)
    # Write the same state FileUpdateStore would restore after an upgrade-required response.
    command = (
        f"cd {APP_DATA} && umask 077 && mkdir -p files/updates && "
        f"printf '%s\\n' {shlex.quote(record)} > {UPDATE_STATE} && "
        f'chown "$(stat -c %u:%g .)" files files/updates {UPDATE_STATE} && '
        f"restorecon -F files files/updates {UPDATE_STATE}"
    )
    device("shell", "su", "0", "sh", "-c", shlex.quote(command))
    (artifacts / "required-update-fixture.json").write_text(record + "\n")
    return minimum


def blocked_minimum(device, version):
    try:
        result = device("shell", "su", "0", "cat", f"{APP_DATA}/{UPDATE_STATE}", check=False, timeout=5)
        if result.returncode:
            return None
        record = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return None
    if (
        not isinstance(record, dict)
        or record.get("installedVersion") != version
        or record.get("blocked") is not True
    ):
        return None
    minimum = record.get("minimum")
    if isinstance(minimum, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", minimum):
        return minimum
    return None


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


def run_launch(device, emulator, evidence, description, launcher, component, version, *, expected_minimum=None):
    evidence.mkdir()

    def record_surface(surface, minimum=None):
        (evidence / "launch-outcome.json").write_text(json.dumps({
            "testedVersion": version,
            "expectedSurface": "signed-out" if expected_minimum is None else "mandatory-update",
            "observedSurface": surface,
            "minimumSupportedVersion": minimum,
        }, indent=2) + "\n")

    def observe(report, label, *args, timeout=15):
        try:
            result = device(*args, check=False, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            report.write(f"{label} timed out after {timeout}s\n")
            for output in (error.stdout, error.stderr):
                if output:
                    report.write(output.decode(errors="replace"))
            raise
        report.write(f"{label} exit: {result.returncode}\n{result.stdout}{result.stderr}")
        return result

    def expected_surface():
        with (evidence / "ui-probe.txt").open("w") as probe:
            dumped = observe(probe, "uiautomator", "shell", f"rm -f {UI_DUMP} && uiautomator dump {UI_DUMP}")
            if dumped.returncode:
                return False
            output = observe(probe, "hierarchy read", "exec-out", "cat", UI_DUMP)
        if output.returncode:
            return False
        (evidence / "ui.xml").write_text(output.stdout)
        labels = app_labels(output.stdout)
        if REQUIRED_HEADING in labels:
            minimum = blocked_minimum(device, version)
            record_surface("mandatory-update", minimum)
            if expected_minimum is None:
                raise RuntimeError(
                    f"{description}: Release APK {version} is blocked by mandatory update "
                    f"(minimum supported version: {minimum or 'unavailable'})"
                )
            if minimum != expected_minimum or f"Current version: {version}" not in labels or AUTH_HEADINGS & labels:
                raise RuntimeError(
                    f"Release APK {version} did not show the expected mandatory-update surface "
                    f"(expected minimum {expected_minimum}, recorded {minimum or 'unavailable'})"
                )
            return True
        # Workspace screens also show the app name. Require the authentication heading.
        if expected_minimum is None and AUTH_HEADINGS & labels:
            record_surface("signed-out")
            return True
        return False

    try:
        device("shell", "am", "force-stop", PACKAGE)
        with (evidence / "launcher.txt").open("w") as report:
            started = observe(
                report, "am start", "shell", "am", "start", "-W", *launcher,
                "-n", shlex.quote(component), timeout=45,
            )
        if started.returncode or "Status: ok" not in started.stdout:
            raise RuntimeError(f"Launcher failed: {started.stdout} {started.stderr}")
        surface = "auth surface" if expected_minimum is None else "mandatory-update surface"
        wait_until(emulator, expected_surface, f"{description} {surface}", 45)
    except Exception:
        for filename, args, binary in (
            ("foreground.txt", ("shell", "dumpsys", "activity", "activities"), False),
            ("screen.png", ("exec-out", "screencap", "-p"), True),
        ):
            try:
                result = device(*args, check=False, timeout=5, text=not binary)
                if binary:
                    if result.returncode == 0 and result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
                        (evidence / filename).write_bytes(result.stdout)
                    else:
                        print(f"Could not capture {filename}: adb exit {result.returncode}", file=sys.stderr)
                else:
                    (evidence / filename).write_text(
                        f"dumpsys exit: {result.returncode}\n{result.stdout}{result.stderr}"
                    )
            except (OSError, UnicodeError, subprocess.TimeoutExpired) as error:
                print(f"Could not capture {filename}: {error}", file=sys.stderr)
        raise
    print(f"Release smoke passed: {description}", flush=True)


def run(apk, artifacts, avd_home, version):
    sdk = Path(os.environ["ANDROID_HOME"])
    adb = sdk / "platform-tools" / "adb"

    def adb_command(*args, check=True, timeout=15, text=True):
        result = subprocess.run(
            [adb, *args], capture_output=True, text=text, timeout=timeout,
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

    def device(*args, **options):
        return adb_command("-t", transport, *args, **options)

    with (artifacts / "release-smoke-emulator.log").open("w") as log:
        emulator = subprocess.Popen(
            [sdk / "emulator" / "emulator", "-avd", avd_name, "-port", PORT,
             "-no-window", "-no-audio", "-no-snapshot", "-gpu", "swiftshader_indirect"],
            env=environment, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            wait_until(emulator, booted, "Android boot", 180)
            isolate_network(device)
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
            run_launch(device, emulator, artifacts / "cold-start", "cold start", launcher, component, version)
            run_launch(
                device, emulator, artifacts / "relaunch", "relaunch after process stop", launcher, component, version,
            )
            minimum = seed_required_update(device, version, artifacts)
            run_launch(
                device, emulator, artifacts / "required-update", "mandatory update", launcher, component, version,
                expected_minimum=minimum,
            )
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
    apk, artifacts, version = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="okou-release-smoke-") as temporary:
        run(Path(apk), Path(artifacts), Path(temporary), version)
