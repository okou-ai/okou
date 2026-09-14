# Billing attribution foundation (A1)

Issue [#33851](https://github.com/vm0-ai/vm0/issues/33851), parent
[#33745](https://github.com/vm0-ai/vm0/issues/33745). This is additive preparation.
No billing reader, pricing, allowance decision, recharge, subscription policy,
Clerk cleanup, or production retention behavior switches in this change.

## Persisted contract

`billing_run_attribution` stores one original run UUID, billed organization/user
IDs, original `agent_runs.created_at`, and the bounded usage-view source. It has
no FK to content, users, agents, sessions, or threads. The insertion trigger is
part of both `insertLaunchRunRows` and `buildAtomicLaunchCteContext` transactions
in `agent-run-create.service.ts`; failed run creation rolls it back. Matching
retries are idempotent; a different org/user/time/source raises `23514`. Updates
cannot replace the immutable identity. `usage_observed` only advances from false
to true after a committed raw/rollup insertion or backfilled linkage; it cannot
be cleared by raw compaction or the current destructive cleanup. The database source classifier follows
`usage-record.service.ts`: web -> chat; schedule/event/legacy goal -> automation;
slack/teams/telegram/email/agentphone/github/agent pass through; otherwise other.
The historical null trigger source is other, without copying trigger payloads.

Raw and hourly usage independently store `billing_run_id`, `billing_anchor_at`,
and `billing_context`. The ID is deliberately not a content FK; an unavailable
canonical source remains reportable rather than being deleted or fabricated:

| Context          | Identity and time                              | Meaning                                                                      |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `run`            | Original run ID and verified run creation time | Canonical billing row agrees with billed org/user and anchor.                |
| `runless`        | No run ID; original event creation time        | A producer explicitly knows the operation had no run.                        |
| `missing_run`    | Original run ID, no anchor                     | A supplied run identity has no surviving verified source.                    |
| `legacy_unknown` | Neither                                        | Historical NULL association or legacy producer with insufficient provenance. |

The raw INSERT trigger atomically attaches attribution for **every** writer,
including old API instances and direct SQL. Its input never changes quantity,
credits, idempotency key, status, processing time, or settlement. It can populate
an older live run's attribution in that same transaction. Known attribution is
immutable; processing updates and FK `SET NULL` leave it intact. A managed call
retains its supplied run identity even when its existing live-run lookup misses.
This does not change the existing allowance fallback in A1.

Generation jobs capture their original identity/runless classification in their
own INSERT transaction and pass it through provider callbacks. Those two job
columns follow the **job's ordinary non-billing deletion lifecycle**, not ledger
retention. Old jobs without a live run remain unknown. A runless usage anchor is
the event time, not job creation, compaction, backfill, or callback-processing time
invented for a run that once existed.

## Writer and consumer inventory

Verified on base `fa2e6e6212dee848c8d37d72551cc5d9b7887ac4`:

| Production writer                                                                       | Atomic capture / provenance                                                                                            |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agent-run-create.service.ts` (both insert paths)                                       | Database run INSERT trigger; includes canonical launch CTE.                                                            |
| `managed-usage.service.ts`                                                              | Raw trigger plus supplied original run ID; explicit runless when actor has no run.                                     |
| `openrouter-usage.service.ts`                                                           | Raw trigger; explicit runless for request-local no-run usage.                                                          |
| `webhooks-agent-health-usage-telemetry.ts`                                              | Raw trigger, runner-supplied run ID; current idempotent INSERT unchanged.                                              |
| `pi-api-first-turn-usage.service.ts`                                                    | Raw trigger in current idempotency-validation transaction.                                                             |
| `pi-memory-stage1-usage.service.ts`                                                     | Explicit runless; current deterministic keys and validation transaction unchanged.                                     |
| `image-generation.service.ts`, `video-generation.service.ts`, `avatar-video.service.ts` | Raw trigger; callbacks carry original job billing identity; synchronous image requests carry request-local provenance. |
| `voice-io-post.service.ts`                                                              | Raw trigger; explicit request-local runless classification.                                                            |
| `intro-video-agent.service.ts`, `intro-video-render.service.ts`                         | Raw trigger; original job billing identity survives provider delay.                                                    |
| `intro-video-voice.service.ts`, `intro-video-presenter.service.ts`                      | Raw trigger with required run ID.                                                                                      |
| `built-in-generation.service.ts`, intro-video agent/render job creation                 | Job INSERT trigger; both webhook job projections include independent identity.                                         |

`src/test-fixtures`, `routes/test-*`, `__tests__`, `__benches__`, and
`src/scripts/dev-bench-seed.ts` are fixtures/benchmarks, not production usage
writers. Their direct inserts also exercise the database boundary. Intentional
legacy fixture inserts that omit new fields remain supported.

Consumers deliberately unchanged: `credit-usage.service.ts`,
`usage-allowance.service.ts`, `usage-record.service.ts`,
`finalized-usage-relation.ts`, `usage.service.ts`, `usage-event-cleanup.service.ts`,
and `webhooks-clerk-cleanup.service.ts`. The finalized UNION's public selection
needs no new field yet. A2 must remove live-content reader dependencies and
switch settlement only after completeness and B's closure/fencing contract pass.

## Compaction and deployment

The compactor keeps its existing global transaction advisory lock, row locks,
allowance-window grains, raw replacement, and exact quantity/credits/allowance
reconciliation. Its physical grain adds all three billing fields. Distinct
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
Old compactors do not carry the new physical columns. Their live-run inserts can
recover verified attribution via the trigger, but they cannot preserve distinct
NULL-live-run identities or runless timestamps. Once populated grains exist,
retain this compactor in any rollback artifact: rollback may stop consumer use,
but must not restore a compactor that discards these fields. No consumer is
activated in A1. Controller release acceptance must verify these artifact/drain
gates, not infer them from elapsed time or a successful build.

Open-PR inventory found #33756 touching canonical run creation; #33756, #33895,
and #33911 compete for migration 1117. These are overlap records, not
dependencies or ordering reservations.
The first merged migration is canonical; later PRs regenerate against main.

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
by primary key. Each committed batch holds the existing compaction advisory
lock before locking its checkpoint/source rows. Live runs use `FOR NO KEY UPDATE`
so first-usage FK key-share checks remain compatible; other source phases retain
`FOR UPDATE`. No `SKIP LOCKED` cursor can skip
held rows. New run and usage writers capture their own attribution. Normal
compaction moving a legacy raw row to a new hourly ID captures its live source
atomically; unresolvable NULL rows stay unknown. A fresh complete inventory after
convergence is authoritative; checkpoint counters are work counts, not a snapshot
census. Restarting a completed job is a no-op; use a new job ID for another pass.

Reports contain only scope identifiers, up to ten conflicting run IDs, and counts: eligible, populated, missing
source, conflicting attribution, pending anchor gaps, new-writer gaps since the
operator-supplied deployment timestamp, and pending generation provenance gaps.
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
`purge_quiescent_provisional_billing_attribution(org, user, run_ids)` is a
bounded, idempotent SQL boundary for that future coordinator: at most 500 IDs,
exact org/user, the compaction lock, no observed usage, no live run/job, and no
raw/hourly/allowance references. The caller must establish quiescence and settle
other obligations first; the function is not account-deletion authority. Its
monotone usage marker prevents current ledger teardown from making previously
billed runs appear provisional. It has no production caller in A1 and does not
activate purge or change current cleanup semantics.

The purge must match exact org/user ownership, preserve surviving members and
organizations, and never use the optional `users` preferences table as deletion
authority. Delete completed backfill checkpoints after exporting and accepting
their content-free report; failed checkpoints remain only until resumed or
explicitly abandoned. Do not create permanent run snapshots, account profiles,
prompt archives, or general audit retention to implement either lifecycle.
