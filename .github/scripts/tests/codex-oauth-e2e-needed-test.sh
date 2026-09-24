#!/usr/bin/env bash

set -euo pipefail

detector="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/codex-oauth-e2e-needed.sh"
fixture=""

cleanup() {
    if [[ -n "$fixture" ]]; then
        rm -rf -- "$fixture"
    fi
}
trap cleanup EXIT

new_fixture() {
    cleanup
    fixture="$(mktemp -d)"
    git -C "$fixture" init -q
    git -C "$fixture" config user.email "codex-e2e-test@example.invalid"
    git -C "$fixture" config user.name "Codex E2E Test"
    mkdir -p "$fixture/crates/runner/scripts" "$fixture/.github/workflows"
    printf '%s\n' 'CODEX_CLI_VERSION="0.156.1"' > \
        "$fixture/crates/runner/scripts/build-template.sh"
    printf '%s\n' 'jobs:' '  prepare:' '    runs-on: ubuntu-latest' > \
        "$fixture/.github/workflows/turbo.yml"
    git -C "$fixture" add .
    git -C "$fixture" commit -qm base
}

commit_change() {
    git -C "$fixture" add .
    git -C "$fixture" commit -qm change
}

assert_needed() {
    local expected="$1"
    local actual
    actual="$(cd "$fixture" && bash "$detector" HEAD~1)"
    if [[ "$actual" != "$expected" ]]; then
        echo "Expected Codex OAuth E2E needed=$expected, got $actual" >&2
        exit 1
    fi
}

new_fixture
printf '%s\n' 'unrelated' >"$fixture/README.md"
commit_change
assert_needed false

if (cd "$fixture" && bash "$detector" unknown-base >/dev/null 2>&1); then
    echo "Unknown base unexpectedly passed detection" >&2
    exit 1
fi

new_fixture
printf '%s\n' 'CODEX_CLI_VERSION="0.157.0"' > \
    "$fixture/crates/runner/scripts/build-template.sh"
commit_change
assert_needed true

new_fixture
printf '%s\n' 'CODEX_CLI_VERSION="0.156.1"' '# unrelated edit' > \
    "$fixture/crates/runner/scripts/build-template.sh"
commit_change
assert_needed false

new_fixture
mkdir -p "$fixture/e2e/tests/03-runner-oauth"
printf '%s\n' '# changed OAuth test' > \
    "$fixture/e2e/tests/03-runner-oauth/codex-oauth.bats"
commit_change
assert_needed true

new_fixture
mkdir -p "$fixture/e2e/tests/03-runner"
printf '%s\n' '# ordinary runner test' > \
    "$fixture/e2e/tests/03-runner/ordinary.bats"
commit_change
assert_needed false

new_fixture
mkdir -p "$fixture/e2e/tests/03-runner-oauth"
printf '%s\n' '# moved OAuth test' > \
    "$fixture/e2e/tests/03-runner-oauth/codex-oauth.bats"
commit_change
mkdir -p "$fixture/e2e/tests/03-runner"
git -C "$fixture" mv \
    e2e/tests/03-runner-oauth/codex-oauth.bats \
    e2e/tests/03-runner/codex-oauth.bats
commit_change
assert_needed true

new_fixture
printf '%s\n' 'CODEX_CLI_VERSION=0.157.0' > \
    "$fixture/crates/runner/scripts/build-template.sh"
commit_change
if (cd "$fixture" && bash "$detector" HEAD~1 >/dev/null 2>&1); then
    echo "Malformed Codex pin unexpectedly passed detection" >&2
    exit 1
fi

new_fixture
printf '%s\n' 'jobs:' '  prepare:' '    runs-on: ubuntu-latest' \
    '  cli-e2e-03-runner-codex-oauth:' '    runs-on: ubuntu-latest' > \
    "$fixture/.github/workflows/turbo.yml"
commit_change
assert_needed true

new_fixture
printf '%s\n' 'jobs:' '  prepare:' '    runs-on: ubuntu-22.04' > \
    "$fixture/.github/workflows/turbo.yml"
commit_change
assert_needed false

echo "Codex OAuth E2E change detection passed"
