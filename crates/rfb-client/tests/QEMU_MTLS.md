# QEMU VeNCrypt client-certificate interoperability (opt-in)

This test runs a **disposable loopback-only QEMU VNC server** with synthetic CA,
server and client identities. It never connects to an existing VNC or OpenSSH
server, launches a guest, edits a production configuration, or activates the
`VncAccess` switch. The owner/Agent/Runner path is **not** covered; that is
tracked by [#37375](https://github.com/okou-ai/okou/issues/37375).

## Pinned executable and command

The fixture expects Ubuntu's exact `qemu-system-x86_64` version:

```text
QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1)
```

Install the distribution package `qemu-system-x86` version
`1:8.2.2+ds-0ubuntu1` **only in an isolated test environment**. Check
`qemu-system-x86_64 --version` before running. Then, from the repository root:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p rfb-client --test qemu_mutual_tls -- --ignored --nocapture --test-threads=1
```

The test checks the executable's exact version string and creates temporary
files: a synthetic CA, server and client keys/certificates, and a QMP Unix
socket. QEMU listens on one OS-chosen `127.0.0.1` port at a time; the test
sets the classic password through QMP, **not a command argument**. The server
process is killed and all fixture files are removed on normal test teardown.
If the process is force-killed externally, inspect and stop any fixture QEMU
process before rerunning. Do not provide real certificates, change an external
host's QEMU settings, or use these fixture keys elsewhere.

## Independently observed matrix, 2026-09-29

| QEMU setting | VeNCrypt subtype | Client | Observed outcome |
| --- | --- | --- | --- |
| `verify-peer=on` | X509None (260) | trusted synthetic CA | TLS + SecurityResult + ClientInit/ServerInit accepted |
| `verify-peer=on` | X509Vnc (261) | trusted synthetic CA + correct classic password | accepted |
| `verify-peer=on` | both | unrelated-CA, expired or no client identity | no authenticated stream |
| `verify-peer=on` | both | correct client, wrong server name or server CA | no authenticated stream |
| `verify-peer=on` | X509Vnc | correct client, wrong password | no authenticated stream |
| `verify-peer=off` | X509None (260) | trusted synthetic CA | **accepted** |
| `verify-peer=off` | X509None (260) | unrelated-CA client | **accepted** |

The last two rows are **negative controls**, not passing security guarantees.
QEMU 8.2.2 still sends a TLS CertificateRequest with `verify-peer=off`, then
accepts a client the configured CA did not sign. The Rust engine rejects a TLS
server that sends no request, but it cannot identify a requesting server that
fails to verify. Server configuration and independent rejection testing are a
separate deployment/activation gate; neither this test nor TLS client selection
alone proves remote `verify-peer=on`.

Controlled rustls peer tests in `tests/client_certificates.rs` cover the
no-request client fail-closed path, TLS 1.2 and 1.3, input bounds, exact subtype,
wrong trust/name/password, timeout and cancellation. They are not substituted
for the independent QEMU fixture. Likewise, this engine fixture does not cover
owner KMS, API, mixed-version migration, Runner authority, Agent permissions or
real session capture.
