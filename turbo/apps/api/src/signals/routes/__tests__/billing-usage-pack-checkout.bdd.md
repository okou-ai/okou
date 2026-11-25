# billing-usage-pack-checkout

## billing-usage-pack-checkout-001

- Vitest: "POST /api/billing/usage-pack-checkout > returns the server-validated Stripe usage pack catalog"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists.
- When: The admin requests `GET /api/billing/usage-pack-catalog`.
- Then: The API responds with HTTP 200, `supportsFreeMembers: true`, and four usage packs: $20 (20,000 purchased + 400 bonus = 20,400 credits), $50 (50,000 + 2,600 = 52,600), $100 (100,000 + 8,700 = 108,700) and $200 (200,000 + 22,200 = 222,200), each priced at its pack amount.

## billing-usage-pack-checkout-002

- Vitest: "POST /api/billing/usage-pack-checkout > rejects pro checkout without a paid usage pack"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Parameter row: `pro`.
- When: The admin requests `POST /api/billing/usage-pack-checkout` with `tier: "pro"` and only themselves assigned a `usagePackUsd: 0` pack.
- Then: The API responds with HTTP 400 and the error `{ message: "At least one member must have a paid usage pack", code: "BAD_REQUEST" }`.

## billing-usage-pack-checkout-003

- Vitest: "POST /api/billing/usage-pack-checkout > rejects team checkout without a paid usage pack"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Parameter row: `team`.
- When: The admin requests `POST /api/billing/usage-pack-checkout` with `tier: "team"` and only themselves assigned a `usagePackUsd: 0` pack.
- Then: The API responds with HTTP 400 and the error `{ message: "At least one member must have a paid usage pack", code: "BAD_REQUEST" }`.

## billing-usage-pack-checkout-004

- Vitest: "POST /api/billing/usage-pack-checkout > checks out pro with both paid and no-package members"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization has a second member; Clerk lists both and no invitations. Stripe creates a customer and a Checkout session. Parameter row: `pro`.
- When: The admin requests `POST /api/billing/usage-pack-checkout` with `tier: "pro"`, a $20 pack for themselves and `usagePackUsd: 0` for the other member.
- Then: The API responds with HTTP 200. Stripe Checkout is created with a usage pack subscription snapshot ID in its metadata and line items of the Pro usage-pack plan × 1 and the $20 pack × 1 (no line for the no-package member).

## billing-usage-pack-checkout-005

- Vitest: "POST /api/billing/usage-pack-checkout > checks out team with both paid and no-package members"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization has a second member; Clerk lists both and no invitations. Stripe creates a customer and a Checkout session. Parameter row: `team`.
- When: The admin requests `POST /api/billing/usage-pack-checkout` with `tier: "team"`, a $20 pack for themselves and `usagePackUsd: 0` for the other member.
- Then: The API responds with HTTP 200. Stripe Checkout is created with a usage pack subscription snapshot ID in its metadata and line items of the Team usage-pack plan × 1 and the $20 pack × 1 (no line for the no-package member).

## billing-usage-pack-checkout-006

- Vitest: "POST /api/billing/usage-pack-checkout > checks out the new plan"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization belongs to an organization whose Clerk membership list has 101 members across two pages and one pending invitation. Stripe creates a customer and a Checkout session.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for `tier: "team"` assigning the four pack sizes $20, $50, $100 and $200 to the first four members, $20 to every other member, and $20 to the pending invitation.
- Then: The API responds with HTTP 200 and the Checkout URL. Stripe Checkout is created in `subscription` mode for the customer with line items Team usage-pack plan × 1, $20 pack × 99, $50 × 1, $100 × 1 and $200 × 1, promotion codes allowed, the requested success and cancel URLs, and metadata (also on the subscription) `{ orgId, tier: "team", priceId: <Team usage-pack plan>, purpose: "usage_pack_subscription", usagePackSubscriptionId }`, with idempotency key `usage-pack-checkout:<snapshot ID>`. Clerk memberships are read with `limit: 100` at offsets 0 and 100.

## billing-usage-pack-checkout-007

