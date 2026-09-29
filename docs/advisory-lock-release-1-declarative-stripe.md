# Release 1 declarative Stripe implementation mapping

This mapping follows Ethan's final September 29 decision in `bba5c515`, which
withdraws the briefly proposed subscription-table exception. The canonical
[terminal contract](advisory-lock-terminal-state.md) is authoritative. Source was
checked at `c036a6f`. **No new table, persisted field or JSON coordination state
is proposed here.** Only the usage pack slice below is implemented; this
mapping does not declare R1 ready.

The earlier requirement to prevent every late quantity or schedule overwrite is
withdrawn. A successful later synchronization may repair 3 → 2 back to the
latest intended 3. Schedule replacement, shared item idempotency keys and remote
fencing are no longer prerequisites. Purchase duplication and issued invoices
remain different: configuration repair cannot reverse an extra charge.

## Implementation status

Implemented for member usage packs (`usage-pack-allocation-change.service.ts`):

- `loadUsagePackConfigurationSource$` reads the subscription, its allocations,
  open allocation changes, in-flight Plan changes and open migrations without a
  transaction. `desiredUsagePackConfiguration` is a pure function of those rows:
  current packages from projected allocation statuses, renewal packages after
  already `scheduled` changes. Previewed quotes do not participate.
- `syncUsagePackSubscriptionConfiguration$(usagePackSubscriptionId, signal?)`
  carries only the identity, reloads that projection, reads Stripe and repairs
  current items or the current/renewal schedule phases with
  `proration_behavior: "none"` and no idempotency key, so a repeated repair of
  the same drift is never suppressed. It defers, rather than overwrites, when an
  allocation or Plan change is `applying`/`pending_payment`, a migration is open,
  Stripe reports `pending_update`, the renewal phase carries a different Plan,
  or the schedule has more than one future phase.
- Invitation activation and refund removal commit local rows first and call the
  sync after commit. A failed sync no longer blocks acceptance or grants.
- `syncUsagePackSubscriptionConfigurations$` runs in the hourly billing cron and
  visits one of 24 stable `hashtext(id)` buckets, so each active subscription
  is compared daily without a cursor, dirty flag or new column. Scoped
  reconciliation visits every subscription of the requested organizations.
- API tests: a lost Stripe response after acceptance keeps the accepted state
  and grants, and reconciliation repairs quantity 1 → 2 once; a late stale
  quantity is repaired without a new invoice or payment; a second reconciliation
  over a converged subscription makes no update.
- Member change and addition quotes first request the same identity-only sync,
  so a stale late quantity is repaired instead of blocking the quote; an API
  test covers 2 → 1 repair before a 50 USD change preview with no invoice.

- Immediate member removal writes absolute quantities from local allocations
  and no longer rejects temporary drift; only a Stripe `pending_update` still
  blocks it. The API removal test starts from a stale quantity 3 and converges
  to 1.

Still unimplemented: change confirmation, the last-member deferred removal and
the expired or deferred change reconcilers still validate Stripe against local
quantities and throw on drift that the sync could not repair (for example,
while a payment is in flight). Plan, migration, legacy Plan and concurrency writers,
cancellation/restore ownership, webhook intent preservation, ordinary initial
purchase admission and immediate unpaid concurrency identity remain as mapped
below.

## Existing sources of each projected fact

`loadDesiredOrgSubscription$(orgId, signal?)` must return an ordinary computed
object from the existing business records below. Mutation-time synchronization
and daily reconciliation use this same projection; neither accepts an old patch
or captured quantity map from its caller.

