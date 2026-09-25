# Billing hot-path baseline for #36891 / PR1

This is a **measurement protocol**, not a production census or approval to run one. Do not infer hard limits from a masked recent sample. Obtain separate read-only access approval, name the environment and a comparable load interval, and redact organization/member IDs and query literals from shared results. Record a complete/truncated flag for each sample, its wall-clock interval, scope, database version, source-shard count, and the exact query plan. Do not alter usage, money, indexes, timeouts or worker schedules as part of a baseline.

## Runtime observations

- `CreditUsage: usage settlement work` is emitted after the caller's money transaction commits and before postcommit delivery: `lockWaitMs` (shared compaction admission), `orgLockWaitMs`, `settlementWorkMs` (inside the settlement function, **excludes COMMIT and earlier inline managed locks**), `pendingEvents`, `pricingRows`, `affectedUsers`, `grantRows`, `expiredRows`, `expiryRows`. Row counts refer to **selected rows**, not only modified rows, and are not a SQL `EXPLAIN` physical-read count. An aborted transaction cannot be inferred from the absence of this log; lost postcommit acknowledgements can replay completion/logs. Log entries contain no org, user, run or event identifiers.
- `UsageAllowance: usage allowance availability work`: `durationMs` includes transaction COMMIT, `lockWaitMs` is the org lock acquisition, `available` only says a plan availability was returned, **not** that a later run/job was admitted. In-transaction callers are not included.
- `CronCompactUsageEvents: usage event compaction work`: `durationMs`, `lockWaitMs`, `rawSeedLimit`, `seededRawRows`, `selectedGrains`, `rawRowsDeleted`, `hourlyRowsDeleted`, `hourlyRowsInserted`, `billingErrorHeldRows`, `logicalInputRows`, `hasMore`. **`rawSeedLimit=500` is not a whole-grain cap**. These log events only cover successfully returned batches, not exceptions.

At comparable load, separately compute p50/p95/p99 and maximum for each duration, per-batch count and lock wait, plus number of missing/failed transactions and worker backlog. Use distinct time windows and note the tail's observation count; zero successful observations is **unknown**, not proof of no pending usage. Compare to before-code baseline and check both successful and failed path logs. Do not use PII or dynamic IDs as time-series dimensions. A runtime duration is not a database buffer/execution count.

## Safe read-only diagnostics (not yet executed against production)

Run with an authorized read-only role **only** on the explicitly approved environment/scope. Keep the transaction short; abort on timeout or degraded database health. For `psql`, set a literal owned `org_id` and optional UTC time bounds in a private, non-shared session, not in a log or issue comment. Bind/quote variables safely; never interpolate untrusted strings in an application shell. Example SQL is a template to adapt to that scoped session:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
-- Replace $1 and $2 with bound org_id and UTC cutoff in the client.
SELECT count(*)::bigint AS pending_events
FROM usage_event
WHERE org_id = $1 AND status = 'pending';
SELECT count(*)::bigint AS pricing_rows FROM usage_pricing;
SELECT user_id, count(*)::bigint AS spendable_grant_rows
FROM usage_pack_credit_grants
WHERE org_id = $1 AND remaining_amount > 0 AND expires_at > $2
GROUP BY user_id ORDER BY spendable_grant_rows DESC LIMIT 20;
SELECT count(*)::bigint AS expiring_rows
FROM credit_expires_record
WHERE org_id = $1 AND remaining > 0;
COMMIT;
```

The single-org counts are complete for that org **only if** all statements finish, the source/shard coverage is complete, and no worker moved rows mid-snapshot; otherwise label `truncated` or `non-snapshot` and do not use the maximum as a bound. Avoid reporting `user_id` outside the private diagnostic session; only aggregate row-count distribution with adequate privacy. `LIMIT 20` shows a **top sample**, not a complete cohort or a proved maximum. For full-population tail distributions, explicitly budget a finite pagination/inventory procedure (including hourly history) and agree on source consistency and overlap with compaction before running it. No blanket `COUNT(*)` of all organizations on a hot primary just to guess p99.

On a representative approved org, use `EXPLAIN (FORMAT JSON)` for the actual generated **read-only SELECT** pending-org, pending-event, pricing, grant, expiry and usage-record queries, with safe bound parameters and their real indexes. Explain alone is a planner estimate, not actual pages; `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executes its statement and requires separate load/timeout review even for `SELECT`. Do not run `ANALYZE` on DML/compaction SQL or claim a final `LIMIT` bounds rows scanned below a GROUP BY/JOIN. Record scanned/returned rows, sort/materialize, buffers, planning/execution time and lock waits separately.

**Period-boundary observation on current main:** `usage-record.service.ts` calls `normalizeFinalizedUsagePeriod`, which rounds both report bounds **up to the next whole hour** before filtering raw `processed_at` and hourly `processed_hour`. A raw usage event first committed after a non-hour-aligned billing-period start but before that next hour can be outside the displayed `billingPeriod`, despite its `processed_at` being within the nominal subscription period. This is observed behavior, not a proposed correction or evidence that first settlement should be backdated; the whole-hour cross-period regression fixture deliberately avoids this separate first-hour gap. PR8 must resolve whether correcting it changes a business-visible report and obtain approval before assuming that timestamp membership alone is the old API contract.

For a compaction grain tail, inspect the **exact** nullable-key grouping used by `candidateCtes` and `lockedSourceCtes` in `cron-compact-usage-events.service.ts`: processed hour, org, user, run, billing run/anchor/context, kind, provider, category, short and weekly window IDs. The selected seed may expand to every raw event and matching hourly row in that grain; `seededRawRows` alone is not a fanout measure. Use a scoped read-only grouped histogram including late arrivals and four-day retention; a top-N without a complete inventory cannot bound the maximum. For report reads include raw and hourly query plans for page and `range=all` totals at matched period/scope, and verify `processed_at` versus `processed_hour` boundaries.

## Decision gate for PR4 / PR6 / PR8

Publish actual sample size/completeness, observed tail and numerical p95/p99/lock/read budgets **after** approved measurements, then prove a chosen physical bound (including one event's grant/expiry fanout and one compaction grain). The current settlement pending SELECT has no `ORDER BY`; any new page or priority can change allowance and FEFO outcomes. If finite work, source order and exact final receipt cannot coexist with the old behavior, pause the affected slice and request a product decision. No measurement, production sweep or money correction is authorized by this runbook.
