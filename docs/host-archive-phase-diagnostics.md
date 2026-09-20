# Host early archive phase diagnostics

Runner records four timed operations for each admitted early archive request.
They use the existing sandbox-operation telemetry and its run identity. The
duration is monotonic elapsed time in integer milliseconds; the event timestamp
is captured at the phase's completion, even if the owner collects it later.

| Operation suffix after `storage_cache_fresh_delivery_` | Boundary                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `headers`                                              | Request send through response status and declared-size validation.                 |
| `body`                                                 | Accepted headers through reading and validating the complete body.                 |
| `apply_wait`                                           | Validated body through the existing storage-apply gate.                            |
| `publication`                                          | Publication task entry through the atomic cache write, including fsync and rename. |

These operations do not include classification or task scheduling before first
poll. Existing `storage_cache_stage_total` and
`storage_cache_stage_batch_write` measure Guest staging. Header time includes
client and network work; it does not separately identify DNS, TCP, TLS, proxy or
upstream latency. Publication time includes filesystem waiting, not just CPU.

Each entered phase emits one success or bounded error record. A dropped active
phase reports `interrupted`; an explicitly cancelled apply gate can report
`cancelled`. A phase never entered has no record. In particular,
missing phases are not successful zero-duration work. Completed sub-millisecond
phases can round to zero. Earlier phase records survive fetch abortion and are
collected after explicit cancellation joins. Already-started atomic publication
is awaited and can succeed after run cancellation. Repeated drain does not emit
the same record again. An unexpected owner Drop, process crash or failed telemetry
delivery can still leave missing records; there is no new background uploader.

Four admitted archives and four phases bound the new records to 16 per prepared
storage delivery. A retry that replaces its storage plan owns another delivery;
report attempt counts rather than assuming a run-wide cap.
The implementation adds a small shared record buffer, clock reads and short
synchronous locks at phase boundaries. It adds no request, retry, per-chunk
record, sleep or awaited telemetry upload to startup. This is a bounded overhead
budget, not a claim of zero runtime cost. Admission, HTTP reuse, the 30-second
request timeout, 8 MiB limit, cache flock and permits through staging are unchanged.

Records contain fixed action names and bounded reasons. A failed `headers`
phase with `response-size-mismatch` also includes the optional
`archive_size_mismatch` object described below. An entered `headers` phase also
includes the optional `archive_connection_attempt` object described below.
Records include no archive URL, query, raw headers, object identity, mount path
or content. Phase records from parallel archives cannot be paired by order. Do
not add phase maxima or percentiles as one request's latency, or add overlapping
early fetch time to storage-apply time.

## Host connection-attempt lifecycle

The Runner-owned reqwest client has one content-free connector layer. For each
entered headers phase, a request-local observer is active while the request is
sent and its status and declared size are validated. A connector service call
starts an attempt guard. That guard follows the connector future if the HTTP
pool continues it in a background task. The headers phase atomically freezes
the observer on success, error or interruption; a connector completion or drop
after that boundary cannot change the recorded summary.

| Field inside `archive_connection_attempt` | Meaning                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `started`                                  | Connector futures started while the request observer was active.                        |
| `succeeded`                                | Those futures that returned a connection before the headers observer froze.              |
| `failed`                                   | Those futures that returned an error before freeze; raw errors are not retained.          |
| `dropped`                                  | Those futures dropped without returning before freeze.                                   |
| `active_at_headers`                        | Started futures with no terminal result when the headers observer froze.                  |
| `terminal_duration_ms`                     | Sum of whole elapsed milliseconds for success, failure and drop recorded before freeze.   |
| `saturated`                                | At least one count or the duration sum reached its fixed representable cap.               |

Counts are capped at 255 and `terminal_duration_ms` at 4,294,967,295. When an
observation exceeds a cap the value remains bounded and `saturated` is true. The API
forwards the seven fields under the `archive_connection_attempt_` prefix in
Axiom. An emitted object with `started: 0` means no connector call was observed
before this headers phase froze. An absent object means the headers phase was
not instrumented, such as an older Runner payload; absence is not zero.