| Computed fact                                          | Existing authoritative inputs                                                                                                                                                                                         | Current writer / ownership change required                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Organization, Customer and actual subscription binding | `org_metadata.org_id`, `stripe_customer_id`, `stripe_subscription_id`; for member packs, `usage_pack_subscriptions.id`, `org_id`, `stripe_customer_id`, `stripe_subscription_id`                                      | Keep binding authority in customer/Checkout/paid-subscription commands. A stale webhook may record the old subscription's invoice, but cannot replace an unrelated newer binding. A missing binding is not authorization to create a second payable subscription.                                                                                                  |
| Current member-pack Plan identity                      | `usage_pack_subscriptions.tier`, `stripe_plan_price_id`, plus successful `usage_pack_subscription_changes` and actual invoice fulfillment                                                                             | `usage-pack-subscription.service.ts` and `usage-pack-plan-change.service.ts` already own real business roots. Current paid state cannot advance from a desired unpaid target alone.                                                                                                                                                                                |
| Current recurring member package quantities            | Group `usage_pack_allocations.stripe_price_id` by the accepted active allocation set and current period; exclude inactive, unpaid and unaccepted invitation allocations                                               | `usage-pack-allocation-change.service.ts` and invitation activation/removal must commit their allocation transitions before requesting identity-only sync. Reuse the existing projection selection rules rather than counting every non-inactive row.                                                                                                              |
| Next-period member package quantities                  | Current allocations plus `usage_pack_allocation_changes` with their actual `kind`, source/replacement identities, target price, `status` and `effective_at`; include child changes owned by a Plan change             | Downgrade/removal and confirmed future changes are intent; an unconfirmed `previewed` quote is not. Use the shared existing effective-date and allocation-owner rules. Do not replay old `deferredSchedule.params` as authoritative quantities.                                                                                                                    |
| Pending immediate Plan/package payment                 | `usage_pack_subscription_changes` / `usage_pack_allocation_changes`: accepted change UUID, status, quote amounts/currency, proration timestamp, invoice ID and pending-update expiry                                  | These are actual commercial operations. Their owning confirmation and invoice commands resume the exact payment. A `pending_payment` target is not a free configuration repair or spendable entitlement.                                                                                                                                                           |
| Legacy-to-pack next-period migration                   | `usage_pack_subscription_migrations`: source/target tier, Plan price, source subscription/customer, status, effective date; `usage_pack_subscription_migration_selections`: accepted beneficiaries and package prices | Initial/revision confirmation commits the business intent first. `previewed` is not accepted. Only the proper paid renewal activates spendable allocations. Its existing schedule ID is a provider result, not the source of intended quantities.                                                                                                                  |
| Invitation addition/removal                            | `usage_pack_invitation_purchases`: payment/acceptance/refund states, exact allocation ID, current period, accepted user and amount facts; corresponding allocations                                                   | `activateAcceptedPurchase$` and `removeRefundedInvitationProjection$` update local business rows in their own transaction, then sync by org ID. Payment before membership acceptance remains inactive. Refund replay cannot remove somebody else's allocation.                                                                                                     |
| Future legacy Plan downgrade                           | `org_metadata.pending_subscription_target_tier` and `pending_subscription_change_at`; existing schedule ID only binds its provider result                                                                             | `downgradeSubscription$` must publish accepted target/time before provider preparation. Audit all readers that currently treat a null `pending_subscription_schedule_id` as no change: a not-yet-created schedule must not erase accepted intent. No new field is necessary for this target/time fact.                                                             |
| Cancellation / restoration                             | Existing `org_metadata.cancel_at_period_end`, current paid period end, pending target/time; corresponding fields on `usage_pack_subscriptions`                                                                        | Make the accepted cancellation/restore command the owner of intent. Current webhook writers also copy these flags from Stripe; they must stop overwriting a newer local choice. Actual paid period/status remains separately evidenced by invoices and entitlement records. Do not reinterpret paid expiry as cancellation intent.                                 |
| Future concurrency reduction                           | `org_concurrency_subscriptions.scheduled_slots`, `scheduled_change_at` and actual bound subscription ID                                                                                                               | `changeConcurrencySubscription$` currently publishes these only after Stripe. Publish accepted future target/time in the command-local commit first; webhook/cron projection must preserve this user-owned intent. All supported writers need this ownership rule in R1.                                                                                           |
| Current paid concurrency                               | `org_concurrency_subscriptions.slots`, status/period and invoice-backed `org_concurrency_entitlements`                                                                                                                | These are observed/paid-service facts. They must not be overwritten with an unpaid requested increase. The intended current quantity after a completed paid change can use its paid business result; existing readers still require their paid/period validation.                                                                                                  |
| Immediate unpaid concurrency increase                  | The current HTTP request and Stripe pending update/invoice; there is no equivalent local persisted concurrency change snapshot                                                                                        | `addStripeConcurrencySubscriptionItem$` and immediate change use `pending_if_incomplete` / `always_invoice`. Identify a genuine existing durable payment identity before making this a resumable local intent. Neither paid `slots` nor future `scheduled_slots` may be silently repurposed as an unpaid purchase claim. This specific mapping remains unresolved. |
| Ordinary initial legacy Plan purchase                  | Signed preview `purchaseId`; existing org binding and provider metadata, but no committed local purchase snapshot before creation                                                                                     | `confirmPlanPurchase$` and Checkout must share admission that survives different valid preview IDs and uncertain provider creation. Their current provider read plus per-preview key does not do this. This remains a purchase-admission gap, not a quantity-ordering gap.                                                                                         |

