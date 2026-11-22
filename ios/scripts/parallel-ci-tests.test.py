#!/usr/bin/env python3
"""Verify same-run native product transfer, including reruns and executable bundles."""

import hashlib
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "wait_artifact", SCRIPTS / "wait-ci-test-artifact.py"
)
waiter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waiter)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.output = Path(tmp.name, "output")
        self.env = {
            "GITHUB_RUN_ID": "12",
            "GITHUB_SHA": "abc",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_OUTPUT": str(self.output),
        }
        self.job = {
            "name": "test-packages",
            "run_attempt": 2,
            "head_sha": "abc",
            "run_id": 12,
            "conclusion": None,
        }
        self.jobs = {"total_count": 1, "jobs": [self.job]}

    def test_keeps_token_on_api_origin_and_rejects_insecure_redirect(self):
        req = waiter.Request(
            "https://api.github.com/example", headers={"Accept": "application/json"}
        )
        req.add_unredirected_header("Authorization", "Bearer test-placeholder")
        redirect = waiter.HTTPSRedirect()
        nxt = redirect.redirect_request(
            req, None, 302, "", {}, "https://blob.example/artifact"
        )
        self.assertFalse(nxt.has_header("Authorization"))
        with self.assertRaises(ValueError):
            redirect.redirect_request(
                req, None, 302, "", {}, "http://blob.example/artifact"
            )

    def test_retries_an_interrupted_stream_from_the_beginning(self):
        class Incomplete(io.BytesIO):
            def read(self, size=-1):
                if self.tell():
                    raise ConnectionResetError()
                return super().read(2)

        target = io.BytesIO()
        with (
            patch.dict(os.environ, {"GH_TOKEN": "test-placeholder"}),
            patch.object(waiter, "build_opener") as factory,
            patch.object(waiter.time, "sleep"),
        ):
            factory.return_value.open.side_effect = [
                Incomplete(b"partial"),
                io.BytesIO(b"complete"),
            ]
            waiter.github_api("repos/owner/repo/actions/artifacts/1/zip", output=target)
        self.assertEqual(target.getvalue(), b"complete")

    def test_waits_for_the_actual_producer_attempt(self):
        name = "ios-ci-products-abc-2"
        artifacts = {"artifacts": [{"name": name, "id": 36, "expired": False}]}
        with (
            patch.dict(os.environ, self.env),
            patch.object(
                waiter,
                "request",
                side_effect=[
                    {"total_count": 1, "jobs": [None]},
                    self.jobs,
                    {"artifacts": []},
                    self.jobs,
                    artifacts,
                ],
            ),
            patch.object(waiter.time, "sleep"),
        ):
            selected = waiter.wait("products")
        self.assertEqual(selected, artifacts["artifacts"][0])

    def test_rejects_failure_or_another_head_before_receiving_products(self):
        for change in ({"conclusion": "failure"}, {"head_sha": "other"}):
            with self.subTest(change=change):
                jobs = {"total_count": 1, "jobs": [self.job | change]}
                with (
                    patch.dict(os.environ, self.env),
                    patch.object(waiter, "request", return_value=jobs),
                    self.assertRaises(ValueError),
                ):
                    waiter.wait("products")
        self.assertFalse(self.output.exists())

    def test_checks_archive_identity_and_sha_before_unpacking(self):
        names = [
            "products.tar.zst",
            "product-identity",
            "product-toolchain.json",
            "Package.resolved.before",
            "package-sources.gitconfig",
        ]
        for damage in ["", "digest", "layout", "size"]:
            with self.subTest(damage=damage):
                out = io.BytesIO()
                with zipfile.ZipFile(out, "w") as archive:
                    for name in names:
                        archive.writestr(name, b"known content")
                    if damage == "layout":
                        archive.writestr("extra", b"unexpected")
                data = out.getvalue()
                digest = hashlib.sha256(
                    data if damage != "digest" else b"other"
                ).hexdigest()
                artifact = {
                    "id": 36,
                    "digest": "sha256:" + digest,
                    "size_in_bytes": len(data) + int(damage == "size"),
                }

                def download(path, *, output, timeout, contents=data):
                    self.assertEqual(path, "repos/owner/repo/actions/artifacts/36/zip")
                    output.write(contents)

                destination = self.output.parent / ("products-" + damage)
                with (
                    patch.dict(os.environ, self.env),
                    patch.object(waiter, "github_api", download),
                ):
                    if damage:
                        with self.assertRaises(ValueError):
                            waiter.receive_products(artifact, destination)
                        self.assertEqual(list(destination.iterdir()), [])
                    else:
                        waiter.receive_products(artifact, destination)
                        self.assertEqual(
                            (destination / names[0]).read_bytes(), b"known content"
                        )


