#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
SANDBOX_ID=$2
SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1"; exit 1; }

# Test 11: verify HTTPS works through proxy for each runtime
# All traffic goes through mitmproxy, so TLS must trust the proxy CA.
echo "--- Test: HTTPS through proxy ---"
TLS_URL="https://www.google.com"
is_expected_cargo_proxy_502() {
  local label=$1 status=$2 output=$3
  [ "$label" = "cargo" ] || return 1
  [ "$status" -eq 101 ] || return 1
  printf '%s\n' "$output" \
    | grep -F "failed to retrieve search results from the registry at https://crates.io" \
    >/dev/null || return 1
  printf '%s\n' "$output" \
    | grep -F "got 502" >/dev/null || return 1
  printf '%s\n' "$output" \
    | grep -F "server: mitmproxy" >/dev/null
}

tls_check() {
  local label=$1 cmd=$2 t=${3:-15} allow_cargo_proxy_502=${4:-false}
  local output status

  # Let the guest timeout finish its TERM/KILL cycle and return stderr before
  # runner exec's timeout can replace the result with a synthetic Timeout.
  if output=$(sudo "$BIN_DIR/runner" exec --timeout "$((t + 10))" \
    --sandbox "$SANDBOX_ID" -- sh -c "timeout --kill-after=5s $t $cmd" 2>&1); then
    echo "  HTTPS $label: ok"
  else
    status=$?
    if [ "$allow_cargo_proxy_502" = true ] \
      && is_expected_cargo_proxy_502 "$label" "$status" "$output"; then
      echo "  HTTPS $label: accepted proxy 502 (crates.io unavailable)"
      return 0
    fi
    fail "HTTPS $label failed with exit code $status: ${output:-no output}"
  fi
}
tls_check "curl"      "curl -sf --max-time 10 $TLS_URL"
tls_check "wget"      "wget -qO /dev/null --timeout=10 $TLS_URL"
tls_check "git"       "git ls-remote --exit-code https://github.com/anthropics/anthropic-sdk-python.git HEAD"
tls_check "python"    "python3 -c \"import urllib.request; urllib.request.urlopen('$TLS_URL')\""
tls_check "node"      "node -e \"require('https').get('$TLS_URL',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',e=>{console.error(e);process.exit(1)})\""
tls_check "ruby"      "ruby -e \"require 'net/http'; Net::HTTP.get(URI('$TLS_URL'))\""
tls_check "php"       "php -r \"file_get_contents('$TLS_URL');\""
# A proxy-generated 502 from crates.io still proves the HTTPS/TLS path reached
# the proxy. Accept only the exact cargo registry response above; other cargo
# failures remain fatal.
tls_check "cargo"     "env CARGO_HOME=/tmp/cargo-test cargo search --limit 1 serde" 30 true

# A static document exercises Chromium's real HTTPS/proxy trust without Google
# page scripts or --dump-dom's implicit tab-close lifecycle. Preserve both bounds.
if CHROMIUM_OUTPUT=$(sudo "$BIN_DIR/runner" exec --timeout 40 \
  --sandbox "$SANDBOX_ID" -- timeout --kill-after=5s 30 \
  node --input-type=module --eval "$(<"$SCENARIO_DIR/chromium-https.mjs")" \
  "$TLS_URL/robots.txt" "User-agent:" 2>&1); then
  echo "  HTTPS chromium: ok"
else
  CHROMIUM_STATUS=$?
  fail "HTTPS chromium failed with exit code $CHROMIUM_STATUS: ${CHROMIUM_OUTPUT:-no output}"
fi

# Java and Go need multi-line scripts.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "printf '%s\n' 'import java.net.*;import java.net.http.*;' 'var c=HttpClient.newHttpClient();' 'var r=HttpRequest.newBuilder(URI.create(\"$TLS_URL\")).build();' 'c.send(r,HttpResponse.BodyHandlers.discarding());' '/exit' | timeout 30 jshell -" \
  || fail "HTTPS java"
echo "  HTTPS java: ok"

# Keep cold Go compilation outside the request budget so a slow build cannot
# masquerade as a proxy or CA failure.
GO_BUILD_TIMEOUT=60
GO_REQUEST_TIMEOUT=15
echo "  Go HTTPS helper build timeout: guest ${GO_BUILD_TIMEOUT}s, runner $((GO_BUILD_TIMEOUT + 10))s"
if GO_BUILD_OUTPUT=$(sudo "$BIN_DIR/runner" exec \
  --timeout "$((GO_BUILD_TIMEOUT + 10))" \
  --sandbox "$SANDBOX_ID" -- sh -c \
  "printf '%s\n' 'package main' 'import (' '\"net/http\"' '\"os\"' ')' 'func main(){r,e:=http.Get(os.Args[1]);if e!=nil{panic(e)};defer r.Body.Close();if r.StatusCode>=http.StatusBadRequest{panic(r.Status)}}' > /tmp/vm0_tls_check.go && timeout --kill-after=5s $GO_BUILD_TIMEOUT go build -o /tmp/vm0-tls-check-go /tmp/vm0_tls_check.go" 2>&1); then
  echo "  Go HTTPS helper build: ok"
else
  GO_BUILD_STATUS=$?
  fail "Go HTTPS helper build failed with exit code $GO_BUILD_STATUS: ${GO_BUILD_OUTPUT:-no output}"
fi
echo "  Go HTTPS request timeout: guest ${GO_REQUEST_TIMEOUT}s, runner $((GO_REQUEST_TIMEOUT + 10))s"
tls_check "go" "/tmp/vm0-tls-check-go $TLS_URL" "$GO_REQUEST_TIMEOUT"
echo "PASS: HTTPS through proxy"
