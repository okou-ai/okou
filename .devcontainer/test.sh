#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

copy_script() {
  local workspace="$1"
  local script="$2"

  mkdir -p "$workspace/.devcontainer"
  cp "$REPO_ROOT/.devcontainer/$script" "$workspace/.devcontainer/$script"
}

REQUIRED_UV_VERSION="$(
  python3 - "$REPO_ROOT/crates/runner/mitm-addon/pyproject.toml" <<'PY'
import sys
import tomllib
from pathlib import Path

with Path(sys.argv[1]).open("rb") as file:
    project = tomllib.load(file)

print(project["tool"]["uv"]["required-version"].removeprefix("=="))
PY
)"

prepare_setup_workspace() {
  local workspace="$1"
  local fake_bin="$workspace/fake-bin"

  copy_script "$workspace" "setup.sh"
  mkdir -p \
    "$fake_bin" \
    "$workspace/home" \
    "$workspace/turbo" \
    "$workspace/crates/runner/mitm-addon"
  printf '[tool.uv]\nrequired-version = "==%s"\n' "$REQUIRED_UV_VERSION" \
    > "$workspace/crates/runner/mitm-addon/pyproject.toml"

  cat > "$fake_bin/sudo" <<'SCRIPT'
#!/usr/bin/env bash
if [[ -n "${SUDO_CALLS_LOG:-}" ]]; then
  printf "%s\n" "$*" >> "$SUDO_CALLS_LOG"
fi
if [[ "$*" == *"pg_available_extensions"* ]]; then
  printf '1\n'
fi
SCRIPT
  cat > "$fake_bin/psql" <<'SCRIPT'
#!/usr/bin/env bash
if [[ -n "${PSQL_CALLS_LOG:-}" ]]; then
  printf "%s\n" "$*" >> "$PSQL_CALLS_LOG"
fi
printf '1\n'
SCRIPT
  cat > "$fake_bin/lefthook" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "$fake_bin/curl" <<'SCRIPT'
#!/usr/bin/env bash
printf "%s\n" "$*" >> "${CURL_CALLS_LOG:-/dev/null}"
url="${@: -1}"
version="${url%/install.sh}"
version="${version##*/}"
install_version="${FAKE_UV_INSTALL_VERSION:-$version}"
cat <<INSTALLER
mkdir -p "\${UV_UNMANAGED_INSTALL}"
cat > "\${UV_UNMANAGED_INSTALL}/uv" <<'UV'
#!/usr/bin/env bash
printf '%s\n' 'uv ${install_version} (test)'
UV
chmod +x "\${UV_UNMANAGED_INSTALL}/uv"
INSTALLER
SCRIPT
  chmod +x "$fake_bin/sudo" "$fake_bin/psql" "$fake_bin/lefthook" "$fake_bin/curl"
}

run_setup() {
  local workspace="$1"

  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" \
    HOME="$workspace/home" \
    PATH="$workspace/fake-bin:$workspace/home/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    PSQL_CALLS_LOG="$workspace/psql.log" \
    SUDO_CALLS_LOG="$workspace/sudo.log" \
    CURL_CALLS_LOG="$workspace/curl.log" \
    FAKE_UV_INSTALL_VERSION="${FAKE_UV_INSTALL_VERSION:-}" \
    bash "$workspace/.devcontainer/setup.sh"
}

prepare_dev_cli_fixture() {
  local fixture="$1"
  local fake_bin="$fixture/fake-bin"

  mkdir -p "$fake_bin"
  cat > "$fake_bin/git" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >> "$GIT_CALLS_LOG"
SCRIPT
  cat > "$fake_bin/npx" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

redacted_args=()
for arg in "$@"; do
  if [[ "$arg" == OP_SERVICE_ACCOUNT_TOKEN=* ]]; then
    test "$arg" = "OP_SERVICE_ACCOUNT_TOKEN=$OP_SERVICE_ACCOUNT_TOKEN"
    redacted_args+=("OP_SERVICE_ACCOUNT_TOKEN=<redacted>")
  else
    redacted_args+=("$arg")
  fi
done

printf '%s\n' "${redacted_args[*]}" >> "$NPX_CALLS_LOG"
if [[ " ${redacted_args[*]} " == *" mountpoint -q "* ]]; then
  exit "${MOUNTPOINT_EXIT_CODE:-0}"
fi
SCRIPT
  chmod +x "$fake_bin/git" "$fake_bin/npx"
}

