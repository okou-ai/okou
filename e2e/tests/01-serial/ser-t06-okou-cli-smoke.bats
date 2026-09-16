#!/usr/bin/env bats
# Smoke tests for the canonical Okou CLI binary entry point.

load '../../helpers/setup'

@test "okou --help identifies Okou and shows supported commands" {
    run $OKOU_CLI --help
    assert_success
    assert_output --partial "Usage: okou"
    assert_output --partial "Okou CLI"
    assert_output --partial "workflow"
    assert_output --partial "agent"
    assert_output --partial "org"
    refute_output --partial "  automation"
    refute_output --partial "  schedule"
    refute_output --partial "  run"
    refute_output --partial "compose"
    refute_output --partial "volume"
    assert_output --partial "artifact"
}

@test "okou outputs a semantic version" {
    run $OKOU_CLI --version
    assert_success
    assert_output --regexp '^[0-9]+\.[0-9]+\.[0-9]+'
}

@test "okou can load the internal agent loop" {
    run $OKOU_CLI __agent-loop --help
    assert_success
    assert_output --partial "Internal sandbox Pi agent loop"
}

@test "okou preserves error output and exit behavior" {
    local command
    for command in automation schedule; do
        run $OKOU_CLI "$command" list
        assert_failure
        assert_output --partial "unknown command '$command'"
    done
}
