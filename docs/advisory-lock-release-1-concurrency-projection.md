# Advisory lock cleanup: concurrency subscription projection

After `4f263928`, Release 1 deletes `stripe_concurrency_subscription:<subscription>`
and both acquisitions. The mutable `org_concurrency_subscriptions` projection
uses conditional publication and daily provider-observation repair. See the
[current per-key inventory](./advisory-lock-release-1-key-retirement.md).
It accompanies [customer and invitation preparation](advisory-lock-release-1-billing.md)
in the single Release 1 PR #37313. Organization purchase and shared usage-pack
projection work are not complete.

## Conditional publication

Webhook reconciliation reads the existing `updated_at` before requesting
Stripe state, then publishes only while that exact database value still
matches. Initial publication uses the subscription primary key with
`ON CONFLICT DO NOTHING`. Losing publication fails the webhook delivery so
Stripe retries against current state; related invoice entitlement inserts
roll back in the same local transaction. It never reports a discarded result
as successful reconciliation.

The timestamp is read as PostgreSQL text and compared back as `timestamp`.
Converting it through JavaScript `Date` would truncate microseconds and make
valid comparisons fail. Every production writer advances the existing
modification timestamp using the greater of the application time and its
previous value plus one microsecond. The snapshot also compares PostgreSQL's
existing `xmin` system value, so outgoing writers that do not yet advance the
timestamp cannot evade the guard through same-clock updates. `xmin` is held
only in memory for this finite provider read and publication; it is not stored
or used as a lasting business version. A committed delete/reinsert has a new
row version too. Intermediate updates within one uncommitted legacy transaction
are not visible to this command's snapshot. Same-clock writes, clock skew and
changes back to an earlier visible state still invalidate an older read. There is no additional field, table, persisted token, or JSON
coordination value.

The writer inventory includes invoice and subscription webhooks, subscription
deletion, scheduled concurrency changes, cancellation/restoration, Plan-end
cleanup, and all billing-reconciliation outcomes. Cron reads the same exact
timestamp with its candidate and guards its provider-result publication.
An intervening payment recovery or renewed period cannot be overwritten by
an older cron candidate merely because both states are `past_due`.

A webhook always retrieves current Stripe state. Equal quantities do not
prove that a cancellation flag, period, schedule or payment status is current.
Likewise, a delayed first paid invoice is immutable payment evidence, not an
authoritative current subscription snapshot. Missing Stripe subscriptions or
removed concurrency items retire an existing projection conditionally; they
do not revive it from the old invoice/event. Immutable invoice-line grant
identities remain unchanged, and a valid paid line is still recorded when the
renewable subscription has since disappeared. Current subscription retirement
does not erase historical payment evidence. A delayed first paid invoice whose
subscription is already absent records a canceled projection using its real
historical price and quantity. The existing primary key then also arbitrates
competing first publication; an absent-row no-op could otherwise let an earlier
provider response insert an active projection afterward. An invoice without any
valid line and without an existing projection still creates no projection.

## Transaction ownership and rollout

The propagated `upsertConcurrencySubscriptionState(tx, ...)` interface is
removed. Invoice and subscription projection commands now accept business data,
obtain `writeDb$` themselves, and execute their finite SQL directly. Neither the
database nor transaction is passed to another function from these publication
commands. The reused timestamp and compatibility-lock builders construct SQL
from ordinary values only. Invoice/update dispatch and cron snapshot replay use
named commands; the scheduled change write is inlined in
`changeConcurrencySubscription$`.

Each publication reads its exact local snapshot and then retrieves Stripe
outside the transaction. Its bounded SQL transaction conditionally publishes
the prepared result without an advisory acquisition. An intervening old or new
committed write invalidates R1's snapshot.

The outgoing `handleConcurrencySubscriptionUpdated` can use an equal-quantity
incoming event directly instead of retrieving Stripe, so a later old event can
still replace a newer observation. The old key did not prevent that overwrite.
Live observations now receive a daily visit through the hourly billing cron's
24 stable hash buckets; scoped reconciliation visits every live identity in its
organizations. A CAS conflict is left to a subsequent scheduled visit. Existing
expired payment-failure candidates continue to receive hourly treatment. Repair
never creates or pays an invoice, creates a subscription or grants credits.
Provider unavailability is not a hard 24-hour recovery SLA.

Database-handle propagation is not an R1 acceptance target. The remaining
billing configuration and financial work is still R1 implementation work.
There is no remaining R2 advisory deletion for this projection. Prepared
R1/R2 publishers invalidate each other's earlier snapshots; external webhook
redelivery or a later cron visit handles rejection, not an in-process retry.
No App/Runner contract, client floor, or Runner drain is introduced.

This change removes one advisory definition and two acquisitions. The shared usage-pack
allocation/Plan/migration/invitation writers still need the approved local
desired-state publication and daily Stripe reconciliation. Temporary remote
quantity drift is accepted. This conditional provider-fact cache is not the
authoritative desired configuration; webhooks must not overwrite that intent.
Repeated reconciliation must preserve payment actions and avoid duplicate
charges or unpaid entitlement.

## Verification

The API tests now provide authoritative Stripe subscription responses for
invoice and update deliveries. A public-webhook/status test sends stale
same-quantity cancellation events repeatedly at one fixed application clock
and checks that cancellation remains visible. The new scoped reconciliation
test omits the update webhook, repairs a live cancellation observation twice,
and checks unchanged credits and no new subscription, invoice or payment. The existing proration test
uses concurrent public event deliveries and status assertions; its artificial
provider gate and advisory serialization assertion are removed. Other coverage
for proration quantities, deletion, shared Plan/allowance subscriptions and
runtime concurrency limits remains.

Local full Vitest and development servers are not run. The PR records type,
format and lint validation, and the PR pipeline executes behavioral tests.
