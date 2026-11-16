#!/usr/bin/env bash
set -euo pipefail

# Run from any directory. GET the public gateway's sign-in document, requiring
# both gateway traversal and the uploaded artifact's identity. No credentials.
# Exit nonzero if the bounded readiness window expires.
if (( $# < 2 || $# > 3 )); then
  echo "usage: $0 <public-preview-url> <artifact-sha> [attempts=30]" >&2
  exit 1
fi

preview_url="$1"
artifact_sha="$2"
attempts="${3:-30}"
if [[ ! "$artifact_sha" =~ ^[0-9a-f]{40}$ || ! "$attempts" =~ ^[1-9][0-9]?$ ]] || (( attempts > 60 )); then
  echo "expected a full artifact SHA and 1-60 readiness attempts" >&2
  exit 1
fi

response_headers="$(mktemp)"
trap 'rm -f "$response_headers"' EXIT
for (( attempt=1; attempt<=attempts; attempt++ )); do
  if curl --fail --silent --show-error --max-time 10 \
    --header 'Sec-Fetch-Mode: navigate' \
    --header 'Sec-Fetch-Dest: document' \
    --dump-header "$response_headers" \
    --output /dev/null \
    "${preview_url%/}/sign-in" && \
    tr -d '\r' < "$response_headers" | grep -Eiq '^HTTP/[^ ]+ 200( |$)' && \
    tr -d '\r' < "$response_headers" | grep -Eiq '^x-vm0-preview-gateway:[[:space:]]*1[[:space:]]*$' && \
    tr -d '\r' < "$response_headers" | grep -Eiq "^x-okou-preview-build-sha:[[:space:]]*${artifact_sha}[[:space:]]*$"; then
    echo "Public app preview serves artifact ${artifact_sha} through the gateway"
    exit 0
  fi
  echo "::warning::Public app preview is not ready for artifact ${artifact_sha} (attempt ${attempt}/${attempts})" >&2
  if (( attempt < attempts )); then
    sleep 2
  fi
done

echo "::error::Public app preview did not serve the deployed artifact through the gateway" >&2
exit 1
