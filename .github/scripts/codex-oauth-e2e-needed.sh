#!/usr/bin/env bash

# Select the paid Codex OAuth smoke test only for a pin change or its own code.
set -euo pipefail

base_ref="${1:?base ref is required}"
git rev-parse --verify "${base_ref}^{commit}" >/dev/null
pin_file="crates/runner/scripts/build-template.sh"
workflow_file=".github/workflows/turbo.yml"
pin_changed=false
workflow_changed=false
test_changed=false
changed_paths="$(git diff --name-only --no-renames "$base_ref" HEAD)"

while IFS= read -r path; do
    case "$path" in
        "$pin_file") pin_changed=true ;;
        "$workflow_file") workflow_changed=true ;;
        .github/scripts/codex-oauth-e2e-needed.sh | \
            .github/scripts/tests/codex-oauth-e2e-needed-test.sh | \
            e2e/tests/03-runner-oauth/*)
            test_changed=true
            ;;
    esac
done <<<"$changed_paths"

read_pin() {
    awk '
        /^CODEX_CLI_VERSION=/ {
            count++
            if ($0 !~ /^CODEX_CLI_VERSION="[^"]+"$/) invalid = 1
            value = substr($0, 20, length($0) - 20)
        }
        END {
            if (count != 1 || invalid) exit 1
            print value
        }
    '
}

extract_oauth_job() {
    awk '
        /^  cli-e2e-03-runner-codex-oauth:$/ { inside = 1 }
        inside && /^  [a-zA-Z0-9_-]+:$/ &&
            $0 != "  cli-e2e-03-runner-codex-oauth:" { exit }
        inside { print }
    '
}

if [[ "$pin_changed" == true ]]; then
    if ! base_pin="$(git show "$base_ref:$pin_file" | read_pin)" ||
        ! head_pin="$(git show "HEAD:$pin_file" | read_pin)"; then
        echo "Cannot uniquely parse CODEX_CLI_VERSION at base and head" >&2
        exit 1
    fi
    if [[ "$base_pin" != "$head_pin" ]]; then
        test_changed=true
    fi
fi

if [[ "$workflow_changed" == true ]]; then
    base_job="$(git show "$base_ref:$workflow_file" | extract_oauth_job)"
    head_job="$(git show "HEAD:$workflow_file" | extract_oauth_job)"
    if [[ "$base_job" != "$head_job" ]]; then
        test_changed=true
    fi
fi

printf '%s\n' "$test_changed"
