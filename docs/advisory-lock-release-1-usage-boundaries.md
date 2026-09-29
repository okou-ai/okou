# Release 1 usage and Storage transaction boundaries

This note records the implemented boundary changes and the remaining implementation work. It does not certify Release 1 readiness. The remaining transaction propagation below is unfinished work, not an outgoing-writer compatibility exception.

## Usage publication

`emitRunUsageEventAttempt$` owns its transaction and executes the context read, amount breakdown, hot-event lookup, archive-pointer validation and canonical append directly. Pure query/SQL builders receive only values. Canonical sequence allocation and event insertion remain one statement; initial events use the deterministic run identity and replacements retain the unique revoke edge and exact context pointer.

Archive downloads finish before this transaction starts. The transaction checks the captured archive pointer when no hot event exists. A changed pointer or a hot event moved by retention causes a fresh attempt; stale absence cannot create a second initial event alongside an outgoing writer's random identity. Realtime publication remains after commit.

The retained `chat_usage_message` key still coordinates outgoing random-ID/no-retry writers. Remove it only when pre-Release-1 APIs are no longer serving, their in-flight requests have drained, and the rollback target has the deterministic append protocol. Usage archive preparation now owns its database queries through business-input commands. The immutable R2 reader receives only the published object metadata and bucket; no database is forwarded. The command validates the pointer across the object read and bounded latest-usage lookup. Other shared-thread/history read adapters still forward database capabilities and remain part of the wider interface cleanup.

## Financial reporting ownership

`usageRecord$` executes its paginated ledger rows, breakdown and totals directly;
its reusable relations are pure SQL builders with business inputs. The team
member report owns both aggregate reads in its local read-only snapshot, without
passing a transaction to a query helper. Explicit result ordering, exact integer
decoding, raw/hourly summation and retained attribution fallbacks are unchanged.
Clerk email resolution and cache updates use an independent business-input
command outside the reporting transaction. This closes these reporting reader
boundaries; it does not yet replace the chat's persisted usage-display protocol.
Existing user API totals, pagination, member isolation, late usage and compaction
cases remain the behavioral verification for the integrated PR pipeline.

## Financial settlement

`settleOrgUsage$` receives an organization identifier and operation identities or Social claim values. It prepares ordinary snapshots and dispatches `commitUsageBatch$`, whose business-only arguments contain those snapshots. The commit command obtains `writeDb$` itself and executes the complete financial write in one local transaction: pending-event claim, pricing-snapshot validation, allowance allocation, member grants, expiring credit lots, shared balance arithmetic, default entitlement repair, and an optional Social receipt. Every statement is executed directly by the transaction owner; the pricing and SQL planners receive only ordinary values. No database or transaction handle is forwarded.

The pending-to-processed conditional update returns the events owned by this attempt before final allowance and credit deductions are calculated from their prepared gross prices. A failure rolls back that claim together with every amount mutation. Existing grant rows are consumed in purchased-before-bonus and expiry order; organization lots retain first-expiring-first-out behavior. Arithmetic preserves an existing negative balance when no credit lot expires. New allowance windows start with zero consumption and receive the allocated delta once. The API regression that observed 140 consumed units for a 70-unit event was caused by aliasing the planned initial window with its mutable consumption state; independent initial values and a zero-valued insert remove that double charge without weakening the assertion.

Managed usage insertion has its own local, idempotent transaction. It commits before invoking organization settlement and reading the receipt. Social settlement instead passes its existing claim identity as values to `settleOrgUsage$`, so its job ownership, managed usage, financial mutations, reservation release and receipt commit together. Provider work and Stripe preparation precede that transaction. Auto-recharge, alerts and usage publication follow commit. `processOrgUsageEventsInTransaction`, `processOrgUsageEventsInLockedTransaction` and `recordManagedUsageInCompactionLockedTransaction` have been removed.

Settlement retains live Run parents before locking the existing wallet and allowance entitlement rows and claiming pending events, and uses the existing allocation identity and grant/lot rows. No new persisted coordination identity was introduced. Empty standalone settlement returns before the pricing and financial mutation batch. Telemetry reports the measured command batch and actual lock waits rather than zero-valued durations for removed helper phases.

## Bounded event preparation correction

Settlement now selects at most 100 pending event snapshots per commit before opening the financial transaction. Managed, OpenRouter and generated-image writers pass their own idempotency keys, so an older organization backlog cannot displace the current operation's receipt. Organization catch-up selects its next page between committed batches. Social uses only its existing job usage identity, keeping the receipt and reservation release in the same commit.

