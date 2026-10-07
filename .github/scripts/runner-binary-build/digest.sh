#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
. "${SCRIPT_DIR}/contract.env"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

target="${1:-${TARGET_TRIPLE:-}}"
case "$target" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  "") echo "missing runner binary target" >&2; exit 2 ;;
  *) echo "unsupported runner binary target: ${target}" >&2; exit 2 ;;
esac

revision="${RUNNER_BINARY_GIT_REVISION:-HEAD}"
git -C "$REPO_ROOT" rev-parse --verify "${revision}^{commit}" >/dev/null
cli_package="${GUEST_CLI_PATH:-}"
cli_manifest="${GUEST_CLI_MANIFEST_PATH:-}"
if { [ -n "$cli_package" ] && [ -z "$cli_manifest" ]; } ||
   { [ -z "$cli_package" ] && [ -n "$cli_manifest" ]; }; then
  echo "GUEST_CLI_PATH and GUEST_CLI_MANIFEST_PATH must be provided together" >&2
  exit 2
fi
if [ -n "$cli_package" ]; then
  if [[ "$cli_package" != /* ]]; then
    cli_package="${REPO_ROOT}/${cli_package}"
  fi
  if [[ "$cli_manifest" != /* ]]; then
    cli_manifest="${REPO_ROOT}/${cli_manifest}"
  fi
  for file in "$cli_package" "$cli_manifest"; do
    if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -s "$file" ]; then
      echo "runner CLI build input is not a nonempty regular file: ${file}" >&2
      exit 1
    fi
  done

  cli_size=$(stat -c '%s' "$cli_package")
  manifest_size=$(stat -c '%s' "$cli_manifest")
  # Match the file and identity constraints in crates/runner/build.rs.
  if [ "$cli_size" -gt $((64 * 1024 * 1024)) ] || [ "$manifest_size" -gt $((16 * 1024)) ]; then
    echo "runner CLI build input exceeds its size limit" >&2
    exit 1
  fi
  cli_sha256=$(sha256sum "$cli_package" | awk '{print $1}')
  # Preserve integer token types and reject duplicate consumed fields, as serde
  # does. jq normalizes these invalid manifests into usable cache identities.
  if ! cli_identity=$(python3 - "$cli_manifest" "$cli_sha256" "$cli_size" <<'PY'
import json
import re
import sys


class JsonInteger:
    def __init__(self, token):
        self.token = token


class JsonObject(dict):
    def __init__(self, pairs):
        super().__init__()
        self.duplicates = set()
        for key, value in pairs:
            if key in self:
                self.duplicates.add(key)
            self[key] = value


def fields(value, names):
    if not isinstance(value, JsonObject) or value.duplicates.intersection(names):
        raise ValueError("invalid or duplicate manifest fields")
    # serde decodes every key in a consumed struct, even an ignored field name.
    for key in value:
        key.encode("utf-8")
    return {name: value[name] for name in names}


def release_version(value):
    return isinstance(value, str) and re.fullmatch(
        r"(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})", value
    ) is not None


def invalid_constant(_value):
    raise ValueError("non-JSON numeric constant")


try:
    with open(sys.argv[1], "rb") as file:
        raw = file.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        raise ValueError("oversized manifest")
    manifest = fields(json.loads(
        raw.decode("utf-8"), object_pairs_hook=JsonObject,
        parse_int=JsonInteger, parse_constant=invalid_constant
    ), ("version", "package", "versions", "sessionConstruction"))
    package = fields(manifest["package"], ("path", "sha256", "size"))
    versions = fields(manifest["versions"], ("cli", "piAgentRuntime", "piSdk"))
    session = fields(manifest["sessionConstruction"], ("digest",))
    if (
        not isinstance(manifest["version"], JsonInteger) or manifest["version"].token != "1"
        or package["path"] != "package.tgz" or package["sha256"] != sys.argv[2]
        or not isinstance(package["size"], JsonInteger) or package["size"].token != sys.argv[3]
        or not release_version(versions["cli"])
        or not release_version(versions["piAgentRuntime"])
        or not isinstance(versions["piSdk"], str)
        or not isinstance(session["digest"], str)
        or re.fullmatch(r"[0-9a-f]{64}", session["digest"]) is None
    ):
        raise ValueError("invalid CLI build identity")
    sdk = versions["piSdk"].split("+okou.")
    if len(sdk) != 2 or not release_version(sdk[0]) or re.fullmatch(r"[0-9a-f]{12}", sdk[1]) is None:
        raise ValueError("invalid Pi SDK identity")
except (OSError, ValueError, KeyError, RecursionError):
    sys.exit(1)

# Schema/path are fixed and package SHA/size are bound to the actual bytes.
# Keep their validation above, but hash only the independent compiled identity.
identity = {"versions": versions, "sessionConstruction": session}
print(json.dumps(identity, sort_keys=True, separators=(",", ":")))
PY
  ); then
    echo "runner CLI manifest is invalid or does not match the package: ${cli_manifest}" >&2
    exit 1
  fi
fi
binary_input_digest=$(
  {
    printf '%s\0%s\0' "$RUNNER_BINARY_INPUT_SCHEMA_VERSION" "$target"
    "${SCRIPT_DIR}/context.sh" inventory "$REPO_ROOT" "$revision" || exit 1
    if [ -n "$cli_package" ]; then
      # Package identity contributes only its actual SHA; independent version
      # and session constants remain hashed alongside it.
      printf 'bundled-cli\0%s\0%s\0' "$cli_sha256" "$cli_identity"
    else
      printf 'local-build-without-cli\0'
    fi
  } | sha256sum | awk '{print $1}'
)

emit "binary-input-digest" "$binary_input_digest"
emit "toolchain-image" "$RUNNER_BINARY_TOOLCHAIN_IMAGE"
