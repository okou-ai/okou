# Admission-lock timing

The run-creation path emits an attempt-scoped timing series to the sandbox operation dataset. Final admission takes no organization advisory lock: capacity is a coarse count of the org's sandbox-occupying runs, and concurrent launches may overshoot the limit. Official Workflow admission takes the credit plan before Workflow/Automation rows, matching reconciliation. The retired organization lock's aggregate `api_dispatch_admission_lock_held` and `api_dispatch_admission_lock_wait` events are no longer emitted. The attempt series below keeps its `admission_lock_*` names; its held window starts when final admission begins, after transaction setup and any Official credit-plan acquisition.

## Attempt identity and outcomes

Join the new events by `run_id`, `commit_invocation`, and `transaction_attempt`. Both ordinal dimensions are bounded (`1`, `2`, `3`, `4_plus`). `commit_invocation` distinguishes queue-payload retry calls; `transaction_attempt` distinguishes fresh compute-ownership transactions within one call. `api_commit_sha`, `runner_group`, `profile`, and `trigger_source` identify the API cohort. A generated `run_id` can be present even when the run was not persisted: use `run_persisted` and `admission_outcome`, not the generic timing-event `success` field, to classify attempts.

`admission_outcome` is one of `pending`, `queued`, `rejected`, `thread_session_snapshot_stale`, `queue_first_claim_lost`, `queue_payload_required`, or `rolled_back`. `queue_payload_required` is an intermediate result that may be followed by another `commit_invocation`. `rolled_back` covers a rejected transaction, including a failure after the callback returned but before commit completed. A checkout/`BEGIN` failure can produce only a transaction-setup event, with no held-time event.

## Boundaries

| `op_type`                                     | Meaning                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api_dispatch_admission_transaction_setup`    | Entry into `db.transaction` through callback start, or through failure before callback start; pre-lock context, not held time.                                                                   |
| `api_dispatch_admission_lock_leaf`            | One exclusive awaited admission step, identified by `admission_leaf`. Optional steps are absent when not invoked. Existing nested timers can overlap these leaves and must not be added to them. |
| `api_dispatch_admission_lock_attempt_held`    | Final admission entry through transaction resolution for this attempt, including commit or rollback tail.                                                                                        |
| `api_dispatch_admission_lock_completion_tail` | Callback completion through transaction resolution.                                                                                                                                              |
| `api_dispatch_admission_lock_residual`        | Held time not assigned to an explicit leaf or completion tail, including application gaps and timing overhead.                                                                                   |
| `api_dispatch_admission_lock_overlap`         | Amount by which measured leaves and completion exceed attempt-held time; nonzero values signal an attribution defect or clock anomaly.                                                           |

The durations use one monotonic clock. Leaf duration plus completion tail plus residual should equal attempt-held duration when overlap is zero. The attempt series is emitted after the transaction resolves, so an Axiom ingest call is not itself part of attempt-held time. The attempt-held event is absent when the transaction fails before entering final admission. Its name does not indicate that an advisory lock was acquired.

## Production readout

For #36257, select a fixed, non-partial window and an exact deployed API SHA/Runner version. Report the count of attempted transactions, attempts entering final admission, final persisted runs, and each applicable leaf's coverage by branch/outcome. Compare p50/p90/p95/p99 and same-run/attempt contribution; do not sum independently aggregated percentiles. Report retries, cancellations, errors and database-pool/lock guardrails. `query_count_coverage` and `row_count_coverage` are currently `unavailable`: this series does not infer statement or affected-row counts from returned objects or add SQL to obtain them. A behavior change still requires #36257's owner and improvement gates.
