# billing-checkout

## billing-checkout-001

- Vitest: "POST /api/billing/checkout > returns 503 when STRIPE_SECRET_KEY is not configured"
- Mode: run
- Given: The Stripe secret key is not configured. The caller sends no authorization header.
- When: The caller requests `POST /api/billing/checkout` for the `pro` tier with success and cancel URLs on the app origin.
- Then: The response is HTTP 503 with code `PROVIDER_UNAVAILABLE` and message "Billing not configured".

## billing-checkout-002

- Vitest: "POST /api/billing/checkout > returns 401 when not authenticated"
- Mode: run
- Given: Billing is configured and the caller sends no authorization header.
- When: The caller requests `POST /api/billing/checkout` for the `pro` tier.
- Then: The response is HTTP 401.

## billing-checkout-003

- Vitest: "POST /api/billing/checkout > returns 403 for non-admin org member"
- Mode: run
- Given: The caller is signed in as an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/checkout` for the `pro` tier.
- Then: The response is HTTP 403 with code `FORBIDDEN` and message "Only org admins can manage billing".

## billing-checkout-004

- Vitest: "POST /api/billing/checkout > returns checkout URL on success"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer. The Pro price is configured. Stripe creates a customer and returns a hosted Checkout session URL.
- When: The admin requests `POST /api/billing/checkout` for the `pro` tier with success and cancel URLs on the app origin.
- Then: The response is HTTP 200 with the Stripe Checkout URL. Stripe receives a customer creation with `orgId` metadata and idempotency key `stripe-customer:development::<orgId>`, and a subscription-mode Checkout session for that customer with one Pro price line item, promotion codes allowed, the given success and cancel URLs, and `orgId`, `tier`, `priceId` and `purchaseCreatedAt` metadata on both the session and the subscription data.

## billing-checkout-005

- Vitest: "POST /api/billing/checkout > shares a published customer while another candidate returns success"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer. A first Pro checkout request is waiting on Stripe customer creation, which later succeeds with a different customer candidate.
- When: The admin sends a second `POST /api/billing/checkout` for `pro` while the first is still pending, the first request's customer creation then succeeds, and later the admin sends a third request while Stripe customer creation would fail.
- Then: Both the first and second requests return HTTP 200 with the same Checkout URL. `GET /api/billing/status` shows tier `limited-free-1` with no subscription. The third request returns HTTP 200 with the same URL, reusing the existing customer.

## billing-checkout-006

- Vitest: "POST /api/billing/checkout > shares a published customer while another candidate returns lost_response"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer. A first Pro checkout request is waiting on Stripe customer creation, whose response is later lost (the Stripe call errors).
- When: The admin sends a second `POST /api/billing/checkout` for `pro` while the first is still pending, the first request's customer creation then fails with a lost response, and later the admin sends a third request while Stripe customer creation would fail.
- Then: Both the first and second requests return HTTP 200 with the same Checkout URL. `GET /api/billing/status` shows tier `limited-free-1` with no subscription. The third request returns HTTP 200 with the same URL, reusing the existing customer.

## billing-checkout-007

- Vitest: "POST /api/billing/checkout > recovers a customer after Stripe created it but its response was lost"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer. Stripe creates customers idempotently by idempotency key, but the response to the first creation is lost.
- When: The admin requests `POST /api/billing/checkout` for `pro`, then retries the same request.
- Then: The first request returns HTTP 500 after Stripe created a customer. The retry returns HTTP 200 with a Checkout URL for that same created customer. `GET /api/billing/status` shows tier `limited-free-1` with no subscription.

## billing-checkout-008

- Vitest: "POST /api/billing/checkout > releases an unpublished Plan claim after a Stripe admission failure"
- Mode: run
- Given: A signed-in organization admin's organization gets a new Stripe customer with a saved default card and no existing subscriptions, and Stripe previews a 2,000-cent Pro invoice and creates subscriptions without a latest invoice. The admin has an in-app Pro purchase preview token from `POST /api/billing/checkout` with `supportsInAppPreview: true`. Stripe's subscription listing (admission check) fails once.
- When: The admin calls `POST /api/billing/checkout/confirm` with the preview token, then retries the same confirmation.
- Then: The first confirmation returns HTTP 500. The retry returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. `GET /api/billing/status` shows tier `limited-free-1` with no subscription.

## billing-checkout-009

- Vitest: "POST /api/billing/checkout > releases an unpublished Plan claim after a Stripe creation failure"
- Mode: run
- Given: A signed-in organization admin's organization gets a new Stripe customer with a saved default card and no existing subscriptions, and Stripe previews a 2,000-cent Pro invoice and creates subscriptions without a latest invoice. The admin has an in-app Pro purchase preview token from `POST /api/billing/checkout` with `supportsInAppPreview: true`. Stripe's subscription creation fails once.
- When: The admin calls `POST /api/billing/checkout/confirm` with the preview token, then retries the same confirmation.
- Then: The first confirmation returns HTTP 500. The retry returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. `GET /api/billing/status` shows tier `limited-free-1` with no subscription.

## billing-checkout-010

- Vitest: "POST /api/billing/checkout > pays a saved-card Plan preview through the rollout-safe checkout route"
- Mode: run
- Given: A signed-in organization admin's organization gets a Stripe customer with a saved default card and no existing subscriptions. Stripe previews a 2,000-cent Pro invoice, creates an incomplete subscription with an open invoice, pays that invoice, and then reports the subscription as active on the Pro price.
- When: The admin requests `POST /api/billing/checkout` for `pro` with `supportsInAppPreview: true`, then after the clock advances one minute sends the same request to `POST /api/billing/checkout` with the returned `previewToken`.
- Then: The first response is HTTP 200 with a `preview` for purchase type `plan`, tier `pro`, 2,000 cents immediate and recurring in `usd`, and a preview token; no hosted Checkout session is created. The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. Stripe previews the invoice twice, creates the subscription for the customer with the saved card, `default_incomplete` payment behavior, `purchaseCreatedAt` equal to the preview time and a `plan-purchase:` idempotency key, and pays the invoice with a `billing-operation:plan:` idempotency key. `GET /api/billing/status` shows tier `pro` with an active subscription.

## billing-checkout-011

- Vitest: "POST /api/billing/checkout > resumes a pending Team purchase and applies it before returning"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer and a recorded subscription. Stripe lists an incomplete Team subscription created for a pending purchase, with a saved card and an open 20,000-cent invoice, alongside an active Pro subscription. Paying the Team invoice makes that subscription active, and Stripe accepts cancellation of the Pro subscription.
- When: The admin requests `POST /api/billing/checkout` for `team` with `supportsInAppPreview: true`, then sends the same request with the returned `previewToken`.
- Then: The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. No new Stripe subscription is created; the pending Team invoice is paid with a `billing-operation:plan:` idempotency key, and the active Pro subscription is canceled with `invoice_now: false` and `prorate: false`. `GET /api/billing/status` shows tier `team` with an active subscription.

## billing-checkout-012

- Vitest: "POST /api/billing/checkout > rejects a resumable Plan purchase after its saved card changes"
- Mode: run
- Given: A signed-in organization admin's organization has a Stripe customer and a recorded subscription. Stripe lists an incomplete Team subscription for a pending purchase with an open 20,000-cent invoice. The admin obtains a Team purchase preview, after which the pending subscription's default payment method changes to a different card.
- When: The admin calls `POST /api/billing/checkout/confirm` with the preview token.
- Then: The response is HTTP 409 with code `CONFLICT` and message "Plan purchase preview is no longer valid", and no Stripe invoice is paid.

## billing-checkout-013

- Vitest: "POST /api/billing/checkout > refreshes an invalid Plan preview through the rollout-safe checkout route"
- Mode: run
- Given: A signed-in organization admin's organization gets a new Stripe customer with no subscriptions, and Stripe previews a 2,000-cent Pro invoice. The customer's saved default card at preview time is later replaced by a different card.
- When: The admin requests `POST /api/billing/checkout` for `pro` with `supportsInAppPreview: true`, then sends the same request with the returned `previewToken`.
- Then: The second response is HTTP 200 with a fresh `preview` (purchase type `plan`, tier `pro`, 2,000 cents immediate and recurring, `usd`) and a different preview token. Stripe retrieves the customer three times and creates no subscription.

## billing-checkout-014

- Vitest: "POST /api/billing/checkout > rejects competing Plan previews and stale purchase replays"
- Mode: run
- Given: A signed-in organization admin's organization gets a Stripe customer with a saved card and no subscriptions; Stripe previews 2,000-cent invoices and every created subscription becomes listable. The admin obtains two Pro previews and one Team preview through `POST /api/billing/checkout` with `supportsInAppPreview: true`.
- When: The admin confirms both Pro previews concurrently via `POST /api/billing/checkout/confirm`, then confirms the Team preview, and finally, after Stripe also lists a different Team subscription for the organization, replays the winning Pro preview.
- Then: The concurrent confirmations return one HTTP 200 and one HTTP 409. The Team confirmation returns HTTP 409 with code `CONFLICT` and message "Plan purchase preview is no longer valid", and the replay returns the same 409 body. Stripe creates exactly one subscription, cancels none and pays no invoice.

## billing-checkout-015

- Vitest: "POST /api/billing/checkout > uses hosted Checkout when an opted-in plan purchase has no saved card"
- Mode: run
- Given: A signed-in organization admin's organization gets a new Stripe customer with no default payment method, default source or saved payment methods. Stripe returns a hosted Checkout session URL.
- When: The admin requests `POST /api/billing/checkout` for `pro` with `supportsInAppPreview: true`.
- Then: The response is HTTP 200 with the hosted Checkout URL, and no Stripe invoice preview is requested.

## billing-checkout-016

- Vitest: "POST /api/billing/checkout > tags preview Stripe checkout objects with the current job ref"
- Mode: run
- Given: The API runs in the `preview` environment with job ref `pr-123`. A signed-in organization admin's organization has no Stripe customer; Stripe creates one and returns a Checkout session URL.
- When: The admin requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 200 with the Checkout URL. The Stripe customer is created with `orgId`, `vm0_environment: "preview"` and `job_ref: "pr-123"` metadata and idempotency key `stripe-customer:preview:pr-123:<orgId>`. The Checkout session and its subscription data carry `orgId`, `tier`, `priceId`, `purchaseCreatedAt` and the same preview environment and job ref metadata.

## billing-checkout-017

- Vitest: "POST /api/billing/checkout > returns 400 when checkout would downgrade the current tier"
- Mode: run
- Given: A signed-in organization admin's organization has an active Team subscription.
- When: The admin requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Cannot create Pro checkout while current tier is Team; use billing management to change plans", and no Stripe Checkout session is created.

## billing-checkout-018

- Vitest: "POST /api/billing/checkout > returns 400 when checkout would duplicate the current tier"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription.
- When: The admin requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Cannot create Pro checkout while current tier is Pro; use billing management to change plans", and no Stripe Checkout session is created.

## billing-checkout-019

- Vitest: "POST /api/billing/checkout > attaches billing identity to the customer, checkout and subscription"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer; Stripe creates one and returns a Checkout session URL.
- When: The admin requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 200 with the Checkout URL. The Stripe customer is created with `orgId` metadata and idempotency key `stripe-customer:development::<orgId>`, and the Checkout session and its subscription data both carry `orgId`, `tier: "pro"`, the Pro `priceId` and `purchaseCreatedAt` metadata.

## billing-checkout-020

- Vitest: "POST /api/billing/checkout > rejects Pro trial checkout outside onboarding payment"
- Mode: run
- Given: A signed-in organization admin's organization has no subscription.
- When: The admin requests `POST /api/billing/checkout` for `pro` with `trialDays: 7`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Pro trial checkout is only available during onboarding".

## billing-checkout-021

- Vitest: "POST /api/billing/checkout > rejects trial checkout for non-Pro tiers"
- Mode: run
- Given: A signed-in organization admin's organization has no subscription.
- When: The admin requests `POST /api/billing/checkout` for `team` with `trialDays: 7`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Trial checkout is only available for Pro tier".

## billing-checkout-022

- Vitest: "POST /api/billing/checkout > returns 400 when successUrl origin does not match APP_URL"
- Mode: run
- Given: A signed-in organization admin's organization has no subscription.
- When: The admin requests `POST /api/billing/checkout` for `pro` with `successUrl` on `https://evil.example.com` and `cancelUrl` on the app origin.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "successUrl and cancelUrl must match the platform origin".

## billing-checkout-023

- Vitest: "POST /api/billing/checkout > accepts successUrl on a first-party www.okou.ai origin"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer; Stripe creates one and returns a Checkout session URL.
- When: The admin requests `POST /api/billing/checkout` for `pro` with success and cancel URLs on `https://www.okou.ai`.
- Then: The response is HTTP 200 with the Stripe Checkout URL.

## billing-checkout-024

- Vitest: "POST /api/billing/checkout > returns 401 when caller has no org"
- Mode: run
- Given: The caller is a signed-in user with no active organization.
- When: The user requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 401.

## billing-checkout-025

- Vitest: "POST /api/billing/checkout > returns 400 when the tier price is unset"
- Mode: run
- Given: A signed-in organization admin's organization has no subscription, and no Stripe price is configured for the Pro tier.
- When: The admin requests `POST /api/billing/checkout` for `pro`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Price not configured for pro tier".
