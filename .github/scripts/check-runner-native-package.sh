#!/usr/bin/env bash
# Actual already-validated Runner, on matching native CPU, no provider download
# or credentials here. Only the disposable child /run is changed.
set -euo pipefail
[[ $# == 5 ]] || { echo 'usage: check-runner-native-package.sh RUNNER METADATA PROVENANCE TARGET OUTPUT' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
runner=$(realpath "$1"); metadata=$(realpath "$2"); provenance=$(realpath "$3"); target=$4
receipt="$PWD/$5"
[[ ! -e "$receipt" && ! -L "$receipt" && "$receipt" == "$PWD/crates/target/"* ]] || exit 1
[[ $(realpath "$(dirname "$receipt")")/$(basename "$receipt") == "$receipt" ]] || exit 1
mkdir -m 700 "$receipt"
owner=$(id -u); group=$(id -g)
sudo unshare --mount --pid --fork --kill-child --mount-proc --propagation private \
  bash -c 'set -euo pipefail
    mount -t tmpfs -o size=67108864,nr_inodes=256,mode=0755 none /run
    python3 -B .github/scripts/check-runner-native-package.py --runner "$1" --metadata "$2" --provenance "$3" --target "$4" --profile ci --out /run/f5-package --runtime-profile privileged-synthetic & child=$!
    wait "$child"
    for file in identity.json helper notices.txt elf.txt receipt.json; do
      [[ -f "/run/f5-package/$file" && ! -L "/run/f5-package/$file" ]] || exit 1
      install -m 600 -o "$6" -g "$7" "/run/f5-package/$file" "$5/$file"
    done' bash "$runner" "$metadata" "$provenance" "$target" "$receipt" "$owner" "$group"
