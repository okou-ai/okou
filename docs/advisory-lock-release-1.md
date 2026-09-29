# Advisory lock cleanup — Release 1

The [terminal state](./advisory-lock-terminal-state.md) is binding. This work adds
no persisted coordination fields. Release 1 prepares every writer that Release 2
may overlap with; removing acquisition expressions alone does not satisfy the
transaction ownership or external-I/O requirements.

All implementation work is consolidated into [#37313](https://github.com/okou-ai/okou/pull/37313).
The source branches are preserved. This document distinguishes implemented
preparation, outgoing-writer compatibility boundaries, and unfinished work.
**Release 1 is not yet complete.** The remaining items below are implementation
requirements, not authorization to release or to remove their locks prematurely.

## Source and compatibility evidence

The initial implementation baseline was main
`5b458cc9df60ce0c3ffc7e1783ec3d36be9634e1`: 28 production acquisition definitions,
one catalog fixture acquisition, and one attribution operator acquisition.
Historical migration SQL is counted separately. The integration branch also
includes main `8531a2b` (the intervening release metadata commit).

Browser and custom account preparation from #37097 was verified against live
production aliases, public API build-info, the configured invocation bound, and
the mandatory rollback floor. See the exact evidence in
[deployment compatibility](./deployment-compatibility.md#browser-advisory-retirement-2026-09-29).
Recheck those deployment facts before promotion if supported versions change.
No new App floor or Runner drain is justified by these API-only changes.

For any retained GA key, the common R2 gate is: every serving and supported
rollback writer contains the relevant preparation; incompatible pre-R1
invocations have drained under an evidenced lifecycle bound; and R1/R2 writers
preserve the invariant while mixed. Merge time, an arbitrary wait, or a green
pipeline does not establish this gate. A row marked **unfinished** needs code
work in addition to deployment evidence. Non-GA paths receive no compatibility
exception merely because their implementation is unfinished.

## Acquisition inventory and removal gates

Names below identify definitions in `turbo/apps/api/src/signals/services/` at
the baseline. A definition can serve multiple runtime callers.

| Package / definition                                                                    | Implemented preparation or direct retirement                                                                                                                                                                                                                    | Retained reason and R2 gate                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap — `org-limited-free-bootstrap.service.ts`                                     | Independent Agent/Storage candidates; upload and verification outside publication; independent unique grant command; final Agent insert plus default-Agent CAS; authoritative cleanup resolution.                                                               | Outgoing API still unconditionally publishes a default Agent. Keep only the publication compatibility key until those writers drain. Both onboarding and Clerk webhook use the prepared command.                                                                                                                                                   |
| Browser — `browser.service.ts`                                                          | **Removed.** Existing unique owned-thread slot and exact state predicates arbitrate all six former call sites. All eight transactions are command-local with direct SQL.                                                                                        | #37097 serving, drain and rollback evidence established; recheck before promotion.                                                                                                                                                                                                                                                                 |
| Custom account — `auth-state-lock.service.ts` custom branch                             | **Removed.** Ordered account mutation and selection UNIQUE/FK arbitration remain. The initial-thread ownership/projection deletion race is fixed by omitting only an authoritatively absent account.                                                            | #37097 serving and rollback evidence established. Shared account transaction propagation still needs structural cleanup.                                                                                                                                                                                                                           |
| Custom prefix — `custom-connector.service.ts`                                           | **Unfinished.** Normalized overlap lives in existing JSON arrays; an ordinary unique index on the whole array cannot enforce per-prefix overlap.                                                                                                                | Existing key still supplies the invariant. A serializable snapshot taken before waiting on an outgoing read-committed writer can be stale; adding isolation alone is insufficient. No extra fields, session lock, or pool-starving nested compatibility transaction is introduced. All affected definition writers must be covered before removal. |
| Model policy — `model-policy.service.ts`                                                | All three writers now share existing default-slot uniqueness, ordered parent/policy ownership, and a fresh whole-set identity check. Empty initialization inserts only the real default before completing the seed; replacements retain client revision checks. | Outgoing seed/default writers lack common row-set ownership. Retain the key for overlap. Helper-owned and forwarded transactions remain **unfinished** structural work; they are not a compatibility exemption.                                                                                                                                    |
| Builtin credential state — `auth-state-lock.service.ts`                                 | Ordinary refresh prepares KMS inputs/outputs before persistence and compares the exact stored input bundle before local writes.                                                                                                                                 | Outgoing unconditional secret writers require the key. One-time remote refresh and credential deletion/rotation still need a complete shared protocol; post-response CAS alone cannot prevent a provider-side stale rotation.                                                                                                                      |
| Model-provider credential state — `auth-state-lock.service.ts`                          | **Unfinished.** Existing account/credential ownership was traced.                                                                                                                                                                                               | One-time refresh, stale credential rejection, run capture, deletion and KMS boundaries must be prepared together without new claim/revision fields. Current locking is not proof of R2 readiness.                                                                                                                                                  |
| Automatic OAuth/DCR — `builtin-connector-automatic-dcr.service.ts`                      | Provider registration and encryption precede conditional issuer publication. Issuer uniqueness selects the published winner; linked-account replacement and reconnect are bound to exact registration identity.                                                 | Outgoing DCR/OAuth callbacks and refresh writers still publish unconditionally. Keep the legacy lifecycle coordination until all are prepared; ordinary store transaction owners are being moved into commands.                                                                                                                                    |
| Gmail watch — `gmail-automation-event.service.ts`                                       | **Unfinished; business choice pending.** Provider `users.stop` has no watch identity, so a late stop can disable a newer watch.                                                                                                                                 | Local snapshot CAS cannot fence that remote effect. The proposed local-immediate-stop / remote-expiry tradeoff requires explicit acceptance; Forms' accepted gap does not authorize Gmail's.                                                                                                                                                       |
| Calendar watch — `google-calendar-automation-event.service.ts`                          | Boundary preparation in progress: paginated baseline and credential/provider preparation outside publication, exact watch and credential predicates.                                                                                                            | Outgoing lifecycle updates require compatibility coordination. Remaining provider-stop and helper transaction boundaries must be completed, not labeled rollout-only.                                                                                                                                                                              |
| Forms watch — `google-forms-automation-event.service.ts`                                | Remote list/create/renew and pagination precede conditional local publication. Reconciliation checks remote existence even for a locally healthy expiry and catches up responses.                                                                               | Outgoing lifecycle writers still update/delete by ID. Preserve the first observed cursor when old stop deletes the state during preparation; do not return successful publication without a watch or restart at newest response. This mixed-writer repair is required before readiness.                                                            |
| Morning Brief preference — `morning-brief-preference.service.ts`                        | **Unfinished.** Traced explicit choice, automatic enrollment, generic workflow toggles and timezone writes.                                                                                                                                                     | Latest-choice publication and stale installation compensation need a common existing-state predicate. The outer transaction/polling remains implementation work; it is not a permanent lock exception.                                                                                                                                             |
| Morning Brief native owner — `morning-brief-native-schedule.service.ts`                 | **Unfinished.** Existing epoch/fence handles present rows; absence still coordinates first materialization with legacy `ordinary` classification.                                                                                                               | Prepare all classification/materialization writers on existing business identities before removing the absent-owner key. A staff-only native control does not make shared legacy schedule writers non-GA.                                                                                                                                          |
| Stripe customer — `billing-customer.service.ts`                                         | Stable provider idempotency key, conditional authoritative binding, local metadata/entitlement write.                                                                                                                                                           | Outgoing customer creation/binding lacks the same protocol. Keep the local publication key until prepared serving/rollback writers cover it.                                                                                                                                                                                                       |
| Organization purchase — `billing-purchase-lock.service.ts`                              | **Unfinished.** Stateless preview/confirm and shared subscription inputs were traced.                                                                                                                                                                           | Purchase confirmation, plan/allocation changes and shared schedules must share real business admission; separate provider keys do not fence a stale absolute quantity.                                                                                                                                                                             |
| Subscription sync — `webhooks-stripe.service.ts`                                        | Every concurrency projection writer advances existing `updated_at` at database precision; provider-result publication uses exact pre-read timestamp CAS. Missing rows use PK arbitration.                                                                       | Outgoing unconditional projection writers require the key. Retire after all webhook/cron/initial-invoice writers use the prepared protocol; preserve authoritative provider checks for cancellation/renewal.                                                                                                                                       |
| Allocation — `usage-pack-allocation-change.service.ts`                                  | **Unfinished** shared quantity protocol; local conditional state updates retained.                                                                                                                                                                              | Coordinate allocation, plan, invitation, migration and the existing concurrency schedule writer before moving/removing remote serialization. A per-operation idempotency key cannot prevent a later stale absolute overwrite.                                                                                                                      |
| Plan change — `usage-pack-plan-change.service.ts`                                       | Same shared projection boundary as allocation.                                                                                                                                                                                                                  | Same shared-writer prerequisite. Transaction forwarding and Stripe I/O are separate unfinished obligations.                                                                                                                                                                                                                                        |
| Invitation purchase — `usage-pack-invitation-purchase.service.ts` purchase key          | Atomic purchase claims, exact refund predicates, and conditional state transitions. Public API tests distinguish the accepted-invite reward from duplicate credit grants.                                                                                       | Outgoing by-ID purchase/refund writers require compatibility. Shared subscription projection still needs completion before full removal.                                                                                                                                                                                                           |
| Invitation email — same file, email key                                                 | **Removed.** Existing active-email unique index arbitrates preview/supersession. Paid collisions retain captured-money refund handling.                                                                                                                         | Constraint and conditional state handling operate with supported outgoing writers; no new coordination row.                                                                                                                                                                                                                                        |
| Usage display — `chat-usage-event.service.ts`                                           | Deterministic initial display-event identity and fresh-snapshot conflict recovery.                                                                                                                                                                              | Outgoing random event IDs and archive replacement behavior require the key. Archive/helper transaction propagation and I/O remain unfinished.                                                                                                                                                                                                      |
| Credits/allowance — `usage-allowance.service.ts`                                        | Pending usage is claimed before pricing; balance/account ownership and exact existing-row CAS protect allowance refresh publication.                                                                                                                            | Outgoing SELECT-pending / unconditional-by-ID processed updates can otherwise double-charge. Retain the key until every supported settlement/refresh writer is prepared. Propagated settlement and Stripe boundaries remain unfinished.                                                                                                            |
| Compaction shared — `usage-event-compaction-lock.service.ts`                            | Run parent before raw ledger; raw rows before hourly aggregate rows; account deletion follows that order.                                                                                                                                                       | Outgoing deleters/compactors use the old order. Include operator and maintenance writers in the removal gate.                                                                                                                                                                                                                                      |
| Compaction exclusive — same file                                                        | Compaction owns exact rows, uses SKIP LOCKED, and publishes aggregates from the rows actually acquired in one command-local transaction. Pure raw-result decoding no longer needs the transaction argument.                                                     | Same old-writer ordering gate. A lexical SQL reduction alone does not prove every raw/hourly writer migrated.                                                                                                                                                                                                                                      |
| SSH owner — `ssh-credential.service.ts`                                                 | Existing credential/host identity and local ownership preparation in progress.                                                                                                                                                                                  | Concurrent key rotation and host attachment must agree on the same existing owner identity. No permanent KEEP exception.                                                                                                                                                                                                                           |
| VNC scope shared/exclusive and owner — `vnc-owner-lifecycle.service.ts` (3 definitions) | **Removed.** Existing member-row `created_at` identity, command-local credential/host writes, and cleanup in the same member lifecycle.                                                                                                                         | Create/admission/cleanup reject a member identity removed during external preflight. Full API types and focused lint passed on the source revision; combined-head pipeline remains required. Shared initial-chat transaction interfaces remain unfinished. No new field or non-GA compatibility fallback.                                          |

## Fixtures, operator and final schema

- The catalog fixture session lock is still executable and **unfinished**.
  Shared catalog mutation needs isolated ownership before its lock can disappear;
  test usage or file age does not justify keeping it in the terminal state.
- The billing-attribution operator retains the compaction compatibility key but
  now takes live Run parents before source rows and rolls back on contention
  without advancing its checkpoint.
- Migration `1287_retire_provisional_billing_purge` drops the unused current
  `purge_quiescent_provisional_billing_attribution` function. Historical
  migrations stay unchanged. The schema snapshot adds no table columns.
- Attribution and allowance reader fallbacks remain. A full live data-convergence
  census has not established their removal conditions; tool age and CI references
  are not convergence evidence.

## Transaction inventory

The baseline syntax inventory scans actual `.transaction(...)` call expressions
under `turbo/apps/api/src/**/*.ts`, excluding named test, fixture, benchmark and
mock paths. It found **422 transaction construction sites**: 356 with a directly
forwarded transaction value, 48 owned by an ordinary function, and 18 command-local
candidates. These are source construction sites, not runtime invocation counts.
The 346 transaction-typed parameter occurrences are only interface candidates.

This classification does not prove safety. `Db` parameters can also receive
transactions, and nested closure capture or helper chains require tracing. The
semantic audit follows these categories:

1. Local command + bounded SQL + no transferred/captured handle: eligible to keep.
2. Transaction parameter/object/context passed to helpers, commands, services or
   callback APIs: inline the SQL or replace it with pure data/SQL preparation.
3. Ordinary helper/store owns a transaction: move ownership into a named command.
4. Provider/KMS/R2/realtime/archive/pagination inside a transaction or helper
   called from it: prepare outside and publish with existing-state predicates.
5. Compatibility-only boundary: state the exact outgoing writer and its removal
   gate. Do not classify unfinished items as this category.

Browser's eight scopes and bootstrap publication/grant scopes have been reviewed
semantically. Usage compaction uses direct execute with a pure decoder. Shared
Storage, billing, credential and workflow helpers still expose transaction
propagation; an all-API end-state claim would be false. A final combined-source
sweep and exact-head validation accompany the integration update.

## Validation and release readiness

Individual source branch checks are evidence for those revisions only. The
combined head must pass its own relevant static checks, types, API tests and
migration pipeline. Full local Vitest and local development servers are not run.
No PR auto-review, merge queue, merge to main, production promotion or deployment
approval is included in this implementation authorization.

The known baseline pnpm audit failures involve unchanged Desktop transitive
`fast-uri` and `ip-address` advisories. Keep those separate from actual changed
API test failures. Do not discard a failing API invariant or call it flaky
without finding its causal interleaving.

## Consolidation provenance

The source heads below were saved before integration under local preservation refs
and remain available on their original remote branches. Their implementation,
tests, documentation and follow-up fixes are included in this PR. Two cherry-picks
changed patch identity: the identical entitlement builder was already present in
bootstrap, and both deployment-compatibility additions were preserved together.

| Source PR | Preserved head                             | Scope                                                   |
| --------- | ------------------------------------------ | ------------------------------------------------------- |
| #37313    | `ab45947f44b89a3ec49e4e71db06284582e5fb73` | prepare conditional default agent bootstrap publication |
| #37315    | `73104426b78fec147bbabbb5845cdb12091545bc` | prepare forms watches for advisory lock retirement      |
| #37316    | `41d3c073b320f26b4631dbb078bae78d16df8db0` | retire prepared browser advisory coordination           |
| #37317    | `7c97bb632ae9dbde1fc451d535807e4471829661` | retire prepared custom account advisory key             |
| #37318    | `92c2ad3a4c1a6b28d58cc80202530b8fdc21e560` | prepare billing customer and invitation write protocols |
| #37320    | `458c394650b0e5549c5e1a1e4922823ee05b40f9` | publish prepared automatic oauth clients conditionally  |
| #37321    | `ab73eb7e3916dba963f220276cc1cd1ed789062b` | prepare usage writers for advisory lock removal         |
| #37323    | `6683617b176387f802aa4eefe1024072cd216d47` | prepare builtin refresh values before persistence       |
| #37324    | `0850d4ac7d40423ca64272a53bc86e58364e7cde` | guard Stripe concurrency projection publication         |

Subsequent changes from each owner are integrated directly into #37313. The
source PRs are closed only after their changes have been pushed to the main PR.
The source branches are not deleted.
