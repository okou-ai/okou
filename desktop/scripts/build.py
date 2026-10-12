#!/usr/bin/env python3
"""Build the native app; release promotion signs the identical CI artifact."""

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def build(version, development, output):
    key = os.environ.get("CLERK_PUBLISHABLE_KEY", "")
    platform = os.environ.get("OKOU_DESKTOP_PLATFORM_URL", "https://app.okou.ai")
    if not key.startswith("pk_test_" if development else "pk_live_"):
        raise ValueError("CLERK_PUBLISHABLE_KEY must match the selected environment")
    config = ROOT / "Resources/desktop-runtime-config.json"
    config.write_text(
        json.dumps(
            {"product": "okou", "platformUrl": platform, "clerkPublishableKey": key}
        )
        + "\n"
    )
    name = "Okou Dev" if development else "Okou"
    identifier = "ai.okou.desktop.dev" if development else "ai.okou.desktop"
    # Custom settings are consumed only by our target. Global PRODUCT_NAME
    # would also rename Swift package resource bundles on a clean build.
    try:
        run(
            "xcodebuild",
            "-project",
            ROOT / "Okou.xcodeproj",
            "-scheme",
            "Okou",
            "-configuration",
            "Release",
            "-destination",
            "generic/platform=macOS",
            "ARCHS=arm64",
            "-jobs",
            "4",
            "-derivedDataPath",
            ROOT / ".build-app",
            "-onlyUsePackageVersionsFromResolvedFile",
            "CODE_SIGNING_ALLOWED=NO",
            f"OKOU_PRODUCT_NAME={name}",
            f"OKOU_BUNDLE_IDENTIFIER={identifier}",
            f"OKOU_VERSION={version}",
        )
    finally:
        config.unlink(missing_ok=True)
    app = output / f"{name}-darwin-arm64" / f"{name}.app"
    if app.exists():
        shutil.rmtree(app)
    app.parent.mkdir(parents=True, exist_ok=True)
    run("ditto", ROOT / f".build-app/Build/Products/Release/{name}.app", app)
    helper_root = ROOT / "ComputerUse"
    run(
        "swift",
        "build",
        "--package-path",
        helper_root,
        "-c",
        "release",
        "-j",
        "4",
        "--disable-automatic-resolution",
    )
    helper_bin = subprocess.check_output(
        [
            "swift",
            "build",
            "--package-path",
            str(helper_root),
            "-c",
            "release",
            "--show-bin-path",
        ],
        text=True,
    ).strip()
    run(
        "ditto",
        Path(helper_bin) / "computer-use-helper",
        app / "Contents/MacOS/computer-use-helper",
    )
    for framework in Path(helper_bin).glob("*.framework"):
        run("ditto", framework, app / "Contents/Frameworks" / framework.name)
    for resource in Path(helper_bin).glob("*.bundle"):
        run("ditto", resource, app / "Contents/Resources" / resource.name)
    run(
        "install_name_tool",
        "-add_rpath",
        "@executable_path/../Frameworks",
        app / "Contents/MacOS/computer-use-helper",
    )
    return app


def sign(app, identity):
    production = identity != "-"
    plist = app / "Contents/Info.plist"
    info = plistlib.loads(plist.read_bytes())
    info["OkouUpdatesEnabled"] = (
        production and info["CFBundleIdentifier"] == "ai.okou.desktop"
    )
    if os.environ.get("SENTRY_DSN_DESKTOP"):
        info["OkouSentryDSN"] = os.environ["SENTRY_DSN_DESKTOP"]
    plist.write_bytes(plistlib.dumps(info))
    common = ["codesign", "--force", "--sign", identity]
    if production:
        common += ["--timestamp", "--options", "runtime"]
    # Sign inside out, including Sparkle's installer, downloader, and XPC services.
    nested = []
    for path in (app / "Contents").rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as file:
            magic = file.read(4)
        if magic in (
            b"\xcf\xfa\xed\xfe",
            b"\xce\xfa\xed\xfe",
            b"\xca\xfe\xba\xbe",
            b"\xca\xfe\xba\xbf",
        ):
            nested.append(path)
    for path in sorted(nested, key=lambda p: len(p.parts), reverse=True):
        run(*common, path)
    bundles = [
        p
        for p in (app / "Contents").rglob("*")
        if p.is_dir()
        and not p.is_symlink()
        and p.suffix in (".framework", ".app", ".xpc")
    ]
    for path in sorted(bundles, key=lambda p: len(p.parts), reverse=True):
        run(*common, path)
    run(*common, "--entitlements", ROOT / "Resources/Entitlements.plist", app)
    run("codesign", "--verify", "--deep", "--strict", app)


