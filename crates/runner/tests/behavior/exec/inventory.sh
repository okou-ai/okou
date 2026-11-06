#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
SANDBOX_ID=$2
fail() { echo "FAIL: $1"; exit 1; }

# Test 7: verify pre-installed language runtimes and databases
echo "--- Test: runtime availability ---"
# Each inventory command has one version argument. Pass pairs as argv so the
# guest resolves the same binaries through its inherited PATH without eval.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c '
  echo "  runtime inventory: $(($# / 2)) checks in 1 runner-exec probe"
  while [ "$#" -gt 0 ]; do
    cmd=$1 arg=$2
    shift 2
    if output=$("$cmd" "$arg" 2>&1); then
      printf "  %s %s -> %s\n" "$cmd" "$arg" "$(printf "%s\n" "$output" | head -1)"
    else
      status=$?
      printf "FAIL: command failed: %s %s (exit %s)\n" "$cmd" "$arg" "$status" >&2
      printf "%s\n" "$output" >&2
      exit "$status"
    fi
  done
' runtime-inventory \
  node --version \
  npm --version \
  python3 --version \
  pip3 --version \
  ruby --version \
  bundler --version \
  php --version \
  composer --version \
  javac -version \
  mvn --version \
  gradle --version \
  go version \
  rustc --version \
  cargo --version \
  gcc --version \
  g++ --version \
  clang --version \
  make --version \
  cmake --version \
  psql --version \
  redis-server --version \
  || fail "runtime inventory probe"
echo "PASS: runtime inventory"

# Test 10: verify /etc/environment is loaded for both user and root
# [sync:etc-environment] Keep in sync with: crates/runner/scripts/customize-rootfs.sh
echo "--- Test: environment variables ---"
EXPECTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
declare -A EXPECTED_ENV=(
  [LANG]="C.UTF-8"
  [NPM_CONFIG_UPDATE_NOTIFIER]="false"
  [NODE_EXTRA_CA_CERTS]="/usr/local/share/ca-certificates/vm0-proxy-ca.crt"
  [AGENT_BROWSER_USE_SYSTEM_CA]="1"
  [SSL_CERT_FILE]="/etc/ssl/certs/ca-certificates.crt"
  [REQUESTS_CA_BUNDLE]="/etc/ssl/certs/ca-certificates.crt"
  [CARGO_HTTP_CAINFO]="/etc/ssl/certs/ca-certificates.crt"
  [RUSTUP_HOME]="/usr/local/rustup"
)
check_env() {
  local label=$1 sudo_flag=$2
  local var
  local -a sudo_args=()
  local -a env_args=("$label" "$EXPECTED_PATH")
  if [ -n "$sudo_flag" ]; then
    sudo_args=("$sudo_flag")
  fi
  for var in "${!EXPECTED_ENV[@]}"; do
    env_args+=("$var" "${EXPECTED_ENV[$var]}")
  done
  sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" \
    "${sudo_args[@]}" -- sh -c '
    fail() { printf "FAIL: %s\n" "$1" >&2; exit 1; }
    label=$1 expected_path=$2
    shift 2
    echo "  $label environment inventory: $(($# / 2 + 1)) checks in 1 runner-exec probe"
    while [ "$#" -gt 0 ]; do
      var=$1 expected=$2
      shift 2
      val=$(printenv "$var") \
        || fail "$label: $var not set"
      [ "$val" = "$expected" ] \
        || fail "$label: $var=$val, expected $expected"
      echo "  $label $var=$val"
    done
    val=$(printenv PATH) \
      || fail "$label: PATH not set"
    printf "%s\n" "$val" | grep -qF "$expected_path" \
      || fail "$label: PATH missing $expected_path in: $val"
    echo "  $label PATH=$val"
  ' environment-inventory "${env_args[@]}" \
    || fail "$label: environment inventory probe"
}
check_env "user" ""
check_env "root" "--sudo"
echo "PASS: environment variables"
