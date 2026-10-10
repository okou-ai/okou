#!/usr/bin/env bash
# Build unprivileged; execute only synthetic conformance in a disposable native
# mount/PID namespace. No host sysctl/AppArmor/Kerberos/device-policy changes.
# CI explicitly selects a privileged synthetic caller BEFORE worker bootstrap;
# that is not production/non-root availability or a runtime worker fallback.
set -euo pipefail
runtime_profile=owner
if [[ $# == 1 && $1 == --privileged-synthetic ]]; then
  runtime_profile=privileged-synthetic
elif [[ $# != 0 ]]; then
  echo 'usage: check-native-kerberos.sh [--privileged-synthetic]' >&2
  exit 1
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
source .github/scripts/native-test-environment.sh
arch=$(uname -m)
uid=$native_uid
gid=$native_gid
case "$arch" in x86_64|aarch64) ;; *) echo 'unsupported native Kerberos CI architecture' >&2; exit 1 ;; esac
receipt="$PWD/crates/target/native-kerberos-receipt"
native_build mkdir -p "$receipt"
[[ ! -L "$receipt" && "$(realpath "$receipt")" == "$receipt" ]] || exit 1
# A repeated local invocation must not label stale package/tests as this run.
for name in compiler.json elf.txt package.json executables.txt tests.txt toolchain.txt notices.txt platform.txt; do
  [[ ! -L "$receipt/$name" ]] || exit 1
  rm -f -- "$receipt/$name"
done
: > "$receipt/tests.txt"
{
  printf 'selected runtime profile: %s\n' "$runtime_profile"
  # Introspection only; never write host policy or infer availability from a sysctl.
  for setting in user/max_user_namespaces kernel/unprivileged_userns_clone kernel/apparmor_restrict_unprivileged_userns; do
    if [[ -f "/proc/sys/$setting" ]]; then
      printf '%s=' "$setting"
      head -c 64 "/proc/sys/$setting"
      printf '\n'
    fi
  done
} > "$receipt/platform.txt"
native_build cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p kerberos-worker --lib --test process --test parent_death --test cleanup_unknown --no-run \
  --message-format=json-render-diagnostics > "$receipt/compiler.json"
native_build python3 - "$receipt" "$arch" "$runtime_profile" "$uid" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
receipt=Path(sys.argv[1]);arch=sys.argv[2];runtime_profile=sys.argv[3];uid=int(sys.argv[4]);executables={};builds=[]
for line in (receipt/'compiler.json').read_text().splitlines():
    event=json.loads(line)
    if event.get('reason')=='compiler-artifact' and event.get('executable') and event.get('profile',{}).get('test'):
        name=event['target']['name']
        if name in ('kerberos_worker','process','parent_death','cleanup_unknown'):
            assert name not in executables
            executables[name]=event['executable']
    if event.get('reason')=='build-script-executed' and 'KERBEROS_WORKER_SHA256' in dict(event.get('env',[])):
        builds.append(event)
assert set(executables)=={'kerberos_worker','process','parent_death','cleanup_unknown'} and len(builds)==1
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
(receipt/'package.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'worktreeDirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),'runtimeVerified':False,'runtimeProfile':runtime_profile,'runtimeUid':0 if runtime_profile=='privileged-synthetic' else uid,'ownerUid':uid,'ownerBootstrap':'not-checked','nativeTarget':env['KERBEROS_WORKER_TARGET'],'binarySha256':sha,'noticesSha256':notice_sha,'mitVersion':'1.22.2','mitSourceSha256':'3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13'},indent=2)+'\n')
(receipt/'executables.txt').write_text('\n'.join(executables[name] for name in ('kerberos_worker','process','parent_death','cleanup_unknown'))+'\n')
PY
# Always exercise the recorded build owner's availability/refusal boundary, without
# capabilities. Restricted Ubuntu/AppArmor may refuse before Ready; the test
# checks cleanup and no alternate backend rather than calling that a native pass.
process_executable=$(head -n 2 "$receipt/executables.txt" | tail -n 1)
native_privileged unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
  bash -c 'set -e; setpriv --reuid "$2" --regid "$3" --clear-groups --bounding-set=-all "$1" --exact supported_or_explicitly_unavailable_bootstrap_never_uses_another_backend --nocapture & child=$!; wait "$child"' \
  bash "$process_executable" "$uid" "$gid" | tee -a "$receipt/tests.txt"
native_build python3 - "$receipt/package.json" "$receipt/tests.txt" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);data=json.loads(path.read_text());tests=Path(sys.argv[2]).read_text()
markers=[line.split('owner bootstrap: ',1)[1] for line in tests.splitlines() if 'owner bootstrap: ' in line]
assert len(markers)==1 and markers[0] in ('supported','explicitly unavailable')
data['ownerBootstrap']=markers[0]
path.write_text(json.dumps(data,indent=2)+'\n')
PY
while IFS= read -r executable; do
  # PID1 supervises rather than execs: native PDEATHSIG needs a real live parent.
  # Explicit CI synthetic-root mode retains only the namespace harness's
  # bootstrap privilege. The unchanged worker must remove all capabilities and
  # pass readonly-root/Landlock/seccomp self-checks BEFORE Ready/any credential.
  # Root fixtures use a bounded CHILD-ONLY tmpfs, not another UID's private checkout
  # ancestors (unmapped after native unshare). Owner mode still uses its actual
  # files/UID; never widen ancestors or alter the host /run/device/policy view.
  native_privileged unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
    bash -c 'set -e; if [[ "$4" == privileged-synthetic ]]; then mount -t tmpfs -o size=67108864,nr_inodes=128,mode=0755 none /run; mkdir -m 0700 /run/kerberos-native-fixture; export KERBEROS_NATIVE_TEST_ROOT=/run/kerberos-native-fixture; "$1" --include-ignored --test-threads=1 & else setpriv --reuid "$2" --regid "$3" --clear-groups --bounding-set=-all "$1" --include-ignored --test-threads=1 & fi; child=$!; wait "$child"' \
    bash "$executable" "$uid" "$gid" "$runtime_profile" | tee -a "$receipt/tests.txt"
done < "$receipt/executables.txt"
native_build cargo --version > "$receipt/toolchain.txt"
native_build rustc --version >> "$receipt/toolchain.txt"
native_build python3 - "$receipt/package.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);data=json.loads(path.read_text());data['runtimeVerified']=True
path.write_text(json.dumps(data,indent=2)+'\n')
PY
