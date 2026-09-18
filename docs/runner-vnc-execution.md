# Runner VNC execution

Runner owns VNC sessions for one assigned Run and exposes them through the
existing guest RPC transport. The guest supplies saved connection IDs and
Run-local session IDs; it never supplies an endpoint, password, certificate,
owner identity or Runner identity. The [private authority API](runner-vnc-authority.md)
resolves and rechecks the saved configuration. The
[RFB engine](../crates/rfb-client/README.md) owns verified TLS, decoding and input.

VNC runs alongside SSH without using SSH's credential cache, invalidation
notifications or session admission. Official fleet startup installs either
available consumer independently. Local/PAT Runners cannot use VNC. The token
prefix selects the transport only; the API authenticates the actual secret and
the immutable winning Runner process on every resolve/check.

## Guest RPC

Requests use the existing version-1 envelope with an object `params` and a
required `remaining_ms` budget greater than 1,000. Runner clamps the budget to
60 seconds and reserves one second for terminal delivery. Unknown fields are
rejected, including authority or destination overrides.

| Method               | Parameters               | Successful result data                                  |
| -------------------- | ------------------------ | ------------------------------------------------------- |
| `vnc.session.start`  | `{ connectionId, mode }` | `{ outcome: "started", session }`                       |
| `vnc.session.list`   | `{}`                     | `{ outcome: "listed", sessions }`                       |
| `vnc.session.status` | `{ sessionId }`          | `{ outcome: "status", session }`                        |
| `vnc.session.close`  | `{ sessionId }`          | `{ outcome: "closed" }`                                 |
| `vnc.capture`        | `{ sessionId }`          | A capture stream, then `{ outcome: "captured", bytes }` |
| `vnc.input`          | `{ sessionId, input }`   | `{ outcome: "sent" }`                                   |

`connectionId` and `sessionId` are UUIDs. A session record contains
`{ sessionId, connectionId, mode }`. Only the creating Run can use or list its
session IDs; another Run's ID is indistinguishable from an absent session.

Start requires `mode: "shared" | "exclusive"`. This is the requested native
ClientInit sharing mode, not a guaranteed exclusive lock. The VNC server decides
whether to accept a connection and whether to retain other viewers. An exclusive
request can disconnect a human viewer. Okou adds no cross-Run controller lock,
mode fallback, automatic reconnect or input replay.

Malformed envelopes or missing/invalid budgets return the existing transport
error `invalid_request`. Known VNC methods without a VNC runtime return
`unavailable`; other method names return `unknown_method`. Runtime failures,
including invalid parameters, use a terminal result with `outcome: "failed"`
and an allow-listed `reason`. Input has the delivery outcomes described below.
Neither raw API bodies nor peer-supplied errors, desktop names, passwords or
trust bundles reach guest responses.

## Capture and input

A capture starts a fresh full-frame update and preserves the engine's dimensions
and geometry. The binary stream uses the existing framing in this order:

1. An event whose data is `{ kind: "capture", width, height, geometry,
updateSequence, capturedAt, bytes, mimeType: "image/png" }`.
2. PNG data frames of at most 64 KiB each.
3. End, followed by the unique successful result, then EOF.

`capturedAt` is Unix time in milliseconds. The PNG is at most 16 MiB and excludes
the cursor. A truncated stream or a failure terminal is not a complete capture.
Full coverage and a fresh response do not establish that the remote application
has settled. A session retains its operation lock until the capture is delivered
or dropped, so waiting requests cannot accumulate retained screenshots.

Input is one balanced operation. The `input` object has one of these shapes:

| Type        | Fields in addition to `type`                      |
| ----------- | ------------------------------------------------- |
| `text`      | `text`                                            |
| `key_chord` | `keys`, such as `["Control", "a"]`                |
| `click`     | `geometry`, `x`, `y`, `button`                    |
| `drag`      | `geometry`, `points` as `[[x, y], ...]`, `button` |
| `scroll`    | `geometry`, `x`, `y`, `axis`, `steps`             |

Coordinate input must carry the capture's exact
`geometry: { sessionId, epoch }`. This engine geometry ID is distinct from the
Run-local RPC session ID. The engine refreshes and checks geometry and bounds
before writing input; stale or foreign geometry cannot target a changed desktop.
RFB cannot make that check atomic with a later server resize.

