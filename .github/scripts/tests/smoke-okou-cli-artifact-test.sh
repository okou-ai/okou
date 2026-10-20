#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
smoke_script="${repo_root}/.github/scripts/artifacts/smoke-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fixture_bin="${tmp_dir}/bin"
package_path="${tmp_dir}/package.tgz"
fixture_package="${tmp_dir}/fixture/package"
mkdir -p "$fixture_bin" "$fixture_package"
cat >"${fixture_bin}/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == *smoke-okou-cli-image-resize.mjs ]]; then
  echo "Smoke-tested packaged Pi image resize worker and fallback"
  exit 0
fi
exec "$@"
EOF

cat >"${fixture_bin}/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --* ]]; do
  shift
done

if [[ "${npm_config_audit:-}" != "false" ]]; then
  echo "npm audit was not disabled" >&2
  exit 1
fi

echo "npm notice This endpoint is being retired. Use the bulk advisory endpoint instead. See the following docs for more info: https://api-docs.npmjs.com/#tag/Audit" >&2
if [[ "${EMIT_INSTALL_STDERR:-false}" == true ]]; then
  echo 'unexpected installation stderr' >&2
fi
installed_root="$npm_config_cache/_npx/fixture/node_modules"
mkdir -p "$installed_root/@okouai/cli" "$installed_root/.bin"
cp "$SMOKE_FIXTURE_CLI" "$installed_root/@okouai/cli/okou.js"
chmod +x "$installed_root/@okouai/cli/okou.js"
ln -s ../@okouai/cli/okou.js "$installed_root/.bin/okou"
PATH="$installed_root/.bin:$PATH" exec "$@"
EOF

cat >"${fixture_package}/okou.js" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${EMIT_UNEXPECTED_STDERR:-false}" == true && "${1:-}" == --version ]]; then
  echo "unexpected CLI stderr" >&2
fi

case "$*" in
  --help)
    printf 'Usage: okou\nOkou CLI\n'
    ;;
  --version)
    echo "1.2.3"
    ;;
  "__agent-loop --help")
    echo "Internal sandbox Pi agent loop"
    ;;
  __unsupported-command)
    if [[ "${ACCEPT_UNSUPPORTED_COMMAND:-false}" == true ]]; then exit 0; else exit 1; fi
    ;;
  *)
    echo "unexpected invocation: $*" >&2
    exit 1
    ;;
esac
EOF

chmod +x "${fixture_bin}/node" "${fixture_bin}/npx"
tar -czf "$package_path" -C "${tmp_dir}/fixture" package
export SMOKE_FIXTURE_CLI="${fixture_package}/okou.js"

output="$({
  PATH="${fixture_bin}:${PATH}" bash "$smoke_script" "$package_path"
} 2>&1)"
grep -Fq "Smoke-tested the canonical okou CLI" <<<"$output"

failure_output="${tmp_dir}/failure-output.txt"
if PATH="${fixture_bin}:${PATH}" \
  EMIT_UNEXPECTED_STDERR=true \
  bash "$smoke_script" "$package_path" >"$failure_output" 2>&1; then
  echo "Smoke test unexpectedly ignored non-npm stderr" >&2
  exit 1
fi
grep -Fxq "unexpected CLI stderr" "$failure_output"
grep -Fq "CLI smoke emitted unexpected stderr: okou --version" "$failure_output"

if PATH="${fixture_bin}:${PATH}" EMIT_INSTALL_STDERR=true \
  bash "$smoke_script" "$package_path" >"$failure_output" 2>&1; then
  echo "Smoke test unexpectedly ignored installation stderr" >&2
  exit 1
fi
grep -Fxq 'unexpected installation stderr' "$failure_output"

if PATH="${fixture_bin}:${PATH}" ACCEPT_UNSUPPORTED_COMMAND=true \
  bash "$smoke_script" "$package_path" >"$failure_output" 2>&1; then
  echo "Smoke test accepted an unsupported command" >&2
  exit 1
fi
grep -Fq 'Unsupported CLI command unexpectedly succeeded' "$failure_output"

echo "smoke-okou-cli-artifact tests passed"
