#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <job-ref> <cloudflare-workers-subdomain>" >&2
  exit 1
fi

job_ref="$1"
cloudflare_workers_subdomain="$2"

: "${job_ref:?job ref is required}"
: "${cloudflare_workers_subdomain:?Cloudflare Workers subdomain is required}"

if [[ ! "$job_ref" =~ ^pr-[1-9][0-9]*$ && "$job_ref" != "staging" ]]; then
  echo "unsupported app preview job ref: $job_ref" >&2
  exit 1
fi

if [[ ! "$cloudflare_workers_subdomain" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "invalid Cloudflare Workers subdomain: $cloudflare_workers_subdomain" >&2
  exit 1
fi

printf 'https://%s-app-okou-app-preview.%s.workers.dev\n' \
  "$job_ref" \
  "$cloudflare_workers_subdomain"
