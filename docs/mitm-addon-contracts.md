# mitmproxy Addon Runtime Contracts

These contracts cover addon control, logging, WebSocket framing and inspection, and path
normalization. Read the relevant section before changing the addon or its pinned
mitmproxy/wsproto dependencies. See the [testing guide](testing/mitm-addon-testing.md)
for environment setup, commands, and executable coverage.

## Runner-private control and readiness

Runner and its embedded addon ship together. `okou_control_socket_dir` selects
the current managed launch directory; `okou_usage_state_id` is also the control
generation and rotates on restart. Readiness requires a correlated `proxy.status`
reply followed by EOF, then the existing TCP listener probe, within the original
10-second startup deadline. A socket inode alone is not readiness. Only read-only
startup probes retry, with at most one second per control attempt.

The addon owns a separate asyncio I/O thread. It opens the launch directory with
`O_DIRECTORY | O_NOFOLLOW`, requires the effective UID and private permissions,
and exclusively binds `control.sock` with mode `0600`. Runner creates launch
directories with mode `0700`. Neither bind failure nor addon shutdown unlinks an
endpoint: Runner removes the launch directory only after reaping its process
tree. Each side connects/binds through its own live directory descriptor's
`/proc/self/fd/<fd>/control.sock` alias, so long launch paths work on Linux.

Each Unix stream carries one request and at most one terminal reply: a four-byte
big-endian unsigned length followed by UTF-8 JSON. Frames are 1–65,536 bytes;
there are at most 16 admitted connections, a backlog of 16, and a five-second
whole-connection deadline. Partial frames, oversize lengths, disconnected or
slow peers cannot retain admission indefinitely. Overload closes without reading
or inventing a request ID. Malformed or pipelined peers can observe a reset.

Requests have exactly `requestId`, `generation`, `method`, and `params`. Identifiers
match `[A-Za-z0-9_.-]{1,64}`; duplicate keys, non-JSON constants, and unknown fields
are rejected. `proxy.status` takes empty object parameters:

```json
{
  "requestId": "request-1",
  "generation": "launch-generation",
  "method": "proxy.status",
  "params": {}
}
```

A successful reply contains those identities, `"type": "result"`, and
`"data": {"state": "running"}`. An error instead contains `"type": "error"` and
`"code": "invalid_request"`, `"stale_generation"`, `"unknown_method"`, `"busy"`,
`"not_ready"`, `"deadline"`, or `"internal_error"`;
`requestId` is null when no valid correlation can be recovered. Error generation
always identifies the serving addon. Rust rejects mismatched identities, unknown
response fields/states, extra response bytes, and missing terminal EOF.

`logs.flush` takes exactly `runId` (a canonical UUID) and `path` (an absolute,
normalized path ending in `network-{runId}.jsonl`). Runner freezes the original
run, path, endpoint, and generation before execution; deferred upload never
looks up a current IP registration or follows a replacement addon. The handler
only observes the writer's path key and does not open the supplied path.
Its result echoes `runId` and `path`, the captured `boundary` sequence, `pending`
write count, and `state: processed|deadline`. Up to eight pending prefix tickets
are admitted; exhaustion returns `busy`. Each request observes the prefix every
50 ms for at most four seconds within the connection deadline. Later writes
cannot extend the captured boundary.

Shutdown stops control admission, closes every accepted socket (including tasks
not yet started), and joins the I/O thread before existing blocking drains. The
`logs.flush` method observes a writer-owned, accepted JSONL prefix: it captures
the requested run/path boundary, waits for that prefix to be processed (including
failed append attempts), and returns either `processed` or `deadline`. A
`processed` result is not an fsync or durability acknowledgement. Cancellation
does not release an admitted writer ticket, and a lost reply after transmission
means an unknown outcome; the transport does not automatically replay future
mutations or move business state onto its thread.

Runner and the embedded addon use the private control socket for all flush
coordination. Old Runner instances retain their embedded addon; no
API-first deployment or mixed Runner/addon protocol fallback is needed. This
stage does not implement token accounting or guest RPC, and unit/packaged runtime
tests do not claim production soak or a measured latency improvement.

### Delivery admission, observation and shutdown

`delivery.flush`, `delivery.status` and `delivery.drain` take empty parameters.
They concern the whole addon generation, not a caller-selected run or current
IP registration. The same request/generation checks reject stale callers.
No delivery method reads policy files or changes registry/auth ownership.

