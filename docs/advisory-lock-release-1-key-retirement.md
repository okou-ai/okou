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

Source definitions: **17 API + 1 operator before → 15 API + 0 operator after**.
This continuation removes the SSH key (16 → 15 API definitions), with no
remaining SSH compatibility acquisition.
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
| `ssh_connection_owner:<org>:<user>`        | Prepared credential/host writes                                  | **Deleted.** All three acquisitions and the SQL definition are removed. Revision/generation CAS, atomic increments, resource uniqueness and the credential-owner FK arbitrate; the mixed-version writer audit is below.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `model-policy:<org>`                       | Policy-set writer coordination                                   | **Unchanged R1 work.** Complete replacement/initialization arbitration is not certified independent of this key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `workflow_watch:gmail:<scope>`             | Watch HTTP plus publication transaction                          | **Authorized R1 compatibility-only exception.** One transaction-scoped acquisition still encloses `users.watch` HTTP plus conditional local publication, explicitly an external call while holding the key. Outgoing `reconcileGmailPhysicalScope` and account cleanup call mailbox-wide `users.stop` under the same key. New/new writes use the unique upsert and live-consumer predicates. R2 moves watch HTTP outside SQL and deletes this key after stop-capable serving/in-flight APIs and rollback targets are gone. This narrow exception is not an unfinished R1 protocol.                                                                            |
| `connector_state:<org>:<user>:<slug>`      | Six documented compatibility acquisitions                        | **Unchanged.** See the existing connector-state writer inventory; no additional acquisition is added here. The earlier ordered-row-lock replacements are not a permitted terminal protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `model_provider_state:<org>:<user>:<type>` | Prepared upsert/conditional writes and compatibility calls       | **Unchanged.** The exact remaining outgoing save/delete writers must be rechecked before final removal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `connector-mcp-oauth`                      | Prepared DCR and compatibility calls                             | **Unchanged.** Registration uniqueness, retirement and all remote/local writer paths need final verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Six application billing triggers also remain. No unfinished implementation in
this table is reassigned to R2. Two rolling releases remain the deployment model.

## Gmail rolling compatibility exception

The September 30 coordination instruction selects default A without weakening
the accepted guarantee for other enabled consumers. New writers never call
`users.stop`. Only `users.watch` plus the finite conditional publication stays
inside the old mailbox key's SQL transaction; access resolution, OAuth/KMS,
profile lookup and inactive-state cleanup are outside it. This is an explicit
R1 exception to the no-external-I/O-in-transactions rule, not a general exemption.

Outgoing `reconcileGmailPhysicalScope` and account-deletion watch cleanup can
call mailbox-wide `users.stop` under that same key. Its HTTP boundary is retained
solely for them. R2 must first verify that no stop-capable version is serving,
no such request remains in flight, and no supported rollback target can stop a
mailbox watch. R2 then moves watch HTTP before the conditional publication
transaction and deletes the key/definition. No third deployment is assumed.

Alternative B is **not implemented or approved**: move watch HTTP outside the
key in R1, accept notification loss if a late old `users.stop` wins, and force
one renewal of every enabled Gmail consumer through the existing renewal path
at R2 rollout. This bounds that loss to R1→R2 rather than the normal six-to-seven
day expiry, but weakens the accepted uninterrupted-consumer guarantee. Default
A is recommended; Ethan may choose B after landing. Delayed remote teardown
alone is already accepted and remains unchanged.

## SSH owner retirement

`ssh_connection_owner:<org>:<user>` has no remaining new acquisition or SQL
definition. It is not retained as an R2 compatibility gate. No row lock, empty
UPDATE, retry or new schema replaces it. KMS preparation precedes the local
transaction; runtime/client invalidation follows its commit.

