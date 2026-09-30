# R1 key retirement after `4f263928`

R1 remains incomplete. Database-handle propagation is not an acceptance target.
This change does not add tables, fields, JSON coordination state, application
triggers, explicit row locks, empty UPDATEs or concurrency retry loops.
No deployment, production data repair or merge is authorized by this document.

## Actual retirement

`stripe_concurrency_subscription:<subscription>` is deleted, including its
SQL definition and both invoice/subscription publication acquisitions.

- Subscription publication reads Stripe outside SQL and uses the existing
  timestamp plus transient PostgreSQL `xmin` to reject an intervening write.
  First publication uses the subscription primary key and `ON CONFLICT`.
- Invoice lines use their existing unique identities. A rejected projection
  rolls back this delivery's invoice inserts; Stripe redelivery is the existing
  external recovery mechanism, not an in-process coordination retry.
- Pre-R1 handlers can still publish stale observations. The old key did not
  prevent a later old handler from overwriting a newer cancellation: it could
  use the incoming equal-quantity event without retrieving Stripe. R1 now
  compares every live concurrency identity daily, using the existing hourly
  billing cron's 24 stable hash buckets. Scoped reconciliation visits all live
  identities in the requested organizations. Expired payment-failure candidates
  retain their hourly treatment. Each publication is conditional on its own
  observed database version; a lost race waits for a later scheduled visit.
- This is repair of the existing provider-fact projection, **not** completion
  of desired configuration ownership. It creates no subscription, invoice,
  payment, refund or credit grant, and does not implement concurrency purchase
  intent or the remaining cancellation/restore writers.
- A public webhook/status/reconciliation API regression omits the subscription
  update event, repairs a live cancellation observation, visits twice, and
  checks unchanged credits and no subscription creation/invoice/payment.

The operator's compaction advisory acquisition is also deleted. Mutation already
requires the existing `--migrate --ack-writer-drain` opt-in. The script is not a
serving old API writer and must not be invoked against incompatible compactors.
Its existing checkpoint is advanced by one version-conditional UPDATE; a
competing invocation rejects and rolls back the complete batch, with no retry.
Run capture uses existing identity uniqueness; source updates preserve their
existing owner/anchor predicates. All explicit source/checkpoint locks, NOWAIT
and `lock_timeout` are removed. Statement timeout remains only as the CLI's
existing total execution budget. The loop pages new batches; it never retries
an aborted batch. Dry-run remains read-only and never reports activation ready.
Local CLI verification covers help, empty inventory and a fresh empty four-phase
migration checkpoint, not production convergence or nonempty legacy migration.

## Per-key inventory

Source definitions: **17 API + 1 operator before → 16 API + 0 operator after**.
The compaction shared/exclusive entries count as two API definitions.

