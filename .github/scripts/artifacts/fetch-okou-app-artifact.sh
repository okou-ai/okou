#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <r2-endpoint> <artifact-uri> <destination-dir>" >&2
  exit 1
fi

r2_endpoint="$1"
artifact_uri="${2%/}"
destination="$3"
archive_uri="${artifact_uri}/dist.tar.gz"
max_attempts="${OKOU_ARTIFACT_FETCH_ATTEMPTS:-3}"
retry_delay_seconds="${OKOU_ARTIFACT_FETCH_RETRY_DELAY_SECONDS:-5}"

if [[ ! -d "$destination" ]]; then
  echo "destination directory must exist: $destination" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=r2-copy.sh
. "$script_dir/r2-copy.sh"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
archive_path="${work_dir}/dist.tar.gz"
error_log="${work_dir}/aws-error.log"

if ! artifact_r2_copy_with_retry \
  "$archive_uri" "$archive_path" "$r2_endpoint" \
  "$error_log" "$max_attempts" "$retry_delay_seconds"; then
  echo "app artifact archive download failed: $archive_uri" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$destination"

# manifest.json and ready.json stay outside the archive because ready.json is
# the marker that publishes the artifact and must be written last.
for metadata_file in manifest.json ready.json; do
  if ! artifact_r2_copy_with_retry \
    "${artifact_uri}/${metadata_file}" \
    "${destination}/${metadata_file}" \
    "$r2_endpoint" "$error_log" "$max_attempts" "$retry_delay_seconds"; then
    echo "app artifact metadata download failed: ${metadata_file}" >&2
    exit 1
  fi
done
