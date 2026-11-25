# billing-status

## billing-status-001

- Vitest: "GET /api/billing/status > returns 401 when not authenticated"
- Mode: run
- Given: Stripe billing is not configured. The caller sends no authorization header.
- When: The caller requests `GET /api/billing/status`.
- Then: The API responds with HTTP 401 and error code `UNAUTHORIZED`.

## billing-status-002

- Vitest: "GET /api/billing/status > returns 401 when the user has no active org"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user has no active organization.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 401 and the error `{ message: "Not authenticated", code: "UNAUTHORIZED" }`.

## billing-status-003

- Vitest: "GET /api/billing/status > keeps billing status isolated across successive organization requests"
- Mode: run
- Given: Two users have completed onboarding in separate organizations; organization A has an active Pro plan and organization B an active Team plan. Stripe billing is not configured.
- When: User A requests `GET /api/billing/status`, then user B, then user A again.
- Then: All requests return HTTP 200. Both of A's responses report tier `pro` with status `active`, and B's response reports tier `team` with status `active`.

## billing-status-004

- Vitest: "GET /api/billing/status > returns billing status for authenticated user"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no subscription and 100,000 credits.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with tier `limited-free-1`, status `active`, concurrency limit 2, restricted built-in models, 100,000 credits, no onboarding payment pending, `hasSubscription` false, null `subscriptionStatus` and null `currentPeriodEnd`.

## billing-status-005

- Vitest: "GET /api/billing/status > returns billing status for agent tokens with billing read capability"
- Mode: run
- Given: Stripe billing is not configured. A free organization seeded with 100,000 credits has an entitled chat user who starts a chat Run; the Run's execution carries an Okou agent token with billing read capability.
- When: The agent token requests `GET /api/billing/status` (as `Authorization: Bearer <agent token>`), after which the Run is cancelled.
- Then: The API responds with HTTP 200 and reports 120,000 credits.

## billing-status-006

- Vitest: "GET /api/billing/status > returns correct data for subscribed org"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-04-20), a Stripe customer and subscription, and 100,000 credits.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with tier `pro`, status `active`, 100,000 credits, `subscriptionStatus` `active`, `currentPeriodEnd` 2099-04-20, `cancelAtPeriodEnd` false, no `scheduledChange`, `canRestorePlan` false and `hasSubscription` true.

## billing-status-007

- Vitest: "GET /api/billing/status > does not report a canceled plan as a subscription"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has a Pro subscription whose Stripe status is `canceled`. Parameter row: `canceled`.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `subscriptionStatus` `canceled` and `hasSubscription` false.

## billing-status-008

- Vitest: "GET /api/billing/status > does not report a incomplete_expired plan as a subscription"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has a Pro subscription whose Stripe status is `incomplete_expired`. Parameter row: `incomplete_expired`.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `subscriptionStatus` `incomplete_expired` and `hasSubscription` false.

## billing-status-009

- Vitest: "GET /api/billing/status > reflects normal subscription activation and cancellation without enabling package controls"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has a normally activated Pro plan without prior funding.
- When: The user requests `GET /api/billing/status`, a signed Stripe `customer.subscription.updated` webhook then marks the subscription `canceled`, and the user requests it again.
- Then: The first response reports status `active` and the second status `suspended`; both report `showUsagePack` false.

## billing-status-010

- Vitest: "GET /api/billing/status > reports active concurrency subscription availability"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no plan subscription but has a paid concurrency subscription of 2 slots (2026-01-01 to 2099-04-20) whose Stripe status is `active`. Parameter row: `active`.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and `hasSubscription` true.

## billing-status-011

- Vitest: "GET /api/billing/status > reports canceled concurrency subscription availability"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no plan subscription but has a paid concurrency subscription of 2 slots (2026-01-01 to 2099-04-20) whose Stripe status is `canceled`. Parameter row: `canceled`.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and `hasSubscription` false.

## billing-status-012

- Vitest: "GET /api/billing/status > returns finite concurrency limit when the concurrency cap is disabled"
- Mode: run
- Given: The concurrent run limit cap is disabled (`0`). Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-04-20).
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and a finite `concurrencyLimit` of 3.

## billing-status-013

- Vitest: "GET /api/billing/status > returns Team capabilities and the current Stripe concurrency price"
- Mode: run
- Given: The concurrent run limit cap is 3. A user has completed onboarding and the organization has an active Team plan. Stripe billing is configured with a concurrency price that Stripe reports as an active monthly recurring USD price of 4200 cents.
- When: The user requests `GET /api/billing/status`; then Stripe reports the concurrency price as missing (`resource_missing`) and the user requests it again.
- Then: The first response reports tier `team`, status `active`, `canBuyConcurrency`, `canBuyCredits`, `autoRechargeAllowed` and `workflowWebhookAutomationAllowed` true, `showUsagePack` and `restrictedBuiltInModels` false, concurrency limit 3 and `concurrencyUnitAmountCents` 4200. The second response has no `concurrencyUnitAmountCents` property.

## billing-status-014

