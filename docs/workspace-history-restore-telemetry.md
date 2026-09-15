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
