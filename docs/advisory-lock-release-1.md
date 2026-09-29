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
includes main `ed6b467`, preserving the browser preferences, thread-image
schema contraction, retired VNC grant cleanup, current generation identity and
the rule prohibiting new database triggers.

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

| Package / definition                                                                    | Implemented preparation or direct retirement                                                                                                                                                                                                                                            | Retained reason and R2 gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap — `org-limited-free-bootstrap.service.ts`                                     | Independent Agent/Storage candidates; upload and verification outside publication; independent unique grant command; final Agent insert plus default-Agent CAS; authoritative cleanup resolution.                                                                                       | Outgoing API still unconditionally publishes a default Agent. Keep only the publication compatibility key until those writers drain. Both onboarding and Clerk webhook use the prepared command.                                                                                                                                                                                                                                                                                                                                                            |
| Browser — `browser.service.ts`                                                          | **Removed.** Existing unique owned-thread slot and exact state predicates arbitrate all six former call sites. All eight transactions are command-local with direct SQL.                                                                                                                | #37097 serving, drain and rollback evidence established; recheck before promotion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Custom account — `auth-state-lock.service.ts` custom branch                             | **Removed.** Ordered account mutation and selection UNIQUE/FK arbitration remain. The initial-thread ownership/projection deletion race is fixed by omitting only an authoritatively absent account.                                                                                    | #37097 serving and rollback evidence established. Shared account transaction propagation still needs structural cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Custom prefix — `custom-connector.service.ts`                                           | **Removed.** Accepted shared-prefix semantics remove the organization-wide exclusion scan, organization-row serialization and advisory key. Existing org/slug uniqueness retains identity; API and Runner select an explicit authorized connector or reject ambiguous routing.          | No prefix-exclusivity old-writer gate remains: exclusivity is no longer a business invariant. Existing Runner intent/ambiguity handling and ID-scoped credential resolution are unchanged. OAuth/Storage transaction ownership remains a separate implementation gap; see [prefix evidence](./advisory-lock-release-1-custom-prefix.md).                                                                                                                                                                                                                    |
| Model policy — `model-policy.service.ts`                                                | All three writers now share existing default-slot uniqueness, ordered parent/policy ownership, and a fresh whole-set identity check. Empty initialization inserts only the real default before completing the seed; replacements retain client revision checks.                         | Outgoing seed/default writers lack common row-set ownership. Retain the key for overlap. Complete replacement and onboarding publication now own direct SQL and pure validation in their commands. Lazy seed/default and response-read adapters remain **unfinished** structural work; they are not a compatibility exemption.                                                                                                                                                                                                                              |
| Builtin credential state — `auth-state-lock.service.ts`                                 | Ordinary refresh prepares KMS inputs/outputs before persistence and compares the exact stored input bundle before local writes.                                                                                                                                                         | Outgoing unconditional secret writers require the key. One-time remote refresh and credential deletion/rotation still need a complete shared protocol; post-response CAS alone cannot prevent a provider-side stale rotation.                                                                                                                                                                                                                                                                                                                               |
| Model-provider credential state — `auth-state-lock.service.ts`                          | **Unfinished.** Existing account/credential ownership was traced.                                                                                                                                                                                                                       | One-time refresh, stale credential rejection, run capture, deletion and KMS boundaries must be prepared together without new claim/revision fields. Current locking is not proof of R2 readiness.                                                                                                                                                                                                                                                                                                                                                           |
| Automatic OAuth/DCR — `builtin-connector-automatic-dcr.service.ts`                      | Provider registration and encryption precede conditional issuer publication. Issuer uniqueness selects the published winner; linked-account replacement and reconnect are bound to exact registration identity.                                                                         | Registration preparation/read/publication now use no-Db command inputs and direct SQL, including an existing catalog identity snapshot fence. Callback token exchange and KMS now precede a command-local atomic account/secret/binding publication, and exact-registration retirement has its own command. Start and callback entrypoints, state claim, catalog reads and post-commit wakeup now use owning commands. Runtime refresh still needs its full caller graph and one-time-provider protocol; the key cannot yet be classified as outgoing-only. |
| Gmail watch — `gmail-automation-event.service.ts`                                       | Approved local-stop/remote-expiry behavior is implemented: no `users.stop`, no remote-stop preparation on account deletion, and inactive state cleanup checks that no current consumer remains.                                                                                         | Late notifications are ignored for inactive consumers. Shared enabled consumers and normal deduplication remain. Ensure, renew and watch reconciliation now use no-Db owning commands. Only watch HTTP plus publication temporarily retains the existing lifecycle transaction: outgoing pre-R1 users.stop can otherwise terminate a new watch. Remove it after those serving/in-flight/rollback writers are gone. Label/configuration/dispatch credential preparation now uses owning commands. Dispatch/queue SQL, shared credential and account-deletion handle propagation remains unfinished implementation. |
| Calendar watch — `google-calendar-automation-event.service.ts`                          | Paginated baseline and credential/provider preparation precede publication; exact watch and credential predicates fence publication. Ambiguous commit recovery reads authoritative state before stopping a candidate.                                                                   | Outgoing lifecycle updates require compatibility coordination. Remaining provider-stop and helper transaction boundaries must be completed, not labeled rollout-only.                                                                                                                                                                                                                                                                                                                                                                                       |
| Forms watch — `google-forms-automation-event.service.ts`                                | Remote preparation and pagination precede conditional publication; repair restores a usable watch. Normal dispatch and deduplication remain.                                                                                                                                            | Failure-window trigger loss is accepted. Forms lifecycle advisory coordination, detachment, cursor triggers, automatic catch-up, original-seed recovery and the second activation lock are removed. Late setup still cannot revive disable/revocation. Ordinary activation, default account and Forms-to-Forms official publication have owning commands. Shared credential, create, thread and generic account/official handle propagation remains unfinished.                                                                                             |
| Morning Brief preference — `morning-brief-preference.service.ts`                        | Generic workflow toggles now own enrollment, automation and native-obligation SQL in one command; timezone synchronization is a separate command-local finite transaction with no transferred handle.                                                                                   | Automatic/default installation and explicit-choice orchestration still need a common latest-intent publication predicate. Enrollment completion and native materialization now share one command-local finite transaction. Their outer transaction/polling and latest-choice publication remain implementation work. Timezone lock polling occurs between completed transactions, never inside a transferred callback.                                                                                                                                      |
| Morning Brief native owner — `morning-brief-native-schedule.service.ts`                 | **Unfinished.** Existing epoch/fence handles present rows; absence still coordinates first materialization with legacy `ordinary` classification.                                                                                                                                       | Prepare all classification/materialization writers on existing business identities before removing the absent-owner key. A staff-only native control does not make shared legacy schedule writers non-GA.                                                                                                                                                                                                                                                                                                                                                   |
| Stripe customer — `billing-customer.service.ts`                                         | Provider preparation outside transactions, stable idempotency key, command-local conditional binding and metadata/entitlement SQL; ambiguous provider/commit recovery reads the committed binding.                                                                                      | Outgoing creation holds the original key, reads the binding, then creates and unconditionally writes. R1 publication takes that same key and rechecks before CAS; either winner is preserved. Only this short compatibility acquisition waits for incompatible serving/in-flight/rollback writers to retire.                                                                                                                                                                                                                                                |
| Organization purchase — `billing-purchase-lock.service.ts`                              | Stale Team previews reject a competing unbound paid Pro subscription; old purchase replay also checks for a later competing subscription. Full common purchase admission remains **unfinished**.                                                                                        | Purchase confirmation, plan/allocation changes and shared schedules must share real business admission; separate provider keys do not fence a stale absolute quantity.                                                                                                                                                                                                                                                                                                                                                                                      |
| Subscription sync — `webhooks-stripe.service.ts`                                        | Every concurrency projection writer advances existing `updated_at` at database precision; provider-result publication uses an exact timestamp and transient existing xmin snapshot. Missing rows use PK arbitration; known removed subscriptions keep their actual canceled projection. | Outgoing unconditional projection writers require the key. The two invoice/update publication commands now own their SQL and perform Stripe GET outside transactions. Other billing helper chains remain unfinished. An outgoing same-quantity stale event can still overwrite a canceled projection without retrieving Stripe; the retained lock does not solve that old-writer limitation. Preserve this boundary in rollout evaluation.                                                                                                                  |
| Allocation — `usage-pack-allocation-change.service.ts`                                  | **Unfinished** shared quantity protocol; local conditional state updates retained.                                                                                                                                                                                                      | Coordinate allocation, plan, invitation, migration and the existing concurrency schedule writer before moving/removing remote serialization. A per-operation idempotency key cannot prevent a later stale absolute overwrite.                                                                                                                                                                                                                                                                                                                               |
| Plan change — `usage-pack-plan-change.service.ts`                                       | Same shared projection boundary as allocation.                                                                                                                                                                                                                                          | Same shared-writer prerequisite. Transaction forwarding and Stripe I/O are separate unfinished obligations.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Invitation purchase — `usage-pack-invitation-purchase.service.ts` purchase key          | Atomic purchase claims, exact refund predicates, and conditional state transitions. Public API tests distinguish the accepted-invite reward from duplicate credit grants.                                                                                                               | Outgoing by-ID purchase/refund writers require compatibility. Shared subscription projection still needs completion before full removal.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Invitation email — same file, email key                                                 | **Removed.** Existing active-email unique index arbitrates preview/supersession. Paid collisions retain captured-money refund handling.                                                                                                                                                 | Constraint and conditional state handling operate with supported outgoing writers; no new coordination row.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Usage display — `chat-usage-event.service.ts`                                           | Deterministic initial display-event identity and fresh-snapshot conflict recovery.                                                                                                                                                                                                      | Outgoing random event IDs and archive replacement behavior require the key. Archive reads now finish before direct-SQL publication, which validates the captured archive pointer. The separate archive read-service root-Db interface remains unfinished.                                                                                                                                                                                                                                                                                                   |
| Credits/allowance — `usage-allowance.service.ts`                                        | Standalone and Social settlement own all financial SQL; the Social receipt commits with ledger, allowance, grants and wallet. Managed/billable/Social availability refresh prepares Stripe outside a local entitlement command and publishes against its observed row.                  | Outgoing SELECT-pending / unconditional-by-ID processed updates can otherwise double-charge. Retain the key until every supported settlement/refresh writer is prepared. Standalone/Social financial transaction APIs were removed. Run/model-selection/PI/firewall availability chains and the broader Clerk cleanup transaction ownership remain unfinished; see the usage boundary inventory.                                                                                                                                                            |
| Compaction shared — `usage-event-compaction-lock.service.ts`                            | Compaction and settlement take Run parents before raw ledger, then hourly aggregates. Clerk lifecycle now takes Social jobs, Agent/Session/Run parents, entitlement, raw and hourly rows in the common order.                                                                           | Outgoing deleters/compactors use the old order. The common Clerk/settlement ordering is implemented. Core Clerk lifecycle deletion now owns direct SQL, including conversation/blob accounting. Surrounding run cancellation, Storage and connector-cleanup helpers remain implementation work, in addition to the outgoing-writer gate.                                                                                                                                                                                                                    |
| Compaction exclusive — same file                                                        | Compaction owns exact rows, uses SKIP LOCKED, and publishes aggregates from the rows actually acquired in one command-local transaction. Pure raw-result decoding no longer needs the transaction argument.                                                                             | Same old-writer ordering gate. A lexical SQL reduction alone does not prove every raw/hourly writer migrated.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SSH owner — `ssh-credential.service.ts`                                                 | Credential and host create/update/delete/reset commits are business-argument commands with direct local SQL; KMS precedes commit and invalidation follows. Rotation, attachment and rebinding own the existing member row before access config, host and credential writes.             | Outgoing rotation/attachment writers do not share that member-row protocol, so retain the owner key until serving/in-flight/rollback compatibility is established. Cloudflare mutations now also own finite command SQL, with KMS before commit and invalidation afterward. Read adapters remain in the separate full-API interface sweep. No permanent KEEP exception.                                                                                                                                                                                     |
| VNC scope shared/exclusive and owner — `vnc-owner-lifecycle.service.ts` (3 definitions) | **Removed.** Existing member-row `created_at` identity, command-local credential/host writes, and cleanup in the same member lifecycle.                                                                                                                                                 | Create/admission/cleanup reject a member identity removed during external preflight. Full API types and focused lint passed on the source revision; combined-head pipeline remains required. Shared initial-chat transaction interfaces remain unfinished. No new field or non-GA compatibility fallback.                                                                                                                                                                                                                                                   |

