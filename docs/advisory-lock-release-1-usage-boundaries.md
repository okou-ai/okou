# Release 1 usage and Storage transaction boundaries

This note records the implemented boundary changes and the remaining implementation work. It does not certify Release 1 readiness. The remaining transaction propagation below is unfinished work, not an outgoing-writer compatibility exception.

## Usage publication

`emitRunUsageEventAttempt$` owns its transaction and executes the context read, amount breakdown, hot-event lookup, archive-pointer validation and canonical append directly. Pure query/SQL builders receive only values. Canonical sequence allocation and event insertion remain one statement; initial events use the deterministic run identity and replacements retain the unique revoke edge and exact context pointer.

Archive downloads finish before this transaction starts. The transaction checks the captured archive pointer when no hot event exists. A changed pointer or a hot event moved by retention causes a fresh attempt; stale absence cannot create a second initial event alongside an outgoing writer's random identity. Realtime publication remains after commit.

The retained `chat_usage_message` key still coordinates outgoing random-ID/no-retry writers. Remove it only when pre-Release-1 APIs are no longer serving, their in-flight requests have drained, and the rollback target has the deterministic append protocol. The archive reader still receives a normal read-only database capability outside this transaction; the wider read-service interface cleanup is not represented as complete.

## Financial settlement

`settleOrgUsage$` receives an organization identifier and operation identities or Social claim values. It prepares ordinary snapshots and dispatches `commitUsageBatch$`, whose business-only arguments contain those snapshots. The commit command obtains `writeDb$` itself and executes the complete financial write in one local transaction: pending-event claim, pricing-snapshot validation, allowance allocation, member grants, expiring credit lots, shared balance arithmetic, default entitlement repair, and an optional Social receipt. Every statement is executed directly by the transaction owner; the pricing and SQL planners receive only ordinary values. No database or transaction handle is forwarded.

The pending-to-processed conditional update returns the events owned by this attempt before final allowance and credit deductions are calculated from their prepared gross prices. A failure rolls back that claim together with every amount mutation. Existing grant rows are consumed in purchased-before-bonus and expiry order; organization lots retain first-expiring-first-out behavior. Arithmetic preserves an existing negative balance when no credit lot expires. New allowance windows start with zero consumption and receive the allocated delta once. The API regression that observed 140 consumed units for a 70-unit event was caused by aliasing the planned initial window with its mutable consumption state; independent initial values and a zero-valued insert remove that double charge without weakening the assertion.

Managed usage insertion has its own local, idempotent transaction. It commits before invoking organization settlement and reading the receipt. Social settlement instead passes its existing claim identity as values to `settleOrgUsage$`, so its job ownership, managed usage, financial mutations, reservation release and receipt commit together. Provider work and Stripe preparation precede that transaction. Auto-recharge, alerts and usage publication follow commit. `processOrgUsageEventsInTransaction`, `processOrgUsageEventsInLockedTransaction` and `recordManagedUsageInCompactionLockedTransaction` have been removed.

Settlement retains live Run parents before locking the existing wallet and allowance entitlement rows and claiming pending events, and uses the existing allocation identity and grant/lot rows. No new persisted coordination identity was introduced. Empty standalone settlement returns before the pricing and financial mutation batch. Telemetry reports the measured command batch and actual lock waits rather than zero-valued durations for removed helper phases.

## Bounded event preparation correction

Settlement now selects at most 100 pending event snapshots per commit before opening the financial transaction. Managed, OpenRouter and generated-image writers pass their own idempotency keys, so an older organization backlog cannot displace the current operation's receipt. Organization catch-up selects its next page between committed batches. Social uses only its existing job usage identity, keeping the receipt and reservation release in the same commit.

