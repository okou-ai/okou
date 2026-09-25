#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
build_script="${repo_root}/.github/scripts/build-okou-desktop-artifact.sh"
verify_script="${repo_root}/.github/scripts/verify-okou-desktop-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
desktop_version="1.2.3"
okou_app_dir="${tmp_dir}/package/Okou.app"
other_app_dir="${tmp_dir}/package/Other.app"
artifact_dir="${tmp_dir}/artifact"
mkdir -p \
  "$okou_app_dir/Contents/MacOS" \
  "$okou_app_dir/Contents/Frameworks/Example.framework/Versions/A" \
  "$other_app_dir/Contents/MacOS"
printf '#!/usr/bin/env bash\nexit 0\n' > "$okou_app_dir/Contents/MacOS/Okou"
printf '#!/usr/bin/env bash\nexit 0\n' > "$other_app_dir/Contents/MacOS/Other"
chmod +x "$okou_app_dir/Contents/MacOS/Okou"
chmod +x "$other_app_dir/Contents/MacOS/Other"
ln -s A "$okou_app_dir/Contents/Frameworks/Example.framework/Versions/Current"

bash "$build_script" \
  "$commit_sha" \
  "$desktop_version" \
  "$okou_app_dir" \
  "$artifact_dir"
bash "$verify_script" "$artifact_dir" "$commit_sha" "$desktop_version"
jq -e \
  --arg commit_sha "$commit_sha" \
  --arg desktop_version "$desktop_version" \
  '.commitSha == $commit_sha
    and .desktopVersion == $desktop_version
    and .okouAppName == "Okou.app"
    and .okouArchive.path == "okou-app.tar.gz"' \
  "$artifact_dir/manifest.json" >/dev/null

extracted_dir="${tmp_dir}/extracted"
mkdir -p "$extracted_dir"
tar -xzf "$artifact_dir/okou-app.tar.gz" -C "$extracted_dir"
test -x "$extracted_dir/Okou.app/Contents/MacOS/Okou"
test -L "$extracted_dir/Okou.app/Contents/Frameworks/Example.framework/Versions/Current"

if bash "$build_script" \
  "$commit_sha" \
  "$desktop_version" \
  "$other_app_dir" \
  "${tmp_dir}/other-artifact" >/dev/null 2>&1; then
  echo "Expected an app directory that is not Okou.app to be rejected" >&2
  exit 1
fi

tampered_dir="${tmp_dir}/tampered"
cp -a "$artifact_dir" "$tampered_dir"
printf 'tampered\n' >> "$tampered_dir/okou-app.tar.gz"
if bash "$verify_script" "$tampered_dir" "$commit_sha" "$desktop_version" >/dev/null 2>&1; then
  echo "Expected a tampered Okou Desktop archive to fail" >&2
  exit 1
fi

missing_dir="${tmp_dir}/missing"
cp -a "$artifact_dir" "$missing_dir"
rm -f "$missing_dir/okou-app.tar.gz"
if bash "$verify_script" "$missing_dir" "$commit_sha" "$desktop_version" >/dev/null 2>&1; then
  echo "Expected a missing Okou Desktop archive to fail" >&2
  exit 1
fi

wrong_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
if bash "$verify_script" "$artifact_dir" "$wrong_sha" "$desktop_version" >/dev/null 2>&1; then
  echo "Expected a Desktop artifact for another commit to fail" >&2
  exit 1
fi
if bash "$verify_script" "$artifact_dir" "$commit_sha" "1.2.4" >/dev/null 2>&1; then
  echo "Expected a Desktop artifact for another version to fail" >&2
  exit 1
fi

