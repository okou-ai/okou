# R1 key retirement

**R1 remains incomplete.** Database-handle propagation is not an acceptance
target. There is no merge, release or production-operation authorization.

## September 30 decisions supersede compatibility ordering

Ethan: “问题不大。我们流量很小别想着版本升级期间的事儿了”, followed by
“这都问题不大，大不了就是主机连不上。但下次再连就能通就行” and
“是的。跟钱无关的基本都可以这么搞”.

- Nonfinancial configuration needs no concurrent-operation protection. A failed
  operation/connection can recover by saving again, reconnecting or the next
  scheduled task. Do not replace a removed key with CAS, savepoints, row locks,
  empty writes, loops or a compatibility protocol solely to serialize it.
- Existing owner authorization, primary/foreign keys and unique identities
  remain. Do not create permanently dangling references.
- Financial operations still need unique receipts, conditional financial
  writes, atomic counters, provider idempotency and reconciliation. Small
  rolling-version anomalies must not become unrecoverable duplicate charges.
- Do not retain any new advisory acquisition for old versions. The two-release
  migration/trigger retirement plan remains; lock compatibility gates do not.
- No new tables/fields/JSON coordination state/triggers. External I/O is outside
  transactions; db/tx propagation is a non-goal.

## Per-key inventory

Initial inventory: **17 API + 1 operator** definitions. At `0ea5f20d`:
**6 API + 0 operator**. Now: **2 API + 0 operator** after credit, invitation and serving
compaction retirement; shared/exclusive compaction counted separately before
removal. A later main integration must recheck any imported definitions. No nonfinancial advisory definition remains.
Deleting a key does not certify all earlier nonfinancial replacement machinery
removed; that simplification remains explicit R1 implementation work below.

| Key                                        | Current state / behavior                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                    | **Deleted.** Stripe customer creation is outside SQL with the existing shared organization idempotency key; local missing-binding UPDATE and organization PK arbitrate new financial writers. Fast-path binding reads are unchanged.                                                                                                                                                                                                        |
| `stripe_concurrency_subscription:<id>`     | **Deleted.** Timestamp/xmin publication and invoice-line uniqueness remain; daily 24-bucket observation repair uses the existing hourly billing cron. This does not complete desired concurrency configuration or duplicate-charge recovery.                                                                                                                                                                                                |
| `usage_pack_billing:<org>`                 | **Still present, R1 financial work.** Plan/migration/legacy Plan/concurrency/cancel/restore and last-member/deferred changes are not all declarative. No outgoing-version-only exemption is claimed.                                                                                                                                                                                                                                        |
| `usage_pack_invitation:<purchase>`         | **Deleted.** Conditional purchase/acceptance/refund transitions, immutable PaymentIntent/paid-amount publication, invitation/allocation uniqueness, grant receipts and refund-attempt provider idempotency arbitrate per-purchase work. Organization-level projection remains separate unfinished R1 work.                                                                                                                                  |
| `billing_purchase:<org>`                   | **Still present, R1 financial work.** Local-first claims still need common Plan/pack arbitration and recoverable duplicate payable-subscription handling. Not an R2 drain gate.                                                                                                                                                                                                                                                             |
| `credit_<org>`                             | **Deleted.** Exact window identity uses existing unique-index insertion and one committed-winner read; original-anchor selection retains allowed historical overlap. Consumption/grant/lot publication is conditional with complete-write checks; wallet debit and expiry use arithmetic. A rejected financial snapshot rolls back once and remains for the next existing settlement cycle.                                                 |
| `usage_event_compaction` shared            | **Deleted.** Settlement claims pending rows conditionally; compaction consumes only actual version-matching DELETE RETURNING rows and publishes their immutable totals in the same transaction. Raw-first cleanup sees committed rollups in its next SQL snapshot.                                                                                                                                                                          |
| `usage_event_compaction` exclusive         | **Deleted.** No compactor reads/replaces old hourly fragments or selects rows FOR UPDATE. A competing batch may consume zero; the next normal cron visit handles the remainder without an in-process retry.                                                                                                                                                                                                                                 |
| `usage_event_compaction` operator          | **Deleted.** Existing `--migrate --ack-writer-drain` operator opt-in and one conditional business-checkpoint UPDATE; rejected batch rolls back once, without retry. No serving compatibility acquisition remains in the script.                                                                                                                                                                                                             |
| `org_bootstrap:<org>`                      | **Deleted.** Prepared R2 storage is outside SQL; default Agent publication uses the existing default field, and losing candidates are cleaned up. Onboarding credits retain their separate unique receipt/financial protocol. No rolling-version fence.                                                                                                                                                                                     |
| `morning-brief-native-owner:<org>:<user>`  | **Deleted.** Native owner reads and first materialization no longer acquire an absent-owner key or explicit native-row locks. Existing owner/occurrence uniqueness remains. Preference/materialization races may recover through another save or scheduled task. Native/enrollment/timezone xmin guards and materialization's empty timestamp write are also removed; other prepared authority paths still need their simplification audit. |
| `morning_brief_preference:<org>:<user>`    | **Deleted.** Both preference entry points and timezone changes no longer run a wait-only compatibility transaction. Clerk remains outside local SQL.                                                                                                                                                                                                                                                                                        |
| `ssh_connection_owner:<org>:<user>`        | **Deleted; no concurrency protection required** (Ethan, September 30). Credential and host edits use ordinary owned UPDATEs, not commit-time revision/generation CAS; losing credential-CAS rollback of all host increments is removed. Generation/revision arithmetic remains normal invalidation metadata. Existing credential-owner FK and resource PK prevent dangling references. See below.                                           |
| `model-policy:<org>`                       | **Deleted.** Repair, settings replacement and onboarding use ordinary finite SQL with existing model/default uniqueness and route FKs. Concurrent low-frequency settings may fail; another save recovers. No new policy-set fence.                                                                                                                                                                                                          |
| `workflow_watch:gmail:<scope>`             | **Deleted.** `users.watch` is outside SQL; conditional local publication follows. New writers never call mailbox-wide `users.stop`. The rolling old-stop notification gap is now accepted; no forced R2 renewal or compensation is added.                                                                                                                                                                                                   |
| `connector_state:<org>:<user>:<slug>`      | **Deleted.** Removed selection/default/Official reconciliation and all automation binding/copy acquisitions, plus the shared projection wrapper and SQL definition. Existing account/selection uniqueness, owned FKs and projection repair remain; earlier savepoint/CAS coordination needs simplification, not R2 compatibility.                                                                                                           |
| `model_provider_state:<org>:<user>:<type>` | **Deleted.** Provider save/delete use existing provider identity; refresh no longer acquired it already. No outgoing-version fence.                                                                                                                                                                                                                                                                                                         |
| `connector-mcp-oauth`                      | **Deleted.** DCR registration publication/retirement, OAuth exchange/refresh and connection publication no longer acquire it. Existing registration uniqueness and binding FKs remain; HTTP/KMS stays outside SQL.                                                                                                                                                                                                                          |

