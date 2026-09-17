# Guest archive connection observation

`guest-storage-apply` writes one `remote_connection_observation` JSON message
to its existing Guest system log when a remote archive application call returns
response headers or an error. The same line is mirrored to stderr by the
existing logger. File archives and decoded-file delivery do not emit it.

This diagnostic separates resolver work and combined connection setup inside
the existing request-to-response-headers timer. It does not separately measure
TCP, TLS, proxy admission or upstream response waiting. Those boundaries and
exact Guest/proxy correlation remain in [#34801](https://github.com/vm0-ai/okou/issues/34801).

## Measurement contract

The observer delegates to the complete ureq `DefaultResolver` and
`DefaultConnector`. The shared Agent, platform certificate verification,
environment proxies, CONNECT handling, connection pool, deadlines, redirects
and existing recovery behavior remain library-owned. The observer neither
parses nor modifies request or response bytes.

| Field                            | Observed boundary                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_to_response_headers_us` | Existing application-call boundary, captured immediately after `call()` returns and before diagnostic serialization or logging. On error this is time until the call failed, not time until received headers. |
| `resolve_outside_setup`          | Delegated resolver calls made outside a connector invocation. Includes resolver validation/filtering and any waiting for libc lookup, not just DNS wire latency.                                              |
| `resolve_inside_setup`           | Delegated resolver calls made during connection setup, including CONNECT proxy resolution. This overlaps `connection_setup`.                                                                                  |
| `connection_setup`               | Outermost complete default-connector calls. Includes TCP/TLS, proxy handling and nested resolution where applicable; recursive connector calls are not counted again.                                         |

Durations use a monotonic clock and are recorded in integer microseconds.
Each phase carries `invocations`, `completed`, `errors`, `interrupted`, and
`status`. An unentered phase has `status: not_entered` and no `duration_us`.
Entered phases distinguish completed, failed, mixed and interrupted outcomes.
An entered duration can legitimately round to zero microseconds; that is
different from an unobserved phase. Aggregate phase counts are callback
invocations, not archive attempts, DNS packets, TCP attempts or wire requests.

`call_outcome` is `response_headers`, `error` or `interrupted`. Returned HTTP
error statuses still have `response_headers`: status validation and archive
extraction happen afterward. Body failure cannot retrospectively change this
header-call observation. Existing body-read, extraction and SandboxOp records
retain their separate contracts.

On Rust unwinding, `interrupted` records the observation guard's lifetime in
`request_to_response_headers_us`; no returned-header boundary was observed.

### Transport use and pooling

`transport_use` describes attempted I/O through observed logical transports:

- `unobserved`: no observed transport I/O entry; this does not establish reuse.
- `new_for_call_only`: used only transports created within this call.
- `prior_call_only`: used only transports retained from an earlier call.
- `mixed`: used both kinds.
- `unavailable`: an attempted transport use lacks a comparable internal identity.

Failed writes still establish attempted use; no successful bytes are implied.
Pool health probes, buffer access and buffered-input checks do not establish
wire I/O. A retained transport can move between worker threads. Its private
creating-call ordinal is compared with the current worker's active call;
it never retains a previous call's observer.

One `call()` may redirect or recover from a stale pooled transport. A redirect
back to a transport created earlier in that same call is still `new_for_call`.
The diagnostic does not claim per-hop reuse or a unique connection count.
Internal ordinals never appear in logs and cannot wrap into a false identity
match. There is no cross-record or cross-proxy correlation key: different
helper invocations may append to one run log, making bare process-local
ordinals unsuitable for that purpose.

## Interpretation limits

Resolution occurs before pool lookup in pinned ureq, so a pooled call can
have nonzero resolver time. A call that fails before reaching the pool must
not be classified as reused merely because no connector ran.

Successful extraction does not itself prove pool eligibility: the single-member
gzip decoder can finish before the HTTP reader receives the final EOF read
that returns its transport to ureq's pool. Reuse tests first drain an HTTP error
body through the existing error path, then exercise a real subsequent archive
request. The observer preserves this existing body-ownership behavior.

Never add nested resolution to combined setup. Do not label the remainder
after subtraction as upstream/server waiting: it can include pool work,
request formatting/writes, header parsing, redirects and redirect-body drains.
Do not subtract this record from the proxy HTTP latency timer; their boundaries
differ. Separate phase percentiles are not additive savings.

Observer guards restore the active context and nesting depth after normal
errors or unwinding. The context is cleared before logging and body access.
External termination, process abort and log write failure can leave no terminal
record. A missing record is not a successful zero or evidence that no remote
work occurred. Resolver timeout observes return to the caller; an underlying
libc lookup can continue on its dependency-owned thread afterward.

## Privacy and cost

The diagnostic has fixed field names and enums, scalar counters and durations.
It contains no URL, host, query, headers, credentials, socket address, object
key, path, user content, raw dependency error or exported identifier. It uses
the existing log message transport without changing the SandboxOp or API
schemas. There is no new compatibility fallback or rollout dependency.

The event budget is one additional local record per returned remote application
call, including failures. Redirects and nested connection work do not add
records. State consists of fixed counters/flags per active call and bounded
identity state per pooled transport, with no growing identity map. The normal
scheduler admits at most four concurrent archive tasks. No per-chunk log,
network request, diagnostic retry or telemetry upload wait is added.
The prefix and JSON payload stay below the tested 1 KiB budget, excluding the
existing logger's timestamp and tag envelope.

Serialization, local append and stderr flush are real overhead. Logging occurs
after the header timer is captured but before body access, remains within the
task total, and consumes wall time under the unchanged global request deadline.
Do not claim that unchanged timer boundaries imply unchanged measured values.

### Local overhead sample

On September 17, 2026, a Linux local-profile comparison used baseline
`e9001cdc0e69e7246209e62e2995a388a82077b5` and observer commit
`21fbc6cca01f306e52b497d0b552c9a8e78f7117` with Rust 1.98.1.
Twelve alternating baseline/observer process pairs each applied 64 tiny
single-file gzip archives to distinct nested mounts, forcing serial scheduling.
Both used the same loopback HTTP/1.1 server, real extraction, system-log appends
and captured stderr; one warmup per binary was excluded. All 1,664 expected
requests completed and output files were checked. The 768 measured observer
calls each emitted one record and reported `new_for_call_only`.

Whole-process medians were 152.53 ms baseline and 152.93 ms observed. Paired
deltas had a 1.37 ms median (21.34 us per call) and ranged from -4.37 to +9.25 ms
per process. Each additional system-log line averaged about 547 bytes, also
mirrored to stderr. This noisy local sample accounts for actual serialization
and logging; it is not a production overhead bound, isolated phase benchmark
or speedup claim.

## Verification and dependency upgrades

The implementation contract was derived from ureq **3.4.2**:

- `run.rs`: resolver-before-pool ordering, redirects and call/header ownership.
- `pool.rs`: connector bypass on a usable pooled transport.
- `unversioned/transport/mod.rs`: complete default connector chain and transport
  delegation, including the buffered-input fast path.
- `unversioned/transport/connect.rs`: recursive CONNECT setup.
- `unversioned/resolver.rs`: resolver boundary and timeout ownership.

These extension traits are explicitly outside ureq's semver guarantees.
Re-audit these source boundaries on upgrades; compilation alone does not prove
unchanged timing semantics. Keep tests for real cold/keep-alive calls, multiple
workers, redirects, proxy recursion/bypass, errors, local/decoded controls,
privacy and process termination. Controlled boundary gates verify phase
placement without fixed elapsed-time assertions.

Before production evaluation, declare exact Runner/API revisions, host,
startup route, manifest/cache/source shape, UTC and Beijing windows, starts,
remote application calls, failures/retries and missing records/joins. Local
diagnostic correctness and overhead measurements do not establish production
recurrence, root cause or a speedup.
