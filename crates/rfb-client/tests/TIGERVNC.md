# Pinned TigerVNC session acceptance

The explicit ignored test connects the production authentication, framebuffer,
session, input and PNG paths to TigerVNC **1.13.1**, packaged by Ubuntu 24.04 as
**1.13.1+dfsg-2build2**. The fixture checks the exact installed package version;
missing tools or a different version fail the requested acceptance run.

This is an external-server gate, separate from the ordinary deterministic test
suite. A default `cargo test` reports its tests as ignored and does not establish
TigerVNC interoperability. Run the relevant commands explicitly before exposing
an engine profile through Runner or user-facing commands.

## Environment and command

Use a disposable Ubuntu 24.04 x86_64 environment, or an authorized development
host. Install only the fixture prerequisites:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends \
  tigervnc-standalone-server=1.13.1+dfsg-2build2 \
  tigervnc-tools=1.13.1+dfsg-2build2 \
  python3-xlib=0.33-2 x11-xserver-utils openssl
```

The Ubuntu archive SHA-256 of
`tigervnc-standalone-server_1.13.1+dfsg-2build2_amd64.deb` is
`a51c4686dc0e95fdc8fb7109ef17a7399267eb70a1a58df2ab2c6f155448584b`.
The upstream tag is
[`v1.13.1`](https://github.com/TigerVNC/tigervnc/tree/v1.13.1).

From the repository root:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client \
  --lib tigervnc_tests::pinned_tigervnc_session_acceptance -- \
  --ignored --exact --nocapture
```

That command retains the complete X509Vnc framebuffer/input session matrix. Run
the independent X509None authentication boundary separately:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client \
  --lib tigervnc_tests::pinned_tigervnc_x509_none_authentication_acceptance -- \
  --ignored --exact --nocapture
```

X509Plain uses TigerVNC's real `PlainUsers` and PAM validation rather than a test
bypass. Ubuntu's `pam_unix` helper permits the unprivileged TigerVNC process to
validate the account that runs it, not a different user's shadow password. On an
authorized disposable Ubuntu host, build the current test, copy only its binary
and fixture to an isolated directory, create an otherwise unused temporary
account, run both TigerVNC and the client test as that account, and remove every
artifact. The example generates the password without printing it; do not run
these account or mode mutations on a persistent or shared host:

```sh
RFB_ACCEPT_USER=rfb-accept-test
RFB_ACCEPT_PASSWORD="$(openssl rand -base64 24)"
if id "$RFB_ACCEPT_USER" >/dev/null 2>&1; then
  echo "refusing to reuse existing account: $RFB_ACCEPT_USER" >&2
  exit 1
fi
sudo useradd --no-create-home --shell /bin/bash "$RFB_ACCEPT_USER"
RFB_ACCEPT_DIR=
cleanup_rfb_accept_user() {
  sudo userdel "$RFB_ACCEPT_USER"
  if [ -n "$RFB_ACCEPT_DIR" ]; then
    rm -rf -- "$RFB_ACCEPT_DIR"
  fi
  unset RFB_ACCEPT_PASSWORD
}
trap cleanup_rfb_accept_user EXIT
printf '%s:%s\n' "$RFB_ACCEPT_USER" "$RFB_ACCEPT_PASSWORD" | sudo chpasswd
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client --lib --no-run
RFB_TEST_BINARY="$(find crates/target/local/deps -maxdepth 1 -type f \
  -name 'rfb_client-*' -perm -111 -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
