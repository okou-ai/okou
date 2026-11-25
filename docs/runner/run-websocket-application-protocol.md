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

After `auth.ok`, the application endpoint sends one `ready` message with its
protocol version when it can accept calls for that exact live Run. The client
starts a bounded readiness wait at `auth.ok` and sends its first request only
after a supported `ready`. If the endpoint cannot become ready, the connection
closes. The client closes on a missing, repeated or unsupported `ready`.

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

| Type       | Sender   | Required fields                                       |
| ---------- | -------- | ----------------------------------------------------- |
| `ready`    | Endpoint | `version`, the common envelope version, initially `1` |
| `request`  | Client   | `id`, `method`, `revision`, `params`                  |
| `response` | Endpoint | `requestId`, plus exactly one of `result` or `error`  |
| `event`    | Endpoint | `name`, `revision`, `data`                            |

A request ID is a positive safe integer. The client issues IDs in strictly
increasing order on each connection. Gaps are valid. Responses may complete out
of order and carry the original ID as `requestId`. Each connection owns its
pending calls and so can start again at ID 1 after reconnecting. The client
discards responses for calls it has already retired. It validates a result
against the method revision captured when it sent the corresponding request.

`method` is a string such as `diagnostics.echo`. Each method defines its
parameter object and result. A present `params` value that fails the method
schema returns `invalid_params`. Errors carry a stable string `code` inside
the `error` object. A valid request envelope can receive
`unsupported_method`, `unsupported_revision`, `invalid_params`, `forbidden`,
`busy` or `unavailable` without affecting other calls. An invalid result for
a known call fails that call. Invalid JSON, an invalid envelope, an unknown
message type or a non-increasing request ID closes the connection.

## Events

After `ready`, an authorized endpoint may send advisory events. The event
name and revision select its payload schema. The client ignores unsupported
names and revisions and discards invalid event payloads. An event has no
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
`ready`. An unanswered request has an unknown outcome. Automatic replay
requires an explicit method-level idempotency contract.

## Compatibility

`ready.version` covers the common message format and connection-level rules.
Compatible additions use optional fields that peers can ignore safely. Only
an incompatible common change requires a new envelope version. When two
envelope versions must coexist, select a supported version before the first
application request and keep v1 available to existing clients during the
overlap.

Each method or event starts at revision 1. Its revision is a positive safe
integer scoped to that name. Add optional fields within a revision only
when ignoring them preserves the contract. An incompatible change introduces
a new revision of the affected name. The endpoint can serve several revisions
on the same connection, keeping the old behavior until its supported clients
have migrated. Unrelated methods and events retain their revisions.

Dispatch requests by the exact pair of method name and revision. An unknown
method returns `unsupported_method`. A known method with an unsupported
revision returns `unsupported_revision` before executing the call. A client
may send a new request at an older revision after that explicit rejection
when the older contract preserves its intended behavior.

An endpoint that sends unsolicited events keeps the existing event revision
available during client overlap. If a consumer needs to select among multiple
event revisions, its subscription operation can record the client's chosen
revision and the endpoint sends that revision for the subscription. Adding a
new event name is compatible because clients ignore names they do not handle.

## Example exchange

These illustrative messages use the same connection. The client sends the
ticket and request messages. The Runner sends `auth.ok`. The application
endpoint sends `ready`, responses and events. The example endpoint supports
both revisions of `diagnostics.echo` and revision 1 of `run.status`.

```jsonl
{"ticket":"<ticket from bootstrap>"}
{"type":"auth.ok"}
{"type":"ready","version":1}
{"type":"request","id":1,"method":"diagnostics.echo","revision":1,"params":{"text":"hello"}}
{"type":"response","requestId":1,"result":{"text":"hello"}}
{"type":"event","name":"diagnostics.notice","revision":1,"data":{"message":"snapshot available"}}
{"type":"request","id":2,"method":"diagnostics.echo","revision":2,"params":{"message":"hello"}}
{"type":"response","requestId":2,"result":{"message":"hello"}}
{"type":"request","id":3,"method":"diagnostics.echo","revision":3,"params":{"message":"hello"}}
{"type":"response","requestId":3,"error":{"code":"unsupported_revision"}}
{"type":"request","id":4,"method":"run.status","revision":1,"params":{}}
{"type":"response","requestId":4,"result":{"status":"running"}}
```

If the connection drops before the status response, the client fails that
local wait. A new connection can start at request ID 1 after it receives its
own `ready`.
