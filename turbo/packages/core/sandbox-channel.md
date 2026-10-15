# Sandbox application channel

This is the shared business protocol over an already admitted Run WSS/private
Guest stream. Ticket authority, URL validation and opaque Caddy/Runner routing
remain with the existing transport. `auth.ok` proves admission; it does not
prove application support. Construct a peer without side effects, install its
complete local role, and call `connect` with the owning Run/panel signal.

The canonical envelope and category schemas are in
[api-contracts](../api-contracts/src/contracts/sandbox-channel.ts). Rust DTOs and
constants are generated from them; the
[native adapter](../../../crates/guest-contracts/src/sandbox_channel.rs)
adds runtime checks that DTO deserialization alone does not enforce.

## Identity and framing

One binary frame carries one UTF-8 JSON object without a byte-order mark. Common message types are
`hello`, `request`, `response` and `event`. Every message has its own fresh,
canonical lowercase UUID v4 `id`, generated securely by its sender. Only a
response has `requestId`, exactly the ID of the hello/request it answers.

```jsonl
{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"diagnostics","categoryVersion":1,"operation":"echo","params":{"payload":"aGk="}}
{"schemaVersion":1,"type":"response","id":"00000000-0000-4000-8000-000000000002","requestId":"00000000-0000-4000-8000-000000000001","result":{"payload":"aGk="}}
{"schemaVersion":1,"type":"event","id":"00000000-0000-4000-8000-000000000003","category":"diagnostics","categoryVersion":1,"event":"notice","data":{"message":"ready"}}
```

Responses contain exactly one result/error, including hello/error replies.
Their own ID never satisfies a pending call. Incoming and outgoing work have
separate maps, even if opposite directions supply equal IDs. Events imply no
response, acknowledgment, ordering, deduplication, replay or delivery promise.
Completed/unknown requestId values are discarded without answering. Duplicate
active inbound request IDs are framing violations and cannot execute twice.

## Readiness and category roles

The external connector sends hello after admission, including its installed
category-version map. Guest replies with its map. The peer applies valid
categories and readiness synchronously before resolving hello, so immediate
Guest requests/events cannot race consumer setup. Categories are immutable for
that connection epoch.

Check common schema equality first, category presence on both participants
second, exact category revision third, then known operation/event, permitted
origin, typed payload and operation-specific authority. Schema/framing errors
disable the owned connection. Missing/mismatched categories disable that
business while matching categories remain usable. Unknown valid category names
in hello have no effect until used; map lookup never follows object prototypes.
Metadata itself grants no permission.

A category promises the complete contract for its local role, rather than
identical operations in both directions. The external `fs` role installs typed
outgoing list/list.close results; the Guest role installs their handlers. The
diagnostics role installs an either-direction echo handler. Register required
incoming handlers before connecting. Event decoders remain installed even
when no listener is interested; unsupported/unobserved events are dropped
locally without an error-message loop.

## Calls, resources and limits

`call(operation, params, signal)` preserves typed params/results through the
captured operation descriptor. `sandboxChannelHandler` and
`sandboxChannelEventHandler` validate untrusted data before invoking typed
consumer functions. A handler receives the epoch signal and peer for reverse
calls; it must honor cancellation. It may await a reverse call without blocking
the independent response reader.
The peer validates every handler result against its captured operation before
emission, including handlers registered directly without a typed adapter.

Initial common policies are 64 KiB per complete frame, eight outgoing waits,
eight incoming work slots, eight queued frames / 256 KiB and 64 levels of JSON
depth. Hello waits five seconds, ordinary calls ten. JSON uses finite numbers
and Unicode scalar strings; object keys named `__proto__` are rejected before
record parsing. Every version is a positive signed-32-bit integer;
category maps contain at most 32 ASCII names of at most 32 bytes.

The browser writer is synchronous, reentrancy-safe and serialized. Failed
transport acceptance returns backpressure without retaining an offline retry.
A queued frame older than 15 seconds closes its epoch when the writer regains
control. It cannot interrupt a blocked JavaScript callback; asynchronous native
IO has its own writer deadline. Acceptance describes a finite local write,
not peer receipt. An undeliverable terminal/error response closes the epoch
instead of growing a queue.

## Failure isolation

Common framing/schema/identity violations, invalid hello results, duplicate
active inbound request IDs and fatal transport/writer failures close the owned
connection. A response with valid common framing and a captured `requestId`
whose operation result is invalid rejects only that call with `invalid_request`,
including a throwing result decoder. Other pending calls and matching
categories remain usable. Invalid hello still fails application readiness.

Request errors are validated at the peer boundary too. Malformed structured
errors from parameter decoders or handlers produce a bounded `invalid_params`
or `unavailable` response without their unsafe metadata; unrelated business
remains usable. An error's serialization or property-access failure cannot
turn this request rejection into connection teardown.

Known-event direction/data rejection, handler exceptions and exhausted incoming
capacity reject/drop that event locally. Saturation reports `busy`; handler
failure reports `unavailable` after releasing its work slot. No ACK, retry queue
or generic replay is added. `diagnostics.notice` permits loss; a future category
that requires reliable updates must specify its own subscription invalidation,
resynchronization or flow-control policy.

