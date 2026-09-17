# RFB client authentication

This internal, unpublished crate establishes an authenticated connection for the
VNC engine tracked by [#34778](https://github.com/vm0-ai/okou/issues/34778).
It is not yet connected to Runner, guest RPC, CLI or owner settings. It does not
provide framebuffer decoding or a usable remote desktop session.

## Contract

`authenticate` consumes an already connected, uniquely owned asynchronous stream,
a certificate identity, a `VncPassword`, explicit `TrustRoots`, and a deadline.
The caller must validate its saved destination and authorization before opening
that stream. This crate never resolves a hostname or opens a second socket.

Only RFB 3.8 / VeNCrypt 0.2 / X509Vnc (subtype 261) is supported. TLS 1.2 or 1.3
verifies the certificate chain, validity and saved DNS name or IP SAN before any
password-derived response is sent. Insecure alternatives are never selected,
including when the server also offers them. There is no verification bypass or
fallback to None, bare VncAuth or anonymous TLS.

Public trust uses `webpki-roots`; custom trust replaces those roots with 1-8 DER
certificates totaling at most 64 KiB. PEM parsing and its encoded-size limit belong
to the configuration layer. No server private key is accepted by this API.

VNC's legacy password challenge uses only eight bytes. `VncPassword` requires
1-8 printable ASCII bytes, preserves spaces and rejects longer or non-ASCII input
instead of truncating it. Its owned bytes are erased on drop and its Debug output
is redacted. Passwords, temporary keys and the DES key schedule are erased before
waiting for SecurityResult. DES is used only inside verified TLS, never as the
transport's security boundary. Callers remain responsible for their own copies
of secrets; this is not a guarantee that a compiler or TLS library makes no copies.

Success returns `Authenticated::into_stream()`, positioned immediately after
SecurityResult. The caller sends ClientInit next; ServerInit and framebuffer data
are not consumed. The returned object retains no password and starts no task.

The earlier of the caller deadline and 30 seconds bounds the whole handshake.
The deadline is rechecked before returning an authenticated connection, including
when a ready server result and the timeout become observable together.
Remote failure text is limited to 4 KiB, consumed by its declared length, discarded
and never included in errors. Unsupported or malformed results fail closed.
Failure, timeout, or cancellation drops the owned stream. Callers must not retain
socket clones if dropping it must disconnect the peer. No connection or input is
retried automatically.

## Verification

Public-API integration tests use real TCP and TLS peers, synthetic certificates,
an independent DES challenge vector, malformed protocol messages and observable
peer disconnects. These tests do not establish full TigerVNC interoperability,
framebuffer safety or complete session lifecycle behavior. Those are separate
engine acceptance gates before any product exposure.

```sh
cargo test --manifest-path crates/Cargo.toml --profile local -p rfb-client
cargo clippy --manifest-path crates/Cargo.toml --profile local -p rfb-client --all-targets
cargo doc --manifest-path crates/Cargo.toml --profile local -p rfb-client --no-deps
cargo fmt --manifest-path crates/Cargo.toml -p rfb-client --check
```

## Protocol sources and attribution

- [RFC 6143](https://datatracker.ietf.org/doc/html/rfc6143)
- [VeNCrypt extension specification](https://github.com/rfbproto/rfbproto/blob/152107db63cd34b3536ad8ddf54a0cfc9017a9f9/rfbproto.rst)
- The VNC authentication flow is adapted from
  [vnc-rs auth.rs](https://github.com/HsuJv/vnc-rs/blob/ab684d009d767c968af2f7559576334038623124/src/client/auth.rs)
  under its MIT license, retained in [LICENSE-vnc-rs](LICENSE-vnc-rs).
  Unsafe enum conversions, unbounded error reads, the upstream task model and
  custom DES implementation are not imported. TLS uses rustls and DES uses
  RustCrypto with key-schedule zeroization enabled.