The commit owns only the selected Run parents in UUID order, then the wallet and allowance entitlement. It claims the selected still-pending IDs with their observed `xmin`; a partial claim rolls back the whole batch. The outer business command refreshes snapshots on a typed conflict, with a bounded retry count, so an already-processed duplicate can reuse its existing receipt. Relevant pricing identities and row versions are captured outside the transaction and revalidated under row ownership before using prepared prices. Standalone pricing calculations run before the transaction, and confirmed pricing diagnostics run only after commit. Social pricing and the managed-event plan are also prepared outside the transaction from all three immutable pricing fields. The receipt command locks the job and requires its exact observed `xmin` before applying that plan; concurrent job changes trigger whole-transaction rollback and preparation retry. The same retry owner handles both ordinary and Social receipts. Each attempt also prepares fresh allowance/Stripe evidence outside the transaction. An entitlement snapshot mismatch uses the same typed conflict, so a retry re-reads and re-prices the operation instead of reusing a stale provider snapshot. Refresh discovery is narrowed to this batch's positive-priced idempotency keys; empty/zero-priced batches, already processed receipts, and free Social jobs do not initiate a refresh. Social preparation can observe an existing processed receipt, while its owning commit still verifies the authoritative receipt before releasing the reservation.

Allowance reads now select only the latest covering short and weekly window for each candidate anchor, with the same start-time/UUID tie-break semantics as the existing allocator. At most two window identities per selected event are owned; a batch spanning distant dates no longer loads every intervening historical window. New windows are at most twice the selected candidate count, allocations are at most the candidate count, and the owner executes at most four allowance SQL mutations. New-window and final allowance allocation arithmetic remain in the owning financial transaction as required current-state work.

Member-grant preparation now pages outside the transaction over the existing spendable index. For each charged member it selects only enough positive credits to cover the batch gross amount, in purchased-before-bonus and expiry/UUID order. Current allowance may reduce that prefix further; a fully allowance-funded member locks no grants. The commit locks only those identities, requires their observed `xmin`, rejects newly observed earlier eligible grants or a newly available grant after an exhausted prefix, and performs arithmetic deductions. A stale prefix rolls the entire event/allowance/credit batch back before a bounded preparation retry. Exact PostgreSQL timestamp text retains sub-millisecond ordering at page boundaries. The selected row count is at most the positive integer credit demand, rather than the member's lifetime grant count. This is a demand-derived bound, not a promise of a small fixed row count: highly fragmented grants can still make a large charge expensive.

Active organization lots now use the same demand-derived preparation: page outside the transaction in expiration/UUID order, then reduce the selected prefix to the current shared debit after allowance and member grants. Commit requires the selected row versions, rejects a prefix that expired during preparation, and checks for newly available earlier live lots. Every lot mutation is an atomic decrement. A zero shared debit reads or expires no organization lots, preserving the existing grant-funded behavior. A shared debit now checks for expired remainder under wallet ownership, rolls back the entire attempted receipt/allowance/grant write when needed, completes expiration through its own command, and prepares the batch again. Its financial transaction owns only the prepared live prefix. A zero shared debit skips this admission/recovery path. Atom-grant expiration in billing reconciliation now has a business-only command with direct SQL and the same wallet-before-expiration-lots ownership order. Its legacy downgrade projection still forwards a database/transaction and remains implementation work. The pre-Release-1 cron owns lots before the wallet and has no advisory guard, so the retained credit key cannot prevent its mixed-version deadlock; database deadlock detection rolls that attempt back and a subsequent reconciliation pass must complete it. These R1 settlement and Atom-expiration writers now share the order required for R2.

