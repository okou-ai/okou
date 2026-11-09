#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/download-verified.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "${tmp_dir}/bin"
cat > "${tmp_dir}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output=""
url=""
while (($# > 0)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --connect-timeout | --max-time)
      shift 2
      ;;
    --fail | --show-error | --silent | --location)
      shift
      ;;
    --)
      url="$2"
      shift 2
      ;;
    *)
      echo "Unexpected curl argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$output" || -z "$url" ]]; then
  echo "Mock curl did not receive an output and URL" >&2
  exit 2
fi

attempt="$(<"$MOCK_CURL_STATE")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" > "$MOCK_CURL_STATE"

case "$MOCK_CURL_MODE" in
  transport-then-success)
    if ((attempt == 1)); then
      echo "curl: (56) simulated transport failure" >&2
      exit 56
    fi
    cp "$MOCK_CURL_SOURCE" "$output"
    ;;
  success)
    cp "$MOCK_CURL_SOURCE" "$output"
    ;;
  corrupt-then-success)
    if ((attempt == 1)); then
      printf 'invalid release response\n' > "$output"
    else
      cp "$MOCK_CURL_SOURCE" "$output"
    fi
    ;;
  always-corrupt)
    printf 'invalid release response\n' > "$output"
    ;;
  *)
    echo "Unexpected mock curl mode: $MOCK_CURL_MODE" >&2
    exit 2
    ;;
esac
EOF
chmod +x "${tmp_dir}/bin/curl"

source_file="${tmp_dir}/release.tar.gz"
printf 'verified release bytes\n' > "$source_file"
expected_sha256="$(sha256sum "$source_file" | cut -d ' ' -f 1)"
url="https://github.com/example/tool/releases/download/v1.2.3/tool.tar.gz"

run_download() {
  local mode="$1"
  local state_file="$2"
  local destination="$3"
  local stderr_file="$4"

  MOCK_CURL_MODE="$mode" \
    MOCK_CURL_SOURCE="$source_file" \
    MOCK_CURL_STATE="$state_file" \
    OKOU_DOWNLOAD_VERIFIED_MAX_ATTEMPTS=3 \
    OKOU_DOWNLOAD_VERIFIED_RETRY_DELAY_SECONDS=0 \
    PATH="${tmp_dir}/bin:${PATH}" \
    bash "$script" "$url" "$expected_sha256" "$destination" \
      > /dev/null 2> "$stderr_file"
}

transport_state="${tmp_dir}/transport.state"
transport_destination="${tmp_dir}/transport.tar.gz"
printf '0\n' > "$transport_state"
run_download \
  transport-then-success \
  "$transport_state" \
  "$transport_destination" \
  "${tmp_dir}/transport.err"
cmp "$source_file" "$transport_destination"
[[ "$(<"$transport_state")" == "2" ]]
grep -Fq "$url" "${tmp_dir}/transport.err"
grep -Fq "curl exit 56" "${tmp_dir}/transport.err"

corrupt_state="${tmp_dir}/corrupt.state"
corrupt_destination="${tmp_dir}/corrupt.tar.gz"
printf '0\n' > "$corrupt_state"
run_download \
  corrupt-then-success \
  "$corrupt_state" \
  "$corrupt_destination" \
  "${tmp_dir}/corrupt.err"
cmp "$source_file" "$corrupt_destination"
[[ "$(<"$corrupt_state")" == "2" ]]
grep -Fq "Checksum mismatch for $url" "${tmp_dir}/corrupt.err"

failure_state="${tmp_dir}/failure.state"
failure_destination="${tmp_dir}/existing.tar.gz"
printf '0\n' > "$failure_state"
printf 'existing destination\n' > "$failure_destination"
if run_download \
  always-corrupt \
  "$failure_state" \
  "$failure_destination" \
  "${tmp_dir}/failure.err"; then
  echo "Expected repeated checksum mismatches to fail" >&2
  exit 1
fi
[[ "$(<"$failure_state")" == "3" ]]
grep -Fxq "existing destination" "$failure_destination"
grep -Fq "$url" "${tmp_dir}/failure.err"
grep -Fq "$expected_sha256" "${tmp_dir}/failure.err"
grep -Fq "after 3 attempts" "${tmp_dir}/failure.err"
if find "$tmp_dir" -maxdepth 1 -name 'existing.tar.gz.partial.*' -print -quit | grep -q .; then
  echo "Expected failed downloads to remove their partial file" >&2
  exit 1
fi

echo "download-verified tests passed"
