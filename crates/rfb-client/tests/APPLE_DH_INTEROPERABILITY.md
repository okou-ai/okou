# Apple DH / ARD type 30 interoperability

The ordinary `rfb-client` suite uses a synthetic peer and deliberately skips
the two `pinned_mac_type_30_*` tests. Passing that suite alone is **not** a
macOS compatibility claim. Run the ignored tests only against an authorized
Mac with Remote Management and a dedicated test account; do not point them at
a personal desktop or reuse production credentials.

## Verified environment and result

On 2026-09-23, the current source was cross-compiled as an AArch64 Linux test
binary and run from the authorized `dev-1` host. An SSH local forward terminated
on the Mac itself, forwarding to its loopback `127.0.0.1:5900`; there was no
plaintext onward hop. The Mac ran macOS 26.6.2 (25G83), Remote Management with
`ControlObserve`, and a synthetic account. Legacy VNC password access was off.

The server advertised `RFB 003.889` and security types 30, 33 and 36. A pinned
independent LibVNCserver ARD client (pinned at
`b16271e95d53aae7a93c3d5bc9b86f6072ab3a56`) first proved that correct credentials reached
ServerInit and wrong credentials failed; the current engine then independently
authenticated with type 30, initialized a shared session, captured a 1024x768
framebuffer and sent a balanced Shift press/release. The input test establishes
successful RFB write only, not application receipt or general macOS input
compatibility. The separate wrong-password engine test verifies rejection.

The observed server used generator 5 and a stable, full-width 4096-bit modulus
over two connections. This is one macOS version/configuration, not coverage of
all Apple DH implementations. The implementation bounds modulus size, parity
and public-value range but does **not** prove primality or authenticate the
server. Apple DH also leaves the later RFB session unencrypted. Product
admission must require a verified outer channel that terminates on the Mac.

## Reproducing the tests

Build the test binary for the host architecture with the current source, and
provide a Mac-local forwarded endpoint and synthetic credentials as environment
variables. Never pass a real password on the command line or include it in test
logs. Run both tests explicitly; they remain ignored in the default suite:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client \
  --test apple_dh --no-run
OKOU_MAC_VNC_ENDPOINT=127.0.0.1:15901 \
OKOU_MAC_VNC_USER="$TEST_USER" \
OKOU_MAC_VNC_PASSWORD="$TEST_PASSWORD" \
  "$MATCHING_TEST_BINARY" pinned_mac_type_30_capture_and_safe_input \
  --ignored --exact --nocapture
OKOU_MAC_VNC_ENDPOINT=127.0.0.1:15901 \
OKOU_MAC_VNC_USER="$TEST_USER" \
  "$MATCHING_TEST_BINARY" pinned_mac_type_30_rejects_wrong_password \
  --ignored --exact --nocapture
```

The forward should be bound to local loopback, use pinned SSH host identity,
and terminate on the Mac before reaching its loopback VNC port. The test keeps
no screenshot, password, private key or raw framebuffer artifact. A future Mac
version or configuration must be retested rather than inferred from this run.
