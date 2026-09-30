# Advisory lock cleanup — Release 1

The [terminal state](./advisory-lock-terminal-state.md) is binding. This work adds
no database tables or persisted fields. Release 1 prepares every writer that
Release 2 may overlap with; removing acquisition expressions alone does not
satisfy the transaction ownership or external-I/O requirements.

**Stripe target update — September 29:** Ethan confirmed deriving the desired
subscription from existing business records and reconciling Stripe once daily.
The briefly considered new-table exception is withdrawn: no new database tables
or fields are allowed. Temporary quantity/schedule drift is accepted; global
ordering of configuration writes is no longer the target.
Payment, refund and paid-entitlement correctness remain required. The
[declarative subscription contract](./advisory-lock-terminal-state.md#declarative-stripe-subscriptions-and-daily-reconciliation)
supersedes strict-ordering requirements in the inventory below. This is an
approved implementation direction, not a claim that the full projection and
reconciliation have been implemented. Reassess the remaining Stripe boundaries
against that contract; do not retain them solely to prevent temporary provider
drift.

All implementation work is consolidated into [#37313](https://github.com/okou-ai/okou/pull/37313).
The source branches are preserved. This document distinguishes implemented
preparation, outgoing-writer compatibility boundaries, and unfinished work.
**Release 1 is not yet complete.** The remaining items below are implementation
requirements, not authorization to release or to remove their locks prematurely.

## Current key retirement

Current source: **3 API definitions and zero operator definitions** (before
this continuation 16 + 0; initial steer 17 + 1). All nonfinancial keys are
removed, including Gmail, SSH, model-policy, native/preference Morning Brief,
bootstrap, connector/model-provider state and DCR; customer publication is also
key-free. The [current key table](./advisory-lock-release-1-key-retirement.md)
is authoritative for exact behavior and remaining financial work.

Ethan's latest September 30 decisions supersede compatibility-only retention
and the short-lived Gmail default-A exception. Watch HTTP is outside SQL; the
rolling old-stop gap is accepted, without R2 forced renewal. Nonfinancial edits
need no concurrent-operation protection when another save, reconnect or task
recovers. SSH commit-time CAS and losing host-bump rollback are removed.
Earlier unnecessary nonfinancial CAS/savepoint/version machinery still needs
simplification; removing keys alone does not finish that additional instruction.

The per-purchase invitation key is now also deleted: conditional financial
transitions, immutable payment publication, grant identities and refund-attempt
idempotency arbitrate it. Serving compaction's shared/exclusive keys are also
deleted: only actual version-matching deleted facts become immutable rollups;
raw-first cleanup and financial reconciliation remain. Remaining keys are
financial: billing purchase, usage-pack billing and credit. They are R1 implementation work, not
outgoing-version/R2 gates. Six application billing triggers also remain. Empty
org-metadata UPDATEs and application-side failure increments are already fixed;
allowance duplicate preflight is documented for current migration 1299.
Database-handle propagation remains a non-goal. No merge/release is authorized.

## Historical source and preparation evidence

The table and older combined-batch notes below preserve preparation history;
old lock-order, compatibility/R2 and Db/Tx propagation descriptions are not
current acceptance requirements. Use the current key table above instead.

The initial implementation baseline was main
`5b458cc9df60ce0c3ffc7e1783ec3d36be9634e1`: 28 production acquisition definitions,
one catalog fixture acquisition, and one attribution operator acquisition.
Historical migration SQL is counted separately. The integration branch also
includes main `3103651`, preserving browser preferences, thread-image schema
contraction, retired Agent SSH/VNC grants, current generation identity, the
Okou Pro/Max retirement and default-policy repair, and the rule prohibiting new
database triggers. Main's migrations 1289/1290, X509None VNC profile and Cloudflare trigger retirement are preserved; main's 1291–1293 subscription catalog migrations are preserved; the two PR-only retirements follow at 1294/1295. Integration `/model` controls retain main's routed-thread-only
behavior and no longer change a member default or recreate a retired session.

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

| Package / definition                                                                    | Implemented preparation or direct retirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Retained reason and R2 gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap — `org-limited-free-bootstrap.service.ts`                                     | Independent Agent/Storage candidates; upload and verification outside publication; independent unique grant command; final Agent insert plus default-Agent CAS; authoritative cleanup resolution.                                                                                                                                                                                                                                                                                                                                                                                                                         | Outgoing API still unconditionally publishes a default Agent. Keep only the publication compatibility key until those writers drain. Both onboarding and Clerk webhook use the prepared command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Browser — `browser.service.ts`                                                          | **Removed.** Existing unique owned-thread slot and exact state predicates arbitrate all six former call sites. All eight transactions are command-local with direct SQL.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #37097 serving, drain and rollback evidence established; recheck before promotion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Custom account — `auth-state-lock.service.ts` custom branch                             | **Removed.** Ordered account mutation and selection UNIQUE/FK arbitration remain. The initial-thread ownership/projection deletion race is fixed by omitting only an authoritatively absent account.                                                                                                                                                                                                                                                                                                                                                                                                                      | #37097 serving and rollback evidence established. Shared account transaction propagation still needs structural cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Custom prefix — `custom-connector.service.ts`                                           | **Removed.** Accepted shared-prefix semantics remove the organization-wide exclusion scan, organization-row serialization and advisory key. Existing org/slug uniqueness retains identity; API and Runner select an explicit authorized connector or reject ambiguous routing.                                                                                                                                                                                                                                                                                                                                            | No prefix-exclusivity old-writer gate remains: exclusivity is no longer a business invariant. Existing Runner intent/ambiguity handling and ID-scoped credential resolution are unchanged. OAuth/Storage transaction ownership remains a separate implementation gap; see [prefix evidence](./advisory-lock-release-1-custom-prefix.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Model policy — `model-policy.service.ts`                                                | All three writers now share existing default-slot uniqueness, ordered parent/policy ownership, and a fresh whole-set identity check. Empty initialization inserts only the real default before completing the seed; replacements retain client revision checks.                                                                                                                                                                                                                                                                                                                                                           | Outgoing seed/default writers lack common row-set ownership. Retain the key for overlap. Replacement, onboarding, lazy seed/default repair and policy/route reads now use owning commands and ordinary snapshots. Remaining workflow creation, dispatch and shared runtime callers have separate unfinished handle propagation; see the Model Policy inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Builtin connector state — `auth-state-lock.service.ts` `connector_state`                | **New-writer dependency removed.** All 44 acquisition sites across 25 files (at `98111e9`) were re-arbitrated: queue admission uses its automation/watch-state row locks; watch publication, repair and credential/OAuth/DCR publications use conditional writes on account, automation and state rows; account-set writers (connect, default, delete, selections, projections) take ordered account row locks (`builtinConnectorAccountRowsLockSql`, `FOR UPDATE`); the first account is decided by `idx_connectors_org_user_slug_default`. See [connector state writers](./advisory-lock-release-1-connector-state.md). | Six short local compatibility acquisitions remain, each for a named outgoing selection or automation-creation writer that changes projection inputs under the key without locking account rows. R2 deletes them once no serving, in-flight or rollback writer takes the key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Model-provider credential state — `auth-state-lock.service.ts` `model_provider_state`   | Firewall refresh publication no longer takes the key; it publishes by exact owner-row CAS. Settings save/delete now lock the existing provider row before secrets.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **Unfinished:** `deleteUserModelProvider$` and `persistMultiAuthModelProvider$` still depend on the key for the no-row first-save race (two concurrent first saves with different auth methods could leave orphan secrets). A lock-free design for that race is required in R1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Automatic OAuth/DCR — `builtin-connector-automatic-dcr.service.ts`                      | Provider registration and encryption precede conditional issuer publication. Issuer uniqueness selects the published winner; linked-account replacement and reconnect are bound to exact registration identity.                                                                                                                                                                                                                                                                                                                                                                                                           | Registration preparation/read/publication now use no-Db command inputs and direct SQL, including an existing catalog identity snapshot fence. Callback token exchange and KMS now precede a command-local atomic account/secret/binding publication, and exact-registration retirement has its own command. Start and callback entrypoints, state claim, catalog reads and post-commit wakeup now use owning commands. Runtime refresh still needs its full caller graph and one-time-provider protocol; the key cannot yet be classified as outgoing-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gmail watch — `gmail-automation-event.service.ts`                                       | Approved local-stop/remote-expiry behavior is implemented: no `users.stop`, no remote-stop preparation on account deletion, and inactive state cleanup checks that no current consumer remains.                                                                                                                                                                                                                                                                                                                                                                                                                           | Late notifications are ignored for inactive consumers. Shared enabled consumers and normal deduplication remain. Ensure, renew and watch reconciliation now use no-Db owning commands. Authorized R1-only compatibility exception: one existing lifecycle-key acquisition still encloses users.watch HTTP plus conditional publication, because outgoing reconcileGmailPhysicalScope and account cleanup call mailbox-wide users.stop under that key. New/new writers use unique upsert and live-consumer predicates. This is not an R1 implementation gap. R2 moves watch HTTP outside SQL and deletes the key once no stop-capable API is serving, in flight or a rollback target. OAuth/KMS/profile work stays outside; the unapproved rolling notification-gap alternative is not implemented. Label/configuration/dispatch credential preparation now uses owning commands. Dispatch reads, deduplication and label/cursor SQL now use owning commands. Queue source validation and event publication now commit in one direct-SQL owning command. Lazy missing-thread publication now owns its SQL. Shared credential, atomic automation creation and account-deletion handle propagation remain unfinished implementation. |
| Calendar watch — `google-calendar-automation-event.service.ts`                          | Lifecycle advisory acquisition and pending/previous-channel recovery are removed. Provider preparation precedes exact credential/watch conditional publication; snapshot batches are capped at 250. Ordinary lifecycle, activation, dispatch and queue SQL now use owning commands.                                                                                                                                                                                                                                                                                                                                       | Outgoing Calendar stop/cursor changes may cause the accepted notification gap and do not justify retaining its lifecycle key. The separate builtin credential coordination still depends on the unfinished shared account protocol. Lazy workflow-thread initialization now owns its SQL. Shared atomic creation, official/account projection and credential handle propagation remain implementation work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Meet subscription — `google-meet-automation-event.service.ts`                           | Ethan accepted Calendar-style gaps for Meet on 2026-09-30. Access resolution and Workspace Events create/renew/adopt/delete run outside transactions; a short publication rechecks the account and enabled consumer before persisting, and removal deletes local state only while no consumer is enabled, then deletes remotely best-effort.                                                                                                                                                                                                                                                                              | The builtin connector key is taken only for those local writes because outgoing writers still hold it across provider HTTP. Account-deletion delete preparation now runs before the deletion transaction, like Calendar and Forms; handle propagation remains unfinished.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Forms watch — `google-forms-automation-event.service.ts`                                | Remote preparation and pagination precede conditional publication; repair restores a usable watch. Normal dispatch and deduplication remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Failure-window trigger loss is accepted. Forms lifecycle advisory coordination, detachment, cursor triggers, automatic catch-up, original-seed recovery and the second activation lock are removed. Late setup still cannot revive disable/revocation. Ordinary activation, default account and Forms-to-Forms official publication have owning commands. Lazy thread publication now owns its SQL. Shared credential, atomic creation and generic account/official handle propagation remains unfinished.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Morning Brief preference — `morning-brief-preference.service.ts`                        | Generic workflow toggles now own enrollment, automation and native-obligation SQL in one command; timezone synchronization is a separate command-local finite transaction with no transferred handle.                                                                                                                                                                                                                                                                                                                                                                                                                     | Automatic/default installation and explicit-choice orchestration still need a common latest-intent publication predicate. Enrollment completion and native materialization now share one command-local finite transaction. Their outer transaction/polling and latest-choice publication remain implementation work. Timezone lock polling occurs between completed transactions, never inside a transferred callback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Morning Brief native owner — `morning-brief-native-schedule.service.ts`                 | **Unfinished.** Existing epoch/fence handles present rows; absence still coordinates first materialization with legacy `ordinary` classification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Prepare all classification/materialization writers on existing business identities before removing the absent-owner key. A staff-only native control does not make shared legacy schedule writers non-GA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stripe customer — `billing-customer.service.ts`                                         | Provider preparation outside transactions, stable idempotency key, command-local conditional binding and metadata/entitlement SQL; ambiguous provider/commit recovery reads the committed binding.                                                                                                                                                                                                                                                                                                                                                                                                                        | Outgoing creation holds the original key, reads the binding, then creates and unconditionally writes. R1 publication takes that same key and rechecks before CAS; either winner is preserved. Only this short compatibility acquisition waits for incompatible serving/in-flight/rollback writers to retire.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Organization purchase — `billing-purchase-lock.service.ts`                              | Stale Team previews reject a competing unbound paid Pro subscription; old purchase replay also checks for a later competing subscription. Full common purchase admission remains **unfinished**.                                                                                                                                                                                                                                                                                                                                                                                                                          | Purchase creation must prevent duplicate payable subscriptions. Configuration writers must persist shared local desired state and reconcile Stripe from it; temporary remote quantity drift is accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Subscription sync — `webhooks-stripe.service.ts`                                        | Every concurrency projection writer advances existing `updated_at` at database precision; provider-result publication uses an exact timestamp and transient existing xmin snapshot. Missing rows use PK arbitration; known removed subscriptions keep their actual canceled projection.                                                                                                                                                                                                                                                                                                                                   | **Key and both acquisitions deleted.** New publication uses exact-state CAS and invoice uniqueness, with Stripe outside transactions. Daily identity-bucket reconciliation repairs live provider observations, including missed webhooks and later old-handler writes; scoped visits cover all live identities. It creates no invoices or payments. Desired concurrency intent, purchase admission and remaining configuration writers are still R1 work, not completed by this provider-fact repair.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Allocation — `usage-pack-allocation-change.service.ts`                                  | **Partly implemented.** Usage pack identity-only sync, daily sweep, invitation activation/refund, quote/confirmation/removal drift repair use existing allocation records. Other writers remain; local conditional state updates retained.                                                                                                                                                                                                                                                                                                                                                                                | Convert the remaining allocation paths and the Plan, migration and concurrency writers to local desired configuration, with Stripe calls outside transactions and daily reconciliation. Retention solely to prevent temporary remote drift is no longer justified. Payment-backed grants and payable creation still require business idempotency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plan change — `usage-pack-plan-change.service.ts`                                       | Same shared projection boundary as allocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Same shared-writer prerequisite. Transaction forwarding and Stripe I/O are separate unfinished obligations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Invitation purchase — `usage-pack-invitation-purchase.service.ts` purchase key          | Atomic purchase claims, exact refund predicates, and conditional state transitions. Public API tests distinguish the accepted-invite reward from duplicate credit grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Outgoing by-ID purchase/refund writers require compatibility. Shared subscription projection still needs completion before full removal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Invitation email — same file, email key                                                 | **Removed.** Existing active-email unique index arbitrates preview/supersession. Paid collisions retain captured-money refund handling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Constraint and conditional state handling operate with supported outgoing writers; no new coordination row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Usage display — `chat-usage-event.service.ts`                                           | **Removed.** Chat amounts come from a bounded, authenticated raw/hourly ledger read, including allowance units and retained billing attribution. The App uses usage events only as refresh hints.                                                                                                                                                                                                                                                                                                                                                                                                                         | Random hint identities and duplicate/delayed delivery are accepted, so outgoing writer ordering no longer requires the key. Deterministic identity, archive-pointer/revoke recovery and Run-parent serialization are removed. The additive read keeps old event payloads readable; only its outgoing-API 404 fallback has a serving/rollback endpoint gate. No App floor or Runner drain. See the [usage boundary inventory](./advisory-lock-release-1-usage-boundaries.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Credits/allowance — `usage-allowance.service.ts`                                        | Standalone and Social settlement own all financial SQL; the Social receipt commits with ledger, allowance, grants and wallet. Managed/billable/Social availability refresh prepares Stripe outside a local entitlement command and publishes against its observed row.                                                                                                                                                                                                                                                                                                                                                    | Outgoing SELECT-pending / unconditional-by-ID processed updates can otherwise double-charge. Retain the key until every supported settlement/refresh writer is prepared. Standalone/Social financial transaction APIs were removed. Queued model selection uses owned credit/allowance commands. Firewall allowance admission now owns its Run/entitlement/window SQL. Other legacy Run/PI and Social snapshot chains and the broader Clerk cleanup transaction ownership remain unfinished; see the usage boundary inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Compaction shared — `usage-event-compaction-lock.service.ts`                            | Compaction and settlement take Run parents before raw ledger, then hourly aggregates. Clerk lifecycle now takes Social jobs, Agent/Session/Run parents, entitlement, raw and hourly rows in the common order.                                                                                                                                                                                                                                                                                                                                                                                                             | Outgoing deleters/compactors use the old order. The common Clerk/settlement ordering is implemented. Core Clerk lifecycle deletion now owns direct SQL, including conversation/blob accounting. Surrounding run cancellation, Storage and connector-cleanup helpers remain implementation work, in addition to the outgoing-writer gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Compaction exclusive — same file                                                        | Compaction owns exact rows, uses SKIP LOCKED, and publishes aggregates from the rows actually acquired in one command-local transaction. Pure raw-result decoding no longer needs the transaction argument.                                                                                                                                                                                                                                                                                                                                                                                                               | Same old-writer ordering gate. A lexical SQL reduction alone does not prove every raw/hourly writer migrated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SSH owner — `ssh-credential.service.ts`                                                 | Credential and host create/update/delete/reset commits are business-argument commands with direct local SQL; KMS precedes commit and invalidation follows. Rotation uses credential revision CAS and atomic host-generation increments; attachment uses resource uniqueness and the credential-owner FK; rebinding uses host generation CAS.                                                                                                                                                                                                                                                                              | The SSH owner key and all three acquisitions are deleted. Outgoing host/credential writers read their revisions after their existing row acquisitions, so their ordinary writes compose with the new conditional writes; no new row locking is introduced. See the key-retirement inventory for the complete writer boundary. Cloudflare mutations now also own finite command SQL, with KMS before commit and invalidation afterward. Configuration list/summary/observation and Runner host-inventory reads now own their commands. Correlated Run/thread access predicates are pure SQL builders without database parameters. Credential-delivery, retained test probes and shared initial-chat interfaces remain in the full caller sweep. No permanent KEEP exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| VNC scope shared/exclusive and owner — `vnc-owner-lifecycle.service.ts` (3 definitions) | **Removed.** Existing member-row `created_at` identity, command-local credential/host writes, and cleanup in the same member lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Create/admission/cleanup reject a member identity removed during external preflight. Configuration routes no longer carry `db` through context spreads; list/summary, credential preflight and post-conflict reads own their database commands, with only business inputs between them. Run-host inventory admission returns ordinary authority results; its read command owns the complete permission query. Main's X509None profile and same-revision conflict behavior are preserved. Focused static checks pass; combined-head pipeline remains required. Shared initial-chat transaction interfaces remain unfinished. No new field or non-GA compatibility fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Fixtures, operator and final schema

- The catalog fixture session lock and release hook are removed. Vitest runs the
  three suites that mutate its real singleton in one sequential project after
  ordinary API suites. The existing `--project=api` filter includes both child
  projects. At that project split, file discovery preserved the 398-file audit set, with
  three catalog files and 395 ordinary files. That is historical discovery
  evidence, not a current test-count or full ownership inventory; no local
  test execution was used.
- The billing-attribution operator's advisory key, explicit row locks, NOWAIT
  and lock_timeout are removed. Mutation still requires its existing explicit
  writer-drain acknowledgement. Conditional checkpoint advancement rejects a
  competing invocation without retry; scoped source writes retain their exact
  identity predicates. Local empty-inventory CLI smoke checks do not establish
  production convergence.
- Migration `1297_retire_provisional_billing_purge` drops the unused current
  `purge_quiescent_provisional_billing_attribution` function. Historical
  migrations stay unchanged. The schema snapshot adds no table columns.
- The unshipped Forms detachment and cursor-trigger migrations are withdrawn.
  The existing non-null cascading cursor/watch relationship is unchanged; repair
  may start from newest and may miss failure-window triggers. Normal dispatch,
  basic deduplication, stop and authority checks remain required.
- Main's migration `1290_retire_cloudflare_access_triggers` removes both
  Cloudflare triggers and their functions, using its documented supported-writer
  and rollback evidence. This PR preserves that migration and the new defensive
  promotion check, and withdraws its duplicate unshipped scope-only retirement.
  Recheck that evidence before release; main does not prove production migration
  completion. No schema column changes.
- Attribution and allowance reader fallbacks remain. A full live data-convergence
  census has not established their removal conditions; tool age and CI references
  are not convergence evidence.

Migration `1298_retire_billing_attribution_mutation_guard` also removes the
redundant canonical attribution mutation guard. Outgoing capture functions and
the retained operator already compare immutable identity, fill only unknown
thread grouping, and never regress observation. The writer-by-writer evidence
is in the trigger retirement inventory. The [production/fixture writer trace](./advisory-lock-release-1-billing-trigger-writers.md) identifies the explicit capture and retention behavior, plus remaining test-state producers. The six billing capture/observation triggers retain their separate implementation and compatibility requirements.

## Current implementation status

The complete Notion event service now uses business-input commands for credential
preparation, verification, receipt/source discovery, repair, input publication
and pending execution. Meet's webhook/lifecycle-notice/receipt/dispatch graph is
also owned; its subscription ensure, renewal and deletion remain separate
implementation. Generic workflow event creation commits the selected account,
binding, optional thread, created event and automation in one owning command.
Schedule polling/claim/settlement and Official metadata publication have the same
ownership shape. Specialized Webhook/Stripe creation, final enable and Official
rollback, Morning Brief native lifecycle, Run/Pi callbacks and unbounded tick
coalescing remain explicitly unfinished in the workflow inventory.

Invitation payment/claim/refund/acceptance commits now own their direct SQL.
Activation and refund removal commit only local allocation/grant rows, then call
the identity-only `syncUsagePackSubscriptionConfiguration$` after commit; no
invitation transaction carries Stripe I/O. The same command runs from the hourly
billing cron in 24 stable identity buckets, so each usage pack subscription is
reconciled daily (see the declarative Stripe mapping for its exact scope).
Initial and revised migration quote preparation/publication use owning commands
and reject a changed source Plan before inserting or retiring intent. Existing
Plan/allocation/invitation operations share admission predicates, but the complete
remote quantity/schedule and ordinary purchase protocol is not yet implemented.
The Stripe evidence distinguishes the viable schedule-only candidate direction
from the unresolved immediate-payment, recovery and pre-release authority edges.

Shared prepared Storage publication and Custom definition OAuth SQL are now
executed directly by their owning commands. Pi invalidation/recapture still
propagates their transaction and remains implementation work. Transient provider
refresh failures no longer mutate newer authorization metadata; rotating-token
and explicit revocation protocols still need provider-specific completion.
Airtable is decided: ordinary refresh like every other provider, accepting that a rare concurrent refresh may revoke the grant and require reconnection.

## Correction follow-up and acceptance gaps

The zero-trigger terminal constraint from `4fa8844` applies to all application
triggers, including nine that predate this PR. The
[trigger retirement inventory](./advisory-lock-release-1-trigger-boundaries.md)
records the historical eleven-definition proposal. The two unshipped Forms
triggers are withdrawn, main's migration 1290 retires both Cloudflare guards,
and migration 1295 retires the canonical mutation guard. Six billing capture and
observation definitions remain. Their explicit writer replacements remain an
acceptance requirement; the existing schema-test constant named
`EXPECTED_PERMANENT_TRIGGERS` does not grant a permanent exception.

The binding command shape added in commit `77a12aa` is retained. Commands take
business inputs and an optional final `AbortSignal`, resolve `writeDb$` internally,
and directly execute finite SQL in their own transaction. Neither the root `db`
nor `tx` can be forwarded. Renaming a helper or wrapping it in a command does not
satisfy this rule.

The following integrated changes address specific review findings; their limited
scope is intentional evidence, not a whole-package completion claim:

- `0cbba4e`: DCR preparation and publication replace the root-Db contract assertion
  with a plain catalog snapshot and direct SQL checks. Registration API tests
  accept independent remote candidates but require the same published client and
  successful authorization callbacks.
- `2181ec9`, `055e94f`: Forms consumer/retry operations and their external callers
  use no-Db command inputs. The lifecycle and projection publication commands own
  finite SQL. Subsequent commit `7d062d3` moves Forms queue persistence into its own direct-SQL command; shared automation-thread creation still forwards `tx`.
- `ea7187c`: Storage upload, reconciliation and deletion commands own their SQL;
  archive preparation/upload/verification occur outside those commits. Agent
  instructions publication rechecks permissions and identity. Other catalog,
  custom-account and workflow publication chains still forward transactions.
- `39925da`: the member-cleanup input DTO removes the 129-line lint failure
  without weakening cleanup. `1f54251` repairs the Atom Custom Stripe fixture's
  missing current billing period; it preserves the API expectation of quantity 3. These fixes require the integrated pipeline, not the old failing revision.
- `c249e9f`, `89e2885`: invoice/update concurrency projection commands now
  contain direct finite SQL and no transferred database handles. Provider GET
  precedes the commit. Existing `xmin` is a transient snapshot predicate, not a
  new stored version; an actual canceled row prevents delayed initial invoice
  publication from reviving a known removed subscription.
- `124966b`: usage display archive I/O and allowance Stripe preparation move
  before financial commits; the direct-SQL display command validates the archive
  pointer and exact entitlement predicates abort stale financial work. The
  remaining settlement/allowance/cleanup SQL graph is explicitly unfinished.
- The shared-prefix implementation removes namespace arbitration and its
  incidental organization initialization. Connector creation therefore cannot
  create the partial organization/entitlement state that caused the earlier
  chat-creation regression. Normal onboarding retains its complete initialization;
  target selection continues to reject ambiguous or unauthorized identities.
- `c332058`: rejected Model Policy updates now roll back default-row preparation
  before returning their original conflict/validation response. Public API
  revision/initialization coverage remains; later continuation removes the
  internal uninitialized-state snapshot assertion and its fixture.
- `ec10bad`: a losing credential refresh returns connection-changed. It cannot
  reuse a replacement authorization merely because the account/method/storage
  identity stayed the same; the existing API rejection assertion is preserved.
- `7b2e6d3` was superseded by the accepted display semantics and `140198c`.
  Chat amounts now come from a bounded settled-ledger API. Usage events only
  request refresh; the display advisory key, Run-parent ownership, archive
  reconciliation, revoke events and deterministic hint IDs are removed.
  Supported older Apps still receive the established hint payload.
- `4cd0a46`: the new concurrent VNC rotation test uses valid eight-character
  protocol passwords. Its exact one-success/one-conflict and host-revision
  assertions are preserved.
- Forms no longer promises failure-window replay. The former cursor detachment,
  progress-preserving triggers, retained-seed retry and synthetic cron catch-up
  are removed under the latest accepted behavior. API coverage still protects
  explicit disable/re-enable, current source ownership and recovery that resumes
  normal notifications. This is not a waiver for money or credentials.

| Remaining R1 requirement                                                        | Responsible scope                                                                                                  | Evidence needed to close it                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A common Stripe quantity/schedule protocol and organization purchase admission  | Billing                                                                                                            | Map existing business records and their writer/webhook ownership to one shared current/future subscription projection. Implement command-owned writes to those records, identity-only synchronization and daily reconciliation. Repair temporary remote drift; separately prevent duplicate payable subscriptions, repeated proration charges and unpaid entitlement. No new table, field or JSON coordination state. |
| One-time credential rotation, revocation, callback and runtime writer agreement | Credentials and bootstrap model-provider chain                                                                     | Prepare every supported writer, keep stale credentials rejected, and prevent a late remote rotation/revoke from invalidating the authoritative credential. Local winner readback is only one part.                                                                                                                                                                                                                    |
| Actual no-handle command ownership across the remaining graph                   | Forms queue/thread, DCR runtime/store, Custom account, Storage catalog/workflow, Usage, Billing, credential chains | Trace callers and direct SQL, remove root-Db and transaction forwarding, and move provider/archive/KMS I/O outside commits. Existing local improvements do not waive other callers.                                                                                                                                                                                                                                   |
| Latest-choice Morning Brief preference and native schedule materialization      | Morning Brief                                                                                                      | Cover explicit choices, defaults, generic workflow toggles and existing native classification/absence before removing coordination.                                                                                                                                                                                                                                                                                   |
| Attribution/allowance fallback convergence                                      | Usage maintenance                                                                                                  | Verify the actual persisted data convergence condition before deleting readers; age and CI references are not evidence.                                                                                                                                                                                                                                                                                               |

Gmail local stop/remote expiry and Calendar gap/best-effort cleanup now have
explicit product approval, recorded in the terminal document. Gmail remote-stop
code is removed; the remaining caller ownership work is implementation. None of
these gaps is evidence for a third release or merely waiting for R2 deployment.

### Morning Brief enrollment ownership

Enrollment reads, first admission, explicit choices, membership qualification
publication, retry admission and retry completion now use business-argument
commands. Each resolves `writeDb$` internally and executes its finite SQL;
Clerk webhook, timezone initialization, the bounded worker and preference
callers no longer pass a database handle into this subgraph. Existing predicates
retain the recorded choice, membership identity and retry schedule. The legacy
transactional migration-state reader performs its enrollment SELECT directly,
so it does not cross into a separate command and lose its caller snapshot.

This change does not remove the outer preference lock/callback transaction or
finish the native absent-owner and generic workflow publication protocol. Those
remain implementation work: the installed automation and the enrollment choice
must share conditional publication before Release 2 removes that boundary. The
existing enrollment lease/backoff fields predate this cleanup; no new field or
coordination state was introduced. Existing user API tests cover first
installation, explicit disable, membership changes and retries. Scoped formatting,
Oxlint and ESLint pass; combined-head type and behavior checks are still required.

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
propagation; an all-API end-state claim would be false. The combined syntax snapshot after
`5b28ebe` contains 431 construction sites: 271 directly transferred, 41
ordinary-helper-owned, and 119 command-local candidates. These counts do not
cover every root-Db flow or establish semantic safety. In particular, 422 is
the historical baseline, not a current complete propagation inventory.

[Usage and Storage boundaries](./advisory-lock-release-1-usage-boundaries.md) and
[billing boundaries](./advisory-lock-release-1-billing.md), and
[credential/watch boundaries](./advisory-lock-release-1-credentials.md), and
[Model Policy boundaries](./advisory-lock-release-1-model-policy.md), and
[workflow queue boundaries](./advisory-lock-release-1-workflow-queue.md) record the remaining
actual caller chains. The semantic obligations above remain open independently
of these syntax counts.

## Validation and release readiness

Forms publication keeps exact existing automation observations to reject late
setup after disable, thread/member deletion or account replacement. Ordinary
activation stays disabled during provider work and commits only under current
authority. Command-owned default account projection and Forms-to-Forms official
publication preserve current source checks without a detachment or second-lock
protocol. Repair may start a new response baseline and miss failure-window
triggers. The two unshipped Forms trigger migrations and cursor FK change are
withdrawn, and cron no longer performs synthetic catch-up. Shared credential,
atomic creation and generic account/official command boundaries remain unfinished;
see the [credential/watch inventory](./advisory-lock-release-1-credentials.md).

The `bcabda2` Usage follow-up prepares at most 100 exact operation events outside
the commit. Managed, OpenRouter and image-generation calls settle their own
idempotency keys; background catch-up pages between transactions. The commit
rechecks event and pricing snapshots before atomic financial writes. Standalone
pricing is prepared outside SQL, and conflicts roll back before bounded
re-preparation. Social retains its receipt and reservation release in the same
commit. Social managed/fixed-price preparation now also precedes the transaction and
its job snapshot is revalidated. Allowance reads select only the latest covering
short/weekly windows for the finite event anchors. Grant preparation pages
outside the commit and selects the actual purchased-before-bonus debit prefix,
with input and earlier-grant validation at commit. Active organization lots use
the current debit's first-expiring prefix, prepared outside the transaction.
`c2b50e1` refreshes allowance evidence on every preparation retry and rolls stale
entitlement evidence back through the same typed conflict. `9bd4453` explicitly
captures and publishes Social billing attribution in the receipt's owning
transaction, retaining the job, money and reservation atomicity. The required
grant/lot debit prefix can still be large. Expiration now prepares at most 100
lots outside each normal commit and rechecks the exact selected rows. A larger
expired cohort retains the old atomic clamp only for the concrete outgoing
credit-adder interleaving documented in the billing inventory; R1 monetary
writers must finish or reject remaining expiration before adding credit.
Legacy inline callers and trial-grant provenance still need implementation.
The event limit alone does not certify a short transaction.

Individual source branch checks are evidence for those revisions only. The
combined head must pass its own relevant static checks, types, API tests and
migration pipeline. Full local Vitest and local development servers are not run.
No PR auto-review, merge queue, merge to main, production promotion or deployment
approval is included in this implementation authorization.

The merged main includes the Desktop transitive audit fixes from #37327.
Do not carry the earlier dependency-audit failure forward as a current result.
Likewise, do not discard a failing API invariant or call it flaky without
finding its causal interleaving.

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

## Integrated continuation verification

The `cef9630` preview failed the 27 Runner chat requests because its ORM still
selected `chat_threads.selected_image_model` after the preview database had
applied main's column contraction. Merge `978f124` incorporates main `712de8a`
and its readers. On combined head `44e3d33`, all twelve Runner E2E shards and
the browser chat smoke passed. These user-facing cases remain intact.

The concurrent Stripe webhook case now redelivers each failed original event
and requires the final billing quantity, as the projection protocol specifies.
It passed API shard 6 on `44e3d33`. API shard 5 exposed a fixture expectation
introduced by invitation-test consolidation: the fixture starts with a full
paid period, rather than the removed case's half period. Commit `dc7a262`
compares the complete billing response before and after pre-acceptance payment,
then verifies activation and redelivery, including the existing 100-credit
invitation reward. API shard 5 passed on combined head `117aab2`.

Four Model Policy cases and their dedicated internal-lock/uninitialized-state
fixtures were removed. Public API cases still cover initialization, stale
revision rejection and preservation of another administrator's configuration.
The chat routing case now constructs its workspace default through that API.
Calendar no longer exposes the internal admission hook. Forms retry delivery
shares the normal delivery setup, while usable repair and explicit disable /
re-enable retain separate tests without failure-window replay assertions. Credential replacement asserts the stored
replacement token through a subsequent provider request, without watch counts.

The next combined batch also owns standalone usage settlement and SSH mutation
SQL in their commands. The former SSH member-row/advisory protocol is superseded:
SSH attachment, rebinding and rotation now arbitrate with existing resource
uniqueness, foreign keys and revision/generation conditional writes. The owner
key and its three acquisitions are removed in R1, not deferred to R2.
This does not complete the unrelated shared Storage, native schedule or
credential transaction graphs.

### Combined verification at `117aab2`

The [combined pipeline](https://github.com/okou-ai/okou/actions/runs/36526993963)
passed API types, ESLint/Oxlint, formatting, Knip and migration validation. API
shards 2–7 passed, including Stripe original-event redelivery, invitation
acceptance balances and the Usage allowance accounting regression. All twelve
Runner E2E shards and browser chat smoke passed again. API shard 1 was cancelled
by fail-fast after shard 8 failed; cancellation is not a behavioral failure.

Shard 8 exposed a real Automatic refresh regression: a concurrent expiry request
treated a sibling's completed refresh as replacement consent and returned 502.
The correction observes the existing OAuth binding row identity, which changes
on authorization replacement but survives a token refresh. It permits reuse only
while that exact binding still exists and retains exact account/token predicates
for publication. The original API success and revocation assertions are retained.
This fix and subsequent command-boundary work require a new combined-head
pipeline; the earlier green checks are not substituted for it.

Later work includes command-local Automatic start/callback preparation,
Morning Brief enrollment/materialization, Billing downgrade and empty-subscription
cancellation, and the common Clerk/settlement parent ordering. These are concrete
boundary improvements, not a declaration that every writer or helper is complete.

### Subsequent command and test changes

`fd18a6d` moves complete Model Policy replacement into a business-input command
with direct SQL for parent/set ownership, validation reads, policy writes and
member preference projection. `a82fa82` also ensures the reused pure write planner
receives an explicit business-value object rather than a wider legacy argument
that happens to contain a database. Lazy initialization, onboarding ownership and
response-read adapters were subsequently migrated to owning commands; the current
Model Policy inventory lists the remaining surrounding callers.

`c88273e` owns Clerk's core user/organization lifecycle deletion and its
post-authority cleanup in commands. Conversation/blob reference accounting,
Run ownership and PI cleanup remain atomic. `7fda4ba` removes the retired
transaction-bearing helper; `305699e` removes database parameters from Clerk's
connector-revocation dispatch and accepted-catalog preparation. Those entry
points return or pass ordinary committed business values. The underlying
connector teardown, run cancellation and Storage chains are still listed as
unfinished; changing these entry points does not complete those callees.

Automatic cancellation now occurs at the actual Ably request boundary and checks
the stored account/token plus runtime notification. DCR retirement uses provider
HTTP completion and real account APIs; its private account row-lock fixture is
removed. All outcomes for revoked credentials, surviving accounts and defaults
remain asserted. Calendar credential predicates are pure SQL builders receiving
only observed values.

On `163d774`, API shard 8 passed with the Automatic consent-identity correction.
API types, lint, Knip and migration also passed. Shard 3 then exceeded the 5-second
budget in the Browser native-file-input case, which serializes independent
selection, transfer-integrity and cleanup scenarios. There was no reported
assertion or endpoint failure identifying a product defect in that case; it is
not labeled a demonstrated flake. The following combined pipeline must verify
its test-structure change and every later code change on the same head.

## September 29 continuation status

The two reported billing-checkout failures at `74a09e9` were fixed without
weakening their API outcomes. Commit `5265d5a` compares the locally observed
cancellation flag with the actual prepared Stripe state and supplies the
current invoice-pricing fixture shape. The valid immediate upgrade still
returns 200; changed quoted inputs still return 409 before mutation. The API
also verifies unchanged amounts after conflict and a successful fresh quote.
The complete pipeline at `5265d5a` passed, including all eight API shards, all
Runner shards, browser smoke, types, lint, formatting and migrations.

Subsequent command-owned slices include Drive and email credentials, multi-auth
publication, atomic single-secret replacement, bounded personal account upsert,
activation and exact/all-account disconnection, existing reward/wallet ordering,
first-paid debt preparation, legacy Plan invoice publication and Morning Brief
enrollment. Provider cancellation follows the committed legacy Plan receipt;
redelivery retries cleanup without issuing another grant. These additions do
not complete the surrounding provider, native schedule or financial graphs.

Pipeline `36556269276` at `ac17a1a` passed all Runner E2E, browser smoke, lint,
formatting, Knip and migration checks. Its API type failure (readonly expiration
IDs supplied to Drizzle) is fixed by `7a63c8b`; its API shard 8 Calendar text
matcher is corrected in `140198c` while preserving the original 400 response
and source/permission assertions. Cancelled API shards are not passes. The
combined continuation requires its own pipeline; earlier green revisions are
not the result for subsequent code.

The principal unfinished Release 1 requirements remain shared Stripe quantity/
schedule publication and ordinary purchase admission, actual caller-specific
credential rotation, monetary writer/finite trial provenance, Morning Brief
latest-choice/native ownership, and the remaining database-handle graph.
Airtable's token-family revocation tradeoff is decided (ordinary refresh,
accepted reconnect risk) and is no longer an open R1 item; see the credential
inventory.
No field, coordination table, JSON claim, new trigger or third release is used
to hide these gaps.

### Continued command ownership and combined validation

The current implementation also owns lazy Model Policy initialization and routing
preparation, chat metadata mutation, MCP discovery/creation/thread projection,
workflow lazy thread publication, all six integration route/thread/event writers,
Discord/Slack/Feishu receipt admission, and ordinary/integration/Stripe queue admission. Pure
SQL builders and ordinary route snapshots replace database-bearing adapters in
those paths. Workflow launch bookkeeping now returns ordinary data rather than a
closure retaining its database. Usage-pack migration publication owns direct
snapshot/allocation SQL and no longer traverses the unrelated pending-count
callback. See the detailed Model Policy, workflow queue and billing inventories
for exact scopes.

The `c942d2d` pipeline passed API shards 2/4/6/7/8, types, lint, format, Knip,
migration, all twelve Runner shards and browser/Playwright checks. Its remaining
API 5 failure counted duplicate realtime steering hints. The test now checks the
public event stream for exactly one replacement per source, the original order,
correct Run binding and idempotent declaration retries. API shards 1/3 were
canceled by that failure. These results precede the subsequent ownership changes;
they are not a passing combined-HEAD result for those changes.

The shared Stripe quantity/schedule/purchase protocol, provider-specific credential
rotation, remaining financial and thread/Storage/producer transactions, and the
remaining trigger-writer inventory are still implementation work. Neither these
ownership commits nor fewer acquisition definitions establish Release 1 readiness.

At `556c316`, all eight API shards, all twelve Runner shards, browser/Playwright,
API/App types, formatting, Knip and migrations passed. Lint identified two
function-length violations, one pure credential classifier complexity violation
and obsolete event-helper imports. Those checks apply to that specific revision;
subsequent Slack/Discord ownership and SSH/VNC test cleanup require their own
combined-head validation. The removed SSH/VNC waiter fixtures and Stripe test
triggers are documented in the workflow queue inventory, with retained public
revision, source-isolation and replay outcomes explicitly listed.

The subsequent compaction gap is now implemented explicitly within the existing
500-row batch: all contexts resolve against retained canonical attribution or a
matching live Run, preserving original precision and ownership. Unavailable
sources remain unresolved; no production convergence is assumed. All three
benchmark/dev Run INSERT sites now use a bounded owning command that captures
their provisional billing identity explicitly. See the trigger inventory for
remaining writer-audit, transaction-ownership and reader-convergence limits.

The shared prepared-volume database adapter is removed at all seven publication
sites: Agent instructions, two Custom connector mutations, Feishu connector
repair, official Workflow catalog activation, and Workflow create/copy. Each
site directly executes one pure SQL builder that retains Storage, validates the
immutable version and commits HEAD plus the prepared Pi index. Preparation and
R2 verification remain outside publication. This closes that shared propagation
chain; enclosing OAuth, Pi invalidation and ordinary catalog/Workflow owners
remain explicitly unfinished rather than being disguised by the SQL builder.
