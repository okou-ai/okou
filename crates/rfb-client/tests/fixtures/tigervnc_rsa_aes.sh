#!/usr/bin/env bash
# Synthetic, opt-in loopback fixture. Does not touch an existing VNC server.
set -euo pipefail
umask 077
binary=${1:?provide compiled rsa_aes_tigervnc test executable}
root=${RSA_AES_FIXTURE_ROOT:-$(cd "$(dirname "$0")/../../../.." && pwd)/codex-work/probe}
user=okou_ra2_37499
port=5995
display=95
test -x "$binary"
test "$(dpkg-query -W -f='${Version}' tigervnc-standalone-server)" = '1.13.1+dfsg-2build2'
test "$(dpkg-query -W -f='${Version}' libnettle8t64)" = '3.9.1-2.2build1.1'
test "$(dpkg-query -W -f='${Version}' libpam0g)" = '1.5.3-5ubuntu5.7'
test -f /etc/pam.d/tigervnc
test ! -e /tmp/.X95-lock
if getent passwd "$user" >/dev/null; then echo 'fixture user already exists; refuse reuse' >&2; exit 1; fi
if ss -H -lnt "sport = :$port" | grep -q LISTEN; then echo 'fixture port already owned' >&2; exit 1; fi
mkdir -p "$root"
work=$(mktemp -d "$root/ra2.XXXXXXXX")
chmod 700 "$work"
owned_user=0
launcher=''
stop_server() {
  if [ -n "$launcher" ]; then
    # Stop only a server whose actual argv binds this exact private fixture key.
    sudo -n python3 - "$work/key.pem" <<'PY'
import os,sys,signal,pathlib
key=sys.argv[1]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdecimal():continue
 try:a=(p/'cmdline').read_bytes().split(b'\0')
 except (FileNotFoundError,PermissionError,ProcessLookupError):continue
 if a and os.path.basename(a[0])==b'Xtigervnc' and key.encode() in a:
  try:os.kill(int(p.name),signal.SIGTERM)
  except ProcessLookupError:pass
PY
    wait "$launcher" 2>/dev/null || :
    launcher=''
    for _ in $(seq 1 100); do
      if ! ss -H -lnt "sport = :$port" | grep -q LISTEN; then return; fi
      sleep .05
    done
    echo 'fixture listener did not close' >&2; return 1
  fi
}
cleanup() {
  local original=$? failed=0
  stop_server || failed=1
  if [ "$owned_user" = 1 ]; then sudo -n userdel "$user" || failed=1; fi
  rm -f -- "$work/key.pem" "$work/public.pem" "$work/password" "$work/server.log" || failed=1
  rmdir "$work" || failed=1
  if [ "$failed" != 0 ]; then echo 'fixture cleanup incomplete' >&2; exit 1; fi
  exit "$original"
}
trap cleanup EXIT
sudo -n useradd --no-create-home --shell /usr/sbin/nologin --comment 'Temporary RSA-AES issue37499 fixture' "$user"
owned_user=1
printf '%s:%s\n' "$user" 'fx37499!' | sudo -n chpasswd
openssl genrsa -traditional -out "$work/key.pem" 2048 >/dev/null 2>&1
openssl rsa -in "$work/key.pem" -pubout -out "$work/public.pem" >/dev/null 2>&1
modulus=$(openssl rsa -pubin -in "$work/public.pem" -modulus -noout)
pin=$(python3 - "$modulus" <<'PY'
import sys,hashlib
n=bytes.fromhex(sys.argv[1].split('=',1)[1])
assert len(n)==256 and n[0]&128
print(hashlib.sha256((2048).to_bytes(4,'big')+n+(65537).to_bytes(256,'big')).hexdigest())
PY
)
printf '%s\n' 'fx37499!' | tigervncpasswd -f > "$work/password"
chmod 600 "$work/key.pem" "$work/password"
export RSA_AES_PORT="$port" RSA_AES_PIN="$pin" RSA_AES_PASSWORD='fx37499!'
start_server() {
  local mode=$1 require=$2
  sudo -n Xtigervnc ":$display" -localhost yes -interface 127.0.0.1 -rfbport "$port" -nolisten tcp -geometry 640x480 -depth 24 -SecurityTypes "$mode" -RSAKey "$work/key.pem" -PasswordFile "$work/password" -RequireUsername "$require" -PlainUsers "$user" -PAMService tigervnc -desktop 'Issue37499 synthetic fixture' </dev/null > "$work/server.log" 2>&1 &
  launcher=$!
  for _ in $(seq 1 100); do
    if ! kill -0 "$launcher" 2>/dev/null; then echo 'fixture server exited' >&2; tail -20 "$work/server.log" >&2; return 1; fi
    if ss -H -lnt "sport = :$port" | grep -q "127.0.0.1:$port"; then return; fi
    sleep .05
  done
  echo 'fixture did not bind exact loopback port' >&2; return 1
}
for mode in RA2 RA2_256 RA2ne RA2ne_256; do
  export RSA_AES_MODE="$mode"
  for require in 0 1; do
    start_server "$mode" "$require"
    if [ "$require" = 1 ]; then export RSA_AES_USER="$user"; else export RSA_AES_USER=''; fi
    echo "independent case mode=$mode credential_subtype=$((2-require)) require_username=$require"
    env -u RSA_AES_NEGATIVE "$binary" --ignored --exact independent_tigervnc_authenticates_and_captures_the_selected_mode --nocapture
    RSA_AES_NEGATIVE=1 RSA_AES_PASSWORD='wrong-canary' "$binary" --ignored --exact independent_tigervnc_authenticates_and_captures_the_selected_mode --nocapture
    RSA_AES_NEGATIVE=1 RSA_AES_PIN=$(printf '%064d' 0) "$binary" --ignored --exact independent_tigervnc_authenticates_and_captures_the_selected_mode --nocapture
    stop_server
  done
done
echo 'all eight independent RSA-AES mode/credential cases passed; cleanup follows'
