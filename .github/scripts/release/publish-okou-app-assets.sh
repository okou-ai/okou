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

  if grep -Eqi 'PreconditionFailed|412' <<< "$aws_output"; then
    echo "App asset already exists: $object_key"
    return 0
  fi

  printf '%s\n' "$aws_output" >&2
  return "$status"
}

export OKOU_APP_R2_ENDPOINT OKOU_APP_R2_BUCKET OKOU_APP_ASSETS_DIRECTORY
export -f content_type_for_app_asset publish_app_asset

existing_assets_json="$(mktemp)"
existing_assets="$(mktemp)"
pending_assets="$(mktemp)"
sorted_assets="$(mktemp)"
trap 'rm -f "$existing_assets_json" "$existing_assets" "$pending_assets" "$sorted_assets"' EXIT

aws s3api list-objects-v2 \
  --endpoint-url "$OKOU_APP_R2_ENDPOINT" \
  --bucket "$OKOU_APP_R2_BUCKET" \
  --prefix 'okou-app/assets/' \
  --output json \
  --no-cli-pager > "$existing_assets_json"
jq -r '(.Contents // [])[] | .Key' \
  "$existing_assets_json" > "$existing_assets"

declare -A existing_asset_keys=()
while IFS= read -r object_key; do
  existing_asset_keys["$object_key"]=1
done < "$existing_assets"
echo "Found ${#existing_asset_keys[@]} existing app assets in R2"

find "$OKOU_APP_ASSETS_DIRECTORY" -type f -print0 | sort -z > "$sorted_assets"
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$OKOU_APP_ASSETS_DIRECTORY"/}"
  asset_name="${relative_path##*/}"

  if [[ "$relative_path" == *.map ]] &&
    [[ ! "$asset_name" =~ -[[:alnum:]_-]{8,}\.[^.]+\.map$ ]]; then
    echo "Skipping unhashed source map: $relative_path"
    continue
  fi

  object_key="okou-app/assets/${relative_path}"
  if [[ -n "${existing_asset_keys["$object_key"]+present}" ]]; then
    echo "App asset already exists: $object_key"
    continue
  fi

  printf '%s\0' "$source_path" >> "$pending_assets"
done < "$sorted_assets"

xargs -0 -r -n 1 -P 16 bash -c \
  "set -euo pipefail; publish_app_asset \"\$1\"" _ < "$pending_assets"

echo "App asset publication complete"