The commit owns only the selected Run parents in UUID order, then the wallet and allowance entitlement. It claims the selected still-pending IDs with their observed `xmin`; a partial claim rolls back the whole batch. The outer business command refreshes snapshots on a typed conflict, with a bounded retry count, so an already-processed duplicate can reuse its existing receipt. Relevant pricing identities and row versions are captured outside the transaction and revalidated under row ownership before using prepared prices. Standalone pricing calculations run before the transaction, and confirmed pricing diagnostics run only after commit. Social pricing and the managed-event plan are also prepared outside the transaction from all three immutable pricing fields. The receipt command locks the job and requires its exact observed `xmin` before applying that plan; concurrent job changes trigger whole-transaction rollback and preparation retry. The same retry owner handles both ordinary and Social receipts. Each attempt also prepares fresh allowance/Stripe evidence outside the transaction. An entitlement snapshot mismatch uses the same typed conflict, so a retry re-reads and re-prices the operation instead of reusing a stale provider snapshot. Refresh discovery is narrowed to this batch's positive-priced idempotency keys; empty/zero-priced batches, already processed receipts, and free Social jobs do not initiate a refresh. Social preparation can observe an existing processed receipt, while its owning commit still verifies the authoritative receipt before releasing the reservation.

Allowance reads now select only the latest covering short and weekly window for each candidate anchor, with the same start-time/UUID tie-break semantics as the existing allocator. At most two window identities per selected event are owned; a batch spanning distant dates no longer loads every intervening historical window. New windows are at most twice the selected candidate count, allocations are at most the candidate count, and the owner executes at most four allowance SQL mutations. New-window and final allowance allocation arithmetic remain in the owning financial transaction as required current-state work.

Member-grant preparation now pages outside the transaction over the existing spendable index. For each charged member it selects only enough positive credits to cover the batch gross amount, in purchased-before-bonus and expiry/UUID order. Current allowance may reduce that prefix further; a fully allowance-funded member locks no grants. The commit locks only those identities, requires their observed `xmin`, rejects newly observed earlier eligible grants or a newly available grant after an exhausted prefix, and performs arithmetic deductions. A stale prefix rolls the entire event/allowance/credit batch back before a bounded preparation retry. Exact PostgreSQL timestamp text retains sub-millisecond ordering at page boundaries. The selected row count is at most the positive integer credit demand, rather than the member's lifetime grant count. This is a demand-derived bound, not a promise of a small fixed row count: highly fragmented grants can still make a large charge expensive. The unseen-prefix check is sufficient only when every concurrent creator owns the same wallet before publishing a member grant. The inspected production creator entrances now acquire that wallet before grant publication, including paid invitation activation; their exact ownership and remaining interface/provider gaps are listed below. Pre-R1 creators do not all follow this protocol and must not coexist with the eventual uncoordinated R2 settlement path.

Active organization lots now use the same demand-derived preparation: page outside the transaction in expiration/UUID order, then reduce the selected prefix to the current shared debit after allowance and member grants. Commit requires the selected row versions, rejects a prefix that expired during preparation, and checks for newly available earlier live lots. Every lot mutation is an atomic decrement. A zero shared debit reads or expires no organization lots, preserving the existing grant-funded behavior. A shared debit now checks for expired remainder under wallet ownership, rolls back the entire attempted receipt/allowance/grant write when needed, completes expiration through its own command, and prepares the batch again. Its financial transaction owns only the prepared live prefix. A zero shared debit skips this admission/recovery path. Atom-grant expiration in billing reconciliation now has a business-only command with direct SQL and the same wallet-before-expiration-lots ownership order. Its legacy downgrade projection still forwards a database/transaction and remains implementation work. The pre-Release-1 cron owns lots before the wallet and has no advisory guard, so the retained credit key cannot prevent its mixed-version deadlock; database deadlock detection rolls that attempt back and a subsequent reconciliation pass must complete it. These R1 settlement and Atom-expiration writers now share the order required for R2.

