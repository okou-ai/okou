#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
fixture="$root/repo"
mkdir -p "$fixture/.github/scripts/release" "$fixture/.github/rollback-floors" "$root/bin"
cp "$repo_root/.github/scripts/release/verify-registry-publisher-cutover.sh" \
  "$fixture/.github/scripts/release/"
git init -q -b main "$fixture"
git -C "$fixture" config user.name "Registry fixture"
git -C "$fixture" config user.email "registry-fixture@example.test"
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m "legacy reader"
old_commit=$(git -C "$fixture" rev-parse HEAD)
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m "independent reader"
reader_commit=$(git -C "$fixture" rev-parse HEAD)
printf '%s\n' "$reader_commit" >"$fixture/.github/rollback-floors/registry-archive-reader"
git -C "$fixture" add .
git -C "$fixture" -c commit.gpgsign=false commit -q -m "reader rollback floor"
git -C "$fixture" update-ref refs/remotes/origin/main HEAD

cat >"$root/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
commit=$MOCK_READER_COMMIT
if [[ "${!#}" == "${MOCK_OLD_ORIGIN:-}/api/build-info" ]]; then
  commit=$MOCK_OLD_COMMIT
fi
printf '{"commitSha":"%s"}\n' "$commit"
SH
chmod +x "$root/bin/curl"

run_gate() {
  env PATH="$root/bin:$PATH" MOCK_READER_COMMIT="$reader_commit" \
    MOCK_OLD_COMMIT="$old_commit" MOCK_OLD_ORIGIN="${1:-}" \
    bash "$fixture/.github/scripts/release/verify-registry-publisher-cutover.sh"
}

run_gate >"$root/success"
for origin in https://api.vm0.ai https://api.okou.ai; do
  if run_gate "$origin" >"$root/failed.out" 2>"$root/failed.err"; then
    echo "FAIL: publication accepted an old reader on $origin" >&2
    exit 1
  fi
  grep -F "${origin} does not serve the independent Registry reader" "$root/failed.err" >/dev/null
done
echo "PASS publication accepts compatible readers and rejects an old reader on either API domain"
