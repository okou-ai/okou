# Advisory lock cleanup: billing Release 1 preparation

This inventory is based on `5b458cc9` and the billing work integrated into the
single Release 1 PR #37313. It
tracks the seven billing acquisition definitions separately from transaction
propagation. It does **not** declare the whole billing package ready for
Release 2.

The accepted Stripe target has since changed to
[a subscription projection from existing data and daily reconciliation](advisory-lock-terminal-state.md#declarative-stripe-subscriptions-and-daily-reconciliation).
No new database tables or fields are allowed; the briefly considered table
exception is withdrawn. Temporary quantity/schedule drift is accepted. Earlier
references here to a common remote ordering protocol do not require preventing
every stale intermediate configuration write; assess
them against eventual convergence and the retained financial guarantees.
This records the new target, not an implemented replacement.

## Implemented protocols

### Stripe customer publication

`getOrCreateStripeCustomer$` now uses a stable Stripe idempotency key scoped to
the environment, preview routing identity, and organization. It inserts metadata
and its default entitlement in the owning command's transaction, or updates an
existing metadata row only while `stripe_customer_id IS NULL`. A losing
publication reads and returns the authoritative binding. Checkout never uses an
unpublished candidate ID. Existing entitlement rows and paid tiers are not
replaced by the default initialization.

Stripe candidate creation now runs **outside** the database transaction. Only
the finite publication transaction retains the old customer advisory acquisition.
An outgoing writer reads the binding under that same acquisition before creating
and unconditionally publishing its customer. If it wins first, the new command
rechecks after acquiring the lock and returns the outgoing binding. If the new
command wins first, the outgoing writer observes the committed binding before
its creation step. Independent candidate preparation can leave an unreferenced
Stripe customer; a Checkout always uses the authoritative published customer.
Provider-response and publication failures reread the committed binding before
propagating an uncertain result. No failed caller deletes a candidate that may
already be referenced. The concurrent Checkout API cases delay one customer
response until the other request has published, then cover both its successful
candidate response and its lost provider response. Both requests and a later
retry must use the same published customer while the billing API remains unpaid.

After incompatible APIs have stopped serving, their requests have drained, and
all rollback targets contain the conditional publication, Release 2 removes the
customer advisory acquisition. No provider-I/O transaction remains to move for
this command. No App or Runner contract changes. Stripe's finite idempotency
retention is not presented as a permanent remote operation log; a remote success
followed by a lost response beyond that retention remains the existing recovery
window.

### Checkout completion publication

`completeCheckoutSession$` reads the existing metadata row before calling Stripe
and publishes the subscription binding only when that exact PostgreSQL row
snapshot still matches. A concurrent billing transition causes a pending response
and a fresh retry instead of overwriting its result. No transaction spans the
provider reads. This is a publication predicate, not the still-missing admission
protocol for two different purchases that can both become payable.

### Usage-pack Checkout completion commit

Webhook delivery and Checkout reconciliation now dispatch the same
`handleUsagePackCheckoutCompleted$` command using the Session and provider
subscription as ordinary inputs. Its publication command obtains `writeDb$` and
owns all SQL: existing subscription roots lock before the existing pending-count
guard, the root is reread under lock and its allocations are read, correlation
and shape are validated, and subscription binding, matching Plan metadata, and the final
pending count commit together. The command assigns the verified final pending count; the former pending-count
trigger was already retired by historical migration 1132.
No transaction or database handle reaches a helper, and no Stripe call occurs
inside this commit. Customer and Session mismatches reject before local writes.

The webhook Checkout dispatcher is now a command so it can dispatch this owned
commit directly. Its invitation branch now dispatches the business-input
invitation commands described below. One-time-credit and canonical Plan-binding
branches still have legacy database-aware services; converting the dispatcher
to a command does **not** finish those chains. Ordinary subscription lifecycle
synchronization and the purchase creation/confirmation graphs also remain
unfinished. These paths still need the approved desired-state and reconciliation
model; no pending-count trigger is retained by this PR.

### Usage-pack in-app price preview

The immediate and recurring Stripe invoice previews now run outside every SQL
transaction. Owning commands read the preferred purchase snapshot and its
allocations, prepare both provider prices, and publish only a timestamp refresh
in a bounded command-owned commit. Publication rechecks the ordinary member or
invitation selections and requires the same transient PostgreSQL `xmin`, pending
status and empty provider bindings. A changed snapshot takes the existing
prepare/retry route rather than returning a stale token. This commit does not
change the pending state or count, so it does not use the transaction callback
API for pending-snapshot mutations.

The existing two-preview/one-subscription API case now delays the first provider
preview response until a second user preview has completed. Both returned quotes
retain the expected immediate/recurring amount and unpaid billing state, and both
can be confirmed without creating a second subscription. There is no database
gate or provider-call-count assertion for price previews. The initial snapshot
preparation and actual Checkout/subscription creation/confirmation paths still
have legacy transaction propagation and provider-I/O boundaries; this finite
preview change does not claim those purchase-admission protocols are complete.

### Plan purchase admission predicates

An active Stripe Plan that is not the preview's bound source is a competing
purchase. A stale Team preview cannot ignore an unbound Pro subscription just
because Team is a higher tier. Recovery may retain a former lower-tier Plan only
when the exact incomplete purchase is already the local subscription binding.
Competing subscriptions are checked before replaying an existing purchase, so
an old preview cannot resume its earlier invoice over a later paid Plan.

The API regression retains concurrent same-tier confirmation, adds the stale
higher-tier preview before local publication, and rejects replay after another
paid subscription appears. These predicates fix admission and recovery cases;
they do not replace the common arbitration still required for provider creates
whose outcome is not yet observable.

Checkout's existing credit binding and canonical Plan subscription lookup now
belong to business-argument commands that obtain their own database and return
ordinary values. The concurrency checkout target, payment preview and
revalidation chain no longer accepts or forwards database handles. Its owning
read command directly verifies the entitlement and active subscription rows,
preserving missing-entitlement errors, the paid-through grace predicate and
the requirement to restore an existing canceling add-on before buying more.

The retained purchase acquisition is now a pure SQL builder, executed directly
by its caller. This removes that transaction-handle interface; it does not
complete the pending-snapshot callback graph or make the unresolved provider
creation protocol safe to remove. Plan confirmation still retains the
documented provider-I/O compatibility boundary until that protocol exists.

### Restoration publication and setup callbacks

Direct restoration and the payment-method setup callback now call the same
business-argument command. It obtains its own database, prepares Stripe work
outside a transaction, and directly commits the metadata update and matching
scheduled-allocation cleanup in one local transaction. The metadata publication
compares the original PostgreSQL row and its transient `xmin` snapshot. If that
snapshot changed, the command leaves both the newer metadata and its allocation
state alone; the direct API returns a conflict. No database or transaction is
passed to the former restoration or allocation-cleanup helpers.

Setup Checkout validation and dispatch are also commands with business data.
The validation command reads its own database; provider payment-method updates
and follow-up commands receive no database handle. These changes prevent stale
local publication. Cancellation, restoration and schedule writers still need
to publish desired configuration for identity-only reconciliation.

### Downgrade and empty-subscription cancellation publication

Direct downgrade, payment-method setup completion, last-member removal and the
reconciliation retry all dispatch the same business-input downgrade command.
The command reads ordinary local snapshots, prepares cancellation or schedule
changes through Stripe, and publishes direct SQL in its own bounded transaction.
Publication matches the original metadata row and its transient PostgreSQL
`xmin`; matching superseded concurrency state is cleared in that same commit.
The direct API reports a conflict if a newer billing transition won.

For an empty usage-pack subscription, the owning member-removal or cron command
receives ordinary subscription/change IDs from the existing allocation workflow.
It dispatches cancellation without forwarding that workflow's database handle.
The cancellation commit also conditionally marks the exact usage-pack
subscription and removal change as canceled/scheduled, so these local results
cannot commit separately from the metadata transition.

The concurrent Team cancellation API case verifies at least one successful
request and the final billing period, retained active tier and cancellation
state. A conditional-publication conflict is a supported response. Existing
member-removal and reconciliation API cases continue to cover cancellation and
refund behavior. The allocation preparation, nonempty removal, refund and
reconciliation helper graphs still propagate database handles and remain
unfinished. This local ownership change does not implement desired-state
reconciliation or the shared payable-purchase admission protocol.

### Concurrency change, cancellation and restoration publication

All database access in `billing-concurrency-subscription.service.ts` now belongs
to commands with business arguments. Active subscription and schedule ownership
reads obtain their own database and return ordinary values; no database handle
is passed through provider preparation or restoration helpers.

Change, cancellation and restoration publish only while the complete original
concurrency row and its transient PostgreSQL `xmin` still match. A rejected
publication returns an API conflict without overwriting the newer row. The
snapshot only spans this one read/provider-call/publication operation; it is
not stored as a business revision. It also distinguishes a deleted and
reinserted row whose values happen to match. Provider calls remain outside SQL
transactions. Concurrent cancellation coverage accepts either serialized success
or a conditional-publication conflict and checks the final public subscription
quantity and cancellation state.

This completes local conditional publication for these three entry points. They
still need to commit desired business configuration before synchronization.
Already-issued Stripe updates may temporarily drift; subsequent reconciliation
must restore the latest local intent without repeating financial effects.

### Invitation preview ownership

The purchase-preview route now dispatches business-input commands for its plan
admission and current subscription reads. Preview preparation owns its local
subscription and reusable-purchase reads; the proration preview command owns its
subscription/allocation/change snapshot. Only ordinary rows and values reach the
Stripe preparation helper. Clerk membership lookup, invoice-preview pagination,
Price reads, and credit calculations all run outside SQL transactions.

`insertPendingInvitationPurchase$` owns the finite commit that supersedes an
unbound unpaid preview and inserts the new purchase under the existing normalized
email unique index. The command obtains its own database and passes neither the
database nor transaction to a helper. The existing API coverage for concurrent
previews, preview replacement, payment amount/tax and unpaid billing behavior is
retained. Invitation confirmation now uses the same owned allocation-preview
command, so its former database-aware preview call is removed. Payment activation,
refund projection and the shared remote protocol below remain separate unfinished
work.

### Invitation purchase transitions

The invitation-creation, refund, and acceptance-activation claims use conditional
`UPDATE ... RETURNING` over their existing business states. Recovery also checks
the existing stale-work timestamp. Refund result publication matches the actual
`refund_attempt`, so an older failed or pending result cannot reopen a completed
or newer refund. Successful completion and projection cleanup also retain the
claimed refund attempt, so a delayed result cannot finalize a later attempt.
Invitation expiry matches the creation claim's original timestamp. A Clerk
read-limit response only releases the claim whose
existing timestamp it read; a superseded invitation-creation result is not
published into another claim.

Multi-row purchase transitions read their owned row within their local
transaction and guard the final state update. The existing credit grant
identities and atomic grant/allocation writes remain intact.

### Invitation command ownership and operation admission

Invitation preview, confirmation, payment receipt, invitation creation,
acceptance recording, refund receipt, revoke and reconciliation now dispatch
business-input commands. Each SQL owner obtains its own `writeDb$`; the Clerk
webhook dispatcher, invitation route, Stripe dispatcher and reconciliation
caller no longer forward a database into this graph. The duplicated get-started
acceptance helper is removed in favor of the existing owned acceptance command.
The remaining invitation-creation/reward-link writes are owned commands too.

Activation directly executes at most two ordinary-value grant SQL statements
under the wallet owner. Each statement checks immutable grant/payment identity
and preserves the original remaining amount on replay. Purchased grants and
their real PaymentIntent refund sources commit with allocation and purchase
activation; bonus grants keep their existing independent key. No grant/refund
helper receives the transaction. Refund completion keeps its attempt predicate.

Reconciliation pages candidate IDs in batches of 100, with provider work between
queries and outside every pagination transaction. Expired unpaid purchases are
also retired in batches of 100. Their final update still requires the pending
state and expiry, so a concurrently committed payment cannot be overwritten by
an earlier expiry read.

A common finite admission check now covers the existing Plan-change,
standalone allocation-change and invitation activation/refund business rows.
After owning the real subscription parent, confirmation excludes another
`applying`/`pending_payment` Plan or allocation change, or
`activating`/`refunding` invitation. Invitation activation/refund uses the same
check before committing its existing active state. An operation excludes only
its own row; a stored completed response remains readable while another change
is active. A preview is not a general lock, and no synthetic operation record,
new state field or lease is introduced. Existing advisory acquisitions remain
for incompatible writers and the unfinished remote projection graph.

The API regressions construct a paid subscription and invitation through
Checkout, purchase and webhook routes. Both standalone and grouped Plan/package
confirmation keep an unfinished payment authoritative while an invitation is
accepted. The invitation remains unactivated until the original invoice-paid
webhook completes the change; ordinary Clerk redelivery can then finish it.
Member credit and management APIs verify the exact paid amounts, no early or
duplicate grant, both resulting allocations, and the inviter's existing
100-credit reward. The tests use no internal state or reconciliation route,
database gate, waiter, trigger or provider-call-count assertion; execution
remains a PR pipeline check.

This is **partial shared-protocol preparation**, not completion of Release 1.
`activateAcceptedPurchase$` still passes its transaction to
`syncUsagePackAllocationProjection`, and
`removeRefundedInvitationProjection$` still passes one to
`syncUsagePackAllocationProjectionAfterInvitationRemoval`; both transactions
still span Stripe. The allocation confirmation's newly owned admission commit
does not convert its later legacy provider/application helpers. Migration,
concurrency mutations, ordinary Plan purchase and other shared subscription
writers do not yet all use this admission/recovery rule. These are unfinished
implementation, not conditions that outgoing-writer drain alone resolves.

### Invitation email arbitration

The `usage_pack_invitation_email` acquisition and its two callers are removed.
`uq_usage_pack_invitation_purchases_current_email` already enforces one open
purchase for an organization's normalized email, including for outgoing writers.
Preview replacement conditionally retires an unpaid preview and inserts with
`ON CONFLICT DO NOTHING`; a conflicting request receives the existing business
conflict response. A paid purchase only supersedes a competing unpaid preview
when the conditional update actually returns it.

If two paid, previously failed purchases race for an empty email slot, the
existing unique constraint chooses the winner. The loser records the validated
payment receipt as `refund_pending` in a new bounded transaction, then follows
the existing refund path. Only that named uniqueness violation is handled this
way. Other database or provider errors remain failures. An outgoing writer that
loses the same index race rolls back and follows its existing webhook retry;
the transaction cannot commit two open purchases or lose a committed receipt.

## Acquisition inventory and remaining gates

| Acquisition                                       | Release 1 result                                                                   | Why a retained boundary cannot yet be deleted                                                                                                                                                                                                         | Release 2 removal gate                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                           | Provider idempotency and conditional publication implemented; retained acquisition | Outgoing creation has no idempotency key and unconditionally overwrites the binding                                                                                                                                                                   | Verified API drain and compatible rollback targets; then delete the finite publication acquisition                                                                         |
| `billing_purchase:<org>`                          | Retained; replacement protocol is not complete in this PR                          | Stateless Plan previews have different purchase IDs; two creations can both become payable. Pending usage-pack snapshot writers also share this boundary                                                                                              | Complete a common creation/arbitration protocol for every Plan and usage-pack writer, then verify API drain and rollback compatibility                                     |
| `stripe_concurrency_subscription:<subscription>`  | **Removed**; conditional projection and daily observation repair                   | Old equal-quantity events could overwrite observations even with the key. New writes use timestamp/xmin CAS and immutable invoice-line identities; daily identity-bucket visits repair live observations without charging                             | No advisory removal gate remains for this key. Desired concurrency configuration, purchase admission and intent ownership are separate unfinished R1 work                  |
| `usage_pack_billing:<org>` in allocation service  | Retained; replacement protocol is not complete in this PR                          | Allocation, migration and deferred schedule workflows still issue Stripe quantity/schedule updates under this key; outgoing invitation activation/refund also do. R1 invitation activation/refund only take it for local writes and sync after commit | Implement desired-state writes, daily reconciliation and payment idempotency with remote work outside commits; verify old/new intent ownership and rollback compatibility  |
| `usage_pack_billing:<org>` in plan-change service | Retained; replacement protocol is not complete in this PR                          | Plan/allocation writers have not yet committed shared local desired current/renewal configuration; temporary provider drift itself is accepted                                                                                                        | Same desired-state/reconciliation implementation as allocation; real invoice and entitlement identities must still prevent repeated financial effects                      |
| `usage_pack_invitation:<purchase>`                | Conditional claims and guarded result writes implemented; retained acquisition     | Outgoing purchase writers still read state and subsequently update by ID; outgoing activation/refund still project Stripe inside this key. R1 activation/refund commit locally and use identity-only sync                                             | Finish all purchase write/cleanup predicates and the shared projection protocol, remove transaction propagation, then verify outgoing API drain and rollback compatibility |
| `usage_pack_invitation_email:<org>:<email>`       | Removed                                                                            | Existing business unique index arbitrates both old and new writers                                                                                                                                                                                    | No additional release gate                                                                                                                                                 |

The table identifies the six retained billing acquisition roles from the original
seven-role inventory. Allocation and Plan change now reuse one pure SQL builder
for `usage_pack_billing`; this removes a duplicate SQL definition, not a runtime
lock or an independent rollout requirement. Their callers must be assessed as
one interacting protocol.

## Transaction ownership inventory

This is a call-chain inventory, not a count of matching type signatures:

- **Customer:** the command owns the metadata insert/CAS and entitlement insert.
  `writeOrgMetadataWithDefaultPlanEntitlement(tx, ..., callback)` is removed from
  this path. The reused entitlement builder accepts ordinary values only.
  Provider candidate creation is outside that transaction; only finite publication
  retains the old acquisition. Failure recovery rereads the published binding.
- **Purchase admission:** `confirmPlanPurchase$` now owns its transaction and
  SQL directly; `confirmPlanPurchaseTransaction` and its transaction argument
  are removed. The old admission boundary and Stripe I/O remain while the
  common cross-preview protocol is unresolved. `writeUsagePackPendingSnapshots`
  still owns a transaction-aware callback and propagates it to snapshot guard
  helpers; those interfaces require implementation, not just lock deletion.
- **Concurrency subscription projection:** the propagated upsert helper is
  removed. Invoice and subscription publication commands accept business data,
  obtain their own database and execute finite SQL directly. Snapshot reads and
  Stripe I/O happen outside these transactions; a pure SQL builder constructs
  their retained outgoing-writer advisory acquisition. All production writes
  advance the existing timestamp, and webhook/cron publication compares its
  exact pre-read value plus PostgreSQL's existing `xmin` row version. Legacy
  invoice organization binding, Plan/allowance reconciliation and cron
  preparation still pass writable databases or transactions to services and
  remain unfinished ownership work. See
  [the projection protocol and removal gate](advisory-lock-release-1-concurrency-projection.md).
- **Restoration and setup callbacks:** the `restoreSubscriptionForOrg(db, ...)`
  interface is removed. Restoration owns its direct metadata CAS and scheduled
  allocation update. The former `billingSetupSubscriptionState(db, ...)`,
  `applyBillingSetupPaymentMethod(db, ...)` and setup-dispatch database arguments
  are removed; owning commands read the finite local state and call provider
  operations outside transactions. Downgrade snapshot and publication commands
  now own their SQL as well; empty-subscription callers dispatch through ordinary
  IDs and atomically publish the related local usage-pack state. The surrounding
  allocation/refund/reconciliation helper graph still needs command ownership.
- **Concurrency change, cancellation and restoration:** read/preparation
  interfaces accept no database. Each publication is direct conditional SQL in
  its owning command, after external provider work. No transaction spans that
  provider work, and the row snapshot remains ordinary operation-local data.
- **Allocation and plan changes:** the allocation and Plan preview service
  chains now dispatch business-input commands for their direct SQL reads and
  publication. The route's shared access/payment-preview graph, confirmation,
  finalization, migration, pending-snapshot, credit-grant and schedule helpers
  still pass databases or transactions. Their remaining Stripe calls, pagination
  and callback ownership must be separated from bounded SQL commits.
- **Invitation:** the route/webhook/cron graph now dispatches owned commands.
  Recovery inserts, purchase/receipt transitions, reward links and grant/refund
  source SQL execute directly in the command that owns them. `lockPurchase` is
  replaced by a pure SQL builder, and no grant or get-started helper receives
  a database. Allocation assignment and activation still reject retired or
  reassigned rows. Activation and refund removal no longer propagate a
  transaction into Stripe: each commits its local allocation/grant rows and
  then requests the identity-only usage pack configuration sync. A failed sync
  leaves correct local business state and is repaired by the daily sweep.

## Allocation and Plan preview admission

Standalone allocation preview publication now runs in
`persistUsagePackChangePreview$`, with ordinary business inputs, its own
`writeDb$`, and direct bounded SQL. Stripe pricing remains outside the transaction.
The commit locks the existing usage-pack subscription root before child rows,
rechecks for a real Plan change in `previewed`, `applying`, or `pending_payment`,
validates the allocation's organization, member, subscription and original price,
and inserts the preview under the existing uniqueness constraints. The Plan
preview publisher takes that same parent lock before expiring or superseding
child previews. No claim field, coordination row or synthetic state is added.

This closes a concrete new-writer admission race: allocation pricing can start
before a Plan preview, wait for Stripe while the Plan preview commits, and then
attempt to publish. The initial unlocked Plan lookup is insufficient; the final
owning-command check now returns a conflict. Failed or completed Plan changes do
not block a new preview. An expired preview retains the existing lifecycle until
the normal preview retirement/supersession path changes its status.

The regression test prepares a paid subscription through Checkout and webhook
APIs, delays only the provider response, publishes the competing Plan preview,
and checks the rejected allocation request, unchanged billing allocation and
unchanged member credits through production APIs. It does not hold database
locks, inspect waiters or install a test trigger.

This is one part of common writer preparation, not a completed organization
purchase or desired-state reconciliation protocol. Outgoing allocation writers do not repeat
the Plan check after external pricing; the old advisory boundary does not itself
repair that pre-existing stale-preview window. The shared advisory acquisition
also still covers outgoing allocation, Plan, invitation and migration writers.
Their local intent ownership, payment effects and command boundaries remain
unfinished; temporary remote drift alone no longer justifies this lock. Its
removal therefore needs both the remaining common protocol implementation and
verified retirement of those incompatible writers.

Plan preview preparation and resume now read through owning business-input
commands. `persistSubscriptionChangePreview$` owns the parent lock, direct
snapshot reads, preview retirement and root/child insertion in one short
transaction. Its retirement SQL builder accepts only an organization ID and time;
its validation and insert-value builders accept ordinary rows. No database or
transaction is forwarded. The retirement statement preserves the existing
expired-versus-superseded reasons for both the Plan intent and its child rows.
Stripe subscription/schedule reads, invoice previews and credit-price preparation
finish before publication begins. Other Plan confirmation, finalization and
reconciliation interfaces remain implementation work. The old Plan-local lock
wrapper now uses the same pure compatibility-key SQL builder as Allocation;
consolidating that definition does not remove the shared advisory boundary.

Plan confirmation preparation now shares the owning stored-change reader with
preview recovery. `markPreparedChangeApplying$` locks the existing subscription
before its Plan change, validates organization/subscription membership, and
commits preview expiration or the root/child `applying` transition itself. The
existing resume, pending-payment, completed and expired responses remain intact;
provider invoice reads occur outside this transaction. The public confirmation
entry accepts business data, but its later `applyStoredSubscriptionChange(db,
...)` provider/application graph still forwards the database. Only preparation
and admission are complete here; finalization and the common remote protocol
are still unfinished Release 1 implementation.

The final local-order review aligns these three preview/confirmation commits
with paid fulfillment, Plan activation and Checkout publication: they lock all
existing subscription roots for the organization in ID order before child rows.
Plan preview publication locks allocations before organization metadata as those
paid writers do. The prepared subscription's customer/binding, status, tier,
Price, billing periods and cancellation flag must still match before an old
quote can publish. Plan source/allocation checks now precede preview retirement,
so a rejected stale request cannot retire another valid preview. Earlier code
also committed retirement before returning a failed final check; the owning
command conversion initially preserved that behavior and this follow-up closes
it. The existing expired/superseded reason semantics remain unchanged for a
valid replacement.

The added API regression pauses both package and Plan pricing at Stripe, delivers
a real subscription-cancellation webhook, and verifies that both stale previews
are rejected while the cancellation, original allocation and credits remain
visible through billing APIs. Remaining legacy writers have not all adopted
this root order. Their payment and intent-ownership boundaries need conversion
to the approved declarative model; strict remote configuration ordering is no
longer a removal prerequisite.

## Unresolved Release 1 work

Billing Release 1 preparation is **not complete**. The accepted replacement is
deriving the desired subscription from existing business records and using the
same projection for mutation-time synchronization and daily reconciliation.
If an older request writes quantity 2 after a newer request wrote 3, that
temporary drift is now accepted: subsequent reconciliation must
read the desired 3 and repair Stripe. A database CAS cannot undo a remote write,
but preventing that intermediate write is no longer an acceptance requirement.

The [Stripe protocol evidence review](advisory-lock-release-1-stripe-protocol-evidence.md)
records historical item/schedule ordering alternatives and verified provider
contracts. The former are not prerequisites for this new target. The latter
still matter to financial effects: configuration repair must not repeatedly
issue invoices, replace payment actions incorrectly or grant unpaid service.

The current allocation, plan-change, migration and invitation rows have useful
business identities and recovery states. Allocation, plan change, migration,
invitation, concurrency add-on, cancellation and restoration must all express
their intended configuration through one projection of existing records. Map
each desired current/future item to its authoritative existing fields and
writers. Webhooks must keep observed provider facts separate from that intent.
A complete replacement includes these GA writers even if a usage-pack UI is
staff-only, without adding a subscription table, fields or hidden coordination
state.

Plan purchase creation also cannot use `stripe_subscription_id` as an unchecked
reservation. The current webhook explicitly rejects replacing an active/trialing
binding with an incomplete subscription, billing management reads that binding,
and Stripe `default_incomplete` can immediately activate zero-cost/trial
subscriptions. Merely publishing a candidate ID before payment would change
those observable semantics without establishing common admission. The derived
subscription projection does not by itself solve duplicate payable purchases.
Additional implementation belongs to the same Release 1 wave before calling it
ready; this finding alone is not evidence that a third release is required.

## Verification boundary

New tests construct organizations/subscriptions through checkout and Stripe
webhook APIs, run concurrent checkout or invitation requests, and inspect
checkout responses, billing status and member credit balances through production
APIs. Lost customer responses are modeled at the Stripe boundary. No production
advisory lock, lock waiter, temporary trigger or artificial database gate is used.
Local full Vitest and local development servers are intentionally not run;
behavior execution belongs to the PR pipeline. The PR records exact formatting,
lint and type-check results separately from CI results.

The concurrent subscription webhook regression accepts a failed first delivery
only when the same original event is redelivered successfully. It then reads
billing status and runtime capacity, and replays the original paid invoice to
check that quantities, credits and effective capacity do not increase. The
separate `uses the live Stripe quantity for proration invoices` checkout test
retains the stronger mixed credit/debit proration case (invoice quantities 2 and
5, authoritative Stripe quantity 4); the duplicate proration setup is removed
from the concurrent-delivery case.

The two invitation-accepted tests are consolidated into concurrent payment and
acceptance coverage. Production credit and get-started APIs show no activation
before acceptance, one purchased/bonus balance after acceptance, and unchanged
balances after another acceptance delivery. The existing 100-credit inviter
reward remains asserted. The separate membership-created webhook test retains
its distinct entry point and exact two-grant/expiry assertions. The Atom Custom
quantity assertion and its authoritative Stripe period fixture remain intact.

The former stale-checkout concurrency test no longer installs a production
`billing_purchase` advisory lock, reads `pg_locks`, or waits for a blocked
transaction. Its hold/read/release fixture actions and all gate state are removed.
The replacement starts a real usage-pack Checkout API request, delays the Stripe
Session response, and runs reconciliation concurrently after the snapshot TTL.
It asserts that the Checkout URL remains resumable through the purchase API and
that the billing API still exposes the original tier and credit balance until
payment. This proves the user-visible outcome without claiming a particular
internal database interleaving. Separate expiration, replacement, and
post-creation cancellation tests retain their distinct behavior coverage.

Stale and provider-expired usage-pack Checkout retirement now executes in
`retireReconciledUsagePackSnapshot$`. The command owns its database, locks the
existing subscription roots before the existing pending-snapshot guard, checks
the stored count against the locked rows, and commits the conditional retirement,
allocation deactivation, and final count assignment together. It passes no
handle to the old pending-snapshot callback API or `retireUsagePackCheckout`.
Provider reads stay in the calling reconciliation command. An expired Session
observation only retires that exact still-unbound Session; a concurrent paid
subscription correlation cannot be undone by an older provider response.

The `billing_purchase` acquisition in that commit remains compatible with the
outgoing purchase writer; retirement does not establish admission for future
remote purchases. Other subscription lifecycle, invoice fulfillment, allocation,
and plan-change reconciliation still use the legacy database-aware service
interfaces and remain explicit Release 1 implementation work. The pending-count trigger was already retired by historical migration 1132;
this finite retirement change does not certify the full reconciliation caller
graph as complete.

### Cancellation changes during preview preparation

Plan preview publication compares the current cancellation state with the Stripe
subscription actually used to price the preview. A webhook catching up with that
same provider state does not invalidate an immediate upgrade: its quote already
has no next recurring payment. A different cancellation state still rejects the
prepared quote before retiring or inserting any intent. Binding, tier, price,
period, allocation and competing-intent checks remain in the owning transaction.

The combined-head API5 failures at `74a09e9` had two separate causes: the overly
strict comparison to the earlier local cancellation value, and a preview fixture
using the obsolete invoice-line `price` field instead of `pricing.price_details`.
Both are corrected without changing the expected 200/409 responses. Public API
checks retain the allocation and credit balance, reject stale package and Plan
quotes, and verify a fresh preview succeeds after cancellation. The final combined
pipeline must verify these fixes; source checks do not replace behavior checks.

### Migration materialization and completion ownership

Migration state reads and initial preview publication also own their finite SQL.
The state command loads the one open migration and only its selections, and
retires an expired preview conditionally. Eligibility, current Stripe
subscription reads, catalogue preparation and quote requests run outside that
transaction. Preview publication verifies the same organization, customer,
subscription, tier and non-ending source Plan before retiring a prior preview or
inserting the new business intent. A cancellation webhook during provider quote
preparation therefore returns a retryable conflict without publishing a stale
migration or changing credits. A fresh preview after the source Plan is restored
remains available.

The corresponding API regression creates the paid source Plan through signed
webhooks, changes cancellation through the real webhook endpoint while a quote
response is pending, and checks rejection, absent migration state and unchanged
billing balances. It then restores the source Plan and verifies a fresh preview.
It uses no database gate or implementation call-count assertion.

Revision preview and confirmation preparation also use owned commands. Their
local transaction reads the exact migration and its selections together; the
provider quote and invoice-line pagination run after commit. Revision intent
publication directly compares the prepared configuration and replaces only that
migration's selections in one local transaction. No handle is passed to a
selection helper. Remote schedule reconciliation and publication still contain
the legacy database-aware graph; these quote and intent changes do not resolve
the common remote writer protocol.

Migration confirmation admission, paid snapshot materialization and invitation
completion now execute their SQL in business-input commands that obtain
`writeDb$` internally. Materialization owns only the exact migration and its
corresponding subscription/allocation selection, rather than forwarding a
transaction into the organization-wide pending-snapshot callback. It inserts an
actual Stripe subscription status, never `purchase_pending` or `checkout_pending`,
so it does not change the existing pending count. It verifies the prepared
configuration and immutable selection identities under migration ownership before
publishing. Invitation completion performs invoice arithmetic before its local
transaction and checks that same prepared configuration before publishing its
payment-backed invitation records and completion state together.

The historical pending-count trigger was dropped by migration
`1132_retire_prepared_domain_triggers`; comments that still called it retained
are corrected. No migration or schema shape changes are introduced here.
The shared `usage_pack_billing` boundary remains as unfinished implementation:
remote schedule publication and other billing writers have not yet adopted
local desired-state writes and daily reconciliation. These command changes do
not implement that model or turn its missing implementation into a drain gate.
Each retained acquisition must be reassessed against payment and intent
ownership, not the superseded prohibition on temporary configuration drift.

Existing public billing migration tests retain paid materialization, revision,
invitation acceptance/refunds and original-event redelivery coverage. Local
verification is formatting, scoped lint and API types; behavior execution remains
with the sole PR's combined-head pipeline.

## Paid invoice cleanup after a newer binding

Legacy Plan and Atom invoice redelivery now checks whether the already-paid
invoice still owns the current Plan before authorizing replacement cleanup.
`last_processed_invoice_id` alone is insufficient: a later
`checkout.session.completed` or `customer.subscription.created` can bind a new
subscription before that purchase's paid invoice arrives. A legacy duplicate
must still match its tier and subscription ID; an Atom duplicate must still
match its tier, `atom_grant` status and unbound subscription state. Superseded
receipts are acknowledged without updating entitlements or canceling the new
subscription. Legitimate cleanup retries for the original current Plan remain.

The API regression establishes both legacy and Atom grants through signed
webhooks, binds a later purchase through Checkout completion, replays the
original paid event, delivers any provider cancellation notifications through
the webhook API, and verifies the later subscription and existing grant amounts
through billing. It does not inspect internal locks or database snapshots.
Focused lint and formatting pass; behavior verification belongs to the combined
HEAD pipeline.

This fixes the obsolete-receipt authorization case. Customer-wide replacement
discovery can still observe a newer payable subscription before that subscription
has any local binding, particularly for Atom grants. The common purchase and
replacement-identity protocol remains unfinished Release 1 implementation;
this local guard is not presented as a provider-side fence or a drain-only gate.

## Auto-recharge SQL ownership and stale cleanup

Recharge admission and failed-request cleanup now own their finite SQL in
commands that obtain `writeDb$`; plan eligibility is loaded through its owning
command. Stripe invoice creation, payment-method reads and payment remain
outside SQL, and no database handle escapes into a provider callback.

Cleanup uses the transient PostgreSQL row version returned by admission. A
failed older provider request cannot clear the pending recharge created after a
user disables and re-enables auto-recharge. If another wallet write has changed
the row, cleanup conservatively leaves the pending value; the existing
ten-minute stale-admission rule remains its recovery path. This does not add a
persisted field or claim that auto-recharge's existing remote-success/retry
window is solved.

The API regression disables and re-enables recharge while an earlier Stripe
response is delayed, then delivers every resulting paid invoice and a replay
through the signed webhook API. Billing must expose exactly one new grant and
the corresponding balance. Formatting and scoped lint pass; combined-head types
and behavior checks belong to the PR pipeline. Shared subscription projection
and ordinary Plan purchase admission remain unfinished Release 1 work.
