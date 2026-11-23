"""Exercise Android test diagnostics and release payload verification."""

import gzip
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import zipfile

SCRIPTS = Path(__file__).resolve().parent


class ReleaseDiagnosticsTest(unittest.TestCase):
    def test_release_smoke_requires_app_owned_auth_surface(self):
        smoke = runpy.run_path(str(SCRIPTS / "release-smoke.py"))

        def surface(xml):
            return smoke["AUTH_HEADINGS"] & smoke["app_labels"](xml)

        self.assertTrue(surface('<hierarchy><node package="ai.okou.android" text="Restoring your session…"/></hierarchy>'))
        self.assertTrue(surface('<hierarchy><node package="ai.okou.android" text="Couldn’t load your session or workspace"/></hierarchy>'))
        self.assertTrue(surface('<hierarchy><node package="ai.okou.android" text="Continue to Okou"/></hierarchy>'))
        self.assertFalse(surface('<hierarchy><node package="ai.okou.android" text="Okou"/></hierarchy>'))
        self.assertFalse(surface('<hierarchy><node package="com.android.launcher3" text="Restoring your session…"/></hierarchy>'))
        self.assertFalse(surface('<hierarchy><node package="ai.okou.android" text=""/></hierarchy>'))
        self.assertFalse(surface('<hierarchy>'))

    def test_relaunch_failure_retains_its_own_evidence(self):
        run_launch = runpy.run_path(str(SCRIPTS / "release-smoke.py"))["run_launch"]

        def check_once(_emulator, check, description, seconds):
            self.assertEqual(seconds, 45)
            if not check():
                raise TimeoutError(description)

        run_launch.__globals__["wait_until"] = check_once
        launches = 0
        screenshot = b"\x89PNG\r\n\x1a\nfixture"

        def device(*args, **options):
            nonlocal launches
            if args[:3] == ("shell", "am", "force-stop"):
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[:3] == ("shell", "am", "start"):
                launches += 1
                return subprocess.CompletedProcess(args, 0, f"Status: ok\nLaunch: {launches}", "")
            if args[:1] == ("shell",) and "uiautomator dump" in args[1]:
                if launches == 2:
                    return subprocess.CompletedProcess(args, 1, "", "UI hierarchy unavailable")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[:2] == ("exec-out", "cat"):
                self.assertEqual(launches, 1)
                xml = '<hierarchy><node package="ai.okou.android" text="Continue to Okou"/></hierarchy>'
                return subprocess.CompletedProcess(args, 0, xml, "")
            self.assertEqual(launches, 2)
            self.assertEqual(options["timeout"], 5)
            if args[:2] == ("shell", "dumpsys"):
                raise subprocess.TimeoutExpired(args, 5)
            self.assertEqual(args, ("exec-out", "screencap", "-p"))
            self.assertFalse(options["text"])
            return subprocess.CompletedProcess(args, 0, screenshot, b"")

        with tempfile.TemporaryDirectory() as temporary:
            cold_start = Path(temporary) / "cold-start"
            relaunch = Path(temporary) / "relaunch"
            component = "ai.okou.android/.MainActivity"
            run_launch(device, None, cold_start, "cold start", (), component, "0.36.0")
            with self.assertRaisesRegex(TimeoutError, "relaunch auth surface"):
                run_launch(device, None, relaunch, "relaunch", (), component, "0.36.0")
            self.assertIn("Launch: 1", (cold_start / "launcher.txt").read_text())
            self.assertIn("Continue to Okou", (cold_start / "ui.xml").read_text())
            self.assertIn("Launch: 2", (relaunch / "launcher.txt").read_text())
            self.assertIn("UI hierarchy unavailable", (relaunch / "ui-probe.txt").read_text())
            self.assertFalse((relaunch / "ui.xml").exists())
            self.assertEqual((relaunch / "screen.png").read_bytes(), screenshot)

    def test_required_update_reports_the_recorded_floor_and_respects_the_expected_surface(self):
        run_launch = runpy.run_path(str(SCRIPTS / "release-smoke.py"))["run_launch"]
        version = "0.36.0"
        minimum = "0.37.2"
        component = "ai.okou.android/.MainActivity"
        hierarchy = """<hierarchy>
          <node package="ai.okou.android" text="Update Okou to continue"/>
          <node package="ai.okou.android" text="Current version: 0.36.0"/>
          <node package="ai.okou.android" text="New version: 0.40.0"/>
        </hierarchy>"""
        screenshot = b"\x89PNG\r\n\x1a\nfixture"

        def check_once(_emulator, check, description, _seconds):
            if not check():
                self.fail(f"Unexpected timeout waiting for {description}")

        def device(*args, **options):
            if args[:2] == ("exec-out", "cat"):
                output = hierarchy
            elif args[:4] == ("shell", "su", "0", "cat"):
                self.assertTrue(args[-1].endswith("/files/updates/state.json"))
                output = json.dumps({"installedVersion": version, "blocked": True, "minimum": minimum})
            elif args[:3] == ("shell", "am", "start"):
                output = "Status: ok"
            elif args[:2] == ("exec-out", "screencap"):
                self.assertFalse(options["text"])
                return subprocess.CompletedProcess(args, 0, screenshot, b"")
            else:
                output = ""
            return subprocess.CompletedProcess(args, 0, output, "")

        run_launch.__globals__["wait_until"] = check_once
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            unexpected = evidence / "cold-start"
            with self.assertRaisesRegex(RuntimeError, r"0\.36\.0.*minimum supported version: 0\.37\.2"):
                run_launch(device, None, unexpected, "cold start", (), component, version)
            self.assertEqual((unexpected / "screen.png").read_bytes(), screenshot)
            self.assertEqual((unexpected / "ui.xml").read_text(), hierarchy)
            expected = evidence / "required-update"
            run_launch(device, None, expected, "mandatory update", (), component, version, expected_minimum=minimum)
            for path, expected_surface in ((unexpected, "signed-out"), (expected, "mandatory-update")):
                self.assertEqual(json.loads((path / "launch-outcome.json").read_text()), {
                    "testedVersion": version,
                    "expectedSurface": expected_surface,
                    "observedSurface": "mandatory-update",
                    "minimumSupportedVersion": minimum,
                })

    def test_release_smoke_leaves_a_competing_emulator_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scripts = {
                "cmdline-tools/13114758/bin/avdmanager": "#!/bin/sh\nexit 0\n",
                "emulator/emulator": "#!/bin/sh\nexec sleep 60\n",
                "platform-tools/adb": '''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if args == ['devices']:
    print('List of devices attached')
elif args == ['devices', '-l']:
    print('List of devices attached\\nemulator-5580\\tdevice transport_id:41')
elif args == ['-t', '41', 'shell', 'getprop ro.boot.qemu.avd_name && getprop sys.boot_completed']:
    print('other-avd\\n1')
elif args == ['-s', 'emulator-5580', 'shell', 'getprop', 'sys.boot_completed']:
    print('1')
else:
    with (Path(os.environ['ANDROID_HOME']) / 'unexpected-adb').open('a') as log:
        print(' '.join(args), file=log)
    sys.exit(2)
''',
            }
            for filename, script in scripts.items():
                path = root / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(script)
                path.chmod(0o755)

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "release-smoke.py"), str(root / "test.apk"), str(root), "0.36.0"],
                env=dict(os.environ, ANDROID_HOME=str(root)), capture_output=True, text=True, timeout=15,
            )
            unexpected = root / "unexpected-adb"
            self.assertFalse(unexpected.exists(), unexpected.read_text() if unexpected.exists() else "")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("belongs to a different AVD", result.stderr)

    def test_release_smoke_stops_before_install_if_ipv6_isolation_fails(self):
        smoke = runpy.run_path(str(SCRIPTS / "release-smoke.py"))
        run = smoke["run"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            avd = root / "owned-avd"
            firewalls = []

            def command(argv, **_options):
                if argv[0].name == "avdmanager":
                    return subprocess.CompletedProcess(argv, 0, "", "")
                args = tuple(argv[1:])
                responses = {
                    ("devices",): "",
                    ("devices", "-l"): "emulator-5580\tdevice transport_id:41",
                    ("-t", "41", "shell", "getprop ro.boot.qemu.avd_name && getprop sys.boot_completed"): "owned-avd\n1",
                }
                if args in responses:
                    return subprocess.CompletedProcess(argv, 0, responses[args], "")
                self.assertEqual(args[:2], ("-t", "41"))
                if args[2:5] == ("shell", "su", "0"):
                    tool = args[5]
                    self.assertEqual(args[6:], ("-w", "5", "-I", "OUTPUT", "!", "-o", "lo", "-j", "REJECT"))
                    firewalls.append(tool)
                    if tool == "ip6tables":
                        return subprocess.CompletedProcess(argv, 1, "", "fixture IPv6 failure")
                    return subprocess.CompletedProcess(argv, 0, "", "")
                if args[2] == "logcat":
                    return subprocess.CompletedProcess(argv, 0, "", "")
                self.fail(f"Unexpected ADB command: {args}")

            with mock.patch.dict(os.environ, ANDROID_HOME=str(root)), \
                 mock.patch.object(subprocess, "run", side_effect=command), \
                 mock.patch.object(subprocess, "Popen") as emulator:
                emulator.return_value.poll.return_value = None
                with self.assertRaisesRegex(RuntimeError, "fixture IPv6 failure"):
                    run(root / "test.apk", root, avd, "0.36.0")
                emulator.return_value.terminate.assert_called_once()
            self.assertEqual(firewalls, ["iptables", "ip6tables"])
            self.assertFalse((root / "cold-start").exists())

    def test_native_gate_rejects_incomplete_failed_and_skipped_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "test-result-exit-code.txt").write_text("0")
            command = [sys.executable, str(SCRIPTS / "check-native-results.py"), str(root), "2"]
            cases = '<testcase classname="Native" name="one"/><testcase classname="Native" name="two"/>'
            report = root / "TEST-pixel2Api35.xml"
            report.write_text(f'<testsuites tests="2">{cases}</testsuites>')
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for content in (f'<testsuites>{cases.replace("two", "one")}</testsuites>',
                            '<testsuites><testcase classname="Native" name="one"/></testsuites>',
                            f'<testsuites skipped="1">{cases}</testsuites>',
                            f'<testsuites>{cases}<failure>crashed</failure></testsuites>',
                            f'<!DOCTYPE testsuites [<!ENTITY x "expanded">]><testsuites>{cases}</testsuites>',
                            f'<!DOCTYPE testsuites SYSTEM "file:///etc/passwd"><testsuites>{cases}</testsuites>'):
                report.write_text(content)
                self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_pairing_accepts_signatures_but_rejects_changed_payload_or_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            unsigned, signed, mapping, compressed, receipt = (
                root / name for name in ("unsigned.apk", "signed.apk", "mapping.txt", "map.gz", "identity.json")
            )
            with zipfile.ZipFile(unsigned, "w") as apk:
                apk.writestr("classes.dex", b"actual-dex")
                apk.writestr("META-INF/library.kotlin_module", b"runtime-metadata")
            signed.write_bytes(unsigned.read_bytes())
            with zipfile.ZipFile(signed, "a") as apk:
                apk.writestr("META-INF/TEST.RSA", b"signature")
            mapping.write_bytes(b"mapping")
            compressed.write_bytes(gzip.compress(mapping.read_bytes()))
            command = [sys.executable, str(SCRIPTS / "verify-release-pair.py"),
                       *map(str, (unsigned, compressed, signed, mapping, receipt))]
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("classes.dex", json.loads(receipt.read_text())["payload"])
            mapping.write_bytes(b"different-build-map")
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            mapping.write_bytes(b"mapping")
            with zipfile.ZipFile(signed, "a") as apk:
                apk.writestr("res/layout.xml", b"different-resource")
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_runner_preserves_failure_logs_on_exit_timeout_and_cancellation(self):
        for outcome in ("failure", "timeout", "cancel"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                tools = root / "platform-tools"
                tools.mkdir()
                adb = tools / "adb"
                adb.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import sys
import time
root = Path(os.environ['ANDROID_HOME'])
if sys.argv[1] == 'devices':
    print('List of devices attached\\nemulator-5554\\tdevice\\nphysical-phone\\tdevice')
else:
    assert sys.argv[1:3] == ['-s', 'emulator-5554']
    def stop(*_):
        (root / 'reader-stopped').touch()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    print('FATAL EXCEPTION: fixture obfuscated stack', flush=True)
    (root / 'reader-ready').touch()
    while True:
        time.sleep(0.1)
''')
                adb.chmod(0o755)
                command = root / "command.py"
                command.write_text('''import os
from pathlib import Path
import sys
import time
root = Path(os.environ['ANDROID_HOME'])
while not (root / 'reader-ready').exists():
    time.sleep(0.01)
if sys.argv[1] == 'failure':
    sys.exit(7)
while True:
    time.sleep(0.1)
''')
                runner = subprocess.Popen(
                    [sys.executable, str(SCRIPTS / "run-native-tests.py"),
                     "--timeout-seconds", "2" if outcome == "timeout" else "30",
                     str(root / "logs"), "--", sys.executable, str(command), outcome],
                    env=dict(os.environ, ANDROID_HOME=str(root)),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                try:
                    if outcome == "cancel":
                        deadline = time.monotonic() + 10
                        while not (root / "reader-ready").exists():
                            if time.monotonic() > deadline:
                                self.fail("logcat reader never started")
                            time.sleep(0.01)
                        runner.send_signal(signal.SIGTERM)
                    stdout, stderr = runner.communicate(timeout=15)
                    self.assertEqual(runner.returncode, {"failure": 7, "timeout": 124, "cancel": 143}[outcome],
                                     (stdout, stderr))
                    self.assertIn("FATAL EXCEPTION", (root / "logs/emulator-5554.log").read_text())
                    self.assertTrue((root / "reader-stopped").exists())
                finally:
                    if runner.poll() is None:
                        runner.terminate()
                        try:
                            runner.communicate(timeout=15)
                        except subprocess.TimeoutExpired:
                            runner.kill()
                            runner.wait()


if __name__ == "__main__":
    unittest.main()
