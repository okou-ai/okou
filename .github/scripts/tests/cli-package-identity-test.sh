#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fixture="${tmp_dir}/repo"
mkdir -p "${fixture}/turbo/apps/cli/scripts" "${fixture}/turbo/apps/cli/dist" \
  "${fixture}/turbo/packages/pi-agent-runtime" "${fixture}/turbo/patches" \
  "${fixture}/.github/scripts"
cp "${repo_root}/turbo/apps/cli/scripts/write-dist-package.mjs" "${fixture}/turbo/apps/cli/scripts/"
for script in build-okou-cli-artifact.sh verify-okou-cli-artifact.sh read-okou-cli-package-identity.py; do
  cp "${repo_root}/.github/scripts/${script}" "${fixture}/.github/scripts/"
done
# The unchanged postbuild projection supplies this dist package; exercise the
# new identity writer and the actual artifact packer against synthetic JS assets.
cat > "${fixture}/turbo/apps/cli/dist/package.json" <<'JSON'
{"name":"@okouai/cli","version":"9.353.0","private":true,"bin":{"okou":"okou.js"},"files":["*.js","*.js.map","*.wasm","migrations/*.sql"]}
JSON
cat > "${fixture}/turbo/packages/pi-agent-runtime/package.json" <<'JSON'
{"version":"1.36.0","dependencies":{"@earendil-works/pi-coding-agent":"0.86.1"}}
JSON
jq -n '{digest: ("d" * 64)}' > "${fixture}/turbo/packages/pi-agent-runtime/session-construction-digest.json"
printf 'first patch\n' > "${fixture}/turbo/patches/@earendil-works__a.patch"
printf 'second patch\n' > "${fixture}/turbo/patches/@earendil-works__b.patch"
for asset in okou.js image-resize-worker.js photon_rs_bg.wasm; do
  printf 'synthetic %s\n' "$asset" > "${fixture}/turbo/apps/cli/dist/${asset}"
done
node "${fixture}/turbo/apps/cli/scripts/write-dist-package.mjs"
expected_sdk_patch_set="$(cat "${fixture}/turbo/patches/@earendil-works__a.patch" "${fixture}/turbo/patches/@earendil-works__b.patch" | sha256sum | cut -c1-12)"
jq -e --arg sdk "0.86.1+okou.${expected_sdk_patch_set}" '(.scripts == null) and (.devDependencies == null)
  and .version == "9.353.0" and .okouBuildIdentity.schemaVersion == 1
  and .okouBuildIdentity.piAgentRuntime == "1.36.0"
  and .okouBuildIdentity.piSdk == $sdk
  and (.okouBuildIdentity | has("commitSha") | not)' \
  "${fixture}/turbo/apps/cli/dist/package.json" >/dev/null

build() {
  (cd "$fixture" && bash .github/scripts/build-okou-cli-artifact.sh "$1" "$2")
}
build aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "${tmp_dir}/first" >/dev/null
first_sha="$(jq -r '.package.sha256' "${tmp_dir}/first/manifest.json")"

# Packaging must use the already-built package identity, not reread the workspace.
jq '.version = "1.36.1"' "${fixture}/turbo/packages/pi-agent-runtime/package.json" > "${tmp_dir}/runtime.json"
mv "${tmp_dir}/runtime.json" "${fixture}/turbo/packages/pi-agent-runtime/package.json"
jq -n '{digest: ("e" * 64)}' > "${fixture}/turbo/packages/pi-agent-runtime/session-construction-digest.json"
build bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "${tmp_dir}/second" >/dev/null
cmp "${tmp_dir}/first/package.tgz" "${tmp_dir}/second/package.tgz"
jq -e '.versions.piAgentRuntime == "1.36.0" and .sessionConstruction.digest == ("d" * 64)' \
  "${tmp_dir}/second/manifest.json" >/dev/null

# A new preparation records the new identity in bytes, which must rotate SHA.
node "${fixture}/turbo/apps/cli/scripts/write-dist-package.mjs"
build bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "${tmp_dir}/third" >/dev/null
[ "$(jq -r '.package.sha256' "${tmp_dir}/third/manifest.json")" != "$first_sha" ] || {
  echo 'Changed packed identity did not change package SHA' >&2; exit 1;
}

# Exercise the real bounded reader on invalid tar/JSON inputs, without extraction.
python3 - "$tmp_dir" "${repo_root}/.github/scripts/read-okou-cli-package-identity.py" <<'PY'
import io, json, pathlib, subprocess, sys, tarfile
root = pathlib.Path(sys.argv[1])
reader = sys.argv[2]
metadata = {"name":"@okouai/cli","version":"9.353.0","okouBuildIdentity":{
    "schemaVersion":1,"piAgentRuntime":"1.36.0","piSdk":"0.86.1+okou.0123456789ab",
    "sessionConstruction":{"digest":"d"*64}}}
valid = json.dumps(metadata).encode()
cases = {
    "missing-record": [json.dumps({"name":"@okouai/cli","version":"9.353.0"}).encode()],
    "duplicate-entry": [valid, valid],
    "leading-dot-duplicate-entry": [valid, valid.replace(b'9.353.0', b'9.353.1')],
    "noncanonical-metadata": [valid],
    "duplicate-consumed-field": [valid.replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1')],
    "oversized-metadata": [valid + b' ' * (16*1024)],
    "invalid-utf8": [valid + b'\xff'],
    "float-schema": [valid.replace(b'"schemaVersion": 1', b'"schemaVersion": 1.0')],
    "invalid-runtime": [valid.replace(b'1.36.0', b'01.36.0')],
    "invalid-sdk": [valid.replace(b'0123456789ab', b'0123456789AB')],
    "invalid-session": [valid.replace(b'd'*64, b'e'*63)],
    "symlink-metadata": [None],
}
for name, values in cases.items():
    path = root / (name + '.tgz')
    with tarfile.open(path, 'w:gz') as archive:
        for index, value in enumerate(values):
            entry_name = 'package/package.json'
            if name == 'noncanonical-metadata':
                entry_name = 'package//package.json'
            elif name == 'leading-dot-duplicate-entry' and index == 1:
                entry_name = './package/package.json'
            entry = tarfile.TarInfo(entry_name)
            if value is None:
                entry.type = tarfile.SYMTYPE
                entry.linkname = 'elsewhere.json'
                archive.addfile(entry)
            else:
                entry.size = len(value)
                archive.addfile(entry, io.BytesIO(value))
    result = subprocess.run([sys.executable, reader, str(path)], capture_output=True, text=True)
    assert result.returncode != 0 and not result.stdout, (name, result.stdout, result.stderr)
class Zeros:
    def read(self, size):
        return b'\0' * size

budget = root / 'archive-budget.tgz'
with tarfile.open(budget, 'w:gz') as archive:
    entry = tarfile.TarInfo('package/package.json')
    entry.size = len(valid)
    archive.addfile(entry, io.BytesIO(valid))
    padding = tarfile.TarInfo('package/padding')
    padding.size = 256*1024*1024 + 1
    archive.addfile(padding, Zeros())
result = subprocess.run([sys.executable, reader, str(budget)], capture_output=True, text=True)
assert result.returncode != 0 and not result.stdout and 'decompressed size' in result.stderr, result.stderr
print('bounded CLI package rejection fixtures: ok')
PY

echo 'cli-package-identity-test: ok'
