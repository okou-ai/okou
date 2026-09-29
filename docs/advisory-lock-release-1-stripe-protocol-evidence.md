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

- [Error types](https://docs.stripe.com/api/errors) define `idempotency_error`
  as reuse of a key with a different **API endpoint and parameters**. A common
  key can therefore arbitrate competing creation endpoints, not just requests
  to one endpoint. This is stronger than separate operation-specific keys.
- [Advanced error handling](https://docs.stripe.com/error-low-level#server-errors)
  says a cached `500` is **indeterminate**, may have side effects, and may later
  produce objects/webhooks during Stripe's reconciliation. Changing to a new key
  is explicitly discouraged. A local read that still shows the old item set is
  not proof that the failed provider mutation cannot subsequently take effect.
- [Pending updates with schedules](https://docs.stripe.com/billing/subscriptions/pending-updates#subscription-schedules)
  states that a schedule phase change discards a pending update and voids its
  invoice. The schedule-update API has no `payment_behavior=pending_if_incomplete`
  option. Moving immediate upgrades directly to schedule updates must not grant
  unpaid service or silently remove supported payment-action behavior.

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

## Common idempotency key from the current item set

The stronger candidate uses the same key `K(I0)` for every writer observing the
same real subscription item IDs `I0`, regardless of its desired quantity. A
successful mutation replaces those items, so subsequent writers use `K(I1)`.
While payment is pending and `I0` remains unchanged, another writer's different
parameters are rejected instead of replacing the pending invoice. This part
addresses the ordinary two-writer race; it is not equivalent to unrelated
per-operation idempotency keys.

A complete implementation still has to resolve the following concrete cases:

1. **A deferred change need not replace current items.** Updating only a future
   schedule phase leaves `I0` unchanged. The same key then rejects the next
   legitimate different change, even after the first change succeeded. Reusing
   the current item set without an identity-advancement rule is not a usable
   succession protocol.
2. **Advancing items before a separate schedule write exposes a new key too
   early.** A replaces `I0` with `I1`, but its update of active schedule `S0` is
   delayed. B can use `K(I1)` and publish a newer phase on that same schedule.
   A's later schedule update can overwrite it. This is a static no-failure
   interleaving for the item-first variant. Binding subsequent writes to a
   retired schedule identity is still required.
3. **Advancing items last requires a recovery owner.** Applying the phase under
   `K(I0)` and then replacing the unchanged current items is a possible
   alternative, not disproven by the previous ordering. A crash between those
   steps leaves `I0` and the cached first request. Recovery must know the actual
   business operation and original request, determine its outcome, finish only
   that operation, and prevent another caller from interpreting an idempotent
   replay as ownership of a different intent. Current concurrency projection
   rows do not persist that immediate-operation identity or request. A fresh
   random key or an invented metadata claim is not the missing recovery rule.
4. **An unpaid pending update can expire without replacing items.** Stripe's
   documented expiry can be 23 hours. A canceled/expired invoice leaves `I0`,
   while `K(I0)` can still replay the original response or reject different
   parameters. Paying the same still-open invoice is ordinary recovery; a new
   legitimate change after expiry needs its own verified identity transition.
5. **Cached `500` and key eviction are different boundaries.** The provider's
   indeterminate-error contract rules out treating a cached error plus one
   unchanged-item read as a safe rollback. Separately, a reused key can execute
   again after eviction: item replacement can reject old item IDs only if the
   combined delete/add endpoint validates all missing old IDs before any side
   effect. Generic “validation before execution” documentation does not
   establish that endpoint-specific atomicity by itself. Schedule writes have
   no old-item parameter, so they additionally need a terminal schedule fence.

The API build config declares a 300-second maximum function duration, and
this checkout uses Stripe SDK 20.4.1's default 80-second HTTP timeout. Those facts
are relevant to request lifetime; this review does **not** invent a known API
request lasting 24 hours. They also do not prove provider-side cancellation or
bound later Stripe reconciliation after an indeterminate error. A final protocol
must state which recovery calls can replay old operations and how their captured
business identities remain valid.

These are implementation obligations for the common-key candidate, not a proof
that the agreed terminal state is impossible. Existing remote-success/local-
failure windows do not justify retaining a lock. A replacement must neither
silently impose a day-long billing freeze after a failed operation nor advance a
key from an unrelated timestamp. Charging a separate invoice before publishing
recurring state is another possible design, but preserving payment action,
discounts, tax, proration, refunds, and all existing callers has not been
implemented or validated. It is not treated as an approved business change.

## Ordinary Plan purchase admission

`confirmPlanPurchase$` currently checks Stripe subscriptions and the local
customer/source binding while holding the retained purchase boundary. Moving
those reads outside the transaction without a replacement lets two distinct
previews both create payable subscriptions. Their current idempotency keys
contain distinct `purchaseId` values.

The documented endpoint-and-parameters check permits a common key across
`subscriptions.create` and `checkout.sessions.create`; endpoint scope alone is
not a blocker. A common key based only on organization, customer, and source
subscription still needs a real next-purchase rule: those values may remain unchanged after a
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

## Replacing every schedule before initialization

A narrower candidate is valid to investigate and is not disproved merely by
Stripe requiring two requests. Each schedule writer releases the attached
schedule it observed, creates its own candidate with `from_subscription`, and
initializes only that exact candidate. A competing writer must release an
uninitialized candidate before creating its replacement; it must never adopt
that candidate and publish different phases through it. Once the candidate is
released, a late update to that terminal schedule cannot update its successor.
A local conditional publication before initialization must additionally reject
an intent whose business source changed during preparation.

This can close the earlier creation/initialization interleaving **among writers
that mutate only their captured schedule identities**. It is a prospective
protocol, not an implemented or provider-tested assertion. Creation conflict,
release conflict, uncertain creation, local publication failure and cleanup of
only an unreferenced candidate still need explicit outcomes. Recovery cannot
retrieve the subscription's current schedule and assume it owns that object.
Existing migration, allocation and Plan records have real schedule/operation
identities for parts of this recovery; concurrency currently stores the desired
scheduled quantity and time, but no schedule ID.

The remaining direct-payment edge is concrete. The current concurrency upgrade
branches in `billing-concurrency-subscription.service.ts` use a direct
subscription update with `payment_behavior=pending_if_incomplete`. Allocation
and Plan upgrades also support that payment-action contract. Stripe's
[pending-update documentation](https://docs.stripe.com/billing/subscriptions/pending-updates),
read again on September 29, permits pending updates on subscription and
subscription-item mutations, not schedule phase updates. It explicitly states:
“A schedule phase change discards a pending update and voids the associated
invoice.” Moving every immediate upgrade into a schedule phase update is
therefore not a demonstrated equivalent payment protocol.

Allowing the direct branch only after it reads an empty schedule is insufficient:

1. Direct writer D reads no attached schedule and prepares its immediate upgrade.
2. Schedule writer A creates candidate T from that same subscription.
3. D's delayed subscription mutation reaches Stripe while T is attached.

Both writers can have followed a read-before-mutate rule, but D now mutates an
object managed by another writer's schedule. Stripe's
[schedule guidance](https://docs.stripe.com/billing/subscriptions/subscription-schedules#subscription-updates-when-a-schedule-is-attached)
explicitly permits direct `items` changes to split an attached schedule phase,
and warns that direct changes can be overwritten by later phases. It does not
make D's earlier empty-schedule observation a provider precondition. The exact
acceptance of A's subsequently prepared old phase timestamps has not been
verified, so this note does not claim that every version of that payload is
accepted or that this precise overwrite was reproduced. It establishes the
missing exclusion step in the proposed common protocol.

A complete solution may pair terminal schedule identity with admission through
real business operations; the Plan/allocation/invitation admission preparation
in this PR is relevant to that direction. It must also cover concurrency's
direct unpaid upgrade, ordinary purchases and every recovery writer. Holding an
unchanging schedule solely as a mutex or repurposing paid slot/status fields as
a claim would not satisfy the terminal constraints. Cached-500 creation remains
subject to Stripe's indeterminate-response contract above; an empty schedule
read alone does not authorize abandoning that attempt and issuing a fresh key.
No speculative shared key, new coordination field or provider mutation was added
as part of this review.

Release itself also needs current business admission. An old local preview must
not fetch and release a newer operation's accepted schedule, then discover its
staleness only in a final database CAS: the release has already removed that
future change. The candidate must remain bound to its originally observed
schedule identity and pass the real-operation authority check before release.
This requirement does not refute terminal schedule identity; it identifies an
additional mutation boundary that the shared protocol must own.
