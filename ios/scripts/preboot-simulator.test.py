#!/usr/bin/env python3
"""Exercise CI preboot selection at the external simctl boundary."""

import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

SCRIPT = Path(__file__).with_name("preboot-simulator.py")
RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-2"
OTHER_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-3"
XCRUN = """#!/usr/bin/env python3
import json, os, pathlib, plistlib, sys
path = pathlib.Path(os.environ['SIMULATOR_FIXTURE'])
inventory = json.loads(path.read_text())
if sys.argv[1:] == ['simctl', 'list', 'devices', 'available', '--json']:
    print(json.dumps(inventory))
elif sys.argv[1:] == ['simctl', 'list', 'runtimes', '--json']:
    print(json.dumps({'runtimes': [{'identifier': 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
        'bundlePath': os.environ['SIMULATOR_RUNTIME_BUNDLE']}]}))
elif sys.argv[1:3] == ['simctl', 'boot']:
    if os.environ.get('SIMULATOR_BOOT_FAILURE'):
        sys.exit('Simulator boot failed')
    device, = [device for devices in inventory['devices'].values()
        for device in devices if device['udid'] == sys.argv[3]]
    if device['state'] != 'Shutdown':
        sys.exit('Device is already booted')
    if os.environ.get('IOS_SIMULATOR_PROFILE') == 'lean':
        database = pathlib.Path('/var/tmp') / ('com.apple.CoreSimulator.SimDevice.' + sys.argv[3]) / 'disabled.plist'
        flags = plistlib.loads(database.read_bytes())
        if not all(flags.get(label) is True for label in ('com.apple.PosterBoard', 'com.apple.chronod')):
            sys.exit('Lean profile was not applied before boot')
    device['state'] = 'Booted'
    path.write_text(json.dumps(inventory))
elif sys.argv[1:3] == ['simctl', 'bootstatus']:
    if os.environ.get('SIMULATOR_READY_FAILURE'):
        sys.exit('Simulator readiness failed')
    path.with_suffix('.ready').write_text(sys.argv[3])
elif sys.argv[1:3] == ['simctl', 'spawn']:
    database = pathlib.Path('/var/tmp') / ('com.apple.CoreSimulator.SimDevice.' + sys.argv[3]) / 'disabled.plist'
    flags = plistlib.loads(database.read_bytes())
    if sys.argv[5:] == ['print-disabled', 'system']:
        for label, value in flags.items():
            if os.environ.get('SIMULATOR_IGNORE_PROFILE'):
                value = False
            print('"' + label + '" => ' + str(value).lower())
    elif sys.argv[5] == 'print':
        if os.environ.get('SIMULATOR_SERVICE_LOADED'):
            print('service is loaded')
        else:
            print('Could not find service "' + sys.argv[6].split('/')[1] + '" in domain for system', file=sys.stderr)
            sys.exit(113)
    else:
        raise ValueError(sys.argv)
else:
    raise ValueError(sys.argv)
"""


class PrebootSimulatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inventory = {
            "devices": {
                RUNTIME: [
                    {"name": "iPhone 17 Pro", "udid": "configured", "state": "Shutdown"}
                ],
                OTHER_RUNTIME: [
                    {"name": "iPhone 17 Pro", "udid": "other", "state": "Shutdown"}
                ],
            }
        }
        self.state = self.root / "devices.json"
        self.state.write_text(json.dumps(self.inventory))
        xcrun = self.root / "xcrun"
        xcrun.write_text(XCRUN)
        xcrun.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.root}:{os.environ['PATH']}",
            "SIMULATOR_FIXTURE": str(self.state),
            "IOS_TEST_DESTINATION": "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2",
            "IOS_SIMULATOR_PROFILE": "standard",
        }

    def invoke(self, *args):
        return subprocess.run(
            ["python3", str(SCRIPT), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_starts_only_the_configured_runtime_and_awaits_readiness(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        devices = json.loads(self.state.read_text())["devices"]
        self.assertEqual(devices[RUNTIME][0]["state"], "Booted")
        self.assertEqual(devices[OTHER_RUNTIME][0]["state"], "Shutdown")
        self.assertEqual(self.state.with_suffix(".ready").read_text(), "configured")

    def test_already_booted_target_is_retained_without_rebooting(self):
        self.inventory["devices"][RUNTIME][0]["state"] = "Booted"
        self.state.write_text(json.dumps(self.inventory))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)
        self.assertEqual(self.state.with_suffix(".ready").read_text(), "configured")

    def lean_fixture(self):
        udid = str(uuid4()).upper()
        self.inventory["devices"] = {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                {"name": "iPhone 18 Pro", "udid": udid, "state": "Shutdown"}
            ]
        }
        self.state.write_text(json.dumps(self.inventory))
        runtime = self.root / "iOS.simruntime"
        daemons = (
            runtime / "Contents/Resources/RuntimeRoot/System/Library/LaunchDaemons"
        )
        daemons.mkdir(parents=True, exist_ok=True)
        for label in ("com.apple.PosterBoard", "com.apple.chronod"):
            (daemons / f"{label}.plist").write_bytes(plistlib.dumps({"Label": label}))
        directory = Path("/var/tmp") / f"com.apple.CoreSimulator.SimDevice.{udid}"
        self.addCleanup(shutil.rmtree, directory, True)
        self.env.update(
            {
                "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_TEMP": str(self.root / "work"),
                "IOS_SIMULATOR_PROFILE": "lean",
                "SIMULATOR_RUNTIME_BUNDLE": str(runtime),
                "IOS_TEST_DESTINATION": "platform=iOS Simulator,name=iPhone 18 Pro,OS=27.0",
            }
        )
        return directory / "disabled.plist"

    def test_lean_profile_precedes_boot_and_restores_only_its_own_settings(self):
        database = self.lean_fixture()
        database.parent.mkdir(mode=0o700)
        original = {"com.apple.unrelated": False, "com.apple.chronod": False}
        database.write_bytes(plistlib.dumps(original))
        database.chmod(0o640)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        flags = plistlib.loads(database.read_bytes())
        self.assertTrue(flags["com.apple.PosterBoard"])
        self.assertTrue(flags["com.apple.chronod"])
        self.assertFalse(flags["com.apple.unrelated"])
        flags["com.apple.added-by-runtime"] = True
        database.write_bytes(plistlib.dumps(flags))
        result = self.invoke("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            plistlib.loads(database.read_bytes()),
            original | {"com.apple.added-by-runtime": True},
        )
        self.assertEqual(database.stat().st_mode & 0o777, 0o640)

    def test_ineffective_or_still_loaded_profile_blocks_ci(self):
        for failure in ("SIMULATOR_IGNORE_PROFILE", "SIMULATOR_SERVICE_LOADED"):
            with self.subTest(failure=failure):
                database = self.lean_fixture()
                self.env[failure] = "true"
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.invoke("restore").returncode, 0)
                self.assertFalse(database.exists())
                del self.env[failure]

    def test_unknown_profile_is_rejected_before_starting_a_device(self):
        self.env["IOS_SIMULATOR_PROFILE"] = "unsupported"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)

    def test_readiness_failure_blocks_ci_after_boot_was_requested(self):
        self.env["SIMULATOR_READY_FAILURE"] = "true"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Simulator readiness failed", result.stderr)

    def test_missing_runtime_does_not_start_the_same_model_on_another_os(self):
        del self.inventory["devices"][RUNTIME]
        self.state.write_text(json.dumps(self.inventory))
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("one available simulator", result.stderr)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)

    def test_boot_failure_blocks_ci_without_changing_devices(self):
        self.env["SIMULATOR_BOOT_FAILURE"] = "true"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Simulator boot failed", result.stderr)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)


if __name__ == "__main__":
    unittest.main()
