# Chat first-output latency

This document defines the serial stages from a web chat `POST /api/chat/events`
to the run's first assistant text chunk reaching Ably, so each stage can be read
as RED (rate, errors, duration) in Axiom. It reuses the existing operation log
(`vm0-sandbox-op-log-<suffix>`), writers and ingestion. No new dataset, queue,
transport or contract field is added.

## Principles

- Stage boundaries are synchronization points: moments the request passes
  serially, with no parallel branch still on the critical path. Work that runs
  beside the path (HTTP response, event publication, heartbeats, full-message
  delivery) is never a boundary.
- Each stage's start and end are sampled by one process, so no stage compares
  two clocks. Existing `api_to_*` rows keep their documented cross-clock
  convention and are used only for the end-to-end total.
- Infrastructure (runner claim, sandbox acquisition, storage delivery and the
  hand-offs between processes) is not split into business stages. It is the
  residual of the end-to-end total minus the business stages, and can be drilled
  into with the existing runner and claim operations.
- Nested diagnostics are reported with `span_kind = nested` or as a separate
  family and are never summed with the stages.

## Stages

| Stage | Interval | `op_type` | Writer / clock |
|---|---|---|---|
| S1 accept | `POST /api/chat/events` handler | HTTP server span in `vm0-traces-<suffix>` | API |
| S2 queue wait | queued input row created → queue-head consumption (`apiStartTime`) | `api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age` | API |
| S3 run prepare | `apiStartTime` → launch transaction commit returned | `api_dispatch_phase_pre_create`, `_prepare_context`, `_prepare_launch`, `_queue_insert`, `_commit` | API, one contiguous collector |
| (infrastructure) | commit → Pi startup begins | residual; drill down with `api_to_claim`, `runner_claim_to_agent_ready` | — |
| S4 CLI boot | guest starts Pi → first projected Pi record | `pi_startup` | guest, monotonic |
| S5 first output | first projected Pi record → guest sends the first session-output chunk | `pi_first_session_output` | guest, monotonic |
| S6 publish | API receives a chunk-0 session-output request → Ably publish settles | `session_output_first_chunk_publish` | API |

End to end: `api_to_first_session_output` is recorded by the guest when it sends
the run's first chunk, with the same `apiStartTime` convention as
`api_to_cli_init`. POST to first chunk sent is S1 + S2 +
`api_to_first_session_output`; add S6 for Ably acceptance.

Infrastructure residual per run:
`api_to_first_session_output − (S3 + pi_startup + pi_first_session_output)`.

### Boundary notes

- S1 ends when the handler returns: the input is committed and the pick runs in
  `waitUntil`, beside the response.
- S2 starts at the queued input row's creation time. It can overlap S1 by the
  enqueue transaction's duration (a few milliseconds).
- S3 `api_dispatch_phase_commit` runs from the runner-job row's logical creation
  time to the launch transaction's return. Only after commit can a runner see
  the pending run; notification and runner claim then run in parallel with the
  API's remaining work.
- S4 ends at the first projected Pi record, the `system/init` built from
  `get_state`. Pi's first model request, firewall credential resolution, model
  time to first text and chunk batching are all inside S5. For S5 diagnostics,
  `firewall_auth_prepare`, `firewall_auth_resolve` and `firewall_auth_admit` are
  nested API rows.
- The Pi CLI launch path is the existing `pi_cli_launch_select` row
  (`outcome` = `installed` or `npx`); join it by `run_id` to split S4.
- S6 is recorded for every text block's chunk 0. The earliest row per run is the
  run's first chunk.

## RED in Axiom

- Rate: row count per `op_type`.
- Errors: `success == false`. `pi_startup` has a failure path;
  `pi_first_session_output` and `session_output_first_chunk_publish` report
  `success = false` when the first chunk's publication fails. A run with a stage
  row but no next-stage row stopped between them. A run that never produces
  assistant text records no S5 row; that is not an error.
- Duration: percentiles of `duration_ms` per `op_type`. Do not sum percentiles.

Supply a fixed UTC `startTime`/`endTime` in the APL request envelope:

```kusto
['vm0-sandbox-op-log-prod']
| where op_type in (
    'api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age',
    'api_dispatch_phase_pre_create', 'api_dispatch_phase_prepare_context',
    'api_dispatch_phase_prepare_launch', 'api_dispatch_phase_queue_insert',
    'api_dispatch_phase_commit',
    'pi_startup', 'pi_first_session_output', 'session_output_first_chunk_publish',
    'api_to_first_session_output')
| summarize rate = count(), errors = countif(success == false),
    p50 = percentile(duration_ms, 50), p90 = percentile(duration_ms, 90)
    by op_type
```
