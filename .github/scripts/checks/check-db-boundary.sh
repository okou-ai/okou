#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(git rev-parse --show-toplevel)
cd "$ROOT_DIR"

failed=0

while IFS= read -r package_json; do
  case "$package_json" in
    turbo/apps/api/package.json | turbo/packages/db/package.json)
      continue
      ;;
  esac

  if jq -e '
    [
      (.dependencies // {}),
      (.devDependencies // {}),
      (.peerDependencies // {}),
      (.optionalDependencies // {})
    ] | any(has("@okouai/db"))
  ' "$package_json" >/dev/null; then
    echo "::error file=$package_json::Only turbo/apps/api and turbo/packages/db may depend on @okouai/db."
    failed=1
  fi
done < <(find turbo -name package.json -not -path "*/node_modules/*" | sort)

db_import_pattern="from ['\"]@okouai/db(/|['\"])|require\\(['\"]@okouai/db(/|['\"])|import\\(['\"]@okouai/db(/|['\"])"
if matches=$(git grep -n -E "$db_import_pattern" -- \
  turbo \
  ':!turbo/apps/api' \
  ':!turbo/packages/db'); then
  echo "::error::Only turbo/apps/api and turbo/packages/db may import @okouai/db."
  echo "$matches"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "DB ownership boundary validated."
