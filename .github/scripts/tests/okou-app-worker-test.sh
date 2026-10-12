#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker_config="${repo_root}/turbo/apps/app-worker/wrangler.jsonc"
if ! grep -Fq '"global_fetch_strictly_public"' "$worker_config"; then
  echo "app Worker must allow public same-zone fetches" >&2
  exit 1
fi
if grep -Fq '"assets"' "$worker_config"; then
  echo "app Worker shell must not depend on the Workers Assets service" >&2
  exit 1
fi

worker_entrypoint="${repo_root}/turbo/apps/app-worker/src/index.ts"
for module_path in \
  '../assets/favicon.ico.bin' \
  '../shell/index.html' \
  '../shell/sw.txt' \
  '../shell/manifest.txt' \
  '../shell/robots.txt' \
  '../shell/icons/icon-192.bin' \
  '../shell/icons/icon-512.bin' \
  '../shell/icons/icon-512-maskable.bin'; do
  if ! grep -Fq "$module_path" "$worker_entrypoint"; then
    echo "app Worker shell module import is missing: ${module_path}" >&2
    exit 1
  fi
done

# Runtime coverage imports workspace dependencies and runs in turbo.yml's
# test-other job with `pnpm -F @okouai/app-worker test`.
echo "okou-app-worker configuration: ok"