`delivery.flush` returns `state: admitted|coalesced`, acknowledging only a wake
for the existing billing/retained-diagnostic owners. One delivery worker plus
one queued wake bound admission. Repeated wakes cannot create parallel flush
workers. Actual buffer admission or synchronous fallback may block that worker;
neither the control loop nor its short snapshot lock waits for delivery I/O.

`delivery.status` returns `flows`, `buffered`, `reports`, `workerActive`,
`wakePending`, `closed`, `drainActive`, `flushFailures`, and `outcomes` containing
`success`, `retryable_failure` and `permanent_failure`. Pending counters and
outcome counters share one memory lock. A webhook outcome is recorded before
its original callback and pending-report release. Outcomes count completed
report delivery cycles, including the existing HTTP retries inside each cycle;
they are not source-record counts, billable units or per-request/run totals.
They reset on process restart and omit losses before webhook admission.
`flushFailures` counts internal worker flush failures separately.

One `delivery.drain` observer is admitted at a time; another receives `busy`.
The observer requests the existing worker at most once per second and checks
progress every 50 ms for up to four seconds. It returns
`{state: quiescent|deadline, snapshot: ...}` within the five-second connection
budget. Quiescence requires no active/queued flush and zero flow, buffered and
report counts. It **does not mean every delivery succeeded**: permanent failures
and retry-budget drops can retire work. Known outcome counters remain visible.
This is not a durable journal, complete loss accounting or cumulative token query.

A timeout/disconnect can retire only the observer, never actual worker, buffer
or HTTP ownership. The Runner keeps one background wake request and at most
one queued notification, so job completion does not wait for socket admission.
Each notification freezes its launch target before dispatch. Restart drops the
old local request owner without retargeting old work. Shutdown freezes one
target and spends at most 30 seconds observing drain; only a correlated
`busy` or `deadline` response permits another observation. A lost/invalid reply
stops automatic requests because execution is unknown.

After control stops, `done()` closes delivery admission and joins the actual
flush worker before shutting down the usage executor. It then retries retained
billing and diagnostics synchronously under their existing retry/idempotency
owners. The separate model-failure reporter keeps its bounded shutdown window.
Runner's existing outer SIGTERM/SIGKILL process stop remains the ultimate bound
for a stuck kernel/network call; no caller deadline safely cancels that call.

The addon delivery SIGUSR1 handler and request/ack files are removed together
with their Rust consumers. Runner's independent service-drain SIGUSR1 is not
this protocol and remains unchanged. API, guest RPC, registry/catalog and log
schemas are unchanged; no mixed embedded-addon transport fallback is retained.

### Registry/catalog application receipts

Runner still publishes complete atomic registry files. Each publication receipt
contains the SHA-256 of the exact serialized bytes, separately from application
evidence. Registration, unregistration and connector synchronization request
acknowledgement after releasing registry and active-run locks. Their success and
retry policies still describe publication: an unconfirmed acknowledgement never
rolls back or automatically republishes configuration.
Initial registration establishes local network-log attribution and runtime-sync
tracking before nonblocking observation admission, including for already-unparked
reused sandboxes. Registration does not wait for a receipt. Each proxy control
generation owns at most one background exchange and one queued publication;
queue saturation records an unconfirmed outcome without waiting or retrying.
Restart, stop, kill and proxy Drop cancel the old generation's queued/in-flight
local observations, even when registry handles survive. Cancellation is an
unconfirmed observation, not rollback of the published registry. Frozen targets
never follow a replacement generation. Unregistration and connector synchronization
retain their synchronous observation waits.

Moving the receipt wait off startup does not remove addon loading work or certify
first-request latency. Current-file enforcement remains on the request path.

`registry.apply` takes exactly `{"digest":"<64 lowercase hex characters>"}`.
It reads only the configured registry/catalog paths; neither policies nor caller
paths travel in the request. One application can be admitted at a time. The
existing mitmproxy event-loop owner runs validation, compilation and auth-cache
reconciliation synchronously, retaining their ordering with request hooks.
Additional applications receive `busy`. Control waits at most four seconds
within its existing five-second connection deadline. A timeout or disconnect
does not cancel admitted work or release its slot; owner completion does. Owner
shutdown closes admission and cancels queued, not-yet-started work before the
control server stops. No arbitrary worker mutates enforcement caches.
The application owner records internal failures using only their exception type,
even after the control waiter has timed out or stopped. Raw exceptions never
enter the cross-thread application future; an active waiter receives the fixed
`internal_error` response instead of an application receipt.

