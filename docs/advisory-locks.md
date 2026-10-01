# Retiring PostgreSQL advisory locks

Starting **2026-09-26**, Okou is progressively removing PostgreSQL advisory
locks. Do not introduce new advisory locks. Existing call sites are temporary
cleanup work; remove them as their business invariants move to database
constraints, atomic SQL, or a smaller transaction over the affected rows.

## Bootstrap seed IO and key retirement

The bootstrap follow-up to #37415 removes the `org_bootstrap` SQL acquisition
helper, its two publication/compensation entrances and its exemption. Its
replacement is not a lock table or another lock held across IO: each attempt
uploads a private unregistered Storage generation, then a short transaction
arbitrates the canonical owner/name with its existing unique index and takes the
actual parent directly `FOR UPDATE` before a fresh default-Agent decision.

A peer's committed default or incumbent HEAD is preserved. Only an empty parent
with no registered versions may be replaced under that ownership; an invalid
retained-version/null-HEAD state fails closed. Candidate publication and
Agent/metadata/entitlement/credit finalization commit together. Compensation
arbitrates only its captured candidate identity after an uncertain commit and
never deletes a live parent or adopts a replacement. Exact losing-prefix
inventory uses the existing bounded, lease-fenced cleanup worker, with no
provider calls inside the publication or compensation transactions.