**This does not yet make all financial work bounded.** `expireOrgCreditsAt$` now prepares at most 100 expired lot identities outside its transaction and traverses subsequent batches only after the previous commit. The owning transaction acquires the wallet, checks for any currently expired row omitted from the prepared set, and clears only those IDs when the set is complete. The finite SQL rechecks each lot's current positive remainder and expiration under row ownership; its actual cleared sum drives arithmetic wallet subtraction. It never publishes an absolute balance computed outside the transaction. Preparation, omission check and mutation use one fixed cutoff; no persisted timestamp is round-tripped through JavaScript for pagination. Usage/addition recovery and Atom-expiration cron call this business-input owner without forwarding handles.

An incomplete prepared set takes the explicit R1 full-clamp compatibility branch before any partial amount mutation. This branch is still unbounded for a large cohort or a newly omitted lot, and the legacy inline billing expiry callers also remain separately unfinished. The reason for preserving the full clamp during actual pre-R1 writer coexistence is concrete: a wallet of 5 with two expired lots of 50 and an overlapping purchase of 150 can become 100 if one expiration commits before the purchase and one after it. Expiring all lots before the purchase yields 150; purchasing first and expiring atomically yields 55. The split result matches neither permitted serial ordering. Current R1 adders and consumers therefore finish or reject expired remainder under wallet ownership before any amount mutation. Their caller trace is below. The compatibility branch can be removed only after pre-R1 adders, debt clearers, extenders and consumers are no longer serving or in flight and the rollback target follows that admission rule. The finite operation and outside-transaction loop then continue unchanged across all cohorts. This exact old-writer boundary does not excuse unfinished command ownership, provider work inside billing transactions, or the remaining paid member-grant transaction boundaries; those remain R1 implementation work.

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

Compaction owns its local transaction and executes pure SQL builders directly. Its candidate query retains live Run parents before raw events and allocations. Each commit now consumes at most 500 raw events, groups only that batch and inserts new hourly fragments; it neither expands a selected hour nor reads/replaces existing hourly fragments. Canonical personal/team/chat usage readers already sum raw and hourly facts by business dimensions, so late batches preserve totals without a whole-hour transaction. Row, amount and allowance-window reconciliation still guards each commit. The API regression records usage through the Runner webhook, invokes scoped compaction, and verifies the billing API across repeated compaction and late same-hour usage; the artificial old-fragment overflow fixture is removed because compaction no longer sums that old fragment. The billing-attribution operator likewise retains parents before source rows and uses bounded conflict handling. A new migration retires the unused `purge_quiescent_provisional_billing_attribution` function from the final schema; historical migrations remain unchanged.

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
| Bootstrap-adjacent rewards      | Bootstrap onboarding and all three Slack reward writers now own their SQL commands. Each keeps the unique reward/grant receipt and arithmetic wallet change in the same transaction, with the common expired-remainder admission. Their adjacent reader and fixture ownership is inventoried separately below.                                                                                                                                         |

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

This monetary preparation does **not** complete the ownership graph: subscription/Atom-plan invoice grants and migration snapshot materialization still forward transaction handles through metadata and pending-snapshot helpers. Usage-pack plan activation and subscription.updated allowance/plan publication now own their commits as described below. The ordinary paid usage-pack fulfillment commit is now owned as described below. The remaining boundaries are implementation work, not a drain gate.

Slack is the only organization-scoped get-started reward. All three production
entry points now commit through business-only commands: direct installation,
connector installation, and first workspace binding. The installation commands
own their database and execute the claim, lot and wallet SQL directly. The binding
command also owns the connection switch and first binding; these changes and its
permanent reward receipt still commit together. Token encryption and subsequent
Slack notifications remain outside these transactions. The generic transaction-
bearing reward helper no longer accepts Slack completions.

Wallet ownership precedes installation and claim rows. Existing unique award and
organization indexes still enforce permanent eligibility. Expired remainder or a
conflicting unique award rolls back the entire attempted binding/installation,
then the business command performs bounded outside-transaction recovery and reads
current claims again. Reinstallation checks the current organization owner before
publishing credentials. Other get-started rewards remain member-scoped and retain
their separate unfinished transaction ownership graph. Slack notification/read
helpers elsewhere still forward an ordinary database; this is not a claim that
the entire Slack service graph is finished.

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

The shared-wallet API regression constructs the expiration counterexample through
real operations: a processed usage event leaves debt of 95, two 50-credit invoice
purchases yield a wallet of 5, and time advances past both lots. Concurrent delivery
of the same new 150-credit purchase must return a balance of 150 and exactly its
active grant. After one more credit is consumed, invoice replay must leave 149.
No internal row edit, advisory lock, trigger or transaction gate constructs this
state. Focused formatting and lint passed; behavior verification belongs to the
final integrated PR pipeline.

