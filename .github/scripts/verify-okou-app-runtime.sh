#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <app-url> <public-assets-url> <assets-directory>" >&2
  exit 1
fi

app_url="${1%/}"
public_assets_url="${2%/}"
assets_directory="${3%/}"
canonical_document="$(dirname "$assets_directory")/index.html"
document_max_attempts="${OKOU_APP_RUNTIME_MAX_ATTEMPTS:-1}"

if [[ ! -d "$assets_directory" ]]; then
  echo "app assets directory does not exist: $assets_directory" >&2
  exit 1
fi
if [[ ! -f "$canonical_document" ]]; then
  echo "canonical app document does not exist: $canonical_document" >&2
  exit 1
fi
if [[ ! "$document_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "OKOU_APP_RUNTIME_MAX_ATTEMPTS must be a positive integer" >&2
  exit 1
fi

layout_files="$(mktemp)"
document_body="$(mktemp)"
curl_error="$(mktemp)"
probe_evidence="$(mktemp)"
trap 'rm -f "$layout_files" "$document_body" "$curl_error" "$probe_evidence"' EXIT

declare -a app_files=()
declare -a stylesheet_files=()
declare -a vendor_files=()
declare -a runtime_files=()
declare -a worker_files=()
declare -a clerk_ui_files=()
find "$assets_directory" -type f \( -name '*.js' -o -name '*.css' \) -print0 | sort -z > "$layout_files"
while IFS= read -r -d '' source_path; do
  relative_path="${source_path#"$assets_directory"/}"
  case "$relative_path" in
    index-*.css) stylesheet_files+=("$relative_path") ;;
    vendor-*.js) vendor_files+=("$relative_path") ;;
    rolldown-runtime-*.js) runtime_files+=("$relative_path") ;;
    shared-database-worker-*.js) worker_files+=("$relative_path") ;;
    clerk-ui-*.js) clerk_ui_files+=("$relative_path") ;;
    app-*.js|index-*.js) app_files+=("$relative_path") ;;
  esac
done < "$layout_files"

