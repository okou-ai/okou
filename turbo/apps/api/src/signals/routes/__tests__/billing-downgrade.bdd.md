# billing-downgrade

## billing-downgrade-001

- Vitest: "POST /api/billing/downgrade > returns 503 when STRIPE_SECRET_KEY is not configured"
- Mode: run
- Given: Stripe billing is not configured (no Stripe secret key), and the caller sends no authentication.
- When: The caller requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`.
- Then: The API responds with HTTP 503 and the error `{ message: "Billing not configured", code: "PROVIDER_UNAVAILABLE" }`.

## billing-downgrade-002

- Vitest: "POST /api/billing/downgrade > returns 401 when not authenticated"
- Mode: run
- Given: Billing is configured with Pro and Team prices, and the caller sends no authorization header.
- When: The caller requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`.
- Then: The API responds with HTTP 401.

## billing-downgrade-003

- Vitest: "POST /api/billing/downgrade > returns 403 for non-admin org member"
- Mode: run
- Given: A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`.
- Then: The API responds with HTTP 403 and the error `{ message: "Only org admins can manage billing", code: "FORBIDDEN" }`.

## billing-downgrade-004

- Vitest: "POST /api/billing/downgrade > returns 409 when org has no subscription"
- Mode: run
- Given: A signed-in org admin belongs to an organization with no Stripe subscription.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`.
- Then: The API responds with HTTP 409 and the error `{ message: "Org has no active subscription", code: "CONFLICT" }`.

## billing-downgrade-005

- Vitest: "POST /api/billing/downgrade > returns 400 when target tier is same or higher"
- Mode: run
- Given: A signed-in org admin's organization has an active Pro subscription.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`.
- Then: The API responds with HTTP 400 and the error `{ message: "Cannot downgrade from pro to pro: target tier is same or higher", code: "BAD_REQUEST" }`.

## billing-downgrade-006

- Vitest: "POST /api/billing/downgrade > schedules team to pro and ends concurrency at period end"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with a default payment method, a discount, no existing schedule, a Team plan item and a concurrency item of quantity 4 in the current monthly period. Stripe creates and updates a subscription schedule.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the period end. Stripe creates a schedule from the subscription and updates it with `end_behavior: "release"`, no proration, a current phase keeping Team plus 4 concurrency slots and a next monthly phase from the period end with only the Pro price, both carrying the discount; the subscription itself is not updated. Billing status shows `cancelAtPeriodEnd` false, `currentPeriodEnd` at the period end, and `scheduledChange` `{ type: "downgrade", targetTier: "pro", effectiveDate }`.

## billing-downgrade-007

- Vitest: "POST /api/billing/downgrade > records a downgrade schedule that Stripe applied while the organization row was rewritten"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with no schedule. While Stripe is applying the new schedule, the same admin changes auto-recharge settings through `PUT /api/billing/auto-recharge`, which rewrites the organization row.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`, then reads `GET /api/billing/status`.
- Then: The downgrade responds with HTTP 200 `{ success: true, effectiveDate }` at the period end, and billing status still shows `scheduledChange` `{ type: "downgrade", targetTier: "pro", effectiveDate }`.

## billing-downgrade-008

- Vitest: "POST /api/billing/downgrade > preserves usage packs when scheduling team to pro"
- Mode: run
- Given: Usage-pack plan prices for Pro and Team are configured. A signed-in org admin's organization has an active Team usage-pack subscription with a usage-pack-plan Team item and a usage pack 50 item of quantity 2.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the period end. Stripe's schedule is updated with a current phase containing usage pack 50 × 2 and the Team usage-pack plan, and a next monthly phase containing usage pack 50 × 2 and the Pro usage-pack plan, with no proration.

## billing-downgrade-009

- Vitest: "POST /api/billing/downgrade > reuses an existing Stripe schedule when scheduling team to pro"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription that is already attached to a Stripe subscription schedule.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the period end. No new Stripe schedule is created; the existing schedule is updated with a current Team phase and a next monthly Pro phase (`end_behavior: "release"`, no proration). Billing status shows `scheduledChange` `{ type: "downgrade", targetTier: "pro", effectiveDate }`.

## billing-downgrade-010

- Vitest: "POST /api/billing/downgrade > restores a pre-boundary concurrency change and the Team plan independently"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription whose plan period ends later than its 5-slot concurrency period, and paid concurrency entitlements of 5 slots. The admin has confirmed a concurrency reduction to 3 slots through `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm`, which created a Stripe schedule.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"`, then `POST /api/billing/concurrency-subscriptions/:subscriptionId/restore`, then `POST /api/billing/restore`, reading `GET /api/billing/status` after each step.
- Then: The downgrade returns HTTP 200 with `effectiveDate` at the plan period end and updates the schedule so the 5-slot phase, then a Team plus 3-slot phase until the plan period end, then a Pro-only phase; status shows the Pro downgrade and a scheduled concurrency quantity of 3. The concurrency restore returns `{ success: true }` and updates the schedule (with an idempotency key) to keep 5 slots until the plan period end while keeping the Pro phase; status still shows the Pro downgrade and no scheduled concurrency quantity. The billing restore returns `{ status: "restored" }`, releases the Stripe schedule, and status shows no scheduled change, concurrency quantity 5 and no scheduled quantity.

