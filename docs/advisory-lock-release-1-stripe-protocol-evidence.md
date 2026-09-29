# Advisory lock cleanup: Stripe writer protocol evidence

This investigation covers the source at
`5ff7cf7d3447f05b134dd0cfbd97b9cb80fab8ca` and Stripe's published API contracts
read on September 29, 2026. It supplements the
[billing implementation inventory](advisory-lock-release-1-billing.md).
The common remote write protocol and cross-preview Plan purchase admission
remain **unfinished Release 1 implementation**. Neither is a gate that deployment
or outgoing-writer drain alone can satisfy. This note does not claim that a
solution under the terminal constraints is impossible.

## Writers that must share the protocol

| Writer                                                         | Current provider mutation                                                                                                                 | Existing business identity and remaining gap                                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allocation changes and invitation activation/refund            | `syncUsagePackProjection` updates absolute current/renewal quantities; `scheduleUsagePackAllocationChange` creates or rewrites a schedule | Allocation-change and invitation-purchase rows identify genuine operations, but operation-specific idempotency does not order competing projections                                                                          |
| Plan changes                                                   | `applyImmediateSubscriptionChange` uses `pending_if_incomplete`; deferred changes update all current/future phases                        | The root change and its existing `deferredSchedule` describe a real change, but other writers do not participate in the same admission or object-ownership protocol                                                          |
| Migration                                                      | Migration confirmation creates or updates a schedule                                                                                      | The migration has a persisted schedule ID and business state; this alone does not fence a concurrent allocation, invitation, or concurrency writer                                                                           |
| Concurrency increase, reduction, cancellation, and restoration | Both direct subscription updates and schedule create/update/release                                                                       | `org_concurrency_subscriptions` is a projection of Stripe state. It has no schedule ID or persisted immediate purchase identity. Its paid slot count and scheduled reduction fields cannot silently become an in-flight lock |
| Plan downgrade and restoration                                 | Both direct subscription updates and schedule create/update/release                                                                       | `org_metadata.pending_subscription_schedule_id` owns a real pending Plan change; it is not currently a general subscription mutation claim                                                                                   |
| Ordinary Plan purchase                                         | `subscriptions.create` or Checkout creation after a provider read                                                                         | Different signed previews have different purchase IDs. The source binding and tier check do not atomically arbitrate two provider creations                                                                                  |

The corresponding services are `usage-pack-allocation-change.service.ts`,
`usage-pack-plan-change.service.ts`,
`usage-pack-subscription-migration.service.ts`,
`billing-concurrency-subscription.service.ts`, `billing-downgrade.service.ts`,
`billing-restore.service.ts`, and `billing-checkout.service.ts`, under
`turbo/apps/api/src/signals/services/`. Reconciliation, webhook binding,
organization deletion, and member removal must respect the chosen ownership
rules too. A staff-only purchase surface does not make shared GA writers
optional.

## Provider contracts verified

