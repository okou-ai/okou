# Installed OpenSSH plus pinned TigerVNC interoperability

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

Run on Ubuntu 24.04 with the installed `openssh-server` and
`openssh-client`, and record both exact package versions in the evidence. Do
not downgrade a working SSH installation just to run this test. TigerVNC is
pinned to `1.13.1+dfsg-2build2`; a missing or different TigerVNC package fails
the requested run. Changing that pin requires a reviewed compatibility update.
A pass on one installed OpenSSH version is evidence for that version, not an
unexecuted OpenSSH version or a substitute for an owner-to-Agent workflow.

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

On a disposable machine where package installation is authorized, ensure
`openssh-server`, `openssh-client`, `tigervnc-standalone-server`,
`tigervnc-tools`, `python3-xlib`, `x11-xserver-utils` and `openssl` are
available. Do not replace the installed OpenSSH version. TigerVNC must be
`1.13.1+dfsg-2build2`; verify with `dpkg-query` before starting the fixture.
If the existing host lacks a dependency and installing it is not authorized,
use an isolated environment or stop rather than changing the host. For an
isolated `python3-xlib` extraction, export `VNC_ACCEPT_PYTHONPATH` as the
absolute, test-account-readable directory containing `Xlib/__init__.py` (for
example, its `usr/lib/python3/dist-packages` directory). Use only a trusted
package and remove the extraction after the test; otherwise leave the variable
unset and use the system `/usr/bin/python3` installation. The script checks the
import as the disposable account before starting sshd.

Build the current exact-head Runner test before changing host state:

```sh
git rev-parse HEAD
cargo test --manifest-path crates/Cargo.toml --profile local -p runner-remote --lib \
  ssh::tests::vnc_interoperability::installed_openssh_tigervnc_vnc_transport_acceptance \
  --no-run
```

Copy the exact `runner_remote-*` executable path printed by this Cargo invocation
(`Executable unittests src/lib.rs (...)`) into `VNC_RUNNER_TEST_BINARY` and export
it for the separate Bash script below. Do not select the newest file in a shared
build directory: it may come from another head even if it lists the same test.
Record the commit and binary SHA-256. Do not use the `runner` package's different
test executable.

## Disposable setup and run

The following reference procedure intentionally requires explicit local review.
It generates the password without printing it, binds only loopback, permits only
local TCP forwarding, and cleans up the owned account and generated material
on exit. A failed cleanup exits nonzero and reports residual resources for
manual inspection. Choose a unique account name; the procedure refuses an
existing one.
From the repository root, save the block as a Bash script and run it with the
exact build-output path exported, for example
`export VNC_RUNNER_TEST_BINARY=crates/target/local/deps/runner_remote-<hash>`.
Do not paste the block into an existing interactive shell: its traps and
fail-fast settings belong to the standalone script.

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
: "${VNC_RUNNER_TEST_BINARY:?set this to the exact executable path printed by Cargo}"
case "$VNC_RUNNER_TEST_BINARY" in
  */deps/runner_remote-*) ;;
  *) echo "unexpected Runner test binary path" >&2; exit 1 ;;
