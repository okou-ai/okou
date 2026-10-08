# Billing attribution foundation (A1)

> The Allowance-specific readers, window grains and archive references in this
> historical A1 record are superseded by
> [organization Usage Allowance retirement](../deployment-compatibility.md#organization-usage-allowance-retired).
> Migration 1347 deletes team-only Allowance history; current attribution keeps
> ordinary usage identities and recorded credits, without Allowance tables.

Issue [#33851](https://github.com/vm0-ai/vm0/issues/33851), parent
[#33745](https://github.com/vm0-ai/vm0/issues/33745). This is additive preparation.
No billing reader, pricing, allowance decision, recharge, subscription policy,
Clerk cleanup, or production retention behavior switches in this change.

## Persisted contract

`billing_run_attribution` stores one original run UUID, billed organization/user
IDs, original `agent_runs.created_at`, and the bounded usage-view source. It has
no FK to content, users, agents, sessions, or threads. Since Advisory Lock
Cleanup R1 (migration `1310_retire_application_billing_capture_triggers`) no
database trigger captures it: the pending launch persistence
(`persistPendingAtomicLaunch` in `thread-claim-run.service.ts` for the Thread
pick, and the Pi maintenance pending and failed-launch records in
`pi-memory-maintenance-execution.service.ts`) write it explicitly with
`billingRunAttributionWrite` in the same launch transaction, so failed run
creation rolls it back. Matching retries are idempotent; the conflict update only
applies when org/user/start/source match and only fills an `unknown` thread
identity, and a mismatch is rejected by the writer. Immutability is a writer
contract, not a database guard: the mutation-guard trigger was retired by
migration `1306_retire_billing_attribution_mutation_guard`, and every supported
writer uses these conditional predicates. `usage_observed` is only set from false
to true by the writer that commits a raw/rollup insertion or backfilled linkage;
no writer clears it. The source classifier (`billingSource`) follows
`usage-record.service.ts`: web -> chat; schedule/event -> automation;
slack/teams/telegram/email/agentphone/github/agent pass through; otherwise other.
The historical null trigger source is other, without copying trigger payloads.

Raw and hourly usage independently store `billing_run_id`, `billing_anchor_at`,
and `billing_context`. The ID is deliberately not a content FK; an unavailable
canonical source remains reportable rather than being deleted or fabricated:

| Context            | Identity and time                              | Meaning                                                                      |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `run`              | Original run ID and verified run creation time | Canonical billing row agrees with billed org/user and anchor.                |
| `pi_memory_stage1` | No run ID; original model event creation time  | Explicit built-in Pi memory extraction; see the D contract below.            |
| `runless`          | No run ID; original event creation time        | A producer explicitly knows the operation had no run.                        |
| `missing_run`      | Original run ID, no anchor                     | A supplied run identity has no surviving verified source.                    |
| `legacy_unknown`   | Neither                                        | Historical NULL association or legacy producer with insufficient provenance. |

Each raw usage producer explicitly writes these fields, captures a missing
canonical attribution for its live run and marks observation in its own
publication transaction; no trigger fills omitted fields, so direct SQL that
omits them stays `legacy_unknown`. Capture never changes quantity, credits,
idempotency key, status, processing time, or settlement. Processing updates and
FK `SET NULL` do not rewrite billing identity. A managed call
retains its supplied run identity even when its existing live-run lookup misses.
This does not change the existing allowance fallback in A1.

Generation jobs explicitly write their original identity/runless classification
in their own INSERT and pass it through provider callbacks. Those two job
columns follow the **job's ordinary non-billing deletion lifecycle**, not ledger
retention. Old jobs without a live run remain unknown. A runless usage anchor is
the event time, not job creation, compaction, backfill, or callback-processing time
invented for a run that once existed.

## Writer and consumer inventory

Foundation inventory verified on base `fa2e6e6212dee848c8d37d72551cc5d9b7887ac4`
and updated for Advisory Lock Cleanup R1, which replaced every capture trigger
with explicit writer SQL. The Stage 1 row is updated by #34267. The detailed
current trace is the
[R1 billing writer trace](../advisory-lock-release-1-billing-trigger-writers.md).

| Production writer                                                           | Explicit capture / provenance                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread-claim-run.service.ts`, `pi-memory-maintenance-execution.service.ts` | `billingRunAttributionWrite` in the launch transaction (Thread pending launch, Pi pending and failed launch); includes canonical launch CTE. |
| `managed-usage.service.ts`                                                  | Captures canonical attribution, writes raw fields and observation; explicit runless when actor has no run.                                   |
| `provider-usage-publication.service.ts`                                     | Runner, OpenRouter and image-result usage capture identity, insert categories and mark observation together.                                 |
| `pi-memory-stage1-usage.service.ts`                                         | Explicit `pi_memory_stage1`; existing deterministic category keys and billing semantics.                                                     |
| `x-resource-usage.service.ts`                                               | Capture, resource claims, final quantities and observation share the local transaction.                                                      |
| `built-in-generation.service.ts`                                            | Job INSERT supplies original billing Run ID and context; webhook job projections include independent identity.                               |
| `cron-compact-usage-events.service.ts`                                      | Explicitly resolves legacy/missing identities, publishes hourly rows with billing fields and marks observation in the same batch.            |

`src/test-fixtures`, `routes/test-*`, `__tests__`, `__benches__`, and
`src/scripts/dev-bench-seed.ts` are fixtures/benchmarks, not production usage
writers. Fixture Run inserts write attribution explicitly as production does.
Intentional legacy fixture inserts that omit new fields remain supported.

Consumers were deliberately unchanged in A1: `credit-usage.service.ts`,
`usage-allowance.service.ts`, `usage-record.service.ts`,
`finalized-usage-relation.ts`, `usage.service.ts`, `usage-event-cleanup.service.ts`,
and `webhooks-clerk-cleanup.service.ts`. [Billing reads](#billing-reads-d3)
switches the first four onto these fields.

## Billing reads (D3)

Issue [#35875](https://github.com/okou-ai/okou/issues/35875). Billing readers no
longer require a live `agent_runs` or `chat_threads` row to produce a bill.

`billing_run_attribution` adds `thread_id` and `thread_context`
(`thread` / `threadless` / `unknown`). `thread_id` is a grouping identifier, not
content: the reader resolves the **live** `chat_threads` row for the displayed
title and for the decision to group by thread at all, so deleting a thread still
collapses its usage into the threadless row exactly as the `agent_runs`
`ON DELETE SET NULL` link did. `unknown` means "not captured yet" and is distinct
from a run that genuinely had no thread. Capture is monotone: the run insertion
writers, the usage-side capture for an older live run, and the operator backfill
only fill `unknown` through their conditional conflict predicate. No database
guard rejects replacing a known grouping identity; the writers never do.

| Read                                                          | Was                                               | Now                                                        |
| ------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `usage-record.service.ts` `usageRecordRunsWith` grouping      | `agent_runs.chat_thread_id`                       | `chat_threads.id` resolved from `billing_run_attribution`  |
| `usage-record.service.ts` `usageRecordRunsWith` last activity | `COALESCE(agent_runs.created_at, processed_hour)` | `COALESCE(billing_anchor_at, processed_hour)`              |
| `usage-record.service.ts` `threadedUsageRecordWith` title     | `chat_threads` joined on the run's live thread    | `chat_threads` joined on the captured grouping identity    |
| `usage-record.service.ts` `queryUsageRecordBreakdown` row key | `agent_runs.chat_thread_id`                       | `chat_threads.id` resolved from `billing_run_attribution`  |
| `usage-allowance.service.ts` `anchorUsageAllowanceCandidates` | `agent_runs.created_at` by run id                 | `usage_event.billing_anchor_at` carried by the settled row |

`finalized-usage-relation.ts` exposes `billing_run_id` and a run-only
`billing_anchor_at` to both ledger branches. The anchor is restricted to the
`run` context there because the display path's remaining fallback is the
processing hour, and a runless row must keep showing that hour rather than
silently switching to its event time. Settlement has no such restriction: the
context check keeps `billing_anchor_at` NULL for every context without a run
start and equal to the event's own creation time for the runless contexts, so
settlement prefers it unconditionally.

Anchoring at settlement is now total. A candidate that cannot be anchored to a
run start falls back to when it happened instead of being dropped from the
allocation, because dropping it silently charged the event its full gross price.

Reads that were checked and need no change: `usage-reporting-ledger.ts` and
`usage.service.ts` group by member and never touch deletable data;
`resolveUsageAllowanceAvailabilityForRun` and
`activateUsageAllowanceWindowsForRun` serve a run that is live by construction;
`x-resource-usage.service.ts` reads the requesting run while it is still
executing. Advisory Lock Cleanup R1 changes chat amounts to an owned, bounded
ledger read in `chat-run-usage.service.ts`; `chat-usage-event.service.ts` only
publishes optional refresh hints with the existing event payload. The new read
uses canonical attribution and current thread ownership, retaining the same
live-Run fallback for unknown grouping identity. It does not infer per-Run
amounts for already-unresolvable historical rows or substitute a hint payload
for missing ledger provenance; those rows remain in generic financial reports.
See [R1 usage boundaries](../advisory-lock-release-1-usage-boundaries.md).

Advisory Lock Cleanup Release 1 keeps these fallbacks: neither a complete
production inventory nor the required zero-gap/conflict conditions have been
established by the code cleanup. Operator age and CI coverage do not establish
data convergence. The bounded operator uses conditional source writes and
conditional checkpoint advancement with no advisory key or explicit row lock; a
competing invocation is rejected without retry and its batch rolls back.

Two transitional fallbacks remain until the operator backfill converges, both
declared at their call sites:

| Fallback                                                                 | Protects                                                | Removal condition                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------- |
| `usage-record.service.ts` and `chat-run-usage.service.ts` live-Run joins | Rows whose attribution predates the grouping identity   | Inventory `thread_gaps: 0` and `conflicts: 0` |
| `usage-allowance.service.ts` `loadRunCreatedAts`                         | Pending rows written before A1 whose run is still alive | Inventory `pending_anchor_gaps: 0`            |

Both counters come from a complete, non-truncated
`pnpm -F @okouai/db billing:attribution` dry-run inventory for the scope. The
backfill refuses to capture a grouping identity for a run whose attribution
disagrees with it, so a non-zero `conflicts` count is a human-resolution gate
rather than a reason to drop the join. The drop pull request removes the two
joins together; it must re-run the backfill immediately beforehand so rows
written by an older instance during the deploy window are not left without a
grouping identity.

## Compaction and deployment

The compactor keeps its allowance-window grains, raw replacement, and exact
quantity/credits/allowance reconciliation; since R1 it takes no advisory lock and
explicitly captures attribution and observation for each bounded batch. Its physical grain adds all three billing fields. Distinct
original runs whose live FKs became NULL cannot merge. Different original
runless event times remain distinct. This can increase rollup row counts for
runless workloads; no original timestamp is replaced with an hourly guess.
Legacy/populated grains coexist without double counting. Backfill changes only
attribution; subsequent compaction consolidates matching populated grains.

Migrations precede API promotion. Outgoing INSERT/RETURNING/ON CONFLICT column
lists still work; no new field is mandatory for old code. New code requires the
migrated schema. There is no full-table data backfill in a migration.

**Before running backfill, verify that all old compactor instances have exited.**
The four-day raw retention window separates new writes from normal compaction;
this is not permission to run backdated writes or backfill during version overlap.
Old compactors do not carry the new physical columns and cannot preserve distinct
NULL-live-run identities or runless timestamps. Once populated grains exist,
retain this compactor in any rollback artifact: rollback may stop consumer use,
but must not restore a compactor that discards these fields. No consumer is
activated in A1. Controller release acceptance must verify these artifact/drain
gates, not infer them from elapsed time or a successful build.

Open-PR inventory found #33756 touching canonical run creation; #33756, #33895,
and #33911 compete for migration 1117. These are overlap records, not
dependencies or ordering reservations.
The first merged migration is canonical; later PRs regenerate against main.

## X resource deduplication accounting

The planned X ingestion path in #34532 computes the unidentified remainder
from the original billable count minus identified occurrences, before collapsing
duplicate IDs. Final billable `quantity` is the globally new unique resource
count plus that remainder. Unidentified units retain the original count-based
charge.

Keep the remainder transient within the internal ingestion protocol. Do not add
`nonDeduplicatedQuantity` to ledger events, hourly rollups or historical usage
API responses, or duplicate it in observation receipts. User-facing usage and
bills show the ordinary net quantity, with no separate deduplication status or
operation-result annotation. This expected condition is not `billingError`.

Shared daily resource claims and observation idempotency still require durable
state. Their atomic write with the net usage obligation, replay fences
and scope-wide activation gates belong to the consuming implementation in
#34610. No dedicated remainder migration or counter-preserving compactor rollout
is a prerequisite. This policy does not activate resource deduplication.

## Bounded operator backfill

Run from `turbo` with the repository-pinned pnpm and an explicitly authorized
`DATABASE_URL`. This PR does **not** authorize production execution.

```sh
# Read-only, bounded inventory. No checkpoint or metadata writes.
pnpm -F @okouai/db billing:attribution --org-id ORG --user-id USER \
  --writer-since 2026-09-14T00:00:00Z --max-rows 10000 --max-ms 5000

# After independently verifying writer/compactor drain, resume this exact job ID.
pnpm -F @okouai/db billing:attribution --org-id ORG --user-id USER \
  --migrate --ack-writer-drain --job-id 00000000-0000-4000-8000-000000000001 \
  --batch-size 200 --max-rows 1000 --max-ms 5000
```

Use a fresh actual UUID for each scope, then retain it across invocations.
Optional `--run-from UUID --run-through UUID` selects an inclusive original-run
UUID range; unlinked legacy rows are excluded by a run range, so also inventory
the organization without that range. Organization is mandatory; user is optional.
A checkpoint refuses changes to its original scope. The batch limit is 500, the
invocation row limit is 1,000,000, and the time limit is at most 60 seconds.
Defaults are 200 rows/batch, 1,000 rows/invocation, 5 seconds. Server statements
have the remaining time budget and lock waits at most one second. Any failed
batch rolls back metadata and cursor together; rerun the same job ID.

The phases are live runs, generation jobs, raw usage, then hourly usage, ordered
by primary key. Each committed batch writes its source rows conditionally and
advances its checkpoint by compare-and-set, without an advisory lock, explicit
row lock or `SKIP LOCKED`. New run and usage writers capture their own
attribution. Normal compaction moving a legacy raw row to a new hourly ID
explicitly captures its live source in the same transaction; unresolvable NULL
rows stay unknown. A fresh complete inventory after
convergence is authoritative; checkpoint counters are work counts, not a snapshot
census. Restarting a completed job is a no-op; use a new job ID for another pass.

Reports contain only scope identifiers, up to ten conflicting run IDs, and counts: eligible, populated, missing
source, conflicting attribution, pending anchor gaps, new-writer gaps since the
operator-supplied deployment timestamp, pending generation provenance gaps, and
thread gaps — runs whose grouping identity is not captured yet.
A `truncated` inventory cannot certify completeness. `activationReady` stays
false in A1 because B and A2 are not implemented. Never silently resolve a
pending unknown/missing-run anchor using event time. Finalized legacy missing
context remains a named historical category for A2's truthful generic bill rows.
No prompts, profiles, request bodies, titles, storage locators, or email addresses
are collected or emitted.

The controller's 2026-09-14 03:16:56–03:16:59 UTC non-atomic census was 135,825 raw,
318,002 hourly, 6,779 org metadata; NULL run IDs were 11,527 and 46,985. These size
the work, not the corruption rate. At 200 rows/batch, raw+hourly alone need roughly
2,270 batches before scope reductions; include live runs and generation jobs in
budgeting. Measure batch lock/statement time on the deployed database before
increasing the budget. Actual production backfill and readiness acceptance belong
to the controller, with both persisted-data and production-log evidence.

## Provisional metadata lifecycle

Run attribution is provisional until it represents incurred usage, allowance,
a grant/refund relationship, or a legitimate outstanding billing obligation.
The table name is not a retention exception. B/A2's durable deletion coordinator
must first fence producers and prove quiescence, then retain only the billing
obligation closure and **delete unbilled attribution for the erased scope**.
A live/pending run or generation callback cannot be treated as proof of no
obligation. Nor can absence of raw usage after normal compaction or current
Clerk ledger cleanup prove that the run was never billed: inspect retained
hourly/allowance and other billing evidence and reconciliation disposition.
The unused `purge_quiescent_provisional_billing_attribution(org, user, run_ids)`
function is retired by the Advisory Lock Cleanup Release 1 migration. It had
no API or operator caller and never activated purge. Historical migration 1119
remains unchanged; the final schema no longer offers an executable advisory
lock through this unused entry point. Current account deletion, retained
attribution and the monotone `usage_observed` marker remain unchanged.
Any future purge still requires exact owner checks, producer quiescence,
settled obligations and absence of live run/job/raw/hourly/allowance references.

The purge must match exact org/user ownership, preserve surviving members and
organizations, and never use the optional `users` preferences table as deletion
authority. Delete completed backfill checkpoints after exporting and accepting
their content-free report; failed checkpoints remain only until resumed or
explicitly abandoned. Do not create permanent run snapshots, account profiles,
prompt archives, or general audit retention to implement either lifecycle.

## Stage 1 operation subtype (D)

[#34267](https://github.com/vm0-ai/vm0/issues/34267) extends this foundation with
`pi_memory_stage1`, a known immutable runless **model** context. Both physical
ledgers enforce NULL live/billing run identity and a non-NULL original anchor;
raw anchors equal creation time. Capture rejects incompatible explicit subtype
inputs before normalization. Existing generic contexts and old writers remain
valid. Matching retained old `runless` response keys are accepted without
retagging or additional charging; arbitrary unknown/conflicting identities fail.

The [cost and activation runbook](../../ops/pi-memory-stage1/README.md) defines
original-time replay, exact gross credit-value estimation, bounded raw/hourly
UNION reconciliation, legacy/missing coverage, two-transaction constraint
validation and retained-schema rollback. This does not expand idempotency
retention, infer Phase 2 from `agent`/model, activate monitoring, or perform A2.

## Compaction legacy-attribution fallback

Usage compaction still rebuilds `billing_run_attribution` from `agent_runs` for
raw `usage_event` facts written before explicit writer capture (rows whose
`billing_context` is outside `run`, `runless` and `pi_memory_stage1`). This is a
declared rollout fallback for historical raw facts only; current writers always
capture attribution explicitly. Remove it once a production census returns zero:

```sql
SELECT count(*) FROM usage_event
WHERE billing_context NOT IN ('run', 'runless', 'pi_memory_stage1');
```
