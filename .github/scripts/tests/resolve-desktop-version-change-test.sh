#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-desktop-version-change.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

test_repo="${tmp_dir}/repo"
git init -q "$test_repo"
git -C "$test_repo" config user.email test@example.com
git -C "$test_repo" config user.name Test
mkdir -p "${test_repo}/turbo/apps/desktop"
printf '{"version":"1.2.3"}\n' > "${test_repo}/turbo/apps/desktop/package.json"
git -C "$test_repo" add turbo/apps/desktop/package.json
git -C "$test_repo" commit -qm initial
base_sha="$(git -C "$test_repo" rev-parse HEAD)"

printf 'unrelated\n' > "${test_repo}/README.md"
git -C "$test_repo" add README.md
git -C "$test_repo" commit -qm unrelated
unchanged_sha="$(git -C "$test_repo" rev-parse HEAD)"

unchanged="$(cd "$test_repo" && bash "$script" "$base_sha" "$unchanged_sha")"
jq -e '
  .changed == false and
  .previousVersion == "1.2.3" and
  .version == "1.2.3"
' <<< "$unchanged" >/dev/null

printf '{"version":"1.3.0"}\n' > "${test_repo}/turbo/apps/desktop/package.json"
git -C "$test_repo" add turbo/apps/desktop/package.json
git -C "$test_repo" commit -qm release
release_sha="$(git -C "$test_repo" rev-parse HEAD)"

changed="$(cd "$test_repo" && bash "$script" "$unchanged_sha" "$release_sha")"
jq -e '
  .changed == true and
  .previousVersion == "1.2.3" and
  .version == "1.3.0"
' <<< "$changed" >/dev/null

if (cd "$test_repo" && bash "$script" invalid "$release_sha") >/dev/null 2>&1; then
  echo "Expected an invalid base commit to fail" >&2
  exit 1
fi

mkdir -p "${test_repo}/desktop"
printf '1.3.0\n' > "${test_repo}/desktop/version.txt"
git -C "$test_repo" rm -q turbo/apps/desktop/package.json
git -C "$test_repo" add desktop/version.txt
git -C "$test_repo" commit -qm native
native_sha="$(git -C "$test_repo" rev-parse HEAD)"
migration="$(cd "$test_repo" && bash "$script" "$release_sha" "$native_sha")"
jq -e '.changed == false and .version == "1.3.0"' <<< "$migration" >/dev/null
printf '1.4.0\n' > "${test_repo}/desktop/version.txt"
git -C "$test_repo" add desktop/version.txt
git -C "$test_repo" commit -qm native-release
native_release_sha="$(git -C "$test_repo" rev-parse HEAD)"
native_release="$(cd "$test_repo" && bash "$script" "$native_sha" "$native_release_sha")"
jq -e '.changed == true and .previousVersion == "1.3.0" and .version == "1.4.0"' <<< "$native_release" >/dev/null

echo "resolve-desktop-version-change tests passed"
