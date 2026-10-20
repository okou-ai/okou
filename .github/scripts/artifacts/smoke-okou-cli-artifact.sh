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
tmp_dir="$(cd "$tmp_dir" && pwd -P)"

readonly npm_advisory_retirement_notice="npm notice This endpoint is being retired. Use the bulk advisory endpoint instead. See the following docs for more info: https://api-docs.npmjs.com/#tag/Audit"

node_path="$(command -v node)"
npx_path="$(command -v npx)"
clean_bin="${tmp_dir}/bin"
mkdir -p "$clean_bin"
ln -s "$node_path" "$clean_bin/node"
clean_path="${clean_bin}:/usr/bin:/bin"

if ! PATH="$clean_path" \
  npm_config_audit=false \
  npm_config_cache="$tmp_dir/npm-cache" \
  "$node_path" "$npx_path" --yes --package="$package_path" \
  bash "$script_dir/smoke-installed-okou-cli.sh" "$tmp_dir" \
  >"$tmp_dir/smoke.stdout" 2>"$tmp_dir/smoke.stderr"; then
  cat "$tmp_dir/smoke.stderr" >&2
  exit 1
fi
awk -v ignored_notice="$npm_advisory_retirement_notice" \
  '$0 != ignored_notice' "$tmp_dir/smoke.stderr" >"$tmp_dir/unexpected-stderr"
if [[ -s "$tmp_dir/unexpected-stderr" ]]; then
  cat "$tmp_dir/unexpected-stderr" >&2
  echo "CLI smoke emitted unexpected installation stderr" >&2
  exit 1
fi
cat "$tmp_dir/smoke.stdout"
