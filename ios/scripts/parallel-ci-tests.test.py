#!/usr/bin/env python3
"""Verify PR artifact provenance, concurrent preparation and executable test products."""

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
            "GITHUB_SHA": "merge-sha",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_REPOSITORY": "owner/repo",
            "PR_HEAD_SHA": "branch-tip",
            "GITHUB_OUTPUT": str(self.output),
        }
        self.job = {
            "name": "test-packages",
            "run_attempt": 1,
            "head_sha": "branch-tip",
            "run_id": 12,
            "conclusion": None,
        }
        self.jobs = {"jobs": [self.job]}
        self.artifact = {
            "name": "ios-ci-products-merge-sha-1",
            "id": 36,
            "expired": False,
            "workflow_run": {"id": 12, "head_sha": "branch-tip"},
        }

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

    def test_selects_the_merge_checkout_on_the_pr_attempt(self):
        for kind, producer, name in [
            ("products", "test-packages", "ios-ci-products-merge-sha-1"),
            ("sources", "prepare-package-sources", "ios-package-sources-merge-sha"),
        ]:
            self.job["name"] = producer
            self.job["conclusion"] = "success" if kind == "sources" else None
            artifact = self.artifact | {"name": name}
            with (
                self.subTest(kind=kind),
                patch.dict(os.environ, self.env),
                patch.object(
                    waiter,
                    "request",
                    side_effect=[
                        {"jobs": [None]},
                        self.jobs,
                        {"artifacts": []},
                        self.jobs,
                        {"artifacts": [artifact | {"expired": True}, artifact]},
                    ],
                ) as request,
                patch.object(waiter.time, "sleep"),
            ):
                self.assertEqual(waiter.wait(kind), artifact)
                self.assertIn("/attempts/1/jobs?", request.call_args_list[0].args[0])
                self.assertIn("name=" + name, request.call_args_list[-1].args[0])

    def test_full_rerun_waits_for_the_replacement_source_upload(self):
        self.env["GITHUB_RUN_ATTEMPT"] = "2"
        source = self.job | {"name": "prepare-package-sources", "run_attempt": 2}
        artifact = self.artifact | {"name": "ios-package-sources-merge-sha"}
        with (
            patch.dict(os.environ, self.env),
            patch.object(
                waiter,
                "request",
                side_effect=[
                    {"jobs": [source]},
                    {"jobs": [source | {"conclusion": "success"}]},
                    {"artifacts": [artifact]},
                ],
            ) as request,
            patch.object(waiter.time, "sleep"),
        ):
            self.assertEqual(waiter.wait("sources"), artifact)
        self.assertIn("/attempts/2/jobs?", request.call_args_list[1].args[0])
        self.assertIn("/artifacts?", request.call_args_list[2].args[0])

    def test_rejects_wrong_producer_or_artifact_identity(self):
        for change in [{"head_sha": "merge-sha"}, {"run_id": 13}, {"run_attempt": 2}]:
            with (
                self.subTest(job=change),
                patch.dict(os.environ, self.env),
                patch.object(
                    waiter, "request", return_value={"jobs": [self.job | change]}
                ),
                self.assertRaisesRegex(ValueError, "Producer identity"),
            ):
                waiter.wait("products")
        for origin in [
            {"id": 13, "head_sha": "branch-tip"},
            {"id": 12, "head_sha": "merge-sha"},
        ]:
            with (
                self.subTest(origin=origin),
                patch.dict(os.environ, self.env),
                patch.object(
                    waiter,
                    "request",
                    side_effect=[
                        self.jobs,
                        {"artifacts": [self.artifact | {"workflow_run": origin}]},
                    ],
                ),
                self.assertRaisesRegex(ValueError, "Artifact identity"),
            ):
                waiter.wait("products")

    def test_independent_package_failure_does_not_hide_a_published_app_suite(self):
        self.job["conclusion"] = "failure"
        with (
            patch.dict(os.environ, self.env),
            patch.object(
                waiter,
                "request",
                side_effect=[
                    self.jobs,
                    {"artifacts": [self.artifact]},
                    self.jobs,
                    {"artifacts": []},
                ],
            ),
        ):
            self.assertEqual(waiter.wait("products"), self.artifact)
            with self.assertRaisesRegex(ValueError, "ended with failure"):
                waiter.wait("products")

    def test_checks_archive_identity_and_sha_before_unpacking(self):
        names = [
            "products.tar.zst",
            "product-identity",
            "product-toolchain.json",
            "Package.resolved.before",
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
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "merge-sha",
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
        for env in [
            {"GITHUB_RUN_ID": "13"},
            {"GITHUB_RUN_ATTEMPT": "2"},
            {"GITHUB_SHA": "other"},
            {"ImageVersion": "other"},
        ]:
            with self.subTest(env=env):
                self.assertNotEqual(
                    self.command("unpack", self.dst, **env).returncode, 0
                )
        self.toolchain.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.toolchain.write_text('{"xcode":"the same"}')
        self.lock.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.assertFalse((self.dst / "okou-ios-ci/DerivedData").exists())


if __name__ == "__main__":
    unittest.main()