The result contains `expectedDigest`, `state: applied|superseded|rejected`, and
the actual `snapshot`. `applied` means the bytes actually loaded and compiled
match the requested digest; `superseded` identifies different loaded bytes;
`rejected` means the registry was unavailable. It does not acknowledge bytes
merely because they were requested. If replacement occurs after opening, the
receipt identifies that opened file and the bytes actually read, not the later
path target. Subsequent requests retain their current-file checks.

Available snapshots include the registry digest and opened-file identity
(`device`, `inode`, `mtimeNs`, `size`), plus the catalog dependency. Catalog state
is `not_used`, `available`, or `unavailable`; an available dependency includes
its actual opened-file identity and validated catalog digest (without its
`sha256:` prefix). An unavailable dependency includes its fixed failure reason
and opened identity when known. Independent catalog replacement can change the
compiled view without changing the registry digest. Existing catalog failure
retry/reuse rules remain authoritative.

An applied snapshot can contain unusable entries. `validEntries`,
`rejectedEntries`, and `omittedEntries` are exact counts, with at most 32 rejected
or omitted entry outcomes and explicit `truncated`. Outcomes carry only validated
source IPs (null for invalid keys), fixed reasons, and omitted builtin/custom
counts. Rejections precede omissions in the sample. Responses exclude raw entry
keys, run credentials, policy bodies, routing variables and detailed exception
messages. Registry-level unavailability includes the fixed reason and actual
digest/file identity when available.

`registry.status` takes empty parameters and returns the last completed loader
observation, initially `unobserved`. Ordinary request-time loads update it too.
It performs no file/API I/O or application and never certifies that disk is
unchanged now. A short projection lock is not held during loading/compilation;
status and JSONL flush can progress while application is stalled. These receipts
are process-local observations, not durability receipts or a new policy source.
Runner and addon ship together; shared catalog and API schemas do not change.

## Logging Boundaries

The addon and Runner keep traffic records, run-local diagnostics, and process
diagnostics on separate paths:

| Source                         | Sink                                                | Ownership and delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proxied traffic                | `network-{run_id}.jsonl`                            | Per-run network records. Runner flushes, reads, and uploads this file through the network-log pipeline.                                                                                                                                                                                                                                                                                                                                                                  |
| Addon run diagnostics          | `proxy-{run_id}.jsonl`                              | Per-run structured diagnostics. This file is local and best effort; its row level does not automatically send a record to Axiom.                                                                                                                                                                                                                                                                                                                                         |
| Important addon process events | Exact `VM0_ADDON_EVENT` envelope on mitmdump stderr | Process-global failures and explicit dual-sink alerts. The versioned envelope carries one bounded addon-owned JSON log record: `level`, `message`, and any additional fields supplied by the addon logger. Runner does not maintain an event-family schema; it forwards the complete record so the additional fields remain top-level Axiom fields. Underbilling owns its canonical fields and also retains its structured proxy JSONL row when a run path is available. |
| Mitmproxy-native output        | Mitmdump stdout or unmatched stderr                 | Runner-owned process logging. Stdout remains local at info because its text stream does not preserve severity; unmatched stderr keeps the existing warning path. Neither enters proxy JSONL.                                                                                                                                                                                                                                                                             |

Addon code must not use `ctx.log` for active logging: mitmproxy's terminal
handler does not preserve the addon/native ownership boundary at the Runner
pipe. Use `log_proxy_entry` for ordinary attributable diagnostics and
`emit_addon_process_event` only for the explicit process-integrity or alert
events that need the independent Runner path. The emitter owns `level` and
`message`; callers may add other JSON-serializable fields directly without a
nested fields map. Runner-owned Axiom metadata (`_time`, `context`, `service`,
`runner_hostname`, and `runner_version`) remains authoritative. Callers remain
responsible for redaction and bounded values.

