# Modern Apple VNC authentication: bounded research evidence

This document records Linux and disposable-Mac verification for [issue
#35867](https://github.com/okou-ai/okou/issues/35867). It is a research record,
not a claim that Okou can yet connect to a Mac or a production activation decision.

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
server-side check. It was not run in that environment because its fixed
TigerVNC/Xvfb prerequisites were not installed. No macOS endpoint was available
for that Linux run; a separate owner-authorized Mac probe followed.

## Disposable macOS 26.6.2 probe (2026-09-23)

An owner-authorized Amazon EC2 `mac2.metal` (Apple M1, ARM64) in `us-west-2`
ran the official macOS 26.6.2 AMI `ami-0e971f0ce976b2435`, build `25G83`.
It was private-network-only; SSH and TCP 5900 were allowed only from a named
development security group. Remote Management was enabled using Apple's
`kickstart`, restricted to a disposable standard local account. The legacy
"VNC viewers may control screen with password" mode was **disabled**
(`VNCLegacyConnectionsEnabled = 0`), and remote-control approval was disabled
(`ScreenSharingReqPermEnabled = 0`). No LDAP, MDM, or interactive approval was
used. Initial attempts failed while the test account's ARD `naprivs` bitmask
still denied access; an explicit user-scoped `kickstart -privs -all` set a
non-denying test bitmask before the successful probes. This does **not** prove
the minimum ARD privilege needed for production.

| Server and configuration                                                         | Observed RFB offer or selected path                                                                    | Authentication result                                                                                                                     | Protection and identity evidence                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 26.6.2 Remote Management; local synthetic account; legacy VNC password off | Banner `RFB 003.889`; offered numeric types `30, 33, 36` from an RFB 3.8 client                        | Offer only; no credential sent                                                                                                            | IANA allocates 30–36 to Apple; the offer alone does not identify their wire contracts.                                                                                  |
| Same server; forced type `36`                                                    | macOS `screensharingd` logged `SendSRPChallenge` and two SRP mechanism steps                           | Correct password authenticated and returned a 1024×768 `ServerInit`; wrong password was rejected with a server-side evidence-mismatch log | A synthetic in-memory TCP relay observed the desktop name in plaintext _after_ authentication. Server proof validation and full-session encryption are not established. |
| Same server; forced type `33`                                                    | macOS logged `SendRSAResponse`, 2048-bit default RSA key size, then `SendRSAResponseSRPAuthentication` | Correct password authenticated and returned the same `ServerInit`; wrong password was rejected with a server-side evidence-mismatch log   | The same relay observed plaintext post-auth `ServerInit`. The test client did not demonstrate a pinned or otherwise verified server RSA host key.                       |

The forced-path independent client was LibVNCserver's unmerged
[ARD auth PR #698](https://github.com/LibVNC/libvncserver/pull/698) at exact
commit `b16271e95d53aae7a93c3d5bc9b86f6072ab3a56`, built on the Mac against
OpenSSL 3.6.3. Its `ardauthprobe` reported `AUTH_OK` for types 33 and 36 only
with the valid synthetic local-account password. The Mac's unified logs
independently showed the selected path and rejected bad evidence. The relay
retained no wire bytes and output only whether the known, non-secret desktop
name appeared in plaintext. No password, private key, raw capture, or server
identity material is included here. This is a one-build/one-configuration
interoperability result, not a release-pinned cross-version fixture or an
endorsement of the experimental client implementation.

## What Linux does not establish

A Linux VNC server does not reproduce macOS Screen Sharing or Remote Management
behavior. The new Mac probe narrows, but does not close, the following gaps:

- a cross-version/configuration matrix (including Screen Sharing, LDAP and
  different ARD privileges), nor a complete public wire contract;
- server-key trust, verified SRP server proof, or account/session selection;
- whether framebuffer and input messages are protected (the observed plaintext
  `ServerInit` already rules out claiming full-session encryption for these
  direct test connections); or
- noninteractive macOS credential rotation, revocation and cancellation
  behavior.

The independent authentication client ran locally on the disposable Mac. A
Linux host in the same VPC observed the same banner and `30, 33, 36` offer,
but no Linux-to-Mac successful authentication was exercised. The Mac server
build and configuration remain part of the evidence; a synthetic Linux peer is
useful for bounded parser and state-machine tests only.

## Current conclusions

- **Direct SRP/type 36:** authentication interoperability is demonstrated on
  macOS 26.6.2 with a synthetic local account, but implementation remains
  **blocked** on a complete, independently verifiable wire contract, server
  proof validation, hostile-peer limits and a release-pinned fixture. The
  observed direct session cannot be represented as fully encrypted.
- **RSA/SRP/type 33:** authentication interoperability is likewise demonstrated,
  but implementation remains **blocked** on the same contract/fixture issues
  plus an explicit RSA server-key trust rule. Apple's high-level
  "RSA-host-key" documentation cannot by itself establish this wire mapping or
  be substituted with the distinct RA2/RSA-AES family.
- **Password-based non-Apple VNC access:** a separate standard VNC profile. It
  must not be used as evidence for modern Apple authentication or silently
  broaden the existing X509Vnc/X509Plain profiles.

The product remains default-off and fail-closed for unsupported profiles. Its
current RFB client rejects the observed `RFB 003.889` banner before credentials;
it does not implement either Apple path. No Apple authentication implementation,
schema/API change, feature activation or production access is implied by these
results.

An SSH tunnel is not automatically an end-to-end fix: the existing VNC SSH
transport protects the Runner-to-SSH-server hop only. If that SSH server is an
intermediate Linux machine and it then dials TCP 5900 on the Mac, the final hop
still carries the observed plaintext RFB data. A future profile would need a
verified SSH endpoint **on the Mac** with a loopback VNC destination, or a
separately verified protective channel to the Mac. It must not silently fall
back to an unprotected direct connection.

## Evidence required to resume Apple compatibility work

The next gate needs a reproducible, release-pinned independent fixture and
documented type-33/type-36 framing, credential bounds, SRP server-proof and
RSA host-key verification behavior. It must test hostile peers, cancellation,
rotation/revocation, minimum ARD privileges, SSH-to-Mac loopback composition
and at least one more exact macOS version/configuration. Only then can either
path move from `blocked` to `go` and justify a PR-sized implementation child.

Sources: [Apple's Remote Desktop encryption matrix](https://support.apple.com/guide/remote-desktop/encrypt-network-data-apdfe8e386b/mac),
[Apple's VNC access guide](https://support.apple.com/guide/remote-desktop/virtual-network-computing-access-and-control-apde0dd523e/mac),
and the [IANA RFB security-type registry](https://www.iana.org/assignments/rfb).
