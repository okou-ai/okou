#!/usr/bin/env bash

runner_host_uname_m() {
  local remote=$1 output status
  if output=$(ssh -n "$remote" uname -m); then
    :
  else
    status=$?
    [ "$status" -eq 255 ] || return "$status"
    # The SSH wrapper owns connection selection. Reissue only this read.
    printf 'Retrying SSH uname -m on %s after exit 255\n' "${remote#*@}" >&2
    output=$(ssh -n "$remote" uname -m) || return $?
  fi
  printf '%s\n' "$output" | tail -n1 | tr -d '\r'
}
