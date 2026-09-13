# Pi candidate reference accounting preparation

Preparation issue [#33765](https://github.com/vm0-ai/vm0/issues/33765) is the
first release of [#33748](https://github.com/vm0-ai/vm0/issues/33748). The
production trigger and function from `1078_baseline.sql` remain unchanged.
No migration or data rewrite accompanies API B.

## Accounting and locks

The canonical API service is
`turbo/apps/api/src/signals/services/pi-memory-stage1-candidate.service.ts`.
Insert and source replacement retain only returned rows. Replacement retains
the new source and guardedly releases the locked previous source. Deletion
uses actual `DELETE RETURNING` hashes, aggregates multiplicity and rejects a
missing blob or insufficient count. All calls are awaited inside the caller's
transaction. Conversation ownership remains additive; candidate counts never
replace `blobs.ref_count`. A failed release rolls back the row mutation and
any preceding retains/releases, including every parent in a bulk deletion.

Lock order for ordinary candidate operations is:

1. Existing completion run lifecycle/chat/run locks, when entered from completion.
2. Storage rows in ascending ID order. Admission uses `FOR NO KEY UPDATE`;
   parent deletion uses `FOR UPDATE`; worker result commit uses `FOR KEY SHARE`.
3. Candidate relation `ROW EXCLUSIVE`, then catalog inspection, then candidate rows.
4. Companion blob writes; bulk explicit releases use ascending hashes.

Combined completion retains its existing checkpoint-before-admission order:
after the existing lifecycle/chat/run locks it locks the memory storage, then
writes checkpoint blobs, then enters candidate admission. Taking the storage
lock **before** either blob or candidate work prevents the new parent/blob
cycle with cleanup. It does not claim to reorder every checkpoint blob owner. If no storage exists, there can be no existing child
reference to release; admission creates the storage in its transaction. It does
not create memory storage for failed or otherwise ineligible completions.
Phase 2 already locks storage before candidates/jobs. Worker result commit
locks its parent before changing a candidate and enqueuing a Phase 2 job; the
latter can acquire a parent FK lock. Hash, owner, lease token, status and lease
expiry checks remain intact. Worker claiming/status-only updates do not change
source references.

`ROW EXCLUSIVE` permits unrelated DML and conflicts with the relation lock
required by `DROP TRIGGER` and trigger enable/disable DDL. PostgreSQL retains
it until transaction end. Detection is a **separate statement after** that
lock has been granted, under **READ COMMITTED**. Consequently a waiting B
transaction sees committed trigger removal even if an earlier statement ran
before the DDL committed. Repeatable Read and Serializable are rejected before
mutation because an older transaction snapshot is not this contract. No
process-global catalog cache or globally exclusive writer lock exists.

Detection accepts either no user trigger or exactly the original enabled
AFTER ROW INSERT/DELETE/UPDATE-OF-source trigger and original function source
fingerprint. Renamed, disabled, extra, filtered or altered accounting triggers
fail closed. Replication-role overrides are unsupported. A standalone function
replacement is outside the migration contract: later retirement must drop the
trigger before its function in one transaction, and must not replace the
function underneath B. `1078_baseline.sql` is the fingerprint authority.

The candidate-to-blob FK and transactional retain protect the source against
concurrent deletion; GC must recheck the count under its normal write lock.
No external object deletion based on an unlocked stale count is authorized by
this change. Existing conversation checkpoint writes also touch blobs; this
slice does not redesign their multi-hash ordering or clamped release policy.
PostgreSQL still aborts a transaction on a deadlock; no failed transaction may
be reported as a successful cleanup or as an automatically retried webhook.

## Writer and deletion inventory

Audited against `main@0213a6a523703137096396fd97ee266442b02252` on 2026-09-13.

| Path                                                                       | Ownership and supported behavior                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-webhook-complete.service.ts`                                        | Sole production admission caller; persisted Pi launch snapshot gates admission. Uses the canonical service in its completion transaction.                                                                                                                                                                                                                                                   |
| Candidate admission service                                                | Actual insert, retry, stale-source rejection and fenced replacement. `insertPiMemoryStage1Candidates` also supports controlled fixture/repair insertion; never issue raw candidate writes to change ownership.                                                                                                                                                                              |
| `webhooks-clerk-cleanup.service.ts`                                        | User and organization storage removal use `deleteStoragesWithPiMemoryCandidates` in a transaction containing only the storage/candidate/reference subset. Existing external cleanup stays outside.                                                                                                                                                                                          |
| `webhooks-clerk.ts`                                                        | Deletion cleanup runs asynchronously after HTTP 200. An invariant failure needs operator investigation/redelivery; it is not a durable retry mechanism.                                                                                                                                                                                                                                     |
| `workflow-delete.service.ts`                                               | Only `custom-skill@...` storages owned by `__org__`; canonical memory admission requires the user-owned `memory` namespace.                                                                                                                                                                                                                                                                 |
| `agent-instructions-storage-transaction.service.ts`                        | Only `agent-instructions@...` org volumes; cannot be a canonical candidate parent.                                                                                                                                                                                                                                                                                                          |
| `cron-sync-skills.service.ts`, development seed                            | Registry/system skill volumes, never user memory storage.                                                                                                                                                                                                                                                                                                                                   |
| Phase 1 worker / Phase 2 job, maintenance and usage writers                | Update status, output, lease, selection and usage fields; do not insert/delete candidates or replace the source. Parent FK locking is preserved.                                                                                                                                                                                                                                            |
| Candidate test fixtures, Phase 2 fixture, `test-pi-memory-stage1-state.ts` | Insertion and parent cleanup now use the canonical service, including the worker test's delete-owner action.                                                                                                                                                                                                                                                                                |
| Numbered external migrations `006`, `007`, `008`, `015`                    | Permanent records remain unchanged. `006` targets retired `agent_composes`/`zero_agents` tables and is not a current repair command. For an actually deleted Clerk org, use provider redelivery of `organization.deleted` to the current webhook, with current API cleanup. `007`/`008` own custom-skill org volumes; `015` builds version indexes and does not change candidate ownership. |
| DB baseline consistency tests                                              | Intentionally exercise the unchanged historical trigger in isolated databases. Retirement must update current-schema expectations, preserving the historical record.                                                                                                                                                                                                                        |

Standalone candidate retention deletion uses `deletePiMemoryStage1Candidates`;
it locks parents and accounts only returned children. Parent deletion must use
`deleteStoragesWithPiMemoryCandidates`, never a raw cascade on user memory.
There is no active production candidate backfill/repair writer in this census.
Any future repair must use this service and preserve total conversation refs.

At dispatch, open PRs had no overlap with these ownership files and no competing
migration in this slice (which adds none). Overlap is inventory, not a reason
to wait for another author's merge.

## Content-free production verification

Use the checked-in, read-only diagnostic:

```sh
psql -X --set ON_ERROR_STOP=1 --dbname "$DATABASE_URL" \
  --file turbo/packages/db/scripts/audit-pi-memory-candidate-references.sql
```

Run it only inside an already-authorized database operator environment with
its existing production **read-only** connection. Do not copy a credential to
chat or an agent sandbox, echo the URL, or enable shell tracing. This is a
standard `psql` invocation, not a new endpoint or a change to masking. The
script takes one Repeatable Read READ ONLY snapshot, uses 30-second statement
and 3-second lock limits, emits one JSON aggregate row and rolls back. A timeout
is incomplete evidence; do not infer zero rows. The operation scans candidate,
conversation and blob metadata; its runtime depends on their current size.

The current agent-accessible MaskDB inventory, refreshed at 2026-09-13 16:07:58
UTC, exposes `blobs`, `conversations` and `storages` but does not expose
`pi_memory_stage1_candidates` or the required catalogs. Its single-table DSL
cannot execute this audit. Therefore the controller still needs an authorized
operator to execute this exact read-only file and return the aggregate receipt,
or separately approved aggregate-only diagnostic access. This PR does not grant
that access, expand masking, export credentials or expose a public API. Absence
of the receipt blocks retirement acceptance, not implementation of API B.

Before promoting B, verify `user_triggers = expected_triggers = 1` so its
strict compatibility decision recognizes the installed accounting owner. Repeat
the audit after B is deployed. Expected before retirement: no missing
candidate blob/owner, no unexpected namespace, no negative count and no count
below candidate or known conversation-plus-candidate ownership. Inspect counts
above known owners and the full-ledger difference separately: initial blob
registration and historical conversation deletion can produce pre-existing
residual counts. They are **not** proof of candidate leaks and must not be
silently reset. Compare pre/post receipts and investigate any unexplained drift;
a clean count floor alone is not full ledger reconciliation. The diagnostic
exports neither source hashes nor candidate/owner identifiers or content.

Record the exact deployed API artifact, query timestamp/version and full JSON
receipt. Separately examine bounded production logs for admission, replacement,
completion, worker fencing, Clerk cleanup errors, deadlocks, invalid releases
and catalog-configuration failures. Logs establish runtime activity and errors;
event counts cannot establish stock or reconcile references. No production
acceptance is claimed by local test results.

## Two releases and rollback

| API/schema combination   | Supported state                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Pre-B + original trigger | Existing production, while release 1 rolls out.                                                                    |
| B + original trigger     | Trigger owns counts; B must never double count.                                                                    |
| B + trigger absent       | B owns counts, including Clerk parent cleanup. Covers release 2 migration-before-promotion and supported rollback. |
| Pre-B + trigger absent   | Unsupported. Must be excluded before retirement.                                                                   |
| C + trigger absent       | Later focused retirement removes detection and uses explicit writes only.                                          |

The controller independently accepts the preparation merge, releases B through
a separate release owner, verifies the deployed artifact and persisted/runtime
evidence, and records B as the supported rollback target. It must establish
that pre-B serving writers and background continuations are no longer eligible.
The PiLoop switch, nominal release duration, a quiet log window and a successful
deployment alone do not establish drain. API rollback does not restore schema.

Only after that gate passes may the controller create the retirement issue
against then-current main. Recheck current writers/locks, supported isolation,
trigger/function identity, statement/lock timeouts, DDL ordering and rollback
eligibility there. The later migration drops only this trigger and its function,
with no data reset. B must remain available during the migrated-schema window.
Do not mix an unrelated multi-table lock order into the drop transaction. If
an audit finds drift, stop retirement and design a narrowly scoped repair.

## Measured scale and limits

The controller's 2026-09-13 15:06:47 UTC MaskDB census found 18 running runs,
8 Pi. Complete Axiom results for `[14:03:45Z, 15:03:45Z)` contained 68 created
and 20 replaced candidate events. These are frozen activity measurements, not
candidate stock, current concurrency, reference consistency or a drain proof.
The preparation implementation does not pause or clear production data.