Process events use the Linux Runner's stderr pipe only. Each emission reopens
`/proc/self/fd/2` with independent nonblocking flags, checks the opened pipe's
atomic-write limit, attempts one complete record, and closes the descriptor.
The original stderr flags remain unchanged for mitmproxy-native output. A full
pipe drops the entire event; later events can be delivered once the reader
resumes. There is no application queue, retry, overflow log, or shutdown drain.
Each concurrent emission owns at most one transient descriptor and one bounded
record (4096 bytes). Non-pipe stderr and transport setup/write errors also drop
the event. Input validation and serialization errors still propagate. This
best-effort policy does not change billing delivery or run-local JSONL logging.

### Capture header inspection

Opt-in network capture serializes a header prefix bounded to 512 raw fields
and 32 KiB of raw name/value bytes per request or response. Header values retain
the existing redaction rules. `*_headers_truncated` describes only that prefix.

Total capture inspection is capped at 2,048 raw fields per side, including
unrelated names. Body capture requires complete `Content-Type` and
`Content-Encoding` discovery within that limit; dependency values retain their
separate 512-field and 32-KiB budgets, including folding separators. Dependencies
after the serialized prefix still apply when the complete collection fits.

If the raw field count exceeds 2,048, capture skips dependency discovery and
only serializes the bounded header prefix. Even an early valid Content-Type
cannot establish that an unseen duplicate or encoding is absent. Nonempty bodies
are omitted with `*_body_encoding: "binary"`; empty bodies have neither a body
nor an encoding field. Empty, absent, and suppressed bodies do not need
dependency discovery. Existing body truncation and incomplete-stream semantics
remain independent of header truncation.

This bounds optional capture work after upstream parsing. It does not reject
traffic or modify status, headers, or wire body bytes. The final network-log row
still reaches the existing writer. Old runners retain their previous capture
policy until updated; the log schema and its consumers do not change.

### JSONL append recovery

The asynchronous writer accepts caller-framed JSONL bytes and opens the
Runner-owned regular log files for reading and appending. Before a nonempty
batch, it inspects only the final byte and appends a newline if the existing
tail is unterminated. The separator uses the same bounded short-write loop as
the records. Inspection or write failures retire the batch through the existing
warning and accounting path; flush completion still means processed, not
persisted. Healthy files gain no extra separators.

Recovery never truncates or rewrites existing bytes: Rust also appends to the
per-run network file. This isolates subsequent addon records from a failed
prefix, including after a writer restart, but cannot recover another producer's
record already embedded in a malformed line or serialize independently
interleaved short-write sequences. The existing Runner uploader continues to
skip malformed physical lines and upload independently parseable records.

## Header-phase credential-resolution failures

If credential resolution fails while preparing a request for authenticated
streaming, the addon terminates that upload from `requestheaders()`. The pinned
mitmproxy runtime closes an HTTP/1 connection or resets the affected HTTP/2
stream before sending `100 Continue` or consuming the request body. It makes no
upstream request and does not retry credential resolution for that flow.

These uploads receive a transport termination instead of a JSON error after
body completion. The existing firewall action, error classification, and proxy
diagnostic remain available; the error hook records a connection failure with
status `0` and releases terminal resources. The unsent local error response is
discarded so it cannot appear as a captured response. Auth failures first
resolved in the normal buffered request hook keep their structured responses.
Successful authenticated streaming retains its bounded capture behavior.

This changes only the addon lifecycle. Runner/API and network-log schemas stay
unchanged, and old Runner instances keep their previous behavior until replaced.
`test_mitmproxy_header_auth_failure_framing.py` covers incomplete Content-Length,
chunked, and HTTP/2 uploads, including body data queued during the headers hook.

## Model-provider failure reporting shutdown

Failure reports are best-effort diagnostics with four reporter-owned daemon
workers and at most 16 admitted reports. Shutdown closes admission, cancels
queued reports, and gives running deliveries one shared 10-second drain window.
Unlike standard thread-pool workers, these workers are not registered for an
interpreter-exit join. A stalled DNS lookup or network operation can therefore
leave a report undelivered without keeping the process alive after the drain.

Running calls are not forcibly interrupted: if the process remains alive, they
retain their worker and admission slot until completion. Normal completion and
queued cancellation keep the same callback-owned cleanup. All workers start
before any report payload is admitted, and failed startup joins the empty
candidate workers. Usage webhook and SigV4 workers retain their independent
joined-shutdown contracts.

