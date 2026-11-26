#!/usr/bin/env bash
set -euo pipefail

# Manage Cloudflare R2 storage for CodeQL manual overlay-base databases.
#
# Subcommands:
#   prepare  Select CODEQL_OVERLAY_DATABASE_MODE for pull_request or push runs,
#            restoring a verified overlay-base archive into the runner-owned database directory on PRs
#            or scheduling an overlay-base rebuild on main when the cached base
#            is missing or older than CODEQL_OVERLAY_REFRESH_SECONDS.
#   publish  Validate, overlay-clean, compress, and atomically publish the
#            overlay-base database from the runner-owned directory to R2, keeping at most two
#            generations (current + previous) to avoid racing active PR readers.
#
# Required environment:
#   RUNNER_TEMP             Job-owned temp root containing codeql_databases.
#   GITHUB_REPOSITORY       Repository name-with-owner (owner/repo).
#
# Optional / subcommand-specific environment:
#   EVENT_NAME              GitHub event name (required for prepare).
#   CODEQL_PATH             CodeQL CLI binary path (required for publish).
#   CODEQL_CLI_VERSION      Stable CodeQL CLI version (required for publish).
#   GITHUB_SHA              40-hex commit SHA (required for publish).
#   GITHUB_RUN_ID           Positive integer run ID (required for publish).
#   GITHUB_RUN_ATTEMPT      Positive integer run attempt (required for publish).
#   R2_ACCOUNT_ID           Cloudflare R2 account ID.
#   R2_BUCKET_NAME          Private R2 bucket name for CI caches.
#   AWS_ACCESS_KEY_ID       R2 S3-compatible access key ID.
#   AWS_SECRET_ACCESS_KEY   R2 S3-compatible secret access key.
#   CODEQL_ACTION_SHA       Override pinned github/codeql-action SHA (40-hex);
#                           defaults to the init pin in SECURITY_WORKFLOW_PATH.
#   SECURITY_WORKFLOW_PATH  Path to security.yml (default: .github/workflows/security.yml).
#   CODEQL_OVERLAY_REFRESH_SECONDS  Main refresh interval (default: 7200).
#   CODEQL_OVERLAY_MAX_AGE_SECONDS  Max usable PR base age (default: 604800).
#   CODEQL_OVERLAY_MAX_ARCHIVE_BYTES Max compressed archive size (default: 3221225472).
#   CODEQL_OVERLAY_TRANSFER_TIMEOUT_SECONDS Max transfer seconds (default: 180).
#   CODEQL_OVERLAY_NOW_EPOCH Override current UTC epoch seconds (for tests).
#   GITHUB_ENV              GitHub Actions env file (prepare writes CODEQL_OVERLAY_DATABASE_MODE).
#   GITHUB_OUTPUT           GitHub Actions outputs (mode, publish, status, cli-version on a hit).
#
# Exit status:
#   0 on normal completion and fail-safe fallback to CODEQL_OVERLAY_DATABASE_MODE=none.
#   2 on invalid invocation.

LANGUAGE="javascript-typescript"
DB_SUBDIR="javascript"
KEY_PREFIX_ROOT="codeql-overlay-base/v1"
REFRESH_SECONDS="${CODEQL_OVERLAY_REFRESH_SECONDS:-7200}"
MAX_AGE_SECONDS="${CODEQL_OVERLAY_MAX_AGE_SECONDS:-604800}"
MAX_ARCHIVE_BYTES="${CODEQL_OVERLAY_MAX_ARCHIVE_BYTES:-3221225472}"
TRANSFER_TIMEOUT_SECONDS="${CODEQL_OVERLAY_TRANSFER_TIMEOUT_SECONDS:-180}"
SECURITY_WORKFLOW_PATH="${SECURITY_WORKFLOW_PATH:-.github/workflows/security.yml}"
ZSTD_COMPRESS_CMD="zstd -q -3 -T0"

usage_fail() {
  echo "codeql-overlay-cache error: $*" >&2
  exit 2
}

warn() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::warning::CodeQL overlay cache: $*" >&2
  else
    echo "codeql-overlay-cache warning: $*" >&2
  fi
}

info() {
  echo "codeql-overlay-cache: $*" >&2
}

validate_positive_int() {
  local name=$1 value=$2
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || usage_fail "$name must be a positive integer"
}

