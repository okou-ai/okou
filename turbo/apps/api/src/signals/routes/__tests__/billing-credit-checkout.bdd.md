# billing-credit-checkout

## billing-credit-checkout-001

- Vitest: "POST /api/billing/credit-checkout > returns 403 for non-admin org member"
- Mode: run
- Given: The caller is signed in as an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/credit-checkout` for 20,000 credits with success and cancel URLs on the app origin.
- Then: The response is HTTP 403 with code `FORBIDDEN` and message "Only org admins can buy credits".

## billing-credit-checkout-002

- Vitest: "POST /api/billing/credit-checkout > allows promotion codes when the customer has no discount"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer; Stripe creates one with no discount and returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits.
- Then: The response is HTTP 200 with the Checkout URL. Stripe receives a `payment`-mode Checkout session for the customer with 20 units of the custom credit-unit price, promotion codes allowed, invoice creation enabled with credit-purchase metadata (`type` and `purpose` `credit_purchase`, `orgId`, `purchaseCreatedAt`, `creditsAmountMode: "amount_subtotal"`, `requestedCreditsAmount: "20000"`), and matching session metadata.

## billing-credit-checkout-003

- Vitest: "POST /api/billing/credit-checkout > automatically applies the customer's coupon"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription, and its Stripe customer has a coupon discount. Stripe returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits.
- Then: The response is HTTP 200 with the Checkout URL. Stripe retrieves the organization's customer, and the `payment`-mode Checkout session uses 20 units of the custom credit-unit price with the customer's coupon in `discounts` and without `allow_promotion_codes`.

## billing-credit-checkout-004

- Vitest: "POST /api/billing/credit-checkout > preserves the credit purchase preview timestamp at confirmation"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription with a saved default card, and its Stripe customer has a coupon discount. Stripe previews the discounted 20,000-credit purchase at 1,800 cents, and later creates, finalizes and pays a 1,800-cent draft invoice.
- When: At a fixed time the admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `previewExistingBilling: true`, calls `POST /api/billing/credit-checkout/confirm` with a tampered preview token, and one minute later confirms with the real preview token.
- Then: The preview returns HTTP 200 with `status: "preview"`, 20,000 credits, 1,800 cents in `usd`, an expiry and a preview token; no Checkout session is created, and the Stripe preview carries the coupon and is not run against the subscribed customer. The tampered confirmation returns HTTP 400 `BAD_REQUEST` and creates no invoice. The real confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`; Stripe creates the invoice for the customer with the saved card, the coupon and credit-purchase metadata whose `purchaseCreatedAt` is the preview time, and adds 20 units of the credit-unit price, both with `credit-purchase:` idempotency keys.

## billing-credit-checkout-005

- Vitest: "POST /api/billing/credit-checkout > uses a legacy subscription source when no higher-priority card exists"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription whose only payment source is a legacy subscription card source; the customer has no default payment method or saved payment methods, only a different customer-level source. Stripe previews the credit purchase and the created invoice reads back as paid.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `supportsInAppPreview: true`, then calls `POST /api/billing/credit-checkout/confirm` with the preview token.
- Then: The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. Stripe creates the invoice for the customer with `default_source` set to the subscription's card source and no `default_payment_method`.

## billing-credit-checkout-006

- Vitest: "POST /api/billing/credit-checkout > rejects payment when the finalized invoice amount differs from the preview"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription with a saved default card. Stripe previews the 20,000-credit purchase, creates a draft invoice, but finalizes it at 1,900 cents instead of the previewed amount, and accepts voiding it.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `previewExistingBilling: true`, then calls `POST /api/billing/credit-checkout/confirm` with the preview token.
- Then: The confirmation returns HTTP 400 with code `BAD_REQUEST`. Stripe voids the invoice with a `credit-purchase:` idempotency key and never pays it.

## billing-credit-checkout-007

