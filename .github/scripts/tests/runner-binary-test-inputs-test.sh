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

command -v cargo >/dev/null || fail "Cargo is required for the native build/test proof"
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
export RUSTC_WRAPPER="" RUSTC_WORKSPACE_WRAPPER=""

repo="${TMPDIR}/repo"
context="${TMPDIR}/context"
target_dir="${TMPDIR}/native-target"
mkdir -p "${repo}/.github/scripts" "${repo}/crates/runner/src/contract"
cp -a "${REPO_ROOT}/.github/scripts/runner-binary-build" "${repo}/.github/scripts/"

# Use an actual audited owner's native module layout, not a new name filter.
owner="${REPO_ROOT}/crates/runner-host/src/gc/workspaces"
if [ -f "${owner}/tests.rs" ] && [ ! -e "${owner}/tests/mod.rs" ]; then
  test_source="crates/runner/src/contract/tests.rs"
elif [ -f "${owner}/tests/mod.rs" ] && [ ! -e "${owner}/tests.rs" ]; then
  test_source="crates/runner/src/contract/tests/mod.rs"
else
  fail "the audited owner must have one native tests module"
fi
mkdir -p "$(dirname "${repo}/${test_source}")"
cat > "${repo}/crates/Cargo.toml" <<'TOML'
[workspace]
resolver = "2"
members = ["runner"]
TOML
cat > "${repo}/crates/runner/Cargo.toml" <<'TOML'
[package]
name = "runner"
version = "0.1.0"
edition = "2021"
TOML
cat > "${repo}/crates/runner/src/main.rs" <<'RUST'
mod contract;
fn main() {
    println!("{}", contract::value());
}
RUST
cat > "${repo}/crates/runner/src/contract.rs" <<'RUST'
pub fn value() -> u32 { 42 }
#[cfg(test)]
mod tests;
RUST
cat > "${repo}/${test_source}" <<'RUST'
#[test]
fn production_contract_is_verified() {
    assert_eq!(super::value(), 42);
}
RUST
cargo generate-lockfile --offline --manifest-path "${repo}/crates/Cargo.toml"
git -C "$repo" init -q
git -C "$repo" config maintenance.auto false
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test

commit_fixture() {
  git -C "$repo" add --all
  git -C "$repo" commit -qm "$1"
}

digest_value() {
  GITHUB_OUTPUT="" GUEST_CLI_PATH="" GUEST_CLI_MANIFEST_PATH="" \
    RUNNER_BINARY_GIT_REVISION=HEAD \
    "${repo}/.github/scripts/runner-binary-build/digest.sh" "$1" \
    | sed -n 's/^binary-input-digest=//p'
}

materialize() {
  GITHUB_OUTPUT="" GUEST_CLI_PATH="" GUEST_CLI_MANIFEST_PATH="" \
    TARGET_TRIPLE=x86_64-unknown-linux-musl RUNNER_BINARY_GIT_REVISION=HEAD \
    RUNNER_BINARY_CONTEXT_ROOT="$context" RUNNER_TEMP="$TMPDIR" \
    CARGO_TARGET_DIR="$target_dir" \
    "${repo}/.github/scripts/runner-binary-build/build.sh" materialize >/dev/null
  "${context}/.github/scripts/runner-binary-build/context.sh" validate-workspace "$context"
}

build_native() {
  # Fresh compiler output at the same source path; do not reuse Cargo artifacts.
  cargo clean --manifest-path "${context}/crates/Cargo.toml" --target-dir "$target_dir"
  cargo build --locked --offline --release \
    --manifest-path "${context}/crates/Cargo.toml" --target-dir "$target_dir"
}

commit_fixture baseline
arm_before=$(digest_value aarch64-unknown-linux-musl)
x86_before=$(digest_value x86_64-unknown-linux-musl)
materialize
build_native
[ "$("${target_dir}/release/runner")" = 42 ] || fail "production context must execute"
cp "${target_dir}/release/runner" "${TMPDIR}/baseline-runner"

cat >> "${repo}/${test_source}" <<'RUST'
#[test]
fn test_only_edit_is_selected() {
    assert_eq!(super::value(), 42);
}
RUST
commit_fixture test-only-edit
arm_after=$(digest_value aarch64-unknown-linux-musl)
x86_after=$(digest_value x86_64-unknown-linux-musl)
printf 'test-only digests: arm=%s/%s x86=%s/%s\n' \
  "$arm_before" "$arm_after" "$x86_before" "$x86_after"