## Paid usage-pack fulfillment ownership

`commitUsagePackFulfillment$` now owns the complete paid-invoice SQL commit. Its
parameters are ordinary prepared invoice/subscription/allocation values and the
caller signal; it obtains `writeDb$` and forwards no database or transaction. The
commit directly owns the existing subscription roots, pending-snapshot guard,
allocation rows and wallet, then commits first-paid negative-balance clearing,
member purchased/bonus grants, exact refund provenance, allocation/plan projection
and the invoice receipt together. Existing processed receipts return without
re-granting or clearing debt. Stripe subscription/catalog preparation remains
outside the commit.

Grant/refund statement builders take ordinary values only. A conflict returns a
row only when the original organization, member, kind, amount, expiry and payment
source match; it retains remaining credits and refund lifecycle fields. A mismatch
rolls back the entire financial transaction. Current allocation ownership and
price identities are revalidated before publishing a prepared grant. An expired
shared remainder is finished atomically only if this is an eligible first-paid
debt-clear operation; member grants that do not clear debt still leave shared
expiration untouched.

The R1 commit retains the existing `usage_pack_billing` and `billing_purchase`
compatibility acquisitions and roots-before-guard order. Outgoing allocation and
purchase writers still use those keys, and the outgoing pending-count trigger
owns the subscription before the guard. The command checks the authoritative
starting count and assigns the exact final count, avoiding a second trigger
increment. These boundaries require the documented compatible serving, in-flight
and rollback writer evidence before R2 removal; they are not new locks or schema.
The full organization root read remains for that outgoing trigger order, so this
change does not claim the terminal transaction footprint is already reached.

The caller chain now dispatches invoice fulfillment as a command from signed
Stripe events, reconciliation, migration finalization/replay and both migration
confirmation APIs, preserving each caller's final `AbortSignal`. Migration remote
scheduling, snapshot materialization and invitation completion still use their
legacy helper ownership; converting orchestration callers does not certify those
separate write protocols. Plan/Atom cancellation replay remains implementation
work; usage-pack plan activation is now owned as described below. Focused Prettier, Oxlint and ESLint passed; combined types and
behavior checks must use the integrated PR HEAD.

The Atom member-credit-only invoice path now uses `grantAtomMemberCredits$`.
It owns the wallet, then the current plan entitlement, validates the same active
Pro/Team and Stripe-customer contract, and directly executes the unique member
grant statement. A duplicate cannot overwrite remaining credits. It receives no
database, forwards no transaction and performs no provider I/O inside the commit.
This member-only grant does not trigger shared-wallet expiration. The separate
Atom plan replacement and its bundled member grant remain in the unfinished
plan publication/cancellation graph.

### Usage-pack plan activation ownership

Plan-change invoice activation now dispatches `activateUsagePackPlanFromSubscription$` and its owning publication command with ordinary Stripe and local snapshot values. Neither command accepts or forwards a database handle. Preparation resolves the existing binding and reads the finite allocation candidates outside the transaction. Publication directly executes the subscription, organization plan, entitlement, and pending-count SQL in one local transaction, with no provider calls. It rereads the current bound subscription and the prepared allocation IDs, rejects a terminal or moved subscription, validates the current quantities, and rejects newly active allocations omitted by preparation before publishing anything.

The R1 publication still takes the existing billing compatibility keys and locks organization subscription roots before the pending guard. This order remains necessary while outgoing lifecycle writers lock a subscription and then enter their pending-count trigger. Removing those compatibility boundaries requires the complete common pending-snapshot writer protocol and the documented outgoing-writer/drain/rollback evidence; changing this activation command alone is not that evidence. Stripe quantity/schedule ordering, the remaining allocation/plan-change helpers, and legacy Atom/plan replacement cancellation are still separate implementation gaps.

Focused Prettier, Oxlint, ESLint, and diff checks cover this change. Existing user-API plan-change and paid-invoice behavior tests must run against the integrated PR head; no local Vitest or development server was run.

### Allowance subscription publication

