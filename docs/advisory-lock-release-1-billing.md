# Advisory lock cleanup: billing Release 1 preparation

This inventory is based on `5b458cc9` and the billing changes in this PR. It
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

### Invitation purchase transitions

The invitation-creation, refund, and acceptance-activation claims use conditional
`UPDATE ... RETURNING` over their existing business states. Recovery also checks
the existing stale-work timestamp. Refund result publication matches the actual
`refund_attempt`, so an older failed or pending result cannot reopen a completed
or newer refund. A Clerk read-limit response only releases the claim whose
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

| Acquisition                                       | Release 1 result                                                                   | Why a retained boundary cannot yet be deleted                                                                                                                                                               | Release 2 removal gate                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe_customer_<org>`                           | Provider idempotency and conditional publication implemented; retained acquisition | Outgoing creation has no idempotency key and unconditionally overwrites the binding                                                                                                                         | Verified API drain and compatible rollback targets; then move Stripe preparation outside the owning command's local commit                                                 |
| `billing_purchase:<org>`                          | Retained; replacement protocol is not complete in this PR                          | Stateless Plan previews have different purchase IDs; two creations can both become payable. Pending usage-pack snapshot writers also share this boundary                                                    | Complete a common creation/arbitration protocol for every Plan and usage-pack writer, then verify API drain and rollback compatibility                                     |
| `stripe_concurrency_subscription:<subscription>`  | Retained; replacement protocol is not complete in this PR                          | Both invoice and subscription-update handlers reread Stripe under this lock and publish mutable subscription projections; deletion and other concurrency writers also require a complete stale-result audit | All projection writers must reject stale provider results without relying on this lock, then verify API drain and rollback compatibility                                   |
| `usage_pack_billing:<org>` in allocation service  | Retained; replacement protocol is not complete in this PR                          | Allocation, migration, invitation activation/refund, and deferred schedule workflows issue absolute Stripe quantity/schedule updates                                                                        | Demonstrate ordering and recovery across all existing operation identities, with remote work outside local commits; then verify mixed R1/R2 writers and rollback targets   |
| `usage_pack_billing:<org>` in plan-change service | Retained; replacement protocol is not complete in this PR                          | Plan changes and allocation changes share the same remote subscription and can overwrite each other's current or renewal quantities                                                                         | Same common projection protocol as allocation; an independent per-change idempotency key is insufficient                                                                   |
| `usage_pack_invitation:<purchase>`                | Conditional claims and guarded result writes implemented; retained acquisition     | Outgoing purchase writers still read state and subsequently update by ID; activation/refund also enters the unresolved shared projection workflow                                                           | Finish all purchase write/cleanup predicates and the shared projection protocol, remove transaction propagation, then verify outgoing API drain and rollback compatibility |
| `usage_pack_invitation_email:<org>:<email>`       | Removed                                                                            | Existing business unique index arbitrates both old and new writers                                                                                                                                          | No additional release gate                                                                                                                                                 |

There are **six remaining billing acquisition definitions** after this PR. The
two `usage_pack_billing` definitions use the same key family and must be assessed
as one interacting protocol, not independent rollout islands.

## Transaction ownership inventory

This is a call-chain inventory, not a count of matching type signatures:

- **Customer:** the command owns the metadata insert/CAS and entitlement insert.
  `writeOrgMetadataWithDefaultPlanEntitlement(tx, ..., callback)` is removed from
  this path. The reused entitlement builder accepts ordinary values only.
  Stripe I/O remains inside the compatibility boundary described above.
- **Purchase admission:** `confirmPlanPurchase$` still delegates a transaction to
  `confirmPlanPurchaseTransaction`; `writeUsagePackPendingSnapshots` still owns
  a transaction-aware callback and propagates it to snapshot guard helpers.
  These interfaces and their remote purchase work require implementation, not
  just lock deletion.
- **Concurrency subscription projection:** the webhook handlers still pass a
  transaction to the lock and projection helpers. Stripe retrieval inside the
  transaction remains unresolved.
- **Allocation and plan changes:** preview/claim/finalization, migration, pending
  snapshot, credit-grant and schedule helpers still accept transactions. Their
  Stripe calls, pagination and callback ownership must be separated from the
  actual bounded SQL commits. File overlap does not establish a merge order.
- **Invitation:** transaction propagation to `loadPurchase` and
  `supersedeCompetingPendingCheckout` is removed from the changed transitions.
  The latter helper is retired and its conditional arbitration SQL is local.
  Remaining propagation includes `lockPurchase`, `lockUsagePackBillingOrg`,
  `ensureAcceptedInvitationSnapshot`, projection helpers and
  `createUsagePackCreditGrant`. Activation and refund projection still hold an
  outer transaction across Stripe. This is not terminal transaction ownership.

## Unresolved Release 1 work

Billing Release 1 preparation is **not complete**. The important unresolved
case is an absolute remote subscription update: operation A computes quantity
2, operation B computes and publishes quantity 3, and A's already-issued
request later writes 2. A database CAS after Stripe succeeds cannot undo that
remote effect, and different Stripe idempotency keys only deduplicate each
operation individually.

The current allocation, plan-change, migration and invitation rows have useful
business identities and recovery states, but this PR does not establish one
compatible ordering protocol across all of those writers. It adds no persisted
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
