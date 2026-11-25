# billing-usage-media.bdd

## billing-usage-media.bdd-001

- Vitest: "BILL-01: billing status and Stripe-backed actions through public API > chains status, checkout, portal, invoices, campaigns, and admin errors without hidden DB state"
- Mode: run
- Given: An org admin has completed onboarding on a free workspace, and an `org:member` belongs to the same organization. After the first auto-recharge checks, Stripe billing prices are configured; Stripe creates a customer and returns subscription, credit and campaign Checkout session URLs in turn, lists the payment-method portal configuration, and lists one paid invoice `in_bdd` (`INV-BDD`, 2500). Later the `ZERO100` campaign is configured.
- When: The admin reads `GET /api/billing/status` and `GET /api/billing/auto-recharge`, and sends `PUT /api/billing/auto-recharge` with `{ enabled: true, threshold: 1000, amount: 1000 }` and then `{ enabled: false }`. The member and then the admin request `POST /api/billing/checkout` for `pro`; the admin completes it through `POST /api/billing/checkout/complete` while Stripe reports the session belongs to another customer, requests `POST /api/billing/credit-checkout` for 2000 credits, `POST /api/billing/portal`, and `GET /api/billing/invoices` (also requested by the member), `POST /api/billing/downgrade` to `limited-free-1`, `POST /api/billing/restore`, `POST /api/billing/redeem/UNKNOWN` and, after configuration, `POST /api/billing/redeem/ZERO100`, and finally reads billing status.
- Then: Initial status shows tier `limited-free-1`, 0 credits, no subscription and auto-recharge disabled with null threshold and amount; the auto-recharge read matches. The enabling update returns 400 `BAD_REQUEST` and the disabling update returns 200 with disabled nulls. The member checkout returns 403 "Only org admins can manage billing"; the admin checkout returns the subscription Checkout URL; the mismatched completion returns 400. Credit checkout returns the credits URL. The portal returns the portal URL, created with configuration `bpc_payment_methods` and the requested return URL. Invoices return `in_bdd` mapped to `{ id, number, date, amount: 2500, status: "paid", hostedInvoiceUrl }`; the member's invoices request returns 403 "Only org admins can view invoices". Downgrade and restore return 409 "Org has no active subscription". The unknown campaign returns `campaign_misconfigured`, `ZERO100` returns `{ status: "ready", checkoutUrl }` with the campaign URL, and final status still shows 0 credits and no subscription.

## billing-usage-media.bdd-002

- Vitest: "BILL-01: billing status and Stripe-backed actions through public API > grants Stripe checkout and invoice credits idempotently through webhook-visible billing status"
- Mode: run
- Given: An org admin has completed onboarding on a free workspace, and the Stripe webhook secret is configured.
- When: Stripe delivers signed webhooks to `POST /api/webhooks/stripe` in order: a paid `checkout.session.completed` `credit_purchase` with `amount_total` 2500 and `creditsAmountMode: "amount_total"`, the same session again under a new event ID, an `invoice.paid` `auto_recharge` invoice with `creditsAmount` 3000, the same invoice again, an `invoice.paid` `credit_purchase` invoice with subtotal 1200, and the same invoice again; the admin reads `GET /api/billing/status` after each delivery.
- Then: Every webhook returns HTTP 200 with body `OK`. Credits read 25,000 after the checkout and stay 25,000 after its duplicate, become 28,000 after the auto-recharge invoice and stay 28,000 after its duplicate, and become 40,000 after the credit purchase invoice and stay 40,000 after its duplicate.

## billing-usage-media.bdd-003

- Vitest: "BILL-02: usage reads > reads empty usage records through visible APIs"
- Mode: run
- Given: An org admin has completed onboarding on a free workspace with no usage.
- When: The admin reads `GET /api/usage/members` without a range, then with `range: "7d"` and `tz: "Asia/Shanghai"`, and reads `GET /api/usage/record` for the default 24-hour range.
- Then: The unranged members read returns `{ period: null, members: [] }`. The 7-day read returns a non-null period with no members. The usage record has `pagination.total` 0 and no rows.

## billing-usage-media.bdd-004

- Vitest: "FILE-02 and CHAIN-BILLING-MEDIA: media generation, quota, and status APIs > queues and completes an image generation through Stripe credits, Fal webhook, and status GET"
- Mode: run
- Given: An org admin has completed onboarding on a free workspace, and a signed Stripe `checkout.session.completed` `credit_purchase` webhook granting 1,000,000 credits is delivered. Fal's queue accepts generation requests, and the generated image URL serves a PNG.
- When: The admin reads `GET /api/billing/status`, selects `gpt-image-1` through `PUT /api/user-model-preference`, requests `POST /api/image-io/generate/private` with a prompt, reads `GET /api/built-in-generations/:generationId`, then Fal posts a `COMPLETED` result (one 1024×1024 PNG, seed 123) with the generation's webhook token to `POST /api/webhooks/built-in-generations/fal/:generationId`, and the admin reads the generation again.
- Then: Billing status shows 1,000,000 credits. Generation returns HTTP 202 with a generation ID, `type: "image"` and `status: "queued"`. The first read returns HTTP 200 with that ID, `type: "image"` and `status: "running"`. The Fal webhook returns `OK`, and the final read shows `status: "completed"` with a result of provider `fal`, output format `png`, image size `1024x1024` and seed 123.

## billing-usage-media.bdd-005

- Vitest: "FILE-02 and CHAIN-BILLING-MEDIA: media generation, quota, and status APIs > chains media quota, generation gates, and status reads through API-visible state"
- Mode: run
- Given: An org admin has completed onboarding on a free workspace whose plan has been canceled, leaving no credits, and has selected `gpt-image-1` as the image model.
- When: The admin requests `POST /api/image-io/generate/private` with a valid prompt; then with `size: "42x42"`; then, after selecting `gpt-image-2`, with `background: "transparent"`; then, back on `gpt-image-1`, with `outputFormat: "png"` and `outputCompression: 50`, with `seed: 1`, with `safetyTolerance: "6"`, with `enhancePrompt: true`, with only `maskImageUrl`, and with only `inputFidelity: "high"`. The admin also reads `GET /api/built-in-generations/:generationId` for an unknown ID, `GET /api/billing/status` and `GET /api/usage/record`.
- Then: The valid request returns HTTP 402 `INSUFFICIENT_CREDITS`. The others return HTTP 400 with messages containing "Unsupported image size", then "gpt-image-2 does not support transparent backgrounds", "outputCompression is only supported for jpeg or webp output", "seed is not supported for gpt-image-1", "safetyTolerance is not supported for gpt-image-1", "enhancePrompt is not supported for gpt-image-1", "maskImageUrl requires imageUrl" and "inputFidelity requires imageUrl". The unknown generation returns 404 "Built-in generation not found". Billing status shows 0 credits and the usage record has no rows.

## billing-usage-media.bdd-006

- Vitest: "BILL-02: banking credential boundary > rejects a browser session on the banking API credential boundary"
- Mode: run
- Given: An org admin has completed onboarding and calls the API with a browser (Clerk) session.
- When: The admin requests `POST /api/banking/accounts` with an empty body.
- Then: The API responds with HTTP 403 and the error message "This endpoint does not accept the provided credential type".
