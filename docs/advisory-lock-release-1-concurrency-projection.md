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
previous value plus one microsecond. Same-clock writes, clock skew, and a
change back to the previous visible state therefore still invalidate an
older read. There is no additional field, table, persisted token, or JSON
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
does not erase historical payment evidence.

## Transaction ownership and rollout

The propagated `upsertConcurrencySubscriptionState(tx, ...)` interface is
removed. Its insert/update SQL and the associated immutable entitlement
inserts are owned by the reconciliation transaction. The reused timestamp
builder is pure SQL construction and receives only a `Date`. The scheduled
change write is also inlined in `changeConcurrencySubscription$`; it no longer
passes the writable database into a write helper. Remaining ordinary database
service arguments are inventoried as unfinished ownership work, not terminal
command-local SQL.

The one historical advisory acquisition definition and its two callers remain
in Release 1. Outgoing webhook writers publish by subscription ID without
checking which local state they read. The legacy lock and the provider-read
transaction boundary keep those outgoing reads serialized with R1 publication.
The lock helper's transaction parameter exists only for that temporary boundary.

Release 2 removal requires evidence that pre-R1 API instances no longer serve,
their in-flight requests have drained, and every retained rollback target has
the conditional protocol. Release 2 then removes the acquisition/helper and
moves the provider read between the initial snapshot read and the bounded SQL
commit. R1 and R2 can overlap: an R2 commit invalidates an R1 result that was
waiting on Stripe; an R1 commit likewise invalidates an R2 snapshot. Neither
writer can overwrite the other's completed publication from an older read.
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