- Vitest: "POST /api/billing/credit-checkout > returns completed when customer balance pays the invoice during finalization"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription with a saved default card. Stripe previews the 20,000-credit purchase, creates a draft invoice, and finalization marks it paid with 0 cents due because the customer balance covers it.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `previewExistingBilling: true`, then calls `POST /api/billing/credit-checkout/confirm` with the preview token.
- Then: The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`. Stripe does not pay, void or delete the invoice.

## billing-credit-checkout-008

- Vitest: "POST /api/billing/credit-checkout > returns the hosted invoice when saved-billing payment requires authentication"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription with a saved default card. Stripe previews the 20,000-credit purchase, creates and finalizes the invoice as open with a hosted invoice URL, and rejects payment with `invoice_payment_intent_requires_action`.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `previewExistingBilling: true`, then calls `POST /api/billing/credit-checkout/confirm` with the preview token.
- Then: The confirmation returns HTTP 200 `{ status: "pending_payment", hostedInvoiceUrl: "https://invoice.stripe.com/saved-billing-authentication" }`. Stripe is asked to pay the invoice with a `billing-operation:credit:` idempotency key, and the invoice is retrieved twice.

## billing-credit-checkout-009

- Vitest: "POST /api/billing/credit-checkout > falls back to Stripe checkout when saved billing is unavailable"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription, but neither the subscription nor the customer has a default payment method and no saved payment methods exist. Stripe returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `previewExistingBilling: true`.
- Then: The response is HTTP 200 with the hosted Checkout URL instead of a preview.

## billing-credit-checkout-010

- Vitest: "POST /api/billing/credit-checkout > returns Checkout when all saved cards are removed after preview"
- Mode: run
- Given: A signed-in organization admin's organization has an active Pro subscription with a saved default card, and Stripe previews the 20,000-credit purchase. After the preview, every saved card and source is removed from the subscription and customer, and Stripe returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `supportsInAppPreview: true`, then one minute later calls `POST /api/billing/credit-checkout/confirm` with the preview token.
- Then: The confirmation returns HTTP 200 `{ status: "checkout_required", checkoutUrl: "https://checkout.stripe.com/session/cards-removed" }`. No invoice is created; the Checkout session's metadata and invoice metadata carry `purchaseCreatedAt` equal to the preview time, with a `credit-purchase:` idempotency key.

## billing-credit-checkout-011

- Vitest: "POST /api/billing/credit-checkout > lets a Free workspace buy credits without upgrading its plan"
- Mode: run
- Given: A signed-in organization admin's workspace is on the Free plan with no subscription. Stripe returns a hosted Checkout URL.
- When: The admin reads `GET /api/billing/status`, requests `POST /api/billing/credit-checkout` for 20,000 credits, then reads billing status again.
- Then: The first status shows tier `limited-free-1`, `canBuyCredits` true and no subscription. The checkout returns HTTP 200 with the Checkout URL, using a `payment`-mode session with 20 units of the custom credit-unit price and `credit_purchase` metadata for the organization. Afterwards the status still shows tier `limited-free-1`, no subscription, `autoRechargeAllowed` false and `restrictedBuiltInModels` true.

## billing-credit-checkout-012

- Vitest: "POST /api/billing/credit-checkout > creates credit checkout with a real execution-issued agent token"
- Mode: run
- Given: An organization admin's organization has an active Pro subscription. A thread run started by the admin has issued its execution an Okou agent token. Stripe returns a hosted Checkout URL.
- When: The caller requests `POST /api/billing/credit-checkout` for 20,000 credits with the agent token as the bearer credential.
- Then: The response is HTTP 200 with the Checkout URL, and Stripe receives a `payment`-mode Checkout session for the organization's existing customer.

## billing-credit-checkout-013

- Vitest: "POST /api/billing/credit-checkout > creates custom amount credit checkout with the configured Stripe price"
- Mode: run
- Given: A signed-in organization admin's organization has no Stripe customer; Stripe creates one and returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 150,000 credits with `customAmount: true`.
- Then: The response is HTTP 200 with the Checkout URL. Stripe receives a `payment`-mode session for the new customer with 150 units of the custom credit-unit price, promotion codes allowed, credit-purchase metadata with `requestedCreditsAmount: "150000"` on the session, the created invoice and the payment intent, and `setup_future_usage: "off_session"` on the payment intent.

## billing-credit-checkout-014

- Vitest: "POST /api/billing/credit-checkout > returns 400 when credit price is not configured"
- Mode: run
- Given: A signed-in organization admin's organization exists, and no custom credit-unit Stripe price is configured.
- When: The admin requests `POST /api/billing/credit-checkout` for 100,000 credits.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Custom credit price not configured".
