# Host early archive phase diagnostics

Runner records `headers` and `body` for each entered GET attempt, then
`apply_wait` and `publication` once for a complete admitted archive. They use
the existing sandbox-operation telemetry and its run identity. The
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

Four admitted archives and at most three GET attempts bound these records to
32 per prepared storage delivery: at most six headers/body records plus one
apply-wait and one publication record per archive. A sandbox retry that replaces
its storage plan owns another delivery; this is not a run-wide cap. Repeated
headers/body records retain failed attempts rather than hiding them behind a
successful recovery. Each headers record freezes its own connection observer.

The existing `storage_cache_fresh_delivery_single_request` marker is retained
once at logical-owner admission for compatibility; it is not an actual request
count after retries. Count entered headers phases for explicit application-level
GET attempts; HTTP-library protocol recovery is not separately measured. Parallel
archives still cannot be paired by event order.

The phase instrumentation adds only a small shared buffer, clock reads and
short synchronous locks at phase boundaries; no per-chunk observation or awaited
telemetry upload is added. Retry requests and sleeps are the bounded behavior
described below. Admission, HTTP reuse, the 30-second per-request timeout,
8 MiB limit, cache flock and permits through staging are unchanged.

Records contain fixed action names and bounded reasons. When a declared
response length differs from the known manifest size, the `headers` phase
includes the optional `archive_size_mismatch` object described below. That
phase can succeed despite the disagreement; zero-length and over-limit
responses still fail. An entered `headers` phase also includes the optional
`archive_connection_attempt` object described below.
Records include no archive URL, query, raw headers, object identity, mount path
or content. Phase records from parallel archives cannot be paired by order. Do
not add phase maxima or percentiles as one request's latency, or add overlapping
early fetch time to storage-apply time.

## Bounded Runner-owned download retries

Archive downloads share the read-only failure policy with session-history blobs:
at most three attempts including the first, 200/400 ms exponential backoff,
and a 90-second overall deadline covering requests and backoff. Each GET retains
its 30-second request timeout. HTTP 429, 500, 502, 503 and 504, timeouts, connect
errors and typed transport interruptions can retry. The next attempt always
starts with an empty body buffer; incomplete bytes are never staged or published.

The effective delay is the larger of backoff and a valid `Retry-After` delta or
HTTP date. Invalid hints, hints beyond the remaining budget, permanent statuses
(including 401/403/404/501), redirects, unsolicited partial responses and archive
size-contract violations do not retry. Cancellation owns both backoff and GETs;
the original cache writer and runner-wide permit remain held by the same owner
until completion or cancellation cleanup. No signed-URL renewal, Guest fallback,
Agent replay or retry of cache publication/staging is introduced. Post-spawn
background cache fills and Guest-owned downloads are unchanged.

Retry diagnostics contain fixed reasons, attempt limits, delay and optional
numeric HTTP status. Terminal HTTP errors also retain the numeric status in the
existing error text, without a telemetry schema change. No URL, query, raw header,
response body or object identity is recorded. A retry policy is not proof that a
historical unknown-status failure was transient or repaired; deployment and a
bounded production follow-up remain separate gates.

## Host connection-attempt lifecycle

The Runner-owned reqwest client has one content-free connector layer. For each
entered headers phase, a request-local observer is active while the request is
sent and its status and declared size are validated. A connector service call
starts an attempt guard. That guard follows the connector future if the HTTP
pool continues it in a background task. The headers phase atomically freezes
the observer on success, error or interruption; a connector completion or drop
after that boundary cannot change the recorded summary.

| Field inside `archive_connection_attempt` | Meaning                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `started`                                 | Connector futures started while the request observer was active.                        |
| `succeeded`                               | Those futures that returned a connection before the headers observer froze.             |
| `failed`                                  | Those futures that returned an error before freeze; raw errors are not retained.        |
| `dropped`                                 | Those futures dropped without returning before freeze.                                  |
| `active_at_headers`                       | Started futures with no terminal result when the headers observer froze.                |
| `terminal_duration_ms`                    | Sum of whole elapsed milliseconds for success, failure and drop recorded before freeze. |
| `saturated`                               | At least one count or the duration sum reached its fixed representable cap.             |

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
the existing headers operation carries these fields:

| Field inside `archive_size_mismatch` | Meaning                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `expected_bytes`                     | Reconciled positive manifest archive length, as exact decimal text.                                      |
| `response_bytes`                     | The HTTP library's declared response length, as exact decimal text; measured before body consumption.    |
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

The metadata belongs to the existing headers phase, preserving its completion
timestamp and explicit drain semantics. It adds no event or network request.
A disagreement alone no longer fails the headers phase: a positive declared
length within the 8 MiB limit becomes the expected length for this transfer.
The body must still be fully received at that length. Zero-length and oversized
responses fail in headers; a transfer ending before its declared length fails
during body reading and is never published. Without a declared length, the
existing manifest-size fallback still applies.

The object is absent on status failures and requests interrupted before a
completed mismatch observation; a later body failure does not erase a
successfully recorded headers disagreement. A successful transfer can proceed
to cache publication and Guest staging without a second download owner.
Neither the lengths nor the metadata prove that the decompressed paths and file
contents match the logical version, or that an overwrite occurred.

For follow-up analysis, freeze exact Runner/API artifacts, UTC window, hosts,
startup route, manifest/content and cache shape; report success, failure, retry
and missing-join denominators. Compare the measured phase with complete storage
apply, executor-to-spawn and API-to-spawn separately. Exclude team-concurrency
queue time but retain durable Runner claim waiting. A correctly measured phase
does not establish a production performance improvement or resolve Guest/proxy
connection attribution. The optional mismatch object extends the API telemetry
schema without changing persisted state or the Guest protocol. New APIs accept
old Runner operations that omit it. Older APIs strip the unknown object and
retain the existing headers operation, successful or failed, so either
deployment order remains functional. Complete diagnostic availability requires
both updated API and Runner artifacts. Missing metadata from an older receiver
is not a zero size or evidence that no mismatch occurred.