`test_model_provider_failure_shutdown.py` exercises the real addon response and
shutdown hooks in a fresh interpreter. It requires successful process exit
while DNS remains blocked, with the production drain budget unchanged. Old
runners retain their previous shutdown behavior until updated; no reporting
API or persisted format changes.

## Managed credential method boundary

Firewall permissions authorize the request's actual HTTP method. Requests with
`X-HTTP-Method-Override` are rejected before managed credentials are resolved or
injected: providers such as Mailchimp can otherwise reinterpret an allowed POST
as a denied DELETE. Header names are case-insensitive; empty and repeated values
are rejected too. Callers must use the actual method and its corresponding
permission. Requests without managed credential injection retain their existing
behavior.

The shared auth plan applies this check to both the request-header streaming
probe and the buffered request hook, including header, query, AWS SigV4, and
auth-base credentials. `test_firewall_method_override.py` covers the Mailchimp
audience deletion bypass through these hooks. Old runners keep their previous
behavior until deployed; permission catalogs that rely on this boundary must
wait for the runner rollout.

## WebSocket Framing Contract

[`websocket_framing.py`](../crates/runner/mitm-addon/src/websocket_framing.py)
is a version-pinned private replacement for mitmproxy's WebSocket connection
class. It bounds decoded data before a complete message reaches mitmproxy's
WebSocket addon hooks. The [real-layer integration
tests](../crates/runner/mitm-addon/tests/test_mitmproxy_websocket_framing.py)
are the executable contract for the behavior described here.

### Limits and allocation boundary

The limits apply to decoded logical messages, not to raw network reads:

| Constant                      | Value   | Scope                                                    |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `MAX_DECODED_MESSAGE_BYTES`   | 256 MiB | One logical message in one WebSocket direction           |
| `MAX_MESSAGE_DATA_FRAMES`     | 8,192   | Data frames in one logical message in one direction      |
| `MAX_AGGREGATE_DECODED_BYTES` | 1 GiB   | All active WebSocket directions in one mitmproxy process |

Each bounded connection has a message budget for one direction. Decoded bytes
are charged as payload data is processed, and the process-wide aggregate budget
reserves the same bytes across all active directions. The limit extension is
appended after negotiated inbound extensions, so permessage-deflate output is
bounded before wsproto delivers decoded content to mitmproxy. A message that
exceeds a byte or frame limit emits no message hook or forwarded data and closes
with WebSocket code 1009 (`MESSAGE_TOO_BIG`).

### Frames, reads, and fragmentation

One network read can contain part of a frame, multiple frames, or a partial
message. The data-frame counter increments once when the first payload for each
data frame arrives, including continuation frames, rather than once per read.
Control frames are passed through and do not consume the data-frame budget. The
decoded-byte and data-frame counters reset only after a complete logical message
has been dispatched, or immediately when the connection closes. Partial frame
state is kept in a mutable `frame_buf` so repeated reads do not repeatedly copy
an immutable prefix.

### Bounded permessage-deflate

When permessage-deflate is negotiated, the framing adapter replaces the
mitmproxy extension while preserving its negotiated takeover and window
parameters. It asks zlib for at most one byte beyond the remaining message and
aggregate budgets. Extra output or a non-empty zlib unconsumed tail is treated as
an overflow lower bound, clears the decompressor and message budget, and closes
the flow with code 1009. A zlib decoding error clears the same state and closes
with `INVALID_FRAME_PAYLOAD_DATA` (1007).

RFC 7692 messages omit the final deflate block on the wire. The adapter restores
the empty-deflate trailer (`00 00 ff ff`) at the end of a compressed message and
runs that output through the same bound before dispatch. Uncompressed messages
after a compressed message, context takeover, and negotiated no-context-takeover
are connection-local states covered by the real-layer tests. Any rejected or
terminally closed compressed flow clears its decompressor and partial framing
state before the flow can release its connection resources.

### Aggregate ownership and terminal cleanup

The aggregate budget is process-global to the mitmproxy event-loop process. A
completed message keeps its decoded-byte reservation through addon hook
dispatch and forwarding: completion clears the per-message counters but defers
aggregate release until the next event-loop turn. This prevents another active
direction from using those bytes while the completed message is still held by
the hook. Rejection and either-direction connection close release the reservation
immediately. Partial frame, budget, and decompressor state are cleared for both
inbound and outbound close paths.