## billing-downgrade-011

- Vitest: "POST /api/billing/downgrade > returns branded setup checkout URLs when team to pro needs a payment method"
- Mode: run
- Given: The app URL is `https://app.okou.ai`. A signed-in org admin's organization has an active Team subscription and Stripe customer with no default payment method or source on either. Stripe creates a setup checkout session with a checkout URL.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "pro"` from origin `https://app.okou.ai`, first without a return URL and then with `returnUrl: "https://app.okou.ai/settings?settings=billing"`.
- Then: Both requests respond with HTTP 200 `{ status: "payment_method_required", checkoutUrl }`. The first creates a Stripe `setup` mode checkout session in USD for the customer with success and cancel URLs `https://app.okou.ai` and metadata (on the session and setup intent) `purpose: "billing_downgrade"`, the org ID, subscription ID and `targetTier: "pro"`; the second uses the explicit return URL for success and cancel. No subscription schedule is created or updated.

## billing-downgrade-012

- Vitest: "POST /api/billing/downgrade > converges concurrent Team cancellation at the period end"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with no schedule, ending in 30 days.
- When: The admin sends two concurrent `POST /api/billing/downgrade` requests with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: At least one request returns HTTP 200 `{ success: true, effectiveDate }` at the period end; any other returns HTTP 409 `{ code: "CONFLICT", message: "Billing changed while downgrading; refresh and try again" }`. Stripe updates the subscription with `cancel_at_period_end: true`. Billing status shows `cancelAtPeriodEnd` true, `currentPeriodEnd` at the period end, and tier still `team`.

## billing-downgrade-013

- Vitest: "POST /api/billing/downgrade > does not delay Team cancellation for a pending concurrency reduction"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with 5 concurrency slots (paid entitlements) for the current period; the Stripe subscription metadata records allowance status `canceled` at the current period end. The admin has confirmed a reduction to 3 slots through `POST /api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm`, so billing status shows a scheduled quantity of 3 and Stripe holds a schedule with a next 3-slot phase.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the current period end. Stripe's schedule is updated with `end_behavior: "cancel"`, no proration, and only the current Team plus 5-slot phase (keeping its metadata). Billing status shows `currentPeriodEnd` at the current period end, no scheduled concurrency quantity and concurrency `cancelAtPeriodEnd` false.

## billing-downgrade-014

- Vitest: "POST /api/billing/downgrade > preserves fixed-term team access when cancelling to limited-free-1"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with no schedule, whose stored access end date is later than Stripe's current period end.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the stored final end date. Stripe updates the subscription with `cancel_at` at that final end and does not update any schedule. Billing status shows `cancelAtPeriodEnd` true, `currentPeriodEnd` at the final end, and `scheduledChange` `{ type: "cancel", targetTier: "limited-free-1", effectiveDate }`.

## billing-downgrade-015

- Vitest: "POST /api/billing/downgrade > does not overwrite an existing subscription cancel_at"
- Mode: run
- Given: A signed-in org admin's organization has an active Pro subscription whose Stripe subscription already has a `cancel_at` later than the current period end, and no schedule.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the existing `cancel_at`. Stripe's subscription and schedules are not updated. Billing status shows `cancelAtPeriodEnd` true, `currentPeriodEnd` at the `cancel_at` date, and `scheduledChange` `{ type: "cancel", targetTier: "limited-free-1", effectiveDate }`.

## billing-downgrade-016

- Vitest: "POST /api/billing/downgrade > preserves external schedule phases when cancelling at schedule end"
- Mode: run
- Given: A signed-in org admin's organization has an active Pro subscription attached to a Stripe schedule whose phases run past the current period end to a later final end, with `end_behavior: "release"`.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the schedule's final end. Stripe's schedule is updated only with `end_behavior: "cancel"` and `proration_behavior: "none"` (phases untouched), and the subscription is not updated. Billing status shows `cancelAtPeriodEnd` true, `currentPeriodEnd` at the final end, and `scheduledChange` `{ type: "cancel", targetTier: "limited-free-1", effectiveDate }`.

## billing-downgrade-017

- Vitest: "POST /api/billing/downgrade > replaces a pending team to pro schedule with cancellation at period end"
- Mode: run
- Given: A signed-in org admin's organization has an active Team subscription with a discount and a pending Stripe schedule downgrading to Pro at the current period end.
- When: The admin requests `POST /api/billing/downgrade` with `targetTier: "limited-free-1"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ success: true, effectiveDate }` at the current period end. Stripe's schedule is updated with `end_behavior: "cancel"`, no proration, and a single current Team phase carrying the discount; the subscription is not updated. Billing status shows `cancelAtPeriodEnd` true and `scheduledChange` `{ type: "cancel", targetTier: "limited-free-1", effectiveDate }`.
