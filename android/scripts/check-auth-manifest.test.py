"""Regression coverage for the merged-manifest authentication boundary."""

import copy
from pathlib import Path
import runpy
import tempfile
import unittest
import xml.etree.ElementTree as ET

policy = runpy.run_path(str(Path(__file__).with_name("check-auth-manifest.py")))
A = policy["A"]


def fixture(package):
    root = ET.Element("manifest", {"package": package})
    app = ET.SubElement(root, "application", {A + "allowBackup": "false"})
    ET.SubElement(app, "provider", {A + "name": policy["SHARED"], A + "exported": "false",
                                  A + "enabled": "false", A + "grantUriPermissions": "false",
                                  A + "authorities": package + ".clerk.shared-session-sync"})
    launcher = ET.SubElement(app, "activity", {A + "name": "ai.okou.android.MainActivity", A + "exported": "true"})
    route = ET.SubElement(launcher, "intent-filter")
    ET.SubElement(route, "action", {A + "name": "android.intent.action.MAIN"})
    ET.SubElement(route, "category", {A + "name": "android.intent.category.LAUNCHER"})
    receiver = ET.SubElement(app, "activity", {A + "name": policy["SSO"], A + "exported": "true"})
    for suffix in ["callback", "oauth"]:
        route = ET.SubElement(receiver, "intent-filter")
        ET.SubElement(route, "action", {A + "name": "android.intent.action.VIEW"})
        for category in ["DEFAULT", "BROWSABLE"]:
            ET.SubElement(route, "category", {A + "name": "android.intent.category." + category})
        ET.SubElement(route, "data", {A + "scheme": "clerk", A + "host": package + "." + suffix})
    ET.SubElement(app, "receiver", {A + "name": policy["PROFILE"], A + "exported": "true", A + "permission": "android.permission.DUMP"})
    ET.SubElement(app, "service", {A + "name": policy["REVOCATION"], A + "exported": "true", A + "permission": "com.google.android.gms.auth.api.signin.permission.REVOCATION_NOTIFICATION"})
    if package.endswith(".debug"):
        ET.SubElement(app, "activity", {A + "name": "androidx.activity.ComponentActivity", A + "exported": "true"})
    return root


class AuthenticationManifestTest(unittest.TestCase):
    def audit(self, root, package):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AndroidManifest.xml"
            ET.ElementTree(root).write(path)
            policy["audit"](path, package)

    def test_exact_release_and_debug_routes(self):
        for package in ["ai.okou.android", "ai.okou.android.debug"]:
            self.audit(fixture(package), package)

    def test_extra_entries_wrong_routes_permissions_and_backup_fail_closed(self):
        base = fixture("ai.okou.android")
        mutations = []
        changed = copy.deepcopy(base)
        ET.SubElement(changed.find("application"), "activity", {A + "name": "Unknown", A + "exported": "true"})
        mutations.append(changed)
        changed = copy.deepcopy(base)
        changed.find("application/provider").set(A + "enabled", "true")
        mutations.append(changed)
        for field, value in [("scheme", "https"), ("host", "other-app.oauth"), ("pathPrefix", "/")]:
            changed = copy.deepcopy(base)
            changed.find(".//data").set(A + field, value)
            mutations.append(changed)
        changed = copy.deepcopy(base)
        changed.find("application/receiver").attrib.pop(A + "permission")
        mutations.append(changed)
        changed = copy.deepcopy(base)
        changed.find("application").set(A + "allowBackup", "true")
        mutations.append(changed)
        changed = copy.deepcopy(base)
        ET.SubElement(changed.find("application"), "activity", {A + "name": "androidx.activity.ComponentActivity", A + "exported": "true"})
        mutations.append(changed)
        for changed in mutations:
            with self.subTest(manifest=ET.tostring(changed)):
                with self.assertRaises(ValueError):
                    self.audit(changed, "ai.okou.android")


if __name__ == "__main__":
    unittest.main()
