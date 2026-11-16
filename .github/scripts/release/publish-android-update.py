"""Publish verified APK bytes before a monotonic Android update manifest.

Usage: publish-android-update.py VERSION APK
Requires JDK/Android SDK, gh, AWS CLI and the production static R2 environment.
No credential values are printed. Writes are conditional and never blindly retried.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

BASE = "https://static.okou.io/"
CURRENT = "android-updates/manifest.json"


def version_parts(version):
    if not isinstance(version, str) or len(version) > 64 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid Android release version")
    return tuple(map(int, version.split(".")))


def validate(manifest):
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported Android update manifest")
    release = manifest["release"]
    version_parts(release["version"])
    digest = release["sha256"]
    key = f'android-updates/releases/{release["version"]}/{digest}.apk'
    if (not re.fullmatch(r"[a-f0-9]{64}", digest)
            or release["url"] != BASE + key
            or type(release["size"]) is not int or not 0 < release["size"] <= 2147483647
            or type(release["minimumSdk"]) is not int or not 24 <= release["minimumSdk"] <= 10000
            or not isinstance(release["notes"], str) or len(release["notes"]) > 8000):
        raise ValueError("Inconsistent Android release metadata")
    return key


class R2:
    def __init__(self, directory):
        self.directory = directory
        self.arguments = ["--bucket", os.environ["R2_BUCKET_NAME"],
                          "--endpoint-url", f'https://{os.environ["R2_ACCOUNT_ID"]}.r2.cloudflarestorage.com',
                          "--cli-connect-timeout", "5", "--cli-read-timeout", "20", "--output", "json", "--no-cli-pager"]

    def run(self, arguments):
        env = dict(os.environ, AWS_MAX_ATTEMPTS="1", AWS_RETRY_MODE="standard",
                   AWS_CLI_ERROR_FORMAT="json", AWS_PAGER="", AWS_CLI_AUTO_PROMPT="off",
                   AWS_REQUEST_CHECKSUM_CALCULATION="WHEN_REQUIRED")
        return subprocess.run(["aws", "s3api", *arguments, *self.arguments], env=env,
                              capture_output=True, timeout=35)

    def get(self, key):
        path = self.directory / "readback"
        result = self.run(["get-object", "--key", key, str(path)])
        if result.returncode:
            try:
                error = json.loads(result.stderr)
                code = error.get("Error", {}).get("Code") or error.get("Code")
            except (ValueError, AttributeError):
                code = None
            if code in {"NoSuchKey", "NotFound", "404"}:
                return None
            raise RuntimeError("Cannot read Android update publication from R2")
        return path.read_bytes(), json.loads(result.stdout)["ETag"]

    def put(self, key, path, etag=None, content_type="application/json"):
        condition = ["--if-match", etag] if etag else ["--if-none-match", "*"]
        # The following readback decides success, including an uncertain write result.
        try:
            self.run(["put-object", "--key", key, "--body", str(path),
                      "--content-type", content_type, "--cache-control",
                      "no-store" if key == CURRENT else "public, max-age=31536000, immutable", *condition])
        except subprocess.TimeoutExpired:
            # A timed-out conditional write may have committed; publish() reads it
            # back before accepting success and never retries the uncertain write.
            pass


def publish(manifest, apk, store, directory):
    key = validate(manifest)
    candidate = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    previous = store.get(CURRENT)
    if previous:
        current = json.loads(previous[0])
        validate(current)
        if version_parts(current["release"]["version"]) > version_parts(manifest["release"]["version"]):
            return "superseded"
        if version_parts(current["release"]["version"]) == version_parts(manifest["release"]["version"]):
            if current != manifest:
                raise RuntimeError("Refusing different bytes or metadata for the same Android version")
            return "already published"
    if apk.stat().st_size != manifest["release"]["size"] or hashlib.sha256(apk.read_bytes()).hexdigest() != manifest["release"]["sha256"]:
        raise RuntimeError("APK bytes changed before publication")
    store.put(key, apk, content_type="application/vnd.android.package-archive")
    uploaded = store.get(key)
    if not uploaded or len(uploaded[0]) != manifest["release"]["size"] or hashlib.sha256(uploaded[0]).hexdigest() != manifest["release"]["sha256"]:
        raise RuntimeError("APK publication could not be verified; manifest is unchanged")
    path = directory / "manifest.json"
    path.write_bytes(candidate)
    store.put(CURRENT, path, previous[1] if previous else None)
    saved = store.get(CURRENT)
    if saved and saved[0] == candidate:
        return "published"
    if saved:
        newer = json.loads(saved[0])
        validate(newer)
        if version_parts(newer["release"]["version"]) > version_parts(manifest["release"]["version"]):
            return "superseded"
    raise RuntimeError("Conditional Android manifest publication could not be verified")


def main(version, apk):
    version_parts(version)
    tools = Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0"
    subprocess.run([str(tools / "apksigner"), "verify", str(apk)], check=True, capture_output=True)
    badging = subprocess.check_output([str(tools / "aapt2"), "dump", "badging", str(apk)], text=True)
    root = Path(__file__).resolve().parents[3]
    code = subprocess.check_output(["bash", str(root / "android/scripts/version-code.sh")], text=True).strip()
    expected = f"package: name='ai.okou.android' versionCode='{code}' versionName='{version}' "
    if not badging.startswith(expected):
        raise ValueError("APK identity does not match its release")
    sdk = re.search(r"^minSdkVersion:'(\d+)'$", badging, re.MULTILINE)
    if not sdk:
        raise ValueError("APK has no minimum SDK")
    notes = subprocess.check_output(["gh", "release", "view", f"android-v{version}", "--repo", os.environ["GITHUB_REPOSITORY"],
                                     "--json", "body", "--jq", ".body"], text=True).strip()[:8000]
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    manifest = {"schemaVersion": 1, "release": {
        "version": version, "minimumSdk": int(sdk[1]),
        "size": apk.stat().st_size, "sha256": digest,
        "url": f"{BASE}android-updates/releases/{version}/{digest}.apk", "notes": notes,
    }}
    with tempfile.TemporaryDirectory(prefix="android-update-") as temporary:
        directory = Path(temporary)
        result = publish(manifest, apk, R2(directory), directory)
    print(f"Android update {version}: {result}; sha256={digest}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: publish-android-update.py VERSION APK")
    main(sys.argv[1], Path(sys.argv[2]))