Six application billing triggers remain. They require actual replacement;
there is no permanent trigger exemption or third release assumption.

## Credit key retirement

`orgCreditCompatibilityLockSql`, its briefly renamed `orgCreditLockSql`, the
`lockOrgCredits` helper and every actual acquisition are deleted. This covers
Run activation in both direct and Pick launches, firewall backfill, standalone
and Social settlement. No parent/entitlement SELECT lock replaces the key.

Both initial Run-window issuance and firewall Run-window backfill now use the
existing `(entitlement_id, kind, starts_at)` unique index with `ON CONFLICT DO
NOTHING`. A missing INSERT result resolves that exact committed identity once,
with its current consumed balance; it does not repeat INSERT, reset consumption,
loop or introduce new state. Disappearing identity rejects the operation. The
settlement planner already conditions its monetary writes and rejects incomplete
window/allocation counts with the batch left for the next settlement cycle.

The public firewall regression sends three concurrent admissions for one BYOK
Run, observes exactly two zero-consumption windows through billing status, then
settles usage, verifies both windows consumed exactly two units, and verifies
subsequent admission is denied rather than refilling allowance. Credits and
visible settled usage retain exact assertions. This verifies ordinary business
outcomes without a key; it does not assert which exact unique-conflict branch
won the interleaving.

**Correction to the earlier different-anchor inventory.** Existing allowance
semantics explicitly select the latest covering window per kind and permit
historical overlap (see the existing allocator and usage-boundaries inventory).
Even a serialized late older anchor can issue a historical window before a
later window's start. Exact-start uniqueness is not a global non-overlap promise;
adding range exclusion or wall-clock bucketing would introduce a different
product rule and can permanently defer legitimate late usage. Neither is added.
Original Run anchors, per-window unit limits and immutable allocations remain.

Settlement owns pending events through a conditional processed transition. It
compares every planned window insert, consumed-window update, allocation receipt,
grant deduction and expiry-lot deduction against the actual affected count. A
short write rolls back the entire financial batch and leaves it for the next
existing settlement cycle, without retry. Window consumption compares the
observed counter/limit before publishing its exact delta; wallet debit and lot
expiry retain atomic arithmetic. Different historical windows are not combined
into a new global budget or reported as a new grant. The financial contract is
per selected window/receipt, not an invented non-overlap constraint. Production
legacy convergence remains unproven and separate from source retirement.

