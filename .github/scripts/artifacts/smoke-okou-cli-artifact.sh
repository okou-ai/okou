#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <package.tgz>" >&2
  exit 1
fi

package_path="$1"
if [[ ! -f "$package_path" ]]; then
  echo "CLI package does not exist: $package_path" >&2
  exit 1
fi
package_path="$(cd "$(dirname "$package_path")" && pwd -P)/$(basename "$package_path")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

readonly npm_advisory_retirement_notice="npm notice This endpoint is being retired. Use the bulk advisory endpoint instead. See the following docs for more info: https://api-docs.npmjs.com/#tag/Audit"

node_path="$(command -v node)"
npx_path="$(command -v npx)"
clean_bin="${tmp_dir}/bin"
mkdir -p "$clean_bin"
ln -s "$node_path" "$clean_bin/node"
clean_path="${clean_bin}:/usr/bin:/bin"

run_cli() {
  local entrypoint="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  shift 3
  PATH="$clean_path" \
    npm_config_audit=false \
    npm_config_cache="$tmp_dir/npm-cache" \
    "$node_path" "$npx_path" \
    --yes --package="$package_path" "$entrypoint" "$@" \
    >"$stdout_file" 2>"$stderr_file"
}

assert_clean_success() {
  local entrypoint="$1"
  local output_name="$2"
  local stdout_file="$tmp_dir/${output_name}.stdout"
  local stderr_file="$tmp_dir/${output_name}.stderr"
  local unexpected_stderr_file="$tmp_dir/${output_name}.unexpected-stderr"
  shift 2
  if ! run_cli \
    "$entrypoint" \
    "$stdout_file" \
    "$stderr_file" \
    "$@"; then
    cat "$stderr_file" >&2
    echo "CLI smoke failed: $entrypoint $*" >&2
    exit 1
  fi
  awk -v ignored_notice="$npm_advisory_retirement_notice" \
    '$0 != ignored_notice' \
    "$stderr_file" >"$unexpected_stderr_file"
  if [[ -s "$unexpected_stderr_file" ]]; then
    cat "$unexpected_stderr_file" >&2
    echo "CLI smoke emitted unexpected stderr: $entrypoint $*" >&2
    exit 1
  fi
}

assert_clean_success \
  node \
  image-resize \
  "$script_dir/smoke-okou-cli-image-resize.mjs"
grep -Fxq \
  "Smoke-tested packaged Pi image resize worker and fallback" \
  "$tmp_dir/image-resize.stdout"
cat "$tmp_dir/image-resize.stdout"

assert_clean_success okou okou-help --help
grep -Fq "Usage: okou" "$tmp_dir/okou-help.stdout"
grep -Fq "Okou CLI" "$tmp_dir/okou-help.stdout"

assert_clean_success okou okou-version --version
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' "$tmp_dir/okou-version.stdout"

NODE_OPTIONS="--disable-warning=ExperimentalWarning" \
  assert_clean_success okou okou-agent-loop-help __agent-loop --help
grep -Fq "Internal sandbox Pi agent loop" "$tmp_dir/okou-agent-loop-help.stdout"

okou_error_status=0
run_cli \
  okou \
  "$tmp_dir/okou-error.stdout" \
  "$tmp_dir/okou-error.stderr" \
  __unsupported-command || okou_error_status=$?
if ((okou_error_status == 0)); then
  echo "Unsupported CLI command unexpectedly succeeded" >&2
  exit 1
fi

echo "Smoke-tested the canonical okou CLI"
