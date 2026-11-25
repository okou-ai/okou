# Run WebSocket application protocol

This proposed v1 contract covers small requests, responses, and notifications
for a live Run. A consumer adopts it when it adds an application endpoint. The current
[Runner ingress](../../ansible/README.md#shared-runner-ingress) implements
transport admission and WebSocket control frames.

## Admission and readiness

The client opens the exact URL returned by `POST /api/runs/:id/wss/bootstrap`.
The existing route is `/runners/<runnerId>/sandbox/runs/<runId>`. The client
sends its ticket in the first text message and waits for `auth.ok`. Admission
continues to use the existing ticket deadline, size and connection limits.

After `auth.ok`, the client sends one `hello` with the common protocol version
and the versions it supports for each business category. When it can accept
calls for that exact live Run, the endpoint replies with one `ready`. For
each category, it selects the highest version that both sides support. It
omits categories with no shared version. The client verifies that selections
were offered and sends requests only after `ready`. The selected versions
apply until the connection closes.

Both sides bound the readiness exchange. They close on a missing, repeated,
or invalid handshake message or an unsupported common protocol version.
A category without a shared version leaves the other categories available.

The URL and the admitted Run assignment supply the connection identity. The
application endpoint checks method authority within that assignment, including
any more specific resource or user permission a method needs. A Guest-backed
consumer chooses an assignment-bound bridge using the
[Guest/Runner transport rules](runner-rpc-transport.md).

## Messages and ownership

Each complete WebSocket text message carries one UTF-8 JSON object. Transport
fragmentation is transparent to the application. The recipient validates
required fields and ignores additional fields on known envelopes. Method
schemas own validation of their parameters and results.

| Type       | Sender   | Required fields                                                              |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| `hello`    | Client   | `version` and `categories`, a map from category name to supported versions   |
| `ready`    | Endpoint | `version` and `categories`, a map from category name to its selected version |
| `request`  | Client   | `id`, `method`, `params`                                                     |
| `response` | Endpoint | `requestId`, plus exactly one of `result` or `error`                         |
| `event`    | Endpoint | `name`, `data`                                                               |

The common `version` is initially `1`. Category versions are positive safe
integers. Each offer lists one or more supported versions without duplicates.
The category is the first component of a qualified method or event name, such
as `diagnostics` in `diagnostics.echo`.

A request ID is a positive safe integer. The client issues IDs in strictly
increasing order on each connection. Gaps are valid. Responses may complete out
of order and carry the original ID as `requestId`. Each connection owns its
pending calls and so can start again at ID 1 after reconnecting. The client
discards responses for calls it has already retired. It validates a result
against the method contract for the negotiated category version.

`method` is a string such as `diagnostics.echo`. Each method defines its
parameter object and result. A present `params` value that fails the method
schema returns `invalid_params`. Errors carry a stable string `code` inside
the `error` object. A valid request envelope can receive
`unsupported_category`, `unsupported_method`, `invalid_params`, `forbidden`,
`busy` or `unavailable` without affecting other calls. An invalid result for
a known call fails that call. Invalid JSON, an invalid envelope, an unknown
message type or a non-increasing request ID closes the connection.

## Events

After `ready`, an authorized endpoint may send advisory events. The event
name and its negotiated category version select the payload schema. The
endpoint emits events only for selected categories. The client ignores
unknown event names and discards invalid event payloads. An event has no
request correlation, acknowledgment, or replay. A consumer that needs
current state after a disconnect reads it through its authoritative query.

## Bounds and failure behavior

Apply the application budget after admission. Start with a 64 KiB limit per
complete application message, eight in-flight requests per connection and
256 KiB of pending application writes per connection. A client checks its
pending bytes before sending. The endpoint returns `busy` when request
capacity is full and closes when a response cannot be queued or written
within its bounded write budget. The endpoint drops advisory events when
they would exceed the write budget and gives queued responses priority.
Every method has a deadline and observes
cancellation. Server work holds its slot until it retires.

The client can retire a wait on cancellation or timeout while execution may
still be in progress. Connection close discards pending writes and cancels
connection-owned work. Run release, assignment loss or cancellation also ends
the channel. On reconnect the client gets a fresh ticket and waits for a new
`hello`/`ready` exchange. An unanswered request has an unknown outcome. Automatic replay
requires an explicit method-level idempotency contract.

## Compatibility

The common `version` covers the message format and connection-level rules.
Compatible additions use optional fields that peers can ignore safely. Only
an incompatible common change requires a new envelope version. When two
envelope versions must coexist, select a supported version before the first
application request and keep v1 available to existing clients during the
overlap.

Each business category starts at version 1 and versions its methods and
events together. A category groups calls and events that share data, state,
or lifecycle. Add optional fields within a version when ignoring them
preserves the contract. Introduce a new version of that category for
incompatible changes. Keep the older category implementation available
during the client overlap. Separate categories retain their versions.

Dispatch a qualified method using its selected category version. A request
in an unselected category returns `unsupported_category` before dispatch.
An unknown method in a selected category returns `unsupported_method`.
An additive method can use the current category version when callers can
handle that error. An additive event can use it when clients can safely
ignore the new event. Event payloads follow the version selected for that
connection, including during old and new client overlap.

## Example exchange

The example endpoint supports `diagnostics` versions 1 and 2 and `run` version

1. This client speaks both diagnostics versions and selects version 2 for
   the connection. The Runner sends `auth.ok`. The client sends the ticket,
   `hello`, and requests. The endpoint sends `ready`, responses, and events.

```jsonl
{"ticket":"<ticket from bootstrap>"}
{"type":"auth.ok"}
{"type":"hello","version":1,"categories":{"diagnostics":[1,2],"run":[1]}}
{"type":"ready","version":1,"categories":{"diagnostics":2,"run":1}}
{"type":"request","id":1,"method":"diagnostics.echo","params":{"message":"hello"}}
{"type":"response","requestId":1,"result":{"message":"hello"}}
{"type":"event","name":"diagnostics.notice","data":{"message":"snapshot available"}}
{"type":"request","id":2,"method":"run.status","params":{}}
{"type":"response","requestId":2,"result":{"status":"running"}}
```

An older client offering `"diagnostics":[1]` selects version 1 and can use the
original echo fields and event payloads. A client offering only
`"diagnostics":[3]` still selects `"run":1`; its `ready` omits diagnostics.
It can continue calling `run.status` on the same connection.
