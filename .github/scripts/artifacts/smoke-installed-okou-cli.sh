#!/usr/bin/env bash
set -euo pipefail

# Called once inside the isolated npx environment by smoke-okou-cli-artifact.sh.
if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <smoke-temp-dir>" >&2
  exit 1
fi
tmp_dir="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
okou_executable="$(command -v okou)"
package_dir="$(dirname "$(realpath "$okou_executable")")"
case "$package_dir" in
  "$tmp_dir/npm-cache/_npx/"*/node_modules/@okouai/cli) ;;
  *) echo "CLI smoke resolved an executable outside its isolated package" >&2; exit 1 ;;
esac

assert_clean_success() {
  local entrypoint="$1" output_name="$2"
  shift 2
  if ! "$entrypoint" "$@" >"$tmp_dir/$output_name.stdout" 2>"$tmp_dir/$output_name.stderr"; then
    cat "$tmp_dir/$output_name.stderr" >&2
    echo "CLI smoke failed: $entrypoint $*" >&2
    exit 1
  fi
  if [[ -s "$tmp_dir/$output_name.stderr" ]]; then
    cat "$tmp_dir/$output_name.stderr" >&2
    echo "CLI smoke emitted unexpected stderr: $entrypoint $*" >&2
    exit 1
  fi
}

assert_clean_success okou okou-help --help
grep -Fq "Usage: okou" "$tmp_dir/okou-help.stdout"
grep -Fq "Okou CLI" "$tmp_dir/okou-help.stdout"
assert_clean_success okou okou-version --version
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' "$tmp_dir/okou-version.stdout"
NODE_OPTIONS="--disable-warning=ExperimentalWarning" \
  assert_clean_success okou okou-agent-loop-help __agent-loop --help
grep -Fq "Internal sandbox Pi agent loop" "$tmp_dir/okou-agent-loop-help.stdout"

if okou __unsupported-command >"$tmp_dir/okou-error.stdout" 2>"$tmp_dir/okou-error.stderr"; then
  echo "Unsupported CLI command unexpectedly succeeded" >&2
  exit 1
fi

# The fallback probe mutates its disposable installed copy, so run it last.
assert_clean_success node image-resize "$script_dir/smoke-okou-cli-image-resize.mjs" "$package_dir"
grep -Fxq "Smoke-tested packaged Pi image resize worker and fallback" "$tmp_dir/image-resize.stdout"
cat "$tmp_dir/image-resize.stdout"
echo "Smoke-tested the canonical okou CLI"
