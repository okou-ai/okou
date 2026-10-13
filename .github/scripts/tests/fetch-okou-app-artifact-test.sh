#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/artifacts/fetch-okou-app-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

r2_endpoint="https://account.r2.cloudflarestorage.com"
artifact_uri="s3://vm0-static-prod/okou-app/abc123"

source_dist="${tmp_dir}/source"
mkdir -p "${source_dist}/assets"
printf '<!doctype html>\n' >"${source_dist}/index.html"
printf 'console.log("app");\n' >"${source_dist}/assets/app-123.js"
touch "${source_dist}/.gitkeep"
tar -czf "${tmp_dir}/dist.tar.gz" -C "$source_dist" .

mkdir -p "${tmp_dir}/bin"
cat >"${tmp_dir}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >>"$MOCK_AWS_LOG"
printf '\n' >>"$MOCK_AWS_LOG"

source_uri="$3"
destination="$4"

if [[ -n "${MOCK_AWS_TRANSIENT_FAILURES:-}" ]]; then
  failure_count="$(<"$MOCK_AWS_STATE_FILE")"
  if (( failure_count < MOCK_AWS_TRANSIENT_FAILURES )); then
    printf '%s\n' "$((failure_count + 1))" >"$MOCK_AWS_STATE_FILE"
    echo "download failed: ${source_uri} ('Connection broken:" \
      "IncompleteRead(0 bytes read, 4096 more expected)')" >&2
    exit 1
  fi
fi

case "$source_uri" in
  */dist.tar.gz)
    if [[ "${MOCK_AWS_ARCHIVE_PRESENT:-true}" != "true" ]]; then
      echo "fatal error: An error occurred (404) when calling the HeadObject" \
        "operation: Key \"${source_uri}\" does not exist" >&2
      exit 1
    fi
    cp "$MOCK_AWS_ARCHIVE_PATH" "$destination"
    ;;
  */manifest.json)
    printf '{"version":1,"files":[]}\n' >"$destination"
    ;;
  */ready.json)
    printf '{"version":1}\n' >"$destination"
    ;;
  *)
    echo "unexpected object copy: ${source_uri}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/bin/aws"

export PATH="${tmp_dir}/bin:${PATH}"
export MOCK_AWS_ARCHIVE_PATH="${tmp_dir}/dist.tar.gz"
export OKOU_ARTIFACT_FETCH_RETRY_DELAY_SECONDS=0

archive_destination="${tmp_dir}/archive-destination"
mkdir -p "$archive_destination"
MOCK_AWS_LOG="${tmp_dir}/archive.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$archive_destination" \
  >/dev/null
test -f "${archive_destination}/index.html"
test -f "${archive_destination}/assets/app-123.js"
test -f "${archive_destination}/.gitkeep"
test -f "${archive_destination}/manifest.json"
test -f "${archive_destination}/ready.json"
if grep -q -- '--recursive' "${tmp_dir}/archive.log"; then
  echo "expected only individual archive and metadata object copies" >&2
  exit 1
fi
if (( "$(grep -c 's3 cp' "${tmp_dir}/archive.log")" != 3 )); then
  echo "expected exactly three object copies for an archived artifact" >&2
  exit 1
fi

missing_archive_destination="${tmp_dir}/missing-archive-destination"
mkdir -p "$missing_archive_destination"
if MOCK_AWS_ARCHIVE_PRESENT=false \
  MOCK_AWS_LOG="${tmp_dir}/missing-archive.log" \
  bash "$script" \
    "$r2_endpoint" \
    "$artifact_uri" \
    "$missing_archive_destination" \
    >/dev/null 2>&1; then
  echo "expected an artifact without an archive to fail" >&2
  exit 1
fi
if (( "$(grep -c 's3 cp' "${tmp_dir}/missing-archive.log")" != 1 )); then
  echo "expected a missing archive to fail without retrying" >&2
  exit 1
fi
if grep -q -- '--recursive' "${tmp_dir}/missing-archive.log"; then
  echo "expected no per-file artifact fallback" >&2
  exit 1
fi

retry_destination="${tmp_dir}/retry-destination"
mkdir -p "$retry_destination"
printf '0\n' >"${tmp_dir}/retry-state"
MOCK_AWS_TRANSIENT_FAILURES=2 \
  MOCK_AWS_STATE_FILE="${tmp_dir}/retry-state" \
  MOCK_AWS_LOG="${tmp_dir}/retry.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$retry_destination" \
  >/dev/null 2>&1
test -f "${retry_destination}/index.html"
test -f "${retry_destination}/manifest.json"

exhausted_destination="${tmp_dir}/exhausted-destination"
mkdir -p "$exhausted_destination"
printf '0\n' >"${tmp_dir}/exhausted-state"
if MOCK_AWS_TRANSIENT_FAILURES=99 \
  MOCK_AWS_STATE_FILE="${tmp_dir}/exhausted-state" \
  MOCK_AWS_LOG="${tmp_dir}/exhausted.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "$exhausted_destination" \
  >/dev/null 2>&1; then
  echo "expected a permanently broken transfer to fail" >&2
  exit 1
fi
if (( "$(grep -c 's3 cp' "${tmp_dir}/exhausted.log")" != 3 )); then
  echo "expected exactly three attempts before giving up" >&2
  exit 1
fi

if MOCK_AWS_LOG="${tmp_dir}/missing.log" \
  bash "$script" "$r2_endpoint" "$artifact_uri" "${tmp_dir}/absent" \
  >/dev/null 2>&1; then
  echo "expected a missing destination directory to be rejected" >&2
  exit 1
fi

if bash "$script" "$r2_endpoint" "$artifact_uri" >/dev/null 2>&1; then
  echo "expected a missing argument to be rejected" >&2
  exit 1
fi

echo "fetch-okou-app-artifact tests passed"