test_skill_link_file_conflict() {
  local workspace="$TEST_ROOT/link-file-conflict"
  local output

  copy_script "$workspace" "link-agent-skills.sh"
  mkdir -p "$workspace/.claude/skills" "$workspace/.agents"
  printf 'keep me\n' > "$workspace/.agents/skills"

  output="$(HOME="$workspace/home" bash "$workspace/.devcontainer/link-agent-skills.sh")"

  grep -Fq "Skipping .agents/skills link because a non-directory entry already exists" <<< "$output" \
    || fail "non-directory conflict did not report that linking was skipped"
  grep -Fxq "keep me" "$workspace/.agents/skills" \
    || fail "non-directory conflict was modified"
}

test_skill_link_directory_conflict() {
  local workspace="$TEST_ROOT/link-directory-conflict"
  local skills_dir="$workspace/.agents/skills"
  local output

  copy_script "$workspace" "link-agent-skills.sh"
  mkdir -p "$workspace/.claude/skills" "$skills_dir"
  mkdir "$skills_dir"/entry-{00001..10000}

  output="$(HOME="$workspace/home" bash "$workspace/.devcontainer/link-agent-skills.sh")"

  grep -Fq "Skipping .agents/skills link because it contains non-symlink entries" <<< "$output" \
    || fail "directory conflict did not report that linking was skipped"
  test -d "$skills_dir/entry-10000" \
    || fail "directory conflict was modified"
}

test_postgresql_setup() {
  local workspace="$TEST_ROOT/postgresql-setup"
  local fake_bin="$workspace/fake-bin"
  local psql_log="$workspace/psql.log"
  local sudo_log="$workspace/sudo.log"

  prepare_setup_workspace "$workspace"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "printf '%s\\n' 'uv $REQUIRED_UV_VERSION (test)'" \
    > "$fake_bin/uv"
  chmod +x "$fake_bin/uv"

  run_setup "$workspace" > /dev/null

  grep -Fxq "service postgresql start" "$sudo_log" \
    || fail "PostgreSQL service was not started"
  grep -Fq -- "-u postgres psql -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -c ALTER ROLE postgres PASSWORD 'postgres';" "$sudo_log" \
    || fail "PostgreSQL password was not configured"
  grep -Fq -- "postgresql://postgres:postgres@localhost:5432/postgres -v ON_ERROR_STOP=1 -Atqc SELECT 1" "$psql_log" \
    || fail "PostgreSQL password authentication was not verified"
  grep -Fq -- "-u postgres psql -h /var/run/postgresql -d postgres -Atqc" "$sudo_log" \
    || fail "pgvector availability probe did not use the local Unix socket"
}

test_uv_setup_skips_installed_version() {
  local workspace="$TEST_ROOT/uv-already-installed"
  local fake_bin="$workspace/fake-bin"

  prepare_setup_workspace "$workspace"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "printf '%s\\n' 'uv $REQUIRED_UV_VERSION (test)'" \
    > "$fake_bin/uv"
  chmod +x "$fake_bin/uv"

  run_setup "$workspace" > /dev/null

  test ! -s "$workspace/curl.log" \
    || fail "correct uv version unexpectedly invoked the installer"
}