## Key-free allowance refresh inside the Pick graph

The three claim-owned allowance refresh nodes no longer call `lockOrgCredits`.
The ordinary allowance object's refresh, direct availability refresh and public
availability command also remove their acquisitions: six actual refresh call
sites. `api_billing_allowance_org_lock_wait` is deleted from these paths, not
reported as a zero-valued lock wait. Availability window reads take no explicit
row lock. The helper is now `resolveAvailabilityInTransaction`, not a locked
transaction abstraction.

These paths only refresh existing entitlement facts and read availability; they
never issue windows or deduct balances. Stripe preparation completes before
SQL. Publication matches the observed entitlement snapshot and rejects a stale
result; a short row count throws and rolls back once, so no admission uses an
uncommitted stale refresh. No retry, new state or fence is added.

The Pick diff is limited to deleting these acquisitions/timings and renaming
the local helper. Factories still take business identities only and return the
same objects; the authorized resource `Promise.all`, computed runner arguments,
10-second lease and parent pending transaction are unchanged. No pending SQL or
sequence/queue lock order changes. Admission errors still reject before commit.

The later issuance/settlement changes above now retire the `credit_` definition
and its remaining calls as well. No serving/in-flight/rollback compatibility
gate is retained.

## Serving compaction retirement

Both advisory definitions, every settlement/deletion/cleanup acquisition and the
lock-scope fixture adapter are removed. Candidate, Run and attribution reads
have no explicit locks. The one financial mutation statement deletes only
version-matching processed raw rows and uses `DELETE RETURNING` as its sole
source of quantity, charged credits, allowance units and window identities.
Canonical missing identities are captured only for consumed facts; conflicts
use `ON CONFLICT DO NOTHING`, not an empty UPDATE. A missing required identity
rejects and rolls back the batch. Hourly publication depends on that capture,
so the retained triggers are not used to supply omitted identity.

Each batch stays at most 500 raw rows and appends immutable hourly fragments;
old fragments are neither read nor rewritten. Complete source/insert totals
and window checks remain. A stale competing delete consumes zero and publishes
no duplicate fragment. The next ordinary cron visit processes residual rows;
there is no local retry. Ordinary statement/FK failures roll back all financial
mutations and follow the cron's existing failure path. No successful convergence
is claimed for an aborted batch.

Cleanup deletes raw rows before hourly rows. When compaction won a raw row,
cleanup's following READ COMMITTED DELETE sees its newly committed fragment;
when cleanup won, compaction consumes no raw source and creates no fragment.
Public scoped cron API tests retain exact financial/storage totals, verify
same-hour fragments and identities after live Run deletion, and cover overlap
followed by an ordinary next visit plus cleanup without resurrection. No
production convergence census was performed.

## Invitation purchase key retirement

The per-purchase key and all ten acquisitions are removed, without a row lock,
empty write, new field or retry. This is distinct from the still-unfinished
organization-level `usage_pack_billing` financial protocol.

| Writer              | Financial arbitration / recovery                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment publication | Validates customer, currency, session, paid amount and PaymentIntent. The actual UPDATE also accepts only an absent or matching PaymentIntent and paid amount, so validation before a concurrent commit cannot overwrite an immutable payment fact. A rejected transaction rolls back its competing-email retirement; existing Stripe redelivery/reconciliation observes the winner, not an in-process retry. |
| Invitation creation | Conditional `payment_succeeded -> creating_invitation` admission; allocation uniqueness plus status/empty-invitation-id publication. Losing publication rolls back the allocation. Provider/Clerk I/O remains outside SQL.                                                                                                                                                                                    |
| Acceptance          | Owner/invitation/user validation; allocation assignment and status-conditional purchase publication share a short transaction. A lost publication rolls back assignment.                                                                                                                                                                                                                                      |
| Activation          | Conditional activation admission and `activating -> accepted`; purchased/bonus grant receipts use the purchase's existing immutable grant identities and payment source. Grant publication and accepted status commit together, with complete-write checks.                                                                                                                                                   |
| Refund              | Existing `refundAttempt` and status-conditional claim/finalization; provider idempotency is `usage-pack-invitation:<purchase>:refund:<attempt>`. Uncertain outcomes read the existing refund rather than creating another financial identity. Allocation retirement and configuration sync retain their separate org-level protocol until that key's complete audit.                                          |
| Expired acceptance  | Conditional still-acceptable status transition to refund_pending; accepted/refunded purchases are not made payable again.                                                                                                                                                                                                                                                                                     |

Public billing API coverage includes concurrent payment/acceptance delivery,
exactly-once credits, hosted and saved-card payments, invalid payment preview,
revocation/refund, failed-refund recovery, migrated invitations and missed
post-commit Stripe synchronization. No test asserts key waiting or order.

