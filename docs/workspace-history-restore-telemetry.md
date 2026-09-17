# Workspace history restore telemetry

`session_history_workspace_cache_guest_restore` describes one attempt to
restore a successfully materialized local history sidecar into a guest. Join it
to startup events using the existing `run_id`.

| Field                                    | Meaning                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `session_history_framework`              | Effective `claude-code`, `codex` or `pi` framework                 |
| `session_history_raw_bytes`              | Validated decoded history size                                     |
| `session_history_source_bytes`           | Validated local sidecar file size; not the remote history-ref size |
| `session_history_source_representation`  | Local sidecar: `raw` or `codex_zstd`                               |
| `session_history_restore_representation` | Actual materialized guest payload: `raw` or `codex_zstd`           |
| `session_history_restore_reason`         | `raw_source`, `retained_zstd` or `codex_pruning_guard`             |
| `session_history_guest_bytes`            | Successfully restored history payload bytes; absent on failure     |

The source and guest lengths can differ. A raw sidecar stays raw even when its
remote ref describes compressed storage. A Codex zstd sidecar can stay compressed
or become raw through the existing pruning guard. The reason follows the actual
materialization result; telemetry does not select or change that result.

Byte values are nonnegative integer measurements bounded by the existing
128 MiB history limit. Guest bytes exclude protocol framing and are not a
partial-transfer counter. A failed guest write may have sent some bytes, but the
restore API does not expose that count, so the field is omitted. Failed local
materialization and restores from other sources do not emit these local fields.
History contents, paths, session IDs and hashes are not included.

The existing `duration_ms` covers Runner's complete guest restore await,
including transport and file publication. Host reads and materialization can
overlap sandbox preparation: `session_history_workspace_cache_restore` adds
their service time to guest restore time and is not a critical-path wall
interval. Use the remaining materialization-wait event and guest-restore event
when assessing the history contribution to startup.

## Rollout and analysis

The webhook fields are additive and optional. Old Runner payloads remain valid;
old API versions strip these unknown additions while accepting the operation.
Measurements become queryable when both the producer and receiver support them.
Missing metadata on historical events or mixed versions is unknown, not zero.
No persisted-history or database migration is required.

Group restore duration by source size, guest payload size, framework and
source/restore representation before attributing a tail to compression. Keep
failed attempts separate and distinguish already-raw sidecars from zstd expanded
for pruning. These observations do not by themselves demonstrate a compression
speedup or replace native resume, append and checkpoint validation in
[#32931](https://github.com/vm0-ai/vm0/issues/32931).

## History transfer measurements

`session_history_transfer` describes the same complete restore attempt for local
sidecars and remote/inline history, including framework validation and any Codex
cleanup on exact reuse. Its `duration_ms` overlaps the existing `session_restore`
and local guest-restore events; do not add those durations together.

Every completed attempt records a bounded `session_history_transfer_source`:
`workspace_cache`, `downloaded` or `inline`, and the effective framework. Here
`downloaded` identifies the remote-reference materializer's result, including its
cache paths; it does not prove an HTTP download occurred. A failed local restore
followed by a successful remote restore produces two records in the same run.
Keep their source and outcome separate. Materialization failures before a restore
attempt and cancelled futures do not produce this completed-attempt record.

Successful restores add these fields:

| Field                                    | Meaning                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_history_wire_codec`             | Caller-selected `none` or `zstd`, independent of stored representation                                                                                      |
| `session_history_codec_reason`           | `native_zstd`, `below_threshold`, `sample_rejected` or `sample_accepted`                                                                                    |
| `session_history_selection_ms`           | Host wall duration of the existing bounded selector, including worker scheduling and joining                                                                |
| `session_history_transfer_bytes`         | Logical guest file payload length, before optional wire compression                                                                                         |
| `session_history_restore_representation` | Logical guest payload is `raw` or `codex_zstd`                                                                                                              |
| `session_history_wire_bytes`             | Actual completed DATA payload bytes for zstd, or raw request payload bytes; excludes framing, paths, credit/control messages and replies                    |
| `session_history_write_requests`         | File requests completed by this write, including one for an empty file; excludes the publication command                                                    |
| `session_history_file_gate_wait_ms`      | Sum of Host waits to acquire the shared file-operation gate, before each request                                                                            |
| `session_history_requests_ms`            | Sum of sequential request envelopes after gate acquisition through successful terminal-result validation                                                    |
| `session_history_encoder_pipeline_ms`    | Sum of Host wall time from starting each encoder producer through its completion; includes thread setup, output backpressure, credit stalls and DATA writes |
| `session_history_publication_ms`         | Host duration of final chunked-file rename execution and completion; zero for a single-request write                                                        |

Request envelopes include source copying, admission, encoding, transport, Guest
helper startup, decode/write and terminal-response wait. They bound those costs
together; they do not isolate Guest disk I/O. Encoder pipeline duration overlaps
the request envelope and is **not encoding CPU time**. Raw requests have zero
encoder pipeline duration. The stages do not cover every framework/path-lock or
request-preparation cost, and independent millisecond rounding can lose fractions.
Do not invent a Guest-only residual or add independent percentile values.

Wire measurements are returned only after the whole file, including required
publication, succeeds. Failed attempts omit successful fields; a failure may
have transferred bytes. The mock has no wire transport and omits wire/count/stage
fields even on success. Missing values on any backend or version are unknown,
not zero. Validated local/reference histories have a 128 MiB logical ceiling,
so they use at most nine requests and 144 MiB encoded payload. The existing
inline-history contract has no equivalent reference-size ceiling. New byte/count
fields accept nonnegative/positive safe integers for both paths; they do not
impose a new inline size or request-count guard. All existing per-request limits
remain in force.

Collection adds a bounded scalar result and a few Host clock reads per request,
one byte-counter update per DATA frame and one telemetry operation per completed
restore attempt. It adds no worker, queue, lock, history copy or Guest protocol
field. It preserves the existing codec, write, cancellation and cleanup paths.
The shared request helper also reads clocks for ordinary/private writes, whose
public APIs discard these measurements.
This bounds instrumentation work but does not establish zero latency/CPU overhead.

API fields are optional. Old Runners remain accepted; old APIs strip additions.
Use containing API/Runner/artifact cohorts and report source, framework, size,
representation, success/failure and missing-field coverage before comparing
durations or compression ratios. Join existing resource and startup observations
by run ID; do not put identities or paths in metric labels. These measurements
deliver [#34789](https://github.com/vm0-ai/okou/issues/34789); current production
baselines and an optimization/no-change decision remain on
[#34728](https://github.com/vm0-ai/okou/issues/34728).
