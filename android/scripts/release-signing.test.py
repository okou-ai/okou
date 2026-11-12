"""Exercise release signing with real SDK tools and isolated test-only keys.

Requires JDK 21 and the SDK from setup-sdk.sh. APK fixtures contain only a
manifest; these tests do not claim device installation or production-key access.
"""

import base64
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SIGN = ROOT / ".github/scripts/artifacts/sign-okou-android-apk.sh"
SDK = Path(os.environ.get("ANDROID_HOME", Path.home() / ".local/share/android-sdk"))
TOOLS = SDK / "build-tools/35.0.0"
PASSWORD = "test-only-release-signing-password"


class ReleaseSigningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key_directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.key_directory.cleanup)
        key = Path(cls.key_directory.name) / "fixture.p12"
        subprocess.run(
            ["keytool", "-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", str(key),
             "-alias", "release-test", "-storepass:env", "FIXTURE_PASSWORD", "-keyalg", "RSA",
             "-keysize", "2048", "-validity", "2", "-dname", "CN=Test Only"],
            env=dict(os.environ, FIXTURE_PASSWORD=PASSWORD), check=True, capture_output=True,
        )
        cls.encoded_key = base64.b64encode(key.read_bytes()).decode()

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.env = dict(os.environ, ANDROID_HOME=str(SDK), RUNNER_TEMP=str(self.work),
                        ANDROID_RELEASE_KEYSTORE_BASE64=self.encoded_key,
                        ANDROID_RELEASE_KEYSTORE_PASSWORD=PASSWORD,
                        ANDROID_RELEASE_KEY_ALIAS="release-test")
        self.unsigned = self.apk("1.2.3")

    def apk(self, version):
        major, minor, patch = map(int, version.split("."))
        code = major * 1_000_000 + minor * 1_000 + patch
        fixture = self.work / version
        fixture.mkdir()
        manifest = fixture / "AndroidManifest.xml"
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="ai.okou.android" android:versionCode="{code}" android:versionName="{version}">
    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="35" />
    <application android:hasCode="false" />
</manifest>''')
        raw = self.work / f"raw-{version}.apk"
        aligned = self.work / f"unsigned-{version}.apk"
        subprocess.run([str(TOOLS / "aapt"), "package", "-f", "-M", str(manifest),
                        "-I", str(SDK / "platforms/android-35/android.jar"), "-F", str(raw)],
                       check=True, capture_output=True)
        subprocess.run([str(TOOLS / "zipalign"), "-P", "16", "4", str(raw), str(aligned)],
                       check=True, capture_output=True)
        return aligned

    def sign(self, version="1.2.3", unsigned=None, **overrides):
        output = self.work / f"signed-{version}.apk"
        result = subprocess.run(["bash", str(SIGN), version, str(unsigned or self.unsigned), str(output)],
                                env=self.env | overrides, text=True, capture_output=True)
        self.assertEqual(list(self.work.glob("android-signing.*")), [])
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        self.assertNotIn(self.encoded_key, result.stdout + result.stderr)
        return result, output

    def test_same_key_signs_increasing_versions_and_preserves_existing_output(self):
        certificates = []
        for version in ["1.2.3", "1.2.4"]:
            unsigned = self.unsigned if version == "1.2.3" else self.apk(version)
            result, output = self.sign(version, unsigned)
            self.assertEqual(result.returncode, 0, result.stderr)
            verification = subprocess.check_output(
                [str(TOOLS / "apksigner"), "verify", "--print-certs", str(output)], text=True)
            certificates.append(re.search(r"certificate SHA-256 digest: (\w+)", verification)[1])
        self.assertEqual(certificates[0], certificates[1])
        previous = output.read_bytes()
        result, _ = self.sign("1.2.4", unsigned)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_bytes(), previous)

    def test_invalid_signing_inputs_never_produce_a_signed_output(self):
        cases = [
            {"ANDROID_RELEASE_KEYSTORE_BASE64": ""},
            {"ANDROID_RELEASE_KEYSTORE_PASSWORD": ""},
            {"ANDROID_RELEASE_KEY_ALIAS": ""},
            {"ANDROID_RELEASE_KEYSTORE_BASE64": "invalid-base64!"},
            {"ANDROID_RELEASE_KEYSTORE_BASE64": base64.b64encode(b"not a PKCS12").decode()},
            {"ANDROID_RELEASE_KEYSTORE_PASSWORD": "wrong-password"},
            {"ANDROID_RELEASE_KEY_ALIAS": "unknown-alias"},
        ]
        for override in cases:
            with self.subTest(field=next(iter(override))):
                result, output = self.sign(**override)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
        result, output = self.sign("1.2.4")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def wrapped_sdk(self, mode):
        tools = self.work / "sdk/build-tools/35.0.0"
        tools.mkdir(parents=True)
        for tool in ["aapt", "zipalign"]:
            (tools / tool).symlink_to(TOOLS / tool)
        signer = tools / "apksigner"
        signer.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import subprocess
import sys
import zipfile
args = sys.argv[1:]
if args[0] == 'sign' and os.environ['SIGNER_MODE'] == 'cancel':
    os.kill(os.getppid(), signal.SIGTERM)
    sys.exit(143)
subprocess.run([os.environ['REAL_APKSIGNER'], *args], check=True)
if args[0] == 'sign' and os.environ['SIGNER_MODE'] == 'tamper':
    with zipfile.ZipFile(Path(args[args.index('--out') + 1]), 'a') as apk:
        apk.writestr('tampered.txt', b'signature must fail')
''')
        signer.chmod(0o755)
        return dict(ANDROID_HOME=str(self.work / "sdk"), SIGNER_MODE=mode,
                    REAL_APKSIGNER=str(TOOLS / "apksigner"))

    def test_corrupt_signature_is_rejected_and_private_files_are_cleaned(self):
        result, output = self.sign(**self.wrapped_sdk("tamper"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_termination_cleans_private_files(self):
        result, output = self.sign(**self.wrapped_sdk("cancel"))
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