if ((
  ${#app_files[@]} != 1 ||
  ${#stylesheet_files[@]} != 1 ||
  ${#vendor_files[@]} != 5 ||
  ${#runtime_files[@]} != 1 ||
  ${#worker_files[@]} != 1 ||
  ${#clerk_ui_files[@]} != 1
)); then
  echo "Expected exactly five numbered vendor assets plus one app stylesheet, app, Rolldown runtime, SharedWorker, and optional-route Clerk UI JavaScript asset" >&2
  exit 1
fi

for group in 1 2 3 4 5; do
  matches=0
  for vendor_file in "${vendor_files[@]}"; do
    if [[ "$vendor_file" == vendor-"${group}"-*.js ]]; then
      matches=$((matches + 1))
    fi
  done
  if (( matches != 1 )); then
    echo "Expected exactly one vendor-${group} JavaScript asset, found ${matches}" >&2
    exit 1
  fi
done

document_assets_url="$public_assets_url"
if [[ "$app_url" == https://*.workers.dev ]]; then
  document_assets_url="${app_url}/okou-app/assets"
fi
app_asset_url="${document_assets_url}/${app_files[0]}"
stylesheet_asset_url="${document_assets_url}/${stylesheet_files[0]}"
declare -a vendor_asset_urls=()
for vendor_file in "${vendor_files[@]}"; do
  vendor_asset_urls+=("${document_assets_url}/${vendor_file}")
done
runtime_asset_url="${document_assets_url}/${runtime_files[0]}"
worker_asset_url="${app_url}/okou-app/assets/${worker_files[0]}"
clerk_ui_asset_url="${document_assets_url}/${clerk_ui_files[0]}"
document_url="${app_url}/sign-up"
document_retry_delay_seconds=10
document_wait_started=$SECONDS
document_wait_deadline=$((document_wait_started + 600))

for ((attempt = 1; attempt <= document_max_attempts; attempt++)); do
  : >"$curl_error"
  : >"$probe_evidence"
  if curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 6 \
    --retry-delay 2 \
    --retry-max-time 90 \
    --retry-all-errors \
    --output "$document_body" \
    "$document_url" 2>"$curl_error"; then
    if python3 - \
      "$document_body" \
      "$canonical_document" \
      "$app_asset_url" \
      "$runtime_asset_url" \
      "$stylesheet_asset_url" \
      "$clerk_ui_asset_url" \
      "${vendor_asset_urls[@]}" 2>"$probe_evidence" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
import re
import sys

COMMIT_SHA_META_NAME = "okou-app-git-commit-sha"
VERSION_META_NAME = "okou-app-version"
RUNTIME_META_NAMES = {COMMIT_SHA_META_NAME, VERSION_META_NAME}
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
MAIN_STYLESHEET_ID = "okou-main-stylesheet"
MAIN_STYLESHEET_LOADER_SCRIPT_ID = "okou-main-stylesheet-loader"


class AppDocumentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.module_scripts: list[str] = []
        self.module_preloads: list[str] = []
        self.clerk_ui_sources: list[str | None] = []
        self.main_stylesheets: list[dict[str, str | None]] = []
        self.main_stylesheet_loader_count = 0
        self.runtime_metadata: dict[str, list[str | None]] = {
            name: [] for name in RUNTIME_META_NAMES
        }

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attributes = dict(attrs)
        if tag == "meta" and attributes.get("name") == "okou-clerk-ui-script":
            self.clerk_ui_sources.append(attributes.get("content"))
        if tag == "link" and attributes.get("id") == MAIN_STYLESHEET_ID:
            self.main_stylesheets.append(attributes)
        if (
            tag == "script"
            and attributes.get("id") == MAIN_STYLESHEET_LOADER_SCRIPT_ID
        ):
            self.main_stylesheet_loader_count += 1
        if tag == "script" and attributes.get("type") == "module":
            source = attributes.get("src")
            if source:
                self.module_scripts.append(source)
        if tag == "link" and attributes.get("rel") == "modulepreload":
            href = attributes.get("href")
            if href:
                self.module_preloads.append(href)
        if tag == "meta" and attributes.get("name") in RUNTIME_META_NAMES:
            name = attributes["name"]
            if name is not None:
                self.runtime_metadata[name].append(attributes.get("content"))


def parse_document(path: str) -> AppDocumentParser:
    parser = AppDocumentParser()
    parser.feed(Path(path).read_text())
    return parser


def runtime_metadata(parser: AppDocumentParser, label: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for name in RUNTIME_META_NAMES:
        values = parser.runtime_metadata[name]
        if len(values) != 1 or values[0] is None:
            raise RuntimeError(
                f"Expected exactly one {label} {name} meta tag with content, got {values}"
            )
        metadata[name] = values[0]
    commit_sha = metadata[COMMIT_SHA_META_NAME]
    version = metadata[VERSION_META_NAME]
    if COMMIT_SHA_PATTERN.fullmatch(commit_sha) is None:
        raise RuntimeError(f"Invalid {label} app commit SHA: {commit_sha}")
    if not version.strip():
        raise RuntimeError(f"Invalid {label} app version: {version}")
    return metadata


parser = parse_document(sys.argv[1])
canonical_parser = parse_document(sys.argv[2])
expected_metadata = runtime_metadata(canonical_parser, "canonical")
observed_metadata = runtime_metadata(parser, "served")
if observed_metadata != expected_metadata:
    raise RuntimeError(
        f"Expected runtime build metadata {expected_metadata}, got {observed_metadata}"
    )

expected_script = [sys.argv[3]]
expected_preloads = {sys.argv[4], *sys.argv[7:]}
expected_stylesheet = sys.argv[5]
expected_clerk_ui_sources = [sys.argv[6]]
if parser.clerk_ui_sources != expected_clerk_ui_sources:
    raise RuntimeError(
        f"Expected one optional Clerk UI source {expected_clerk_ui_sources}, "
        f"got {parser.clerk_ui_sources}"
    )
if parser.module_scripts != expected_script:
    raise RuntimeError(
        f"Expected one CDN app module script {expected_script}, got {parser.module_scripts}"
    )
if (
    len(parser.module_preloads) != len(expected_preloads)
    or set(parser.module_preloads) != expected_preloads
):
    raise RuntimeError(
        f"Expected CDN runtime/vendor modulepreloads {sorted(expected_preloads)}, "
        f"got {parser.module_preloads}"
    )
if len(parser.main_stylesheets) != 1:
    raise RuntimeError(
        f"Expected one main stylesheet preload, got {parser.main_stylesheets}"
    )
main_stylesheet = parser.main_stylesheets[0]
expected_stylesheet_attributes = {
    "as": "style",
    "href": expected_stylesheet,
    "rel": "preload",
}
observed_stylesheet_attributes = {
    name: main_stylesheet.get(name) for name in expected_stylesheet_attributes
}
if (
    observed_stylesheet_attributes != expected_stylesheet_attributes
    or "fetchpriority" in main_stylesheet
):
    raise RuntimeError(
        "Expected main stylesheet preload without fetchpriority "
        f"{expected_stylesheet_attributes}, "
        f"got {main_stylesheet}"
    )
if parser.main_stylesheet_loader_count != 1:
    raise RuntimeError(
        "Expected exactly one main stylesheet loader, "
        f"got {parser.main_stylesheet_loader_count}"
    )
PY
    then
      break
    fi
  else
    curl_status=$?
    {
      printf 'Transport probe failed for %s (curl exit %s)\n' \
        "$document_url" \
        "$curl_status"
      cat "$curl_error"
    } >"$probe_evidence"
  fi

  if ((attempt == document_max_attempts || SECONDS >= document_wait_deadline)); then
    elapsed_seconds=$((SECONDS - document_wait_started))
    printf \
      'App runtime document did not converge for %s after probe %s/%s (%ss); final probe evidence:\n' \
      "$app_url" \
      "$attempt" \
      "$document_max_attempts" \
      "$elapsed_seconds" \
      >&2
    cat "$probe_evidence" >&2
    exit 1
  fi

  printf \
    '::warning title=Waiting for app runtime convergence::%s has not converged (attempt %s/%s)\n' \
    "$document_url" \
    "$attempt" \
    "$document_max_attempts" \
    >&2
  remaining_seconds=$((document_wait_deadline - SECONDS))
  sleep_seconds=$document_retry_delay_seconds
  if ((remaining_seconds < sleep_seconds)); then
    sleep_seconds=$remaining_seconds
  fi
  sleep "$sleep_seconds"
done

for asset_url in \
  "$stylesheet_asset_url" \
  "$app_asset_url" \
  "${vendor_asset_urls[@]}" \
  "$runtime_asset_url" \
  "$clerk_ui_asset_url"; do
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --head \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 6 \
    --retry-delay 2 \
    --retry-max-time 90 \
    --retry-all-errors \
    "$asset_url" >/dev/null
done

worker_status="$(curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --range 0-0 \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 6 \
  --retry-delay 2 \
  --retry-max-time 90 \
  --retry-all-errors \
  --output /dev/null \
  --write-out '%{http_code}' \
  "$worker_asset_url")"
if [[ "$worker_status" != "206" ]]; then
  echo "SharedWorker same-origin proxy returned HTTP ${worker_status}: ${worker_asset_url}" >&2
  exit 1
fi

printf 'Verified app runtime: stylesheet=%s app=%s vendor=%s runtime=%s worker=%s clerk-ui=%s\n' \
  "$stylesheet_asset_url" \
  "$app_asset_url" \
  "${vendor_asset_urls[*]}" \
  "$runtime_asset_url" \
  "$worker_asset_url" \
  "$clerk_ui_asset_url"
