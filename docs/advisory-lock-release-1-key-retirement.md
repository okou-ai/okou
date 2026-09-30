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

Initial inventory: **17 API + 1 operator** definitions. Before this continuation:
**16 API + 0 operator**. Now: **6 API + 0 operator**; compaction's shared/exclusive
SQL definitions count separately. No nonfinancial advisory definition remains.
Deleting a key does not certify all earlier nonfinancial replacement machinery
removed; that simplification remains explicit R1 implementation work below.

| Key                                        | Current state / behavior                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                    | **Deleted.** Stripe customer creation is outside SQL with the existing shared organization idempotency key; local missing-binding UPDATE and organization PK arbitrate new financial writers. Fast-path binding reads are unchanged.                                                                                                                                                                                                        |
| `stripe_concurrency_subscription:<id>`     | **Deleted.** Timestamp/xmin publication and invoice-line uniqueness remain; daily 24-bucket observation repair uses the existing hourly billing cron. This does not complete desired concurrency configuration or duplicate-charge recovery.                                                                                                                                                                                                |
| `usage_pack_billing:<org>`                 | **Still present, R1 financial work.** Plan/migration/legacy Plan/concurrency/cancel/restore and last-member/deferred changes are not all declarative. No outgoing-version-only exemption is claimed.                                                                                                                                                                                                                                        |
| `usage_pack_invitation:<purchase>`         | **Still present, R1 financial work.** Complete shared projection, purchase/refund transitions and cleanup must be independent of this key before removal.                                                                                                                                                                                                                                                                                   |
| `billing_purchase:<org>`                   | **Still present, R1 financial work.** Local-first claims still need common Plan/pack arbitration and recoverable duplicate payable-subscription handling. Not an R2 drain gate.                                                                                                                                                                                                                                                             |
| `credit_<org>`                             | **Still present, R1 financial work.** Window issuance, consumption and all settlement callers need a complete no-key protocol. Existing window uniqueness alone does not prove independent issuance across different Run start times.                                                                                                                                                                                                       |
| `usage_event_compaction` shared            | **Still present, R1 financial work.** Source/parent/ledger coexistence and financial preservation need their complete no-key protocol.                                                                                                                                                                                                                                                                                                      |
| `usage_event_compaction` exclusive         | **Still present, R1 financial work.** Do not remove the barrier before the serving source-consumption/deletion protocol preserves actual consumed facts.                                                                                                                                                                                                                                                                                    |
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

## Allowance index 1297 preflight

The current allowance uniqueness migration is 1297 (earlier references to 1296
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
query after authorized repair before migration 1297.

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
