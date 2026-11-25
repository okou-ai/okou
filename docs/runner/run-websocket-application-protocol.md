# Run WebSocket application protocol

This proposed v1 contract covers small request/response exchanges with a live
Run. A consumer adopts it when it adds an application endpoint. The current
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

| Type       | Sender   | Required fields                                      |
| ---------- | -------- | ---------------------------------------------------- |
| `ready`    | Endpoint | `version`, the integer `1` for this protocol         |
| `request`  | Client   | `id`, `method`, `params`                             |
| `response` | Endpoint | `requestId`, plus exactly one of `result` or `error` |

A request ID is a positive safe integer. The client issues IDs in strictly
increasing order on each connection. Gaps are valid. Responses may complete out
of order and carry the original ID as `requestId`. Each connection owns its
pending calls and so can start again at ID 1 after reconnecting. The client
discards responses for calls it has already retired.

`method` is a string such as `diagnostics.echo`. `params` is an object, and
`result` is defined by the method. Errors carry a stable string `code` inside
the `error` object. A valid request envelope can receive
`unsupported_method`, `invalid_params`, `forbidden`, `busy` or `unavailable`
without affecting other calls. An invalid result for a known call fails that
call. Invalid JSON, an invalid envelope, an unknown message type or a
non-increasing request ID closes the connection.

## Bounds and failure behavior

Apply the application budget after admission. Start with a 64 KiB limit per
complete application message, eight in-flight requests per connection and
256 KiB of pending application writes per connection. A client checks its
pending bytes before sending. The endpoint returns `busy` when request
capacity is full and closes when a response cannot be queued or written
within its bounded write budget. Every method has a deadline and observes
cancellation. Server work holds its slot until it retires.

The client can retire a wait on cancellation or timeout while execution may
still be in progress. Connection close discards pending writes and cancels
connection-owned work. Run release, assignment loss or cancellation also ends
the channel. On reconnect the client gets a fresh ticket and waits for a new
`ready`. An unanswered request has an unknown outcome. Automatic replay
requires an explicit method-level idempotency contract.

Compatible envelope additions use optional fields. Increment the protocol
version when envelope rules or the semantics of existing methods change
incompatibly. An additive method can use the same version because a peer can
return `unsupported_method`. Server-initiated calls, events and streaming can
have their delivery guarantees specified when a consumer requires them.

## Example exchange

This example uses a read-only `diagnostics.echo` method with a string
`text` parameter. It illustrates the contract for a future endpoint.

The client sends line 1. The endpoint sends lines 2 and 3, in that order.
The client then sends lines 4 and 6 and receives their respective responses
on lines 5 and 7.

```jsonl
{"ticket":"<ticket from bootstrap>"}
{"type":"auth.ok"}
{"type":"ready","version":1}
{"type":"request","id":1,"method":"diagnostics.echo","params":{"text":"hello"}}
{"type":"response","requestId":1,"result":{"text":"hello"}}
{"type":"request","id":2,"method":"diagnostics.echo","params":{"text":42}}
{"type":"response","requestId":2,"error":{"code":"invalid_params"}}
```

If the connection drops after line 6, the client fails that local wait. A
different authenticated connection can start a new call at ID 1 after
receiving its own `ready`.