def verify(app, version, development):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    identifier = "ai.okou.desktop.dev" if development else "ai.okou.desktop"
    name = "Okou Dev" if development else "Okou"
    assert info["CFBundleIdentifier"] == identifier
    assert info["CFBundleName"] == name
    assert info["CFBundleDisplayName"] == name
    assert info["CFBundleExecutable"] == name
    assert info["CFBundleURLTypes"][0]["CFBundleURLSchemes"] == [identifier]
    assert info["LSMinimumSystemVersion"] == "14.0"
    assert info["CFBundleShortVersionString"] == version
    assert info["CFBundleVersion"] == version
    assert not (app / "Contents/Frameworks/Electron Framework.framework").exists()
    assert (app / "Contents/Resources/Clerk_ClerkKit.bundle").is_dir()
    config = json.loads(
        (app / "Contents/Resources/desktop-runtime-config.json").read_text()
    )
    assert config["product"] == "okou"
    assert config["clerkPublishableKey"].startswith(
        "pk_test_" if development else "pk_live_"
    )
    if not development:
        assert config["platformUrl"] == "https://app.okou.ai"
    for executable in (name, "computer-use-helper"):
        run("lipo", app / "Contents/MacOS" / executable, "-verify_arch", "arm64")
    run(app / "Contents/MacOS" / info["CFBundleExecutable"], "--smoke-test", timeout=30)


def notarize(artifact, profile):
    if profile:
        credentials = ["--keychain-profile", profile]
    else:
        credentials = [
            "--key",
            os.environ["OKOU_DESKTOP_NOTARIZE_API_KEY_PATH"],
            "--key-id",
            os.environ["OKOU_DESKTOP_NOTARIZE_API_KEY_ID"],
            "--issuer",
            os.environ["OKOU_DESKTOP_NOTARIZE_API_ISSUER"],
        ]
    # Keep the same submission after transport failures; never hide an Apple rejection.
    result = subprocess.check_output(
        [
            "xcrun",
            "notarytool",
            "submit",
            str(artifact),
            *credentials,
            "--output-format",
            "json",
        ],
        text=True,
    )
    submission = json.loads(result)["id"]
    print(f"Notarization submission: {submission}", flush=True)
    for attempt in range(3):
        waited = subprocess.run(
            [
                "xcrun",
                "notarytool",
                "wait",
                submission,
                *credentials,
                "--output-format",
                "json",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if waited.returncode == 0:
            status = json.loads(waited.stdout)["status"]
            if status != "Accepted":
                run("xcrun", "notarytool", "log", submission, *credentials)
                raise RuntimeError(f"Apple notarization: {status}")
            return
        print(waited.stderr, flush=True)
    raise RuntimeError(f"Notarization did not complete: {submission}")


def package(app, identity, profile, should_notarize, output):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    name, version = info["CFBundleName"], info["CFBundleShortVersionString"]
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{name}-darwin-arm64-{version}.zip"
    dmg = archive.with_suffix(".dmg")
    archive.unlink(missing_ok=True)
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive)
    if should_notarize:
        notarize(archive, profile)
        run("xcrun", "stapler", "staple", app)
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive)
    with tempfile.TemporaryDirectory(prefix="okou-dmg-") as staging:
        run("ditto", app, Path(staging) / app.name)
        (Path(staging) / "Applications").symlink_to("/Applications")
        run(
            "hdiutil",
            "create",
            "-ov",
            "-format",
            "UDZO",
            "-volname",
            name,
            "-srcfolder",
            staging,
            dmg,
        )
    if identity != "-":
        run("codesign", "--force", "--sign", identity, "--timestamp", dmg)
    if should_notarize:
        notarize(dmg, profile)
        run("xcrun", "stapler", "staple", dmg)
        run("xcrun", "stapler", "validate", app)
        run("xcrun", "stapler", "validate", dmg)
        run("spctl", "--assess", "--type", "execute", app)
    run("hdiutil", "verify", dmg)
    print(archive, dmg, sep="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        type=Path,
        help="Promote an existing canonical artifact without rebuilding",
    )
    parser.add_argument("--version", default=(ROOT / "version.txt").read_text().strip())
    parser.add_argument("--output", type=Path, default=ROOT / "out")
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--sign", default="-", metavar="IDENTITY")
    parser.add_argument("--notarize", action="store_true")
    parser.add_argument("--notary-profile")
    parser.add_argument("--package", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("Version must be a numeric major.minor.patch")
    if args.notarize and (args.sign == "-" or not args.package):
        parser.error("Notarization requires Developer ID signing and --package")
    output = args.output.resolve()
    app = (
        args.app.resolve()
        if args.app
        else build(args.version, args.development, output)
    )
    if not args.verify_only:
        sign(app, args.sign)
    verify(app, args.version, args.development)
    if args.package:
        package(app, args.sign, args.notary_profile, args.notarize, output)
    print(app)


if __name__ == "__main__":
    main()