## Fixtures, operator and final schema

- The catalog fixture session lock and release hook are removed. Vitest runs the
  three suites that mutate its real singleton in one sequential project after
  ordinary API suites. The existing `--project=api` filter includes both child
  projects. File discovery retains all 398 distinct API test files, with three
  catalog files and 395 ordinary files; no local test execution was used.
- The billing-attribution operator retains the compaction compatibility key but
  now takes live Run parents before source rows and rolls back on contention
  without advancing its checkpoint.
- Migration `1288_retire_provisional_billing_purge` drops the unused current
  `purge_quiescent_provisional_billing_attribution` function. Historical
  migrations stay unchanged. The schema snapshot adds no table columns.
- The unshipped Forms detachment and cursor-trigger migrations are withdrawn.
  The existing non-null cascading cursor/watch relationship is unchanged; repair
  may start from newest and may miss failure-window triggers. Normal dispatch,
  basic deduplication, stop and authority checks remain required.
- Migration `1289_retire_cloudflare_scope_change_trigger` removes the redundant
  scope-change trigger and function. Every historical conversion writer already
  owns the config and detaches incompatible hosts. The SSH binding trigger stays
  for foundation-era readers without `FOR SHARE`; its separate deployment gate
  is recorded in the trigger inventory. No schema column changes.