test_uv_setup_installs_required_version() {
  local workspace="$TEST_ROOT/uv-install"

  prepare_setup_workspace "$workspace"
  run_setup "$workspace" > /dev/null

  grep -Fq "https://astral.sh/uv/$REQUIRED_UV_VERSION/install.sh" "$workspace/curl.log" \
    || fail "uv installer URL did not use the project-required version"
  test "$("$workspace/home/.local/bin/uv" --version | awk '{ print $2 }')" = "$REQUIRED_UV_VERSION" \
    || fail "uv installer did not create the required version"
}

test_uv_setup_rejects_invalid_requirement() {
  local workspace="$TEST_ROOT/uv-invalid-requirement"
  local output

  prepare_setup_workspace "$workspace"
  printf '[tool.uv]\nrequired-version = ">=0.11"\n' \
    > "$workspace/crates/runner/mitm-addon/pyproject.toml"

  if output="$(run_setup "$workspace" 2>&1)"; then
    fail "non-exact uv requirement unexpectedly succeeded"
  fi

  grep -Fq "must define an exact [tool.uv] required-version" <<< "$output" \
    || fail "invalid uv requirement did not explain the failure"
  test ! -s "$workspace/curl.log" \
    || fail "invalid uv requirement unexpectedly invoked the installer"
}

test_uv_setup_rejects_installed_version_mismatch() {
  local workspace="$TEST_ROOT/uv-version-mismatch"
  local output

  prepare_setup_workspace "$workspace"

  if output="$(FAKE_UV_INSTALL_VERSION="0.0.0" run_setup "$workspace" 2>&1)"; then
    fail "mismatched installed uv version unexpectedly succeeded"
  fi

  grep -Fq "uv $REQUIRED_UV_VERSION was installed but is not effective on PATH" <<< "$output" \
    || fail "uv version mismatch did not explain the failure"
}

test_devcontainer_postgresql_config() {
  local config="$REPO_ROOT/.devcontainer/devcontainer.json"
  local lock="$REPO_ROOT/.devcontainer/devcontainer-lock.json"

  jq -e '.features | has("ghcr.io/itsmechlark/features/postgresql:1") | not' "$config" > /dev/null \
    || fail "PostgreSQL feature should not duplicate the vm0-dev image"
  jq -e '.features | has("ghcr.io/itsmechlark/features/postgresql:1") | not' "$lock" > /dev/null \
    || fail "PostgreSQL feature lock should be removed"
  jq -e '.postStartCommand | startswith("sudo service postgresql start &&")' "$config" > /dev/null \
    || fail "PostgreSQL service should start with the container"
  jq -e '.customizations.vscode.settings."sqltools.connections"[0].password == "postgres"' "$config" > /dev/null \
    || fail "SQLTools password should match DATABASE_URL"
  jq -e '.remoteEnv.OP_SERVICE_ACCOUNT_TOKEN == "${localEnv:OP_SERVICE_ACCOUNT_TOKEN}"' "$config" > /dev/null \
    || fail "1Password service account token should pass directly from the host"
}

test_dcu_command_wiring() {
  local fixture="$TEST_ROOT/dcu-command-wiring"
  local workspaces="$fixture/custom-workspaces"
  local dotfiles="https://example.com/okou/dotfiles.git"
  local expected_without_extra
  local expected_with_extra

  prepare_dev_cli_fixture "$fixture"
  mkdir -p "$fixture/home" "$workspaces/primary" "$workspaces/extra"

  env -i \
    HOME="$fixture/home" \
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
    OKOU_WORKSPACES="$workspaces" \
    OKOU_DOTFILES="$dotfiles" \
    GIT_CALLS_LOG="$fixture/git.log" \
    NPX_CALLS_LOG="$fixture/npx.log" \
    bash "$REPO_ROOT/bin/dcu" primary
  env -i \
    HOME="$fixture/home" \
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
    OKOU_WORKSPACES="$workspaces" \
    OKOU_DOTFILES="$dotfiles" \
    GIT_CALLS_LOG="$fixture/git.log" \
    NPX_CALLS_LOG="$fixture/npx.log" \
    bash "$REPO_ROOT/bin/dcu" primary extra

  expected_without_extra="@devcontainers/cli up --workspace-folder $workspaces/primary --dotfiles-repository $dotfiles --remove-existing-container"
  expected_with_extra="@devcontainers/cli up --workspace-folder $workspaces/primary --dotfiles-repository $dotfiles --mount type=bind,source=$workspaces/extra,target=/workspaces/extra --remove-existing-container"
  grep -Fxq "$workspaces/primary|pull" "$fixture/git.log" \
    || fail "dcu did not update the selected primary workspace"
  grep -Fxq "$expected_without_extra" "$fixture/npx.log" \
    || fail "dcu did not pass the configured workspace and dotfiles paths"
  grep -Fxq "$expected_with_extra" "$fixture/npx.log" \
    || fail "dcu did not pass the configured extra workspace mount"
}

