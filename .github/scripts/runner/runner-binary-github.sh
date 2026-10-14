#!/usr/bin/env bash
# GitHub is only a discovery index. R2 readers remain the binary byte authority.

runner_binary_github_request() {
  local path=$1 body=$2 headers=$3
  if [[ ! "${REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    [ -z "${GH_TOKEN:-}" ] || [[ "$GH_TOKEN" == *$'\n'* || "$GH_TOKEN" == *$'\r'* ]]; then
    return 1
  fi
  # Keep the token out of command arguments and raw provider diagnostics private.
  printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' "$GH_TOKEN" |
    curl --fail --silent --show-error --proto '=https' \
      --connect-timeout 5 --max-time 30 --max-filesize 2097152 \
      --header @- --dump-header "$headers" --output "$body" \
      --write-out '%{http_code}' -- "https://api.github.com/repos/${REPO}/${path}" \
      2>"${headers}.error"
}

runner_binary_github_json() (
  local path=$1 temporary status
  temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/runner-github.XXXXXX") || return 1
  trap 'rm -rf "$temporary"' EXIT
  status=$(runner_binary_github_request "$path" "$temporary/body" "$temporary/headers") || return 1
  [ "$status" = 200 ] || return 1
  [ "$(stat -c '%s' "$temporary/body")" -le 1048576 ] || return 1
  jq -e 'type == "object"' "$temporary/body" >/dev/null || return 1
  cat "$temporary/body"
)

runner_binary_github_artifacts() (
  local name=$1 temporary page status
  [[ "$name" =~ ^runner-binary-asset-[a-zA-Z0-9_-]+$ ]] || return 1
  temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/runner-github.XXXXXX") || return 1
  trap 'rm -rf "$temporary"' EXIT
  # Bound discovery without treating a truncated search as a successful lookup.
  for ((page = 1; page <= 8; page++)); do
    status=$(runner_binary_github_request \
      "actions/artifacts?name=${name}&per_page=100&page=${page}" \
      "$temporary/page-${page}.json" "$temporary/headers") || return 1
    [ "$status" = 200 ] || return 1
    [ "$(stat -c '%s' "$temporary/page-${page}.json")" -le 1048576 ] || return 1
    # Content/identity classification remains owned by the cache resolver.
    jq -se 'length == 1' "$temporary/page-${page}.json" >/dev/null || return 1
    if ! grep -qiE '^link:.*rel="next"' "$temporary/headers"; then
      jq -s . "$temporary"/page-*.json
      return
    fi
  done
  return 1
)

runner_binary_github_download() (
  local artifact_id=$1 output_dir=$2 temporary status location staged=""
  [[ "$artifact_id" =~ ^[1-9][0-9]*$ ]] || return 1
  temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/runner-github.XXXXXX") || return 1
  trap 'rm -rf "$temporary"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
  status=$(runner_binary_github_request "actions/artifacts/${artifact_id}/zip" \
    "$temporary/archive.zip" "$temporary/headers") || return 1
  if [ "$status" = 302 ]; then
    location=$(python3 - "$temporary/headers" <<'PYTHON'
import sys
from urllib.parse import urlsplit

headers = open(sys.argv[1], encoding="utf-8").read().splitlines()
locations = [line.split(":", 1)[1].strip() for line in headers if line.lower().startswith("location:")]
if len(locations) != 1:
    raise SystemExit(1)
url = urlsplit(locations[0])
if url.scheme != "https" or not url.hostname or url.username or url.password:
    raise SystemExit(1)
print(locations[0])
PYTHON
    ) || return 1
    # Storage redirects get no GitHub authorization, even on the same host. Never
    # follow another redirect or expose a signed URL/raw download diagnostic.
    status=$(curl --fail --silent --show-error --proto '=https' \
      --connect-timeout 5 --max-time 30 --max-filesize 2097152 \
      --output "$temporary/archive.zip" --write-out '%{http_code}' \
      -- "$location" 2>"$temporary/download.error") || return 1
  fi
  [ "$status" = 200 ] || return 1
  [ "$(stat -c '%s' "$temporary/archive.zip")" -le 2097152 ] || return 1
  if ! python3 - "$temporary/archive.zip" "$temporary/manifest.json" <<'PYTHON'
import stat
import sys
import zipfile
from pathlib import Path

try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len(files) != 1:
            raise ValueError("ambiguous archive")
        entry = files[0]
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if entry.filename != "manifest.json" or mode not in (0, stat.S_IFREG):
            raise ValueError("unsafe archive entry")
        if not 0 < entry.file_size <= 1048576:
            raise ValueError("manifest size")
        with archive.open(entry) as source:
            data = source.read(1048577)
        if len(data) != entry.file_size:
            raise ValueError("manifest size mismatch")
        Path(sys.argv[2]).write_bytes(data)
except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
    raise SystemExit(1)
PYTHON
  then
    return 1
  fi
  mkdir -p "$output_dir" || return 1
  [ ! -e "$output_dir/manifest.json" ] && [ ! -L "$output_dir/manifest.json" ] || return 1
  staged=$(mktemp "$output_dir/.manifest.XXXXXX") || return 1
  cp "$temporary/manifest.json" "$staged" || return 1
  mv "$staged" "$output_dir/manifest.json"
)
