# Pinned TigerVNC session acceptance

The explicit ignored test connects the production authentication, framebuffer,
session, input and PNG paths to TigerVNC **1.13.1**, packaged by Ubuntu 24.04 as
**1.13.1+dfsg-2build2**. The fixture checks the exact installed package version;
missing tools or a different version fail the requested acceptance run.

This is an external-server gate, separate from the ordinary deterministic test
suite. A default `cargo test` reports it as ignored and does not establish
TigerVNC interoperability. Run it explicitly before exposing this engine through
Runner or user-facing commands.

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

No existing desktop, VNC service or saved credentials are used. The fixture
starts its own X server on an unused display and an ephemeral loopback TCP port,
with X11 TCP disabled. It creates a temporary CA and localhost/IP SAN server
certificate, and the synthetic password `testpass`. The client verifies that CA
and identity through the same X509Vnc authentication used by production.

Normal completion waits for both fixture and server exit. On a failed or
cancelled Rust test, the child guard kills the Python fixture; Linux
`PR_SET_PDEATHSIG` also terminates that fixture's X server. Temporary certificate
and password files are held by the test's temporary directory. Every setup and
XRandR helper has a ten-second execution limit and the same parent-death guard.

## Assertions and limits

The test runs both ZRLE and Raw, using a module-private SetEncodings adapter only
in the test. Production does not gain an encoding override. For each mode it:

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
