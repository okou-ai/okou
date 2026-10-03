#!/usr/bin/env bash
# Build unprivileged; execute only synthetic conformance in a disposable native
# mount/PID namespace. No host sysctl/AppArmor/Kerberos/device-policy changes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
arch=$(uname -m)
uid=$(id -u)
gid=$(id -g)
case "$arch" in x86_64|aarch64) ;; *) echo 'unsupported native Kerberos CI architecture' >&2; exit 1 ;; esac
receipt="$PWD/crates/target/native-kerberos-receipt"
mkdir -p "$receipt"
[[ ! -L "$receipt" && "$(realpath "$receipt")" == "$receipt" ]] || exit 1
# A repeated local invocation must not label stale package/tests as this run.
for name in compiler.json elf.txt package.json executables.txt tests.txt toolchain.txt notices.txt; do
  [[ ! -L "$receipt/$name" ]] || exit 1
  rm -f -- "$receipt/$name"
done
: > "$receipt/tests.txt"
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p kerberos-worker --lib --test process --test cleanup_unknown --no-run \
  --message-format=json-render-diagnostics > "$receipt/compiler.json"
python3 - "$receipt" "$arch" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
receipt=Path(sys.argv[1]);arch=sys.argv[2];executables={};builds=[]
for line in (receipt/'compiler.json').read_text().splitlines():
    event=json.loads(line)
    if event.get('reason')=='compiler-artifact' and event.get('executable') and event.get('profile',{}).get('test'):
        name=event['target']['name']
        if name in ('kerberos_worker','process','cleanup_unknown'):
            assert name not in executables
            executables[name]=event['executable']
    if event.get('reason')=='build-script-executed' and 'KERBEROS_WORKER_SHA256' in dict(event.get('env',[])):
        builds.append(event)
assert set(executables)=={'kerberos_worker','process','cleanup_unknown'} and len(builds)==1
build=builds[0];env=dict(build['env']);binary=Path(build['out_dir'])/'native/kerberos-worker'
assert env['KERBEROS_WORKER_TARGET']==f'{arch}-unknown-linux-musl'
sha=hashlib.sha256(binary.read_bytes()).hexdigest();assert sha==env['KERBEROS_WORKER_SHA256']
notices=b'\n'.join((Path(build['out_dir'])/'native'/name).read_bytes() for name in ('NOTICE-MIT','NOTICE-musl','NOTICE-Zig'))
notice_sha=hashlib.sha256(notices).hexdigest();assert notice_sha==env['KERBEROS_WORKER_NOTICES_SHA256']
for executable in executables.values():
    assert notices in Path(executable).read_bytes(), 'linked native consumer did not retain redistribution notices'
(receipt/'notices.txt').write_bytes(notices)
headers=subprocess.check_output(['readelf','-h','-l','-d',str(binary)],text=True)
assert 'INTERP' not in headers and '(NEEDED)' not in headers
machine='AArch64' if arch=='aarch64' else 'Advanced Micro Devices X86-64';assert machine in headers
(receipt/'elf.txt').write_text(headers)
(receipt/'package.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'worktreeDirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),'runtimeVerified':False,'nativeTarget':env['KERBEROS_WORKER_TARGET'],'binarySha256':sha,'noticesSha256':notice_sha,'mitVersion':'1.22.2','mitSourceSha256':'3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13'},indent=2)+'\n')
(receipt/'executables.txt').write_text('\n'.join(executables[name] for name in ('kerberos_worker','process','cleanup_unknown'))+'\n')
PY
while IFS= read -r executable; do
  # PID1 must supervise the test process rather than exec it: native PDEATHSIG
  # requires a real live parent, and this namespace dies with its supervisor.
  # Drop back to the ORIGINAL file owner before the test/worker runs. Mapping
  # only outer UID0 inside a new user namespace cannot traverse private checkout
  # ancestors owned by the runner UID; widening those permissions is not a fix.
  sudo unshare --mount --pid --fork --kill-child --mount-proc \
    bash -c 'set -e; setpriv --reuid "$2" --regid "$3" --clear-groups --bounding-set=-all "$1" --include-ignored --test-threads=1 & child=$!; wait "$child"' \
    bash "$executable" "$uid" "$gid" | tee -a "$receipt/tests.txt"
done < "$receipt/executables.txt"
cargo --version > "$receipt/toolchain.txt"
rustc --version >> "$receipt/toolchain.txt"
python3 - "$receipt/package.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);data=json.loads(path.read_text());data['runtimeVerified']=True
path.write_text(json.dumps(data,indent=2)+'\n')
PY
