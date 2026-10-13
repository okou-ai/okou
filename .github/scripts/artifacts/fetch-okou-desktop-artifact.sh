#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 <r2-endpoint> <artifact-uri> <destination-directory>" >&2
  exit 1
fi

r2_endpoint="$1"
artifact_uri="${2%/}"
destination="$3"
max_attempts="${OKOU_DESKTOP_ARTIFACT_FETCH_ATTEMPTS:-3}"
retry_delay_seconds="${OKOU_DESKTOP_ARTIFACT_FETCH_RETRY_DELAY_SECONDS:-5}"

if [[ ! -d "$destination" ]]; then
  echo "Destination directory must exist: $destination" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=r2-copy.sh
. "$script_dir/r2-copy.sh"

error_log="$(mktemp)"
trap 'rm -f "$error_log"' EXIT

for filename in manifest.json ready.json; do
  if ! artifact_r2_copy_with_retry \
    "$artifact_uri/$filename" \
    "$destination/$filename" \
    "$r2_endpoint" "$error_log" "$max_attempts" "$retry_delay_seconds"; then
    echo "Desktop artifact download failed: $artifact_uri/$filename" >&2
    exit 1
  fi
done

okou_archive_path="$(jq -r '.okouArchive.path // ""' "$destination/manifest.json")"
if [[ "$okou_archive_path" != "okou-app.tar.gz" ]]; then
  echo "Desktop artifact manifest contains an unexpected Okou archive path: ${okou_archive_path:-<missing>}" >&2
  exit 1
fi
if ! artifact_r2_copy_with_retry \
  "$artifact_uri/$okou_archive_path" \
  "$destination/$okou_archive_path" \
  "$r2_endpoint" "$error_log" "$max_attempts" "$retry_delay_seconds"; then
  echo "Desktop artifact download failed: $artifact_uri/$okou_archive_path" >&2
  exit 1
fi
