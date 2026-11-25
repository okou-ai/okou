# Run WebSocket application protocol

This proposal uses the historical sandbox application message model for
authenticated Run WebSocket connections. The current
[Runner ingress](../../ansible/README.md#shared-runner-ingress) provides
admission and WebSocket control frames. A future consumer implements this
application protocol.

## Admission and readiness

The client opens the exact URL returned by `POST /api/runs/:id/wss/bootstrap`
at `/runners/<runnerId>/sandbox/runs/<runId>`. It sends the ticket in the first
text message and waits for the Runner's `auth.ok`.

The client then sends one application `hello` with the common schema version
and the category versions it supports. The endpoint replies with a correlated
`response` once it can serve the exact live Run. A successful hello response
returns the highest shared version for each category and omits categories
without a shared version. The client verifies each selection against its
offer. An empty selection is valid.

Both peers install their local roles before the exchange. The endpoint sends
the hello response before any application call or event. The client applies
the selection before dispatching subsequent messages. The handshake has a
deadline. Repeated hello, an invalid handshake, or an unsupported common
schema version ends the connection. Selections remain fixed for its lifetime.

## Messages and ownership

Each complete WebSocket binary message carries one UTF-8 JSON object without
a byte-order mark. WebSocket fragmentation is transparent to the application.
Each message carries `schemaVersion` (initially 1), `type`, and a freshly
generated canonical lowercase UUID v4 `id`.

| Type       | Sender                                  | Additional required fields                                          |
| ---------- | --------------------------------------- | ------------------------------------------------------------------- |
| `hello`    | Client                                  | `categories`, mapping names to nonempty lists of supported versions |
| `request`  | Either peer                             | `category`, `categoryVersion`, `operation`, `params`                |
| `response` | Either peer                             | `requestId` and exactly one of `result` or `error`                  |
| `event`    | Either peer, as allowed by the category | `category`, `categoryVersion`, `event`, `data`                      |

A response uses `requestId` to identify the hello or request it answers.
Inbound work and outbound waits use separate maps. A duplicate active
inbound request ID closes the connection. Unknown or retired response
correlations are discarded. The reader can dispatch responses while an
inbound handler waits on a reverse call.

The category contract defines allowed directions, parameters, results and
event payloads. A request for an unselected category or a category version
different from the selection returns `unsupported_category` before dispatch.
Unknown operations return `unsupported_method`. Invalid parameters return
`invalid_params`. Errors carry a stable string `code`. An invalid result
fails the corresponding call. Invalid common envelopes close the channel.

The admitted Run assignment supplies connection identity. A handler checks
authority for its operation and resources. Category negotiation describes
supported contracts. Guest-backed consumers use the
[Guest/Runner transport rules](runner-rpc-transport.md) to choose a bridge.

## Events and bounds

Events carry message identity and have advisory delivery. They have no ACK
or reconnect replay. Unsupported events and invalid event payloads are
dropped. A consumer that needs current state after disconnect queries its
authoritative source.

The initial application limits are 64 KiB per complete message, eight inbound
work slots and eight outbound waits per peer, and 256 KiB of pending writes
per peer. Reject calls with `busy` when inbound capacity is full. Serialize
writes, prioritize responses over queued advisory events, and drop events
under write saturation. An undeliverable response closes the connection.
Methods and writes have deadlines. Work owns its slot until it retires.

Connection close cancels connection-owned work. Run release, loss of
assignment, or cancellation ends the channel. Reconnect obtains a fresh
ticket and negotiates again. An unanswered call has an unknown outcome.
Automatic replay requires an explicit method-level idempotency contract.

## Compatibility

The common schema version governs framing, message identity, and correlation.
Each business category versions its related operations and events together.
Keep the old category contract available during a supported-client overlap.
A category with no common version is unavailable for that connection while
other selected categories remain usable. Adding a category leaves the common
schema and other category versions unchanged.

## Example exchange

After ticket admission, the client offers diagnostics versions 1 and 2 and
Run version 1. The endpoint selects diagnostics version 2 and Run version 1.
The client calls echo, then the endpoint calls echo in the reverse direction
and sends an advisory notice. These JSON lines represent binary messages.

```jsonl
{"schemaVersion":1,"type":"hello","id":"00000000-0000-4000-8000-000000000001","categories":{"diagnostics":[1,2],"run":[1]}}
{"schemaVersion":1,"type":"response","id":"00000000-0000-4000-8000-000000000002","requestId":"00000000-0000-4000-8000-000000000001","result":{"categories":{"diagnostics":2,"run":1}}}
{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000003","category":"diagnostics","categoryVersion":2,"operation":"echo","params":{"message":"hello"}}
{"schemaVersion":1,"type":"response","id":"00000000-0000-4000-8000-000000000004","requestId":"00000000-0000-4000-8000-000000000003","result":{"message":"hello"}}
{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000005","category":"diagnostics","categoryVersion":2,"operation":"echo","params":{"message":"from endpoint"}}
{"schemaVersion":1,"type":"response","id":"00000000-0000-4000-8000-000000000006","requestId":"00000000-0000-4000-8000-000000000005","result":{"message":"from endpoint"}}
{"schemaVersion":1,"type":"event","id":"00000000-0000-4000-8000-000000000007","category":"diagnostics","categoryVersion":2,"event":"notice","data":{"message":"snapshot available"}}
```

A client offering only diagnostics version 1 uses that version if the endpoint
still supports it. A client offering diagnostics version 3 and Run version 1
receives only the Run selection. It can still call `run.status`.