Supply optional `onEventError` to observe local rejection through bounded
`{ category, event, code }` metadata. It receives no payload, raw exception,
path or stack and must return synchronously (`undefined`), without starting
unowned asynchronous work. A throwing observer is retired for this peer's
lifetime; unrelated calls remain usable. Handler ownership remains with its
epoch, and retired-epoch failures cannot notify a replacement consumer.
Unsupported/unobserved events remain local drops without error-message loops.

Closing/Run replacement aborts pending waits, timers and handler ownership.
Reconnect clears correlations and category state, sends a new hello and exposes
a new ready epoch. It never replays generic calls or reuses resource handles.
Discarded writes belong to the lost epoch; their failure callbacks cannot close
its replacement. A consumer that closes the peer during teardown stays closed.
UUIDs do not replace connection/Run ownership. Locally canceled or timed-out
waits do not claim remote/kernel cancellation.

Subscriptions, tasks, streams and directory cursors have independent,
category-owned IDs. A later category defines its own finite resources, expiry,
sequence/EOF/flow control, cancellation and any needed acknowledgment/resume
policy. Generic message IDs supply none of those guarantees. Keep terminal
resource-bearing results owned until their category can release or expire the
resource; UI view invalidation must not silently orphan a returned cursor.

## Native readonly filesystem role

The packaged Guest installs the complete fs v2 role alongside diagnostics.
It captures Guest `/` for each connection's first filesystem job; process HOME
and cwd never select that root. Paths are canonical raw basename tokens relative
to `/`; an empty path denotes Guest root. A consumer initially displaying
`/home/user` sends those two raw components rather than an empty path.

Resolve each component from its held parent fd with Linux openat2 using BENEATH,
NO_SYMLINKS and NO_MAGICLINKS. NO_XDEV is mandatory except at the single full
prefix equal to canonical `/home/user`, whose authorized home mount is entered
explicitly. Its descendants regain NO_XDEV. Other mount directories and links
remain visible metadata but cannot expand; no file contents are opened. All
prefix identities and timestamps are revalidated from captured Guest root before
and after pages. Unavailable kernel semantics fail closed without weaker flags.

One post-fork worker owns filesystem execution for the whole Guest, with eight
queued jobs and 256 KiB serialized request accounting (including active work).
Admission never waits on the router. Physical work retains its connection owner;
cancelled or abandoned queued work cannot start another lookup. At most eight
live stream owners plus nine active/queued retired owners can retain filesystem
state; weak maintenance tracking disappears with those owners. A stuck syscall
can delay filesystem calls and expiry maintenance, but cannot block diagnostics
or response routing. Cooperative deadlines do not force kernel cancellation.

`fs/list` selects exactly a path or this connection's opaque cursor. Each listing
has its own fd, seek offset, unread buffer and pending entry. Pages contain at
most 128 entries and 48 KiB of complete response JSON, including both UUIDs.
Enumeration, metadata and revalidation share 512 steps and a two-second
cooperative processing budget. Eight cursors per connection expire after 30
seconds without a successful continuation; `fs/list.close` explicitly releases
one. Foreign, closed and expired handles return `cursor_expired`.

Page boundaries preserve carryover until actual EOF; a non-null nextCursor
denotes more work even for an empty page. Directory and ancestor identities and
timestamps are checked before and after each page. Observed mutation or path
replacement disposes that listing with `directory_changed`; refresh creates a
new identity. This detects observed changes rather than promising an atomic
filesystem snapshot. Display labels escape control, invalid UTF-8 and directional
characters, while raw name tokens remain the only path input.

Older diagnostics-only Guests do not advertise fs. Home-rooted fs v1 peers have
a different category revision: exact matching rejects their operations before
interpreting paths, while schema and diagnostics remain at version 1. Matching
diagnostics remains usable; fs callers show unsupported/update-required until a
matching complete role exists. A web deployment cannot upgrade a running Guest.
The owning native suite checks matching pinned images on amd64 and ARM64,
including mount rejection and cursor retirement/park/reuse. The existing public
Node Run suite checks actual root/home/home-user and nested/paged fixtures and
explicit release. UI navigation owns its current location separately from the
connection: capture that raw prefix per call, and release obsolete results on
their original epoch without applying them to a newly selected directory.

## Evolution

Common envelope/encoding/routing/identity/correlation changes increment
schemaVersion. Changes to required category operations, origins, parameters,
results or semantics increment that category's revision. A new category changes
neither the common schema nor unrelated category revisions. Each participant
ships one current schema and one current revision per installed category; no
version ranges, old adapters or per-operation capability negotiation are used.
Unsupported peers fail inside their consumer rather than crash the application.

Add a business contract and typed operations/events in api-contracts, register
its Rust bindings/constants and native validators, and install the complete
local role before advertising it. Reuse the same public socket route and one
peer reader. Payload interpretation and authority belong to the business
endpoint, not the ticket API or opaque transport. Actual wire shapes and
cross-language semantic rejection are exercised by
[shared fixtures](../../../crates/guest-contracts/tests/fixtures/sandbox-channel.json).
