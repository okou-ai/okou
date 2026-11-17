#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

commit_all() {
  local repo=$1 message=$2
  git -C "$repo" add --all
  git -C "$repo" commit -qm "$message"
}

commit_path() {
  local repo=$1 path=$2 message=$3
  git -C "$repo" add -- "$path"
  git -C "$repo" commit -qm "$message"
}

assert_workspace_change_detected() {
  local repo=$1 path=$2 label=$3 base output
  base=$(git -C "$repo" rev-parse HEAD)
  printf '\n# %s\n' "$label" >> "${repo}/${path}"
  commit_path "$repo" "$path" "$label"

  if ! output=$(
    cd "$repo"
    ./scripts/crate-changed.sh member-two "$base" 2>&1
  ); then
    fail "${path} must affect every workspace crate"
  fi
  grep -qF "Workspace-level file changed, all crates affected" <<<"$output" \
    || fail "${path} must be classified as a workspace-level input"
}

repo="${TMPDIR}/repo"
mkdir -p \
  "${repo}/scripts" \
  "${repo}/crates/.cargo" \
  "${repo}/crates/member-one/src" \
  "${repo}/crates/member-two/src"
cp "${REPO_ROOT}/scripts/crate-changed.sh" "${repo}/scripts/crate-changed.sh"
cp "${REPO_ROOT}/rust-toolchain.toml" "${repo}/rust-toolchain.toml"
chmod +x "${repo}/scripts/crate-changed.sh"

cat > "${repo}/crates/Cargo.toml" <<'TOML'
[workspace]
resolver = "2"
members = ["member-one", "member-two"]
TOML
cat > "${repo}/crates/member-one/Cargo.toml" <<'TOML'
[package]
name = "member-one"
version = "0.1.0"
edition = "2021"
TOML
cat > "${repo}/crates/member-two/Cargo.toml" <<'TOML'
[package]
name = "member-two"
version = "0.1.0"
edition = "2021"
TOML
cat > "${repo}/crates/.cargo/config.toml" <<'TOML'
[build]
target-dir = "target"
TOML
printf 'max_width = 100\n' > "${repo}/crates/rustfmt.toml"
printf 'pub fn one() {}\n' > "${repo}/crates/member-one/src/lib.rs"
printf 'pub fn two() {}\n' > "${repo}/crates/member-two/src/lib.rs"
printf 'unrelated\n' > "${repo}/README.md"
cargo generate-lockfile --offline --manifest-path "${repo}/crates/Cargo.toml"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
commit_all "$repo" baseline

assert_workspace_change_detected \
  "$repo" "crates/rustfmt.toml" "rustfmt-config-change"
assert_workspace_change_detected \
  "$repo" "crates/.cargo/config.toml" "cargo-config-change"
assert_workspace_change_detected \
  "$repo" "rust-toolchain.toml" "toolchain-change"

base=$(git -C "$repo" rev-parse HEAD)
printf 'changed\n' >> "${repo}/README.md"
commit_path "$repo" README.md unrelated-change
set +e
(
  cd "$repo"
  ./scripts/crate-changed.sh member-two "$base"
) >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "unrelated files must not affect workspace crates"

echo "crate-changed-test: ok"
