# billing-credit-checkout-auto-recharge

## billing-credit-checkout-auto-recharge-001

- Vitest: "credit checkout auto-recharge ownership > publishes a default Plan before rejecting auto-recharge for a new workspace"
- Mode: run
- Given: A signed-in organization admin's new workspace has no billing Plan or Stripe customer. Stripe creates customers and returns a hosted Checkout URL.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with auto-recharge enabled (threshold 5,000, amount 20,000), reads `GET /api/billing/auto-recharge`, then requests the same credit checkout without auto-recharge.
- Then: The first request returns HTTP 400 with code `BAD_REQUEST` and message "Auto-recharge is only available for Pro or Team workspaces". Auto-recharge reads back as disabled with null threshold and amount. The plain checkout returns HTTP 200 with the Checkout URL, and Stripe creates exactly one Checkout session.

## billing-credit-checkout-auto-recharge-002

- Vitest: "credit checkout auto-recharge ownership > keeps the default Plan usable after concurrent new-workspace checkout requests"
- Mode: run
- Given: A signed-in organization admin's new workspace has no billing Plan or Stripe customer. Stripe creates customers and returns a hosted Checkout URL.
- When: The admin sends two concurrent `POST /api/billing/credit-checkout` requests for 20,000 credits with auto-recharge enabled, reads `GET /api/billing/auto-recharge`, then requests the same credit checkout without auto-recharge.
- Then: Both concurrent requests return HTTP 400 with code `BAD_REQUEST`. Auto-recharge reads back as disabled with null threshold and amount. The plain checkout returns HTTP 200 with the Checkout URL, and Stripe creates exactly one Checkout session.

## billing-credit-checkout-auto-recharge-003

- Vitest: "credit checkout auto-recharge ownership > updates repeated enabled checkout config without replacing the existing Plan, then disables after hosted checkout"
- Mode: run
- Given: A signed-in organization admin's workspace has an active Pro subscription. Stripe returns a hosted Checkout URL for credit purchases.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with auto-recharge `{ enabled: true, threshold: 5000, amount: 20000 }`, then with `{ enabled: true, threshold: 10000, amount: 50000 }`, then with `{ enabled: false }`.
- Then: Every request returns HTTP 200 with the Checkout URL. After each enabled request `GET /api/billing/auto-recharge` returns exactly that config and `GET /api/billing/status` still shows tier `pro` with `canBuyCredits` and `autoRechargeAllowed` true. After the disable request, auto-recharge reads back as disabled with null threshold and amount.

## billing-credit-checkout-auto-recharge-004

- Vitest: "credit checkout auto-recharge ownership > preserves config commit ordering when hosted Checkout fails (enabled=true)"
- Mode: run
- Given: A signed-in organization admin's Pro workspace has auto-recharge enabled at threshold 5,000 and amount 20,000 from an earlier credit checkout. Stripe Checkout session creation fails once.
- When: The admin requests `POST /api/billing/credit-checkout` with auto-recharge `{ enabled: true, threshold: 10000, amount: 50000 }`, then retries a credit checkout without auto-recharge.
- Then: The failed request returns HTTP 500 `{ error: "Internal server error" }`, and `GET /api/billing/auto-recharge` already returns the new config (threshold 10,000, amount 50,000). The retry returns HTTP 200 with the Checkout URL and the new config remains.

## billing-credit-checkout-auto-recharge-005

- Vitest: "credit checkout auto-recharge ownership > preserves config commit ordering when hosted Checkout fails (enabled=false)"
- Mode: run
- Given: A signed-in organization admin's Pro workspace has auto-recharge enabled at threshold 5,000 and amount 20,000 from an earlier credit checkout. Stripe Checkout session creation fails once.
- When: The admin requests `POST /api/billing/credit-checkout` with auto-recharge `{ enabled: false, threshold: 10000, amount: 50000 }`, then retries a credit checkout without auto-recharge.
- Then: The failed request returns HTTP 500 `{ error: "Internal server error" }`, and `GET /api/billing/auto-recharge` still returns the original enabled config (threshold 5,000, amount 20,000). The retry returns HTTP 200 with the Checkout URL and the original config remains.

## billing-credit-checkout-auto-recharge-006

- Vitest: "credit checkout auto-recharge ownership > leaves auto-recharge enabled when a disable request returns an in-app preview"
- Mode: run
- Given: A signed-in organization admin's Pro workspace has auto-recharge enabled at threshold 5,000 and amount 20,000. The Pro subscription has a saved default card, and Stripe previews a 2,000-cent credit invoice.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with `supportsInAppPreview: true` and auto-recharge `{ enabled: false }`.
- Then: The response is HTTP 200 with a `preview` for 20,000 credits at 2,000 cents and a preview token. `GET /api/billing/auto-recharge` still returns the original enabled config, and no Stripe Checkout session is created.

## billing-credit-checkout-auto-recharge-007

- Vitest: "credit checkout auto-recharge ownership > rejects an invalid credit-purchase preview for a Free workspace"
- Mode: run
- Given: A signed-in organization admin's workspace is on the Free plan.
- When: The admin calls `POST /api/billing/credit-checkout/confirm` with preview token `not-a-valid-preview`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message "Credit purchase preview expired or is no longer valid", and no Stripe invoice is created.

## billing-credit-checkout-auto-recharge-008

- Vitest: "credit checkout auto-recharge ownership > rejects invalid enabled config without changing persisted settings ({\"enabled\":true,\"amount\":20000})"
- Mode: run
- Given: A signed-in organization admin's workspace has an active Pro subscription and auto-recharge disabled.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with auto-recharge `{ enabled: true, amount: 20000 }` (no threshold).
- Then: The response is HTTP 400 with code `BAD_REQUEST`. `GET /api/billing/auto-recharge` still returns disabled with null threshold and amount, and no Stripe Checkout session is created.

## billing-credit-checkout-auto-recharge-009

- Vitest: "credit checkout auto-recharge ownership > rejects invalid enabled config without changing persisted settings ({\"enabled\":true,\"threshold\":20000,\"amount\":20000})"
- Mode: run
- Given: A signed-in organization admin's workspace has an active Pro subscription and auto-recharge disabled.
- When: The admin requests `POST /api/billing/credit-checkout` for 20,000 credits with auto-recharge `{ enabled: true, threshold: 20000, amount: 20000 }` (threshold equal to amount).
- Then: The response is HTTP 400 with code `BAD_REQUEST`. `GET /api/billing/auto-recharge` still returns disabled with null threshold and amount, and no Stripe Checkout session is created.

## billing-credit-checkout-auto-recharge-010

- Vitest: "credit checkout auto-recharge ownership > returns the provider-config guard before authentication for both routes"
- Mode: run
- Given: The Stripe secret key is not configured, and the caller presents a session token that does not authenticate.
- When: The caller requests `POST /api/billing/credit-checkout` for 20,000 credits and `POST /api/billing/credit-checkout/confirm` with an invalid preview token.
- Then: Both responses are HTTP 503 with code `PROVIDER_UNAVAILABLE` and message "Billing not configured".
