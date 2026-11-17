#!/usr/bin/env bash

TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"
load "${TEST_ROOT}/helpers/failure-diagnostics"

bats::on_failure() {
    # Diagnostics must not replace the assertion's exit status or block cleanup.
    e2e_report_failure "${1:-1}" || true
}

# The wrapper records canonical Okou invocations for CI diagnostics.
export OKOU_CLI="${TEST_ROOT}/helpers/trace-cli.sh"
