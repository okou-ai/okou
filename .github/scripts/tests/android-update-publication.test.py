"""Exercise publish-last readiness and concurrent/uncertain publication outcomes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).parents[1] / "release/publish-android-update.py"
spec = importlib.util.spec_from_file_location("android_update", path)
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


class Store:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.failed_key = None
        self.race = None

    def get(self, key):
        value = self.objects.get(key)
        return (value, hashlib.sha256(value).hexdigest()) if value is not None else None

    def put(self, key, file, etag=None, content_type=None):
        self.writes.append(key)
        if key == self.failed_key:
            return  # Neither a successful command nor a retry is assumed.
        if key == publication.CURRENT and self.race:
            self.objects[key] = self.race
        current = self.get(key)
        if (current and current[1] != etag) or (not current and etag):
            return
        self.objects[key] = file.read_bytes()


class PublicationTest(unittest.TestCase):
    def test_version_order_matches_server_and_native_policy(self):
        vectors = json.loads((path.parents[3] / "turbo/packages/api-contracts/src/validators/fixtures/android-versions.json").read_text())
        for item in vectors["comparisons"]:
            with self.subTest(item=item):
                left = publication.version_parts(item["left"])
                right = publication.version_parts(item["right"])
                self.assertEqual((left > right) - (left < right), item["order"])
        for version in vectors["invalid"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                publication.version_parts(version)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.apk = self.directory / "app.apk"
        self.apk.write_bytes(b"verified signed APK fixture")
        self.store = Store()

    def manifest(self, version="0.13.0"):
        digest = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        return {"schemaVersion": 1, "release": {
            "version": version,
            "sha256": digest, "size": self.apk.stat().st_size, "minimumSdk": 24, "notes": "Update",
            "url": f"https://static.okou.io/android-updates/releases/{version}/{digest}.apk",
        }}

    def publish(self, manifest=None):
        return publication.publish(manifest or self.manifest(), self.apk, self.store, self.directory)

    def test_first_publication_and_idempotence_preserve_exact_bytes(self):
        manifest = self.manifest()
        self.assertEqual(self.publish(manifest), "published")
        self.assertEqual(json.loads(self.store.objects[publication.CURRENT]), manifest)
        self.assertEqual(self.store.writes[-1], publication.CURRENT)
        self.assertEqual(self.store.objects[publication.validate(manifest)], self.apk.read_bytes())
        writes = list(self.store.writes)
        self.assertEqual(self.publish(manifest), "already published")
        self.assertEqual(writes, self.store.writes)

    def test_failed_apk_write_cannot_advance_manifest(self):
        self.store.failed_key = publication.validate(self.manifest())
        with self.assertRaisesRegex(RuntimeError, "APK publication"):
            self.publish()
        self.assertNotIn(publication.CURRENT, self.store.objects)
        self.assertEqual(len(self.store.writes), 1)

    def test_lower_version_and_same_version_different_identity_cannot_overwrite(self):
        self.assertEqual(self.publish(), "published")
        saved = self.store.objects[publication.CURRENT]
        self.assertEqual(self.publish(self.manifest("0.12.0")), "superseded")
        self.apk.write_bytes(b"different signed APK")
        with self.assertRaisesRegex(RuntimeError, "same Android version"):
            self.publish()
        self.assertEqual(self.store.objects[publication.CURRENT], saved)

    def test_numeric_components_preserve_release_order_across_digit_boundaries(self):
        self.assertEqual(self.publish(self.manifest("0.9.0")), "published")
        self.assertEqual(self.publish(self.manifest("0.10.0")), "published")
        self.assertEqual(self.publish(self.manifest("0.1.1000")), "superseded")
        self.assertEqual(self.publish(self.manifest("0.1000.0")), "published")

    def test_racing_newer_release_is_not_rolled_back(self):
        self.store.race = json.dumps(self.manifest("0.14.0")).encode()
        self.assertEqual(self.publish(), "superseded")
        self.assertEqual(self.store.objects[publication.CURRENT], self.store.race)

    def test_uncertain_failed_manifest_write_requires_exact_readback(self):
        self.store.failed_key = publication.CURRENT
        with self.assertRaisesRegex(RuntimeError, "Conditional"):
            self.publish()
        self.assertEqual(self.store.writes.count(publication.CURRENT), 1)

    def test_metadata_rejects_mismatched_version_url_and_unexpected_types(self):
        for key, value in [("version", "0.13-beta"), ("url", "https://example.com/app.apk"),
                           ("minimumSdk", True), ("sha256", "unknown"), ("size", -1)]:
            manifest = self.manifest()
            manifest["release"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                publication.validate(manifest)


if __name__ == "__main__":
    unittest.main()
