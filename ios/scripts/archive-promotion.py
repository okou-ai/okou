#!/usr/bin/env python3
"""Exact-input iOS test evidence and immutable archive promotion protocol."""

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import tarfile
import time
from pathlib import Path, PurePosixPath

import tomllib

INPUT_PATHS = (
    "ios",
    ".github/workflows/ios.yml",
    ".github/workflows/ios-archive-proof.yml",
    ".github/workflows/release-please.yml",
    ".github/scripts/changed-base-ref.sh",
    "release-please-config.json",
)
SEMVER = r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?"
VERSION_LINE = re.compile(
    rb"(?m)^(MARKETING_VERSION = )"
    + SEMVER.encode()
    + rb"( // x-release-please-version)$"
)
TEST_STEP = "Build app and run isolated simulator tests"
ARCHIVE_STEP = "Build unsigned device Release archive"


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def git_bytes(*args):
    return subprocess.check_output(["git", *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def write_json(path, value):
    path.write_bytes(json_bytes(value))


def read_json(path):
    return json.loads(path.read_bytes())


def toolchain():
    return {
        "xcode": command("xcodebuild", "-version"),
        "deviceSDK": command("xcrun", "--sdk", "iphoneos", "--show-sdk-build-version"),
        "simulatorSDK": command(
            "xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version"
        ),
        "architecture": platform.machine(),
        "testDestination": os.environ["IOS_TEST_DESTINATION"],
    }


def inputs(commit, tools):
    entries = git_bytes("ls-tree", "-r", "-z", commit, "--", *INPUT_PATHS).split(b"\0")
    archive, tests = [], []
    for entry in entries:
        if not entry:
            continue
        header, raw_path = entry.split(b"\t", 1)
        mode, kind, oid = header.decode().split()
        path = raw_path.decode()
        if path == "ios/CHANGELOG.md":
            continue
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ValueError(f"Unsupported promotion input: {path}")
        data = git_bytes("cat-file", "blob", oid)
        archive.append([path, mode, digest(data)])
        if path == "ios/version.txt":
            if not re.fullmatch(SEMVER, data.decode().strip()):
                raise ValueError("Invalid iOS release version")
            data = b"<release-version>\n"
        elif path == "ios/Config/Shared.xcconfig":
            data, count = VERSION_LINE.subn(rb"\1<release-version>\2", data)
            if count != 1:
                raise ValueError(
                    "Expected exactly one release-please marketing version"
                )
        tests.append([path, mode, digest(data)])
    if not any(entry[0] == "ios/version.txt" for entry in archive):
        raise ValueError("Missing iOS promotion inputs")
    return {
        "version": 1,
        "toolchain": tools,
        "archiveInputSha256": digest(json_bytes([archive, tools])),
        "testInputSha256": digest(json_bytes([tests, tools])),
    }


def ensure_commit(sha):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a full builder commit SHA")
    result = subprocess.run(
        ["git", "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True, check=False
    )
    if result.returncode:
        subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", "origin", sha], check=True
        )


def version_only(before, after):
    before, after = dict(before), dict(after)
    old, new = before.pop("version", None), after.pop("version", None)
    return bool(
        isinstance(old, str)
        and isinstance(new, str)
        and re.fullmatch(SEMVER, old)
        and re.fullmatch(SEMVER, new)
        and before == after
    )


def release_only(base):
    """Conservative whole-group allowlist; unknown metadata changes run tests."""
    command("git", "merge-base", "--is-ancestor", base, "HEAD")
    packages = json.loads(git_bytes("show", f"{base}:release-please-config.json"))[
        "packages"
    ]
    changes = git_bytes(
        "diff", "--no-renames", "--name-only", "-z", base, "HEAD"
    ).split(b"\0")
    changed = [path.decode() for path in changes if path]
    if not changed:
        return False
    for path in changed:
        # No additions, deletions, mode changes, or renames can be version-only.
        old_entry = git_bytes("ls-tree", base, "--", path).split()
        new_entry = git_bytes("ls-tree", "HEAD", "--", path).split()
        if not old_entry or not new_entry or old_entry[:2] != new_entry[:2]:
            return False
        before = git_bytes("show", f"{base}:{path}")
        after = git_bytes("show", f"HEAD:{path}")
        if path in {f"{package}/CHANGELOG.md" for package in packages}:
            continue
        if path == ".release-please-manifest.json":
            old, new = json.loads(before), json.loads(after)
            if old.keys() == new.keys() and all(
                key in packages
                and re.fullmatch(SEMVER, old[key])
                and re.fullmatch(SEMVER, new[key])
                for key in old
            ):
                continue
        if path == "ios/Config/Shared.xcconfig":
            old, old_count = VERSION_LINE.subn(rb"\1<release-version>\2", before)
            new, new_count = VERSION_LINE.subn(rb"\1<release-version>\2", after)
            if old_count == new_count == 1 and old == new:
                continue
        for package, config in packages.items():
            if (
                config["release-type"] == "simple"
                and path == f"{package}/{config.get('version-file', 'version.txt')}"
            ):
                if re.fullmatch(SEMVER, before.decode().strip()) and re.fullmatch(
                    SEMVER, after.decode().strip()
                ):
                    break
            elif config["release-type"] == "node" and path == f"{package}/package.json":
                if version_only(json.loads(before), json.loads(after)):
                    break
            elif config["release-type"] == "rust" and path == f"{package}/Cargo.toml":
                old, new = tomllib.loads(before.decode()), tomllib.loads(after.decode())
                if version_only(old.pop("package"), new.pop("package")) and old == new:
                    break
        else:
            if path == "crates/Cargo.lock":
                old, new = tomllib.loads(before.decode()), tomllib.loads(after.decode())
                for lock in (old, new):
                    for locked_package in lock["package"]:
                        if "source" not in locked_package and re.fullmatch(
                            SEMVER, locked_package["version"]
                        ):
                            locked_package["version"] = "<release-version>"
                if old == new:
                    continue
            return False
    return True


class Store:
    def __init__(self):
        self.bucket = os.environ["R2_BUCKET_NAME"]
        self.endpoint = (
            f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        )
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
            if not os.environ.get(name):
                raise ValueError(f"{name} is required")

    def call(self, operation, key, *args):
        return subprocess.run(
            [
                "aws",
                "s3api",
                operation,
                "--endpoint-url",
                self.endpoint,
                "--bucket",
                self.bucket,
                "--key",
                key,
                *args,
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def get(self, key, destination):
        result = self.call("get-object", key, str(destination))
        if result.returncode:
            if re.search(r"\((NoSuchKey|404|NotFound)\)", result.stderr):
                return False
            raise RuntimeError(result.stderr)
        return True

    def put(self, key, source):
        result = self.call(
            "put-object", key, "--body", str(source), "--if-none-match", "*"
        )
        if result.returncode:
            if re.search(r"\((PreconditionFailed|412)\)", result.stderr):
                return False
            raise RuntimeError(result.stderr)
        return True


def required_object(store, key, path):
    if not store.get(key, path):
        raise ValueError(f"Required promotion object is missing: {key}")
    return read_json(path)


def github_record(record, required_step):
    if record["repository"] != os.environ["GITHUB_REPOSITORY"]:
        raise ValueError("Evidence belongs to another repository")
    sha = record["commitSha"]
    ensure_commit(sha)
    run_id, attempt = record["runId"], record["runAttempt"]
    if (
        not isinstance(run_id, int)
        or not isinstance(attempt, int)
        or min(run_id, attempt) < 1
    ):
        raise ValueError("Invalid evidence run identity")
    route = f"repos/{record['repository']}/actions/runs/{run_id}/attempts/{attempt}"
    run = json.loads(command("gh", "api", route))
    if (
        run["head_sha"] != sha
        or run["event"] != "merge_group"
        or run["path"] != ".github/workflows/ios.yml"
        or not run["head_branch"].startswith("gh-readonly-queue/main/")
    ):
        raise ValueError("Expected an exact main merge-group iOS builder")
    pages = json.loads(
        command("gh", "api", f"{route}/jobs?per_page=100", "--paginate", "--slurp")
    )
    jobs = [
        job for page in pages for job in page["jobs"] if job["name"] == "build-test"
    ]
    if (
        len(jobs) != 1
        or jobs[0]["conclusion"] != "success"
        or not any(
            step["name"] == required_step and step["conclusion"] == "success"
            for step in jobs[0]["steps"]
        )
    ):
        raise ValueError(f"Builder did not pass {required_step}")


def verify_evidence(evidence, target):
    if (
        evidence["version"] != 1
        or evidence["testInputSha256"] != target["testInputSha256"]
    ):
        raise ValueError("Test evidence does not match these inputs")
    github_record(evidence, TEST_STEP)
    actual = inputs(evidence["commitSha"], target["toolchain"])
    if (
        evidence["toolchain"] != target["toolchain"]
        or actual["testInputSha256"] != target["testInputSha256"]
    ):
        raise ValueError(
            "Test evidence source/configuration/dependencies/toolchain mismatch"
        )


def provenance():
    return {
        "version": 1,
        "repository": os.environ["GITHUB_REPOSITORY"],
        "commitSha": command("git", "rev-parse", "HEAD"),
        "runId": int(os.environ["GITHUB_RUN_ID"]),
        "runAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
    }


def resolve_tests(work):
    target = read_json(work / "inputs.json")
    run_tests = True
    if os.environ["GITHUB_EVENT_NAME"] == "merge_group" and release_only(
        os.environ["MERGE_GROUP_BASE_SHA"]
    ):
        evidence_file = work / "test-evidence.json"
        key = f"okou-ios/tests/{target['testInputSha256']}/evidence.json"
        if Store().get(key, evidence_file):
            verify_evidence(read_json(evidence_file), target)
            run_tests = False
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"run_tests={str(run_tests).lower()}\n")
    print(
        "Run simulator tests"
        if run_tests
        else "Reuse exact-input main merge-group test evidence"
    )


def publish(work):
    target = read_json(work / "inputs.json")
    if os.environ["GITHUB_EVENT_NAME"] != "merge_group":
        raise ValueError("Only main merge groups can publish canonical archives")
    record = provenance()
    if inputs(record["commitSha"], target["toolchain"]) != target:
        raise ValueError("Builder inputs changed")
    github_record(record, ARCHIVE_STEP)
    archive_checksum = (work / "archive-sha256.txt").read_text().strip()
    if archive_checksum != file_digest(work / "archive.tar.gz"):
        raise ValueError("Archive transfer checksum mismatch")
    store = Store()
    evidence_file = work / "test-evidence.json"
    ran_tests = os.environ["IOS_RAN_TESTS"]
    if ran_tests not in ("true", "false"):
        raise ValueError("Expected an explicit simulator test decision")
    if ran_tests == "false" and not release_only(os.environ["MERGE_GROUP_BASE_SHA"]):
        raise ValueError("Mixed merge groups must run simulator tests")
    if ran_tests == "true":
        evidence = record | {
            "testInputSha256": target["testInputSha256"],
            "toolchain": target["toolchain"],
        }
        verify_evidence(evidence, target)
        write_json(evidence_file, evidence)
        key = f"okou-ios/tests/{target['testInputSha256']}/evidence.json"
        if not store.put(key, evidence_file):
            evidence = required_object(store, key, evidence_file)
    else:
        evidence = read_json(evidence_file)
    verify_evidence(evidence, target)
    prefix = (
        f"okou-ios/archives/{target['archiveInputSha256']}/{record['commitSha']}/"
        f"{record['runId']}/{record['runAttempt']}"
    )
    manifest = (
        record
        | target
        | {
            "iosVersion": git_bytes("show", "HEAD:ios/version.txt").decode().strip(),
            "archiveSha256": archive_checksum,
            "testEvidence": evidence,
        }
    )
    manifest_file = work / "manifest.json"
    write_json(manifest_file, manifest)
    for name in ("archive.tar.gz", "manifest.json"):
        if not store.put(f"{prefix}/{name}", work / name):
            raise ValueError(
                "Builder artifact already exists; never overwrite immutable objects"
            )
    ready = {
        "version": 1,
        "archiveInputSha256": target["archiveInputSha256"],
        "manifestKey": f"{prefix}/manifest.json",
        "manifestSha256": digest(manifest_file.read_bytes()),
    }
    ready_file = work / "ready.json"
    write_json(ready_file, ready)
    # A unique builder namespace prevents cross-run partial-upload races. The
    # first completed exact-input archive wins; no mutable latest-success index.
    if not store.put(
        f"okou-ios/inputs/{target['archiveInputSha256']}/ready.json", ready_file
    ):
        existing_work = work / "existing-ready"
        existing_work.mkdir()
        download_archive(existing_work, store, target, 0, manifest["iosVersion"])
    print(f"Published immutable archive: {prefix}")


def download_archive(work, store, target, wait_seconds, version):
    ready_file = work / "ready.json"
    key = f"okou-ios/inputs/{target['archiveInputSha256']}/ready.json"
    deadline = time.monotonic() + wait_seconds
    while not store.get(key, ready_file):
        if time.monotonic() >= deadline:
            raise ValueError("Exact-input archive is not ready; no rebuild fallback")
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    ready = read_json(ready_file)
    if (
        ready["version"] != 1
        or ready["archiveInputSha256"] != target["archiveInputSha256"]
    ):
        raise ValueError("Readiness identity mismatch")
    if not re.fullmatch(
        rf"okou-ios/archives/{target['archiveInputSha256']}/[0-9a-f]{{40}}/[1-9][0-9]*/[1-9][0-9]*/manifest\.json",
        ready["manifestKey"],
    ):
        raise ValueError("Noncanonical archive mapping")
    manifest_file = work / "manifest.json"
    manifest = required_object(store, ready["manifestKey"], manifest_file)
    if digest(manifest_file.read_bytes()) != ready["manifestSha256"]:
        raise ValueError("Manifest checksum mismatch")
    github_record(manifest, ARCHIVE_STEP)
    actual = inputs(manifest["commitSha"], target["toolchain"])
    for field in ("version", "archiveInputSha256", "testInputSha256", "toolchain"):
        if manifest[field] != target[field] or actual[field] != target[field]:
            raise ValueError(f"Archive input mismatch: {field}")
    verify_evidence(manifest["testEvidence"], target)
    if manifest["iosVersion"] != version:
        raise ValueError("Release version mismatch")
    prefix = (
        f"okou-ios/archives/{target['archiveInputSha256']}/{manifest['commitSha']}/"
        f"{manifest['runId']}/{manifest['runAttempt']}"
    )
    if ready["manifestKey"] != f"{prefix}/manifest.json":
        raise ValueError("Noncanonical archive mapping")
    archive_file = work / "archive.tar.gz"
    if not store.get(f"{prefix}/archive.tar.gz", archive_file):
        raise ValueError("Mapped archive is missing")
    if file_digest(archive_file) != manifest["archiveSha256"]:
        raise ValueError("Archive checksum mismatch")
    return manifest, ready


def consume(work, wait_seconds):
    if os.environ["GITHUB_REF"] != "refs/heads/main":
        raise ValueError("Only main can consume a release archive")
    target = read_json(work / "inputs.json")
    version = git_bytes("show", "HEAD:ios/version.txt").decode().strip()
    if version != os.environ["IOS_VERSION"]:
        raise ValueError("Release version mismatch")
    manifest, ready = download_archive(work, Store(), target, wait_seconds, version)
    archive_file = work / "archive.tar.gz"
    archive_root = (work / "Original.xcarchive").resolve()

    def archive_member(member, destination):
        safe = tarfile.data_filter(member, destination)
        if safe is None:
            return None
        member_path = Path(destination) / safe.name
        if not member_path.resolve().is_relative_to(archive_root):
            raise ValueError("Archive member escapes the application archive")
        if safe.issym() or safe.islnk():
            link_base = member_path.parent if safe.issym() else Path(destination)
            if not (link_base / safe.linkname).resolve().is_relative_to(archive_root):
                raise ValueError("Archive link escapes the application archive")
        return safe

    with tarfile.open(archive_file) as archive:
        members = archive.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or path.parts[0] != "Original.xcarchive"
            ):
                raise ValueError("Unexpected archive member path")
        archive.extractall(work, members=members, filter=archive_member)
    mapping = {
        "version": 1,
        "releaseTarget": command("git", "rev-parse", "HEAD"),
        "iosVersion": version,
        "archiveInputSha256": target["archiveInputSha256"],
        "builderCommit": manifest["commitSha"],
        "builderRunId": manifest["runId"],
        "builderRunAttempt": manifest["runAttempt"],
        "manifestKey": ready["manifestKey"],
        "manifestSha256": ready["manifestSha256"],
        "archiveSha256": manifest["archiveSha256"],
        "testEvidence": manifest["testEvidence"],
    }
    write_json(work / "release-mapping.json", mapping)
    mapping_key = f"okou-ios/releases/{mapping['releaseTarget']}/mapping.json"
    store = Store()
    if not store.put(mapping_key, work / "release-mapping.json"):
        existing = required_object(store, mapping_key, work / "existing-mapping.json")
        if existing != mapping:
            raise ValueError("Release target already maps to a different archive")
    print(json.dumps(mapping))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    tools = sub.add_parser("toolchain")
    tools.add_argument("output", type=Path)
    capture = sub.add_parser("inputs")
    capture.add_argument("--toolchain", required=True, type=Path)
    capture.add_argument("--output", required=True, type=Path)
    release = sub.add_parser("release-only")
    release.add_argument("--base", required=True)
    for operation in ("resolve-tests", "publish", "consume"):
        part = sub.add_parser(operation)
        part.add_argument("work", type=Path)
        if operation == "consume":
            part.add_argument("--wait-seconds", type=int, default=600)
    args = parser.parse_args()
    if args.operation == "toolchain":
        write_json(args.output, toolchain())
    elif args.operation == "inputs":
        subprocess.run(
            ["git", "diff", "--exit-code", "HEAD", "--", *INPUT_PATHS], check=True
        )
        if git_bytes("ls-files", "--others", "--exclude-standard", "--", *INPUT_PATHS):
            raise ValueError("Untracked promotion inputs are not allowed")
        write_json(args.output, inputs("HEAD", read_json(args.toolchain)))
    elif args.operation == "release-only":
        print(str(release_only(args.base)).lower())
    elif args.operation == "resolve-tests":
        resolve_tests(args.work)
    elif args.operation == "publish":
        publish(args.work)
    else:
        consume(args.work, args.wait_seconds)


if __name__ == "__main__":
    main()