## Gmail rolling behavior

The short-lived default-A instruction and commit `058e009e` are superseded by
Ethan's subsequent direct decision. Watch HTTP is outside SQL now, with no key.
A late outgoing `users.stop` can interrupt a new watch during rollout; that
finite rolling notification gap is accepted. Do not claim normal delayed
teardown was the original approval for this separate gap. No rollout renewal,
new field, compensation loop or strict remote ordering is implemented.

Local disable still stops consumption immediately. Without consumers the watch
is not renewed and expires naturally; late notifications are ignored. New
writers never stop the mailbox globally. Normal renewal/reconnect paths remain.

## SSH low-frequency behavior

The earlier exact-winner CAS audit is superseded by Ethan's simpler contract.
Credential/host edits are direct owned UPDATEs; a late edit may win. No
commit-time expected revision/generation predicate or credential-CAS rollback
serializes rotation with attachment, another rotation or a host edit. Existing
request validation/preflight checks are ordinary API behavior, not a replacement
commit arbiter. Deletion relies on owned identity, existing in-use checks and
the credential-owner RESTRICT FK, not revision CAS. Generation still increments
normally when credentials or hosts change; KMS precedes SQL and invalidation
follows it. A host resolves the stored current credential on the next connection.

API tests now assert current credential metadata/host resolution after races,
not exactly one concurrent 200/409 or a preserved concurrent winner. The delayed
KMS edit can publish after an intervening rename; both changes remain usable.
Attachment/deletion assertions retain the natural FK outcome, since permanently
dangling credentials are not accepted. No actual mixed-version deployment or
production operation was performed.

## Remaining nonfinancial simplification

Removing all nonfinancial keys is complete in source, but the latest instruction
also requires removing earlier unnecessary substitutes. This is not finished:
account creation/deletion/selection conflict helpers, credential publication
snapshot guards and other prepared watch or queue paths still need a per-path
classification. Default changes now write once without a savepoint or redo;
the existing unique-index conflict returns a 400 asking the user to save again.
Native/enrollment/timezone xmin guards and the materialization empty timestamp
write are removed. Preserve authorization and
permanent-reference integrity; simplify low-frequency coordination rather than
calling it a required new protocol. Do not defer this implementation to R2.

## Existing completed financial and SQL corrections

Concurrency publication reads Stripe outside SQL and rejects an intervening
write; invoice lines keep their immutable uniqueness. Daily observation repair
creates no subscription, invoice, payment, refund or credit, so it is not proof
of desired-configuration ownership or money recovery.

The attribution operator has no advisory, explicit source/checkpoint row lock,
NOWAIT or lock_timeout. It consumes bounded batches and advances its existing
checkpoint conditionally. Local help/empty-inventory/checkpoint smoke is not
production convergence evidence.

Legacy Plan invoice publication no longer does `updated_at = updated_at` on
org metadata. It conditions its actual business metadata/receipt write;
duplicate delivery fills a missing entitlement without replacing newer facts.
Ordinary failure counters use SQL arithmetic and committed thresholds/returned
state, not application-side `current + 1`. Both fixes were integrated before
this continuation and are preserved.

## Allowance index 1298 preflight

The current allowance uniqueness migration is 1298 (earlier references to 1296
predate main's migration renumbering). Before an authorized release, query the
target database read-only:

```sql
SELECT entitlement_id, kind, starts_at, count(*) AS copies,
       array_agg(id ORDER BY id) AS window_ids
FROM org_usage_allowance_windows
GROUP BY entitlement_id, kind, starts_at
HAVING count(*) > 1;
```

Require zero rows before admitting the migration. No production query was run.
If duplicates exist, prepare a reviewed scoped repair: validate identical
ownership/limits/expiry; account for raw allocations and hourly window
references; remap to a canonical existing window; reconcile consumed units
against immutable receipts. Do not blindly sum counters, delete referenced
history or skip the index. Conflicting facts require investigation. Repeat the
query after authorized repair before migration 1298.

## Purchase overlap recovery remains implementation work

Local-first claims keep losing same-type new requests out of Stripe, but do not
yet share a root across every Plan/pack purchase. This is new-writer financial
work, not rolling-version compatibility. Complete recovery must discover all
customer subscriptions by existing org/purchase/snapshot/source metadata;
compare local bindings and paid invoice identities; cancel positively identified
unpaid losers without proration; and deduplicate refunds of already paid
extras by invoice/payment identity, without another credit grant. Unknown
payment status must be read first. Existing grant/refund identities do not
authorize refunding unrelated invoices. This recovery is still unimplemented;
no guarantee against unrecoverable duplicate charges is claimed.
