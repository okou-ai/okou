# Advisory lock cleanup: concurrency subscription projection

This Release 1 change starts from `5b458cc9`. It prepares the mutable
`org_concurrency_subscriptions` projection for coexistence with a Release 2
writer that no longer takes `stripe_concurrency_subscription:<subscription>`.
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
outside the transaction. Its bounded SQL transaction acquires the historical
advisory lock and conditionally publishes the prepared result. The one acquisition
definition and its two callers remain because outgoing webhooks still publish
unconditionally under that same key. An outgoing writer that acquired the lock
first invalidates R1's snapshot; an outgoing writer that acquires it later reads
Stripe after the R1 commit. R1 no longer keeps Stripe I/O inside that boundary.

Other legacy billing preparation and reconciliation paths still pass ordinary
writable databases or transactions to services, including invoice organization
binding, plan and allowance projection, missing-subscription reconciliation,
and cron discovery. They are unfinished ownership work; the two command-local
projection commits do not establish full billing conformance.

Release 2 removal requires evidence that pre-R1 API instances no longer serve,
their in-flight requests have drained, and every retained rollback target has
the conditional protocol. Release 2 then removes the acquisition and its pure
SQL builder. R1 and R2 can overlap: either writer's publication invalidates the
other's older snapshot, and a stale result retries instead of overwriting.
No App/Runner contract, client floor, or Runner drain is introduced.

This change adds no advisory acquisition and removes none; the combined billing
wave still has six definitions after removal of the invitation-email acquisition. The shared usage-pack
allocation/Plan/migration/invitation absolute Stripe writes need separate
ordering and recovery work. Conditional local cache publication does not solve
remote quantity overwrite ordering.

## Verification

The API tests now provide authoritative Stripe subscription responses for
invoice and update deliveries. A new public-webhook/status test sends stale
same-quantity cancellation events repeatedly at one fixed application clock
and checks that cancellation remains visible. The existing proration test
uses concurrent public event deliveries and status assertions; its artificial
provider gate and advisory serialization assertion are removed. Other coverage
for proration quantities, deletion, shared Plan/allowance subscriptions and
runtime concurrency limits remains.

Local full Vitest and development servers are not run. The PR records type,
format and lint validation, and the PR pipeline executes behavioral tests.