esac
test -x "$VNC_RUNNER_TEST_BINARY"
VNC_ACCEPT_PYTHONPATH="${VNC_ACCEPT_PYTHONPATH:-}"
if [ -n "$VNC_ACCEPT_PYTHONPATH" ]; then
  case "$VNC_ACCEPT_PYTHONPATH" in
    /*) ;;
    *) echo "isolated Python path must be absolute" >&2; exit 1 ;;
  esac
  test -r "$VNC_ACCEPT_PYTHONPATH/Xlib/__init__.py"
fi
"$VNC_RUNNER_TEST_BINARY" --list --ignored | grep -F \
  'ssh::tests::vnc_interoperability::installed_openssh_tigervnc_vnc_transport_acceptance' >/dev/null
printf 'test_source_sha=%s\n' "$(git rev-parse HEAD)"
sha256sum "$VNC_RUNNER_TEST_BINARY"
VNC_OPENSSH_VERSION="$(dpkg-query -W -f='${Version}' openssh-server)"
VNC_OPENSSH_CLIENT_VERSION="$(dpkg-query -W -f='${Version}' openssh-client)"
VNC_TIGERVNC_VERSION="$(dpkg-query -W -f='${Version}' tigervnc-standalone-server)"
test "$VNC_TIGERVNC_VERSION" = '1.13.1+dfsg-2build2'
printf 'OpenSSH server=%s client=%s; TigerVNC=%s\n' \
  "$VNC_OPENSSH_VERSION" "$VNC_OPENSSH_CLIENT_VERSION" "$VNC_TIGERVNC_VERSION"
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
VNC_ACCEPT_PASSWORD=""
VNC_ACCEPT_CREATED=0
VNC_SSHD_PID=""

cleanup_vnc_acceptance() {
  local result=$? command_line="" preserve_scratch=0
  trap - EXIT INT TERM
  if [ -z "$VNC_SSHD_PID" ] && [ -f "$VNC_ACCEPT_DIR/sshd.pid" ]; then
    VNC_SSHD_PID="$(sudo cat "$VNC_ACCEPT_DIR/sshd.pid" 2>/dev/null)" || {
      echo "cannot read isolated sshd PID; retain scratch for inspection" >&2
      preserve_scratch=1
      result=1
    }
  fi
  if [[ "$VNC_SSHD_PID" =~ ^[0-9]+$ ]]; then
    command_line="$(sudo ps -p "$VNC_SSHD_PID" -o args= 2>/dev/null || true)"
    if [[ "$command_line" == *"$VNC_ACCEPT_DIR/sshd_config"* ]]; then
      sudo kill "$VNC_SSHD_PID" 2>/dev/null || result=1
      for _ in $(seq 1 50); do
        command_line="$(sudo ps -p "$VNC_SSHD_PID" -o args= 2>/dev/null || true)"
        [[ "$command_line" == *"$VNC_ACCEPT_DIR/sshd_config"* ]] || break
        sleep 0.1
      done
      # If the isolated daemon does not exit, retain its files for manual
      # inspection instead of force-killing a PID that could have been reused.
    elif [ -n "$command_line" ]; then
      echo "refusing to kill an unrelated sshd PID" >&2
      preserve_scratch=1
      result=1
    fi
    if [ -d "/proc/$VNC_SSHD_PID" ]; then
      command_line="$(sudo ps -p "$VNC_SSHD_PID" -o args= 2>/dev/null || true)"
      if [[ "$command_line" == *"$VNC_ACCEPT_DIR/sshd_config"* || -z "$command_line" ]]; then
        echo "cannot confirm isolated sshd has exited; retain scratch" >&2
        preserve_scratch=1
        result=1
      fi
    fi
  elif [ -n "$VNC_SSHD_PID" ]; then
    echo "invalid isolated sshd PID; inspect before manual cleanup" >&2
    preserve_scratch=1
    result=1
  fi
  if (( VNC_ACCEPT_CREATED )); then
    sudo userdel --remove "$VNC_ACCEPT_USER" 2>/dev/null || result=1
  fi
  if (( ! preserve_scratch )) && [[ "$VNC_ACCEPT_DIR" == /tmp/okou-vnc-ssh-accept.* &&
        -d "$VNC_ACCEPT_DIR" && ! -L "$VNC_ACCEPT_DIR" ]]; then
    sudo rm -rf -- "$VNC_ACCEPT_DIR" || result=1
  fi
  if [ -e "$VNC_ACCEPT_DIR" ] || id "$VNC_ACCEPT_USER" >/dev/null 2>&1; then
    echo "acceptance resources remain; inspect and clean them manually" >&2
    result=1
  fi
  unset VNC_ACCEPT_PASSWORD
  exit "$result"
}
trap cleanup_vnc_acceptance EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

VNC_ACCEPT_PASSWORD="$(openssl rand -base64 24)"
sudo useradd --create-home --shell /bin/bash "$VNC_ACCEPT_USER"
VNC_ACCEPT_CREATED=1
sudo -u "$VNC_ACCEPT_USER" env PYTHONPATH="$VNC_ACCEPT_PYTHONPATH" \
  /usr/bin/python3 -c 'from Xlib import X, display'
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
sudo /usr/sbin/sshd -f "$VNC_ACCEPT_DIR/sshd_config" \
  -E "$VNC_ACCEPT_DIR/sshd.log"
VNC_SSHD_PID="$(sudo cat "$VNC_ACCEPT_DIR/sshd.pid")"
VNC_SSHD_READY=""
for _ in $(seq 1 20); do
  if ssh-keyscan -T 1 -p "$VNC_OPENSSH_PORT" 127.0.0.1 >/dev/null 2>&1; then
    VNC_SSHD_READY=1
    break
  fi
done
test "$VNC_SSHD_READY" = 1

VNC_OPENSSH_HOST_KEY_ALGORITHM="$(awk '{print $1}' "$VNC_ACCEPT_DIR/host_key.pub")"
VNC_OPENSSH_HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$VNC_ACCEPT_DIR/host_key.pub" -E sha256 | awk '{print $2}')"
printf 'ssh_loopback=127.0.0.1:%s host_key=%s/%s\n' \
  "$VNC_OPENSSH_PORT" "$VNC_OPENSSH_HOST_KEY_ALGORITHM" "$VNC_OPENSSH_HOST_KEY_FINGERPRINT"
sudo install -m 755 "$VNC_RUNNER_TEST_BINARY" "$VNC_ACCEPT_DIR/runner-tests"
sudo install -m 644 crates/rfb-client/tests/fixtures/tigervnc.py \
  "$VNC_ACCEPT_DIR/tigervnc.py"
# The test account only needs a private work directory and its client key.
# Keep sshd_config, sshd.pid, sshd.log and the host key unwritable by it.
sudo install -d -m 700 -o "$VNC_ACCEPT_USER" -g "$VNC_ACCEPT_USER" \
  "$VNC_ACCEPT_DIR/test"
sudo install -m 600 -o "$VNC_ACCEPT_USER" -g "$VNC_ACCEPT_USER" \
  "$VNC_ACCEPT_DIR/client_key" "$VNC_ACCEPT_DIR/test/client_key"
chmod 711 "$VNC_ACCEPT_DIR"

sudo -u "$VNC_ACCEPT_USER" env \
  HOME="/home/$VNC_ACCEPT_USER" \
  TMPDIR="$VNC_ACCEPT_DIR/test" \
  PYTHONPATH="$VNC_ACCEPT_PYTHONPATH" \
  VNC_OPENSSH_VERSION="$VNC_OPENSSH_VERSION" \
  VNC_OPENSSH_PORT="$VNC_OPENSSH_PORT" \
  VNC_OPENSSH_USERNAME="$VNC_ACCEPT_USER" \
  VNC_OPENSSH_PASSWORD="$VNC_ACCEPT_PASSWORD" \
  VNC_OPENSSH_PRIVATE_KEY="$VNC_ACCEPT_DIR/test/client_key" \
  VNC_OPENSSH_HOST_KEY_ALGORITHM="$VNC_OPENSSH_HOST_KEY_ALGORITHM" \
  VNC_OPENSSH_HOST_KEY_FINGERPRINT="$VNC_OPENSSH_HOST_KEY_FINGERPRINT" \
  RFB_TIGERVNC_FIXTURE="$VNC_ACCEPT_DIR/tigervnc.py" \
  RFB_TIGERVNC_PLAIN_USERNAME="$VNC_ACCEPT_USER" \
  RFB_TIGERVNC_PLAIN_PASSWORD="$VNC_ACCEPT_PASSWORD" \
  RFB_TIGERVNC_PAM_SERVICE=tigervnc \
  "$VNC_ACCEPT_DIR/runner-tests" \
  ssh::tests::vnc_interoperability::installed_openssh_tigervnc_vnc_transport_acceptance \
  --ignored --exact --nocapture
```

Do not omit the test filter: running the complete Runner binary test suite on an
acceptance host is outside this procedure.

## Evidence and cleanup

Record all of the following against the exact PR head:

- commit and test-binary SHA-256;
- `dpkg-query` versions for both installed OpenSSH packages and pinned TigerVNC;
- the four matrix cases and their start/status/capture/close result, including
  each `matrix_case_destination` RFB port;
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