unsafe_dir="${tmp_dir}/unsafe"
unsafe_source="${tmp_dir}/unsafe-source"
mkdir -p "$unsafe_dir" "$unsafe_source/Other.app"
printf 'unexpected\n' > "$unsafe_source/Other.app/file"
tar -czf "$unsafe_dir/okou-app.tar.gz" -C "$unsafe_source" Other.app
unsafe_archive_sha="$(shasum -a 256 "$unsafe_dir/okou-app.tar.gz" | cut -d ' ' -f 1)"
unsafe_archive_size="$(wc -c < "$unsafe_dir/okou-app.tar.gz" | tr -d '[:space:]')"
jq \
  --arg archive_sha "$unsafe_archive_sha" \
  --argjson archive_size "$unsafe_archive_size" \
  '.okouArchive.sha256 = $archive_sha | .okouArchive.size = $archive_size' \
  "$artifact_dir/manifest.json" > "$unsafe_dir/manifest.json"
unsafe_manifest_sha="$(shasum -a 256 "$unsafe_dir/manifest.json" | cut -d ' ' -f 1)"
jq \
  --arg manifest_sha "$unsafe_manifest_sha" \
  '.manifestSha256 = $manifest_sha' \
  "$artifact_dir/ready.json" > "$unsafe_dir/ready.json"
if bash "$verify_script" "$unsafe_dir" "$commit_sha" "$desktop_version" >/dev/null 2>&1; then
  echo "Expected an archive with another top-level path to fail" >&2
  exit 1
fi

forge_output="${tmp_dir}/forge-output"
mkdir -p "$forge_output/Okou.app/Contents/Resources/native" \
  "$forge_output/Okou.app/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "$forge_output/Okou.app/Contents/Resources/native/clerk-auth-helper"
chmod +x "$forge_output/Okou.app/Contents/Resources/native/clerk-auth-helper"

OKOU_DESKTOP_SKIP_SIGNING=true node - "$repo_root" "$forge_output" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = process.argv[2];
const outputPath = process.argv[3];
const forgeConfig = require(path.join(
  repoRoot,
  "turbo/apps/desktop/forge.config.js",
));

if (forgeConfig.packagerConfig.name !== "Okou") {
  throw new Error("Default build must use the Okou display name");
}
if (forgeConfig.packagerConfig.appBundleId !== "ai.okou.desktop") {
  throw new Error("Default build must use the Okou bundle ID");
}

forgeConfig.hooks
  .postPackage({}, { platform: "darwin", outputPaths: [outputPath] })
  .then(() => {
    const helperPath = path.join(outputPath, "Okou.app/Contents/MacOS/clerk-auth-helper");
    if (!fs.statSync(helperPath).isFile()) {
      throw new Error("Packaged native Clerk helper is missing");
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
NODE

OKOU_DESKTOP_SKIP_SIGNING=true \
OKOU_DESKTOP_PRODUCT=okou \
OKOU_DESKTOP_PLATFORM_URL=https://app.okou.ai \
node - "$repo_root" <<'NODE'
const path = require("node:path");

const repoRoot = process.argv[2];
const forgeConfig = require(path.join(
  repoRoot,
  "turbo/apps/desktop/forge.config.js",
));
const { packagedAppPaths } = require(path.join(
  repoRoot,
  "turbo/apps/desktop/scripts/packaged-app-paths.js",
));

if (forgeConfig.packagerConfig.name !== "Okou") {
  throw new Error("Okou build must use the Okou display name");
}
if (forgeConfig.packagerConfig.appBundleId !== "ai.okou.desktop") {
  throw new Error("Okou build must use the Okou production bundle ID");
}
if (
  forgeConfig.packagerConfig.protocols[0].schemes[0] !==
  "ai.okou.desktop"
) {
  throw new Error("Okou build must register the Okou auth scheme");
}
if (
  !packagedAppPaths().appBundlePath.endsWith(
    `Okou-${process.platform}-${process.arch}/Okou.app`,
  )
) {
  throw new Error("Okou packaged app path must be product scoped");
}
if (
  packagedAppPaths({ appBundlePath: "/tmp/Okou.app" })
    .appBundlePath !== "/tmp/Okou.app"
) {
  throw new Error("Desktop smoke tests must support an installed app path");
}
NODE

echo "okou Desktop artifact tests passed"
