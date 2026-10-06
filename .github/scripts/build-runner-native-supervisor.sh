#!/usr/bin/env bash
# Compile real production-library integration consumers in the EXISTING producer.
# No test execution/emulation, Runner cache publication or production release.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${SOURCE_SHA:?missing optimized supervisor source SHA}" "${TARGET_TRIPLE:?missing optimized supervisor target}"
. .github/scripts/runner-image-target.sh
runner_image_validate_target "$TARGET_TRIPLE"
[[ ${RUNNER_RELEASE_TOOLCHAIN_IMAGE:-} == ghcr.io/okou-ai/vm0-toolchain-rust:20260825 ]] || exit 1
[[ -f crates/target/f5-release-input/context.json ]] || exit 1
export CARGO_TARGET_DIR="$PWD/crates/target"
# Ordinary optimized integration tests link the unmodified production library;
# no cfg(test) supervisor replacement, compiler override or native helper path.
for profile in ci release; do
  output="$CARGO_TARGET_DIR/f5-supervisor-$profile"
  [[ ! -e "$output" && ! -L "$output" ]] || exit 1
  mkdir -m 700 "$output"
  compiler_source="$PWD"
  if [[ "$profile" == ci ]]; then
    # Runner ci compiles from its verified materialized production tree. The
    # immutable native ELF retains DWARF source paths, so tests must use that
    # same REAL source context, not strip or replace its sealed helper bytes.
    compiler_source=$(python3 -B .github/scripts/runner-native-supervisor.py prepare-ci "$output" \
      --profile "$profile" --target "$TARGET_TRIPLE" --source-sha "$SOURCE_SHA")
  fi
  (
    # Preserve Cargo configuration discovery, original output paths and profile.
    cd "$compiler_source/crates"
    CARGO_INCREMENTAL=0 cargo test --manifest-path Cargo.toml --locked --profile "$profile" \
      --target "$TARGET_TRIPLE" -j 1 -p kerberos-worker \
      --test process --test parent_death --test cleanup_unknown --no-run \
      --message-format=json-render-diagnostics > "$output/worker-compiler.json"
    CARGO_INCREMENTAL=0 cargo test --manifest-path Cargo.toml --locked --profile "$profile" \
      --target "$TARGET_TRIPLE" -j 1 -p rfb-client --test qemu_gssapi --no-run \
      --message-format=json-render-diagnostics > "$output/peer-compiler.json"
  )
  python3 -B .github/scripts/runner-native-supervisor.py finish "$output" \
    --profile "$profile" --target "$TARGET_TRIPLE" --source-sha "$SOURCE_SHA"
done
