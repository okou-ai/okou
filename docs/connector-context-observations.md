# Connector context observations

## Owners and versioned scopes

The shared identity context captures accounts, variables, encrypted credentials,
OAuth bindings and catalog authority without decrypting all saved accounts.
Thread derives the existing selected eager plan from those captured facts. MCP,
firewall-placeholder, model/body override, environment-reference and selected-account
rules are unchanged. SQL, admission/currentness, lease/account fences, credential
storage and runtime firewall credential resolution are unchanged by task M.

Two independent cohorts now report their actual work:

- `connector_context_schema=shared_v2`: shared snapshot query, pool acquisition,
  environment materialization and source materialization. `connectors$` no longer
  contains `builtinResolve`, `builtinDecrypt` or `builtinDecryptCount`. Shared
  observations do not emit a fabricated decrypt zero or require decrypt stages
  to be classified complete.
- `connector_context_schema=selected_eager_v1`: the claim-owned eager credential
  context captures `builtinResolve`, `builtinDecrypt` and `builtinDecryptCount`
  alongside its memoized credential result. One owned launch consumer
  (`prepareEncryptedSecrets$`) copies the completed observations into the existing
  Run collector. Preload schedules work but emits nothing. Each claim has its own
  read-only context; there is no process plaintext cache or mutable timing state.

The old `shared_v1` cohort measured all saved built-in method-owned credentials,
not the selected eager set. During L it instead omitted the two intervals and
reported a shared zero. Do not combine those cohorts with either new cohort.
Source/build SHA remains necessary for historical interpretation.

## Stage definitions

All action names have prefix `api_dispatch_prepare_context_`, `span_kind=nested`.
Original wall-clock finish timestamps and monotonic elapsed durations survive
preload: a nested record can finish before the later consuming launch phase.