This diagnostic observes connection **attempts**, not the transport used by the
request. Hyper-util 0.1.20 races its idle-pool checkout against a lazy connector
future. If an idle connection is immediately ready, the connector never starts,
so a successful zero-start operation is consistent with immediate pool reuse.
If checkout becomes ready after a connector starts, the pooled connection can
serve the response while the losing connector future completes in the
background and enters the pool. Therefore any nonzero attempt lifecycle remains
ambiguous about which transport served the response. Do not label these records
as new or reused connections, and do not subtract their duration distribution
from the headers distribution as if their per-percentile samples were paired.

The connector covers the client's configured address resolution, TCP, proxy and
TLS establishment as one operation. Reqwest 0.13.5 does not expose separate
phase durations or hyper-util's internal pooled-handle reuse bit. This contract
must be rechecked when those pinned dependencies change. It deliberately avoids
reqwest verbose connection tracing because that mode can include signed request
bytes.

The observer stores only fixed counters, duration and a saturation bit. It does
not inspect or retain the connector destination, URL, origin, host, address,
certificate, provider/account identity, object identity, headers, credentials,
content or raw error. It creates no request, retry, event, per-attempt array or
startup telemetry wait. The connector wrapper allocates one small future only
when connection establishment starts; immediate pooled checkout does not invoke
it. Pool keying, eight-idle-socket limit, 30-second idle lifetime, platform TLS,
environment proxy behavior, redirect policy, request timeout and cancellation
remain unchanged.

The optional object is additive. New APIs accept old Runner operations that
omit it. Older APIs strip the unknown object and retain the existing headers
operation, so either deployment order remains functional; complete queryable
diagnostics require both updated artifacts.

## Declared-size disagreement

When a known manifest length differs from the response's declared body length,
the existing headers failure carries these fields:

| Field inside `archive_size_mismatch` | Meaning                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `expected_bytes`                     | Reconciled positive manifest archive length, as exact decimal text.                                      |
| `response_bytes`                     | The HTTP library's declared response length, as exact decimal text; no body bytes have been consumed.    |
| `source_kind`                        | `storage` or `artifact` for the grouped request's first target.                                          |
| `source_index`                       | That representative target's zero-based index in the normalized prepared plan's collection for its kind. |
| `content_encoding`                   | `absent`, one trimmed case-insensitive `identity` or `gzip`, or `other`.                                 |

The API forwards each field under the `archive_size_mismatch_` prefix in Axiom.
Byte strings contain at most 20 decimal digits and retain arbitrary u64 declared
lengths without JavaScript rounding. A source index can exceed the four-request
admission limit: it refers to the prepared plan, not admission order. Duplicate
targets can share a request and its expected length; the first handle is only
a representative, not a unique object identity or a stable index across retries.
Multiple, empty, invalid, encoding-list and unrecognized Content-Encoding values
become `other`; their raw values are never retained.

The metadata belongs to the existing failed phase, preserving its completion
timestamp and explicit drain semantics. It adds no event or network request.
It is absent on status failures, body-size failures, successful headers and
interrupted requests without a completed mismatch observation. Rejection still
precedes body consumption, cache publication and Guest staging, with no second
download owner. These measurements can distinguish candidate representations;
they do not establish an overwrite, corruption, or a production repair.

For follow-up analysis, freeze exact Runner/API artifacts, UTC window, hosts,
startup route, manifest/content and cache shape; report success, failure, retry
and missing-join denominators. Compare the measured phase with complete storage
apply, executor-to-spawn and API-to-spawn separately. Exclude team-concurrency
queue time but retain durable Runner claim waiting. A correctly measured phase
does not establish a production performance improvement or resolve Guest/proxy
connection attribution. The optional mismatch object extends the API telemetry
schema without changing persisted state or the Guest protocol. New APIs accept
old Runner operations that omit it. Older APIs strip the unknown object and
retain the existing failed operation, so either deployment order remains
functional. Complete diagnostic availability requires both updated API and
Runner artifacts. Missing metadata from an older receiver is not a zero size
or evidence that no mismatch occurred.