- Vitest: "GET /api/billing/status > includes active concurrency subscription slots"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Team subscription, 120,000 credits, and one concurrency subscription with three paid lines: 2 slots until 2099-05-20 (cancel at period end), 1 slot until 2099-06-20, and 5 slots that expired on 2026-01-01.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with concurrency limit 13 and a single concurrency subscription entry `{ id, quantity: 3, currentPeriodEnd: "2099-06-20T00:00:00.000Z", cancelAtPeriodEnd: true }`.

## billing-status-015

- Vitest: "GET /api/billing/status > excludes canceled concurrency subscriptions from status"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Team subscription, 120,000 credits, and a 2-slot concurrency subscription whose Stripe status is `canceled`.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with concurrency limit 10 and an empty `concurrencySubscriptions` list.

## billing-status-016

- Vitest: "GET /api/billing/status > returns cancelAtPeriodEnd true when set"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-04-20) that is set to cancel at period end.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `cancelAtPeriodEnd` true, `hasSubscription` true, `scheduledChange` `{ type: "cancel", targetTier: "limited-free-1", effectiveDate: 2099-04-20 }` and `canRestorePlan` true.

## billing-status-017

- Vitest: "GET /api/billing/status > returns scheduled downgrade details when set"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Team subscription (period ending 2099-04-20, not cancelling) with a pending schedule downgrading to Pro at the period end.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `cancelAtPeriodEnd` false, `scheduledChange` `{ type: "downgrade", targetTier: "pro", effectiveDate: 2099-04-20 }` and `canRestorePlan` true.

## billing-status-018

- Vitest: "GET /api/billing/status > returns 200 for non-admin member"
- Mode: run
- Given: Stripe billing is not configured. A signed-in `org:member` (not an admin) belongs to an organization with 100,000 credits.
- When: The member requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200.

## billing-status-019

- Vitest: "GET /api/billing/status > includes creditExpiry data for paid org with expires records"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-04-20) and the plan's renewal credit grant.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `creditExpiry.expiringNextCycle` 20,000 and `nextExpiryDate` 2099-05-20, and a single credit grant with source `subscription_renewal`, label "Pro plan", amount and remaining 20,000, expiring 2099-05-20.

## billing-status-020

- Vitest: "GET /api/billing/status > returns zero creditExpiry without active credit grants"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no subscription and no credit grants.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with `creditExpiry.expiringNextCycle` 0 and `nextExpiryDate` null.

## billing-status-021

- Vitest: "GET /api/billing/status > displays credits minus not-yet-settled expired amount"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no subscription, a ledger of 103,000 credits, and a 3,000-credit purchase grant that expired on 2026-03-01 but has not been settled.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and reports 100,000 credits.

## billing-status-022

- Vitest: "GET /api/billing/status > maps pay-as-you-go expires records to Pay as you go segment"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-05-20), 40,000 credits, a 20,000-credit `subscription_renewal` grant, a 10,000-credit `credit_purchase` grant and a 10,000-credit `auto_recharge` grant.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200. The credit breakdown contains a `payAsYouGo` segment labelled "Pay as you go" with 20,000 credits, and the credit grants include exactly two `auto_recharge` or `credit_purchase` grants.

## billing-status-023

- Vitest: "GET /api/billing/status > maps subscription_renewal at Pro amount to Pro plan segment"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-05-20), 20,000 credits and a 20,000-credit `subscription_renewal` grant.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and the credit breakdown is exactly `[{ category: "plan", label: "Pro plan", credits: 20000, tier: "pro" }]`.

## billing-status-024

- Vitest: "GET /api/billing/status > maps subscription_renewal at Team amount to Team plan segment"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Team subscription (period ending 2099-05-20), 120,000 credits and a 120,000-credit `subscription_renewal` grant.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and the credit breakdown is exactly `[{ category: "plan", label: "Team plan", credits: 120000, tier: "team" }]`.

## billing-status-025

- Vitest: "GET /api/billing/status > maps one_time_purchase records to Promotional segment"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has no subscription, 100,000 credits and a 100,000-credit `one_time_purchase` grant expiring 2099-12-31.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and the credit breakdown contains a `promotional` segment labelled "Promotional" with 100,000 credits.

## billing-status-026

- Vitest: "GET /api/billing/status > surfaces paid-tier credit purchases as Pay as you go"
- Mode: run
- Given: Stripe billing is not configured. A signed-in user's organization has an active Pro subscription (period ending 2099-05-20), 25,000 credits and a 20,000-credit `subscription_renewal` grant.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 and the credit breakdown is exactly a `plan` segment "Pro plan" with 20,000 credits (tier `pro`) followed by a `payAsYouGo` segment "Pay as you go" with 5,000 credits; no credit grant has source `auto_recharge`.

## billing-status-027

- Vitest: "GET /api/billing/status > returns defaults when org row does not exist"
- Mode: run
- Given: A signed-in user's organization has no billing record. Stripe billing is configured with a concurrency price, and reading that price from Stripe would fail.
- When: The user requests `GET /api/billing/status`.
- Then: The API responds with HTTP 200 with tier `limited-free-1`, status `suspended`, 0 credits, `hasSubscription` false, `canBuyConcurrency` false and no `concurrencyUnitAmountCents` property.
