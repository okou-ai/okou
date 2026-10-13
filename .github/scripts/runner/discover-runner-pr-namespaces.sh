#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env GITHUB_OUTPUT
require_env METAL_HOSTS
require_env METAL_USER

declare -A pr_numbers=()
reachable_hosts=0

IFS=',' read -r -a configured_hosts <<<"$METAL_HOSTS"
for configured_host in "${configured_hosts[@]}"; do
  host=${configured_host//[[:space:]]/}
  if [ -z "$host" ]; then
    continue
  fi

  if ! resources=$(ssh "${METAL_USER}@${host}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

systemctl list-units \
  --all \
  --type=service \
  --no-legend \
  --plain \
  'vm0-runner-pr-*' 2>/dev/null | awk '{print $1}'
systemctl list-unit-files \
  --type=service \
  --no-legend \
  --no-pager \
  'vm0-runner-pr-*' 2>/dev/null | awk '{print $1}'

for root in /var/lib/vm0-runner/bin /var/lib/vm0-runner/runners; do
  if [ -d "$root" ]; then
    find "$root" -mindepth 1 -maxdepth 1 -type d -name 'pr-*' -printf '%f\n'
  fi
done

groups_root=/var/lib/vm0-runner/groups
if [ -d "$groups_root" ]; then
  find "$groups_root" \
    -mindepth 2 \
    -maxdepth 2 \
    -type d \
    -name '*-pr-*' \
    -printf '%f\n'
fi
REMOTE_SCRIPT
  ); then
    echo "::warning::Unable to inspect runner resources on ${host}; leaving that host unchanged" >&2
    continue
  fi

  reachable_hosts=$((reachable_hosts + 1))
  while IFS= read -r resource; do
    if [[ "$resource" =~ (^|-)pr-([1-9][0-9]*)(-|$) ]]; then
      pr_numbers["${BASH_REMATCH[2]}"]=1
    fi
  done <<<"$resources"
done

if [ "$reachable_hosts" -eq 0 ]; then
  echo "failed to inspect runner resources on any configured metal host" >&2
  exit 1
fi

if [ "${#pr_numbers[@]}" -eq 0 ]; then
  numbers_json='[]'
else
  numbers_json=$(
    printf '%s\n' "${!pr_numbers[@]}" |
      sort -n |
      jq --compact-output --raw-input --slurp \
        'split("\n") | map(select(length > 0) | tonumber)'
  )
fi

echo "Discovered runner resources for PRs: ${numbers_json}"
printf 'numbers=%s\n' "$numbers_json" >>"$GITHUB_OUTPUT"
