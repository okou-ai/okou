# Advisory lock cleanup: billing Release 1 preparation

This inventory is based on `5b458cc9` and the billing work integrated into the
single Release 1 PR #37313. It
tracks the seven billing acquisition definitions separately from transaction
propagation. It does **not** declare the whole billing package ready for
Release 2.

## Implemented protocols

### Stripe customer publication

`getOrCreateStripeCustomer$` now uses a stable Stripe idempotency key scoped to
the environment, preview routing identity, and organization. It inserts metadata
and its default entitlement in the owning command's transaction, or updates an
existing metadata row only while `stripe_customer_id IS NULL`. A losing
publication reads and returns the authoritative binding. Checkout never uses an
unpublished candidate ID. Existing entitlement rows and paid tiers are not
replaced by the default initialization.

The old customer advisory acquisition remains around the Stripe call for the
Release 1 API overlap: an outgoing writer has neither the provider idempotency
key nor the conditional database publication. Moving the remote call outside
this boundary while that writer can run would allow it to create another
customer and overwrite the winning binding.

After incompatible APIs have stopped serving, their requests have drained, and
all rollback targets contain this protocol, Release 2 can move customer
preparation outside the local database transaction and remove this advisory
call. No App or Runner contract changes. Stripe's finite idempotency retention
is not presented as a permanent remote operation log; a remote success followed
by a lost response beyond that retention remains the existing recovery window.

### Checkout completion publication

`completeCheckoutSession$` reads the existing metadata row before calling Stripe
and publishes the subscription binding only when that exact PostgreSQL row
snapshot still matches. A concurrent billing transition causes a pending response
and a fresh retry instead of overwriting its result. No transaction spans the
provider reads. This is a publication predicate, not the still-missing admission
protocol for two different purchases that can both become payable.

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
local publication. They do not establish ordering between remote cancellation,
restoration and schedule writers.

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
unfinished. This local ownership change does not solve remote quantity/schedule
ordering or the shared purchase-admission protocol.

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

This completes local conditional publication for these three entry points. It
does not fence already-issued Stripe updates or establish shared schedule
ordering; those remote guarantees remain part of the unresolved protocol below.

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

| Acquisition                                       | Release 1 result                                                                   | Why a retained boundary cannot yet be deleted                                                                                                            | Release 2 removal gate                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                           | Provider idempotency and conditional publication implemented; retained acquisition | Outgoing creation has no idempotency key and unconditionally overwrites the binding                                                                      | Verified API drain and compatible rollback targets; then move Stripe preparation outside the owning command's local commit                                                 |
| `billing_purchase:<org>`                          | Retained; replacement protocol is not complete in this PR                          | Stateless Plan previews have different purchase IDs; two creations can both become payable. Pending usage-pack snapshot writers also share this boundary | Complete a common creation/arbitration protocol for every Plan and usage-pack writer, then verify API drain and rollback compatibility                                     |
| `stripe_concurrency_subscription:<subscription>`  | Conditional projection protocol implemented; retained acquisition                  | Outgoing handlers publish unconditional projections; all new writers advance the existing timestamp and new reconciliation results use exact-value CAS   | Verify API drain and compatible rollback targets, then move provider reads outside the local commit; see the concurrency projection inventory                              |
| `usage_pack_billing:<org>` in allocation service  | Retained; replacement protocol is not complete in this PR                          | Allocation, migration, invitation activation/refund, and deferred schedule workflows issue absolute Stripe quantity/schedule updates                     | Demonstrate ordering and recovery across all existing operation identities, with remote work outside local commits; then verify mixed R1/R2 writers and rollback targets   |
| `usage_pack_billing:<org>` in plan-change service | Retained; replacement protocol is not complete in this PR                          | Plan changes and allocation changes share the same remote subscription and can overwrite each other's current or renewal quantities                      | Same common projection protocol as allocation; an independent per-change idempotency key is insufficient                                                                   |
| `usage_pack_invitation:<purchase>`                | Conditional claims and guarded result writes implemented; retained acquisition     | Outgoing purchase writers still read state and subsequently update by ID; activation/refund also enters the unresolved shared projection workflow        | Finish all purchase write/cleanup predicates and the shared projection protocol, remove transaction propagation, then verify outgoing API drain and rollback compatibility |
| `usage_pack_invitation_email:<org>:<email>`       | Removed                                                                            | Existing business unique index arbitrates both old and new writers                                                                                       | No additional release gate                                                                                                                                                 |

There are **six remaining billing acquisition definitions** after this PR. The
two `usage_pack_billing` definitions use the same key family and must be assessed
as one interacting protocol, not independent rollout islands.

## Transaction ownership inventory

This is a call-chain inventory, not a count of matching type signatures:

- **Customer:** the command owns the metadata insert/CAS and entitlement insert.
  `writeOrgMetadataWithDefaultPlanEntitlement(tx, ..., callback)` is removed from
  this path. The reused entitlement builder accepts ordinary values only.
  Stripe I/O remains inside the compatibility boundary described above.
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
- **Allocation and plan changes:** preview/claim/finalization, migration, pending
  snapshot, credit-grant and schedule helpers still accept transactions. Their
  Stripe calls, pagination and callback ownership must be separated from the
  actual bounded SQL commits. File overlap does not establish a merge order.
- **Invitation:** transaction propagation to `loadPurchase` and
  `supersedeCompetingPendingCheckout` is removed from the changed transitions.
  The latter helper is retired and its conditional arbitration SQL is local.
  `ensureAcceptedInvitationSnapshot(tx, ...)` is also removed; its recovery
  insert is local to acceptance. Allocation assignment and activation reject
  retired or reassigned rows. Remaining propagation includes `lockPurchase`,
  `lockUsagePackBillingOrg`, projection helpers and
  `createUsagePackCreditGrant`. Activation and refund projection still hold an
  outer transaction across Stripe. This is not terminal transaction ownership.

## Unresolved Release 1 work

Billing Release 1 preparation is **not complete**. The important unresolved
case is an absolute remote subscription update: operation A computes quantity
2, operation B computes and publishes quantity 3, and A's already-issued
request later writes 2. A database CAS after Stripe succeeds cannot undo that
remote effect, and different Stripe idempotency keys only deduplicate each
operation individually.

The [Stripe protocol evidence review](advisory-lock-release-1-stripe-protocol-evidence.md)
records the investigated item/schedule identity alternatives, verified provider
contracts, and remaining admission and recovery obligations. In particular,
Stripe permits replacing an unpaid pending update, and creating a schedule from
a subscription has no expected previous schedule identity. Neither primitive
alone establishes the common write protocol.

The current allocation, plan-change, migration and invitation rows have useful
business identities and recovery states, but this PR does not establish one
compatible ordering protocol across all of those writers. Concurrency add-on
change, cancellation and restoration also write the shared schedule; they do not
have persisted purchase/change identities and previously did not enter the
`usage_pack_billing` boundary. Their current random schedule idempotency keys are
not a cross-operation ordering protocol. A complete replacement must include
these GA writers even if a particular usage-pack UI is staff-only.

Plan purchase creation also cannot use `stripe_subscription_id` as an unchecked
reservation. The current webhook explicitly rejects replacing an active/trialing
binding with an incomplete subscription, billing management reads that binding,
and Stripe `default_incomplete` can immediately activate zero-cost/trial
subscriptions. Merely publishing a candidate ID before payment would change
those observable semantics without establishing common admission. It adds no persisted
field, coordination table or JSON marker to hide that gap. Additional
implementation belongs to the same Release 1 wave before calling it ready; this
finding alone is not evidence that a third release is required.

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
