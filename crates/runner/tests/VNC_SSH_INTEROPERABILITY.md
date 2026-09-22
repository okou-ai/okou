# Pinned OpenSSH plus TigerVNC interoperability

This explicit ignored test composes the production Runner SSH authority,
host-key verification, direct-tcpip forwarding, VNC authority, inner TLS/RFB
authentication, session, PNG capture and close paths against independent server
implementations.

It covers this matrix:

| Outer SSH authentication | Inner VNC profile |
| ------------------------ | ----------------- |
| Password                 | X509Vnc           |
| Password                 | X509Plain         |
| Public key               | X509Vnc           |
| Public key               | X509Plain         |

The gate pins Ubuntu 24.04 `openssh-server` version
`1:9.6p1-3ubuntu13.14` and TigerVNC version
`1.13.1+dfsg-2build2`. Missing or different packages fail the requested run.
Changing either pin requires a reviewed compatibility update; ordinary package
drift is not acceptance evidence.

The test is ignored by default. A normal `cargo test` does not establish this
interop boundary.

## Safety boundary

Run only on a disposable Ubuntu 24.04 host, VM or owner-authorized development
machine on which creating and deleting one test account is acceptable. The
procedure refuses to reuse the chosen account, starts an isolated loopback
`sshd` with generated host and client keys, uses an ephemeral port and starts
TigerVNC's own isolated X server. It must not point at an existing SSH daemon,
VNC desktop, user, key, password, port or service configuration.

OpenSSH protects the Runner-to-SSH-server hop. The `127.0.0.1:<ephemeral>` RFB
destination is opened by that SSH server. TigerVNC independently presents a
certificate for `localhost`; the Runner verifies that identity with the
fixture-generated CA. No route substitution or raw-TCP fallback is permitted.

## Prerequisites

Install the exact packages:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends \
  openssh-server=1:9.6p1-3ubuntu13.14 \
  openssh-client=1:9.6p1-3ubuntu13.14 \
  tigervnc-standalone-server=1.13.1+dfsg-2build2 \
  tigervnc-tools=1.13.1+dfsg-2build2 \
  python3-xlib=0.33-2 x11-xserver-utils openssl
```

Build the current exact-head Runner test before changing host state:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p runner \
  ssh::tests::vnc_interoperability::pinned_openssh_tigervnc_vnc_transport_acceptance \
  --no-run
```

Locate the test executable produced by that command and record its SHA-256 and
the current commit. Do not reuse a binary built from another head.

## Disposable setup and run

The following reference procedure intentionally requires explicit local review.
It generates the password without printing it, binds only loopback, permits only
local TCP forwarding, and removes the account and all generated material on
exit. Choose a unique account name; the procedure refuses an existing one.