- Stripe documents [deleting an old subscription item and adding a replacement
  in one subscription update](https://docs.stripe.com/billing/subscriptions/change-price#update-the-subscription).
  Its [separate item deletion endpoint](https://docs.stripe.com/api/subscription_items/delete)
  rejects an already-deleted item. These facts do not by themselves establish
  that a combined delete/add request atomically rejects a missing old item
  before every invoice or replacement side effect. That stronger condition
  still needs provider evidence before it becomes a correctness premise.
- [Pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates#canceling-changing)
  are replaceable: updating again with new values voids the prior pending
  invoice, creates another invoice, and replaces the pending update. Failed
  payment leaves the existing subscription unchanged. `pending_if_incomplete`
  therefore does not claim an old item exclusively while payment is pending.
  Changing to `error_if_incomplete` would remove supported payment-action
  behavior; it is not an equivalent implementation.
- [Creating a schedule with `from_subscription`](https://docs.stripe.com/api/subscription_schedules/create#create_subscription_schedule-from_subscription)
  copies the live subscription configuration. The request cannot include phase
  changes; Stripe requires a subsequent update. It accepts no expected previous
  schedule or item identity.
- [Releasing a schedule](https://docs.stripe.com/api/subscription_schedules/release)
  stops its remaining phases, leaves the subscription in place, and detaches
  it. Only an active or not-started schedule can be released. This provides a
  useful terminal identity boundary for that schedule, not for a later request
  addressed to the underlying subscription.
- [Schedule updates](https://docs.stripe.com/billing/subscriptions/subscription-schedules#update-subscription-schedules)
  replace the supplied current/future phase configuration. Phase items use
  prices and quantities, not the live subscription item ID. Stripe also warns
  that direct subscription changes can be overwritten by a later phase.
- [Idempotency](https://docs.stripe.com/api/idempotent_requests) replays one
  request, requires matching parameters for the same key, and permits key
  removal after at least 24 hours. Different operation keys do not order their
  requests; one permanent key cannot represent successive different purchases.

These findings came from public documentation and the installed Stripe SDK
types. No live Stripe mutation or test-mode purchase was performed. A local
provider fixture that implements the desired fence would not establish the
provider's actual contract.

## Why object identity still needs a complete protocol

Keeping a write bound to a captured schedule is a useful direction. If a newer
operation releases schedule `S1` and publishes `S2`, an older operation must
never fetch `S2` and apply its stale phases there. The same restriction applies
to cleanup: a losing candidate may only clean up its own unreferenced object.

Replacing schedules alone leaves this valid sequence to handle:

1. A prepares an intent while no schedule is attached, or after retiring its
   captured schedule. Its `from_subscription` creation has not completed.
2. B creates a schedule, completes a newer change, and a legitimate restore or
   schedule completion subsequently leaves the subscription without a schedule.
3. A's delayed creation now succeeds. Uniqueness of the currently attached
   schedule cannot distinguish this from the original empty state.
4. Updating A's new schedule with the old intent would overwrite the newer
   result. A local CAS only after that mutation is too late.

This is a static interleaving, not a claimed runtime reproduction. Capturing
`S0` does not prevent it because schedule creation has no `S0` precondition.

A candidate creation that merely copies current state could instead be
followed by a short conditional publication of its real schedule identity and
business intent **before** the mutating phase update. A failed publication would
retire only the unreferenced candidate. Such a design still has to establish
all of the following in code:

- Every writer can recover that exact published identity and its intended
  phases after an uncertain provider response or failed local commit.
- A newer operation retires the old identity before publishing its replacement,
  including restore, cancellation, natural completion, and deletion paths.
- A webhook cannot mistake a prepared schedule's unchanged provider state for
  evidence that the committed business intent should be discarded.
- Direct subscription writes and pending invoices participate too. An old
  item is still present after an unpaid pending update, and Stripe permits a
  later request to replace that pending invoice.
- Missing schedules or empty local bindings do not allow an old request to
  adopt a newer operation's identity and continue.

The existing allocation, Plan-change, migration, and invitation records offer
real business identities for parts of this design. This investigation has not
demonstrated a shared implementation for concurrency and ordinary Plan
purchases. Reinterpreting paid entitlement rows, inserting fictitious package
changes, or keeping a schedule solely as a mutex would not close that gap under
the agreed constraints.

## Ordinary Plan purchase admission

`confirmPlanPurchase$` currently checks Stripe subscriptions and the local
customer/source binding while holding the retained purchase boundary. Moving
those reads outside the transaction without a replacement lets two distinct
previews both create payable subscriptions. Their current idempotency keys
contain distinct `purchaseId` values.

A common key based only on organization, customer, and source subscription also
needs a real next-purchase rule: those values may remain unchanged after a
decline, cancellation, or expired attempt. Reusing the key with different
parameters is rejected; advancing it from an unrelated row update or arbitrary
time window permits another request while the first outcome is still unknown.

Publishing an unpaid candidate into `stripe_subscription_id` is not a neutral
reservation. The current webhook rejects replacing an active/trialing binding
with an incomplete subscription; management and entitlement readers consume
that binding; and zero-cost or trial creation may activate immediately. The
replacement must preserve those business behaviors and resolve uncertain
outcomes from authoritative provider state without creating a second payable
purchase.

## Completion evidence still required

The implementation must cover all rows in the writer table, preserve paid
entitlements and pending payment behavior, and use command-owned short SQL
transactions without passing handles. API tests must exercise competing
changes, stale work after restoration, failed payment followed by recovery,
and repeated original webhook events; assert resulting quantities, schedules,
and amounts through user-facing APIs. Provider-boundary fixtures should model
verified Stripe behavior, not invent conditional mutation guarantees.

Only after that common protocol exists can the retained advisory acquisitions
be classified solely as outgoing-writer compatibility. The two-release plan
remains unchanged; this unresolved implementation is part of Release 1.