Stripe allowance updates now enumerate their organization targets outside any transaction and dispatch one business-input command per organization. Each command prepares active window IDs outside its transaction, then owns the wallet before the current entitlement and directly updates that entitlement and those windows. It reevaluates the existing Stripe-binding/custom-plan admission from current rows, preserves consumed units, and rejects an active window added after preparation so a redelivered event can prepare again. Cancellation still expires every prepared currently active window; credit-limit changes still update both short and weekly limits. Provider work and target enumeration do not run inside this transaction, and the former target/window helpers no longer receive database or transaction handles.

This closes the subscription.updated allowance publication subgraph. The invoice-paid allowance owner is also migrated below. The subscription.deleted branch executes its window SQL directly using a pure value builder; its enclosing legacy database-bearing owner still requires migration. The adjacent subscription.updated plan projection is described below; the global Stripe quantity/schedule protocol remains separate implementation work. Focused formatting, Oxlint, ESLint, and diff checks passed; integrated API behavior remains a PR-pipeline check.

### Legacy subscription.updated plan publication

`publishLegacyPlanSubscription$` now owns the organization plan projection, its plan entitlement, and trial shortening in one local SQL transaction per organization. Stripe scheduled-end preparation and organization/credit-lot enumeration run outside transactions. The command rechecks the current subscription/custom-plan binding while owning the wallet, directly reads current member-pack eligibility and subscription entitlement ownership, and preserves the existing duplicate-Stripe-identity behavior and marketing-metadata retirement. Trial shortening only updates the prepared, still-positive matching renewal lots; a newly eligible lot aborts the entire publication for event redelivery. It does not extend or revive expired credits.

`handleSubscriptionUpdatedLegacy$` dispatches these ordinary-value commands and the allowance/concurrency owners, with its caller's final abort signal. The former transaction-bearing plan-entitlement helper is removed. The separate invoice grant/replacement path and the usage-pack lifecycle synchronizer remain outside this completion claim. Focused formatting, Oxlint, ESLint, and diff checks passed; user-visible billing, allowance, and trial results still require the combined-head API pipeline.

### Allowance invoice ownership

Allowance invoice processing now prepares provider invoice details before dispatching `publishUsageAllowanceInvoice$`. That command directly owns wallet-before-entitlement locking, current invoice binding admission, entitlement publication, and cancellation-window SQL. Active invoices use the existing subscription/effective-time business predicate on the actual conflicting row, so a concurrent different, newer subscription cannot be overwritten using a stale preliminary read. Canceled invoices update only the still-matching or unbound entitlement. Prepared window IDs are revalidated, and a new active window rolls back both cancellation and window expiry for event redelivery. Provider calls and database handles do not cross this command's transaction boundary.

The subscription.deleted orchestration remains a separate ownership gap. Focused formatting, Oxlint, ESLint, caller search, and diff checks passed for invoice publication; the combined PR pipeline must verify the existing allowance billing API scenarios.

### Preview Slack starter wallet

The preview Slack seed route now dispatches an ordinary-value command for default-agent publication and the starter wallet. That command owns the wallet, preserves an existing wallet without re-granting or downgrading it, and commits any new-wallet starter receipt, arithmetic balance increment, initial entitlement, and default-agent reference together. It finishes any orphaned expired remainder before a new grant, preserving the common balance-writer ordering. The existing starter-grant uniqueness still prevents cleanup/reseed from granting twice. The prior transaction-bearing starter/default callbacks are removed. Built-in model-key fixture provisioning remains a separate database-bearing fixture graph and is not certified by this monetary change.

Focused formatting, Oxlint, ESLint, obsolete-caller search, and diff checks passed. The preview Slack user-API scenarios must still pass on the integrated PR head.

The combined-head WHCB07 API regression exposed an allowance-only organization: a paid allowance invoice can legitimately create its entitlement before an organization wallet exists. A subscription update matched by that existing binding therefore remains admitted without a wallet row; metadata-based rebinding still requires and validates the wallet. The command always owns the current entitlement, and an existing wallet is acquired first. This restores the existing renewal/limit-update contract without relaxing the API assertions.

## Remaining member-grant writer preparation

The allocation-upgrade invoice commit and subscription-change invoice fulfillment now acquire the existing billing compatibility key, their subscription parent, and the wallet before any change, claim, receipt, or member-grant row. Their prepared organization and subscription identities are revalidated against the owned current change. Grant publication and the invoice receipt still commit together. The subscription-before-wallet order matches primary paid fulfillment and avoids reversing its parent ownership order. The extracted builders accept only ordinary identifiers and do not execute SQL. These two legacy functions still accept or forward database/transaction handles; preparing their monetary order does not complete command ownership.

