# Bounded RFB session engine

This internal, unpublished crate establishes an authenticated connection for the
VNC engine tracked by [#34778](https://github.com/vm0-ai/okou/issues/34778).
It provides verified authentication, framebuffer decoding and caller-driven
capture/input sessions for the documented reference-server profile. Runner
integrates this engine through [Run-owned guest RPC](../../docs/runner-vnc-execution.md)
and the private authority API. CLI and full product acceptance remain later
delivery slices; VNC remains disabled by default.

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
RFB version exchange, security negotiation, TLS handshake and VNC authentication
all consume that same absolute deadline rather than receiving per-stage budgets.
An authentication deadline error retains only the bounded local stage active at
expiry. The stage locates the client-side protocol responsibility; it does not
identify whether a server, firewall, proxy or another network component caused
silence. The deadline is checked at phase boundaries and before returning an
authenticated connection, including when a ready server result and the timeout
become observable together.
Remote failure text is limited to 4 KiB, consumed by its declared length, discarded
and never included in errors. Unsupported or malformed results fail closed.
Failure, timeout, or cancellation drops the owned stream. Callers must not retain
socket clones if dropping it must disconnect the peer. No connection or input is
retried automatically.

## Framebuffer contract

`Authenticated::initialize(sharing_mode, deadline)` requires an explicit
`SharingMode::Shared` or `SharingMode::Exclusive` for each connection. It sends
ClientInit's shared-flag as 1 or 0 respectively. Shared requests that existing
clients remain connected; exclusive requests that they be disconnected. The server
may refuse or override either request according to its configuration. Successful
initialization does not confirm exclusive control, prevent a later client from
connecting, or exclude local input. There is no automatic mode change or reconnect
after refusal, and this crate imposes no additional cross-session control lock.

Initialization validates bounded ServerInit metadata and negotiates 32-bit
little-endian true-color RGBX (depth 24, 8-bit channels at shifts 0/8/16). Native
server formats are validated before this
normalization. Desktop names are bounded and discarded. Only ZRLE, CopyRect, Raw,
Cursor and DesktopSize are advertised, in that preference order.

The returned `FramebufferConnection` owns the TLS stream, framebuffer, exact
per-pixel coverage, cursor shape and one persistent zlib inflater. Call
`update(false, deadline)` for the initial full-frame request. A full request clears
coverage; subsequent `update(true, deadline)` calls can accumulate partial updates.
`pixels()` returns borrowed immutable RGBA only when every pixel is known. It never
substitutes black or stale pixels for missing coverage. CopyRect transfers validity
alongside pixels with overlap-safe semantics, including invalidating a destination
copied from an unknown source.

DesktopSize advances `geometry_epoch()`, discards old framebuffer contents and
requires the next request to be nonincremental. It can occur before other
rectangles in the same message. `update_sequence()` advances only after processing
a complete FramebufferUpdate. Neither sequence nor complete coverage proves that
a remote application has settled; the session owns capture/input coordination.

Cursor pixels and hotspot are separate from the desktop image. Alpha follows the
per-row cursor mask; the Cursor extension does not supply the cursor's desktop
position. Empty shapes remove the cursor. The decoder does not composite a cursor,
resize the server or transfer clipboard text. The session layer adds PNG and
keyboard/pointer operations. Bell and bounded standard ServerCutText messages are
consumed and discarded.

Initialization and updates consume ownership. Error, timeout, or dropping the
future drops the stream and its storage; a partially decoded connection cannot be
reused. Each operation is bounded by the earlier of its caller deadline and 30
seconds, with a fresh check before success. Decode work yields between rows/tiles
and inflate chunks capped at 64 KiB of input and output each. Limiting input also
bounds synchronous work on empty DEFLATE blocks that produce no pixels. There are
no detached workers or retries.

## Decoder limits and accounting

| Resource                                            | Bound                              |
| --------------------------------------------------- | ---------------------------------- |
| Width or height                                     | 8,192 pixels; neither may be zero  |
| Total framebuffer pixels                            | 8,388,608                          |
| ServerInit name / discarded standard clipboard text | 4 KiB each                         |
| Rectangles per update                               | 4,096                              |
| ZRLE compressed rectangle                           | 40 MiB                             |
| Wire bytes per update, including headers            | 64 MiB                             |
| Messages before a framebuffer update                | At most 63 Bell/clipboard messages |
| Cursor dimensions                                   | 256 by 256                         |
| Accounted owned decoder memory                      | 128 MiB                            |

ZRLE decompressed storage is bounded before allocation by four bytes per rectangle
pixel plus 382 bytes per 64-by-64 tile (and one overflow-detection byte). Every
tile must decode to exactly its pixel count, with no extra decompressed data.
Palette indices, per-row packed bits and run lengths are checked. The zlib stream
continues across rectangles; each length field bounds its compressed chunk.

Heap buffers use fallible allocation and reserve their actual capacity against a
shared budget before use. Reservations cover framebuffer pixels, coverage bits,
cursor replacement, compressed and decompressed rectangles, decoded RGBA, tile
scratch and overlapping old/new resize buffers. An additional conservative 256 KiB
reservation covers inflater state and fixed protocol/decoder overhead. Scratch is
released after each rectangle. `memory_usage()` exposes retained and peak accounted
bytes. Compressed input is released immediately after inflation, before allocating
RGBA/tile scratch, allowing high-detail 4K frames within the same total budget.
The compressed cap includes headroom above the geometry-derived decoded bound for
normal deflate framing. Accounting measures buffers,
not process RSS. TLS/socket buffers, allocator
metadata and caller-created copies are outside this budget. Session captures and
encoder/input storage use this same budget as described below.

## Session contract

`Session::new(connection)` adopts an initialized `FramebufferConnection`. The
session is noncloneable and operations require mutable access, serializing capture
and input without a worker or queue. An operation takes ownership of the connection
before awaiting IO; failure or cancellation then closes it and leaves the session
closed. Invalid input detected before IO preserves the untouched session. `close()`
and dropping the session immediately release the transport; retained captures keep
only their own memory reservations. No reconnect or input replay is automatic.

The caller owns idle timers, current authorization and Run/session admission.
`expires_at()` supplies a two-hour maximum operation deadline. Every operation is
clamped to that expiry, but an idle, unpolled object does not close itself or detect
a disconnect. The Runner owner must close/drop it on expiry, revocation or
Run termination. This crate never establishes another socket or opens a destination.

`capture(deadline)` starts a nonincremental full-frame request. It consumes one
complete response before requesting more: incremental while coverage is incomplete,
or nonincremental after DesktopSize. At most 64 responses share one deadline capped
at 30 seconds. Resize-only responses need another request on TigerVNC; waiting for
unsolicited pixel data would stall. Continuous updates are never enabled. Timeout
returns an error rather than a cached image labeled fresh. Neither coverage nor a
fresh response proves an application has settled.

An immutable `Capture` owns a PNG, timestamp, frame sequence, dimensions and
`Geometry { session_id, epoch }`. Its PNG excludes the cursor; a separately copied
cursor shape/hotspot describes that same snapshot. RFB does not supply its desktop
position. PNG rows use the maintained `png` encoder, filter Up and flate2 level 1,
with cooperative yields between rows. A conservative 2 MiB reservation covers
encoder state and row/chunk buffers. Output is capped at 16 MiB; a larger image
fails with `ImageTooLarge` without changing dimensions. Buffer capacity, temporary
output compaction and cursor copies are charged. Kept captures retain that charge
after return and even after session close; enough retained images can make a later
operation fail with `ResourceLimit`. Copies explicitly made by a caller are its
responsibility. No image is written to disk or published by this crate.

`input(command, &mut outcome, deadline)` prevalidates the entire operation and sends
it once, within five seconds and the supplied/session deadlines. The caller-owned
`InputOutcome` resets to `NotStarted` when the future is created, before it is
polled. Dropping an unpolled future preserves the untouched session and cannot
reuse a previous operation's delivery result. The outcome remains observable
after dropping the future:

- `NotStarted`: no application-input write was attempted. A coordinate refresh may
  already have performed framebuffer IO.
- `Unknown`: a write was attempted; a prefix, all or none of the input may have
  reached the peer. Never infer that a failed operation is safe to replay.
- `Sent`: every intended press/release and the flush completed before the deadline.
  This is transport completion, not acknowledgement from the remote application.

Coordinate operations carry a geometry identity from the relevant session. They
refresh first and recheck epoch and bounds before writing; another session's token
is rejected. RFB cannot make this check atomic with a later server resize. Input is
balanced on successful completion; disconnect/cancellation cannot guarantee a key
or button release reached the server. An idle external viewer or human may still
operate the desktop. Sustained unsolicited server output can backpressure input;
the bounded operation fails and closes rather than claiming full-duplex delivery.

Supported operations are click, drag through 2-256 explicit points, 1-100 scroll
steps, text, and a chord of 1-8 distinct keys. Positive scroll moves down/right;
negative moves up/left. Drag has no hidden timed interpolation. Text is limited to
4 KiB UTF-8 and 4,096 emitted events, including releases (so 2,048 ordinary
characters is the event ceiling). Newline/tab use named keysyms; other controls are
rejected. Latin-1 and Unicode keysyms are sent directly, with no clipboard fallback.
Actual insertion depends on server, keyboard layout and application handling;
named modifiers and F1-F35 follow X11 keysyms.

## Verification

Public-API integration tests use real TCP and TLS peers, synthetic certificates,
an independent DES challenge vector, malformed protocol messages and observable
peer disconnects. Framebuffer tests verify both ClientInit sharing flags and
server refusal without a mode fallback, exact pixels, all ZRLE modes, independent
persistent-zlib fixtures, CopyRect overlap/coverage, cursor/resize behavior,
decompression limits, cancellation and maximum geometry allocation accounting.
Session tests additionally verify immutable PNG pixels, refresh/resize ordering,
input bytes and outcomes, cancellation and output limits. The explicitly invoked
[TigerVNC acceptance harness](tests/TIGERVNC.md) verifies the independent server
profile; ordinary tests do not silently claim that interoperability test ran.
Runner authority and RPC have their own integration coverage. CLI and product
end-to-end acceptance remain later slices.

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
