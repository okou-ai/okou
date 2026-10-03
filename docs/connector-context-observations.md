# Shared Connector context observations

Issues [#37628](https://github.com/okou-ai/okou/issues/37628) and parent
[#37627](https://github.com/okou-ai/okou/issues/37627) add attribution only. They
change no SQL, preload order, account selection, authorization/currentness,
credential storage/decryption, retry/cancellation, launch fence or pool setting.
They do not authorize merge, deployment, credential caching or an optimization.

## Current owner and scopes

`agent-run-context.signals.ts::createAgentEnvironment` executes one statement
for the member's accounts, variables, encrypted credentials and OAuth bindings.
Agent `environment$` shares it. Source materialization additionally awaits
custom definitions; builtin credential resolution additionally awaits the
catalog. Individual builtin decryption failures remain settled until their
selected method/account consumes them. Custom runtime credential handling is
unchanged.

The context carries plain read-only numeric observations with its existing
computed result, not a timing collector, command/state, DB handle, new computed
node or process credential cache. Preload emits nothing. Thread copies the
completed observations into its existing Run collector, retaining their
original wall-clock finish times. Nothing is added to public/Runner payloads.

The existing `api_dispatch_prepare_context_load_custom_connector_value_rows`
retains its original boundaries: remaining wait for the selected custom source
results. Those depend on shared `connectors$`, account candidates and scope.
This is **not custom-only SQL duration**, and it excludes the subsequent
runtime-row projection. New records identify these semantics with
`connector_value_rows_semantics=shared_context_wait_v1` and
`connector_context_schema=shared_v1`. Never compare mixed legacy/new versions as
if that name identified one unchanged implementation.

## Stages

All names below have the prefix `api_dispatch_prepare_context_` and
`span_kind=nested`. A nested label does not imply interval containment: early
preload can finish before the consumer wait or even before `api_to_spawn` starts.

| Suffix                                      | Actual boundary                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_custom_connector_value_rows`          | Existing remaining source-consumer wait, including account/scope/shared dependencies.                                                                                                                               |
| `project_custom_connector_value_rows`       | Synchronous conversion of the resolved available custom sources to runtime rows; no query/decrypt.                                                                                                                  |
| `connector_context_environment_query`       | Awaited execution/results envelope of the unchanged shared statement, including pool acquisition, statement/network/driver work and Drizzle decoding. Query-builder construction is outside this interval.          |
| `connector_context_pool_acquire`            | Actual pg-pool connect callback duration, with its actual callback finish time and `idle/new/queued` classification. Only emitted for exactly one captured acquisition.                                             |
| `connector_context_environment_materialize` | Synchronous conversion of decoded statement rows into accounts, variables and encrypted credential values.                                                                                                          |
| `connector_context_sources_materialize`     | Synchronous account/definition binding and source-snapshot construction, after environment and definitions resolve. It does not measure the prior definition wait.                                                  |
| `connector_context_builtin_resolve`         | Builtin credential computed envelope, including waiting for shared source snapshots/catalog and the decrypt function.                                                                                               |
| `connector_context_builtin_decrypt`         | Invocation of the existing builtin method-owned credential selection/decryption function, excluding its prior source/catalog wait. The count bucket can be zero: an empty invocation is not evidence of a KMS call. |

The query, environment and source costs cover **all identity-scoped saved
accounts**, including unused/unavailable builtin/custom accounts, and Agent
variables. They are not costs of only the selected custom connectors. The
builtin stages are shared prerequisites, not custom credential decryption.
Definition/catalog/account/scope waits are not individually partitioned here;
retain an unattributed dependency/scheduling remainder rather than declaring it
measured DB wait. Existing catalog/selection telemetry and bounded OTel traces
may support a separately scoped investigation.

Query duration minus the one measured acquisition is a **post-acquisition
residual**, not measured server execution. It includes network, driver, decoding
and scheduling. Acquisition includes connection setup or queued/idle delivery,
not solely pool saturation. Do not infer server CPU, row transfer bytes or a
removable current-state read from either number.

## Bounded dimensions and privacy

In addition to existing Run correlation, exact API build marker, process-age,
Runner group/profile and source tags, the new dimensions are only:

- `connector_context_schema`: `shared_v1`.
- `connector_value_rows_semantics`: `shared_context_wait_v1`.
- `connector_scope_source`: the existing finite Connector scope source.
- `connector_context_observation`: `complete`, `partial` or `missing` for the
  five shared operation intervals (pool coverage is separate).
- `connector_context_pool_capture`: `single`, `missing` or `multiple`.
- `connector_context_pool_acquire_path`: `idle`, `new` or `queued`, only on the
  acquisition record.
- Count buckets with prefix `connector_context_` and suffix `_count_bucket`:
  `requested_custom`, `candidate_custom`, `returned_row`, `account`,
  `custom_account`, `stored_value` and `builtin_decrypt`.

Every count uses the existing `0 / 1 / 2_4 / 5_8 / 9_16 / 17_plus` buckets.
Requested custom counts are scope definitions; candidate custom counts are the
matching saved source results before final per-definition account admission,
including unavailable results. Neither is the final selected account count.
Shared counts describe returned SQL rows, saved accounts, custom saved accounts,
and connector variable/credential entries before declared-field filtering.
Builtin decrypt count is the number of uniquely keyed settled credential results,
not successes. No exact count is emitted.

No new raw org/user/Agent/connector/account/secret ID, credential name/value,
SQL/parameter text, exception content, user content, provider label, byte payload
or dynamic dimension is logged. Existing OTel SQL tracing is not widened or
copied into these records. Optional metadata construction/recording failures
omit diagnostics; required reads, mappings and decrypt results/errors are not
caught or replaced. The pool callback still delivers its original client/error
if the optional capture write fails.

## Presence and absence

This contract applies when Thread actually consumes and successfully resolves
`runCustomConnectorStoredRows$`; it is not a census of all attempted starts.

| Case                                                                             | Expected observations                                                                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No accounts, no allowed custom definitions                                       | Wait/projection and all five shared intervals; account/custom/value/decrypt buckets are zero. The aggregate SQL still returns an empty-account row.   |
| Builtin-only or custom-only scope                                                | Same stages; full saved-account counts may include the other kind. Empty builtin decrypt is still timed with a zero count.                            |
| Mixed scope or unused saved accounts                                             | Same stages; shared counts include all saved accounts, while candidate/requested custom buckets describe the consuming scope.                         |
| Unavailable/reconnect/incompatible custom account                                | Same completed shared stages if the required read succeeds; final admission/omission remains the existing behavior. Counts do not grant availability. |
| Matching preload finished early                                                  | Original captured shared intervals plus the remaining consumer wait; no reread. Early shared durations may be entirely off the startup critical path. |
| Later-request/mismatched context                                                 | Same factory, statement and stage definitions, with that request's own captured intervals; no backfill from another context.                          |
| Zero or multiple pool captures                                                   | Query and other intervals remain; no pool record is fabricated/combined. `pool_capture` identifies missing/multiple coverage.                         |
| Optional metadata interval failure                                               | Missing interval or shared observation, with `partial/missing` where the outer record is retained. Sink failure can omit records entirely.            |
| Required read/definition/catalog/source failure or a rejected/unconsumed preload | No completed shared result is emitted by this path. Do not interpret absent records as zero latency or count them as successful starts.               |

Per completed consuming Run there are at most seven new records: five shared
operation intervals, one exact acquisition and one projection. Capture adds one
async-local scope around the existing query, small request-only numeric objects,
and a linear custom-account count over an already materialized array; no SQL,
connection, worker, sampling loop or unbounded retained collection is added.
Actual production overhead/resource guardrails remain a deployment follow-up.

## Parent readout and decision gate

1. Verify the exact serving API markers after separately authorized deployment;
   merge/release is not deployment. Dispatch API SHA/process-age identifies the
   dispatch process, not necessarily the later Runner-claim API binary. Confirm
   the Runner release independently from Runner startup records.
2. Select a fixed event-time startup window and record query/read time and
   partial-result status. Allow a documented bounded lookback for preload
   records that finish before the startup window. Join only by `run_id` and
   report observed startup denominators, missing/duplicate/partial/out-of-window
   stages, invalid durations/timestamps and late-ingestion limits. Do not
   deduplicate arbitrary repeated records into a complete observation.
3. Stratify exact API/Runner cohorts, startup path, API process-age bucket,
   source/scope and shared/requested/candidate count buckets. Report nearest-rank
   per-Run p50/p90/p95/p99 (`ceil(p * n)`, one-based), <=1 second and sample sizes.
   Shared stages with zero eligible decrypts are their own workload class.
4. Infer an interval from each original finish time and duration. Account for
   millisecond timestamp precision/clock discontinuities. Verify one measured
   acquisition lies within its query before deriving a nonnegative residual;
   inconsistent samples are invalid coverage, not clamped evidence.
5. Intersect each candidate interval with both the actual remaining consumer
   wait and startup interval. Early/parallel/nested work cannot be subtracted
   wholesale. Build counterfactuals per Run before aggregating, subtracting only
   a justified non-overlapping intersection and labeling impossible complete
   removal as an optimistic bound, never predicted savings. Do not sum nested
   percentiles or treat shared builtin/Agent work as custom-only cost.
6. Independently inspect failed starts, retries, cancellation, credential/auth
   outcomes and CPU/memory/database/pool connections/queue pressure. Successful
   Run spans alone cannot establish these rates or a safe behavior change.
7. Retain #37627/#24203 until their own gates pass. Only reproducible safe
   removable/overlap-able critical-path leverage justifies a separately
   authorized behavior slice. Otherwise record a no-change decision. No arbitrary
   minimum-ms threshold, production explain/analyze or credential skip/cache is
   authorized by this instrumentation.

API tests cover public send/Run/Runner outcomes and relevant credential/account
safety, not logger output or internal callback counts. The pool-instrumentation
suite owns the infrastructure capture contract (including a non-recording
tracer and a failed diagnostic write), which a production endpoint cannot
configure. Static stage/dimension/consumer review verifies the source contract;
actual emitted presence/absence is an explicit post-deployment gate, not a local
log-test or source-level improvement claim.
