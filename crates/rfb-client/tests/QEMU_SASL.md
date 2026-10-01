# QEMU 8.2.2 X509SASL/SCRAM engine interoperability

This test is **opt-in**: it starts a disposable, loopback-only QEMU and a process-local Cyrus SASL config with synthetic credentials and a two-day test CA. It is not an Owner API, Runner, App, PNG or production test. Run on Ubuntu 24.04 with `qemu-system-x86` **1:8.2.2+ds-0ubuntu1**, `libsasl2-modules` **2.1.28+dfsg1-5ubuntu3** (SCRAM plugin), `sasl2-bin`, `openssl`, `python3` and Rust:

```sh
CARGO_TARGET_DIR=/your/isolated/cargo-target bash crates/rfb-client/tests/fixtures/qemu_sasl.sh
```

The script checks the exact QEMU and Cyrus versions, creates files under ignored `codex-work/probe/`, listens only on `127.0.0.1` at a temporary VNC port, sets `SASL_CONF_PATH` **only on the child QEMU process**, and deletes the temporary CA private key, server private key and SASL database while killing/waiting for QEMU on exit. No host-global SASL config, persistent QEMU, public firewall, or production certificate is modified. The synthetic account/password are test-only. QEMU uses `verify-peer=off` so this is **server-verified TLS and password-based SCRAM**, not a mutual-client-certificate profile. The Rust client separately verifies the server certificate chain and hostname before SASL.

## Numeric subtype discrepancy

The [RFB extensions spec](https://github.com/rfbproto/rfbproto/blob/152107db63cd34b3536ad8ddf54a0cfc9017a9f9/rfbproto.rst) assigns TLSSASL **263**, X509SASL **264**. [QEMU's `ui/vnc.h` at the pinned source](https://github.com/qemu/qemu/blob/f8296b816fabd370307cd22b0270b610fc0fa279/ui/vnc.h#L381-L390) assigns **X509SASL 263**, **TLSSASL 264**. The QEMU 8.2.2 fixture itself offers only numeric **263** with `tls-creds-x509` and then SCRAM-SHA-256 over verified TLS. Our opt-in `X509Authentication::QemuScramSha256` matches precisely this QEMU implementation; **it does not claim generic standards-compliant X509SASL 264** and refuses QEMU 264 rather than silently using its anonymous TLS path. Supporting a corrected or other server requires a new explicit, independently verified profile.

## Acceptance and limits

The integration test proves a positive SCRAM authentication through RFB ClientInit/ServerInit (nonzero geometry), wrong-password failure, and wrong server-name/root rejection. Unit/controlled-peer tests cover absent subtype or mechanism, wire framing (NULL vs empty), bad padding and final proof, malformed/excessive salt or iterations, and deadlines/cancellation; keep those distinct from the independent QEMU assertion. The SCRAM library is `rsasl` 2.3.1 compiled with only `std`, `config_builder`, `provider`, `scram-sha-2`; an exact single-mechanism registry prevents fallback. The client checks `i` (4096–100000), salt (8–128 decoded bytes), total bytes, round count, nonce and framing **before** the synchronous PBKDF2 library step. A bounded crypto task runs on Tokio blocking pool; when cancelled, no network task retains the connection, and any already-running bounded crypto work finishes separately and drops its credentials. The existing 30-second absolute handshake deadline covers network and transition stages. SCRAM supplies no SASL stream security layer; the verified TLS stream remains in use.

This is an RFB engine entry point only. No saved credentials, owner authorization, generation policy, App UI or product activation is introduced here. `VncAccess` remains off by default; the dependent product issue is #37466 under parent #35048.