The projection may contain several actual subscriptions for grandfathered
standalone concurrency contracts. Do not consolidate them into a new payable
subscription as a side effect of reconciliation. New concurrency purchase
currently adds an item to the primary Plan subscription; preserve that shape.

Existing paid invoice receipts, credit grants/refunds and membership ownership
remain the financial authority. Do not store a second desired configuration,
pretend that a paid slot row is an unpaid request, create sham package changes,
or add a new JSON status to bypass a missing mapping.

## Command graph to implement

1. The accepting business command prepares provider quotes outside SQL, obtains
   `writeDb$` internally, and commits only the relevant existing local records.
   Its transaction has finite direct SQL and no forwarded `db`/`tx` or Stripe
   request. It returns committed ordinary business results.
2. `loadDesiredOrgSubscription$` reads the actual organization/subscription and
   relevant accepted current/future records. Page large member sets outside a
   transaction; select a consistent source with existing predicates and retry
   if the business inputs changed. Do not claim a whole-organization unbounded
   transaction is short merely because no handle escapes.
3. A pure projection derives the current/future Plan, package and concurrency
   items, their effective dates, cancellation intent and real pending payment
   boundaries. It receives ordinary values only, not an executor or store.
4. `syncOrgSubscriptionConfiguration$(orgId, signal?)` reloads that projection,
   reads Stripe and applies its differences outside transactions. Retry by
   reloading identity, never by replaying a captured imperative mutation.
5. The daily sweep pages actual org/subscription identities and invokes the same
   command. It includes changes whose immediate sync never ran; no dirty flag,
   applied revision, new queue or coordination table is required.

`syncUsagePackProjection`, its invitation callers, Plan deferred schedule
helpers, migration synchronization, concurrency change/cancel/restore and Plan
downgrade/restore must converge on this graph. Realtime publication occurs after
local commits. Existing `cron-billing-entitlements.service.ts` can host the daily
sweep, while retaining separate bounded invoice discovery and paid fulfillment.
A daily attempt is not a hard 24-hour recovery guarantee during Stripe failure.

## Configuration repair versus financial operations

Configuration repair compares complete current/future business projections and
uses no-proration updates. Preserve unrelated prices, discounts, tax behavior
and billing anchors. It must not create/pay an invoice, issue a refund, grant
credits or create another subscription merely because a quantity differs.
Repeating a repair may change Stripe again after stale work; it must not charge
for the same accepted operation again.

A genuine paid change retains its own existing purchase/change/invoice identity,
accepted quote and payment-action behavior. Resume `pending_if_incomplete`
through that financial workflow, not an unconditional schedule phase update.
Stripe documents that a phase change can discard a pending update and void its
invoice. A fresh observed pending payment is therefore a reason to defer an
unrelated configuration repair, not to replace that customer's invoice.

Already-in-flight repair work can still intersect payment work. Recovery must
read the authoritative invoice: a paid receipt remains a money fact even if
later provider configuration is wrong; an unpaid voided invoice is not a grant
or permission to charge again. Test the actual payment-action URL/status and
subsequent paid outcome. This does not reinstate global ordering of harmless
configuration drift.

