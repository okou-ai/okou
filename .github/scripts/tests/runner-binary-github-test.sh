#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$SCRIPT_DIR/runner-binary-github.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/bin" "$TMPDIR/scratch"
export REPO=okou-ai/okou GH_TOKEN=fixture-token RUNNER_TEMP="$TMPDIR/scratch"
export HTTP_LOG="$TMPDIR/http.log"

fail() { echo "FAIL: $1" >&2; exit 1; }

cat > "$TMPDIR/bin/curl" <<'PYTHON'
#!/usr/bin/env python3
import io, json, os, pathlib, stat, sys, urllib.parse, zipfile
args = sys.argv[1:]; url = urllib.parse.urlsplit(args[-1]); mode = os.environ['HTTP_MODE']
output = pathlib.Path(args[args.index('--output')+1])
assert '--max-filesize' in args and '--max-time' in args and '--location-trusted' not in args
storage = url.hostname == 'storage.fixture.test' or url.path.startswith('/storage/')
with open(os.environ['HTTP_LOG'],'a') as log:
    log.write(('storage' if storage else 'api')+' '+url.path+'\n')
if storage:
    assert '--header' not in args, 'authorization was forwarded to storage'
    if mode == 'storage-fail':
        print('signed-url signature=supersecret',file=sys.stderr); sys.exit(7)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as zipped:
        if mode == 'multiple': zipped.writestr('other.json','{}')
        if mode == 'traversal': name = '../manifest.json'
        else: name = 'manifest.json'
        if mode == 'symlink':
            entry = zipfile.ZipInfo(name); entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            zipped.writestr(entry,'/etc/passwd')
        else: zipped.writestr(name,'x'*1048577 if mode == 'oversized-manifest' else '{"fixture":true}')
    output.write_bytes(b'not a zip' if mode == 'invalid-zip' else archive.getvalue())
    print('200',end=''); sys.exit(0)
assert url.hostname == 'api.github.com' and 'Authorization: Bearer fixture-token' in sys.stdin.read()
headers = pathlib.Path(args[args.index('--dump-header')+1]); headers.write_text('HTTP/2 200\r\n')
if mode == 'api-fail':
    print('provider failure signature=supersecret',file=sys.stderr); sys.exit(7)
if url.path.endswith('/actions/artifacts'):
    page = int(urllib.parse.parse_qs(url.query)['page'][0])
    if page == 1 or mode == 'endless':
        headers.write_text('HTTP/2 200\r\nLink: <https://api.github.com/untrusted-next>; rel="next"\r\n')
    output.write_text('x'*1048577 if mode == 'oversized-json' else json.dumps({'artifacts':[{'id':page}]}))
    print('200',end='')
elif url.path.endswith('/zip'):
    assert url.path.endswith('/123/zip'), 'wrong artifact identity'
    origin = 'api.github.com/storage' if mode == 'same-origin-storage' else 'storage.fixture.test'
    location = ('http' if mode == 'unsafe-redirect' else 'https')+'://'+origin+'/123?signature=supersecret'
    text = 'HTTP/2 302\r\nLocation: '+location+'\r\n'
    if mode == 'ambiguous-redirect': text += 'Location: https://other.fixture.test/123\r\n'
    headers.write_text(text); output.write_text(''); print('302',end='')
else:
    output.write_text('{"id":123}'); print('200',end='')
PYTHON
chmod +x "$TMPDIR/bin/curl"
export PATH="$TMPDIR/bin:$PATH"

export HTTP_MODE=valid
name=runner-binary-asset-aarch64-unknown-linux-musl-fixture
pages=$(runner_binary_github_artifacts "$name")
jq -e 'length == 2 and .[0].artifacts[0].id == 1 and .[1].artifacts[0].id == 2' <<<"$pages" >/dev/null ||
  fail "pagination must preserve every complete page"
[ "$(wc -l < "$HTTP_LOG")" -eq 2 ] || fail "unexpected discovery request count"
json=$(runner_binary_github_json actions/runs/123)
jq -e '.id == 123' <<<"$json" >/dev/null || fail "expected bounded API JSON"

for mode in valid same-origin-storage; do
  HTTP_MODE="$mode" runner_binary_github_download 123 "$TMPDIR/$mode" || fail "valid archive download failed"
  jq -e '.fixture == true' "$TMPDIR/$mode/manifest.json" >/dev/null || fail "wrong archive contents"
done

for mode in multiple traversal symlink oversized-manifest invalid-zip unsafe-redirect ambiguous-redirect storage-fail api-fail; do
  if output=$(HTTP_MODE="$mode" runner_binary_github_download 123 "$TMPDIR/$mode" 2>&1); then
    fail "unsafe or failed archive accepted: $mode"
  fi
  [ ! -e "$TMPDIR/$mode/manifest.json" ] || fail "failed archive exposed a manifest: $mode"
  [[ "$output" != *supersecret* ]] || fail "raw signed diagnostics leaked"
done

for mode in endless oversized-json api-fail; do
  : > "$HTTP_LOG"
  if output=$(HTTP_MODE="$mode" runner_binary_github_artifacts "$name" 2>&1); then
    fail "incomplete or failed discovery accepted: $mode"
  fi
  [[ "$output" != *supersecret* ]] || fail "raw discovery diagnostic leaked"
  if [ "$mode" = endless ]; then
    [ "$(wc -l < "$HTTP_LOG")" -eq 8 ] || fail "pagination limit was not enforced"
    [ -z "$output" ] || fail "truncated discovery must not expose partial pages"
  fi
done

[ -z "$(find "$RUNNER_TEMP" -mindepth 1 -print -quit)" ] || fail "owned HTTP scratch was not cleaned"
[ -z "$(find "$TMPDIR" -name '.manifest.*' -print -quit)" ] || fail "manifest staging leaked"

echo "runner-binary-github-test: ok"
