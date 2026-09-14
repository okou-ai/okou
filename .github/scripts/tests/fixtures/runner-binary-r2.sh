#!/usr/bin/env bash

# Exercise real curl/TLS/SigV4 without adding a test endpoint to production code.
runner_binary_r2_fixture_start() {
  export R2_TEST_ROOT=$1
  export R2_TEST_CURL
  R2_TEST_CURL=$(command -v curl)
  mkdir -p "${R2_TEST_ROOT}/bin" "${R2_TEST_ROOT}/store"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj '/CN=*.r2.cloudflarestorage.com' \
    -addext 'subjectAltName=DNS:*.r2.cloudflarestorage.com' \
    -keyout "${R2_TEST_ROOT}/key.pem" -out "${R2_TEST_ROOT}/cert.pem" >/dev/null 2>&1
  coproc R2_FIXTURE {
    exec node "$(dirname "${BASH_SOURCE[0]}")/runner-binary-r2.mjs" "$R2_TEST_ROOT" "$2"
  }
  R2_TEST_PID=$R2_FIXTURE_PID
  IFS= read -r -t 10 R2_TEST_PORT <&"${R2_FIXTURE[0]}"
  export R2_TEST_PORT
  cat > "${R2_TEST_ROOT}/bin/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
exec "$R2_TEST_CURL" -q "$@" --noproxy '*' \
  --connect-to "${R2_ACCOUNT_ID}.r2.cloudflarestorage.com:443:127.0.0.1:${R2_TEST_PORT}" \
  --cacert "${R2_TEST_ROOT}/cert.pem" \
  --header "X-Fixture-Mode: ${R2_TEST_MODE:-success}"
BASH
  chmod +x "${R2_TEST_ROOT}/bin/curl"
}

runner_binary_r2_fixture_stop() {
  if [ -n "${R2_TEST_PID:-}" ]; then
    kill "$R2_TEST_PID"
    wait "$R2_TEST_PID" || true
  fi
}