Buttons are `left`, `middle` or `right`; scroll axes are `vertical` or
`horizontal`. Positive steps move down/right and negative steps move up/left.
Drag has 2–256 explicit points, and scrolling has 1–100 steps in either direction.
Text is bounded to 4 KiB UTF-8 and 4,096 emitted press/release events; newline and
tab are allowed, and other control characters are rejected. Chords contain 1–8
distinct keys: single printable characters, `Enter`, `Tab`, `Escape`, `Backspace`,
`Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`, arrows, `Shift`, `Control`,
`Alt`, `Meta`, or `F1`–`F35`. Text uses keysyms, not clipboard transfer, so actual
insertion depends on the server, keyboard layout and application.

The input result preserves the engine's delivery state, including when the
operation is cancelled or times out:

- `not_started`: no application-input write was attempted. A coordinate refresh
  may already have performed framebuffer IO.
- `unknown`: a write was attempted, so none, some or all of the input may have
  reached the server.
- `sent`: all intended presses/releases and flush completed within the deadline.
  This is transport completion, not remote application acknowledgement.

Failed input includes an allow-listed `reason`. If terminal delivery itself
fails, the caller cannot infer delivery state from the missing response and must
not automatically replay input. Cancellation or disconnection can prevent a key
or button release from reaching the server.

## Authority and lifetime

Start resolves only the supported `vnc_password` / `x509_vnc` profile, validates
the saved destination and trust configuration, and establishes verified TLS/RFB.
It checks the resolved connection generation again after handshake before
publishing the session. Credentials are dropped after authentication.

Status/list disclosure and every capture/input check current authority and the
resolved generation. A denied check, API failure or changed generation closes
the affected session instead of reconnecting or adopting replacement credentials.
List omits sessions whose authority is unavailable, whose configuration changed,
or which close while the list checks its snapshot, and continues checking the
other sessions. API failures, malformed authority responses, request cancellation
and request timeout still fail the list instead of appearing as an empty inventory.
Explicit close remains available to clean up a Run-owned session after authority
revocation. Checks are admission decisions: a later authority change cannot
retract remote effects already started. As with SSH, deletion and recreation with
the same connection ID and generation is not distinguishable.

Session lookup, authority checks and operations serialize under a per-session
lock. Independent sessions may operate concurrently, subject to server policy.
Run and sandbox cancellation stop pending and active work. Run shutdown closes
sessions and joins cleanup before returning. A tracked owner enforces the
engine's two-hour expiry even when no RPC is active. There is no authorization
poll or fixed idle-revocation interval; an idle peer disconnect is detected by
the next capture/input operation or expiry. Status returns local session metadata
after checking authority; it does not probe the remote desktop.

| Resource                                                | Bound                                  |
| ------------------------------------------------------- | -------------------------------------- |
| Sessions per Runner process, including handshakes       | 4                                      |
| Sessions per Run, including pending handshakes          | 2                                      |
| Guest RPC requests per Run, shared with other consumers | 8                                      |
| Engine-accounted memory per session                     | 128 MiB                                |
| One PNG                                                 | 16 MiB                                 |
| Request wall-time budget                                | 60 seconds, including terminal reserve |
| Engine handshake, framebuffer update or capture         | At most 30 seconds                     |
| Engine application input                                | At most 5 seconds                      |
| Session lifetime                                        | At most 2 hours                        |

Admission permits remain owned through actual session, socket, DNS and retained
capture cleanup. Engine accounting covers its owned buffers and reservations;
it is not process RSS and excludes TLS/socket buffers and allocator overhead.
The process bound is independent for overlapping Runner processes during drain.
No screenshot is written to disk or published by Runner.

## Deployment and verification

This slice adds no API schema, database migration, guest-helper framing or
feature-switch change. Old Runners return unknown/unavailable for these methods;
new Runners fail closed when the private VNC endpoints are missing or fail. Keep
those endpoints in supported API rollback targets before enabling clients.
Existing SSH guest RPC remains supported.

VNC stays disabled by default, including staff. Runner integration tests exercise
production dispatch against a controlled HTTP authority and an independent
TLS/RFB peer, checking protocol bytes, captures, authority changes, cancellation
and cleanup. The engine's separate TigerVNC acceptance evidence does not establish
complete product acceptance. [#34781](https://github.com/vm0-ai/okou/issues/34781)
owns the CLI and [#34782](https://github.com/vm0-ai/okou/issues/34782) owns the
remaining UI and real-Agent, multi-client acceptance before activation.