The first limit violation on each connection is stored as content-free
diagnostic state. At terminal flow cleanup,
`mitm_addon.py`'s
[`_release_terminal_flow_state()`](../crates/runner/mitm-addon/src/mitm_addon.py#L1658-L1684)
calls `log_limit_violation()` to consume that state and write a
`websocket_framing_limit` warning for each stored direction. Its structured
fields are `reason`,
`direction`, `limit_unit`, `limit_value`, `observed_value`,
`observed_is_lower_bound`, `close_code`, `run_id`, `flow_id`, and
`firewall_name`; payload contents are not logged. The separate
`release_flow_state()` entry point removes any remaining connection-scoped
diagnostic state without emitting a record.

### Installation and version re-audit

`install_websocket_framing()` is idempotent: it returns when the marked bounded
connection class is already installed, and rejects an unexpected unmarked
mitmproxy connection class. `mitm_addon.load()` installs the adaptation through
the [exact-version compatibility gate](../crates/runner/mitm-addon/src/mitmproxy_compat.py)
before registering addon options. The gate requires mitmproxy `12.2.3` and
wsproto `1.3.2`; the [runner dependency contract](../crates/runner/src/deps.rs)
and the addon `pyproject.toml`/`uv.lock` keep those pins aligned.

Before either dependency is upgraded, re-audit the private mitmproxy
connection, extension, frame-buffer, and generator behavior described above and
update the compatibility gate, runner artifact metadata, Python dependency
metadata, and this contract together. The
[`test_mitmproxy_websocket_framing.py`](../crates/runner/mitm-addon/tests/test_mitmproxy_websocket_framing.py)
suite must continue to pass as the executable framing contract.

## WebSocket handshake inspection boundary

Request classification and 101 response confirmation inspect `Headers.fields`
as raw bytes. They do not obtain full strings through `Headers.get_all()` before
checking the handshake budget. The caller owns one 8,192 limit and passes it to
response confirmation:

- Token lookup spends one unit per visited raw field, including unrelated
  fields, and one per inspected matching-value byte. A complete token at a comma
  or actual field end can return immediately; exhausting the budget is not a
  field ending. Later fields and an irrelevant suffix are not inspected.
- Singleton lookup separately allows at most 8,192 raw fields and an inclusive
  8,192 value bytes. It verifies cardinality and length before stripping SP/HTAB,
  so oversized or repeated key/version/accept fields cannot trigger full-value
  conversion or copying.
- Raw names are length-checked before ASCII case normalization. Key validation
  still requires 24 encoded bytes and 16 decoded bytes; version is `13`, and
  response confirmation requires an ASCII key and the matching 28-byte accept.

Over-budget or invalid handshakes fail closed to ordinary HTTP classification
and terminal usage handling. These are local addon inspection limits, separate
from mitmproxy's raw HTTP head buffering and other header consumers. Old runners
retain their previous inspection behavior until they are updated.

`test_http_header_syntax.py` uses guarded raw values and field sequences to prove
early termination and bounded access. `test_mitmproxy_websocket_header_budget.py`
feeds non-UTF-8 values through real HTTP/1 request hooks and guards the dependency
conversion boundary. `test_model_provider_websocket_lifecycle.py` verifies raw
response confirmation and tracked-flow retention/release. These regressions use
structural assertions, with no timing or allocation thresholds.

## Response Content-Type inspection boundary

The shared response classifier inspects at most 8,192 raw header fields and
8,192 leading Content-Type value bytes per call. It checks field count before
enumeration and name length before ASCII case normalization. Missing or repeated
Content-Type fields do not establish SSE, including a parameterized first value
followed by a duplicate.

For a singleton, the media type must end at a semicolon inside the inspected
prefix or at the actual field end within the byte limit. Exhausting the budget
does not establish a field ending. Only this bounded media type is copied,
stripped of SP/HTAB, and compared case-insensitively with exactly
`text/event-stream`. An arbitrarily large parameter suffix after an early
semicolon is neither decoded nor copied by the classifier. Lookalikes such as
`text/event-stream+json` remain non-SSE.

Missing, ambiguous, or over-budget input follows the existing non-SSE inspector
selection and terminal JSON eligibility shared by usage and failure observers.
This does not prove the body is JSON: a true SSE body with an unclassifiable
header may have no parsed usage or failure event. Request and response wire
headers and streamed bytes are preserved. These local limits do not bound
mitmproxy's raw HTTP-head buffering or other header consumers; old runners keep
the previous behavior until updated.

`test_response_content_type_budget.py` covers parsed HTTP/1 ASCII and non-UTF-8
parameter suffixes through the real response-header hook, guards the dependency
conversion boundary, and verifies parsed usage and unchanged traffic. Structural
raw-value guards and exact-boundary cases protect against unbounded suffix
copies, name normalization, and truncated-prefix matches. The shared failure
reporting suite also verifies the same classification for usage and failure
observers without timing or allocation thresholds.

## Content-Encoding decoder inspection boundary

Shared body decoders inspect at most 8,192 raw header fields and 8,192 total
Content-Encoding value bytes per call, including comma-space separators for
repeated fields. Field count is checked before traversal, and raw names are
length-checked before case normalization. All matching values must fit the
budget before any value is decoded, joined, stripped, or lowercased. Oversized
unrelated names and values are skipped without copying or normalization.

Within budget, decoding preserves mitmproxy's UTF-8/surrogateescape conversion,
comma folding, and existing whitespace/case normalization. Missing and empty
encoding remain identity; gzip, deflate, and br keep streaming support, while
zstd keeps its bounded terminal JSON path. Repeated fields and coding lists
retain their unsupported-encoding behavior.

Budget exhaustion is uninspectable, not proof of identity encoding. Capability
checks decline both streaming and terminal JSON fallback. Successful billable
model responses and registered connector response parsers therefore use the
existing empty 502 response and discard upstream body bytes. The fixed
`content encoding header inspection limit exceeded` diagnostic contains no raw
header data. Upstream errors, non-billable flows, and bodyless responses retain
their existing pass-through policy; status-level provider failure reports remain
available. Accepted and pass-through responses preserve wire headers and bytes.

Direct terminal JSON decoding returns an error for exhaustion, strict capture
decoders hide the body, and best-effort capture decompression retains wire bytes
as it does for unsupported encoding. These local decoder limits do not bound
mitmproxy's initial HTTP-head buffer, separate request-billing inspection, or
other header consumers. Old runners retain their previous local behavior until
updated; no wire protocol or persisted state changes.

`test_response_content_encoding_budget.py` exercises guarded raw inputs through
the real response hooks and verifies usage delivery, exact limits, and 502/body
discard behavior. The provider failure suite covers the real 429 response hook
with oversized unrelated names and excess fields while verifying HTTP reports
and pass-through traffic. The regressions use structural work assertions, not
wall-clock thresholds.

## Path normalization work boundary

Path safety validation accepts at most 65,536 input characters and five percent
decoding passes. Before whole-segment NFKC, each raw or decoded segment must have
at most 30 consecutive non-starters after compatibility decomposition (NFKD).
This is the [UAX #15 stream-safe input boundary](https://www.unicode.org/reports/tr15/#Stream_Safe_Text_Format):
the addon rejects unsupported paths; it does not insert characters or rewrite
the request path. Already ordered sequences above the limit are rejected too.

The guard decomposes one code point at a time and counts nonzero canonical
combining classes across decompositions. This catches characters with class zero
that decompose into marks, as well as multi-mark expansions. It never applies
NFKD to an unbounded segment. With bounded non-starter runs, the subsequent
whole-segment NFKC cannot perform unbounded canonical reordering per character.
The Unicode scan adds linear work; the plain-ASCII fast path is unchanged.

Long starter-separated Unicode paths remain supported within the total limit.
Existing dot/matrix syntax, malformed escapes, UTF-8, compatibility syntax, and
decode-depth checks remain in place. Matching rejects over-budget paths with the
existing `unsafe_path` decision before credentials are resolved. Shared base and
auth-rewrite URL validation uses the same boundary. During runner rollout, old
runners retain the previous pathological-input behavior until drained; no wire
format or persisted data changes.

`test_request_path_normalization_budget.py` exercises both real addon request
phases, observes the standard-library normalization boundary, and checks denial
before auth as well as successful unchanged Unicode paths. Correctness tests use
structural assertions rather than elapsed-time thresholds.
