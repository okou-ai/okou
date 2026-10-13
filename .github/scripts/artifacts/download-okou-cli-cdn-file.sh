#!/usr/bin/env bash
set -euo pipefail

# Download one public CLI CDN file. Artifact integrity and execution are checked
# by the caller after all files have been downloaded successfully.
if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <public-url> <destination>" >&2
  exit 2
fi

url="$1"
destination="$2"
diagnostics="$(mktemp)"
trap 'rm -f -- "$diagnostics"' EXIT

printf 'Downloading CLI CDN file: %s\n' "$url"
# The retry budget limits when another attempt can start; the transfer timeout
# bounds the final attempt too. Omitting --retry-delay enables curl's backoff.
if curl --disable -fsSL \
  --connect-timeout 10 \
  --max-time 60 \
  --retry 8 \
  --retry-max-time 120 \
  --retry-all-errors \
  --verbose \
  --stderr "$diagnostics" \
  --write-out 'CDN result: http=%{http_code} remote_ip=%{remote_ip} dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s\n' \
  --output "$destination" \
  -- "$url"; then
  exit 0
else
  status="$?"
  printf 'CLI CDN download failed (curl exit %s): %s\n' "$status" "$url" >&2
  cat -- "$diagnostics" >&2
  exit "$status"
fi
