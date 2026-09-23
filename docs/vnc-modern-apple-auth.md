# Modern Apple VNC authentication: Linux verification boundary

This document records the bounded Linux-side verification for [issue
#35867](https://github.com/okou-ai/okou/issues/35867). It is a research record,
not a compatibility claim or a production activation decision.

## What Linux verifies

The Linux test runner can exercise Okou's generic RFB engine against synthetic
protocol peers, and can act as a client for a real macOS VNC server when an
authorized macOS endpoint is available. The current Linux-only run covered the
existing RFB 3.8 / VeNCrypt profiles at repository revision
`5f2c507897b4877aa25780ccc374bc526f4b297f`:

| Suite                       |       Result | Evidence boundary                                                                                                                                               |
| --------------------------- | -----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfb-client` authentication | 25/25 passed | Synthetic TCP/TLS peers; X509None, X509Vnc and X509Plain negotiation, trust-before-credential ordering, bounds, cancellation and fail-closed downgrade handling |
| framebuffer                 | 29/29 passed | Synthetic RFB peers; decoding, coverage, resize, limits and malformed input                                                                                     |
| session                     | 16/16 passed | Synthetic RFB peers; capture, input, cancellation, geometry and cleanup                                                                                         |
| session limits              |   3/3 passed | Synthetic RFB peers; PNG and shared-memory budgets                                                                                                              |

Commands used:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client \
  --test authentication -- --nocapture
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client \
  --test framebuffer --test session --test session_limits -- --nocapture
```

The pinned external TigerVNC acceptance harness remains a separate Linux
server-side check. It was not run in this environment because its fixed
TigerVNC/Xvfb prerequisites were not installed. The available authorized VNC
inventory also contained no macOS endpoint.

## What Linux does not establish

A Linux VNC server does not reproduce macOS Screen Sharing or Remote Management
behavior. These tests therefore do not establish:

- which macOS build and settings offer or select SRP or RSA-host-key
  authentication;
- Apple's credential framing, account/session selection, or server-key trust;
- whether an authenticated exchange protects the full RFB session; or
- noninteractive macOS credential rotation, revocation and cancellation
  behavior.

An actual macOS server can be tested from Linux, but the server build and
configuration remain part of the evidence. A synthetic Linux peer is useful for
bounded parser and state-machine tests only.

## Current conclusions

- **SRP:** blocked. The repository has no macOS fixture, authorized macOS probe,
  complete wire contract, or independent viewer cross-check.
- **RSA-host-key:** blocked for the same reasons; the name must not be treated
  as evidence for the distinct RA2/RSA-AES family.
- **Password-based non-Apple VNC access:** a separate standard VNC profile. It
  must not be used as evidence for modern Apple authentication or silently
  broaden the existing X509Vnc/X509Plain profiles.

The product remains default-off and fail-closed for unsupported profiles. No
Apple authentication implementation, schema/API change, feature activation or
production access is implied by the Linux results.

## Evidence required to resume Apple compatibility work

The next probe needs an owner-authorized disposable macOS server with its exact
OS/build and Remote Management or Screen Sharing settings recorded. The probe
must capture the offered and selected path, successful and failed authentication,
server-identity evidence, session-protection evidence and an independent viewer
cross-check where available. SRP and RSA-host-key must receive separate `go`,
`no-go` or `blocked` conclusions before a protocol implementation child is
created.
