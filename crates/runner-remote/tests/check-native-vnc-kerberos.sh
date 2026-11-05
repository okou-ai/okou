#!/usr/bin/env bash
# Build as the ordinary owner, then exercise synthetic VNC contention in private
# mount/PID namespaces. Requires the native Kerberos harness environment and
# sudo (or CI's explicit NATIVE_TEST_OWNER bootstrap). No real credentials/KDCs.
# Writes exact-head package/executable receipts; any missing/failed test is fatal.
set -euo pipefail
[[ $# == 0 ]] || { echo 'usage: check-native-vnc-kerberos.sh' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
source crates/kerberos-worker/tests/native-test-environment.sh
receipt="$PWD/crates/target/native-vnc-kerberos-receipt"
native_build mkdir -p "$receipt"
[[ ! -L "$receipt" && "$(realpath "$receipt")" == "$receipt" ]] || exit 1
for name in compiler.json package.json executable.txt tests.txt; do
  [[ ! -L "$receipt/$name" ]] || exit 1
  rm -f -- "$receipt/$name"
done
: > "$receipt/tests.txt"
native_build cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-remote --lib --no-run --message-format=json-render-diagnostics > "$receipt/compiler.json"
native_build python3 - "$receipt" <<'PY'
import hashlib,json,platform,subprocess,sys
from pathlib import Path
receipt=Path(sys.argv[1]);executables=[];builds=[]
for line in (receipt/'compiler.json').read_text().splitlines():
    event=json.loads(line)
    if event.get('reason')=='compiler-artifact' and event.get('executable') and event.get('profile',{}).get('test') and event['target']['name']=='runner_remote':
        executables.append(Path(event['executable']))
    if event.get('reason')=='build-script-executed' and 'KERBEROS_WORKER_SHA256' in dict(event.get('env',[])):
        builds.append(event)
assert len(executables)==1 and len(builds)==1
executable=executables[0];build=builds[0];env=dict(build['env'])
assert executable.is_file() and not executable.is_symlink()
assert env['KERBEROS_WORKER_TARGET']==platform.machine()+'-unknown-linux-musl'
helper=Path(build['out_dir'])/'native/kerberos-worker'
assert hashlib.sha256(helper.read_bytes()).hexdigest()==env['KERBEROS_WORKER_SHA256']
(receipt/'executable.txt').write_text(str(executable)+'\n')
(receipt/'package.json').write_text(json.dumps({
    'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
    'worktreeDirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),
    'nativeTarget':env['KERBEROS_WORKER_TARGET'],'binarySha256':env['KERBEROS_WORKER_SHA256'],
    'testExecutableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
    'runtimeProfile':'privileged-synthetic','runtimeVerified':False,
    'scope':'real native VNC contention, short ordinary RPC/check budgets, cancellation and admission recovery; not deployed Runner latency'
},indent=2)+'\n')
PY
executable=$(< "$receipt/executable.txt")
for scenario in \
  vnc::tests::native::kerberos_admission::busy_kerberos_handshakes_allow_ordinary_start_and_check_in_another_run \
  vnc::tests::native::kerberos_admission::kerberos_negotiation_uses_the_final_authority_response_without_another_retry \
  vnc::tests::native::diagnostics::native_kdc_trust_failure_keeps_separate_rfb_and_kdc_configuration_receipts; do
  native_privileged unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
    bash -s -- "$executable" "$scenario" <<'RUNTIME' | tee -a "$receipt/tests.txt"
set -euo pipefail
mount -t tmpfs -o size=67108864,nr_inodes=512,mode=0755 none /run
mkdir -m 0700 /run/kerberos-native-fixture
export TMPDIR=/run/kerberos-native-fixture
"$1" --ignored --exact "$2" --test-threads=1 &
child=$!
wait "$child"
RUNTIME
done
native_build python3 - "$receipt" <<'PY'
import json,sys
from pathlib import Path
receipt=Path(sys.argv[1]);tests=(receipt/'tests.txt').read_text()
for name in (
    'vnc::tests::native::kerberos_admission::busy_kerberos_handshakes_allow_ordinary_start_and_check_in_another_run',
    'vnc::tests::native::kerberos_admission::kerberos_negotiation_uses_the_final_authority_response_without_another_retry',
    'vnc::tests::native::diagnostics::native_kdc_trust_failure_keeps_separate_rfb_and_kdc_configuration_receipts',
):
    assert tests.count('test '+name+' ... ok')==1, name
assert tests.count('test result: ok. 1 passed; 0 failed; 0 ignored;')==3
path=receipt/'package.json';data=json.loads(path.read_text());data['runtimeVerified']=True
path.write_text(json.dumps(data,indent=2)+'\n')
PY
