# Pi preparation timing

This is the instrumentation runbook for [#33730](https://github.com/vm0-ai/vm0/issues/33730),
the first slice of [#33703](https://github.com/vm0-ai/vm0/issues/33703).
It measures existing work; it is not a latency optimization or production
acceptance result. The historical English DeepSeek V4 Flash cohort averaged
639.6 ms before transport, including an unattributed 63.8 ms between KMS and
the ownership transaction. Neither interval is established as SDK CPU time.

## Delivery and fields

The API adapter in
[`pi-preparation-timing.service.ts`](../turbo/apps/api/src/signals/services/pi-preparation-timing.service.ts)
uses the existing sandbox-operation writer and its `waitUntil` ownership.
Each actually started phase emits one completion observation to
`vm0-sandbox-op-log-prod`, including work that finishes after attempt cancellation.
There is no new telemetry queue, timer, cancellation listener, provider owner,
network await before transport, or change to session disposal. Delivery remains
best effort; missing telemetry is not a zero-duration phase or proof of success.

The optional synchronous observer and fixed phase vocabulary live in
[`preparation-timing.ts`](../turbo/packages/pi-agent-runtime/src/preparation-timing.ts).
Its clock/measurement helpers are exported through the runtime `/api` entry for
the API preparation owner as well. They contain no API service or transport
dependency. Observer exceptions are contained; the original result/error and
existing cancellation/recovery owner remain authoritative. The observation
signal only labels completion; it does not add cancellation to SDK bootstrap.

| Field                                  | Meaning                                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op_type`                              | `pi_prepare_` followed by one phase below; never a resource name.                                                                                                                        |
| `duration_ms`                          | Monotonic `performance.now()` difference around executable work.                                                                                                                         |
| `started_at`, `finished_at`            | Separately sampled UTC wall boundaries; use for correlation, not as a replacement for monotonic duration.                                                                                |
| `_time`                                | `finished_at`, not ingestion time.                                                                                                                                                       |
| `outcome`                              | `success` when work returned, `error` when it threw, or `cancelled` when its existing signal was aborted at completion. Canonical cancellation at the provider gate is also `cancelled`. |
| `success`                              | Whether `outcome` is `success`; a preparation success does not assert run success or that transport started.                                                                             |
| `run_id`, `trace_id`, `api_commit_sha` | Captured run, active API trace when available, normalized build revision when configured. Missing trace/revision fails a production correlation claim.                                   |
| `source`, `sandbox_type`, `span_kind`  | `api`, `runner`, `nested`, matching the existing operation pipeline.                                                                                                                     |

No prompt/history, credentials, signed URLs, raw errors, resource identifiers,
per-resource events, or arbitrary labels enter these observations. Existing
dispatch process-age/ordinal buckets and catalog/snapshot cache dimensions remain
on their original records; join them by run and preparation occurrence rather
than creating another dispatch ordinal or inferring that the process was warm.

## Executable boundaries and nesting

The phase names below omit the common `pi_prepare_` prefix.

| Phase                                         | Exact work / parent                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`                                      | `preparePiLaunchResources` around the existing measured launch body. Covers the same work as legacy `api_dispatch_prepare_pi_launch_resources`; never add both.                                         |
| `launch_resume`                               | `resolveLatestPiResumeSession`; child of `launch` and the legacy resume measurement. Absent for maintenance.                                                                                            |
| `launch_memory`                               | `resolvePiMemoryRecall` with captured mounts and versions; child of `launch`. Absent for maintenance.                                                                                                   |
| `launch_manifest_sign`, `launch_session_sign` | The two existing `generatePresignedGetUrl` reads, still in the same `Promise.all`; overlapping children of `launch`.                                                                                    |
| `launch_identity`                             | Resource digest, base-session identity, deadline and unchanged final launch-object assembly; synchronous child of `launch`.                                                                             |
| `h0_metadata_preflight`                       | `readResumeSessionMetadata` for blob-backed history in `publishLargeHistoryTransfer$`, before API resource loading. Absent for new or inline sessions.                                                  |
| `resource_snapshot`                           | API `loadApiFirstTurnResource$`, including validation. Existing `pi_resource_snapshot_prepare` is nested and supplies cache/index dimensions.                                                           |
| `credentials_route`                           | Route normalization and `apiFirstTurnModelConfig`: subscription lookup or decryption, credential resolution and direct-route materialization. KMS HTTP is a nested transport span, not the whole phase. |
| `h0_load`                                     | `loadResumeSessionJsonl$`; no-resume legitimately returns without a blob request.                                                                                                                       |
| `h0_validate_materialize`                     | `validateResumeSession` then `materializeApiFirstTurnH0`; synchronous API history authentication/materialization.                                                                                       |
| `history`                                     | Runtime `MemoryPiSession` parsing/creation and launch-session ID validation, before SDK shell creation.                                                                                                 |
| `runtime_initialize`                          | `createPiAgentSessionForRuntime`, including its in-memory SessionManager argument; parent of the following runtime initialization phases.                                                               |
| `resources_prompt`                            | Registry initialization, memory recall, memory tool metadata, harness/append prompt preparation, resource options and catalog model resolution, in their original order.                                |
| `model_runtime`                               | `createPiModelRuntime` and explicit credential-store argument: fixed SDK bootstrap and provider registration.                                                                                           |
| `session_services`                            | `createAgentSessionServices`, including its settings/resource-loader arguments.                                                                                                                         |
| `resource_loader`                             | `piPreheatedResourceLoaderOptions`; synchronous child of `session_services`, after ModelRuntime as before.                                                                                              |
| `session_create`                              | `createAgentSessionFromServices`, including thinking-level/tool arguments.                                                                                                                              |
| `session_finalize`                            | Existing configured-thinking-level recording after SDK session creation.                                                                                                                                |
| `compaction_preflight`                        | `assertPiApiFirstTurnCompactionSafe` and compaction settings read, after the shell is ready.                                                                                                            |
| `model_context`                               | Native history preparation, user-message append, context build and conversion to model messages/tools, before the durable provider gate.                                                                |
| `provider_boundary`                           | Start of `withApiFirstTurnLifecycle` through transaction return/throw, including lock, eligibility, active input and ownership marking. **Not HTTP transport start.**                                   |

An interrupted `Promise.all` can return before a sibling settles. Its late child
retains its own actual finish/outcome even if it extends beyond the failed
parent; no extra joining, replay or error-precedence change is introduced.
Prepared work may end as `cancelled` even when an uncooperative dependency
eventually returns. Phases skipped by native-input/large-history transfer or
earlier failures have no fabricated observations.

Reconstruct serial boundaries rather than summing every row. In particular,
exclude the runtime children when counting `runtime_initialize`, exclude
`resource_loader` when counting `session_services`, and take the union of URL
signing intervals rather than their sum. Leave measured gaps visible, including
observer/adapter overhead. Wall time has millisecond resolution and may move;
do not silently clamp or reinterpret it as monotonic CPU time.

## Admission, activation and actual transport

[`committedAtomicLaunchResponse`](../turbo/apps/api/src/signals/services/agent-run-create.service.ts)
still checkpoints `api_dispatch_phase_queue_insert` at `runnerJobCreatedAt`, the
logical row creation time. It is not commit completion. Existing `api_to_*`,
first-assistant publication and dispatch phase definitions are unchanged.

[`runner-dispatch.service.ts`](../turbo/apps/api/src/signals/services/runner-dispatch.service.ts)
already reports cumulative `runner_notification_queue_to_commit_return`,
`...activation_scheduled`, `...activation_entry`, `...same_thread_markers_complete`
and `...database_ready`. Their `duration_ms` remains the legacy wall elapsed
time from logical runner-job creation, and `_time` remains delivery time. The
additive `logical_queue_created_at` and `boundary_at` fields expose their exact
endpoints. Subtract cumulative values or compare `boundary_at`; do not sum them.
The same fields cover `activation_origin=direct` and `promotion`.

Direct commit return is sampled immediately after `db.transaction` returns.
Promotion samples it in `finalizePromoteQueuedCandidate` after its transaction.
Activation entry is sampled on entry to `activatePendingRun$`. The API turn is
started between same-thread markers and database-ready, while Runner notification
continues independently; notification completion is not the API-turn start.
These milestone rows are delivered after notification work and can be missing
when that existing path fails; a reached milestone is not a notification-success
claim. Initially queued admission is distinct from the later promotion commit.

For actual provider request start, use the existing HTTP client span from
`vm0-traces-prod`, linked by `trace_id` and the recorded wall interval. For the
fixed direct DeepSeek fixture, select the first request to
`https://api.deepseek.com/responses` after `provider_boundary` returns. Inspect
the dataset's current field metadata before selecting HTTP destination/start
fields. Project only span ID, trace ID, start/end or duration, status and API
service revision; do not export headers, bodies, or arbitrary URL fields.
Verify exactly one matching request and the deployed revision. The remaining
boundary-return-to-HTTP-start interval includes request construction/scheduling;
do not label it ownership time or infer it when the transport span is absent.
An HTTP client span marks the instrumented request start, not first byte on the
wire, provider TTFT, or completion of a streamed response.

## Bounded production acceptance

Controller acceptance is separate from implementation merge. Verify a deployed
API revision containing this PR before collecting the exact English fixture in
#33703, with the same agent, DeepSeek V4 Flash route, normal priority, chat-send
transport and reported reasoning configuration. Keep all attempts, failures and
extra outputs. This PR neither runs the fixture nor releases production.

Supply the fixture's exact run IDs and a fixed UTC `startTime`/`endTime` in the
APL request envelope. The following metadata-only query selects observations
and the existing cache/process/milestone context without reading run contents:

```kusto
['vm0-sandbox-op-log-prod']
| where run_id in ('FIXTURE_RUN_1', 'FIXTURE_RUN_2', 'FIXTURE_RUN_3', 'FIXTURE_RUN_4', 'FIXTURE_RUN_5')
| where op_type startswith 'pi_prepare_'
    or op_type startswith 'api_dispatch_phase_'
    or op_type startswith 'api_dispatch_prepare_pi_launch_'
    or op_type startswith 'api_dispatch_connector_catalog_'
    or op_type startswith 'runner_notification_queue_to_'
    or op_type == 'pi_resource_snapshot_prepare'
| project _time, run_id, op_type, duration_ms, success, outcome,
    started_at, finished_at, trace_id, api_commit_sha,
    logical_queue_created_at, boundary_at, activation_origin,
    api_process_age_bucket, api_process_dispatch_ordinal_bucket,
    cache_hit, cache_lookup_ms,
    connector_catalog_projection_cache_outcome,
    connector_catalog_projection_cache_observation
| sort by run_id asc, _time asc
| limit 1000
```

Check the response's completeness/truncation metadata and row count. Narrow the
window or split the explicitly named runs if the cap is reached. Use the
catalog's bounded cache-outcome and observation fields when forming matched
cohorts, without exporting catalog data.
Do not equate a full snapshot hit with a catalog hit or a warm API process.

For each complete attempt, verify revision and trace linkage, map each observed
phase to this table, correlate actual provider start, and reconcile the serial
preparation interval without double counting. Include cancellation/error and
missing-telemetry counts. Production observation, overhead measurement and a
larger matched comparison remain controller work; a historical five-run mean
does not establish a new p95/p99 or expected speedup.
