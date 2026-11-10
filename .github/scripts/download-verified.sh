#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 <url> <sha256> <destination>" >&2
  exit 1
fi

url="$1"
expected_sha256="$2"
destination="$3"
max_attempts="${OKOU_DOWNLOAD_VERIFIED_MAX_ATTEMPTS:-3}"
retry_delay_seconds="${OKOU_DOWNLOAD_VERIFIED_RETRY_DELAY_SECONDS:-2}"

if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Expected SHA-256 must contain exactly 64 lowercase hexadecimal characters" >&2
  exit 1
fi
if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "OKOU_DOWNLOAD_VERIFIED_MAX_ATTEMPTS must be a positive integer" >&2
  exit 1
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "OKOU_DOWNLOAD_VERIFIED_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 1
fi

destination_dir="$(dirname -- "$destination")"
if [[ ! -d "$destination_dir" ]]; then
  echo "Verified download destination directory does not exist: $destination_dir" >&2
  exit 1
fi

temporary="$(mktemp "${destination}.partial.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  if curl \
    --fail \
    --show-error \
    --silent \
    --location \
    --connect-timeout 10 \
    --max-time 30 \
    --output "$temporary" \
    -- "$url"; then
    actual_sha256="$(sha256sum "$temporary" | cut -d ' ' -f 1)"
    if [[ "$actual_sha256" == "$expected_sha256" ]]; then
      mv -- "$temporary" "$destination"
      echo "Downloaded and verified $url"
      exit 0
    fi

    echo \
      "Checksum mismatch for $url on attempt $attempt/$max_attempts: expected $expected_sha256, got $actual_sha256" \
      >&2
  else
    curl_status="$?"
    echo \
      "Download transport failed for $url on attempt $attempt/$max_attempts (curl exit $curl_status)" \
      >&2
  fi

  if ((attempt < max_attempts)); then
    echo "Retrying verified download of $url" >&2
    sleep "$retry_delay_seconds"
  fi
done

echo \
  "Failed to download and verify $url after $max_attempts attempts; destination was not replaced: $destination" \
  >&2
exit 1