clean_db_location() {
  if [ -e "$DB_LOCATION" ] || [ -L "$DB_LOCATION" ]; then
    rm -rf -- "$DB_LOCATION"
  fi
}

emit_prepare_result() {
  local mode=$1 publish=$2 status=$3
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'CODEQL_OVERLAY_DATABASE_MODE=%s\n' "$mode" >> "$GITHUB_ENV"
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'mode=%s\n' "$mode"
      printf 'publish=%s\n' "$publish"
      printf 'status=%s\n' "$status"
      if [[ "$mode" == "overlay" ]]; then
        printf 'cli-version=%s\n' "${4:?missing base CLI version}"
      fi
    } >> "$GITHUB_OUTPUT"
  fi
}

emit_publish_status() {
  local status=$1
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'status=%s\n' "$status" >> "$GITHUB_OUTPUT"
  fi
}

resolve_action_sha() {
  if [ -n "${CODEQL_ACTION_SHA:-}" ]; then
    [[ "$CODEQL_ACTION_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$CODEQL_ACTION_SHA"
    return 0
  fi
  [ -f "$SECURITY_WORKFLOW_PATH" ] || return 1
  local sha
  sha=$(sed -nE 's|.*github/codeql-action/init@([0-9a-f]{40}).*|\1|p' "$SECURITY_WORKFLOW_PATH" | head -n 1)
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

r2_ready() {
  [ -n "${R2_ACCOUNT_ID:-}" ] &&
    [ -n "${R2_BUCKET_NAME:-}" ] &&
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] &&
    [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] &&
    [[ "$R2_ACCOUNT_ID" =~ ^[a-zA-Z0-9_-]+$ ]] &&
    command -v aws >/dev/null 2>&1 &&
    command -v zstd >/dev/null 2>&1 &&
    command -v jq >/dev/null 2>&1 &&
    command -v python3 >/dev/null 2>&1
}

r2_endpoint() {
  printf 'https://%s.r2.cloudflarestorage.com\n' "$R2_ACCOUNT_ID"
}

r2_get_manifest() {
  local key=$1 dest=$2
  AWS_MAX_ATTEMPTS=2 \
    timeout --kill-after=5s 30s aws s3api get-object \
      --endpoint-url "$(r2_endpoint)" \
      --bucket "$R2_BUCKET_NAME" \
      --key "$key" --range bytes=0-65536 \
      --cli-connect-timeout 5 --cli-read-timeout 15 \
      "$dest" \
      >"$WORK_DIR/get-manifest.out" 2>"$WORK_DIR/get-manifest.err"
}

r2_put_manifest() {
  local key=$1 body=$2
  shift 2
  AWS_MAX_ATTEMPTS=1 \
    timeout --kill-after=5s 30s aws s3api put-object \
      --endpoint-url "$(r2_endpoint)" \
      --bucket "$R2_BUCKET_NAME" \
      --key "$key" \
      --body "$body" \
      --content-type application/json "$@" \
      --cache-control 'private, no-store' \
      --cli-connect-timeout 5 --cli-read-timeout 15 \
      >"$WORK_DIR/put-manifest.out" 2>"$WORK_DIR/put-manifest.err"
}

r2_download_payload() {
  local key=$1 dest=$2 expected_size=$3
  # Request one extra byte to detect an oversized object without filling the disk.
  AWS_MAX_ATTEMPTS=2 \
    timeout --kill-after=5s "${TRANSFER_TIMEOUT_SECONDS}s" aws s3api get-object \
      --endpoint-url "$(r2_endpoint)" --bucket "$R2_BUCKET_NAME" --key "$key" \
      --range "bytes=0-${expected_size}" --cli-connect-timeout 5 --cli-read-timeout 60 \
      "$dest" >"$WORK_DIR/get-payload.out" 2>"$WORK_DIR/get-payload.err"
}

r2_upload_payload() {
  local body=$1 key=$2
  AWS_MAX_ATTEMPTS=1 \
    timeout --kill-after=5s "${TRANSFER_TIMEOUT_SECONDS}s" aws s3api put-object \
      --endpoint-url "$(r2_endpoint)" --bucket "$R2_BUCKET_NAME" --key "$key" \
      --if-none-match '*' --body "$body" --content-type application/zstd \
      --cache-control 'private, no-store' --cli-connect-timeout 5 --cli-read-timeout 60 \
      >"$WORK_DIR/put-payload.out" 2>"$WORK_DIR/put-payload.err"
}

r2_delete_object() {
  local key=$1
  AWS_MAX_ATTEMPTS=2 \
    timeout --kill-after=5s 30s aws s3api delete-object \
      --endpoint-url "$(r2_endpoint)" \
      --bucket "$R2_BUCKET_NAME" \
      --key "$key" \
      --cli-connect-timeout 5 --cli-read-timeout 15 \
      >"$WORK_DIR/delete.out" 2>"$WORK_DIR/delete.err"
}

validate_manifest() {
  local manifest=$1 action_sha=$2
  local payload_regex="^${KEY_PREFIX_ROOT}/${action_sha}/db-[1-9][0-9]*-[1-9][0-9]*\\.tar\\.zst\$"
  [[ -f "$manifest" && -s "$manifest" && ! -L "$manifest" ]] || return 1
  [ "$(stat -c '%s' "$manifest")" -le 65536 ] || return 1
  jq -e \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg action_sha "$action_sha" \
    --arg language "$LANGUAGE" \
    --arg payload_regex "$payload_regex" \
    --argjson max_size "$MAX_ARCHIVE_BYTES" '
    .version == 1
      and .repository == $repository
      and .language == $language
      and .codeqlActionSha == $action_sha
      and (.codeqlCliVersion | type == "string" and test("^[0-9]+[.][0-9]+[.][0-9]+$"))
      and (.baseSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.createdAtEpoch | type == "number" and floor == . and . > 0 and . < 10000000000)
      and (.payloadKey | type == "string" and test($payload_regex))
      and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.compressedSizeBytes | type == "number" and floor == . and . > 0 and . <= $max_size)
      and (
        (.previousPayloadKey == null)
        or (.previousPayloadKey == "")
        or (.previousPayloadKey | type == "string" and test($payload_regex))
      )
  ' "$manifest" >/dev/null 2>&1
}

extract_archive() {
  zstd -qdc -- "$1" | python3 -I -c '
import sys
import tarfile
from pathlib import PurePosixPath

def regular_files_only(member, destination):
    path = PurePosixPath(member.name)
    if path.is_absolute() or ".." in path.parts or member.type not in (
        tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE
    ):
        raise tarfile.FilterError("unexpected member in CodeQL cache archive")
    return tarfile.data_filter(member, destination)

with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    archive.extractall(sys.argv[1], filter=regular_files_only)
# Consume the final tar padding so the decompressor can report its exit status.
while sys.stdin.buffer.read(65536):
    pass
' "$2"
}

do_prepare() {
  [ -n "${EVENT_NAME:-}" ] || usage_fail "EVENT_NAME is required for prepare"
  [ -n "${GITHUB_REPOSITORY:-}" ] || usage_fail "GITHUB_REPOSITORY is required"
  validate_positive_int CODEQL_OVERLAY_REFRESH_SECONDS "$REFRESH_SECONDS"
  validate_positive_int CODEQL_OVERLAY_MAX_AGE_SECONDS "$MAX_AGE_SECONDS"
  validate_positive_int CODEQL_OVERLAY_MAX_ARCHIVE_BYTES "$MAX_ARCHIVE_BYTES"
  validate_positive_int CODEQL_OVERLAY_TRANSFER_TIMEOUT_SECONDS "$TRANSFER_TIMEOUT_SECONDS"

  local now_epoch
  now_epoch="${CODEQL_OVERLAY_NOW_EPOCH:-$(date +%s)}"
  validate_positive_int CODEQL_OVERLAY_NOW_EPOCH "$now_epoch"

  clean_db_location

  if ! r2_ready; then
    info "R2 credentials or tools unavailable; falling back to full scan (mode=none)."
    emit_prepare_result none false unavailable
    return 0
  fi

  local action_sha
  if ! action_sha=$(resolve_action_sha); then
    warn "could not resolve pinned github/codeql-action SHA; falling back to mode=none."
    emit_prepare_result none false invalid-pin
    return 0
  fi

  local prefix="${KEY_PREFIX_ROOT}/${action_sha}"
  local manifest_key="${prefix}/manifest.json"
  local manifest_file="${WORK_DIR}/manifest.json"

  case "$EVENT_NAME" in
    push)
      if r2_get_manifest "$manifest_key" "$manifest_file" && validate_manifest "$manifest_file" "$action_sha"; then
        local created_at age
        created_at=$(jq -r '.createdAtEpoch' "$manifest_file")
        age=$((now_epoch - created_at))
        if [ "$age" -ge 0 ] && [ "$age" -lt "$REFRESH_SECONDS" ]; then
          info "overlay-base is fresh (age=${age}s < ${REFRESH_SECONDS}s); skipping rebuild (mode=none)."
          emit_prepare_result none false fresh
          return 0
        fi
        info "overlay-base is stale (age=${age}s >= ${REFRESH_SECONDS}s); scheduling rebuild (mode=overlay-base)."
      else
        info "no valid overlay-base manifest found; scheduling initial rebuild (mode=overlay-base)."
      fi
      emit_prepare_result overlay-base true rebuild
      return 0
      ;;

    pull_request)
      if ! r2_get_manifest "$manifest_key" "$manifest_file"; then
        info "no overlay-base manifest in R2; falling back to full scan (mode=none)."
        emit_prepare_result none false miss
        return 0
      fi
      if ! validate_manifest "$manifest_file" "$action_sha"; then
        warn "overlay-base manifest failed validation; falling back to full scan (mode=none)."
        emit_prepare_result none false invalid-manifest
        return 0
      fi

      local created_at age payload_key expected_sha expected_size
      created_at=$(jq -r '.createdAtEpoch' "$manifest_file")
      age=$((now_epoch - created_at))
      if [ "$age" -lt 0 ] || [ "$age" -gt "$MAX_AGE_SECONDS" ]; then
        info "overlay-base manifest expired (age=${age}s > ${MAX_AGE_SECONDS}s); falling back to full scan (mode=none)."
        emit_prepare_result none false expired
        return 0
      fi

      payload_key=$(jq -r '.payloadKey' "$manifest_file")
      expected_sha=$(jq -r '.sha256' "$manifest_file")
      expected_size=$(jq -r '.compressedSizeBytes' "$manifest_file")
      local archive="${WORK_DIR}/base.tar.zst"

      if ! r2_download_payload "$payload_key" "$archive" "$expected_size"; then
        warn "overlay-base download failed; falling back to full scan (mode=none)."
        emit_prepare_result none false download-failed
        return 0
      fi

      local actual_size actual_sha
      actual_size=$(stat -c '%s' "$archive")
      actual_sha=$(sha256sum "$archive" | cut -d ' ' -f 1)
      if [ "$actual_size" != "$expected_size" ] || [ "$actual_sha" != "$expected_sha" ]; then
        warn "overlay-base archive integrity mismatch; falling back to full scan (mode=none)."
        emit_prepare_result none false checksum-mismatch
        return 0
      fi

      local staging="${WORK_DIR}/staging"
      mkdir -p "$staging"
      if ! extract_archive "$archive" "$staging" 2>"$WORK_DIR/extract.err"; then
        warn "overlay-base archive could not be safely extracted; falling back to full scan."
        emit_prepare_result none false unsafe-archive
        return 0
      fi

      if [[ ! -f "$staging/base-database-oids.json" || ! -s "$staging/base-database-oids.json" || -L "$staging/base-database-oids.json" ]] ||
        ! jq -e 'type == "object" and length > 0 and all(.[]; type == "string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$"))' "$staging/base-database-oids.json" >/dev/null 2>&1 ||
        [[ ! -f "$staging/${DB_SUBDIR}/codeql-database.yml" || ! -s "$staging/${DB_SUBDIR}/codeql-database.yml" || -L "$staging/${DB_SUBDIR}/codeql-database.yml" ]]; then
        warn "restored overlay-base database is incomplete; falling back to full scan (mode=none)."
        emit_prepare_result none false incomplete-db
        return 0
      fi

      mv "$staging" "$DB_LOCATION"
      info "restored overlay-base (${actual_size} bytes, age=${age}s, baseSha=$(jq -r '.baseSha[0:8]' "$manifest_file")) -> mode=overlay."
      emit_prepare_result overlay false hit "$(jq -r '.codeqlCliVersion' "$manifest_file")"
      return 0
      ;;

    *)
      info "unsupported event '${EVENT_NAME}' for overlay caching; using mode=none."
      emit_prepare_result none false unsupported-event
      return 0
      ;;
  esac
}

