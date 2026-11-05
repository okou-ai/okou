#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <r2-endpoint> <bucket> <assets-directory>" >&2
  exit 1
fi

OKOU_APP_R2_ENDPOINT="${1%/}"
OKOU_APP_R2_BUCKET="$2"
OKOU_APP_ASSETS_DIRECTORY="${3%/}"

if [[ ! -d "$OKOU_APP_ASSETS_DIRECTORY" ]]; then
  echo "app assets directory does not exist: $OKOU_APP_ASSETS_DIRECTORY" >&2
  exit 1
fi
if [[ -z "$(find "$OKOU_APP_ASSETS_DIRECTORY" -type f -print -quit)" ]]; then
  echo "app assets directory is empty: $OKOU_APP_ASSETS_DIRECTORY" >&2
  exit 1
fi

content_type_for_app_asset() {
  case "${1,,}" in
    *.js) printf '%s\n' 'application/javascript' ;;
    *.css) printf '%s\n' 'text/css; charset=utf-8' ;;
    *.json | *.map) printf '%s\n' 'application/json' ;;
    *.wasm) printf '%s\n' 'application/wasm' ;;
    *.svg) printf '%s\n' 'image/svg+xml' ;;
    *.png) printf '%s\n' 'image/png' ;;
    *.jpg | *.jpeg) printf '%s\n' 'image/jpeg' ;;
    *.webp) printf '%s\n' 'image/webp' ;;
    *.avif) printf '%s\n' 'image/avif' ;;
    *.gif) printf '%s\n' 'image/gif' ;;
    *.ico) printf '%s\n' 'image/x-icon' ;;
    *.woff) printf '%s\n' 'font/woff' ;;
    *.woff2) printf '%s\n' 'font/woff2' ;;
    *.ttf) printf '%s\n' 'font/ttf' ;;
    *.otf) printf '%s\n' 'font/otf' ;;
    *) printf '%s\n' 'application/octet-stream' ;;
  esac
}

publish_app_asset() {
  local source_path=$1
  local relative_path="${source_path#"$OKOU_APP_ASSETS_DIRECTORY"/}"
  local object_key="okou-app/assets/${relative_path}"
  local aws_output content_type status
  content_type="$(content_type_for_app_asset "$relative_path")"
  if aws_output="$(aws s3api put-object \
    --endpoint-url "$OKOU_APP_R2_ENDPOINT" \
    --bucket "$OKOU_APP_R2_BUCKET" \
    --key "$object_key" \
    --body "$source_path" \
    --content-type "$content_type" \
    --cache-control 'public, max-age=31536000, immutable' \
    --if-none-match '*' 2>&1)"; then
    echo "Published app asset: $object_key"
    return 0
  else
    status=$?
  fi

  if grep -Eq \
    '^(aws: \[ERROR\]: )?An error occurred \((PreconditionFailed|412)\) when calling the PutObject operation:' \
    <<< "$aws_output"; then
    echo "App asset already exists: $object_key"
    return 0
  fi

  printf '%s\n' "$aws_output" >&2
  return "$status"
}

export OKOU_APP_R2_ENDPOINT OKOU_APP_R2_BUCKET OKOU_APP_ASSETS_DIRECTORY
export -f content_type_for_app_asset publish_app_asset

pending_assets="$(mktemp)"
trap 'rm -f "$pending_assets"' EXIT
sorted_assets="$(mktemp)"
trap 'rm -f "$pending_assets" "$sorted_assets"' EXIT

asset_count=0
find "$OKOU_APP_ASSETS_DIRECTORY" -type f -print0 | sort -z > "$sorted_assets"
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$OKOU_APP_ASSETS_DIRECTORY"/}"
  asset_name="${relative_path##*/}"

  if [[ "$relative_path" == *.map ]] &&
    [[ ! "$asset_name" =~ -[[:alnum:]_-]{8,}\.[^.]+\.map$ ]]; then
    echo "Skipping unhashed source map: $relative_path"
    continue
  fi

  printf '%s\0' "$source_path" >> "$pending_assets"
  asset_count=$((asset_count + 1))
done < "$sorted_assets"

# Conditional creates protect existing bytes, including another publisher
# winning the same key. Work is bounded by this build, not retained history.
echo "Publishing ${asset_count} app assets with up to 16 concurrent conditional uploads"
xargs -0 -r -n 1 -P 16 bash -c \
  "set -euo pipefail; publish_app_asset \"\$1\"" _ < "$pending_assets"

echo "App asset publication complete: ${asset_count} assets in ${SECONDS}s"
