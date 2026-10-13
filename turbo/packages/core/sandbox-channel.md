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
not peer receipt. An undeliverable terminal/error response or event-handler
saturation closes the epoch instead of growing a queue.

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
