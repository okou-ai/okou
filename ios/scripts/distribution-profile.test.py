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
        profile = {
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
        if bundle == "ai.okou.ios":
            profile["Entitlements"]["com.apple.developer.applesignin"] = ["Default"]
            profile["Entitlements"]["com.apple.developer.associated-domains"] = [
                "applinks:app.okou.ai",
                "webcredentials:app.okou.ai",
            ]
        return profile

    def invoke(self, profile, bundle="ai.okou.ios", callback_host="app.okou.ai"):
        source = self.work / "profile.plist"
        output = self.work / (str(uuid.uuid4()) + ".plist")
        encoded = plistlib.dumps(profile)
        source.write_bytes(encoded)
        command = [
            "python3",
            str(SCRIPT),
            str(source),
            str(output),
            "--bundle-id",
            bundle,
        ]
        if callback_host is not None:
            command += ["--connector-callback-host", callback_host]
        result = subprocess.run(
            command,
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
                self.assertEqual(
                    entitlements.get("com.apple.developer.applesignin"), ["Default"]
                )
                self.assertEqual(
                    entitlements["com.apple.developer.associated-domains"],
                    ["applinks:app.okou.ai", "webcredentials:app.okou.ai"],
                )

    def test_rejects_an_app_profile_without_the_requested_associated_domains(self):
        profile = self.profile()
        del profile["Entitlements"]["com.apple.developer.associated-domains"]
        result, output = self.invoke(profile)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "does not authorize requested com.apple.developer.associated-domains",
            result.stderr,
        )
        self.assertFalse(output.exists())

    def test_resolves_the_archived_host_with_an_apple_wildcard_profile(self):
        profile = self.profile()
        profile["Entitlements"]["com.apple.developer.associated-domains"] = ["*"]
        result, output = self.invoke(profile, callback_host="staging-app.omby.ai")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            plistlib.loads(output.read_bytes())[
                "com.apple.developer.associated-domains"
            ],
            ["applinks:staging-app.omby.ai", "webcredentials:staging-app.omby.ai"],
        )

    def test_rejects_a_missing_or_malformed_archived_callback_host(self):
        for host in (None, "https://app.okou.ai", "$(UNRESOLVED)"):
            result, output = self.invoke(self.profile(), callback_host=host)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "valid archived connector callback host is required", result.stderr
            )
            self.assertFalse(output.exists())

    def test_rejects_main_app_profile_without_sign_in_with_apple(self):
        profile = self.profile()
        del profile["Entitlements"]["com.apple.developer.applesignin"]
        result, output = self.invoke(profile)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_prepares_the_widget_signature_with_only_the_shared_app_group(self):
        profile = self.profile("ai.okou.ios.widgets")
        del profile["Entitlements"]["aps-environment"]
        del profile["Entitlements"]["keychain-access-groups"]
        result, output = self.invoke(profile, "ai.okou.ios.widgets")
        self.assertEqual(result.returncode, 0, result.stderr)
        entitlements = plistlib.loads(output.read_bytes())
        self.assertEqual(
            entitlements["application-identifier"], f"{TEAM}.ai.okou.ios.widgets"
        )
        self.assertEqual(
            entitlements["com.apple.security.application-groups"], ["group.ai.okou.ios"]
        )
        self.assertNotIn("aps-environment", entitlements)
        self.assertNotIn("keychain-access-groups", entitlements)
        profile["Entitlements"]["com.apple.security.application-groups"] = []
        result, output = self.invoke(profile, "ai.okou.ios.widgets")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

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
