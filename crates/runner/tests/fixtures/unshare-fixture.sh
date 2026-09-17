#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" != -- ]]; do shift; done
shift
# bash -c <namespace init script> <argv0>
shift 4
while [[ "$1" != -- ]]; do shift; done
shift
exec bash "$@"