[ "$arm_after" = "$arm_before" ] || fail "test-only edits must preserve the arm64 complete-binary key"
[ "$x86_after" = "$x86_before" ] || fail "test-only edits must preserve the x86_64 complete-binary key"
materialize
[ ! -e "${context}/${test_source}" ] || fail "the production context must omit the test-only module"
build_native
cmp "${TMPDIR}/baseline-runner" "${target_dir}/release/runner" \
  || fail "fresh native production bytes must stay identical"

# Independent verification consumes full source, not the binary context.
cargo test --locked --offline --manifest-path "${repo}/crates/Cargo.toml" \
  --target-dir "${TMPDIR}/test-target" -- --list > "${TMPDIR}/selected-tests.log"
grep -q '^contract::tests::production_contract_is_verified: test$' "${TMPDIR}/selected-tests.log" \
  || fail "the original owner test must still be selected"
grep -q '^contract::tests::test_only_edit_is_selected: test$' "${TMPDIR}/selected-tests.log" \
  || fail "the edited owner test must still be selected"
cargo test --locked --offline --manifest-path "${repo}/crates/Cargo.toml" \
  --target-dir "${TMPDIR}/test-target" -- --test-threads=1 > "${TMPDIR}/executed-tests.log"
grep -q '^test contract::tests::test_only_edit_is_selected .* ok$' "${TMPDIR}/executed-tests.log" \
  || fail "the edited owner test must actually execute"
grep -q '2 passed; 0 failed;' "${TMPDIR}/executed-tests.log" \
  || fail "all independently selected tests must pass"

cat > "${repo}/crates/runner/src/contract.rs" <<'RUST'
pub fn value() -> u32 { 43 }
#[cfg(test)]
mod tests;
RUST
commit_fixture production-edit
[ "$(digest_value aarch64-unknown-linux-musl)" != "$arm_after" ] \
  || fail "production Rust must rotate the arm64 key"
[ "$(digest_value x86_64-unknown-linux-musl)" != "$x86_after" ] \
  || fail "production Rust must rotate the x86_64 key"
materialize
build_native
[ "$("${target_dir}/release/runner")" = 43 ] || fail "production changes must reach the actual compiled context"

# A future unaudited test-named file is conservatively included.
mkdir -p "${repo}/crates/runner/src/unreviewed"
printf '#[test]\nfn unaudited() {}\n' > "${repo}/crates/runner/src/unreviewed/tests.rs"
commit_fixture unaudited-file
arm_unknown=$(digest_value aarch64-unknown-linux-musl)
x86_unknown=$(digest_value x86_64-unknown-linux-musl)
printf '// further unaudited input\n' >> "${repo}/crates/runner/src/unreviewed/tests.rs"
commit_fixture unaudited-file-edit
[ "$(digest_value aarch64-unknown-linux-musl)" != "$arm_unknown" ] \
  || fail "unknown test-named files must remain arm64 inputs"
[ "$(digest_value x86_64-unknown-linux-musl)" != "$x86_unknown" ] \
  || fail "unknown test-named files must remain x86_64 inputs"

arm_guarded=$(digest_value aarch64-unknown-linux-musl)
x86_guarded=$(digest_value x86_64-unknown-linux-musl)
cat > "${repo}/crates/runner/src/contract.rs" <<'RUST'
pub fn value() -> u32 { 43 }
mod tests;
RUST
commit_fixture introduced-production-reader
[ "$(digest_value aarch64-unknown-linux-musl)" != "$arm_guarded" ] \
  || fail "a new production reader must rotate the arm64 key"
[ "$(digest_value x86_64-unknown-linux-musl)" != "$x86_guarded" ] \
  || fail "a new production reader must rotate the x86_64 key"
materialize
if cargo build --locked --offline --release \
  --manifest-path "${context}/crates/Cargo.toml" --target-dir "$target_dir" \
  > "${TMPDIR}/production-reader.log" 2>&1; then
  fail "a required excluded source must not silently produce a binary"
fi
grep -q "file not found for module \`tests\`" "${TMPDIR}/production-reader.log" \
  || fail "the changed production reader must fail at the actual missing source"

echo "PASS: audited test layout preserves both keys/native bytes and independent test execution"
