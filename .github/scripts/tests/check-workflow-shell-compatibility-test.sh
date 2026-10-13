#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="${SCRIPT_DIR}/checks/check-workflow-shell-compatibility.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_pass() {
  local workflow="$1"
  if ! "$CHECKER" "$workflow"; then
    fail "expected ${workflow} to pass"
  fi
}

expect_fail() {
  local workflow="$1"
  local expected="$2"
  local output
  if output="$("$CHECKER" "$workflow" 2>&1)"; then
    fail "expected ${workflow} to fail"
  fi
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected output to contain '${expected}', got: ${output}"
  fi
}

cat > "${TMPDIR}/default-sh.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: example.test/toolchain:latest
    steps:
      - name: Bash-only script
        run: |
          set -euo pipefail
          if [[ -n "$HOME" ]]; then
            echo "$HOME"
          fi
YAML
expect_fail "${TMPDIR}/default-sh.yml" "SC3040"
expect_fail "${TMPDIR}/default-sh.yml" "SC3010"

cat > "${TMPDIR}/job-bash.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container: example.test/toolchain:latest
    defaults:
      run:
        shell: bash
    steps:
      - name: Bash-only script
        run: |
          set -euo pipefail
          [[ -n "$HOME" ]]
YAML
expect_pass "${TMPDIR}/job-bash.yml"

cat > "${TMPDIR}/step-bash.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: example.test/toolchain:latest
    steps:
      - name: Bash-only script
        shell: bash
        run: |
          values=(one two)
          [[ "${#values[@]}" -eq 2 ]]
YAML
expect_pass "${TMPDIR}/step-bash.yml"

cat > "${TMPDIR}/workflow-bash.yml" <<'YAML'
name: test
on: push
defaults:
  run:
    shell: bash
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: example.test/toolchain:latest
    steps:
      - run: '[[ -n "$HOME" ]]'
YAML
expect_pass "${TMPDIR}/workflow-bash.yml"

cat > "${TMPDIR}/step-sh-override.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: example.test/toolchain:latest
    defaults:
      run:
        shell: bash
    steps:
      - name: Explicit sh override
        run: |
          function greet() {
            echo hello
          }
          greet
        shell: sh
YAML
expect_fail "${TMPDIR}/step-sh-override.yml" "SC2112"

cat > "${TMPDIR}/posix-sh.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: example.test/toolchain:latest
    steps:
      - name: POSIX script
        run: |
          set -eu
          if [ -n "$HOME" ]; then
            echo "$HOME"
          fi
          echo "${{ github.sha }}"
YAML
expect_pass "${TMPDIR}/posix-sh.yml"

cat > "${TMPDIR}/host-bash.yml" <<'YAML'
name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Host defaults to Bash
        run: |
          set -euo pipefail
          [[ -n "$HOME" ]]
YAML
expect_pass "${TMPDIR}/host-bash.yml"

echo "check-workflow-shell-compatibility-test: ok"