- Vitest: "POST /api/billing/usage-pack-checkout > separates the immediate balance-adjusted charge from the recurring amount"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer with a saved default payment method; Stripe's `next` invoice preview is 2000 cents and the `recurring` preview is 4000 cents. Stripe then creates an active Pro usage pack subscription whose first invoice is paid.
- When: The admin requests `POST /api/billing/usage-pack-checkout` with `supportsInAppPreview: true`, `tier: "pro"` and a $20 pack, then confirms the returned preview token through `POST /api/billing/usage-pack-checkout/confirm`.
- Then: The preview responds with HTTP 200 `{ status: "preview", purchaseType: "usage_pack", tier: "pro", immediateAmountCents: 2000, nextRecurringAmountCents: 4000, currency: "usd", expiresAt, previewToken }`, after Stripe previews both `next` and `recurring` modes. The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`.

## billing-usage-pack-checkout-008

- Vitest: "POST /api/billing/usage-pack-checkout > recovers usage pack checkout from a transient Clerk server failure"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Clerk's first membership read fails with a transient 521 server error and later succeeds listing only the admin; there are no invitations. Stripe creates a customer and a Checkout session.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack.
- Then: The API responds with HTTP 200 and the recovered Checkout URL. Clerk memberships are read twice with one retry delay, and exactly one Checkout session is created.

## billing-usage-pack-checkout-009

- Vitest: "POST /api/billing/usage-pack-checkout > returns a non-cacheable 503 on the first Clerk rate limit"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Clerk's membership read is rate-limited (429) with `Retry-After` 7 seconds; invitations are empty.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack.
- Then: The API responds with HTTP 503, the error `{ message: "Billing organization members are temporarily unavailable", code: "PROVIDER_UNAVAILABLE" }`, `Retry-After: 7` and `Cache-Control: no-store`. Clerk memberships are read once without a retry delay, and no Stripe customer or Checkout session is created.

## billing-usage-pack-checkout-010

- Vitest: "POST /api/billing/usage-pack-checkout > preserves non-rate-limit Clerk checkout failures"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Clerk's membership read fails with a non-rate-limit error; invitations are empty.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack.
- Then: The API responds with HTTP 500 `{ error: "Internal server error" }`. Clerk memberships are read once without a retry delay, and no Stripe customer or Checkout session is created.

## billing-usage-pack-checkout-011

- Vitest: "POST /api/billing/usage-pack-checkout > stops sibling Clerk pagination after a checkout directory rate limit"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization exists. Clerk's membership read is rate-limited with `Retry-After` 1 second while the first invitation page is still pending.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack; afterwards the pending invitation page resolves with a full page of 100 invitations.
- Then: The API responds with HTTP 503 and `Retry-After: 1` without a retry delay. Memberships and invitations are each read once, no Stripe customer or Checkout session is created, and no further invitation page is requested after the first page resolves.

## billing-usage-pack-checkout-012

- Vitest: "POST /api/billing/usage-pack-checkout > keeps only one payable Checkout across concurrent different configurations"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization has an existing Stripe customer and is the only member. Stripe Checkout sessions are tracked as open or expired.
- When: The admin reads `GET /api/billing/status`, sends two concurrent `POST /api/billing/usage-pack-checkout` requests for Pro with a $20 pack and with a $50 pack, then requests Pro with a $100 pack, and reads billing status again.
- Then: The concurrent requests return HTTP 200 or 409, with at least one 200. One or two Checkout sessions are created (each carrying a usage pack subscription snapshot ID and the requested pack), every extra session is expired, and exactly one session remains open. The $100 replacement returns HTTP 200 with a Stripe Checkout URL, and still exactly one session is open. Billing tier and credits are unchanged.

## billing-usage-pack-checkout-013

- Vitest: "POST /api/billing/usage-pack-checkout > renews the expiry of a reused purchase preview"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. The clock is fixed at 2035-05-15T00:00Z. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD.
- When: The admin requests an in-app preview through `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack, the clock advances 14 minutes, and the admin requests the same preview again.
- Then: The first preview's `expiresAt` is 15 minutes after the start; the reused preview's `expiresAt` is renewed to 29 minutes after the start.

## billing-usage-pack-checkout-014