**This does not yet make all financial work bounded.** The dedicated R1 expiration command still owns all expired applicable rows. The bounded current allowance reads and final allocation remain inside the transaction to preserve atomicity; their placement is not an unfinished boundary. Splitting expired lots into independent committed batches is unsafe with the current balance clamp. For example, a wallet of 5 with two expired lots of 50 and an overlapping purchase of 150 can become 100 if one expiration commits before the purchase and one after it. Expiring all lots before the purchase yields 150; purchasing first and expiring atomically yields 55. The split result matches neither permitted serial ordering. No such batching was added. A bounded replacement therefore needs a proven common protocol for every shared-credit addition, expiration, refund and consumption writer, preserving existing negative-balance and first-expiring-first-out behavior. Merely truncating selected lots, consolidating ledger rows without auditing their references, or awaiting outgoing API drain is insufficient. This is unfinished Release 1 implementation, not a Release 2 deferral. A possible two-release protocol is to prepare every future balance-adder, refund and consumer in Release 1 to refuse or finish expired remainder under wallet ownership before proceeding; Release 1 must retain atomic full expiration while pre-Release-1 writers coexist. Only after those current-writer guards are implemented and old writers drain could Release 2 safely enable bounded expiration commits. The current continuation implements the wallet monetary prerequisites below; plan and fulfillment command ownership is still unfinished.

The public API regression creates 101 pending connector events through the authenticated Runner usage webhook, obtains the current Maps receipt without draining that backlog, then catches up and repeats settlement. It asserts 32 credits for the current operation, 133 after catch-up, and an unchanged final usage response on retry. Existing purchased-before-bonus, member isolation, delayed-expiry, exact lot/wallet and duplicate receipt assertions remain. No lock waiter, trigger or artificial transaction gate is used. API behavior and types require verification on the final integrated PR HEAD.

## Allowance preparation and admission

Stripe subscription retrieval receives an immutable entitlement snapshot before settlement, built-in run activation, and allowance availability transactions. Its response is transient data. There is no Stripe retrieval fallback in the locked entitlement loader. An expired entitlement accepts prepared work only when its complete existing-row snapshot still matches. A changed entitlement or an expiry boundary crossed without prepared evidence aborts the financial operation, preventing stale provider results from restoring a revoked entitlement.

Empty settlement and events already covered by issued allowance windows skip unnecessary refresh preparation. Free or already settled Social jobs also skip it. Historical allowance anchors retain the existing live-run fallback pending a complete production convergence census; the billing-attribution reader fallback has the same evidence requirement.

`resolveUsageAllowanceAvailability$` now owns the managed and billable admission refresh. It reads the current snapshot, completes Stripe retrieval outside a transaction, then owns the entitlement and executes any refresh and availability SQL locally. Its callers pass only the organization identifier and signal.