RFB_ACCEPT_DIR="$(mktemp -d /tmp/rfb-client-acceptance.XXXXXX)"
install -m 755 "$RFB_TEST_BINARY" "$RFB_ACCEPT_DIR/rfb-client-tests"
install -m 644 crates/rfb-client/tests/fixtures/tigervnc.py "$RFB_ACCEPT_DIR/tigervnc.py"
chmod 755 "$RFB_ACCEPT_DIR"
sudo -u "$RFB_ACCEPT_USER" env \
  HOME=/tmp \
  RFB_TIGERVNC_PLAIN_USERNAME="$RFB_ACCEPT_USER" \
  RFB_TIGERVNC_PLAIN_PASSWORD="$RFB_ACCEPT_PASSWORD" \
  RFB_TIGERVNC_PAM_SERVICE=tigervnc \
  RFB_TIGERVNC_FIXTURE="$RFB_ACCEPT_DIR/tigervnc.py" \
  "$RFB_ACCEPT_DIR/rfb-client-tests" \
  tigervnc_tests::pinned_tigervnc_x509_plain_authentication_acceptance \
  --ignored --exact --nocapture
```

The fixture passes only the username to TigerVNC's `PlainUsers` option. The
password remains in the disposable account's test-process environment long
enough to construct a zeroizing `PlainCredentials` value and is never printed by
the fixture. The packaged `/etc/pam.d/tigervnc` service performs the independent
verification.

No existing desktop, VNC service or saved credentials are used. The fixture
starts its own X server on an unused display and an ephemeral loopback TCP port,
with X11 TCP disabled. It creates a temporary CA and localhost/IP SAN server
certificate, and, for X509Vnc, the synthetic password `testpass`. Each server
advertises exactly one requested security type. The client verifies the same CA
and identity before completing the selected authentication.

Normal completion waits for both fixture and server exit. On a failed or
cancelled Rust test, the child guard kills the Python fixture; Linux
`PR_SET_PDEATHSIG` also terminates that fixture's X server. Temporary certificate
and password files are held by the test's temporary directory. Every setup and
XRandR helper has a ten-second execution limit and the same parent-death guard.

## Assertions and limits

The X509Vnc session test runs both ZRLE and Raw, using a module-private
SetEncodings adapter only in the test. Production does not gain an encoding
override. Every session connection
explicitly requests `SharingMode::Shared`; this harness does not establish
exclusive-mode behavior for any server policy. For each encoding it:

- Checks exact initial framebuffer pixels and a changed rectangle.
- Uses an actual X11 `CopyArea` and an incremental update to verify copied
  pixels. TigerVNC's per-connection log must report CopyRect and the requested
  Raw/ZRLE encoder, so the test does not infer which encoding was exercised.
- Calls the public session capture API and decodes its PNG, checking dimensions,
  RGBA color and pixel contents.
- Sends ASCII and Chinese text (`a中文`), a Control+A chord, click, drag and wheel
  operations. A focused X11 application observes exact press/release keysyms,
  button identities and endpoint coordinates. Chinese is sent as Unicode X11
  keysyms; this establishes delivery to this application, not IME compatibility
  or text insertion into every application or keyboard layout.
- Installs a known cursor shape and checks its pixels and hotspot separately
  while confirming the captured PNG excludes cursor composition.
- Resizes the server through XRandR, checks new capture dimensions and geometry
  epoch, and verifies old coordinate tokens are rejected before input starts.
- Closes the session and waits for TigerVNC to observe the disconnect.

The fixture synchronizes on observed X11 events and server state with bounded
deadlines. A completed input write or fresh capture is not an application-settled
acknowledgement. Full captures request actual pixels; the separate incremental
decoder phase is necessary to exercise CopyRect.

## Running a compiled test on another host

The fixture path can be supplied before process startup using
`RFB_TIGERVNC_FIXTURE`. This allows a locally built matching-platform test binary
and the tracked Python fixture to be uploaded to an isolated directory on an
authorized development host without building the entire workspace there:

```sh
RFB_TIGERVNC_FIXTURE=/absolute/path/tigervnc.py ./rfb-client-tests \
  tigervnc_tests::pinned_tigervnc_session_acceptance \
  --ignored --exact --nocapture
```

Use the current compiled test binary, verify upload checksums, and record its
source revision and observed test result. An earlier binary or a standalone
protocol probe does not validate a later session implementation.
