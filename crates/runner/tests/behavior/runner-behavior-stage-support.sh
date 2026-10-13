#!/usr/bin/env bash
# Source-only checksum-verified staging for the two native behavior drivers.

stage_runner_behavior_support() {
  local remote=$1
  local source=$2
  local destination=$3
  local expected_sha256
  local attempts=3
  local attempt
  local status

  if [[ ! "$destination" =~ ^/[a-zA-Z0-9._/-]+$ ]] \
    || [[ "/$destination/" == *"/../"* ]] \
    || [[ "/$destination/" == *"/./"* ]]; then
    echo "unsafe Runner behavior support destination: $destination" >&2
    return 2
  fi
  expected_sha256=$(sha256sum "$source" | awk '{print $1}') || return "$?"

  for attempt in $(seq 1 "$attempts"); do
    status=0
    # The destination is derived from the workflow-owned job reference.
    # shellcheck disable=SC2029
    ssh "$remote" "set -eu
umask 077
destination='${destination}'
expected_sha256='${expected_sha256}'
source_tmp=\$(mktemp)
published_tmp=''
cleanup() {
  rm -f -- \"\$source_tmp\"
  if [ -n \"\$published_tmp\" ]; then
    sudo rm -f -- \"\$published_tmp\"
  fi
}
trap cleanup EXIT
cat > \"\$source_tmp\"
actual_sha256=\$(sha256sum \"\$source_tmp\" | awk '{print \$1}')
if [ \"\$actual_sha256\" != \"\$expected_sha256\" ]; then
  echo \"Runner behavior support worker checksum mismatch\" >&2
  exit 1
fi
published_tmp=\$(sudo mktemp \"\${destination}.XXXXXX\")
sudo install -m 0755 \"\$source_tmp\" \"\$published_tmp\"
sudo mv -- \"\$published_tmp\" \"\$destination\"
published_tmp=''
" < "$source" || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$attempts" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while staging Runner behavior support worker; retrying (${attempt}/${attempts})" >&2
    sleep "$attempt"
  done
}