```sh
VNC_ACCEPT_USER="okou-vnc-accept-$$"
if id "$VNC_ACCEPT_USER" >/dev/null 2>&1; then
  echo "refusing to reuse existing account: $VNC_ACCEPT_USER" >&2
  exit 1
fi
VNC_ACCEPT_DIR="$(mktemp -d /tmp/okou-vnc-ssh-accept.XXXXXX)"
case "$VNC_ACCEPT_DIR" in
  /tmp/okou-vnc-ssh-accept.*) ;;
  *) echo "unexpected acceptance directory" >&2; exit 1 ;;
esac
VNC_ACCEPT_PASSWORD="$(openssl rand -base64 24)"
VNC_SSHD_PID=""

cleanup_vnc_acceptance() {
  if [ -n "$VNC_SSHD_PID" ]; then
    sudo kill "$VNC_SSHD_PID" 2>/dev/null || true
    wait "$VNC_SSHD_PID" 2>/dev/null || true
  fi
  sudo userdel --remove "$VNC_ACCEPT_USER" 2>/dev/null || true
  case "$VNC_ACCEPT_DIR" in
    /tmp/okou-vnc-ssh-accept.*) sudo rm -rf -- "$VNC_ACCEPT_DIR" ;;
  esac
  unset VNC_ACCEPT_PASSWORD
}
trap cleanup_vnc_acceptance EXIT INT TERM

sudo useradd --create-home --shell /bin/bash "$VNC_ACCEPT_USER"
printf '%s:%s\n' "$VNC_ACCEPT_USER" "$VNC_ACCEPT_PASSWORD" | sudo chpasswd
ssh-keygen -q -t ed25519 -N '' -f "$VNC_ACCEPT_DIR/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$VNC_ACCEPT_DIR/client_key"
sudo install -d -m 700 -o "$VNC_ACCEPT_USER" -g "$VNC_ACCEPT_USER" \
  "/home/$VNC_ACCEPT_USER/.ssh"
sudo install -m 600 -o "$VNC_ACCEPT_USER" -g "$VNC_ACCEPT_USER" \
  "$VNC_ACCEPT_DIR/client_key.pub" \
  "/home/$VNC_ACCEPT_USER/.ssh/authorized_keys"

VNC_OPENSSH_PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
sudo tee "$VNC_ACCEPT_DIR/sshd_config" >/dev/null <<EOF
Port $VNC_OPENSSH_PORT
ListenAddress 127.0.0.1
HostKey $VNC_ACCEPT_DIR/host_key
PidFile $VNC_ACCEPT_DIR/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
PermitRootLogin no
AllowUsers $VNC_ACCEPT_USER
AllowTcpForwarding local
PermitOpen 127.0.0.1:*
GatewayPorts no
X11Forwarding no
PermitTTY no
LogLevel VERBOSE
EOF
sudo sh -c \
  "exec /usr/sbin/sshd -D -e -f '$VNC_ACCEPT_DIR/sshd_config' 2>'$VNC_ACCEPT_DIR/sshd.log'" &
VNC_SSHD_PID=$!
VNC_SSHD_READY=""
for _ in $(seq 1 20); do
  if ssh-keyscan -T 1 -p "$VNC_OPENSSH_PORT" 127.0.0.1 >/dev/null 2>&1; then
    VNC_SSHD_READY=1
    break
  fi
done
test "$VNC_SSHD_READY" = 1

VNC_OPENSSH_VERSION="$(dpkg-query -W -f='${Version}' openssh-server)"
test "$VNC_OPENSSH_VERSION" = "1:9.6p1-3ubuntu13.14"
VNC_OPENSSH_HOST_KEY_ALGORITHM="$(awk '{print $1}' "$VNC_ACCEPT_DIR/host_key.pub")"
VNC_OPENSSH_HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$VNC_ACCEPT_DIR/host_key.pub" -E sha256 | awk '{print $2}')"
VNC_RUNNER_TEST_BINARY="$(find crates/target/local/deps -maxdepth 1 -type f \
  -name 'runner-*' -perm -111 -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
test -n "$VNC_RUNNER_TEST_BINARY"
sudo install -m 755 "$VNC_RUNNER_TEST_BINARY" "$VNC_ACCEPT_DIR/runner-tests"
sudo install -m 644 crates/rfb-client/tests/fixtures/tigervnc.py \
  "$VNC_ACCEPT_DIR/tigervnc.py"
sudo chown -R "$VNC_ACCEPT_USER:$VNC_ACCEPT_USER" "$VNC_ACCEPT_DIR"

sudo -u "$VNC_ACCEPT_USER" env \
  HOME="/home/$VNC_ACCEPT_USER" \
  TMPDIR="$VNC_ACCEPT_DIR" \
  VNC_OPENSSH_VERSION="$VNC_OPENSSH_VERSION" \
  VNC_OPENSSH_PORT="$VNC_OPENSSH_PORT" \
  VNC_OPENSSH_USERNAME="$VNC_ACCEPT_USER" \
  VNC_OPENSSH_PASSWORD="$VNC_ACCEPT_PASSWORD" \
  VNC_OPENSSH_PRIVATE_KEY="$VNC_ACCEPT_DIR/client_key" \
  VNC_OPENSSH_HOST_KEY_ALGORITHM="$VNC_OPENSSH_HOST_KEY_ALGORITHM" \
  VNC_OPENSSH_HOST_KEY_FINGERPRINT="$VNC_OPENSSH_HOST_KEY_FINGERPRINT" \
  RFB_TIGERVNC_FIXTURE="$VNC_ACCEPT_DIR/tigervnc.py" \
  RFB_TIGERVNC_PLAIN_USERNAME="$VNC_ACCEPT_USER" \
  RFB_TIGERVNC_PLAIN_PASSWORD="$VNC_ACCEPT_PASSWORD" \
  RFB_TIGERVNC_PAM_SERVICE=tigervnc \
  "$VNC_ACCEPT_DIR/runner-tests" \
  ssh::tests::vnc_interoperability::pinned_openssh_tigervnc_vnc_transport_acceptance \
  --ignored --exact --nocapture
```

Do not omit the test filter: running the complete Runner binary test suite on an
acceptance host is outside this procedure.

## Evidence and cleanup

Record all of the following against the exact PR head:

- commit and test-binary SHA-256;
- `dpkg-query` versions for OpenSSH and TigerVNC;
- the four matrix cases and their start/status/capture/close result;
- the pinned host-key algorithm/fingerprint and non-secret loopback topology;
- certificate identity `localhost` and exact forwarded RFB port;
- test exit status;
- confirmation that the isolated `sshd`, TigerVNC/X server, disposable account,
  temporary home, keys, certificates and scratch directory no longer exist.

The existing deterministic Runner/API tests remain authoritative for negative
cases: wrong SSH/VNC credentials, bad host key, channel refusal, certificate
identity mismatch, unsupported Runner tuples, route/grant/generation changes,
cancellation, capacity and cleanup. This external matrix proves independent
implementation compatibility and does not replace those cases.