test_dcz_command_wiring() {
  local fixture="$TEST_ROOT/dcz-command-wiring"
  local workspaces="$fixture/home/workspaces"
  local dotfiles="https://example.com/okou/dotfiles.git"
  local expected_mount_probe
  local expected_recreate
  local expected_exec

  prepare_dev_cli_fixture "$fixture"
  mkdir -p "$workspaces/primary" "$workspaces/extra"

  env -i \
    HOME="$fixture/home" \
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
    OKOU_DOTFILES="$dotfiles" \
    OP_SERVICE_ACCOUNT_TOKEN="fixture-only" \
    NPX_CALLS_LOG="$fixture/npx.log" \
    MOUNTPOINT_EXIT_CODE=1 \
    bash "$REPO_ROOT/bin/dcz" primary extra

  expected_mount_probe="@devcontainers/cli exec --workspace-folder $workspaces/primary mountpoint -q /workspaces/extra"
  expected_recreate="@devcontainers/cli up --workspace-folder $workspaces/primary --dotfiles-repository $dotfiles --mount type=bind,source=$workspaces/extra,target=/workspaces/extra --remove-existing-container"
  expected_exec="@devcontainers/cli exec --workspace-folder $workspaces/primary --remote-env OP_SERVICE_ACCOUNT_TOKEN=<redacted> zsh"
  grep -Fxq "$expected_mount_probe" "$fixture/npx.log" \
    || fail "dcz did not probe the default extra workspace mount"
  grep -Fxq "$expected_recreate" "$fixture/npx.log" \
    || fail "dcz did not recreate the container with configured dotfiles"
  grep -Fxq "$expected_exec" "$fixture/npx.log" \
    || fail "dcz did not pass the 1Password token under its vendor-standard name"
}

test_dev_cli_required_inputs() {
  local fixture="$TEST_ROOT/dev-cli-required-inputs"
  local workspaces="$fixture/home/workspaces"

  prepare_dev_cli_fixture "$fixture"
  mkdir -p "$workspaces/primary"

  if env -i \
    HOME="$fixture/home" \
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
    GIT_CALLS_LOG="$fixture/git.log" \
    NPX_CALLS_LOG="$fixture/npx.log" \
    bash "$REPO_ROOT/bin/dcu" primary > /dev/null 2>&1; then
    fail "dcu unexpectedly accepted missing dotfiles configuration"
  fi
  if env -i \
    HOME="$fixture/home" \
    PATH="$fixture/fake-bin:/usr/bin:/bin" \
    NPX_CALLS_LOG="$fixture/npx.log" \
    bash "$REPO_ROOT/bin/dcz" primary > /dev/null 2>&1; then
    fail "dcz unexpectedly accepted a missing 1Password token"
  fi
}

test_skill_link_file_conflict
test_skill_link_directory_conflict
test_postgresql_setup
test_uv_setup_skips_installed_version
test_uv_setup_installs_required_version
test_uv_setup_rejects_invalid_requirement
test_uv_setup_rejects_installed_version_mismatch
test_devcontainer_postgresql_config
test_dcu_command_wiring
test_dcz_command_wiring
test_dev_cli_required_inputs

echo "Devcontainer integration tests passed"