- Vitest: "POST /api/billing/usage-pack-checkout > rejects a usage pack preview after a replacement retires its snapshot"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD.
- When: The admin requests an in-app preview through `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack, then a replacement preview with a $50 pack, then confirms the first preview token through `POST /api/billing/usage-pack-checkout/confirm`.
- Then: The confirmation responds with HTTP 409 and the Invalid preview error `{ message: "Usage pack purchase preview is no longer valid", code: "CONFLICT" }`, and no Stripe subscription is created.

## billing-usage-pack-checkout-015

- Vitest: "POST /api/billing/usage-pack-checkout > rejects a replacement usage pack purchase while a confirmation owns the claim"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD. The admin has an in-app preview for Pro with a $20 pack. While Stripe is creating the subscription for its confirmation, the admin requests a replacement $50 preview; Stripe then returns an active subscription with no invoice.
- When: The admin confirms the preview through `POST /api/billing/usage-pack-checkout/confirm` (during which the replacement request is sent), then confirms the same preview again.
- Then: The replacement request returns HTTP 409. The confirmation returns HTTP 200 `{ status: "completed", hostedInvoiceUrl: null }`; the repeat returns the same body after retrieving the subscription with `latest_invoice` expanded. Stripe creates the subscription exactly once and never cancels it.

## billing-usage-pack-checkout-016

- Vitest: "POST /api/billing/usage-pack-checkout > retires an unpaid claim after quote changed and permits a fresh preview"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD. The admin has obtained an in-app purchase preview for Pro with a $20 pack. Before confirmation, Stripe's invoice preview changes to 4100 cents. Parameter row: `quote changed`.
- When: The admin confirms the preview through `POST /api/billing/usage-pack-checkout/confirm`, confirms the same preview token again, and then, with Stripe quoting the original 4000 cents again, requests a new preview through `POST /api/billing/usage-pack-checkout`.
- Then: The first confirmation returns HTTP 409 with the Invalid preview error `{ message: "Usage pack purchase preview is no longer valid", code: "CONFLICT" }`; no Stripe subscription or Checkout session is created. The replay returns HTTP 409 with the Invalid preview error `{ message: "Usage pack purchase preview is no longer valid", code: "CONFLICT" }`. The new preview returns `status: "preview"` with immediate and next recurring amounts of 4000 cents USD and a different preview token, and still no subscription or Checkout session is created.

## billing-usage-pack-checkout-017

- Vitest: "POST /api/billing/usage-pack-checkout > retires an unpaid claim after provider rejection and permits a fresh preview"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD. The admin has obtained an in-app purchase preview for Pro with a $20 pack. Before confirmation, Stripe's invoice preview request fails. Parameter row: `provider rejection`.
- When: The admin confirms the preview through `POST /api/billing/usage-pack-checkout/confirm`, confirms the same preview token again, and then, with Stripe quoting the original 4000 cents again, requests a new preview through `POST /api/billing/usage-pack-checkout`.
- Then: The first confirmation returns HTTP 500; no Stripe subscription or Checkout session is created. The replay returns HTTP 409 with the Invalid preview error `{ message: "Usage pack purchase preview is no longer valid", code: "CONFLICT" }`. The new preview returns `status: "preview"` with immediate and next recurring amounts of 4000 cents USD and a different preview token, and still no subscription or Checkout session is created.

## billing-usage-pack-checkout-018

- Vitest: "POST /api/billing/usage-pack-checkout > retires an unpaid claim after provider Abort and permits a fresh preview"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD. The admin has obtained an in-app purchase preview for Pro with a $20 pack. Before confirmation, the confirming request is aborted while Stripe answers the invoice preview. Parameter row: `provider Abort`.
- When: The admin confirms the preview through `POST /api/billing/usage-pack-checkout/confirm`, confirms the same preview token again, and then, with Stripe quoting the original 4000 cents again, requests a new preview through `POST /api/billing/usage-pack-checkout`.
- Then: The first confirmation returns HTTP 500; no Stripe subscription or Checkout session is created. The replay returns HTTP 409 with the Invalid preview error `{ message: "Usage pack purchase preview is no longer valid", code: "CONFLICT" }`. The new preview returns `status: "preview"` with immediate and next recurring amounts of 4000 cents USD and a different preview token, and still no subscription or Checkout session is created.

## billing-usage-pack-checkout-019

- Vitest: "POST /api/billing/usage-pack-checkout > attempts the saved card for an open usage pack invoice"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer, reports a saved default payment method, and previews an invoice of 4000 cents USD. Stripe creates an `incomplete` Pro usage pack subscription whose latest invoice is open with a hosted invoice URL, and paying it with the saved card fails because customer authentication is required.
- When: The admin requests an in-app preview through `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack and confirms it through `POST /api/billing/usage-pack-checkout/confirm`.
- Then: The confirmation responds with HTTP 200 `{ status: "pending_payment", hostedInvoiceUrl }`, and Stripe is asked to pay the open invoice with an idempotency key containing `billing-operation:usage-pack:`.

