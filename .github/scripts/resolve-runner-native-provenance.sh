#!/usr/bin/env bash
# Keep an original manifest; never fabricate compiler identity for cached bytes.
# Uses the existing bounded GitHub metadata index, not guessed R2 keys/accounts.
set -euo pipefail
[[ $# == 3 ]] || exit 1
target=$1; digest=$2; transport=$3
[[ "$digest" =~ ^[0-9a-f]{64}$ && -d "$transport" && ! -L "$transport" ]] || exit 1
. .github/scripts/runner-image-target.sh
runner_image_validate_target "$target"
if [[ -f "$transport/manifest.json" && ! -L "$transport/manifest.json" ]]; then exit 0; fi
name="runner-binary-asset-$target-$digest"
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}"
[[ ! -e "$transport/provenance-index" ]] || exit 1
mkdir -m 700 "$transport/provenance-index"
gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=5" > "$transport/provenance-index/artifacts.json"
mapfile -t runs < <(jq -r --arg name "$name" '.artifacts[] | select(.name==$name and .expired==false and .size_in_bytes>0 and .size_in_bytes<65536) | .workflow_run.id' "$transport/provenance-index/artifacts.json")
for run in "${runs[@]}"; do
  [[ "$run" =~ ^[1-9][0-9]*$ ]] || exit 1
  candidate="$transport/provenance-index/$run"
  mkdir -m 700 "$candidate"
  if ! timeout 30s gh run download "$run" --repo "$GITHUB_REPOSITORY" -n "$name" -D "$candidate"; then continue; fi
  [[ -f "$candidate/manifest.json" && ! -L "$candidate/manifest.json" ]] || exit 1
  if jq -e --arg target "$target" --arg digest "$digest" --argjson run "$run" --slurpfile m "$transport/metadata.json" \
    '.producer.runId==$run and .target==$target and .binaryInputDigest==$digest and .runner.sha256==$m[0].runnerSha256 and .runner.sizeBytes==$m[0].runnerSizeBytes' "$candidate/manifest.json" >/dev/null; then
    cp -- "$candidate/manifest.json" "$transport/manifest.json"
    exit 0
  fi
done
echo 'original cached Runner producer metadata unavailable; no fabricated attribution' >&2
exit 1
