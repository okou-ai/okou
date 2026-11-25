# billing-portal

## billing-portal-001

- Vitest: "POST /api/billing/portal > returns 503 when STRIPE_SECRET_KEY is not configured"
- Mode: run
- Given: Stripe billing is not configured (no Stripe secret key), and a signed-in user with an organization calls the API.
- When: The user requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The API responds with HTTP 503 and the error `{ message: "Billing not configured", code: "PROVIDER_UNAVAILABLE" }`.

## billing-portal-002

- Vitest: "POST /api/billing/portal > returns 401 when not authenticated"
- Mode: run
- Given: The caller sends no authorization header.
- When: The caller requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The API responds with HTTP 401 and the error `{ message: "Not authenticated", code: "UNAUTHORIZED" }`.

## billing-portal-003

- Vitest: "POST /api/billing/portal > returns 403 for a non-admin org member"
- Mode: run
- Given: A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The API responds with HTTP 403 and the error `{ message: "Only org admins can manage billing", code: "FORBIDDEN" }`.

## billing-portal-004

- Vitest: "POST /api/billing/portal > returns portal URL to the allowed origin http://app.localhost:3002/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002` and Stripe lists one active payment-method portal configuration (`bpc_payment_methods`, only payment method updates enabled, `purpose: "payment_method_management"`). A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe creates a portal session URL. Parameter row: return URL `http://app.localhost:3002/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "http://app.localhost:3002/settings/billing"`.
- Then: The API responds with HTTP 200 and the Stripe session `url`. The Stripe portal session is created for the organization's customer with configuration `bpc_payment_methods` and `return_url` `http://app.localhost:3002/settings/billing`.

## billing-portal-005

- Vitest: "POST /api/billing/portal > returns portal URL to the allowed origin https://okou.ai/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002` and Stripe lists one active payment-method portal configuration (`bpc_payment_methods`, only payment method updates enabled, `purpose: "payment_method_management"`). A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe creates a portal session URL. Parameter row: return URL `https://okou.ai/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "https://okou.ai/settings/billing"`.
- Then: The API responds with HTTP 200 and the Stripe session `url`. The Stripe portal session is created for the organization's customer with configuration `bpc_payment_methods` and `return_url` `https://okou.ai/settings/billing`.

## billing-portal-006

- Vitest: "POST /api/billing/portal > returns portal URL to the allowed origin https://console.okou.ai/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002` and Stripe lists one active payment-method portal configuration (`bpc_payment_methods`, only payment method updates enabled, `purpose: "payment_method_management"`). A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe creates a portal session URL. Parameter row: return URL `https://console.okou.ai/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "https://console.okou.ai/settings/billing"`.
- Then: The API responds with HTTP 200 and the Stripe session `url`. The Stripe portal session is created for the organization's customer with configuration `bpc_payment_methods` and `return_url` `https://console.okou.ai/settings/billing`.

## billing-portal-007

- Vitest: "POST /api/billing/portal > returns portal URL to the allowed origin https://pr-22085-app.omby.ai/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002` and Stripe lists one active payment-method portal configuration (`bpc_payment_methods`, only payment method updates enabled, `purpose: "payment_method_management"`). A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe creates a portal session URL. Parameter row: return URL `https://pr-22085-app.omby.ai/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "https://pr-22085-app.omby.ai/settings/billing"`.
- Then: The API responds with HTTP 200 and the Stripe session `url`. The Stripe portal session is created for the organization's customer with configuration `bpc_payment_methods` and `return_url` `https://pr-22085-app.omby.ai/settings/billing`.

## billing-portal-008

- Vitest: "POST /api/billing/portal > reuses the payment method portal despite unrelated stored metadata"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`. A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe lists the payment-method portal configuration `bpc_payment_methods` with an extra unrelated metadata key (`retired_marker`) besides `purpose: "payment_method_management"`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl` `http://app.localhost:3002/settings/billing`.
- Then: The API responds with HTTP 200 and the Stripe session URL. Stripe portal configurations are listed with `limit: 100`, and the session is created for the customer with the existing configuration `bpc_payment_methods` and the requested return URL.

## billing-portal-009

- Vitest: "POST /api/billing/portal > does not open a portal with multiple purpose matches"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`. A signed-in org admin's organization has no Stripe customer yet, and Stripe can create one. Parameter row: multiple purpose matches — Stripe's portal configuration list contains two configurations tagged `purpose: "payment_method_management"`.
- When: The admin requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The API responds with HTTP 500. Stripe portal configurations are listed with `limit: 100`, and no portal session is created.

## billing-portal-010

- Vitest: "POST /api/billing/portal > does not open a portal with an incomplete configuration list"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`. A signed-in org admin's organization has no Stripe customer yet, and Stripe can create one. Parameter row: an incomplete configuration list — Stripe's portal configuration list returns the matching configuration but reports `has_more: true`.
- When: The admin requests `POST /api/billing/portal` with a return URL on the app origin.
- Then: The API responds with HTTP 500. Stripe portal configurations are listed with `limit: 100`, and no portal session is created.

## billing-portal-011

- Vitest: "POST /api/billing/portal > creates a customer for payment method management without a subscription"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`. A signed-in org admin's organization has no Stripe customer or subscription. Stripe lists no portal configurations and can create a customer, a configuration and a session.
- When: The admin requests `POST /api/billing/portal` with `returnUrl` `http://app.localhost:3002/settings/billing`.
- Then: The API responds with HTTP 200 and the Stripe session URL. Stripe creates a customer with `metadata.orgId` and idempotency key `stripe-customer:development::<orgId>`, creates a portal configuration named "Okou payment methods" with only payment method updates enabled, login page disabled and `purpose: "payment_method_management"` (idempotency key `payment-method-portal-v2`), and creates the session for the new customer with that configuration and the return URL.

## billing-portal-012

- Vitest: "POST /api/billing/portal > repairs a managed portal configuration before creating a session"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`. A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe's managed payment-method portal configuration has subscription cancellation enabled.
- When: The admin requests `POST /api/billing/portal` with `returnUrl` `http://app.localhost:3002/settings/billing`.
- Then: The API responds with HTTP 200 and the Stripe session URL. Stripe updates `bpc_payment_methods` to be active, named "Okou payment methods", with only payment method updates enabled, login page disabled and `purpose: "payment_method_management"`, and then creates the session for the customer with that configuration and the return URL.

## billing-portal-013

- Vitest: "POST /api/billing/portal > returns 400 for the disallowed origin in https://evil.example.com/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`, and a signed-in org admin exists. Parameter row: return URL `https://evil.example.com/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "https://evil.example.com/settings/billing"`.
- Then: The API responds with HTTP 400 and the error `{ message: "returnUrl must match the platform origin", code: "BAD_REQUEST" }`.

## billing-portal-014

- Vitest: "POST /api/billing/portal > returns 400 for the disallowed origin in https://okou.ai.evil.example/settings/billing"
- Mode: run
- Given: The app URL is `http://app.localhost:3002`, and a signed-in org admin exists. Parameter row: return URL `https://okou.ai.evil.example/settings/billing`.
- When: The admin requests `POST /api/billing/portal` with `returnUrl: "https://okou.ai.evil.example/settings/billing"`.
- Then: The API responds with HTTP 400 and the error `{ message: "returnUrl must match the platform origin", code: "BAD_REQUEST" }`.