## billing-usage-pack-checkout-020

- Vitest: "POST /api/billing/usage-pack-checkout > reuses concurrent usage pack previews after a delayed provider response"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer with a saved default payment method and previews 4000 cents, but the first preview response is delayed. Stripe creation of the subscription is held until the other confirmation has answered.
- When: The admin sends an in-app preview request through `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack, sends a second identical preview while the first waits, lets the first complete, reads `GET /api/billing/status`, and then confirms both preview tokens concurrently through `POST /api/billing/usage-pack-checkout/confirm`.
- Then: Both previews show immediate and next recurring amounts of 4000 cents USD, and billing status still shows tier `limited-free-1` with no subscription. The first confirmation to answer is HTTP 409; the final statuses are one 200 and one 409. Stripe creates exactly one subscription, for the customer with the saved payment method, and cancels none.

## billing-usage-pack-checkout-021

- Vitest: "POST /api/billing/usage-pack-checkout > reuses Checkout after its Session response outlives the cancelled request"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer with no saved payment method. Stripe returns a Checkout session URL, but the API request is cancelled while Stripe is answering. Stripe later reports that session as open.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack (cancelled request), then requests it again.
- Then: The cancelled request returns HTTP 500 and no session is expired. The retry returns HTTP 200 with the original Checkout URL after retrieving the original session; only one session is ever created and none is expired.

## billing-usage-pack-checkout-022

- Vitest: "POST /api/billing/usage-pack-checkout > reuses an open Checkout when repeated usage pack previews lose their saved card"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe reports a saved default payment method for the first two customer reads and none afterwards, previews 4000 cents, and creates one Checkout session that it reports as open.
- When: The admin requests two in-app previews through `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack using different success and cancel URLs, submits each preview token back through `POST /api/billing/usage-pack-checkout`, and then repeats the purchase without a preview token.
- Then: Both token submissions return HTTP 200 `{ status: "checkout_required", checkoutUrl }` with the same URL, and the repeated purchase returns `{ url: checkoutUrl }`. Stripe creates the Checkout session once and retrieves it twice.

## billing-usage-pack-checkout-023

- Vitest: "POST /api/billing/usage-pack-checkout > expires a known Checkout without a URL before replacing its snapshot"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization is the only member. Stripe creates the customer with no saved payment method. Stripe's first Checkout session is created without a URL; a later session has a URL and is reported as open.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro with a $20 pack, then requests Pro with a $50 pack twice.
- Then: The first request returns HTTP 500 and Stripe expires the URL-less session. The $50 request returns HTTP 200 with the new Checkout URL; the replacement session uses line items Pro usage-pack plan × 1 and $50 pack × 1 and a different `usage-pack-checkout:` idempotency key. The repeat returns the same URL without creating another session, and only the original session is ever expired.

## billing-usage-pack-checkout-024

- Vitest: "POST /api/billing/usage-pack-checkout > rejects stale member selections before creating checkout"
- Mode: run
- Given: Pro and Team plan prices, usage-pack plan prices and the $20, $50, $100 and $200 usage pack prices are configured, and Stripe returns a matching usage pack catalog. A signed-in org admin of a free organization belongs to an organization where Clerk lists the admin and another member, and no invitations.
- When: The admin requests `POST /api/billing/usage-pack-checkout` for Pro assigning a $20 pack only to themselves.
- Then: The API responds with HTTP 400 and the error `{ message: "Organization members changed; refresh billing and try again", code: "BAD_REQUEST" }`, and no Checkout session is created.
