# Recoverable chat usage projection (#36951)

`usage.recorded` is a presentation of committed usage, not the charge or its receipt. The financial settlement retains its existing whole-transaction semantics and synchronous result. It does not query chat tables, snapshots, or R2. In the same transaction that processes pending usage, it upserts a content-free `usage_chat_projection_work` row for each **distinct non-null run ID** in that settlement. The row has only the run FK, monotonically increasing desired/applied revisions, due/lease times and bounded failure metadata (error **type**, not message); it is neither a pricing snapshot nor a user/org attribution record. One run can contain charges from different owners. A run deletion cascades the row; a deleted thread with a surviving run is discarded by the content consumer without restoring content.

The chat-owned consumer uses short leases and at most 10 claims per one-minute `process-background-jobs` cron. Each claim reads the canonical finalized raw+hourly usage and the current thread/history via the existing per-run card serialization. A nonterminal or pending run is deferred; a later terminal callback may emit immediately, but a callback is not required for eventual redrive. An unchanged card is acknowledged without another append; a later settlement increments desired revision and reopens the obligation. The worker acknowledges only the revision it claimed, with the current lease still valid. A newer financial commit stays pending if it races projection. A fully acknowledged row is deleted in the same chat-owned transaction, so later usage starts a new revision epoch rather than retaining a per-run tombstone. If the chat append committed but the worker died before acknowledgement, replay compares the visible payload, schedules a best-effort client catch-up notification, and acknowledges it without a duplicate card. Realtime transport itself is not a durable delivery guarantee; a missed notification can still require a client refresh. Failure retains work with exponential backoff (1–60 minutes) and a class-only error. The postcommit fast path may improve latency, but is not the durability mechanism. Financial receipts do not depend on projection or its external I/O.

## Rollout and rollback

1. Apply the **additive** table migration before deploying API code that enqueues it. Old API versions ignore the table and keep their direct postcommit emitter. New workers and old direct writers use the existing per-run card lock/compare, so overlap must not duplicate a visible card. An old API's settlement cannot write the new work record: do not claim a crash-recovery guarantee for its commits while old writers serve traffic. No historical backfill is included; inspect and reconcile pre-cutover missing cards separately before claiming full coverage.
2. Deploy API/worker only after the migration is live. A rollback to a version with the old emitter leaves content-free work rows in place for a later new-version worker; never drop the table until the rollback floor and outstanding obligations are resolved. Do not interpret a missed postcommit callback or an empty successful telemetry window as proof there is no backlog.
3. This PR does not authorize production deployment, database backfill, financial adjustments, retries of unknown upstream effects or merging. Observe the new `api_billing_projection_outbox_write` timing and distinct `projection_runs` dimension using the [billing baseline](billing-hot-path-baseline.md). An already-unbounded pending settlement is not made bounded by this PR; compare the new single set-based outbox write against the baseline and coordinate a proven batch bound with #36956. Never silently omit work from a committed charge.

## Operational inspection (requires separate read-only production authorization)

A query on a separately approved database/scope can count the due and retrying work; it must not be mistaken for a complete error census or a financial ledger. Read only with a short timeout and retain no run IDs in shared results. The worker logs failed attempts and stores `failure_count`, `last_error` class, `created_at`, `updated_at`, and `available_at`; an unacknowledged row is always eligible again when its due/lease deadline passes. An idle/failing cron is not an SLA guarantee. Alerting policy should use oldest unacknowledged age, count by failure range and cron health, not just successful job count. No automated money correction or stale work deletion is permitted on this signal.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT count(*)::bigint AS unacknowledged,
       min(created_at) AS oldest_obligation,
       max(failure_count) AS max_failure_count
FROM usage_chat_projection_work
WHERE applied_revision < desired_revision;
COMMIT;
```

The example is a template, **not** permission for a production full-table query; size/plan and a bounded scope must be reviewed before running. The due index covers `available_at, run_id` for unacknowledged rows. Completed rows are deleted immediately; outstanding rows also cascade with run erasure. They contain no prompts, thread titles, object keys or response bodies.
