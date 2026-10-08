#!/usr/bin/env bash
# Opt-in isolated QEMU 8.2.2 / Cyrus SCRAM integration fixture. No public listener.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
command -v qemu-system-x86_64 >/dev/null
command -v saslpasswd2 >/dev/null || test -x /usr/sbin/saslpasswd2
command -v openssl >/dev/null
qemu-system-x86_64 --version | head -1 | grep -Fqx 'QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1)'
test "$(dpkg-query -W -f='${Version}' libsasl2-modules)" = '2.1.28+dfsg1-5ubuntu3'
test -e /usr/lib/x86_64-linux-gnu/sasl2/libscram.so.2
# QEMU prints vnc-help text with exit status 1 (usage), so inspect its output.
vnc_help=$(qemu-system-x86_64 -vnc help 2>&1 || :)
grep -E '^  sasl=<bool' >/dev/null <<< "$vnc_help"
mkdir -p "$repo/codex-work/probe"
work=$(mktemp -d "$repo/codex-work/probe/qemu-sasl.XXXXXXXX")
chmod 700 "$work"
pid=''
stop_qemu() {
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; pid=''; fi
}
cleanup() {
    stop_qemu
    test -n "$work" && test -d "$work" && rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -m 700 "$work/tls" "$work/conf"
openssl req -x509 -newkey rsa:2048 -noenc -days 2 -subj /CN=Issue37465Root -keyout "$work/ca-key.pem" -out "$work/tls/ca-cert.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -noenc -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout "$work/tls/server-key.pem" -out "$work/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/tls/ca-cert.pem" -CAkey "$work/ca-key.pem" -CAcreateserial -days 2 -extfile "$work/server.ext" -out "$work/tls/server-cert.pem" >/dev/null 2>&1
chmod 600 "$work/ca-key.pem" "$work/tls/server-key.pem"
write_config() {
    printf 'mech_list: %s\npwcheck_method: auxprop\nauxprop_plugin: sasldb\nsasldb_path: %s/passwd.db\n' "$1" "$work" > "$work/conf/qemu.conf"
}
write_config SCRAM-SHA-256
printf 'fixture-test-only-37465\n' | /usr/sbin/saslpasswd2 -p -c -f "$work/passwd.db" -u "$(hostname)" fixture37465
chmod 600 "$work/passwd.db"
port=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
test "$port" -ge 5900
start_qemu() {
    SASL_CONF_PATH="$work/conf" qemu-system-x86_64 -machine pc,accel=tcg -m 64 -nodefaults -device VGA -display none -vnc "127.0.0.1:$((port - 5900)),tls-creds=tls0,sasl=on" -object "tls-creds-x509,id=tls0,endpoint=server,dir=$work/tls,verify-peer=off" -S -monitor none -serial none -no-reboot </dev/null > "$work/qemu.log" 2>&1 &
    pid=$!
    ready=0
    for _ in $(seq 1 100); do
        if ! kill -0 "$pid" 2>/dev/null; then echo 'QEMU fixture exited' >&2; exit 1; fi
        if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then ready=1; break; fi
        sleep 0.05
    done
    if [ "$ready" != 1 ]; then echo 'QEMU fixture did not listen' >&2; exit 1; fi
}
start_qemu
printf 'isolated QEMU 8.2.2 / Cyrus 2.1.28 SCRAM on 127.0.0.1:%s\n' "$port"
cd "$repo/crates"
QEMU_SASL_ROOT_PEM="$work/tls/ca-cert.pem" QEMU_SASL_PORT="$port" cargo test --profile local --locked -p rfb-client --test qemu_sasl -- --ignored --nocapture
stop_qemu
write_config PLAIN
start_qemu
printf 'isolated QEMU 8.2.2 / Cyrus 2.1.28 without SCRAM on 127.0.0.1:%s\n' "$port"
QEMU_SASL_EXPECT_MISSING_SCRAM=1 QEMU_SASL_ROOT_PEM="$work/tls/ca-cert.pem" QEMU_SASL_PORT="$port" cargo test --profile local --locked -p rfb-client --test qemu_sasl -- --ignored --nocapture
