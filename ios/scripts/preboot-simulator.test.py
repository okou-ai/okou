#!/usr/bin/env python3
"""Exercise CI preboot selection at the external simctl boundary."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("preboot-simulator.py")
RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-2"
OTHER_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-3"
XCRUN = """#!/usr/bin/env python3
import json, os, pathlib, signal, sys
path = pathlib.Path(os.environ['SIMULATOR_FIXTURE'])
inventory = json.loads(path.read_text())
if sys.argv[1:] == ['simctl', 'list', 'devices', 'available', '--json']:
    print(json.dumps(inventory))
elif sys.argv[1:] == ['simctl', 'list', '--json']:
    if os.environ.get('SIMULATOR_DIAGNOSTICS_FAILURE'):
        sys.exit('Full inventory unavailable')
    if os.environ.get('SIMULATOR_DIAGNOSTICS_HANG'):
        signal.pause()
    print(path.with_suffix('.full.json').read_text())
elif sys.argv[1:3] == ['simctl', 'boot']:
    if os.environ.get('SIMULATOR_BOOT_FAILURE'):
        sys.exit('Simulator boot failed')
    device, = [device for devices in inventory['devices'].values()
        for device in devices if device['udid'] == sys.argv[3]]
    if device['state'] != 'Shutdown':
        sys.exit('Device is already booted')
    device['state'] = 'Booted'
    path.write_text(json.dumps(inventory))
elif sys.argv[1:3] == ['simctl', 'bootstatus']:
    if os.environ.get('SIMULATOR_READY_FAILURE'):
        sys.exit('Simulator readiness failed')
    path.with_suffix('.ready').write_text(sys.argv[3])
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
        self.full_inventory = {
            "runtimes": [{"identifier": RUNTIME, "version": "26.2", "isAvailable": True}],
            "devices": {RUNTIME: [{"name": "Unavailable model", "isAvailable": False}]},
        }
        self.state.with_suffix(".full.json").write_text(json.dumps(self.full_inventory))
        xcrun = self.root / "xcrun"
        xcrun.write_text(XCRUN)
        xcrun.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.root}:{os.environ['PATH']}",
            "SIMULATOR_FIXTURE": str(self.state),
            "IOS_TEST_DESTINATION": "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2",
            "DEVELOPER_DIR": "/Applications/SelectedXcode.app/Contents/Developer",
            "GITHUB_SHA": "tested-merge",
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "2",
            "ImageVersion": "fixture-image",
            "UNRELATED_SECRET": "must-not-be-reported",
        }

    def invoke(self):
        return subprocess.run(
            ["python3", str(SCRIPT)],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )

    def assert_selection_failure(self, result, count):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Expected one available simulator", result.stderr)
        prefix = "Simulator selection failure:\n"
        report, _ = json.JSONDecoder().raw_decode(result.stderr.split(prefix, 1)[1])
        self.assertEqual(report["destination"], self.env["IOS_TEST_DESTINATION"])
        self.assertEqual(report["runtimeIdentifier"], RUNTIME)
        self.assertEqual(report["matchCount"], count)
        self.assertEqual(report["availableDeviceInventory"], self.inventory)
        self.assertEqual(report["environment"]["GITHUB_SHA"], "tested-merge")
        self.assertEqual(report["environment"]["GITHUB_RUN_ID"], "123")
        self.assertEqual(report["environment"]["GITHUB_RUN_ATTEMPT"], "2")
        self.assertEqual(report["environment"]["DEVELOPER_DIR"], self.env["DEVELOPER_DIR"])
        self.assertEqual(report["environment"]["ImageVersion"], "fixture-image")
        self.assertNotIn("must-not-be-reported", result.stderr)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)
        self.assertFalse(self.state.with_suffix(".ready").exists())

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

    def test_readiness_failure_blocks_ci_after_boot_was_requested(self):
        self.env["SIMULATOR_READY_FAILURE"] = "true"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Simulator readiness failed", result.stderr)

    def test_missing_runtime_does_not_start_the_same_model_on_another_os(self):
        del self.inventory["devices"][RUNTIME]
        self.state.write_text(json.dumps(self.inventory))
        result = self.invoke()
        self.assert_selection_failure(result, 0)
        # The later full snapshot is supplemental, even if the runtime appears there.
        self.assertIn(json.dumps(self.full_inventory), result.stderr)

    def test_missing_model_reports_the_actual_available_devices(self):
        self.inventory["devices"][RUNTIME][0]["name"] = "iPad mini"
        self.state.write_text(json.dumps(self.inventory))
        self.assert_selection_failure(self.invoke(), 0)

    def test_ambiguous_model_reports_both_devices_without_booting_either(self):
        self.inventory["devices"][RUNTIME].append(
            {"name": "iPhone 17 Pro", "udid": "duplicate", "state": "Shutdown"}
        )
        self.state.write_text(json.dumps(self.inventory))
        self.assert_selection_failure(self.invoke(), 2)

    def test_supplemental_inventory_failure_preserves_selection_evidence(self):
        del self.inventory["devices"][RUNTIME]
        self.state.write_text(json.dumps(self.inventory))
        self.env["SIMULATOR_DIAGNOSTICS_FAILURE"] = "true"
        result = self.invoke()
        self.assert_selection_failure(result, 0)
        self.assertIn("Full inventory unavailable", result.stderr)
        self.assertIn("Supplemental simctl inventory exit status: 1", result.stderr)

    def test_supplemental_inventory_timeout_preserves_selection_evidence(self):
        del self.inventory["devices"][RUNTIME]
        self.state.write_text(json.dumps(self.inventory))
        self.env["SIMULATOR_DIAGNOSTICS_HANG"] = "true"
        result = self.invoke()
        self.assert_selection_failure(result, 0)
        self.assertIn("Supplemental simctl inventory timed out", result.stderr)

    def test_boot_failure_blocks_ci_without_changing_devices(self):
        self.env["SIMULATOR_BOOT_FAILURE"] = "true"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Simulator boot failed", result.stderr)
        self.assertEqual(json.loads(self.state.read_text()), self.inventory)


if __name__ == "__main__":
    unittest.main()
