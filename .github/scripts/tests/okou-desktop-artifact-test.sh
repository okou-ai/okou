#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
build_script="${repo_root}/.github/scripts/artifacts/build-okou-desktop-artifact.sh"
verify_script="${repo_root}/.github/scripts/artifacts/verify-okou-desktop-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
desktop_version="1.2.3"
okou_app_dir="${tmp_dir}/package/Okou.app"
other_app_dir="${tmp_dir}/package/Other.app"
artifact_dir="${tmp_dir}/artifact"
symbols_dir="${tmp_dir}/package/dSYMs"
mkdir -p \
  "$okou_app_dir/Contents/MacOS" \
  "$okou_app_dir/Contents/Frameworks/Example.framework/Versions/A" \
  "$other_app_dir/Contents/MacOS"
printf '#!/usr/bin/env bash\nexit 0\n' > "$okou_app_dir/Contents/MacOS/Okou"
printf '#!/usr/bin/env bash\nexit 0\n' > "$other_app_dir/Contents/MacOS/Other"
chmod +x "$okou_app_dir/Contents/MacOS/Okou"
chmod +x "$other_app_dir/Contents/MacOS/Other"
ln -s A "$okou_app_dir/Contents/Frameworks/Example.framework/Versions/Current"
for bundle in Okou.app.dSYM computer-use-helper.dSYM; do
  mkdir -p "$symbols_dir/$bundle/Contents/Resources/DWARF"
  printf 'debug symbols\n' > "$symbols_dir/$bundle/Contents/Resources/DWARF/binary"
done

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
    and .okouArchive.path == "okou-app.tar.gz"
    and .debugSymbolsArchive.path == "okou-dsyms.tar.gz"' \
  "$artifact_dir/manifest.json" >/dev/null

extracted_dir="${tmp_dir}/extracted"
mkdir -p "$extracted_dir"
tar -xzf "$artifact_dir/okou-app.tar.gz" -C "$extracted_dir"
tar -xzf "$artifact_dir/okou-dsyms.tar.gz" -C "$extracted_dir"
test -x "$extracted_dir/Okou.app/Contents/MacOS/Okou"
test -L "$extracted_dir/Okou.app/Contents/Frameworks/Example.framework/Versions/Current"
diff -r "$symbols_dir" "$extracted_dir/dSYMs"

if bash "$build_script" \
  "$commit_sha" \
  "$desktop_version" \
  "$other_app_dir" \
  "${tmp_dir}/other-artifact" >/dev/null 2>&1; then
  echo "Expected an app directory that is not Okou.app to be rejected" >&2
  exit 1
fi

for archive in okou-app.tar.gz okou-dsyms.tar.gz; do
  tampered_dir="${tmp_dir}/tampered-$archive"
  cp -a "$artifact_dir" "$tampered_dir"
  printf 'tampered\n' >> "$tampered_dir/$archive"
  if bash "$verify_script" "$tampered_dir" "$commit_sha" "$desktop_version" >/dev/null 2>&1; then
    echo "Expected a tampered Desktop archive to fail: $archive" >&2
    exit 1
  fi

  missing_dir="${tmp_dir}/missing-$archive"
  cp -a "$artifact_dir" "$missing_dir"
  rm -f "$missing_dir/$archive"
  if bash "$verify_script" "$missing_dir" "$commit_sha" "$desktop_version" >/dev/null 2>&1; then
    echo "Expected a missing Desktop archive to fail: $archive" >&2
    exit 1
  fi
done

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
cp "$artifact_dir/okou-dsyms.tar.gz" "$unsafe_dir/"
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

# Framework links remain supported, but symbol links must fail before extraction.
ln -s /tmp "$symbols_dir/Okou.app.dSYM/escape"
if bash "$build_script" "$commit_sha" "$desktop_version" "$okou_app_dir" \
  "$tmp_dir/linked-symbols" >/dev/null 2>&1; then
  echo "Expected linked symbols to fail before publication" >&2
  exit 1
fi

echo "okou Desktop artifact tests passed"