do_publish() {
  [ -n "${GITHUB_REPOSITORY:-}" ] || usage_fail "GITHUB_REPOSITORY is required"
  [ -n "${CODEQL_PATH:-}" ] || usage_fail "CODEQL_PATH is required for publish"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || usage_fail "valid 40-hex GITHUB_SHA is required for publish"
  if [[ ! "${CODEQL_CLI_VERSION:-}" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    warn "no stable CodeQL bundle version for this database; skipping publish."
    emit_publish_status unsupported-version
    return 0
  fi
  validate_positive_int GITHUB_RUN_ID "${GITHUB_RUN_ID:-}"
  validate_positive_int GITHUB_RUN_ATTEMPT "${GITHUB_RUN_ATTEMPT:-}"
  validate_positive_int CODEQL_OVERLAY_REFRESH_SECONDS "$REFRESH_SECONDS"
  validate_positive_int CODEQL_OVERLAY_MAX_ARCHIVE_BYTES "$MAX_ARCHIVE_BYTES"
  validate_positive_int CODEQL_OVERLAY_TRANSFER_TIMEOUT_SECONDS "$TRANSFER_TIMEOUT_SECONDS"

  local now_epoch
  now_epoch="${CODEQL_OVERLAY_NOW_EPOCH:-$(date +%s)}"
  validate_positive_int CODEQL_OVERLAY_NOW_EPOCH "$now_epoch"

  if ! r2_ready; then
    warn "R2 credentials or tools unavailable; skipping overlay-base publish."
    emit_publish_status unavailable
    return 0
  fi

  local action_sha
  if ! action_sha=$(resolve_action_sha); then
    warn "could not resolve pinned github/codeql-action SHA; skipping overlay-base publish."
    emit_publish_status invalid-pin
    return 0
  fi

  local db_path="${DB_LOCATION}/${DB_SUBDIR}"
  local oids_file="${DB_LOCATION}/base-database-oids.json"
  if [[ ! -f "$oids_file" || ! -s "$oids_file" || -L "$oids_file" ]] || [ ! -d "$db_path" ]; then
    warn "overlay-base database files missing in ${DB_LOCATION}; skipping publish."
    emit_publish_status invalid-db
    return 0
  fi

  local resolve_out="${WORK_DIR}/resolve.json"
  if ! "$CODEQL_PATH" resolve database "$db_path" --format=json >"$resolve_out" 2>"$WORK_DIR/resolve.err" ||
    ! jq -e 'has("overlayBaseSpecifier") and (.overlayBaseSpecifier | type == "string" and length > 0)' "$resolve_out" >/dev/null 2>&1; then
    warn "CodeQL database does not contain an overlayBaseSpecifier; skipping publish."
    emit_publish_status not-overlay-base
    return 0
  fi

  if ! "$CODEQL_PATH" database cleanup "$db_path" --cache-cleanup=overlay >"$WORK_DIR/cleanup.out" 2>"$WORK_DIR/cleanup.err"; then
    warn "CodeQL overlay cleanup failed; skipping publish."
    emit_publish_status cleanup-failed
    return 0
  fi

  local archive="${WORK_DIR}/overlay-base.tar.zst"
  if ! tar --hard-dereference -I "$ZSTD_COMPRESS_CMD" -cf "$archive" -C "$DB_LOCATION" .; then
    warn "failed to archive overlay-base database; skipping publish."
    emit_publish_status archive-failed
    return 0
  fi

  local compressed_size sha256
  compressed_size=$(stat -c '%s' "$archive")
  if [ "$compressed_size" -le 0 ] || [ "$compressed_size" -gt "$MAX_ARCHIVE_BYTES" ]; then
    warn "overlay-base archive size (${compressed_size} bytes) exceeds limit (${MAX_ARCHIVE_BYTES}); skipping publish."
    emit_publish_status size-exceeded
    return 0
  fi
  sha256=$(sha256sum "$archive" | cut -d ' ' -f 1)

  local prefix="${KEY_PREFIX_ROOT}/${action_sha}"
  local manifest_key="${prefix}/manifest.json"
  local payload_key="${prefix}/db-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.tar.zst"
  local old_manifest="${WORK_DIR}/old-manifest.json"
  local previous_key="" obsolete_key=""

  local manifest_condition=(--if-none-match '*')
  if r2_get_manifest "$manifest_key" "$old_manifest"; then
    local etag
    if ! etag=$(jq -er '.ETag | strings | select(length > 0)' "$WORK_DIR/get-manifest.out"); then
      warn "R2 did not return the manifest ETag; skipping publish."
      emit_publish_status manifest-unavailable
      return 0
    fi
    manifest_condition=(--if-match "$etag")
    if validate_manifest "$old_manifest" "$action_sha"; then
      local created_at
      created_at=$(jq -r '.createdAtEpoch' "$old_manifest")
      if (( created_at <= now_epoch && now_epoch - created_at < REFRESH_SECONDS )); then
        info "another main run already refreshed the base."
        emit_publish_status fresh
        return 0
      fi
      previous_key=$(jq -r '.payloadKey' "$old_manifest")
      obsolete_key=$(jq -r '.previousPayloadKey // ""' "$old_manifest")
    fi
  elif ! jq -e '(.Error.Code // .Code) | IN("NoSuchKey", "404", "NotFound")' \
    "$WORK_DIR/get-manifest.err" >/dev/null 2>&1; then
    warn "could not establish the previous manifest state; skipping publish."
    emit_publish_status manifest-unavailable
    return 0
  fi

  if ! r2_upload_payload "$archive" "$payload_key"; then
    warn "failed to upload overlay-base archive to R2; skipping manifest update."
    emit_publish_status upload-failed
    return 0
  fi

  local new_manifest="${WORK_DIR}/new-manifest.json"
  jq -n \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg language "$LANGUAGE" \
    --arg action_sha "$action_sha" \
    --arg cli_version "$CODEQL_CLI_VERSION" \
    --arg base_sha "$GITHUB_SHA" \
    --arg payload_key "$payload_key" \
    --arg previous_key "$previous_key" \
    --arg sha256 "$sha256" \
    --argjson created_at "$now_epoch" \
    --argjson compressed_size "$compressed_size" '
    {
      version: 1,
      repository: $repository,
      language: $language,
      codeqlActionSha: $action_sha,
      codeqlCliVersion: $cli_version,
      baseSha: $base_sha,
      createdAtEpoch: $created_at,
      payloadKey: $payload_key,
      previousPayloadKey: (if $previous_key == "" then null else $previous_key end),
      sha256: $sha256,
      compressedSizeBytes: $compressed_size
    }
  ' >"$new_manifest"

  if ! r2_put_manifest "$manifest_key" "$new_manifest" "${manifest_condition[@]}"; then
    if jq -e '(.Error.Code // .Code) | IN("PreconditionFailed", "412", "ConditionalRequestConflict")' \
      "$WORK_DIR/put-manifest.err" >/dev/null 2>&1; then
      # The conditional PUT was rejected. Only this run could create this payload.
      r2_delete_object "$payload_key" || warn "failed to prune superseded payload."
      emit_publish_status superseded
      return 0
    fi
    # A lost response can follow a committed PUT. Never replay it or delete
    # potentially referenced bytes. Confirm the candidate before pruning.
    if ! r2_get_manifest "$manifest_key" "$WORK_DIR/readback.json" ||
      ! cmp -s "$new_manifest" "$WORK_DIR/readback.json"; then
      warn "could not confirm the manifest update."
      emit_publish_status manifest-failed
      return 0
    fi
  fi

  if [ -n "$obsolete_key" ] && [ "$obsolete_key" != "$payload_key" ] && [ "$obsolete_key" != "$previous_key" ]; then
    r2_delete_object "$obsolete_key" || warn "failed to prune obsolete overlay-base object."
  fi

  info "published overlay-base (${compressed_size} bytes, key=${payload_key})."
  emit_publish_status published
  return 0
}

[ -n "${RUNNER_TEMP:-}" ] || usage_fail "RUNNER_TEMP is required"
DB_LOCATION="$RUNNER_TEMP/codeql_databases"
export AWS_DEFAULT_REGION=auto AWS_RETRY_MODE=standard AWS_CLI_ERROR_FORMAT=json
export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
WORK_DIR=$(mktemp -d "$RUNNER_TEMP/codeql-overlay-cache.XXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT

case "${1:-}" in
  prepare)
    (($# == 1)) || usage_fail "usage: $0 prepare|publish"
    do_prepare
    ;;
  publish)
    (($# == 1)) || usage_fail "usage: $0 prepare|publish"
    do_publish
    ;;
  *)
    usage_fail "usage: $0 prepare|publish"
    ;;
esac
