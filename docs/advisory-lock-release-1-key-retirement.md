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
**6 API + 0 operator**. Now: **3 API + 0 operator** after the unsafe credit retirement was withdrawn; invitation and serving
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
| `credit_<org>`                             | **Unfinished R1 financial work.** Attempted issuance retirement was withdrawn after distinct-Run overissue. Same-identity unique insertion and conditional financial writes remain, but cannot alone prevent contemporary first-window duplication; see the diagnostic and decision boundary below.                                                                                                                                         |
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

## Credit issuance retirement is withdrawn pending its financial protocol

The same-identity unique-index insertion and one committed-winner read remain,
and explicit wallet/entitlement/window read locks remain removed. Pure refresh
paths, including all three claim graph refresh nodes, stay key-free. However the
credit issuance/backfill/settlement acquisitions are restored as unfinished R1
financial work, **not** an outgoing-version compatibility exemption. The helper
is `orgCreditLockSql`, not `orgCreditCompatibilityLockSql`; `lockOrgCredits` stays
deleted. No new key namespace or row-lock substitute is introduced.

A public API diagnostic constructs two different BYOK Runs one minute apart,
starts their first billable firewall admissions concurrently, then records and
settles two units each. With a two-unit allowance and initial wallet -10, expected
single-window funding leaves wallet -12; the removed-key source can leave -10.
The earlier same-Run test did not cover this case. Its strict diagnostic patch
and logs are retained separately; the money assertion is not weakened into a
passing test. The original acquisition also sometimes permits the later Run to
win first and then issues a historical earlier window, so restoring it reduces
the new simultaneous-read-empty race but is **not a complete fix** or acceptance
proof. Historical overlap semantics alone do not excuse contemporary overissue.

Earliest-covering selection can unify already committed unused windows, but
changes the existing latest-covering history rule. It also cannot by itself
arbitrate windows inserted and consumed inside concurrent settlement transactions,
where the other root is invisible, or account for immutable allocations already
committed to another root. No global non-overlap rule or wall-clock bucketing is
invented. Exact-start uniqueness only closes the exact identity collision.

If the complete no-key financial protocol cannot preserve current history,
Ethan must choose between accepting bounded contemporary overissue and adding an
existing-column range exclusion with reviewed historical-overlap handling and
explicit late-anchor policy. The conservative recommendation is constraint-based
non-overissue rather than silently relaxing paid allowance. No data cleanup,
constraint or relaxed amount assertion is implemented without that decision.
Other financial keys continue independently; this stays R1, not R2 or drain-only.

The public same-Run firewall regression still verifies three admissions reuse
exactly two windows, settlement consumes two units once, later admission cannot
refill them, and organization credits/visible usage remain exact. This remains
useful but is not proof for distinct Run anchors.

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

The attempted issuance/settlement retirement is withdrawn for the distinct-Run
financial gap above. No serving/in-flight/rollback compatibility gate is retained.

## Canonical migration root mapping — partial implementation

Migration materialization now resolves the existing subscription root by its
unique Stripe subscription binding and verifies organization/customer ownership.
A paid conversion of a zero-allocation legacy Plan root updates only its real
Price/tier/status; it never changes the root PK or clears the provider binding.
The migration UUID remains the quote/selection/payment/completion and provider
idempotency identity. Existing rootless historical migrations still use their
already-persisted migration UUID, not a newly generated root identity.

Canonical root ID is carried into allocation FKs, existing Stripe metadata
aliases, correlated paid invoice/parent metadata and invitation purchase ownership.
Before completion, replay checks the beneficiary/Price/USD selection set, not
merely its row count. Invoice/line/allocation/grant identities and monetary/period
validation are retained. Existing migration key acquisitions are not added or
removed by this mapping.

**Verification boundary:** whole existing billing API coverage passes, including
migration payment/replay/invitation paths. The new zero-allocation legacy Plan-root
case is not constructible through the current production Plan purchase writer,
which still stores Plan purchases on org metadata only; it therefore has source,
type and lint evidence but not a claimed new-case runtime API proof. No internal
fixture was added to disguise that missing entry point. Shared initial Plan/pack
admission, no-provider/expired-quote recovery, Plan-family routing and purchase
key retirement remain unfinished R1 work.

## Key-free paid allocation invoice fulfillment

Two further `usage_pack_billing` acquisitions are removed: standalone upgrade
invoice commit and grouped subscription-change invoice fulfillment. These
paths do not create an invoice, charge Stripe or synchronize configuration;
they apply an already-paid, validated invoice to local financial facts.

The existing invoice-fulfillment primary key is inserted before completing the
allocation changes or publishing purchased/bonus grants. `ON CONFLICT DO NOTHING`
selects one actual receipt writer. A losing insertion reads the same committed
receipt once and requires the same subscription and period; no transaction is
retried. The receipt, state transitions and grants commit together, so any
failure rolls back every mutation. The ordinary receipt FK keeps its existing
subscription parent; no new parent/row lock is introduced.

Allocation completion matches the prepared organization, subscription, change
kind/group, recipient, source/replacement allocation, source/target Price and
package values. Grant
identities still contain change/invoice/grant type; refundable amounts retain
the original invoice-line source. Paid invoice replay cannot publish another
grant or complete a change that was reassigned while amounts were prepared.

Public billing API cases now deliver two matching paid invoices concurrently,
then replay once more. Original standalone upgrade credit/refund amounts and
allocation assertions remain; grouped Plan upgrade keeps its prior grants and
asserts exactly one invoice receipt. These narrow retirements do **not** certify
all configuration writers or the organization key independent. Three production
SQL definitions remain, and `billing_purchase` and the remaining
`usage_pack_billing` writers are unfinished R1 work, not compatibility gates.

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

## Unpaid quotes and invitation terminal subpaths

Three unpaid allocation/Plan/migration preview acquisitions and two invitation
terminal acquisitions are removed. Quote publication is not paid intent;
existing unique quote identities and confirmation source validation remain.
Invitation activation first conditionally performs the real activating-to-accepted
transition; grant receipts and exact allocation activation share that transaction,
so a failed financial write rolls back the accepted state. Refund completion
uses its existing refund-attempt transition and allocation retirement atomically,
then synchronizes current configuration by subscription identity after commit.
There is no separate intermediate refund projection transaction or new fence.

These five removals leave the usage-pack organization key and its remaining
financial admission/deferred/provider-first writers unfinished. The new public
refund regression verifies failed post-commit configuration sync does not undo
successful local refund, charge again or resurrect the purchase. It does not
certify every provider-specific quantity/Plan/cancellation writer declarative.
The existing grant conflict-update helper retains a separate financial audit.

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

## Allowance index 1305 preflight

The current allowance uniqueness migration is 1305 (earlier references to 1296
and 1299 predate main's model-catalog integration). Before an authorized release, query the
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
query after authorized repair before migration 1305.

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
