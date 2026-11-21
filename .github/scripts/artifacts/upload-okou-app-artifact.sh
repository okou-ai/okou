#!/usr/bin/env bash
set -euo pipefail

# Upload the local build and manifest, committing ready.json last so a
# later run can safely reuse the archive even if asset publication failed.
r2_endpoint=${1:?R2 endpoint is required}
if [[ ! "${ARTIFACT_PREFIX:?artifact prefix is required}" =~ ^okou-app/[0-9a-f]{40}$ ]]; then
  echo "Expected a commit-scoped App artifact prefix" >&2
  exit 1
fi
artifact_uri="s3://${R2_BUCKET_NAME:?R2 bucket is required}/${ARTIFACT_PREFIX}"
cache_control="public, max-age=31536000, immutable"

aws s3 rm "$artifact_uri/" \
  --endpoint-url "$r2_endpoint" \
  --recursive

# A single archive keeps readers to one request instead of one per
# file, which is where R2 kept breaking the transfer mid-stream.
tar -czf /tmp/okou-app-dist.tar.gz -C turbo/apps/platform/dist .

aws s3api put-object \
  --endpoint-url "$r2_endpoint" \
  --bucket "$R2_BUCKET_NAME" \
  --key "${ARTIFACT_PREFIX}/dist.tar.gz" \
  --body /tmp/okou-app-dist.tar.gz \
  --content-type application/gzip \
  --cache-control "$cache_control"

aws s3api put-object \
  --endpoint-url "$r2_endpoint" \
  --bucket "$R2_BUCKET_NAME" \
  --key "${ARTIFACT_PREFIX}/manifest.json" \
  --body /tmp/okou-app-manifest.json \
  --content-type application/json \
  --cache-control "$cache_control"

aws s3api put-object \
  --endpoint-url "$r2_endpoint" \
  --bucket "$R2_BUCKET_NAME" \
  --key "${ARTIFACT_PREFIX}/ready.json" \
  --body /tmp/okou-app-ready.json \
  --content-type application/json \
  --cache-control "$cache_control" \
  --if-none-match "*"

echo "Artifact ready: ${artifact_uri}/"
