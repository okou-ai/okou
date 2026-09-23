# Admission-lock timing

The run-creation path emits an additive, attempt-scoped timing series to the sandbox operation dataset. It does not change the organization advisory lock or any admission check. `api_dispatch_admission_lock_held` and `api_dispatch_admission_lock_wait` remain the existing aggregate series; do not add their independently aggregated percentiles.

## Attempt identity and outcomes

Join the new events by `run_id`, `commit_invocation`, and `transaction_attempt`. Both ordinal dimensions are bounded (`1`, `2`, `3`, `4_plus`). `commit_invocation` distinguishes queue-payload retry calls; `transaction_attempt` distinguishes fresh compute-ownership transactions within one call. `api_commit_sha`, `runner_group`, `profile`, and `trigger_source` identify the API cohort. A generated `run_id` can be present even when the run was not persisted: use `run_persisted` and `admission_outcome`, not the generic timing-event `success` field, to classify attempts.

`admission_outcome` is one of `pending`, `queued`, `rejected`, `thread_session_snapshot_stale`, `queue_first_claim_lost`, `queue_payload_required`, or `rolled_back`. `queue_payload_required` is an intermediate result that may be followed by another `commit_invocation`. A `rolled_back` event includes a transaction that failed after the callback returned but before commit completed. A checkout/`BEGIN` failure can produce only a transaction-setup event, with no held-time event.

## Boundaries

| `op_type`                                     | Meaning                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api_dispatch_admission_transaction_setup`    | Entry into `db.transaction` through callback start, or through failure before callback start; pre-lock context, not held time.                                                                         |
| `api_dispatch_admission_lock_leaf`            | One exclusive awaited step inside the lock, identified by `admission_leaf`. Optional steps are absent when not invoked. Existing nested timers can overlap these leaves and must not be added to them. |
| `api_dispatch_admission_lock_attempt_held`    | Lock acquisition through transaction resolution for this attempt, including commit or rollback tail.                                                                                                   |
| `api_dispatch_admission_lock_completion_tail` | Callback completion through transaction resolution.                                                                                                                                                    |
| `api_dispatch_admission_lock_residual`        | Held time not assigned to an explicit leaf or completion tail, including application gaps and timing overhead.                                                                                         |
| `api_dispatch_admission_lock_overlap`         | Amount by which measured leaves and completion exceed attempt-held time; nonzero values signal an attribution defect or clock anomaly.                                                                 |

The new durations use one monotonic clock. Leaf duration plus completion tail plus residual should equal attempt-held duration when overlap is zero. The attempt series is emitted after the transaction resolves, so an Axiom ingest call is not itself part of attempt-held time. Existing aggregate timer names and their emission paths remain compatible. For a pre-lock admission rejection, the legacy held timer still records its historical near-zero transaction tail; the new attempt-held event is absent because the organization lock was never acquired.

## Production readout

For #36257, select a fixed, non-partial window and an exact deployed API SHA/Runner version. Report the count of attempted transactions, acquired-lock attempts, final persisted runs, and each applicable leaf's coverage by branch/outcome. Compare p50/p90/p95/p99 and same-run/attempt contribution; do not sum independently aggregated percentiles. Report retries, cancellations, errors and database-pool/lock guardrails. `query_count_coverage` and `row_count_coverage` are currently `unavailable`: this series does not infer statement or affected-row counts from returned objects or add SQL to obtain them. A behavior change still requires #36257's owner and improvement gates.
