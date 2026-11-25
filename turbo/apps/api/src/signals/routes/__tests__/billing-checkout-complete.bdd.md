# billing-checkout-complete

## billing-checkout-complete-001

- Vitest: "POST /api/billing/checkout/complete > reconciles a paid plan checkout before its webhook arrives without duplicating credits"
- Mode: run
- Given: A signed-in organization admin with no Stripe customer has started a Pro plan checkout through `POST /api/billing/checkout`. Stripe reports the checkout session as complete with an active subscription whose latest invoice is first still open and unpaid, then paid at 2,000 cents for the Pro price.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID while the invoice is unpaid, then twice concurrently after it is paid, once more afterwards, and Stripe then delivers a signed `invoice.paid` webhook for the same invoice to `POST /api/webhooks/stripe`.
- Then: The first completion returns HTTP 200 `{ completed: false }` and `GET /api/billing/status` is not yet Pro. Both concurrent completions and the later one return `{ completed: true }`; billing status then shows tier `pro`, an active subscription, the invoice period end and 20,000 credits. After the webhook returns HTTP 200, billing status and `GET /api/billing/usage-pack-credits` are unchanged, so no credits are duplicated.

## billing-checkout-complete-002

- Vitest: "POST /api/billing/checkout/complete > reconciles a paid usage pack checkout before its webhook arrives without duplicating credits"
- Mode: run
- Given: A signed-in organization admin with no Stripe customer has started a Pro usage-pack checkout with a $20 member usage pack through `POST /api/billing/usage-pack-checkout`. Stripe reports the checkout session as complete with an active subscription for the usage-pack Pro plan price and the $20 pack price, whose latest invoice is first open and unpaid, then paid at 2,000 cents.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID while the invoice is unpaid, then twice concurrently after it is paid, once more afterwards, and Stripe then delivers a signed `invoice.paid` webhook for the same invoice to `POST /api/webhooks/stripe`.
- Then: The first completion returns HTTP 200 `{ completed: false }` and billing status is not yet Pro. Both concurrent completions and the later one return `{ completed: true }`; billing status shows tier `pro`, an active subscription and the invoice period end, and `GET /api/billing/usage-pack-credits` shows a usage pack with 20,400 total credits (20,000 purchased plus 400 bonus) in two credit grants. After the webhook returns HTTP 200, billing status and the credit grants are unchanged, so no credits are duplicated.

## billing-checkout-complete-003

- Vitest: "POST /api/billing/checkout/complete > finds the plan item in a completed multi-item subscription"
- Mode: run
- Given: A signed-in organization admin's organization already has a Stripe customer and is on the free tier. Stripe reports the checkout session as complete with a `trialing` subscription whose items list the $20 usage pack price before the usage-pack Pro plan price.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID.
- Then: The response is HTTP 200 `{ completed: false }`. `GET /api/billing/status` shows tier `limited-free-1`, a subscription with status `trialing`, and no current period end.

## billing-checkout-complete-004

- Vitest: "POST /api/billing/checkout/complete > keeps checkout pending when the subscription is incomplete"
- Mode: run
- Given: A signed-in organization admin's organization already has a Stripe customer and is on the free tier. Stripe reports the checkout session as complete with an `incomplete` Pro subscription.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID.
- Then: The response is HTTP 200 `{ completed: false }`. `GET /api/billing/status` shows tier `limited-free-1`, a subscription with status `incomplete`, and no current period end.

## billing-checkout-complete-005

- Vitest: "POST /api/billing/checkout/complete > returns 400 when completed checkout would downgrade the current tier"
- Mode: run
- Given: A signed-in organization admin's organization has an active Team subscription recorded from a paid invoice. Stripe reports a completed checkout session for the same customer with a different active subscription on the Pro price.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Cannot create Pro checkout while current tier is Team; use billing management to change plans". `GET /api/billing/status` still shows tier `team` with an active subscription.

## billing-checkout-complete-006

- Vitest: "POST /api/billing/checkout/complete > returns completed false while Stripe has not completed the session"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer. Stripe reports the checkout session as `open` with no subscription.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID.
- Then: The response is HTTP 200 `{ completed: false }` and no Stripe subscription is retrieved.

## billing-checkout-complete-007

- Vitest: "POST /api/billing/checkout/complete > rejects an expired checkout instead of reporting it as pending"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer. Stripe reports the checkout session for that customer as `expired` with no subscription.
- When: The admin calls `POST /api/billing/checkout/complete` with the session ID.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Checkout session expired", and no Stripe subscription is retrieved.

## billing-checkout-complete-008

- Vitest: "POST /api/billing/checkout/complete > rejects complete checkout sessions from another customer"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer. Stripe reports the checkout session with status `complete` but belonging to a different Stripe customer.
- When: The admin calls `POST /api/billing/checkout/complete` with that session ID.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Checkout session does not belong to current organization".

## billing-checkout-complete-009

- Vitest: "POST /api/billing/checkout/complete > rejects expired checkout sessions from another customer"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer. Stripe reports the checkout session with status `expired` and belonging to a different Stripe customer.
- When: The admin calls `POST /api/billing/checkout/complete` with that session ID.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Checkout session does not belong to current organization".