| Writer                                           | New arbitration                                                                                                                                           | Outgoing writer interaction                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential creation                              | Existing credential primary key and owner; resource-id conflicts resolve the existing public idempotency result                                           | Different IDs remain independent; a repeated ID does not create another credential.                                                                                                                                                                                                            |
| Credential rotation                              | `UPDATE credentials WHERE revision = expectedRevision RETURNING`; host generation uses SQL arithmetic; lost credential CAS rolls back the whole host bump | Main `updateSshCredential` reads/checks the revision after its existing credential row acquisition, and both versions update hosts before the credential. An old winner makes the new CAS fail; a new winner makes the old revision check fail. New code does not introduce a row acquisition. |
| Host creation / attachment                       | Existing host primary key and owned credential FK; duplicate host IDs resolve once after rollback                                                         | Creation does not capture credential secrets. A host attached after rotation's host UPDATE starts at generation 1 but resolves the current credential. A host included in that UPDATE gets the increment. Neither outcome leaves the host on old secrets.                                      |
| Host editing / rebinding                         | Existing host generation conditional UPDATE and credential-owner FK                                                                                       | Main `lockOwnerHostForUpdate` reads/checks generation after its existing host row acquisition; an old edit makes the new CAS fail, while a new edit makes the old expected-generation check fail. Rotation increments the committed generation atomically.                                     |
| Credential deletion                              | Revision-conditional DELETE, `NOT EXISTS` committed attachments, existing RESTRICT credential-owner FK                                                    | The FK also rejects an attachment committed while DELETE waits, in both versions. A failed attachment returns missing credential; a failed deletion returns in-use or revision conflict.                                                                                                       |
| Host delete / learned-key reset / runner pinning | Existing generation/owner predicates and ordinary FK enforcement; no owner advisory acquisition                                                           | Host deletion cannot leave a dangling credential reference. Pinning verifies the current host/credential identity, not the username snapshot returned by a concurrent attachment. Existing outgoing pinning may take its own row locks; none are added to R1.                                  |

Public API regressions cover attachment versus rotation, attachment/rebinding
versus credential deletion, two competing rotations (one successful revision,
one 409, and no losing generation bump), and rotation versus host editing
(success with both increments or deterministic stale-generation rejection).
The attachment assertion no longer infers write ordering from the username
snapshot in the create response: final host inventory must resolve the new
username; the attached host generation can be 1 or 2, while the original host
must be 2. This removes a serialization assertion, not the credential outcome.
The source audit uses outgoing main `714cba13`; local tests exercise the current
public API, not an actual mixed-version deployment. No production rollout is
claimed.

## Empty writes and failure counters

Thread selection now uses a read-only `INSERT … SELECT` source. Its ordinary
connector FK check or zero selected rows yields the existing unavailable-account
result when deletion wins; no connector timestamp is rewritten to serialize it.
Migration 1298 first generated CASCADE, but API testing showed that cascade
cleanup cannot report the exact number of late references outside a statement's
snapshot. Migration 1299 therefore declares the same two account FKs as
`NO ACTION DEFERRABLE INITIALLY IMMEDIATE`. Only account deletion defers their
checks for its two mutations, then restores immediate checking before returning.
Ordinary selection writes retain statement-time FK errors and deterministic
unavailable-account responses. A short transaction actually deletes
the account, then deletes/counts selections in the next SQL snapshot. A reference
committed before the ordinary parent DELETE is included; an insert after it
fails its FK check at commit. No lock-only statement, row lock or retry is used.
The concurrent selection/deletion API count assertion is unchanged.

Apply the complete migration chain before R1 API deployment, following the
normal two-release DB-first sequence. Outgoing API deletions already explicitly
clear these owned selections inside their transactions, so the final constraint
still rejects a committed orphan. Drizzle does not emit deferrability: the
current SQL declaration is `src/constraints/connector-selection.sql`; fresh-schema
validation installs that declaration and still compares full constraint SQL
against migration replay. No comparison is weakened or deferral ignored.
No fields, indexes or application-defined triggers are added by these changes.

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
