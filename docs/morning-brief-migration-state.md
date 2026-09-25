# Morning Brief migration state

> The proposal to replace Official Workflow Morning Brief with the Native
> `simple-morning-brief` pipeline was retired. Official Workflow is the sole
> execution path after the stage-2 cleanup. This document remains relevant for
> the shared installation/ownership reader and as migration history; its
> Native transition discussions below are historical, not operational advice.

## Native storage retirement: pre-drop evidence, not authorization

This inventory is for [#36916](https://github.com/okou-ai/okou/issues/36916)
under [#36915](https://github.com/okou-ai/okou/issues/36915). It is a
**preparation checklist**, not evidence sufficient to drop a table, release
code, change data, or close either issue. Code/schema baseline:
`origin/main` `a4794200e232f46f6f64eb8102067c6a367667d7` (2026-09-25).
[#36750](https://github.com/okou-ai/okou/pull/36750) removed Native execution
entrypoints, **not** historical email admission, retention, deletion, or the
Official scheduler's Native authority reads. Re-inventory after the S1 release
and before opening any separately authorized S2 physical-drop change. As of
this baseline, in-flight #36901 touches Morning Brief erasure admission and
this document, #36909 touches `email-common.service.ts`, and #36900, #36907,
#36911, #36897 and #36894 touch the ownership inventory. Reconcile their
**merged** semantics at S2; file overlap alone is not a reason to wait now.
The #36893 scheduling incident is an independent S1 owner, not this audit's
runtime implementation.

### Read-only production snapshot and its limits

MaskDB `vm0-prod-ro` metadata, structured reads and unmasked-column count/group
aggregates were read **2026-09-25 13:04:29–13:05:40 UTC**. These are
point-in-time, all-account counts, not transactionally consistent across tables.
No raw message, template, provider request or personal content was read:

| Surface                                                   | Observed at that window                                                                                                                                                                                                                                             | What it does _not_ prove                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `morning_brief_native_schedules`                          | 477, all `phase=target=legacy`; 451 enabled/legacy-owned, 26 disabled/no owner                                                                                                                                                                                      | No old API writer, no Official stale anchors, or no rollback dependency.                                                                                                                                                           |
| `morning_brief_native_occurrences`                        | 10 settled, zero unsettled; outcomes: 4 delivered, 3 generation-failed, 1 generation-unknown, 1 collection-failed, 1 not-configured                                                                                                                                 | No unknown provider request or delivery/recovery obligation.                                                                                                                                                                       |
| `morning_brief_collection_occurrences`                    | 10: 8 completed, 2 running                                                                                                                                                                                                                                          | The two running attempts are harmless or terminal; lease, provider and deletion state need separate evidence.                                                                                                                      |
| `morning_brief_generations`                               | 8 physical rows, all `expires_at <= 2026-09-25 13:05 UTC`: 4 succeeded/deliver, 3 output-rejected, 1 invocation-outcome-unknown; all 8 `result_bytes` and `retained_until` were null on a bounded eight-row read; the four deliver rows had `content_purged_at` set | Eight expired generation rows are **not** zero physical rows. MaskDB does not expose `result_title`, `result_markdown` or `retained_sources`; the receipt/provider ambiguity survives the result purge.                            |
| `morning_brief_platform_generation_receipts` (**retain**) | 8: 7 reported/response-received, 1 invocation-unknown                                                                                                                                                                                                               | Not user-content erasure proof; never clear accounting receipts to make a drop count pass.                                                                                                                                         |
| Shared `email_outbox`                                     | 2,055 `sent`; no global `pending` or `sending` at this instant                                                                                                                                                                                                      | `template` is masked and cannot be filtered/grouped, and the gateway omits committed provider request/key. Global zero is not Native-template drain, nor proof about already-accepted or unknown Resend calls; `sent` rows remain. |
| Official `workflow_automations` (`daily-delivery` only)   | 478, 448 enabled                                                                                                                                                                                                                                                    | No successful S1 release, owner-choice, claim/queue, or delivery-window proof.                                                                                                                                                     |
| `account_erasure_jobs`                                    | 2 `verified_erased`                                                                                                                                                                                                                                                 | No future/newly captured jobs, sink-version compatibility or guarantee that old binaries have drained.                                                                                                                             |

MaskDB exposes the four Native tables named above and the **retained** receipt
table, but not `morning_brief_native_schedule_skips`,
`morning_brief_deliveries`, `morning_brief_installed_preferences`, or Official
`morning_brief_schedule_claims`. No production row counts for those four are
claimed. It also cannot enumerate live `pg_constraint`/`pg_depend`, filter
masked outbox templates, inspect provider-side acceptance, or establish fleet
and rollback-target identity. The snapshot cannot be a deletion certificate.

### Seven-table dependency and removal matrix

Here, "drop gate" means a condition to prove in a **later** contract/release,
not a request to perform the drop now. Refresh direct and indirect callers,
including old serving/rollback binaries, test fixtures, exports, raw SQL, schema
barrels, migration-consistency and account-erasure tests. Published migrations
remain immutable history. Schema sources: `turbo/packages/db/src/schema/`
`morning-brief-{native-schedule,collection-occurrence,generation,delivery,installed-preference}.ts`
and `workflow-schedule-skip.ts`; creation/changes in migrations 1149, 1151,
1152, 1155, 1157, 1164, 1165, 1181 and 1212.

| Candidate / FK boundary                | Current readers/writers on baseline `main`; prerequisite to remove                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `morning_brief_native_schedules`       | PK `(org_id,user_id)`; nullable thread FK `ON DELETE SET NULL`, **no** member/Agent FK. Parent of Native occurrences and skips (both `ON DELETE CASCADE`). `morning-brief-native-schedule.service.ts` still reads/writes Official choice, claim, settlement and revocation; `morning-brief-schedule-claim.service.ts`, `morning-brief-preference.service.ts`, `workflow-automation.service.ts`, `official-workflow-reconciliation.service.ts` and `workflow-schedule-expiry.service.ts` depend on it. Historical production-mail authority also reads it; test-only `test-email-outbox-state.ts` writes fixtures. Gate: S1 eliminates Native scheduling/reconciliation _decision_ reads with tested disabled intent, stale-anchor and old-callback handling; then prove no serving, draining or permitted rollback binary writes/reads it, and settle child obligations before contraction. Do not infer safety from all rows being `legacy`. |
| `morning_brief_native_occurrences`     | Child of Native schedule by composite cascade FK; no FK from generation or Official claim. `morning-brief-native-schedule.service.ts` settlement/revocation and `workflow-schedule-expiry.service.ts` unsettled-claim guard read/write it. Gate: prove all leases/claims and delivery recovery resolved with authoritative Run/queue/provider evidence, and remove Official expiry dependency without reopening a missed slot. A settled row or old timestamp alone is not provider proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `morning_brief_native_schedule_skips`  | Composite cascade FK to Native schedules; no runtime API read/write found on this baseline (the active expiry writer uses **`workflow_schedule_skips`**, which is separate and stays). Gate: obtain its unexposed row count/catalogue dependencies, confirm no rollback writer/reader, and preserve any Official skip history. Do not confuse the two tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `morning_brief_collection_occurrences` | Composite cascade FKs to `org_members_metadata` and `agents`; **parent** of generations through a composite cascade FK. `morning-brief-collection-occurrence.service.ts` and membership/Clerk cleanup delete/stamp ownership; `morning-brief-native-email-admission.service.ts` locks frozen membership for mail. Test-only outbox fixture creates rows. Gate: independently resolve running/expired leases and legacy mail provenance before removing cleanup/admission and dropping; do not cascade away generation content as a substitute for retention.                                                                                                                                                                                                                                                                                                                                                                                  |
| `morning_brief_generations`            | Composite cascade FK to collection occurrence; unique invoked-anchor fence, no FK to billing receipts or deliveries. `morning-brief-generation-store.service.ts` still sanitizes expired bodies and deletes rows older than the **seven-day scheduled-anchor replay window**; `morning-brief-generation-retention-worker.service.ts` is still called by `cron-execute-workflow-automations.ts`. Gate: keep tick and privacy fence until body/proof purge is proved, wait for safe replay/unknown-outcome reconciliation, then verify **zero physical generation rows** and no old writer/reader before stopping the worker or dropping. Do not issue a second model request for `reserved`/`invocation_outcome_unknown`. Keep `morning_brief_platform_generation_receipts` independent and intact.                                                                                                                                            |
| `morning_brief_deliveries`             | Composite member FK plus Agent/thread cascade FKs; **deliberately no FK** to generation, `chat_events` or `email_outbox`; unique outbox and attempt references are logical provenance. `morning-brief-native-email-admission.service.ts` joins/locks it for the historical `morning-brief-result` template; `morning-brief-delivery.service.ts` removes owned deliveries and their linked outbox intents atomically during member/Clerk/Agent/thread deletion. Gate: prove Native-template mail/provider lifecycle and deletion path retired or safely replaced, with no linked or orphaned live intent; preserve sent Chat and Official result-mail. MaskDB does not expose this table.                                                                                                                                                                                                                                                      |
| `morning_brief_installed_preferences`  | Non-authoritative projection, FKs to evictable `org_members_cache`, `agents`, `chat_threads`, all cascade. No production runtime reader/writer found on this baseline after #36750; schema/inventory remain. Gate: verify old API and rollback floor no longer read/write it, catalogue and erasure compatibility, and actual row count via authorized read. **Do not** delete canonical Official preference, enrollment, installation or disabled choice with the projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`ACCOUNT_OWNERSHIP_INVENTORY` declares **each of these seven** `user_root`
owned by `user_id`, while `email_outbox` is `deferred_retention`,
`morning_brief_platform_generation_receipts` is `billing_preserved`, and
`morning_brief_schedule_claims` is a separate retained Official `user_root`.
The rollback boundary differs by table: schedules/occurrences still gate live
Official claim/expiry and preference writers, collection/delivery rows still
gate historical mail and deletion, generations still gate bounded retention,
and skips/projections still require proof about old binaries. Therefore no
single age threshold, empty pending-outbox snapshot or global rollback commit
can replace a per-consumer drain. Retain Official definitions, installations,
preferences, enrollments, automation and skip history, schedule claims, email
subscriptions, sent Chat and platform receipts.
`account-erasure-relational-collector.ts:assertCatalogueInventoryCoverage`
rejects both an uncovered live table and a declared-but-absent table
(`catalogue_absent`). Remove inventory/schema entries only in the separately
staged contraction with compatible fleet/rollback target and tests; **never
weaken the fail-closed guard**. Member/Clerk cleanup, Agent deletion and thread
deletion also call Native revokers, independently of the relational sweep.
A dropped table makes an old deletion binary fail during the migration-before-
API-promotion window; #34296's all-present/all-absent transaction/advisory-lock
bridge concerned different tables and is not an approved hot-path template here.

### Independent mail, content and cross-version gates

1. Keep the distinct `morning-brief-result` decoder/renderer and fail-closed
   admission in `email-common.service.ts` and
   `morning-brief-native-email-admission.service.ts` while **any** historical
   Native outbox intent can survive, including `pending`, leased `sending`,
   terminal `failed` with a committed request/key, or retained `sent` history
   needing reconciliation. The drain checks exact delivery provenance,
   membership and occurrence; production intents check Native epoch/choice,
   while previews check their Official installation binding. Destination,
   opt-out and shared suppression checks also apply before a request is
   prepared. A committed request/key is replayed
   as-is; the worker cannot retract a provider-accepted send and deletion of a
   local row cannot prove the provider did not receive it. The 15-minute outbox
   deadline, retries and cleanup are not a provider settlement certificate.
   Remove this decoder only after template-specific, bounded provider/outbox
   reconciliation, an explicit historical-mail handling decision for retained
   rows, proof no old producer can enqueue it, and tests that an orphan can
   **never** fall through to generic/Official sending. Preserve normal
   `official-automation-result` email and the shared outbox.
2. Do not stop the retention worker just because generation execution is gone.
   Its `SKIP LOCKED` batches sanitize source-derived title/Markdown and
   `retained_sources` at their deadlines; rows remain until the seven-day
   replay cutoff based on `scheduled_for`. `expires_at`, `content_purged_at`
   and actual content NULL checks are independent of a zero-row test. The
   current eight expired rows still exist. Reconcile ambiguous provider costs
   without clearing anonymous platform receipts. #35950 is **open** and only
   proposes dropping nullable `retained_sources`/`retained_until` after
   #35949's separate production stop-write/read-back gate; whole-table
   retirement would ultimately subsume its DDL, **not** its distinct
   deployment/content/privacy evidence. Re-evaluate its entry condition,
   production evidence and sequencing with its owner; do not close or implement
   it implicitly. Even if those columns go first, retain result-body cleanup.
3. Migrations apply **before** API promotion. Require an observed minimum
   serving API fleet, drained old instances/background ticks and queue/Run
   callbacks, a rollback floor excluding every seven-table reader/writer,
   compatibility across mixed versions for account deletion, and a separate
   release/data-deletion authorization. No same-release assumption from a new
   schema alone. A table drop is not reversible by rolling back API code; do
   not use `DROP ... CASCADE`. Pause on unknown active work, unexplained count,
   missing FK, erasure sink/version mismatch, unsafe locks, provider ambiguity,
   unverified Official choice/delivery or unprovable rollback floor.

### Minimum-privilege preflight and later acceptance reads

After S1 business acceptance, **re-measure** all seven table counts and bytes,
Native phases/owners, enabled/disabled Official anchor divergence and future
anchors, unsettled Native and Official claims, running collection leases,
generation state/age/body/proof/physical counts, deliveries and linked/orphan
outbox status _by template_, provider acceptance/idempotency outcomes, account-
erasure jobs/sinks/collector versions, FK/dependent objects and API fleet and
rollback target. Check at least the one-hour operational window and the next
relevant local delivery windows for advancing schedules, zero stale backfill
Runs, no duplicate Chat/email, and preserved disabled choices. A CI/deploy
success is not business acceptance. Record each query's UTC timestamp, scope,
count, owner of unresolved state and disposition; recheck immediately before
any separately authorized migration and after promotion.

Use MaskDB structured metadata/aggregates for the exposed unmasked columns,
with paginated reads and explicit scope; **do not** use its global outbox status
as a Native-template predicate or attempt SQL through that gateway. A later
owner should request a narrowly scoped, read-only production catalogue/SQL
role or an approved aggregate-only diagnostic with a statement timeout,
fixed UTC `:as_of`, redacted output and no raw content/address/key exposure.
Suggested acceptance queries for that later authorized reader (illustrative,
not executed by this document):

```sql
-- Run each statement against one verified production revision; record UTC time.
SELECT count(*) FROM morning_brief_generations;
SELECT state, decision, count(*) FROM morning_brief_generations
GROUP BY state, decision;
SELECT count(*) FILTER (WHERE result_title IS NOT NULL OR result_markdown IS NOT NULL
  OR result_bytes IS NOT NULL) AS remaining_body,
  count(*) FILTER (WHERE retained_sources IS NOT NULL) AS remaining_proof,
  count(*) FILTER (WHERE expires_at <= :as_of) AS expired_rows
FROM morning_brief_generations;
SELECT status, count(*) FROM morning_brief_collection_occurrences GROUP BY status;
SELECT state, count(*) FROM morning_brief_native_occurrences GROUP BY state;
WITH targets AS (
  SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace
    AND relname IN ('morning_brief_native_schedules',
      'morning_brief_native_occurrences', 'morning_brief_native_schedule_skips',
      'morning_brief_collection_occurrences', 'morning_brief_generations',
      'morning_brief_deliveries', 'morning_brief_installed_preferences')
)
SELECT c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent,
       c.confdeltype FROM pg_constraint c
WHERE c.contype = 'f' AND (c.conrelid IN (SELECT oid FROM targets)
  OR c.confrelid IN (SELECT oid FROM targets));
-- Separately count all seven targets and dependent views/functions via
-- pg_class/pg_depend, including absent relations (not just present OIDs).
-- In an approved, redacted template-only read (never select the JSON body):
SELECT template->>'template' AS template_name, status, count(*)
FROM email_outbox WHERE template->>'template' = 'morning-brief-result'
GROUP BY template->>'template', status;
-- In the same approved diagnostic, aggregate committed-request/key presence,
-- failed/sending ambiguity and linked vs orphaned delivery references, without
-- returning recipient, body, provider payload or idempotency key values.
```

Do not run these SQL queries through MaskDB. An operator must additionally inspect provider-side intent status using approved minimal
permissions, deployment history/rollback resolver, logs and active jobs; DB
counts alone cannot prove a request never crossed the network. Acceptance after
an authorized contract must assert target relations absent, seven schema and
erasure entries removed _together_ with old readers, retained Official
`morning_brief_schedule_claims`/automations/definitions/installations/
preferences/enrollments, sent Chat and accounting receipts still present and
unmodified, and shared outbox and erasure jobs healthy. On a mismatch, abort
before DDL or halt promotion and escalate; after a committed drop, roll forward
with a compatible binary/repair plan, **not** an old API rollback into missing
tables or a blind resend. The controller independently accepts the evidence;
this document is not a production clearance.

`morning-brief-migration-state.service.ts` describes which Official Workflow
installation a member owns. The preference surface continues to read that
installation without relying on the retired Native projection.

## The exported contract

`loadMorningBriefOwnership(db, owner)` answers "which installation does this
member's preference surface manage?" and returns the enrollment row, every
Morning Brief installation the member holds (oldest first), and the selected
one. `loadMorningBriefMigrationState(db, owner)` composes the full view on top
of it and returns exactly one of:

| `kind`         | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `absent`       | The member owns no Morning Brief installation.              |
| `pending`      | The selected installation has not finished installing.      |
| `installed`    | The installation owns one valid Morning Brief schedule.     |
| `inconsistent` | The installation is installed but its schedule is not ours. |

Every state carries the owner, the enrollment, and
`additionalInstallations`. Installation-bearing states also carry the selected
installation and `chatThreadId`. An `installed` state carries the automation's
`enabled`, `cronExpression`, `timezone` and `nextRunAt`; an `inconsistent`
state carries which invariant failed.

`loadMorningBriefDefaultAgentId(db, owner)` resolves the Agent an org-wide
action would use, and backs both the adoption tie-break and the Settings
availability check.

## Ownership invariants

- **Settings owns exactly one installation.** The catalog installs Morning
  Brief per Agent, so holding several installations is a legitimate state. The
  enrollment records the one the preference surface manages. When that record
  is absent or stale — written before the column existed, or pointing at an
  installation that was later uninstalled — ownership falls back to the
  adoption rule: the installation on the org's current default Agent,
  otherwise the oldest. Changing the org default Agent does not move an
  installation the enrollment already owns.
- **Additional installations are inventory, not candidates.** They are
  reported so the migration can account for them. They are never adopted,
  paused, rewritten or deleted by this path, and they keep running on their own
  Agent.
- **Enrollment intent is not enabled state.** `morning_brief_enrollments`
  records a one-time installation intent. A `completed` enrollment only says
  which installation it bound; the delivery schedule owns whether the brief
  runs today, and an explicitly disabled automation stays disabled. An explicit
  opt-out (`cancelled`) is a user choice that migration must preserve rather
  than re-derive.
- **The thread binding is canonical.** The destination thread comes from
  `workflow_user_automation_threads` scoped to the same org, user and
  workflow — never from a thread title, and never from another owner. `null`
  means the brief has not delivered yet, which is normal before the first run,
  not a failed lookup. Deleting that thread pauses its automation; migration
  must not resurrect it.
- **Failure is not emptiness.** A read that throws propagates. Nothing in this
  reader converts a dependency failure into "no brief", and nothing here
  writes.

## Automatic enrollment retries

Initialization, onboarding, membership events and the enrollment worker share
the existing member advisory lock and durable enrollment retry fields. Intent
is recorded before checking the feature switch, timezone, default Agent and
accepted active workflow definition. Unknown eligibility is qualified once
against Clerk so historical members keep their ineligible preference state.
For a known eligible member, an unavailable local prerequisite does not repeat
that read or consume the external failure budget; the worker revisits it after
a minute, and an inline request can proceed as soon as the prerequisite arrives.

A first qualification or locally ready attempt claims a five-minute recovery
lease before reading current Clerk membership. Failed attempts retry after 1,
2, 4, 8, then at most 15 minutes, and inline requests honor the same deadline as
workers. Skipped requests do not extend an existing deadline. Explicit preference changes keep
their own immediate behavior. Membership qualification preserves its lease;
a new membership event or explicit choice invalidates an older retry writer.
Settings reads the preference on load; enrollment progress is not pushed to an
open page.

Deletion records the departed membership generation even when enrollment has
not started or an earlier live lookup already marked the member departed.
Replayed creation of that generation cannot revive enrollment.
A different live generation can qualify on a later ready attempt, including
when its creation webhook was missed. Installation still checks current
membership; local prerequisites and retry state never grant authority.

These changes reuse the existing schema and HTTP contracts. Old browser
initialization requests remain supported, and mixed older API workers may
retain the previous retry behavior until rollout completes. Rollback does not
require a data migration.

## Reading it safely

`loadMorningBriefMigrationState` is a composed read, not a transactional
snapshot. Its parts can move between queries. Callers that act on the result —
enabling, disabling, installing, or eventually claiming an occurrence — must
invoke it inside the transaction or advisory lock that already guards that
mutation, exactly as the preference surface does today.

## Migration boundary

- The cutover owns state that outlives this read: the Settings-owned
  installation and its schedule, explicit opt-outs, the bound thread and its
  history, and the automation's email delivery policy. It must revalidate
  ownership, membership and the user's current choice at the delivery boundary
  rather than trusting a view composed earlier.
- Account selection must stay stable. The legacy path resolves the destination
  thread's explicit connector account before the org default; a migrated brief
  must resolve the same account and must not silently fall back to another one
  when an explicit account is missing or revoked.
- `FeatureSwitchKey.NativeMorningBrief` (persisted/API key
  `simpleMorningBrief` for mixed-version compatibility) selects the
  implementation. During retirement stage 1 it has no enabled cohort, including
  staff; a data migration resets stored `true` overrides and the API refuses
  new ones. The key remains registered while the rollback drains. It is
  independent of `MorningBrief`, which remains the user-facing availability
  switch: turning the implementation switch on must never change whether a user
  has Morning Brief, and turning it off must not discard choices the user made
  while it was on.

## The installed preference projection

`morning_brief_installed_preferences` holds at most one row per
`(org_id, user_id)`: a copy of the `installed` state above, written by the real
Settings writers and read back by the real Settings reader
([#34693](https://github.com/vm0-ai/okou/issues/34693)). It is a persistence and
serialization rehearsal for the native pipeline, **not** an authority, an
execution record, or a cache that makes anything faster. The legacy installation
and its automation still decide everything; the legacy queries all still run.

`FeatureSwitchKey.NativeMorningBrief` remains registered for rollback
compatibility, but stage 1 disables its staff cohort and existing opt-ins. The
legacy installation stays authoritative after a verified rollback.

### What is copied, and when it may be used

The row stores `projection_version` plus the fields needed to reproduce and
check the managed installed state: the selected `workflow_id`, its
`automation_id` and `agent_id`, the bound `chat_thread_id`, `enabled`,
`cron_expression`, `timezone` and `next_run_at`. Nothing else — no source
bodies, prompts, results, credentials, usage or delivery attempts.

The Settings GET always loads and answers from the live canonical state first.
Only then, and only while the switch is on, may the projection supply the
response, and only when **every** field above still equals that live state and
`projection_version` is the version the reader understands. Anything else —
no row, an unsupported version, a different selected installation, a schedule
the scheduler advanced, a timezone an older binary changed — silently keeps the
legacy answer.

The row's own `updated_at` is not freshness evidence. Old API binaries, the
automation poller, catalog reconciliation and thread deletion all change the
legacy state without writing here, which is exactly why equality against a
freshly loaded state is the only accepted proof. GET itself never writes,
installs, repairs, backfills or creates a thread, and `absent`, `pending`,
`inconsistent` and pre-installation opt-out states never reach the projection at
all.

### Refresh is not atomic with the legacy write

Writers refresh the row after a successful preference update, after enrollment
completion or adoption, and after timezone synchronization. All three already
hold the preference advisory lock, so they serialize against each other, but
[that lock's transaction is not the legacy write's transaction](#reading-it-safely):
the legacy mutation runs on the outer `Db` and has already committed when the
copy starts.

The refresh therefore never pretends to be atomic. It re-reads the canonical
state inside its own bounded transaction, and if the copy fails, the failure is
reported operationally while the committed legacy outcome is still returned —
the user is not told a successful choice failed, and the mutation is not
replayed. A later read falls back to legacy and still shows that choice. An
expected skip (switch off, no installed brief, no membership parent) is recorded
separately from an infrastructure failure, so a failure is never recorded as a
healthy projection. Cancellation keeps propagating; a cancelled request does not
leave a detached write behind.

When the state is not `installed`, the refresh deletes the row instead of
copying, so no description of a state the reader cannot reproduce survives.

### What the concurrency evidence actually proves

Those claims are held up by forced interleavings rather than by ordering two
requests and reading the final state ([#34711](https://github.com/vm0-ai/okou/issues/34711)).
Test-only fixtures suspend or fail exactly one owner's write, and every
rendezvous is an observed arrival — `pg_blocking_pids`, or a committed public
response — never a sleep:

- **Membership cleanup versus refresh.** With the cleanup's `DELETE` held
  uncommitted, the refresher is observed waiting on that exact parent row while
  running its own `for key share` recheck; after the cleanup commits, the
  refresh skips and recreates neither row. In the opposite order the copy is
  held written-but-uncommitted while the cleanup queues behind that
  transaction, and the committed copy then leaves with the parent's cascade.
- **Toggle versus timezone.** Each ownership order suspends the lock holder at
  its projection write and issues the other request while it is held. The
  timezone request's own preference write commits and is publicly readable,
  which is the arrival evidence available for the preference lock: it uses
  `pg_try_advisory_xact_lock` with a retry delay, so a contender never waits on
  a PostgreSQL lock and never appears in `pg_blocking_pids`. A toggle performs
  no write before taking that lock, so its overlap rests on being issued while
  the holder is proven suspended, plus the reads showing it committed nothing
  until the holder released.
- **A failed copy after a committed choice.** A real Settings mutation is
  observed suspended at its projection write with its legacy choice already
  visible, then released into a real database error. The request still returns
  that choice, later reads keep it, the legacy automation is not replayed, and
  an ordinary later write succeeds once the fault is removed.

The limit is equally explicit: because a copy may answer a read only while it
still equals the legacy state, a fresh copy and a missing one are
indistinguishable through the API. Whether a refresh was `refreshed`, `failed`,
`skipped` or `cleared` is therefore asserted where that outcome exists, in the
projection service suite, not inferred from a response body.

### The deletion fence is a cache lifetime, not erasure authority

The row's lifetime is deliberately evictable:

- A composite foreign key to `org_members_cache(org_id, user_id)` with
  `ON DELETE CASCADE` covers today's membership, user, organization,
  auth-cache invalidation and cache-list refresh deletions. The refresh locks
  and rechecks that exact parent with `FOR KEY SHARE`, so a concurrent cleanup
  either waits for the copy and then cascades it away, or has already removed
  the parent and leaves nothing to write. **The refresh never creates or
  refills that parent.**
- Foreign keys to `agents(id)` and `chat_threads(id)` invalidate the copy when
  the owning Agent or the destination thread is deleted. Neither deletion
  creates a replacement thread or an enabled state; the legacy brief stays
  paused or uninstalled exactly as it does today.
- Native writes also pass the existing transaction-level
  [erasure admission](../turbo/packages/db/src/operations/account-erasure.ts):
  READ COMMITTED, sorted organization and user subject locks taken before any
  business row and held through commit.

The limits are as real as the guarantees. `org_members_cache` is a 60-second
read-through role cache, not a tombstone: a concurrent membership read can
refill it after a cleanup, and this projection's writer cannot prevent that.
[The Clerk erasure bridge is still unregistered](account-erasure-foundation.md),
so admission bounds this writer, not the world. None of this is global deletion
finality, and the presence of a row never authorizes executing a brief.

**Hard gate:** before native state becomes execution authority, this evictable
cache lifetime must be replaced with durable membership and erasure ownership.
Cutover must not inherit a disposable parent.

### What this slice does not do

It consumes no occurrence, claims no schedule, advances no due slot, and adds no
Run, Chat event, email, provider request or user credit operation. S3b owns
occurrence, attempt and lease state and lands with the first real S4 collection
executor; S4 owns source collection; S7 owns the complete preference and
enrollment materialization, the durable ownership above, and the cutover. The
production counts below are automation inventory: they are not a native-row
census, and they do not show that any preference has been migrated.

## The legacy schedule claim journal

The legacy poller destroys the occurrence it fires. It clears `next_run_at`,
stamps the poll clock into `last_run_at`, and only afterwards creates the queue
event and the Run. Nothing records which scheduled instant that work belonged
to, so a completion callback can advance the schedule twice, or advance it after
a newer execution already took ownership. Comparing `last_run_id` cannot fix it:
that column is written after the Run transaction returns.

`morning_brief_schedule_claims` records the occurrence the poller actually
claimed. One row is written per fired occurrence, inside the transaction that
clears `next_run_at` and inserts the queue event, holding:

- the authenticated owner, organization, workflow and automation;
- a server-generated execution identity and the exact pre-claim `next_run_at`
  as `scheduled_anchor_at`;
- a monotonic `claim_sequence` and the actual `claimed_at` poll clock;
- the exact original queue event and, once the launch transaction creates it,
  the exact Run;
- a bounded queue disposition and a bounded settlement state and time.

`(automation_id, scheduled_anchor_at)` is unique, and the queue-event and Run
bindings are unique where present, so retrying the same admission can never
produce a second occurrence, queue item or Run binding. `fired_at` keeps its
existing meaning: it is the real fire time, never relabelled as the scheduled
instant.

Only the installation this document's canonical selection reports as a member's
installed Morning Brief is journaled. Additional installations, manual runs and
every other automation kind keep their existing untracked behavior, and the
journal activates no native work: the `FeatureSwitchKey.NativeMorningBrief` switch is not
consulted here at all. The table is additive and unconditional — it has no
feature-gated creation, and it is written only on the legacy path.

### What the claim sequence does and does not prove

The highest `claim_sequence` for an automation is the current claim. A callback
from any lower sequence settles nothing. That fences newer journaled claims
only. It does not prove that Settings, enrollment, reconciliation, a generic
enable/disable, a thread deletion and recreation, or a rollback writer did not
replace ownership and restore the same values in between, so it is not a
complete schedule-replacement or ABA fence. S7b has to make those writers
consume a durable owner and revocation epoch together with the current user
choice.

### Settlement

One operation advances the schedule. The completion callback and the outer
pre-run failure path both call it. Under the automation and occurrence row
locks it verifies the exact execution or Run binding, that the occurrence is
the current claim, that it is still unsettled, that the automation is enabled,
and that `next_run_at` is still NULL. It then reads the current schedule and
timezone, applies the existing recurrence and failure policy, and commits the
schedule update and the settlement together.

The recurrence clock is sampled after those locks, never at arrival. Waiting on
a real schedule writer can outlast a cron boundary, and an instant read taken
before the wait would publish a successor that is already in the past and fire
again immediately.

The late `last_run_id` write that follows the launch transaction has the same
shape of hazard and the same answer. It cannot be expressed as one UPDATE with a
"no newer claim" subquery: under READ COMMITTED a statement keeps the snapshot
it started with, so an UPDATE that begins before a newer claimant commits, waits
on the automation row and then proceeds would still evaluate that subquery
against its pre-wait snapshot and overwrite the newer value. The write therefore
takes the automation row lock first and re-reads the current claim in later
statements, which observe everything the wait let through.

That makes a duplicate callback, a failed-Run callback overlapping the outer
pre-run error path, and a callback from a superseded claim all no-ops. A user
action that already published a non-null `next_run_at` keeps that schedule, and
a timezone edited while the claim was active is the timezone its own completion
uses. Insufficient-credit handling and the existing failure-count and
auto-disable behavior are unchanged.

### A tick without a claim has no schedule authority

Two ticks can resolve the same due row. The one that loses, or that fails at the
queue admission boundary before any claim exists, must not behave like the old
unjournaled writer: that writer computes recurrence and failure counts from its
own stale snapshot and updates by id and enabled state alone, so it could
republish a schedule the winner already consumed, raise a failure count or
disable the automation the winner owns.

A journal-aware tick that failed before acquiring a claim therefore restricts
its failure update to the exact unconsumed occurrence it resolved. Absence of a
local claim id is not mutation authority. Genuinely unjournaled legacy ticks
pass no such restriction and keep their exact previous behavior, and a tick that
did acquire a claim settles through the shared settlement operation instead.

### Compatibility branches and their removal gates

- **Unjournaled callback.** A callback whose Run has no journal binding keeps
  the exact previous behavior. It carries no journaled protection and never
  infers an anchor for an execution it does not recognize. Remove it when no
  unjournaled legacy execution can still call back.
- **Untracked pending event.** A coalescing tick that finds a pending event
  belonging to no recorded occurrence does not attach its anchor to it and does
  not consume the schedule. `next_run_at` keeps the same due instant and the
  existing cron rereads the row on its next tick. Remove it when every pending
  legacy event is journaled.
- **Old code, new schema.** The table is additive, so an API instance running
  older code during a rolling deployment ignores it and keeps claiming and
  settling unjournaled work through the path above. This slice gives forward
  identity on the new path only; it does not make a mixed fleet safe for native
  activation. Native switch rollback stays a later protocol and cannot simply
  re-enable the legacy path alongside unresolved native work.

### Evidence lifetime

Rows are content-free execution and dedupe history: no prompt, provider payload,
result, email address, credential or free-form error string is stored. There is
deliberately no shorter TTL: deleting a row while its callback can still arrive
would restore exactly the double-advance this table prevents, and losing a known
record must never reclassify it as an old untracked execution that may advance
again. Nothing here authorizes historical deletion or backfill, and missing
historical evidence is not proof of a drain. S7b and S9 have to account for this
retained history before removing it.

Two removal paths exist, and the `automation_id` cascade is not sufficient on
its own. `workflows.owner_user_id` and `workflow_automations.owner_user_id` are
plain text with no users foreign key, and user cleanup only cascades the Agents
the departing user owns, so a member whose Morning Brief runs on a colleague's
shared or default Agent would otherwise keep both the automation and this
journal after deletion. `revokeMorningBriefScheduleOwnership` therefore runs at
the same owner, organization and membership revocation points the rest of
Morning Brief already uses:

- the `automation_id` cascade removes occurrences with their automation,
  including uninstall;
- owner, organization and membership revocation scrubs that scope's
  occurrences: `org_id` and `owner_user_id` become NULL and the settlement
  becomes the terminal `revoked`.

Revocation deliberately scrubs rather than deletes. Deleting would make a
callback that is still in flight look like an execution this table never
recorded, which is exactly the untracked legacy branch that may advance a
schedule. What survives is content-free — automation, workflow, occurrence
identity and timestamps — and its terminal settlement makes any later callback a
no-op. No automation, workflow or other owner is touched, which is what keeps
other Morning Brief surfaces unchanged.

### Executed boundary evidence

The focused API regression suite drives the production cron route, shared queue
drain, Run transaction and callback dispatcher against PostgreSQL. It observes:

- two real launchers reaching the same queue claim, with one Run and one binding;
- a PostgreSQL `AFTER INSERT` fault rolling the Run and its earlier journal
  binding back together;
- the Pi launch composition reaching its API-first ownership transfer with the
  same bound occurrence;
- a completion callback settling after the Run transaction commits but before
  the late `last_run_id` write starts;
- a failed-Run callback whose first settlement is rolled back by PostgreSQL,
  then retried while the outer pre-run failure enters the same settlement
  operation;
- the untracked pending-event compatibility branch being consumed through the
  shared queue drain before the next real cron tick journals recovery; and
- three journaled failures preserving the legacy auto-disable threshold.

The generic scheduler regression suite remains the authority for unchanged
insufficient-credit behavior: credit failures neither increment the failure
count nor disable recurring schedules. At a representative retained-history
scale of 80,000 rows (slightly above one year at the measured 215 daily
schedules), PostgreSQL uses the dedicated owner-user index for global user
erasure, the org-leading owner index for membership erasure, and the sequence
index for the current-claim read. These are executed boundaries, not an
assertion that `claim_sequence` is the later S7b choice or rollback epoch.

### What this slice does not do

It does not transfer Morning Brief to native execution, create a Run for the
native pipeline, change legacy billing, or establish a native user-choice
authority. It adds no email disposition field and does not touch the outbox: a
late result callback can still create fresh email and a provider request can
already be in flight. Global callback and outbox counts are not drain proof.

## Observed production scale

A paginated MaskDB read on 2026-09-16 at 09:50:15–09:50:17 UTC, including
internal accounts, found 167 `daily-delivery` automations — 160 enabled, 7
disabled — across 166 `(org_id, owner_user_id)` pairs and 163 organizations.
One owner holds two installations and both are disabled. Historical automation
contexts identify 143 distinct destination threads for 143 automations; 24
automations have no context. All 167 are reconciliation-current with result
email enabled.

A second paginated read on 2026-09-16 at 12:01:06–12:01:07 UTC, on the same
all-production scope, found 168 `daily-delivery` automations — 161 enabled, 7
disabled — across 167 `(org_id, owner_user_id)` pairs and 164 organizations, all
reconciliation-current with result email enabled.

`morning_brief_enrollments` and `workflow_user_automation_threads` are not
exposed in MaskDB, so pending-enrollment counts and canonical thread bindings
are unverified. Historical context counts are a lower bound on threads, not a
count of those tables. Re-measure through supported application or database
tooling before a cutover depends on these numbers.

Neither read is a count of `morning_brief_installed_preferences`, which starts
empty and needs no historical backfill: it is filled only when a member's own
Settings writer runs while the implementation switch is on.