The following member-grant creator boundaries remain implementation work, not outgoing-writer drain gates:

- Accepted invitation activation (`activateAcceptedPurchase`) now acquires the existing wallet explicitly in its transaction owner after the Stripe projection has returned and before either purchased or bonus grant. The subsequent grant/refund-source, allocation and acceptance writes are SQL only. This closes the settlement-prefix publication gap without newly holding the wallet across provider I/O. The enclosing transaction still passes its handle and retains provider projection earlier in its scope; that command/remote-protocol boundary is unfinished.
- Get-started check-in, connector, iMessage, invitation-reward acceptance, and review entrances now acquire or create the existing wallet before publishing their claim and member grant. Review finalization and AgentPhone linking/code consumption are command-owned finite transactions; check-in executes its SQL directly in the route command. Signed Clerk invitation/membership acceptance now dispatches its own finite reward command. The paid-invitation recovery caller still uses the ordinary invitation helper, and the shared Builtin/custom credential publication graph still forwards database/transaction handles. This remaining ownership work is separate from their new wallet-before-claim monetary ordering. Paid invitation allocation activation now has the explicit monetary gate described above; its broader transaction remains unfinished.

The primary paid usage-pack fulfillment and member-only Atom invoice command already own the wallet before publishing member grants. The legacy bundled Atom path also owns it, but its provider cancellation and handle propagation remain separately unfinished.

Without wallet ownership, a creator can insert a purchased grant after settlement has checked for unseen earlier grants but before settlement commits its prepared bonus deduction. A user-visible balance read between those commits can observe both full grants, so this is a real purchased-before-bonus ordering gap; the prefix query alone is insufficient. The R1 creator audit now covers direct `usagePackCreditGrants` inserts and the `createUsagePackCreditGrant`/pure-SQL caller graphs: subscription invoice fulfillment, member-only and bundled Atom invoices, both allocation invoice owners, invitation activation, review/invitation rewards and automatic check-in/connector/iMessage rewards all acquire the wallet before a new grant. Fixture-only grant insertion is not a production writer. Existing paid invitation/refund/migration writers acquire the same billing key before conflicting purchase/allocation writes, while purchase-only claims never acquire the wallet and invitation-reward/refund source reads of purchases do not lock them. No wallet-to-purchase-lock path outside that billing key was found. This is a traced source argument, not a runtime forced interleaving test or a claim that all those owners already have final command boundaries. Release 1 readiness remains false while the identified broader boundaries and Stripe protocol are unfinished.

### Get-started member reward ownership

`grantGetStartedClaim$` obtains `writeDb$`, owns wallet-before-claim order, checks the current review lease and terminal status, and commits its member credit and completed claim with direct SQL. A global author/reward-slot conflict rolls back that whole transaction; a finite retry begins a fresh transaction and observes the winning claim. No transaction, database, callback adapter or nested savepoint crosses this command. The review worker obtains its own database for each command and keeps provider reads and realtime publication outside the redemption transaction.

Automatic connector/check-in/iMessage rewards use the existing unique actor/quest/source identity to insert the completed receipt and its credit in one SQL statement. The SQL builder accepts only business values. A duplicate completion creates no new credit, including a same-user completion in another organization. The iMessage source remains the one fixed `agentphone-link` identity; linking an already existing account does not grant a retroactive reward. The parent transaction owns the wallet before claim/grant publication; this prerequisite is explicit at both Builtin OAuth completion entrances, custom OAuth publication and invitation-reward acceptance, rather than hidden in a grant helper.

`linkAgentPhoneIdentity$` owns link creation, an optional one-time connection-code consumption, and the iMessage receipt in one bounded transaction. Existing phone/user ownership is checked through the existing unique identities; a conflicting code is consumed as before. The direct link route and incoming-code route pass ordinary identities to commands. Code creation, code consumption and review callers no longer forward databases. Existing API cases cover duplicate check-ins across organizations, concurrent author rewards, invitation quota/acceptance, code reuse and wrong-account linking, exact TTL and personal-credit spending. These assertions remain; final behavior verification belongs to the combined PR pipeline.

Builtin/custom credential publication still includes shared transaction-aware helpers. The Builtin graph also retains the old revoke/Calendar preparation boundary until that owner moves provider/KMS preparation outside the publication transaction. This is unfinished implementation, not a compatibility permission to keep wallet ownership across external I/O. These source graphs and paid-invitation recovery are not certified by the completed review/AgentPhone/Clerk reward subgraphs.