| Suffix                                      | Cohort            | Boundary                                                                                                                                                                                                                                           |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_custom_connector_value_rows`          | shared_v2         | Existing remaining consumer wait for selected custom source results, including shared dependencies; not custom-only SQL or decryption. `connector_value_rows_semantics=shared_context_wait_v1` is unchanged.                                       |
| `project_custom_connector_value_rows`       | shared_v2         | Synchronous conversion of resolved custom sources to runtime rows; no query/decrypt.                                                                                                                                                               |
| `connector_context_environment_query`       | shared_v2         | Shared statement execution/results, including pool acquisition, network/driver work and decoding; excludes query-builder construction.                                                                                                             |
| `connector_context_pool_acquire`            | shared_v2         | One actual pg-pool acquisition with original finish time and idle/new/queued path; omitted for zero/multiple captures.                                                                                                                             |
| `connector_context_environment_materialize` | shared_v2         | Synchronous conversion of decoded shared statement rows.                                                                                                                                                                                           |
| `connector_context_sources_materialize`     | shared_v2         | Synchronous account/definition/source binding, after required reads resolve.                                                                                                                                                                       |
| `connector_context_builtin_resolve`         | selected_eager_v1 | Envelope from requesting the selected encrypted rows/eager plan until the eager context finishes decryption. Includes prerequisite plan/model/permission/source waits and the decrypt interval; not a DB-only duration or remaining consumer wait. |
| `connector_context_builtin_decrypt`         | selected_eager_v1 | Actual concurrent per-credential `decryptStoredSecretValue`/settle envelope, excluding the preceding selection/plan wait. Empty eager sets are still timed.                                                                                        |

Resolve includes decrypt: never sum these overlapping durations or subtract
preloaded intervals wholesale from startup. Query minus acquisition is a
post-acquisition residual (network, driver, decoding and scheduling), not measured
server CPU. Counts and intervals do not authorize deleting a current-state fence.

## Counts and privacy

Shared numeric facts remain captured plain values. Shared records retain existing
finite account, custom-account, returned-row, stored-value, requested-custom and
candidate-custom count buckets (`0 / 1 / 2_4 / 5_8 / 9_16 / 17_plus`). These are
identity-snapshot counts, not final selected account counts.

Selected eager records include:

- `connector_context_builtin_decrypt_count`: numeric metric copied from
  `builtinDecryptCount`, the number of uniquely keyed selected credential attempts,
  including settled failures. It is not a string label, success count or total Run
  KMS HTTP-call count. A malformed envelope can fail before issuing KMS; other Run
  operations can issue KMS independently.
- `connector_context_builtin_decrypt_count_bucket`: the same finite count buckets
  for bounded grouping.
- `connector_context_observation=complete/partial`: presence of both completed
  eager intervals. Missing diagnostics are not interpreted as zero latency.
- Existing finite connector-scope/count dimensions from the selected plan.

Shared complete/partial/missing covers its three shared intervals only. Pool
coverage stays independently single/missing/multiple. No new raw identity,
connector/account/secret name/value, SQL/parameter, exception text, user content,
provider label or byte payload is recorded. Optional capture/record failures omit
diagnostics; required source reads, selected results and original errors are never
caught or replaced. Numeric metrics are carried separately from bounded string
dimensions by the existing timing collector and flattened by the existing ingest.

## Presence, failure and consumer boundary

- A successfully consumed run with no eligible eager credentials reports both
  selected intervals and count zero. This is not evidence of zero total Run KMS.
- Mixed eager/deferred connectors report only selected eager credential attempts;
  runtime-only and unselected accounts do not inflate the selected count.
- Preload and both launch consumers share the same memoized credential result.
  Only the encrypted-secret consumer records selected intervals, avoiding duplicates.
- Selected credential failures remain per-item settled, then propagate when the
  consumer needs that selected credential. Unselected bad accounts remain isolated.
- A failed/rejected/unconsumed launch can have no selected observation pair. The
  successful-consumer denominator is not a census of all attempted decrypts.
- Optional capture failure can leave partial/absent records. Sink failure can omit
  records entirely without changing the required launch outcome.

There are at most two selected eager records per consuming Run, in addition to
shared records. No new SQL, query, connection, worker, sampling loop, timer or
unbounded retained collection is introduced.

## Consumer and query migration inventory

Repository search finds the producer/type in `agent-run-context.signals.ts`,
shared and selected recording in `thread-claim-run.service.ts`, action-name
inventory in `api-dispatch-timing.service.ts`, and this guide. No checked-in Axiom
panel definition or dashboard query consumes the builtin fields.

Saved/external queries that select the two existing builtin action names or
`connector_context_builtin_decrypt_count_bucket`, or require five shared stages
for `connector_context_observation=complete`, must change:

1. Group shared work by `shared_v2`; require query/materialize/sources (pool separate).
2. Filter builtin intervals/counts to `selected_eager_v1`; use the numeric count
   metric for exact attempt comparisons and the bucket for cohort grouping.
3. Join only by existing Run correlation and exact API SHA; maintain separate
   coverage denominators, reject duplicates, and retain original finish times.
4. Do not backfill a missing builtin metric on shared records as zero, mix the
   pre-L all-account workload with selected eager, or sum resolve and decrypt.

Axiom dashboard inventory was attempted read-only. Okou permission diagnosis
allows `dashboards|read`, but the provider token returned HTTP 403 (`token does not
have access to resource: dashboards with action: read`). External dashboard
inventory is therefore **unverified**, not an assertion that no such panels exist.
No dashboard/provider configuration was changed.

## Verification

Logger-owned transport tests in `lib/__tests__/log-axiom-transport.test.ts` construct
N=0/1/2 scenarios through production connect/send/Runner claim endpoints. At the
existing mocked external SDK ingest boundary they compare the numeric observation
with actual external KMS decrypt calls, require both completed finite intervals,
and reject shared decrypt fields. This is the documented logger-owner exception;
ordinary API route tests still assert HTTP/Runner/firewall outcomes, not logs.
No production test hook, logger mock bypass or lint exception is added.

Deployed acceptance uses fixed finite UTC Axiom windows, exact serving SHA, complete
query responses, completed new-thread/continuation outputs, and explicit stage/count,
KMS and SQL evidence. Preview mock execution with synthetic credentials does not
prove real provider actions, production rollout or production latency improvement.
