#!/usr/bin/env bash
# Matching native CPU only, checked ORIGINAL executables + original package.
# Namespace PID1 supervises live children; no host policy or native overrides.
set -euo pipefail
[[ $# == 4 ]] || { echo 'usage: check-runner-native-supervisor.sh INPUT PACKAGE PROFILE TARGET' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
input=$(realpath "$1"); package=$(realpath "$2"); profile=$3; target=$4
[[ "$profile" == ci || "$profile" == release ]] || exit 1
[[ $(uname -m)-unknown-linux-musl == "$target" ]] || exit 1
python3 -B .github/scripts/runner-native-supervisor.py validate "$input" \
  --package "$package" --profile "$profile" --target "$target" --source-sha "${SOURCE_SHA:?}"
# Only native fixture provisioning. Same signed/extracted independent MIT20.1
# acceptor/KDC as the original controlled-peer job, never installed host packages.
python3 -B -m unittest discover -s crates/rfb-client/tests/fixtures -p qemu_gssapi_runtime_test.py
runtime=$(python3 -B .github/scripts/prepare-kerberos-peer-fixture.py)
receipt="$PWD/crates/target/f5-supervisor-receipt-$profile"
[[ ! -e "$receipt" && ! -L "$receipt" ]] || exit 1
mkdir -m 700 "$receipt"
install -m 600 "$runtime/provider.json" "$receipt/provider.json"
# Install the ORIGINAL checked bytes into the fixed profile/target harness path.
# No lookup, compiler on consumer, replacement helper, or source rebuild.
deps="$PWD/crates/target/$target/$profile/deps"
mkdir -p "$deps"
[[ $(realpath "$deps") == "$deps" ]] || exit 1
for name in process parent_death cleanup_unknown qemu_gssapi; do
  file=$(python3 - "$input/manifest.json" "$name" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['executables'][sys.argv[2]]['file'])
PY
)
  [[ ! -e "$deps/$file" && ! -L "$deps/$file" ]] || exit 1
  install -m 700 "$input/$file" "$deps/$file"
done
owner=$(id -u); group=$(id -g)
status=0
# Child-only tmpfs matches the existing peer harness's 64MiB/256 inode ceiling.
# All test-owned fixture secrets are deleted INSIDE the namespace, not exported.
sudo unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
  bash -c 'set -euo pipefail
    mount -t tmpfs -o size=67108864,nr_inodes=256,mode=0755 none /run
    mkdir -m 700 /run/kerberos-native-fixture
    mkdir -m 700 /run/optimized-results
    export KERBEROS_NATIVE_TEST_ROOT=/run/kerberos-native-fixture
    for name in process parent_death cleanup_unknown; do
      file=$(python3 - "$1/manifest.json" "$name" <<"PY"
import json,sys
print(json.load(open(sys.argv[1]))["executables"][sys.argv[2]]["file"])
PY
)
      env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin KERBEROS_NATIVE_TEST_ROOT=/run/kerberos-native-fixture \
        "$2/$file" --include-ignored --nocapture --test-threads=1 > "/run/optimized-results/$name.txt" & child=$!
      status=0; wait "$child" || status=$?
      install -m 600 -o "$6" -g "$7" "/run/optimized-results/$name.txt" "$5/$name.txt"
      [[ "$status" == 0 ]] || exit "$status"
    done
    peer=$(python3 - "$1/manifest.json" <<"PY"
import json,sys
print(json.load(open(sys.argv[1]))["executables"]["qemu_gssapi"]["file"])
PY
)
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin KERBEROS_NATIVE_TEST_ROOT=/run/kerberos-native-fixture \
      python3 -B crates/rfb-client/tests/fixtures/qemu_gssapi.py --runtime-dir "$3" --controlled-peer-only \
        --test-executable "$2/$peer" --optimized-manifest "$1/manifest.json" > /run/optimized-results/peer.txt & child=$!
    status=0; wait "$child" || status=$?
    install -m 600 -o "$6" -g "$7" /run/optimized-results/peer.txt "$5/peer.txt"
    [[ "$status" == 0 ]] || exit "$status"
    # This proves exact nonzero required tests AND the original peer cleanup.
    python3 -B .github/scripts/runner-native-supervisor.py runtime-finish "$1" --result "$5"
    chown "$6:$7" "$5/receipt.json"' \
  bash "$input" "$deps" "$runtime" "$profile" "$receipt" "$owner" "$group" || status=$?
# Preserve ORIGINAL attribution and compiler bytes whether runtime passed or failed.
for file in manifest.json distribution-build-context.json worker-compiler.json peer-compiler.json validated.json; do
  install -m 600 "$input/$file" "$receipt/$file"
done
exit "$status"
