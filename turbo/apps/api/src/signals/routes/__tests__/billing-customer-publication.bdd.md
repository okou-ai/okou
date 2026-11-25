# billing-customer-publication

## billing-customer-publication-001

- Vitest: "initializes the default Plan through a fresh payment-method portal and reuses its customer"
- Mode: run
- Given: A signed-in organization admin's new organization has no billing Plan or Stripe customer. Stripe creates a customer, has no existing billing portal configuration, creates one, and returns a portal session URL.
- When: The admin opens `POST /api/billing/portal` with a return URL on the app origin, reads `GET /api/billing/status`, opens the portal again while Stripe would create a different customer, and reads billing status again.
- Then: Both portal requests return HTTP 200 with the portal URL. The status shows tier `limited-free-1`, status `active`, 0 credits, concurrency limit 2, `canBuyCredits` true, `canBuyConcurrency`, `showUsagePack`, `autoRechargeAllowed` and `workflowWebhookAutomationAllowed` false, `restrictedBuiltInModels` true and no subscription. Stripe creates exactly one customer, with `orgId` metadata and idempotency key `stripe-customer:development::<orgId>`, and the last portal session uses that customer, the created configuration and the return URL. The second status read is identical to the first.

## billing-customer-publication-002

- Vitest: "binds an organization initialized by a check-in while preserving its Plan and reward"
- Mode: run
- Given: A signed-in organization admin has already completed the daily get-started check-in, which initialized the organization's billing. Stripe creates a customer and returns a portal session URL.
- When: The admin opens `POST /api/billing/portal` with a return URL, then reads `GET /api/billing/status` and repeats `POST /api/get-started/check-in`.
- Then: The portal request returns HTTP 200 with the portal URL, and Stripe's portal session uses the new customer, the portal configuration and the return URL. Billing status is identical to the status before the portal request, and the repeated check-in returns the same receipt as the original.

## billing-customer-publication-003

- Vitest: "publishes one authoritative customer for concurrent fresh portal requests"
- Mode: run
- Given: A signed-in organization admin's new organization has no Stripe customer. Stripe returns the same customer ID for every customer creation and returns a portal session URL.
- When: The admin sends two concurrent `POST /api/billing/portal` requests, then reads `GET /api/billing/status`.
- Then: Both requests return HTTP 200 with the portal URL, and both Stripe portal sessions use the same customer. Billing status shows tier `limited-free-1`, 0 credits, concurrency limit 2 and `restrictedBuiltInModels` true.

## billing-customer-publication-004

- Vitest: "preserves an organization check-in completed during external customer preparation"
- Mode: run
- Given: A signed-in organization admin's new organization has no Stripe customer. While Stripe is creating the customer for a portal request, the admin completes the get-started check-in.
- When: The admin opens `POST /api/billing/portal`, then repeats `POST /api/get-started/check-in` and reads `GET /api/billing/status`.
- Then: The portal request returns HTTP 200. The repeated check-in returns the original receipt ID with status `granted` and reward amount 100. Billing status shows tier `limited-free-1`, 0 credits and concurrency limit 2, and the Stripe portal session uses the created customer, the portal configuration and the return URL.

## billing-customer-publication-005

- Vitest: "uses a concurrently committed customer after losing the provider response"
- Mode: run
- Given: A signed-in organization admin's new organization has no Stripe customer. While Stripe is creating the customer for a first portal request, a second portal request completes, and then the first request's Stripe response is lost (the call errors).
- When: The admin opens `POST /api/billing/portal`, during which the concurrent portal request completes, then reads `GET /api/billing/status`.
- Then: Both portal requests return HTTP 200 with the portal URL, and both Stripe portal sessions use the customer committed by the concurrent request. Billing status shows tier `limited-free-1`, 0 credits and concurrency limit 2.

## billing-customer-publication-006

- Vitest: "propagates provider failure without a winner and accepts another normal portal request"
- Mode: run
- Given: A signed-in organization admin has completed the get-started check-in. Stripe customer creation fails once with an error, then succeeds.
- When: The admin opens `POST /api/billing/portal`, reads `GET /api/billing/status`, and opens the portal again.
- Then: The first portal request returns HTTP 500 and no Stripe portal session is created. Billing status is identical to the status before the failure. The second portal request returns HTTP 200 with the portal URL.

## billing-customer-publication-007

- Vitest: "retains the preview routing metadata and provider idempotency identity"
- Mode: run
- Given: The API runs in the `preview` environment with job ref `pr-tx0062`. A signed-in organization admin's new organization has no Stripe customer.
- When: The admin opens `POST /api/billing/portal` with a return URL.
- Then: The request returns HTTP 200. Stripe creates the customer with `orgId`, `vm0_environment: "preview"` and `job_ref: "pr-tx0062"` metadata and idempotency key `stripe-customer:preview:pr-tx0062:<orgId>`.
