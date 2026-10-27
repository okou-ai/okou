#!/usr/bin/env python3
"""Exercise distribution capability checks with independent synthetic Apple profiles."""

import datetime
import plistlib
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPT = Path(__file__).with_name("distribution-profile.py").resolve()
ROOT = SCRIPT.parents[2]
TEAM = "C5UWSXYB67"


class DistributionProfileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)

    def profile(self, bundle="ai.okou.ios"):
        return {
            "UUID": str(uuid.uuid4()),
            "TeamIdentifier": [TEAM],
            "ApplicationIdentifierPrefix": [TEAM],
            "ExpirationDate": datetime.datetime(
                2100, 1, 1, tzinfo=datetime.timezone.utc
            ),
            "Entitlements": {
                "application-identifier": f"{TEAM}.{bundle}",
                "com.apple.developer.team-identifier": TEAM,
                "aps-environment": "production",
                "get-task-allow": False,
                "com.apple.security.application-groups": ["group.ai.okou.ios"],
                "keychain-access-groups": [f"{TEAM}.*"],
            },
        }

    def invoke(self, profile, bundle="ai.okou.ios"):
        source = self.work / "profile.plist"
        output = self.work / (str(uuid.uuid4()) + ".plist")
        encoded = plistlib.dumps(profile)
        source.write_bytes(encoded)
        result = subprocess.run(
            ["python3", str(SCRIPT), str(source), str(output), "--bundle-id", bundle],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(source.read_bytes(), encoded)
        return result, output

    def test_prepares_both_bundle_signatures_with_shared_storage_and_existing_keychain_group(
        self,
    ):
        for bundle in ("ai.okou.ios", "ai.okou.ios.notifications"):
            profile = self.profile(bundle)
            result, output = self.invoke(profile, bundle)
            self.assertEqual(result.returncode, 0, result.stderr)
            entitlements = plistlib.loads(output.read_bytes())
            self.assertEqual(entitlements["application-identifier"], f"{TEAM}.{bundle}")
            self.assertEqual(
                entitlements["keychain-access-groups"], [f"{TEAM}.ai.okou.ios"]
            )
            self.assertEqual(
                entitlements["com.apple.security.application-groups"],
                ["group.ai.okou.ios"],
            )
            if bundle == "ai.okou.ios":
                self.assertEqual(entitlements["aps-environment"], "production")

    def test_rejects_profiles_that_cannot_share_the_cache_or_session(self):
        for capability in (
            "com.apple.security.application-groups",
            "keychain-access-groups",
        ):
            profile = self.profile("ai.okou.ios.notifications")
            profile["Entitlements"][capability] = []
            result, output = self.invoke(profile, "ai.okou.ios.notifications")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_rejects_development_scope_or_the_wrong_bundle(self):
        for mutation in (
            lambda p: p["Entitlements"].update({"aps-environment": "development"}),
            lambda p: p.update({"ProvisionedDevices": ["test-device"]}),
            lambda p: p["Entitlements"].update(
                {"application-identifier": TEAM + ".other"}
            ),
        ):
            profile = self.profile()
            mutation(profile)
            result, output = self.invoke(profile)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