| Key                                        | Before                                                           | After / remaining R1 boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                    | Short compatibility publication acquisition                      | **Verified compatibility-only, unchanged.** `origin/main`'s `getOrCreateStripeCustomer$` holds this key while reading an absent binding, creating without an idempotency key and unconditionally upserting it. R1 new/new callers use the shared provider idempotency key and missing-binding CAS; they do not require the advisory key among themselves. Retain one short publication acquisition so an old in-flight creator cannot replace the new committed binding. R2 removes it only after serving/in-flight old creators drain and supported rollback versions use conditional binding. Fast-path reads and Stripe creation already occur outside it. |
| `stripe_concurrency_subscription:<id>`     | Two local compatibility acquisitions                             | **Deleted.** Version-conditional publication, invoice identity uniqueness and daily observation repair as above. No R2 key remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `usage_pack_billing:<org>`                 | New projection writers still unfinished                          | **Unchanged R1 work.** Plan/migration/legacy Plan/concurrency/cancel/restore composition and last-member/deferred changes are not all declarative. Not a drain-only gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `usage_pack_invitation:<purchase>`         | Conditional purchase/refund transitions plus shared billing work | **Unchanged R1 work.** The shared projection and complete writer/cleanup audit are not finished; do not call all acquisitions compatibility-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `billing_purchase:<org>`                   | Local claims but split Plan/pack arbitration                     | **Unchanged R1 work.** Cross-type claims must arbitrate a common existing business row; mixed-version duplicate payable-subscription recovery is still incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `credit_<org>`                             | Settlement and allowance acquisition                             | **Unchanged R1 work.** Window issuance/admission and every settlement caller still need a complete no-key protocol. Existing window uniqueness does not by itself prove all callers independent.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `usage_event_compaction` shared            | Serving cleanup/settlement barrier                               | **Unchanged.** Complete the source/parent/ledger coexistence audit before certifying it compatibility-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `usage_event_compaction` exclusive         | Serving compaction/deletion barrier                              | **Unchanged.** No production convergence evidence is asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `usage_event_compaction` operator          | Operator acquisition                                             | **Deleted.** Existing writer-drain opt-in, conditional checkpoint and identity/source writes; no lock substitution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `org_bootstrap:<org>`                      | Prepared publication boundary                                    | **Unchanged this change.** Existing default-Agent CAS is present; the full outgoing writer/cleanup proof is not re-certified here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `morning-brief-native-owner:<org>:<user>`  | First-materialization/legacy-classification coordination         | **Unchanged R1 work.** Absent-row ownership is not solved by renaming the acquisition compatibility-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `morning_brief_preference:<org>:<user>`    | Short outgoing-writer compatibility boundary                     | **Unchanged.** Prior implementation moved Clerk outside; the entire native/preference interaction still requires final no-key verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ssh_connection_owner:<org>:<user>`        | Prepared credential/host writes                                  | **Unchanged.** Credential rotation versus host attachment/rebinding still needs final all-writer no-key proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `model-policy:<org>`                       | Policy-set writer coordination                                   | **Unchanged R1 work.** Complete replacement/initialization arbitration is not certified independent of this key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `workflow_watch:gmail:<scope>`             | Watch HTTP plus publication transaction                          | **Unchanged R1 work.** New writers never call mailbox-wide `users.stop`; Gmail's local-disable/natural-expiry decision is settled. Watch HTTP still inside this boundary is implementation work, not a product decision or a drain-only declaration.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `connector_state:<org>:<user>:<slug>`      | Six documented compatibility acquisitions                        | **Unchanged.** See the existing connector-state writer inventory; no additional acquisition is added here. The earlier ordered-row-lock replacements are not a permitted terminal protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `model_provider_state:<org>:<user>:<type>` | Prepared upsert/conditional writes and compatibility calls       | **Unchanged.** The exact remaining outgoing save/delete writers must be rechecked before final removal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `connector-mcp-oauth`                      | Prepared DCR and compatibility calls                             | **Unchanged.** Registration uniqueness, retirement and all remote/local writer paths need final verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Six application billing triggers also remain. No unfinished implementation in
this table is reassigned to R2. Two rolling releases remain the deployment model.

## Empty writes and failure counters

Thread selection now uses a read-only `INSERT … SELECT` source. Its ordinary
connector FK check or zero selected rows yields the existing unavailable-account
result when deletion wins; no connector timestamp is rewritten to serialize it.
Migration 1298 changes only the two existing selection-to-account FK deletion
actions from RESTRICT to CASCADE. This makes an account deletion also clear a
reference committed after its statement snapshot; an insert after deletion
fails its FK check. Visible selection deletion and account deletion still share
one statement, with an explicit child-mutation dependency. The returned resolved
count describes selections explicitly deleted from that statement's snapshot.
The migration must precede the R1 API deployment, following the normal two-release
DB-first sequence. Outgoing API deletions already explicitly clear these owned
selections, so CASCADE does not change another resource's deletion authority.
No fields, indexes or application-defined triggers are added by 1298.

Legacy Plan invoice publication no longer performs `updated_at = updated_at`.
It performs the actual metadata/receipt transition with the original admission
facts in its WHERE predicate. Zero rows rolls back grants/extensions and resolves
the committed winner once after rollback. Duplicate invoice delivery can insert
a missing entitlement using `ON CONFLICT DO NOTHING`, without replacing a
newer projection; valid replacement cleanup redelivery remains available.

Ordinary pre-run failures increment in SQL, use the same statement's threshold
to disable/clear the successor, and return the committed count. Selected legacy
Morning Brief keeps native-before-automation conditional publication; its
counter write is also arithmetic, and a stale snapshot rolls back both writes.
Ordinary run callbacks also use arithmetic and a threshold on the committed
count rather than writing the count computed from their earlier read. Schedule
recomputation uses the returned enabled state. No counter repair uses a retry.

## Allowance index 1297 preflight

Before the authorized release, query the target database read-only:

```sql
SELECT entitlement_id, kind, starts_at, count(*) AS copies,
       array_agg(id ORDER BY id) AS window_ids
FROM org_usage_allowance_windows
GROUP BY entitlement_id, kind, starts_at
HAVING count(*) > 1;
```

The required result is zero rows. Run this before deployment admission, not
only when `CREATE UNIQUE INDEX` fails. No production query was run in this change.
If duplicate groups exist, do not skip the index, discard referenced windows or
let the release enter a known-failing migration. Prepare an independently
reviewed scoped data repair before proceeding: validate identical owner,
limits and expiry, account for raw `usage_allowance_allocations` and compacted
`usage_event_hourly_rollup` window references, remap references to a canonical
existing window, and reconcile consumed units against the immutable receipts.
Do not blindly sum counters or delete cascading receipt history. Conflicting
limits/expiry or unexplained consumption require investigation, not automatic
merging. Repeat the query after that authorized repair, then run migration 1297.
This is a release precondition, not evidence that production has converged.

## Purchase overlap recovery remains implementation work

The local-first claims prevent losing _new_ requests from invoking Stripe, but
they do not yet share a root across every Plan/pack purchase. A pre-R1 creator
can also create another subscription after the new short claim boundary. The
new concurrency observation repair above cannot fix a duplicate charge.

Required R1 recovery must discover all customer subscriptions with the existing
org, purchase/snapshot and source-subscription metadata; compare them with the
committed local binding and paid invoice identities; cancel only positively
identified **unpaid** losing purchases with no proration; and route an already
paid duplicate through an invoice/payment-identity-deduplicated refund, without
issuing a second credit grant. Indeterminate payment status must be read before
cleanup. Existing grant and member-credit-refund identities are not permission
to refund an unrelated invoice. This complete recovery is **not implemented by
this change** and no guarantee of mixed-version duplicate-charge recovery is
claimed. It stays in R1 rather than becoming an R2 drain condition.