`acceptGetStartedInvitation$` owns signed Clerk invitation and membership rewards. It acquires the wallet before the specific claim, validates the invitation identity and self-invitation restriction, and commits the acceptance timestamp, unique invitee/slot receipt and member bonus together. Global uniqueness conflicts roll back the whole transaction before a bounded fresh attempt. The paid-invitation recovery entrance still invokes the ordinary database-bearing helper; migrating that caller must preserve its separate purchased-credit activation and Stripe correctness. Existing acceptance-before-payment, duplicate delivery, quota and membership-webhook API cases remain unchanged. Focused formatting, Oxlint, ESLint and diff checks pass; integrated behavior remains a PR-pipeline check.

### Shared-wallet expiration writer trace

The shared-wallet expiration prerequisite is separate from the member-grant creator protocol. The current caller trace is:

| Monetary operation                                                                    | Current admission under wallet ownership                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paid credit purchases, automatic recharge, campaign and one-time invoice credits      | `grantPurchasedOrgCredits$` checks expired remainder before the unique invoice receipt and arithmetic increment; an expired remainder exits the transaction and invokes expiration before retry.                                     |
| Limited-free bootstrap                                                                | The grant command checks expired remainder before its one-time receipt and increment; existing paid tiers remain unchanged.                                                                                                          |
| Slack installation, connect/reconnect rewards                                         | The owning Slack write commands check expired remainder before the organization reward receipt and increment.                                                                                                                        |
| Usage/Social shared debit                                                             | The bounded settlement owner rejects expired remainder before shared debit; its complete event/allowance/grant transaction rolls back before expiration and re-preparation. Grant-only settlement does not mutate the shared wallet. |
| Stripe subscription renewal, Atom grant, trial extension and first-paid debt clearing | Each currently owns the wallet and finishes atomic expiration before adding, extending or clearing debt. Their remaining helper/provider boundary cleanup is separately tracked.                                                     |
| Scheduled expiration                                                                  | The R1 Atom-expiration cron calls the finite batch owner; its omission check selects the full clamp only when the outgoing-writer compatibility boundary requires it.                                                                |
| Development wallet provisioning                                                       | CLI and Slack preview writers likewise finish expired remainder before changing the wallet. Test-only fixture assignments do not execute in production.                                                                              |

Member-credit refunds do not increment `org_metadata.credits`; they retire member grants and issue Stripe refunds. The member cleanup/refund protocol still requires its own command review. Organization deletion removes the wallet and its lots rather than admitting a new credit balance.

This trace identifies no additional production shared-wallet adder that skips the expiration admission rule. It is a caller review of the listed operations, not a declaration that every database-bearing interface is gone. R1 still executes full atomic expiration because pre-R1 grant and renewal requests can add after one partial clamp while old consumers can spend before the remaining clamp. The `credit_` key does not cover all those old adders or the old cron, so retaining that key across separate transactions is neither sufficient nor an acceptable substitute.

After those outgoing serving/in-flight/rollback writers are gone, remove the completeness-triggered full-clamp branch. The already implemented finite commit then owns the wallet, clears only its prepared IDs and applies their actual arithmetic clamp; its outside-transaction loop prepares the next batch. A concurrent R1 adder or consumer finishes/refuses remaining expired lots before an amount mutation, so it cannot interleave a purchase or charge between partial clamps. The R1 full branch and R2 finite branch can coexist under this rule. This is a bounded runtime path today for complete cohorts of at most 100 rows, not a declaration that large-cohort runtime or legacy inline billing callers are already bounded.

The public API expiry regression now covers both a small purchase history and 120 expiring purchases. Authenticated usage creates real debt; signed Stripe invoices bring the wallet to 5 while leaving a larger expiring total. After time advances, duplicate new purchase webhooks must leave the full 150 new credits, later usage must leave 149, and redelivery cannot grant twice. It checks billing API amounts and grant receipts without an internal gate, database mutation or waiter. Focused formatting, Oxlint, ESLint and diff checks pass; behavior and types require the final combined PR pipeline. No new coordination field, table, trigger, advisory key or cross-transaction handle was added. Newly discovered balance writers bypassing admission and remaining inline expiration owners are R1 implementation work, not removal-gate exceptions.