- Attribution and allowance reader fallbacks remain. A full live data-convergence
  census has not established their removal conditions; tool age and CI references
  are not convergence evidence.

## Correction follow-up and acceptance gaps

The zero-trigger terminal constraint from `4fa8844` applies to all application
triggers, including nine that predate this PR. The
[trigger retirement inventory](./advisory-lock-release-1-trigger-boundaries.md)
records the historical eleven-definition proposal. The two unshipped Forms
triggers are withdrawn, and migration 1289 retires the redundant Cloudflare
scope-change guard. Eight definitions remain: seven billing attribution and one
SSH binding. Their explicit writer replacements remain an
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
- The custom prefix namespace owner now initializes metadata and its default
  entitlement together in `ensureCustomConnectorOrgMetadata$`, using direct SQL
  and preserving existing paid entitlements. This repairs the combined API
  regression that returned 500 when creating a chat after a custom connector.
- `c332058`: rejected Model Policy updates now roll back default-row preparation
  before returning their original conflict/validation response. Public API
  revision/initialization coverage remains; later continuation removes the
  internal uninitialized-state snapshot assertion and its fixture.
- `ec10bad`: a losing credential refresh returns connection-changed. It cannot
  reuse a replacement authorization merely because the account/method/storage
  identity stayed the same; the existing API rejection assertion is preserved.
