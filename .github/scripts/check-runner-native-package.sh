#!/usr/bin/env bash
# Actual already-validated Runner on matching native CPU. Only child /run changes.
set -euo pipefail
[[ $# == 5 || $# == 9 ]] || { echo 'usage: check-runner-native-package.sh RUNNER METADATA PROVENANCE TARGET OUTPUT [--profile release --compiler-receipt JSON]' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
runner=$(realpath "$1"); metadata=$(realpath "$2"); provenance=$(realpath "$3"); target=$4
profile=ci; compiler=''
if [[ $# == 9 ]]; then
  [[ $6 == --profile && $7 == release && $8 == --compiler-receipt ]] || exit 1
  profile=release; compiler=$(realpath "$9")
fi
receipt="$PWD/$5"
[[ ! -e "$receipt" && ! -L "$receipt" && "$receipt" == "$PWD/crates/target/"* ]] || exit 1
[[ $(realpath "$(dirname "$receipt")")/$(basename "$receipt") == "$receipt" ]] || exit 1
mkdir -m 700 "$receipt"
owner=$(id -u); group=$(id -g)
status=0
sudo unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
  bash -c 'set -euo pipefail
    mount -t tmpfs -o size=67108864,nr_inodes=256,mode=0755 none /run
    extra=(); if [[ "$8" == release ]]; then extra=(--compiler-receipt "$9"); fi
    # Preserve only non-secret consumer identity, not caller tokens/environment.
    export GITHUB_RUN_ID="${10}" GITHUB_RUN_ATTEMPT="${11}"
    python3 -B .github/scripts/check-runner-native-package.py --runner "$1" --metadata "$2" --provenance "$3" --target "$4" --profile "$8" --out /run/f5-package --runtime-profile privileged-synthetic "${extra[@]}" & child=$!
    status=0; wait "$child" || status=$?
    # Keep real package evidence after a native failure, explicitly runtime=false.
    # A receipt exists only after the package/ELF/source checks; propagate failure.
    if [[ -f /run/f5-package/receipt.json && ! -L /run/f5-package/receipt.json ]]; then
      for file in identity.json helper notices.txt elf.txt receipt.json; do
        [[ -f "/run/f5-package/$file" && ! -L "/run/f5-package/$file" ]] || exit 1
        install -m 600 -o "$6" -g "$7" "/run/f5-package/$file" "$5/$file"
      done
    elif [[ "$status" == 0 ]]; then
      exit 1
    fi
    exit "$status"' bash "$runner" "$metadata" "$provenance" "$target" "$receipt" "$owner" "$group" "$profile" "$compiler" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" || status=$?
# These are original supplied bytes, not freshly relabeled producer identities.
for source in "$metadata" "$provenance"; do [[ -f "$source" && ! -L "$source" ]] || exit 1; done
install -m 600 "$metadata" "$receipt/producer-metadata.json"
install -m 600 "$provenance" "$receipt/producer-manifest.json"
exit "$status"
