#!/usr/bin/env bash
# Native x86/ARM protocol controls, independent of the production MIT1.22 worker.
# Build/extract unprivileged; only synthetic runtime runs in disposable mount/PID
# namespaces. No host packages, policy, /run, external KDCs or real credentials.
set -euo pipefail
[[ $# == 0 ]] || { echo 'usage: check-native-gssapi-peer.sh' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
arch=$(uname -m)
case "$arch" in x86_64|aarch64) ;; *) echo 'unsupported native GSSAPI architecture' >&2; exit 1 ;; esac
receipt="$PWD/crates/target/native-gssapi-peer-receipt"
mkdir -p "$receipt"
[[ ! -L "$receipt" && "$(realpath "$receipt")" == "$receipt" ]] || exit 1
for name in compiler.json package.json provider.json tests.txt toolchain.txt executable.txt; do
  [[ ! -L "$receipt/$name" ]] || exit 1
  rm -f -- "$receipt/$name"
done
: > "$receipt/tests.txt"
runtime=$(python3 .github/scripts/prepare-kerberos-peer-fixture.py)
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p rfb-client --test qemu_gssapi --no-run --message-format=json-render-diagnostics \
  > "$receipt/compiler.json"
python3 - "$receipt" "$runtime" "$arch" <<'PY'
import hashlib,json,os,subprocess,sys
from pathlib import Path
receipt,runtime,arch=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
executables=[];builds=[]
for line in (receipt/'compiler.json').read_text().splitlines():
    event=json.loads(line)
    if event.get('reason')=='compiler-artifact' and event.get('executable') and event.get('profile',{}).get('test') and event['target']['name']=='qemu_gssapi':
        executables.append(Path(event['executable']))
    if event.get('reason')=='build-script-executed' and 'KERBEROS_WORKER_SHA256' in dict(event.get('env',[])):
        builds.append(event)
assert len(executables)==1 and len(builds)==1
executable=executables[0];env=dict(builds[0]['env'])
assert executable.is_file() and not executable.is_symlink()
assert env['KERBEROS_WORKER_TARGET']==arch+'-unknown-linux-musl'
helper=Path(builds[0]['out_dir'])/'native/kerberos-worker'
assert hashlib.sha256(helper.read_bytes()).hexdigest()==env['KERBEROS_WORKER_SHA256']
provider=(runtime/'provider.json').read_bytes()
(receipt/'provider.json').write_bytes(provider)
(receipt/'executable.txt').write_text(str(executable)+'\n')
data={'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
      'worktreeDirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),
      'runtimeVerified':False,'runtimeProfile':'privileged-synthetic','runtimeUid':0,'ownerUid':os.geteuid(),
      'architecture':arch,'nativeTarget':env['KERBEROS_WORKER_TARGET'],
      'binarySha256':env['KERBEROS_WORKER_SHA256'],
      'testExecutableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
      'fixtureProviderSha256':hashlib.sha256(provider).hexdigest(),
      'fixtureMitVersion':'1.20.1-6ubuntu2',
      'scope':'independent mutual-GSS/RFC4752/verified-TLS RFB finality controls; not QEMU PNG or product acceptance'}
(receipt/'package.json').write_text(json.dumps(data,indent=2)+'\n')
PY
executable=$(< "$receipt/executable.txt")
# PID1 remains a supervising parent. The two synthetic KDCs plus native input
# roots share a bounded CHILD-ONLY tmpfs; no checkout ancestor is widened.
sudo unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
  bash -c 'set -euo pipefail; mount -t tmpfs -o size=67108864,nr_inodes=256,mode=0755 none /run; mkdir -m 0700 /run/kerberos-native-fixture; export KERBEROS_NATIVE_TEST_ROOT=/run/kerberos-native-fixture; python3 crates/rfb-client/tests/fixtures/qemu_gssapi.py --runtime-dir "$1" --controlled-peer-only --test-executable "$2" & child=$!; wait "$child"' \
  bash "$runtime" "$executable" | tee "$receipt/tests.txt"
cargo --version > "$receipt/toolchain.txt"
rustc --version >> "$receipt/toolchain.txt"
python3 - "$receipt" <<'PY'
import json,sys
from pathlib import Path
receipt=Path(sys.argv[1]);tests=(receipt/'tests.txt').read_text()
assert tests.count('test result: ok. 2 passed; 0 failed; 0 ignored;')==2
assert 'cleanup verified:' in tests
path=receipt/'package.json';data=json.loads(path.read_text());data['runtimeVerified']=True
path.write_text(json.dumps(data,indent=2)+'\n')
PY