- `7b2e6d3`: usage display writers acquire the existing Run parent before
  validating hot/archive state, preventing a second initial append after the
  first writer is archived. This is part of the R1/R2 common protocol.
- `4cd0a46`: the new concurrent VNC rotation test uses valid eight-character
  protocol passwords. Its exact one-success/one-conflict and host-revision
  assertions are preserved.
- Forms no longer promises failure-window replay. The former cursor detachment,
  progress-preserving triggers, retained-seed retry and synthetic cron catch-up
  are removed under the latest accepted behavior. API coverage still protects
  explicit disable/re-enable, current source ownership and recovery that resumes
  normal notifications. This is not a waiver for money or credentials.

| Remaining R1 requirement                                                        | Responsible scope                                                                                                  | Evidence needed to close it                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A common Stripe quantity/schedule protocol and organization purchase admission  | Billing                                                                                                            | Cover allocation, plan change, migration, invitation, concurrency changes/cancel/restore; reject the delayed A=2 after B=3 remote overwrite and double-payable purchase cases using existing business state. Per-operation idempotency and post-write CAS are insufficient. |
| One-time credential rotation, revocation, callback and runtime writer agreement | Credentials and bootstrap model-provider chain                                                                     | Prepare every supported writer, keep stale credentials rejected, and prevent a late remote rotation/revoke from invalidating the authoritative credential. Local winner readback is only one part.                                                                          |
| Actual no-handle command ownership across the remaining graph                   | Forms queue/thread, DCR runtime/store, Custom account, Storage catalog/workflow, Usage, Billing, credential chains | Trace callers and direct SQL, remove root-Db and transaction forwarding, and move provider/archive/KMS I/O outside commits. Existing local improvements do not waive other callers.                                                                                         |
| Latest-choice Morning Brief preference and native schedule materialization      | Morning Brief                                                                                                      | Cover explicit choices, defaults, generic workflow toggles and existing native classification/absence before removing coordination.                                                                                                                                         |
| Attribution/allowance fallback convergence                                      | Usage maintenance                                                                                                  | Verify the actual persisted data convergence condition before deleting readers; age and CI references are not evidence.                                                                                                                                                     |

Gmail local stop/remote expiry and Calendar gap/best-effort cleanup now have
explicit product approval, recorded in the terminal document. Gmail remote-stop
code is removed; the remaining caller ownership work is implementation. None of
these gaps is evidence for a third release or merely waiting for R2 deployment.

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
`305699e` contains 427 construction sites: 303 directly transferred, 44
ordinary-helper-owned, and 80 command-local candidates. These counts do not
cover every root-Db flow or establish semantic safety. In particular, 422 is
the historical baseline, not a current complete propagation inventory.

[Usage and Storage boundaries](./advisory-lock-release-1-usage-boundaries.md) and
[billing boundaries](./advisory-lock-release-1-billing.md), and
[credential/watch boundaries](./advisory-lock-release-1-credentials.md), and
[Model Policy boundaries](./advisory-lock-release-1-model-policy.md) record the remaining
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
create/thread and generic account/official command boundaries remain unfinished;
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
grant/lot prefix can still be large; expired-lot clamping remains one atomic
operation and is an unfinished bound. Splitting that clamp changes results when
a purchase interleaves. The event limit alone does not certify a short transaction.

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
SQL in their commands. SSH retains its outgoing owner key because the old host
attachment writer does not own the existing member row before binding a
credential. R1 attachment, rebinding and credential rotation share that row
ordering; R2 may remove that key only after incompatible serving writers and
in-flight requests are gone and the rollback target uses the same protocol.
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
response-read adapters remain separate implementation work.

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
