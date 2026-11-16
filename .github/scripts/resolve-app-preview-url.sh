#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <job-ref> <public-preview-domain>" >&2
  exit 1
fi

job_ref="$1"
public_preview_domain="$2"

if [[ ! "$job_ref" =~ ^pr-[1-9][0-9]*$ && "$job_ref" != "staging" ]]; then
  echo "unsupported app preview job ref: $job_ref" >&2
  exit 1
fi

# The public gateway and preview authentication own this zone. Do not turn a CI
# variable into an arbitrary authorized origin or a silent provider fallback.
if [[ "$public_preview_domain" != "omby.ai" ]]; then
  echo "unsupported public app preview domain: $public_preview_domain" >&2
  exit 1
fi

printf 'https://%s-app.%s\n' "$job_ref" "$public_preview_domain"