This removes one literal acquisition site; the dated inventories below are
historical snapshots, not updated production counts. Supported old writers must
include #37097's parent-first/fresh-default and exact-generation compensation
preparation. Pre-preparation writers require a serving/in-flight drain and
rollback exclusion by the release owner. Source retirement is not evidence that
this deployment gate passed. See the
[compatibility matrix](deployment-compatibility.md#bootstrap-private-generation-publication-and-advisory-retirement)
and [publication proof](storage-version-publication.md#bootstrap-seed-publication).

## Why we are removing them

Advisory locks have been overused for problems that a unique index or a simple
SQL statement already solves: preventing duplicate creation, updating a value,
claiming queued work, or reconciling one resource. In these cases the extra
lock adds a second coordination protocol without strengthening the data model.

Every writer must know the same advisory key and acquire locks in the same
order. An unrelated writer can bypass that convention. Broad organization or
global keys serialize independent requests, keep transactions and connections
open while waiting, and make deadlocks harder to reason about. Holding a lock
across provider calls also makes database contention depend on network latency.

Put each invariant at the smallest boundary that can enforce it. PostgreSQL
still takes the row and index locks required by normal SQL; this policy retires
application-defined advisory locking, not transactional consistency.

## Choose a replacement

| Required behavior                               | Preferred approach                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At most one row for a business identity         | A primary key or unique index over the actual identity, including tenant scope where appropriate. Use `INSERT ... ON CONFLICT` for the intended duplicate outcome.         |
| Create a resource if absent                     | A unique constraint and an atomic insert/upsert. Let the database arbitrate concurrent creation.                                                                           |
| Increment a counter or reserve positions        | `UPDATE ... SET value = value + delta RETURNING ...`, or an atomic upsert that initializes and increments the owning row.                                                  |
| Only one request may perform a state transition | `UPDATE ... WHERE state = expected_state RETURNING ...`; only the request that changes the row owns the transition.                                                        |
| Reject an edit based on stale state             | A version predicate in the update, incrementing the version on success. Return the existing conflict result when no row matches.                                           |
| Change several rows under one invariant         | First look for a constraint or one statement. If necessary, use a short transaction and lock the existing row that owns the invariant in a consistent order.               |
| Multiple workers may process independent jobs   | Atomically claim durable job rows. `FOR UPDATE SKIP LOCKED` can select an available job when processing a different job is valid.                                          |
| Avoid duplicate provider effects                | A durable operation identity, a transactional outbox where needed, and the provider's idempotency key where supported. Keep network work outside the database transaction. |
| Enforce a product limit                         | Decide whether the limit is soft or strict. A soft limit can use the current count. A strict limit needs an atomic reservation or a transaction over the quota owner.      |

These are design choices for the actual contract. Do not mechanically replace
every advisory lock with `FOR UPDATE`, a new lock table, an in-memory mutex, or
a distributed lock in another service.

## SQL examples

The following use illustrative tables and parameters. Use the repository's
Drizzle APIs and bound values when implementing them.

### Deduplicate using the business key

Assume all three identity columns below are `NOT NULL`:

```sql
CREATE UNIQUE INDEX webhook_receipts_event_key
ON webhook_receipts (org_id, provider, event_id);

INSERT INTO webhook_receipts (org_id, provider, event_id)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, provider, event_id) DO NOTHING
RETURNING id;
```

A returned row identifies the request that inserted the receipt. An empty
result means the event already exists. Commit the receipt and any corresponding
business changes or durable outbox work in the same transaction, so a failed
attempt cannot consume the identity without recording the work.

Choose the unique key from the business contract. Account for nullable keys,
case normalization, and soft deletion explicitly. A preceding existence check
does not prevent another request from inserting the same key. Handle the
specific intended conflict; do not swallow unrelated constraint failures.

### Update from the stored value

```sql
UPDATE counters
SET value = value + $2
WHERE id = $1
RETURNING value;
```

This avoids reading a value into application code and later overwriting a
concurrent increment. If initialization is required, use an upsert with an
increment expression. Atomic arithmetic alone does not deduplicate repeated
requests; retain a business idempotency key when the operation requires one.

### Let the state transition select the winner

```sql
UPDATE jobs
SET state = 'claimed'
WHERE org_id = $1
  AND id = $2
  AND state = 'queued'
RETURNING id;
```

Only the caller receiving the row owns this claim. A caller receiving no row
follows the existing already-claimed or unavailable result. Persist dependent
work in the same transaction. Durable worker claims also need explicit crash
recovery; changing a status does not guarantee that a worker will finish.

For optimistic edits, the same pattern can use `WHERE version = $expected`
and `SET version = version + 1`. Keep authorization and ownership predicates
in the write as well as in the API boundary.

### Keep a multi-row invariant on its owner

When one statement cannot express the operation, lock the existing owner row,
validate the invariant, and change its dependent rows in the same short
transaction. All participating writers must follow the same row-lock order.
Reuse a row lock the transaction already holds instead of adding another
coordination layer.

A row lock cannot protect a row that does not exist. Use a unique constraint
to arbitrate creation. Likewise, a transaction containing `COUNT` followed by
`INSERT` does not by itself enforce a strict capacity limit under concurrent
requests. Use an atomic quota reservation when strict capacity is required.
Accepting occasional overshoot is a product decision for a soft limit; it is
not a general replacement for billing or authorization invariants.

`SKIP LOCKED` is appropriate only when skipping busy work preserves the
contract. It must not silently skip required billing, deletion, or lifecycle
work. A database transaction also cannot atomically commit a remote provider
effect: keep a durable operation record and the recovery semantics required by
that provider.

## Retire existing calls progressively

For each removal, identify the user-visible invariant and all production
writers, including callbacks and background jobs. Check the existing schema
and transaction first: many callers already have the necessary primary key,
unique constraint, conditional write, or row lock.

Land any genuinely necessary constraint before relying on it. Preserve
tenant scope, idempotency, rollback behavior, and the supported old/new writer
combinations described in [deployment compatibility](./deployment-compatibility.md).
If a remaining lock protects a real multi-row invariant, describe that
invariant and its replacement before removing the call.

Remove obsolete lock helpers, test hooks, and migration acceptance utilities
with their callers. Retire a backfill tool or compatibility fallback based on
its completed data and rollout conditions. A CI reference alone does not prove
that an operator tool is still needed. Preserve shipped migration history.

Do not hide unresolved ordering with `NOWAIT`, lock retry loops, larger
timeouts, or a new fallback. Simplify the invariant and transaction boundary.

## Testing the resulting behavior

Follow the [testing guide](./testing.md): construct API state through production
endpoints and assert responses or state available through production endpoints.
Concurrent requests can verify one resource, one accepted transition, correct
amounts, permissions, cancellation, and the specified duplicate outcome.

Do not hold production advisory locks in a test, inspect lock waiters, install
temporary blocking triggers, or add internal gates solely to force an
interleaving. Do not assert that a particular lock was acquired. Tests whose
only contract is that implementation detail should be removed with their
fixtures. A change in synchronization should not break a test when the
user-visible contract remains the same.

## Lint enforcement and initial inventory

`api/no-new-advisory-lock` is enabled for API and DB TypeScript source and
scripts in their ESLint configurations. It rejects literal PostgreSQL advisory
lock and unlock function calls, including try/shared/transaction variants.
Existing calls have individual next-line exemptions marking them as
pre-2026-09-26 stock. These exemptions identify cleanup work; do not copy them
onto new calls or expand them to files or directories. Remove an exemption
when its call is removed.

This is a lexical rule. Standalone SQL migrations, dynamically assembled
function names, and files outside the configured lint scope are not checked
by it. They remain subject to the same no-new-advisory-lock policy in review.

The first cleanup PR, [#36978](https://github.com/okou-ai/okou/pull/36978), has
the following source inventory at commit `f76ca2717067e29b6c36afcf6eeb32404dc701c5`
on 2026-09-26:

| Scope                                    | Acquisition call sites |
| ---------------------------------------- | ---------------------: |
| API production TypeScript                |                     55 |
| Official-workflow catalog test isolation |                      1 |
| Billing-attribution operator backfill    |                      1 |
| **Total**                                |                 **57** |

This counts literal acquisition sites in API/DB TS/JS files, not distinct lock
keys or runtime acquisitions. It excludes comments, unlocks, lint-rule fixture
strings, and SQL migration files. Six acquisition sites in shipped SQL
migration files are outside this inventory; it is not a census of installed
database functions. The table is a dated PR snapshot, not a claim that all
remaining calls are necessary or that the cleanup has already shipped.

## Follow-up cleanup in PR #37009

[PR #37009](https://github.com/okou-ai/okou/pull/37009), as prepared on
2026-09-26, reduces the main-branch inventory from 56 acquisition sites to 46:
44 API production sites, one catalog test-isolation site, and one attribution
operator-tool site. The ten removed SQL sites belong to VNC creation, Banking
Connect, Feishu installation, canonical Agent mutations, five shared Official
catalog readers, and Social job admission. This is a proposed PR inventory,
not evidence of production deployment.

Additional caller removals do not delete the shared helpers themselves:
connector refresh failure; queue-head SELECT; screenshot UPSERT; four SSH
creation/deletion/reset entries; account rename; VNC defaults; and failed
Official installation cleanup. Private Agent creation and metadata-only edits
also stop entering the public quota key. Count these separately from literal
SQL sites and runtime key acquisitions.

The GA preparation covered Browser profile cleanup, automation destination
resolution, SSH creation-ID replay, export-job admission, built-in generation
quotas, and Official catalog publication/organization lock ordering. Seven
prepared keys retire in the follow-up below; reconciliation needs the additional
Morning Brief preparation described there. Their replacement protocols are in
[deployment compatibility](./deployment-compatibility.md#scoped-advisory-cleanup-and-owner-row-preparation-2026-09-26).
Do not infer necessity from the remaining count or from a test that waits for a
lock.

## Narrow cleanup and prepared-key retirement (2026-09-27)

Against main `931167c9d234821a3ffd186d7493058e92631cb3`, this batch removes
nine production acquisition sites, reducing the inventory from **46 to 37**:
35 production, one catalog test-isolation site, and one billing attribution
operator-tool site. The six historical SQL migration sites are unchanged and
counted separately.

Two removals cover failed Official Run persistence and installed Official
uninstall. They retain catalog and existing row/foreign-key protection without
entering the credit plan after Workflow rows. The other seven retire #37009's
prepared keys: Browser profile, automation destination resolver, SSH creation-ID,
export admission, generation admission, catalog publisher, and the Official
normal-admission organization site.

Two shared entrances are narrower without deleting another SQL definition:
only schedule automations acquire the queue-admission key, including manual
schedule execution; uncapped connector/check-in rewards skip the owner key and
COUNT while retaining exact reward deduplication. Do not add these runtime
acquisition reductions to the literal-site reduction.

Official copy gains exact private-name conflict recovery after complete
transaction rollback. Device authorization commits the exact session claim,
credentials, and completion marker in the same existing account transaction.
Their advisory keys remain until these new writer preparations cover serving
and supported rollback versions and outgoing requests drain.

The reconciliation organization key also remains. Morning Brief dormant
validation/finalization now take native authority before the Workflow, matching
the reservation/staging paths. This new row-order preparation must cover
serving and supported rollback writers before that key can retire; the already
deployed #37009 preparation does not contain it.

Production API 1.682.4 includes #37009's preparation. The rollback resolver now
requires its merge commit `c639e3397602b5c9b049315c7a99f5ed2e23e660`; the accepted
serving boundary and the separate copy/device/reconciliation preparation gates
are recorded in
[deployment compatibility](./deployment-compatibility.md#prepared-advisory-key-retirement-and-writer-preparation-2026-09-27).

## Single-statement and read-only entrances (2026-09-27)

Against main `da9c52cd2fccc1c278c96fc31a4f63dfeb577faf`, the literal inventory
remains **37**: 35 production sites, one catalog fixture and one attribution
operator site, plus six historical SQL migration sites counted separately.
This batch removes or narrows callers of shared helpers; it removes no SQL
acquisition definition.

| Scope                                        | Literal sites removed | Caller change                                                                              |
| -------------------------------------------- | --------------------: | ------------------------------------------------------------------------------------------ |
| Browser suspension and expired-claim release |                     0 | Two calls removed; six multi-step calls remain.                                            |
| Non-event-source connector selection clear   |                     0 | One call becomes conditional on the six automation source connectors.                      |
| Connector and check-in rewards               |                     0 | One redemption-helper branch skips locking for these two exact claim identities.           |
| Limited-free bootstrap finalization          |                     0 | One duplicate same-transaction call removed; three calls remain.                           |
| Allowance availability precheck              |                     0 | One credit-lock call becomes refresh-only; four direct callers keep the same precheck API. |
| SSH credential deletion                      |                     0 | No call removed; four owner-helper calls remain pending the ordering preparation below.    |

Browser's two writes retain their existing status and claim-time predicates.
Non-event-source selection clear retains exact selection deletion, parent KEY
SHARE protection and atomic generation invalidation. Connector/check-in grants
use the unique actor/quest/source claim, its existing row lock and transactional
credit idempotency; other reward identities retain their redemption protocol.
The bootstrap caller already holds the same key in the same transaction.
Allowance availability uses the existing single-query snapshot and only enters
the old refresh transaction for an expired entitlement. It does not reserve
allowance; window creation, actual admission and settlement retain their locks.

SSH create/update now prepare exact credential-FK error conversion after full
transaction rollback. Deletion still needs its owner key: a host can appear
after the no-reference check, and rotation locks hosts before the credential.
A lock-free DELETE could lock the credential while its RESTRICT check waits for
a rotating host, whose rotation then waits for that credential. Exact DELETE
predicates and FK-error conversion alone do not resolve this ordering cycle.
Keep the key until a consistent lifecycle ordering covers serving and supported
rollback writers, including in-flight operations.

Device authorization, Official copy and Official reconciliation keep their
separate preparation gates. On 2026-09-27, public `/api/build-info` reads from
both `api.okou.ai` and `api.vm0.ai` reported API `1.683.0` at
`d97a36a06c664b149d2598d5e14a12e7cbd4ea5b`, before #37057. A successful main
workflow or preview deployment does not prove those preparations have shipped.

## Constraint arbitration and redundant entrances (2026-09-27)

Against main `9e28a95b6b831aeccaa399bfd6e6d8c36725c230`, the next batch removes
the Get Started redemption SQL definition. The literal inventory changes from
**37 to 36**: 34 production sites, one catalog fixture and one attribution
operator site. The six historical SQL migration sites remain separate. No
migration is required; these counts describe source, not production deployment.

| Scope                              | Literal sites removed | Caller or branch change                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Get Started redemption             |                     1 | Remove the redemption helper and its one caller; the five remaining capped quest types no longer acquire reward/owner keys. Connector/check-in already skipped them.                                                                                                              |
| Calendar previous-channel cleanup  |                     0 | Remove one lifecycle call and its single-statement transaction; retain watch/current/previous channel CAS.                                                                                                                                                                        |
| Connector account cleanup          |                     0 | Remove two nested account-target calls and move custom deletion's first acquisition to its caller: net one fewer expression. Builtin deletion goes from two acquisitions to one, Calendar deletion from three to one, principal replacement from two to one; custom stays at one. |
| Bootstrap reservation precheck     |                     0 | Remove one call; final publication and compensation retain the other two.                                                                                                                                                                                                         |
| VNC standalone credential creation |                     0 | One entrance uses the existing three shared cleanup scopes without the exclusive owner acquisition. The owner SQL definition remains.                                                                                                                                             |
| Pi first-turn cancellation         |                     0 | Remove one preliminary lifecycle-wrapper call; four wrapper calls remain, including the final failure/cancellation arbiter.                                                                                                                                                       |
| Inline Social settlement           |                     0 | Remove one static compaction call and route the already-locked settlement through its body. Paid settlement goes from three shared compaction plus two credit acquisitions to one of each, in the same order.                                                                     |
| Official copy source snapshot      |                     0 | The existing organization-key expression becomes publication-only: two transaction entrances become one. The final publication key remains.                                                                                                                                       |
| SSH credential deletion            |                     0 | Prepare parent-row protection and revision DELETE RETURNING; keep deletion's owner call pending rollout, alongside the other three callers.                                                                                                                                       |

Get Started retains its own claim row lock and atomically commits credits with
the granted claim. Existing reward-key, beneficiary/quest/slot, and Slack-org
unique constraints arbitrate competing claims. A savepoint covers the entire
grant, including credits; only those exact unique conflicts are interpreted
after rollback. Reward identity takes precedence over quota exhaustion.
Invitations try each available slot in the existing 1..15 domain at most once,
across all organizations for that beneficiary. This is bounded allocation of
business slots, not retrying lock failures. Other database errors propagate.

The narrower callers retain their existing state predicates, cleanup scopes,
final arbiters and first-acquisition order. Social still takes shared compaction
protection before its job row, then organization credit protection. Standalone
settlement retains its lock-taking entry and committed telemetry. Official copy
retains catalog/source row protection and exact source revalidation before any
publication. Its full-key retirement, Device auth and Official reconciliation
still have the separate rollout gates above. SSH preparation and the supported
mixed-writer boundaries are described in
[deployment compatibility](./deployment-compatibility.md#constraint-arbitration-and-narrower-advisory-entrances-2026-09-27).

## Soft limits and prepared-key retirement (2026-09-27)

Against main `6b624e6e1b23a45386db5c07f9b21a8ffdd8af9f`, this batch removes
five acquisition SQL sites: **36 to 31**, comprising **29 production**, one
catalog fixture and one billing-attribution operator site. The six historical
SQL migration sites are unchanged. Copy and reconciliation contain separate
SQL sites for the same organization key; this inventory counts the sites.

| Removed SQL site         | Preserved behavior                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public Agent quota       | COUNT prechecks reject an already-full organization. The seven-Agent limit is soft: concurrent requests may exceed it. Permissions and uniqueness stay. |
| Official Workflow copy   | Catalog/source row protection, source revalidation, private-name uniqueness, complete rollback conflict recovery and unpublished-volume cleanup.        |
| Device authorization     | Existing account-target transaction, exact polling claim, credential persistence and completion marker. Provider work stays outside the transaction.    |
| Official reconciliation  | Existing native authority, Workflow and Automation/identity protection in that order, with revision and lineage conditions.                             |
| Schedule queue admission | Best-effort pending-event coalescing, exact occurrence claims, event identity, transactional source transitions and the existing FIFO/Run claim.        |

Public Agent capacity and pending schedule coalescing no longer require strict
cross-request serialization. Schedule admission still checks for a pending item
before insertion, but concurrent legitimate triggers can both enqueue and run.
Each resulting Run follows normal admission and billing. Ordinary cron retains
its exact `nextRunAt` conditional claim; journaled Morning Brief retains its
atomic occurrence claim and queue-event binding. This does not permit duplicate
consumption of one occurrence or one event.

Five additional business entrances stop acquiring a shared helper's advisory
key, without removing another SQL definition:

| Entrance                            | Retained protocol                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| SSH credential deletion             | Exact parent row protection, fresh READ COMMITTED reference check, revision DELETE and precise host-FK recovery.    |
| VNC Agent access update             | All three shared cleanup scopes and the existing Agent row protection.                                              |
| VNC thread override clear           | Ownership checks and exact selection DELETE; override SET retains its lifecycle entrance.                           |
| Calendar registered-watch retention | Exact watch/channel conditional UPDATE, transaction and post-write cancellation check.                              |
| Pi provider preflight               | Read-only eligibility checks; result publication, fallback, cancellation and input reservation keep their protocol. |

The former Pi preflight transaction ended before starting the provider request;
the preflight never reserves provider execution. Browser publication and the remaining
SSH/VNC owner operations need further conditional-write preparation and are
outside this batch. No new lock, constraint, migration or fallback is added.
Serving evidence and the enforced rollback floor are recorded in
[deployment compatibility](./deployment-compatibility.md#soft-limits-and-prepared-key-retirement-2026-09-27).

## Custom account, Browser and bootstrap preparation (2026-09-27)

Against main `6184cf9fc2ccad47a262a4efe9436393ed75c2ec`, this preparation
retains **31** literal acquisition sites: **29 production**, one catalog fixture
and one billing-attribution operator. Six historical SQL migration sites remain
separate. No acquisition expression is removed or narrowed in this preparation.

| Protocol                 | Retained SQL sites | Retained acquisition expressions | Prepared replacement                                                                                                    |
| ------------------------ | -----------------: | -------------------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| Custom account target    |                  1 |     4 custom-capable expressions | Existing definition protection, ordered account mutations, selection UNIQUE/FK arbitration and exact rollback recovery. |
| Browser thread lifecycle |                  1 |                                6 | Owned-thread partial UNIQUE, exact state transitions, atomic instance publication and claim-scoped failure cleanup.     |
| Limited-free bootstrap   |                  1 |                                2 | The actual instructions Storage parent, a fresh default-Agent check and compensation for the captured Storage identity. |

Custom account default changes and sibling promotion use `FOR NO KEY UPDATE`
in account-ID order. Only the account being deleted upgrades to `FOR UPDATE`,
before a fresh statement clears its selections. This allows selection FK
checks to finish without a promotion/selection lock cycle. Existing-thread SET
converts only the custom-selection FK violation after the complete transaction
rolls back. Initial-thread creation rolls back just that custom selection's
savepoint and preserves the existing missing-account omission contract.
Builtin event-source projection and its account-target protocol are unchanged.

Browser publication retains instance-before-logical statement order. Its
conditional logical transition must succeed in the same transaction as the
provider instance and screen; losing the claim rolls back all three and cleans
up the exact provider. A lost publication does not enter generic start-failure
cleanup. Fresh claims store millisecond timestamps explicitly so state
comparisons round-trip through the existing Date decoder. These timestamps
compare observed state; they are not a new globally unique attempt generation.

Bootstrap acquires the actual canonical instructions Storage before checking
whether a default Agent still needs publication. It captures the returned
Storage ID and S3 prefix before upload; rollback compensation cannot adopt a
replacement with the same name. Existing grant idempotency, permissions and
paid-tier behavior remain. The existing S3-in-transaction boundary remains;
acquiring the Storage earlier is not a shorter-transaction optimization.

These keys retire only after this new preparation covers the supported serving
and rollback writers and outgoing requests drain. That gate is separate from
earlier advisory preparations; see the [compatibility protocol](./deployment-compatibility.md#custom-account-browser-and-bootstrap-owner-protocols-2026-09-27).
After retirement, Custom removes one expression and narrows three shared
expressions to builtin targets; Browser removes six and bootstrap removes two.
That future change would remove three SQL sites, not twelve.

Invitation-email arbitration is outside this preparation. Its existing unique
index does not by itself preserve paid-purchase priority over an unpaid preview.
Chat usage display is also outside the scope.

## Schedule coalescing moves to the trigger (release 3)

The prepared-key retirement above already removed the
`chat_event_queue:<threadId>` key and left best-effort coalescing inside the
admission transaction. The unified chat queue removes that in-transaction
coalescing as well: enqueue upserts `queued_chat_threads` before appending the
input, pick claims the thread with a lease, and pick and steering consume an
input through its unique revoke edge. The schedule trigger revokes its old
unconsumed schedule tick when it enqueues (a journaled Morning Brief tick only
after its claim succeeds, in that transaction), so admission is generic and
holds no lock.
The literal inventory is unchanged. Mixed old/new API writers can add one extra
schedule tick during the cutover; see
[deployment compatibility](./deployment-compatibility.md#unified-chat-queue-release-3).
