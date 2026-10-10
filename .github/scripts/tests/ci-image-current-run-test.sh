#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
waiter=${WAIT_SCRIPT:-"$repo_root/.github/scripts/wait-runner-image.sh"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

# The boundary fixture rejects discovery/sleep and exposes only this run's
# exact-name artifact. The real manifest validator remains in the entrypoint.
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
[ "$1" = run ] && [ "$2" = download ] && [ "$3" = 777 ]
[ "$4" = -n ] && [ "$5" = "$EXPECTED_ARTIFACT" ] && [ "$6" = -D ]
[ "${FAIL_DOWNLOAD:-false}" = false ]
mkdir -p "$7"
cp "$FIXTURE_MANIFEST" "$7/manifest.json"
SH
cat > "$tmp/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 99
SH
chmod +x "$tmp/bin/gh" "$tmp/bin/sleep"
guests=$(bash -c '. "$1"; runner_guest_binaries_load; printf "%s\n" "${RUNNER_GUEST_BINARIES[@]}"' \
  -- "$repo_root/.github/scripts/runner-guest-binaries.sh" | \
  jq -Rn '[inputs] | map({key:.,value:"guest-hash"}) | from_entries')

for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  artifact="runner-image-manifest-${target}-source-sha-pr-42"
  jq -n --arg target "$target" --argjson guests "$guests" '{
    schemaVersion:1,headSha:"source-sha",jobRef:"pr-42",target:$target,
    profile:"vm0/default",binDir:"/bin/pr-42",runnerDir:"/runners/pr-42",
    runnerSha256:"runner-hash",guestSha256:$guests,
    hosts:{"metal-1":{rootfsHash:"rootfs-hash",snapshotHash:"snapshot-hash"}}
  }' > "$tmp/valid.json"
  run_waiter() {
    : > "$tmp/gh.log"
    : > "$tmp/output"
    env PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" EXPECTED_ARTIFACT="$artifact" \
      FIXTURE_MANIFEST="$tmp/manifest.json" FAIL_DOWNLOAD="${FAIL_DOWNLOAD:-false}" \
      HEAD_SHA=source-sha JOB_REF=pr-42 TARGET="$target" PROFILE=vm0/default \
      METAL_HOSTS=metal-1 SELECTED_HOST=metal-1 REPO=test/repo GITHUB_REPOSITORY=test/repo \
      GITHUB_RUN_ID=777 RUNNER_IMAGE_RUN_ID="${PRODUCER_ID-777}" \
      GITHUB_OUTPUT="$tmp/output" OUTPUT_DIR="$tmp/download" \
      bash "$waiter" > "$tmp/stdout" 2> "$tmp/stderr"
  }
  cp "$tmp/valid.json" "$tmp/manifest.json"
  run_waiter
  [ "$(wc -l < "$tmp/gh.log")" -eq 1 ]
  grep -qx 'producer-run-id=777' "$tmp/output"
  grep -qx 'selected-rootfs-hash=rootfs-hash' "$tmp/output"
  # A consumer-only rerun still uses the same run, independently of attempt.
  GITHUB_RUN_ATTEMPT=2 run_waiter
  [ "$(wc -l < "$tmp/gh.log")" -eq 1 ]
  for id in 778 invalid 0 ''; do
    if PRODUCER_ID="$id" run_waiter; then echo 'invalid producer accepted' >&2; exit 1; fi
    [ ! -s "$tmp/gh.log" ]
  done
  if FAIL_DOWNLOAD=true run_waiter; then echo 'missing artifact accepted' >&2; exit 1; fi
  [ "$(wc -l < "$tmp/gh.log")" -eq 1 ]
  for mutation in '.headSha="stale"' '.jobRef="other"' '.target="unsupported"' \
    '.profile="other"' '.runnerSha256=""' 'del(.hosts["metal-1"])' 'del(.guestSha256["guest-agent"])'; do
    jq "$mutation" "$tmp/valid.json" > "$tmp/manifest.json"
    if run_waiter; then echo "invalid manifest accepted: $mutation" >&2; exit 1; fi
    [ "$(wc -l < "$tmp/gh.log")" -eq 1 ]
  done
  printf '{' > "$tmp/manifest.json"
  if run_waiter; then echo 'malformed manifest accepted' >&2; exit 1; fi
  [ "$(wc -l < "$tmp/gh.log")" -eq 1 ]
done

echo 'ci-image-current-run-test: ok'