Current Plan/allocation/invitation/migration roots provide genuine financial
identities to retain. Ordinary initial Plan purchase and immediate concurrency
require the specific missing identity/admission mapping above. Do not describe
those unfinished implementations as waiting only for outgoing-writer drain.

## Issued-invoice boundary

`proration_behavior: 'none'` prevents a repair request itself from creating a
new proration charge. It does not undo an automatic renewal invoice created
while Stripe was stale. A late quantity 2 can survive until invoicing even if
local accepted business records project 3; later synchronization does not
rewrite the issued invoice.

`prepareUsagePackPriceCredits` and `prepareUsagePackFulfillment` in
`usage-pack-subscription.service.ts` validate invoice price, quantity, amount,
currency and period. A quantity mismatch error detects this condition; it does
not refund an overcharge or authorize collection of an undercharge.
`usage_pack_credit_refunds` models refunds of unspent member grants, not an
arbitrary invoice-correction system. Do not repurpose it without preserving its
actual source/amount contract.

The remaining implementation must show how the existing financial workflow
handles a renewal crossing a stale-provider interval. Preserve authorization
for the actual invoiced period, exact paid receipts and deduplication. Do not
auto-charge an unquoted catch-up amount, silently grant a larger package against
a smaller paid invoice, or claim daily configuration convergence fixes money.
This is a concrete financial coverage requirement, not a reason to keep a
schedule-identity fence for every ordinary configuration write.

## Two-release ownership and activation

R1 implements all mapped intent writers, the shared projection, identity-only
sync, daily sweep and financial safeguards. R2 removes only the specific
remaining outgoing compatibility boundaries. Missing code cannot be delegated
to a drain or treated as an extra third release.

The difficult compatibility fact is ownership, not harmless Stripe drift:
pre-R1 webhook/cron writers can still replace cancellation, future Plan or
concurrency fields with observed provider values, and some outgoing commands
publish accepted intent only after provider mutation. An outgoing completed
user choice is not automatically stale work that the new reconciler may erase.

One activation approach to evaluate is for all R1 code to contain both the
legacy compatibility behavior and the final explicit writer ownership, while
desired-driven background correction remains inactive until the incompatible
serving, in-flight and rollback writers retire. The transition must preserve
accepted legacy choices and switch every remaining R1/R2 participant to the same
projection and webhook ownership before correction starts. This is a possible
boundary inside the existing two releases, not a third application release.

A brief billing-admission pause could help establish that boundary, but this
document does not implement, validate or authorize such a production pause.
First investigate the existing source records and deployment configuration for
a compatible transition without an additional product availability tradeoff.
A per-user UI flag cannot switch shared Stripe writers, webhooks and cron.
Proving compatible existing-writer capture could remove the activation concern;
a blind Stripe snapshot import or delayed webhook overwrite is not that proof.
Do not use arbitrary wait time, main merge time, Runner drain or a new persisted
coordination marker as activation evidence. The concrete transition is still
implementation work, rather than a proven drain-only gate.

## API acceptance cases

- Different valid initial previews converge on one payable subscription or
  Checkout identity, including lost-response, trial and payment-action cases.
- A late configuration sync writes 2 after 3; a later identity-only sync repairs
  to 3 without an extra proration invoice, credit grant or refund.
- Current/next Plan, package and concurrency changes compose without losing
  another accepted dimension. Cancellation/restore and a delayed webhook do
  not overwrite the latest committed local choice.
- Pending and failed upgrade payment remains recoverable; repeated actual paid
  events grant once and stale work never gives unpaid entitlement.
- Invitation payment before acceptance remains inactive; acceptance and refund
  replays preserve exact balances and recurring quantities.
- A stale-provider renewal exercises the real paid-invoice validation/recovery
  path, rather than only checking a later quantity repair.
- The daily sweep recovers work whose immediate synchronization never ran.

Use provider HTTP boundaries and public billing APIs. Do not add lock waiters,
internal gates, temporary triggers or exact incidental provider-call counts.