class PreparationTests(unittest.TestCase):
    def test_boot_and_transfer_overlap_and_both_must_succeed(self):
        fixture = """import os, pathlib, sys, time
role, other = ("boot", "receive") if "preboot" in __file__ else ("receive", "boot")
root = pathlib.Path(os.environ["RUNNER_TEMP"])
(root / role).touch()
for _ in range(300):
    if (root / other).exists():
        break
    time.sleep(.01)
else:
    sys.exit(99)
sys.exit(7 if role == os.environ["FAIL_ROLE"] else 0)
"""
        for failure in ("", "boot", "receive"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                scripts = root / "ios/scripts"
                scripts.mkdir(parents=True)
                for name in ("preboot-simulator.py", "wait-ci-test-artifact.py"):
                    (scripts / name).write_text(fixture)
                run = subprocess.run(
                    ["bash", str(SCRIPTS / "prepare-parallel-simulator.sh")],
                    cwd=tmp,
                    check=False,
                    env=os.environ | {"RUNNER_TEMP": tmp, "FAIL_ROLE": failure},
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(run.returncode, 7 if failure else 0, run.stderr)
                self.assertTrue(
                    all((root / role).exists() for role in ("boot", "receive"))
                )


class ProductTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.work = self.base / "repo"
        self.lock = (
            self.work
            / "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        self.lock.parent.mkdir(parents=True)
        self.lock.write_text("locked")
        self.src = self.base / "producer"
        self.dst = self.base / "consumer"
        self.root = self.src / "okou-ios-ci"
        products = self.root / "DerivedData/Build/Products"
        binary = products / "Debug-iphonesimulator/Okou.app/Okou"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"test executable")
        binary.chmod(0o755)
        (binary.parent / "alias").symlink_to("Okou")
        (products / "Okou.xctestrun").write_text("test specification")
        (self.root / "package-sources.gitconfig").write_text("")
        shutil.copyfile(self.lock, self.root / "Package.resolved.before")
        self.toolchain = self.base / "tools.json"
        self.toolchain.write_text('{"xcode":"the same"}')
        # The CI host uses sw_vers; provide a deterministic host identity on Linux.
        version = self.base / "sw_vers"
        version.write_text("#!/bin/sh\necho 24D39\n")
        version.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.base}:{os.environ['PATH']}",
            "GITHUB_RUN_ID": "12",
            "GITHUB_SHA": "abc",
            "IOS_PRODUCT_TOOLCHAIN": str(self.toolchain),
        }
        self.command("pack", self.src, check=True)
        shutil.copytree(
            self.src / "ios-native-products", self.dst / "ios-native-products"
        )

    def command(self, mode, temp, check=False, **extra):
        return subprocess.run(
            ["bash", str(SCRIPTS / "transfer-ci-test-products.sh"), mode],
            cwd=self.work,
            env=self.env | {"RUNNER_TEMP": str(temp)} | extra,
            capture_output=True,
            check=check,
        )

    def test_preserves_specification_permissions_and_links(self):
        self.command("unpack", self.dst, check=True)
        products = self.dst / "okou-ios-ci/DerivedData/Build/Products"
        self.assertEqual(
            (products / "Okou.xctestrun").read_text(), "test specification"
        )
        alias = products / "Debug-iphonesimulator/Okou.app/alias"
        self.assertTrue(alias.is_symlink())
        self.assertTrue(os.access(alias, os.X_OK))

    def test_rejects_wrong_run_toolchain_and_package_lock_before_extraction(self):
        self.assertNotEqual(
            self.command("unpack", self.dst, GITHUB_RUN_ID="13").returncode, 0
        )
        self.toolchain.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.toolchain.write_text('{"xcode":"the same"}')
        self.lock.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.assertFalse((self.dst / "okou-ios-ci/DerivedData").exists())


if __name__ == "__main__":
    unittest.main()