| Caller                                | Current ownership and remaining propagation                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkBillableOperationCredits$`      | Uses the new availability command outside a transaction. Its balance/grant read helpers still receive an ordinary database.                                                                                                                                                                                                          |
| `checkManagedCredits$`                | Uses the new availability command outside a transaction; `checkManagedCreditsInDb` was removed. Its balance/pricing/read helper graph still receives an ordinary database.                                                                                                                                                           |
| `createSocialDataJob$`                | Awaits its first admission transaction, invokes the availability command, then starts a fresh admission transaction. The transaction-aware snapshot-only check performs no Stripe request; the wider Social admission helper graph remains.                                                                                          |
| `run-admission.service`               | Still calls `resolveUsageAllowanceAvailability(params.db, ...)`. `prepareAgentRun$` and `completeAgentRun$` call admission before launch; queued prompt/automation and Pi Stage 1/Phase 2 commands likewise supply their ordinary command database. The resolver's internal transaction still forwards handles to allowance helpers. |
| `agent-webhook-firewall-auth.service` | Still calls `resolveUsageAllowanceAvailabilityForRun(params.db, ...)` before the final firewall admission transaction. The route supplies an ordinary database. The helper and its transaction-aware window graph remain.                                                                                                            |
| `agent-run-create.service`            | `activatePreparedLaunchUsageAllowance` forwards the launch transaction through timing callbacks to `activateUsageAllowanceWindowsForRun`. Stripe evidence is prepared before launch, but activation SQL still needs to move into the launch owner without splitting Run/window atomicity.                                            |

The current production caller trace does not find an outer transaction around either remaining Stripe-capable availability resolver. This is a call-chain finding, not a type guarantee. Passing ordinary databases through helpers or context objects also violates the confirmed terminal shape and remains work.

The `credit_` compatibility key still coordinates outgoing writers that select pending events and later mark them processed unconditionally, and outgoing allowance writers without entitlement ownership. The new financial command cannot prevent those old writers from debiting a previously read event. Removing this key requires all shared allowance and billing writers to finish their common protocol, followed by evidence that pre-Release-1 serving and in-flight requests are gone and the rollback target is compatible. Unfinished admission or billing code is not covered by an old-writer drain exception.

## Compaction and cleanup

Compaction owns its local transaction and executes pure SQL builders directly. Its candidate query retains live Run parents before raw events and allocations; raw ownership precedes hourly replacement. The billing-attribution operator likewise retains parents before source rows and uses bounded conflict handling. A new migration retires the unused `purge_quiescent_provisional_billing_attribution` function from the final schema; historical migrations remain unchanged.

`deleteUsageData$` is a standalone command with business scope arguments. It deletes Social jobs, owns an organization entitlement when applicable, then deletes raw usage before hourly rows. `usageCleanupTargets` is a pure, fixed list of table/condition values. The old database-bearing `deleteOrgUsageData` and `deleteUserUsageData` helpers and their nested usage savepoints were removed. Clerk's existing atomic lifecycle transaction executes that same list directly.

The Clerk lifecycle owner now deletes the owned Social jobs first, acquires Agent/Session/Run parents, owns the organization entitlement when applicable, and then deletes raw usage before hourly rows and the entitlement cascade. Settlement now retains pending Run parents before the wallet and entitlement, matching launch activation and lifecycle deletion. Agent and threadless deletion execute the compatibility SQL directly; the database-bearing compaction lock helper was removed. `deleteClerkAgentLifecycleData$` dispatches to business-only user/organization commands. Each obtains `writeDb$` itself and executes its complete deletion transaction directly: usage rows, the exact locked Run set, conversations, artifact catalog projections, stable-context generations/publications/heads, owned Agent cascades, Morning Brief outbox revocation and last-step blob reference arithmetic. Its reusable builders receive ordinary scope/identity/reference values only. Blob locks retain global ordering and NOWAIT, and missing/insufficient references roll back the entire deletion. The post-membership stable-context sweep has its own business-only command. The two outer Clerk deletion orchestrators return ordinary released-slot results; their other legacy Discord/Slack/connector/Storage and cancellation helpers still receive database handles. Agent deletion and threadless Run cleanup also retain transaction-aware lifecycle graphs. These remaining commits must not be split to hide handle propagation.

The shared/exclusive `usage_event_compaction` key therefore has two separate conditions: finish the remaining current-writer transaction ownership graph above and verify the shared ordering in the PR pipeline, then establish serving/in-flight/rollback evidence for outgoing raw-before-parent and hourly-before-raw writers. The key in the operator and all runtime callers must retire together. Merely draining pre-Release-1 APIs would not retire the remaining database/transaction-bearing interfaces.

## Storage publication

The standalone server-side volume preparation, archive-size reconciliation and publication commands own their database access. Archive construction, R2 upload and verification finish before publication. The standalone publication transaction contains only direct Storage/version/index/publication SQL; it does not pass a database or transaction to another function. Pure SQL/value builders preserve immutable version identity, existing Pi publication fences and index repair invalidation. This does not cover callers of the legacy `commitPreparedVolumeServerSide({db, ...})` helper.

The transaction-bearing preparation APIs `prepareVolumeServerSideWithDb$` and `writeAgentInstructionsStorageInTransaction$` have been removed. Agent instructions PUT prepares objects first and rechecks current Agent ownership, visibility and name during publication, but its publication still forwards `tx` through the stable-context fence, `commitPreparedVolumeServerSide`, refresh and completion helpers. It is unfinished command-ownership work. Bootstrap uses the standalone upload command. Standalone instructions deletion owns its local SQL transaction and deletes R2 objects after commit. A public concurrent PUT/GET test checks that the visible instructions resolve to one complete uploaded archive; that behavior check does not establish transaction ownership.

## Remaining implementation inventory

| Path                            | Concrete remaining graph                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Allowance admission and launch  | `run-admission` -> `resolveUsageAllowanceAvailability`; firewall admission -> `resolveUsageAllowanceAvailabilityForRun`; `activatePreparedLaunchUsageAllowance` -> `activateUsageAllowanceWindowsForRun` -> `lockOrgCredits` and window helpers. The launch transaction escapes through timing callbacks.                                                                                                                                              |
| Credit admission reads          | `checkManagedCreditBalance` and `checkManagedCreditsSnapshotInDb` still receive databases; Social job admission propagates its transaction into the snapshot checker and other admission helpers.                                                                                                                                                                                                                                                      |
| Clerk lifecycle deletion        | The core `deleteClerkAgentLifecycleData$` user/org and post-membership sweeps now own finite SQL with no escaping handles. Surrounding `cancelOrgRuns`/`cancelUserRuns`, Discord/Slack cleanup, connector cleanup and Storage/Pi candidate deletion still receive `db`/`tx` from the outer deletion orchestrators. Their ownership remains unfinished, not an outgoing-only exception.                                                                 |
| Agent/threadless deletion       | `deleteAgentInTransaction` and `deleteIfStillEligible` retain transaction-aware conversation, artifact, Storage, and lifecycle helper graphs. Their compatibility admission now executes direct SQL, but the remaining lifecycle helpers still receive the transaction.                                                                                                                                                                                |
| Other Storage publication       | `commitPreparedCustomConnectorSkillStorage` and `official-workflow-catalog-sync` -> `commitPreparedVolumeServerSide({db,...})` -> version and Pi index helpers. Ordinary upload uses `commitVerifiedStorageVersion` -> `commitStorageVersionInTransaction` -> `commitActiveStorageVersion`, with mounted-Run, immutable-checkpoint, HEAD, lineage and Pi projection helpers receiving the transaction. These guards must move together into the owner. |
| Other lifecycle Storage cleanup | Multi-Agent and Clerk deletion still use transaction-aware Storage/instructions and Pi memory candidate cleanup helpers.                                                                                                                                                                                                                                                                                                                               |
| Bootstrap-adjacent rewards      | Bootstrap's onboarding grant command owns its own SQL, but `get-started-rewards.persistGetStartedGrant` still calls the legacy `grantOrgCredits(tx, ...)` helper for the existing atomic reward receipt. It cannot be replaced with a separate committed grant.                                                                                                                                                                                        |

No persistent fields, generic lock service, lease, saga or new coordination table were added. The internal Model policy row-lock/blocked-transaction and manufactured-unrepaired-state tests were removed; API initialization races, stale snapshot rejection, model/preference preservation and OAuth configuration preservation remain. The provider-routing test now constructs policy state through the public API. Artificial settlement rollback injection was removed while concurrent retry, exact grants/lots/balances, allowance consumption and public receipt assertions remain.

No full local Vitest suite or local development server was run. Targeted static checks and the combined PR pipeline are the verification boundary. Release 1 is not ready while the concrete current-writer protocol and ownership gaps above remain, even if the current CI run passes.

Clerk connector-revocation preparation now obtains its own database for account
selection and calls the accepted-catalog command with no database argument.
The catalog-unavailable result still permits local teardown with a null snapshot.
Organization/user external-cleanup dispatch receives only business identities
and the final signal. The actual connector deletion, broader run cancellation
and Storage helper graphs below these entry points remain implementation work.

## Shared-wallet expiration admission: implementation in progress

The first writer preparation uses the wallet row as the common owner. A writer
checks for a positive expired lot before publishing its grant receipt or changing
its balance. When the predicate fails, it leaves the transaction, invokes
`expireOrgCredits$`, and retries from a new current timestamp. Recovery is bounded
to four attempts; continuing contention fails without publishing a partial grant.
This is implemented for onboarding, test-organization floors, automatic recharge,
invoice and checkout credit purchases, one-time campaign purchases, and Atom
credit-only grants. Unique invoice receipts and their wallet increments still
commit together. Commands accept business inputs and obtain `writeDb$` themselves.

The expiration command owns the wallet first and then all expired lots in expiry
and ID order. It clears the lots and clamps the wallet in one SQL statement. This
whole-expiration transaction is intentionally retained in Release 1: pre-R1
adders have no expired-remainder predicate and could otherwise add credits between
two clamps. Release 2 may bound this command only once the complete R1 writer
graph is prepared and incompatible serving/in-flight/rollback writers are gone.

This monetary preparation does **not** complete the ownership graph: subscription/Atom-plan grants and first-paid fulfillment still forward transaction handles through metadata, member-grant and pending-snapshot helpers. Those boundaries remain implementation work, not a drain gate.

Slack is the only organization-scoped get-started reward. Its installation writer
now owns the installation, claim, organization lot and wallet increment in one
command transaction. Wallet ownership precedes the claim; award identity and the
organization limit remain protected by their existing unique indexes. A conflicting
award rolls back the whole installation attempt and retries from authoritative
claims. The old database-bearing `grantOrgCredits` interface is removed. Two additional
Slack callers (first workspace binding and connector installation) still use the
existing claim helper inside their atomic installation transaction; they now own
the wallet before installation/claim rows and finish expired remainder through
the common SQL before publishing the reward. Their command ownership is unfinished. Other get-started rewards remain
member-scoped and retain their separate unfinished transaction ownership graph.

Shared Usage settlement now participates in the same expiration predicate and
bounded outside-transaction recovery. Its event claim, allowance and member debit
are rolled back together if shared expiration is required, including Social's
managed receipt/reservation publication. A fresh attempt re-prepares event, price,
allowance, grant and live-lot evidence. Already processed receipts and operations
fully covered by allowance/member grants do not cause expiration.

Plan renewal and Atom-plan credits now execute the common atomic expiration SQL
under the wallet row already owned by invoice publication. A single data-modifying
CTE inserts the unique invoice lot and increments the wallet only for that receipt.
The old `grantOrgCredits`, `createExpiresRecord`, `expireCredits` and trial-expiry
transaction helpers are removed. Trial extension finishes expired remainder before
changing positive lots; already expired trial credits cannot be revived. The API
trial-invoice regression extends the trial after its old expiry and replays that
event, asserting zero credits and no resurrected grant.

First-paid debt clearing owns the wallet before evaluating current paid-grant and
fulfillment evidence. Only eligible negative debt triggers whole expiration and
clearing; a member grant that does not clear debt does not expire shared credits.
Refunds affect member-owned grants/refund records, not the shared organization
wallet. Trial shortening already owns the wallet through its metadata update and
only decreases expiry; subsequent monetary writers observe any resulting remainder.
The preview/test state seed routes are test-only writers, not supported production
balance writers. They remain a separate fixture command-ownership cleanup.

Plan/Atom replacement cancellations still execute within the existing transaction
chain. Moving them after commit without a complete replay identity loses some
cancellations: the currently stored subscription ID has been overwritten, and the
existing Stripe customer-list fallback excludes some previously selected IDs (for
example past-due lower-tier subscriptions). Broadening cancellation to all customer
subscriptions would risk unrelated current plans. This remains implementation work,
not a compatibility exception. The prepared monetary predicates above do not
resolve the plan entitlement, pending-snapshot and member-grant helper propagation.
R1 is not certified ready by this note.
