#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
work="$RUNNER_TEMP/okou-ios-archive-proof"
IOS_ARCHIVE_DIR="$work" bash ios/scripts/build-archive.sh
version=$(<ios/version.txt)
# Xcode is not invoked after this point. Preparation must leave compiled files and symbols intact.
python3 ios/scripts/archive-proof.py prepare "$work/Original.xcarchive" "$work/Prepared.xcarchive" \
  --version "$version" --build-number 9999
# Release metadata promotes this archive under a later version. On the real
# bundle, no application metadata may keep the version it was compiled under.
python3 ios/scripts/archive-proof.py prepare "$work/Original.xcarchive" "$work/Promoted.xcarchive" \
  --version 999.0.0 --build-number 9999
python3 - "$work/Promoted.xcarchive" "$version" <<'PY'
import pathlib, plistlib, sys
app = pathlib.Path(sys.argv[1]) / 'Products/Applications/Okou.app'
stale = sorted(
    str(path.relative_to(app))
    for path in app.rglob('Info.plist')
    if plistlib.loads(path.read_bytes()).get('CFBundleShortVersionString') == sys.argv[2]
)
if stale:
    raise SystemExit(f'Promoted bundles kept the compiled version: {stale}')
PY
python3 - "$work" <<'PY'
import hashlib, json, pathlib, subprocess, sys
work = pathlib.Path(sys.argv[1])
manifest = {
    'version': 1,
    'commitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'archiveSha256': hashlib.sha256((work / 'archive.tar.gz').read_bytes()).hexdigest(),
    'purpose': 'archive-promotion-proof-only',
}
(work / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
