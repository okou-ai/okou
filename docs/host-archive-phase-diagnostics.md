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

New records contain only fixed action names and bounded reasons. They include
no archive URL, query, headers, object identity, mount path or content. There is
no per-archive correlation field: phase records from parallel archives cannot
be paired by order. Do not add phase maxima or percentiles as one request's
latency, or add overlapping early fetch time to storage-apply time.

For follow-up analysis, freeze exact Runner/API artifacts, UTC window, hosts,
startup route, manifest/content and cache shape; report success, failure, retry
and missing-join denominators. Compare the measured phase with complete storage
apply, executor-to-spawn and API-to-spawn separately. Exclude team-concurrency
queue time but retain durable Runner claim waiting. A correctly measured phase
does not establish a production performance improvement or resolve Guest/proxy
connection attribution. These additive operation names change no API schema,
persisted state, Guest protocol or deployment ordering.
