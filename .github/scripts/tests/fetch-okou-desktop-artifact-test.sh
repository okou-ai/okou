#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/artifacts/fetch-okou-desktop-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

source_dir="${tmp_dir}/source"
mkdir -p "$source_dir" "${tmp_dir}/bin"
printf 'okou archive\n' > "$source_dir/okou-app.tar.gz"
printf 'debug symbols\n' > "$source_dir/okou-dsyms.tar.gz"
printf '{"version":2,"okouArchive":{"path":"okou-app.tar.gz"},"debugSymbolsArchive":{"path":"okou-dsyms.tar.gz"}}\n' > "$source_dir/manifest.json"
printf '{"version":1}\n' > "$source_dir/ready.json"

cat > "${tmp_dir}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >> "$MOCK_AWS_LOG"
printf '\n' >> "$MOCK_AWS_LOG"

source_uri="$3"
destination="$4"
filename="${source_uri##*/}"

if [[ -n "${MOCK_AWS_TRANSIENT_FAILURES:-}" ]]; then
  failure_count="$(<"$MOCK_AWS_STATE_FILE")"
  if (( failure_count < MOCK_AWS_TRANSIENT_FAILURES )); then
    printf '%s\n' "$((failure_count + 1))" > "$MOCK_AWS_STATE_FILE"
    echo "download failed: IncompleteRead" >&2
    exit 1
  fi
fi

if [[ "$filename" == "okou-app.tar.gz" && "${MOCK_ARCHIVE_PRESENT:-true}" != "true" ]]; then
  echo "fatal error: An error occurred (404) when calling HeadObject" >&2
  exit 1
fi
if [[ "$filename" == "okou-dsyms.tar.gz" && "${MOCK_SYMBOLS_PRESENT:-true}" != "true" ]]; then
  echo "fatal error: An error occurred (404) when calling HeadObject" >&2
  exit 1
fi

cp "$MOCK_SOURCE_DIR/$filename" "$destination"
EOF
chmod +x "${tmp_dir}/bin/aws"

export PATH="${tmp_dir}/bin:${PATH}"
export MOCK_SOURCE_DIR="$source_dir"
export OKOU_DESKTOP_ARTIFACT_FETCH_RETRY_DELAY_SECONDS=0
r2_endpoint="https://account.r2.cloudflarestorage.com"
artifact_uri="s3://vm0-static-prod/okou-desktop/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

destination="${tmp_dir}/destination"
mkdir -p "$destination"
MOCK_AWS_LOG="${tmp_dir}/fetch.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$destination"
cmp "$source_dir/okou-app.tar.gz" "$destination/okou-app.tar.gz"
cmp "$source_dir/okou-dsyms.tar.gz" "$destination/okou-dsyms.tar.gz"
cmp "$source_dir/manifest.json" "$destination/manifest.json"
cmp "$source_dir/ready.json" "$destination/ready.json"
if (( "$(grep -c 's3 cp' "${tmp_dir}/fetch.log")" != 4 )); then
  echo "Expected exactly four Desktop artifact object copies" >&2
  exit 1
fi

missing_symbols_destination="${tmp_dir}/missing-symbols"
mkdir -p "$missing_symbols_destination"
if MOCK_SYMBOLS_PRESENT=false \
  MOCK_AWS_LOG="${tmp_dir}/missing-symbols.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$missing_symbols_destination" \
    >/dev/null 2>&1; then
  echo "Expected missing Desktop symbols to fail" >&2
  exit 1
fi
test ! -e "$missing_symbols_destination/okou-dsyms.tar.gz"
if (( "$(grep -c 's3 cp' "${tmp_dir}/missing-symbols.log")" != 4 )); then
  echo "Expected missing symbols to fail without retrying" >&2
  exit 1
fi
if grep -q -- '--recursive' "${tmp_dir}/fetch.log"; then
  echo "Desktop artifact fetch must use explicit immutable objects" >&2
  exit 1
fi

missing_destination="${tmp_dir}/missing"
mkdir -p "$missing_destination"
if MOCK_ARCHIVE_PRESENT=false \
  MOCK_AWS_LOG="${tmp_dir}/missing.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$missing_destination" \
    >/dev/null 2>&1; then
  echo "Expected a missing Desktop archive to fail" >&2
  exit 1
fi
if (( "$(grep -c 's3 cp' "${tmp_dir}/missing.log")" != 3 )); then
  echo "Expected a missing Desktop archive to fail without retrying" >&2
  exit 1
fi

retry_destination="${tmp_dir}/retry"
mkdir -p "$retry_destination"
printf '0\n' > "${tmp_dir}/retry-state"
# App's suite covers shared transient recovery and the default budget. This
# caller must pass its independently configured Desktop budget to the helper.
if OKOU_DESKTOP_ARTIFACT_FETCH_ATTEMPTS=2 \
  MOCK_AWS_TRANSIENT_FAILURES=99 \
  MOCK_AWS_STATE_FILE="${tmp_dir}/retry-state" \
  MOCK_AWS_LOG="${tmp_dir}/retry.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$retry_destination" \
    >/dev/null 2>&1; then
  echo "Expected an exhausted Desktop fetch to fail" >&2
  exit 1
fi
test ! -e "$retry_destination/okou-app.tar.gz"
if (( "$(grep -c 's3 cp' "${tmp_dir}/retry.log")" != 2 )); then
  echo "Expected the configured Desktop budget of exactly two attempts" >&2
  exit 1
fi

undeclared_source_dir="${tmp_dir}/undeclared-source"
undeclared_destination="${tmp_dir}/undeclared-destination"
mkdir -p "$undeclared_source_dir" "$undeclared_destination"
cp "$source_dir/okou-app.tar.gz" "$source_dir/ready.json" "$undeclared_source_dir/"
printf '{"version":1}\n' > "$undeclared_source_dir/manifest.json"
if MOCK_SOURCE_DIR="$undeclared_source_dir" \
  MOCK_AWS_LOG="${tmp_dir}/undeclared.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$undeclared_destination" \
    >/dev/null 2>&1; then
  echo "Expected a manifest without an Okou archive to fail" >&2
  exit 1
fi
test ! -e "$undeclared_destination/okou-app.tar.gz"

if MOCK_AWS_LOG="${tmp_dir}/absent.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "${tmp_dir}/absent" \
    >/dev/null 2>&1; then
  echo "Expected a missing destination directory to fail" >&2
  exit 1
fi

echo "fetch-okou-desktop-artifact tests passed"
