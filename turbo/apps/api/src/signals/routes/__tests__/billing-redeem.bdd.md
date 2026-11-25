# billing-redeem

## billing-redeem-001

- Vitest: "POST /api/billing/redeem/:campaign > returns 401 when the caller is unauthenticated"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. The caller sends no authorization header.
- When: The caller requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 401.

## billing-redeem-002

- Vitest: "POST /api/billing/redeem/:campaign > returns campaign_misconfigured for an unknown campaign"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin exists.
- When: The admin requests `POST /api/billing/redeem/UNKNOWN` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }`.

## billing-redeem-003

- Vitest: "POST /api/billing/redeem/:campaign > returns 401 when the caller has no active org"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in user has no active organization.
- When: The user requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 401.

## billing-redeem-004

- Vitest: "POST /api/billing/redeem/:campaign > lets unexpected (non-Stripe) errors propagate so Sentry captures the full stack"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has no recorded redemption, and creating the Stripe Checkout session fails with a non-Stripe error ("boom: database unreachable").
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 500.

## billing-redeem-005

- Vitest: "POST /api/billing/redeem/:campaign > returns admin_required for non-admin org members"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "error", reason: "admin_required" }`.

## billing-redeem-006

- Vitest: "POST /api/billing/redeem/:campaign > creates a Stripe Checkout session on first visit and records the row"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has no recorded redemption, and Stripe creates Checkout session `cs_fresh_1`; Stripe later reports that session as open.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin, then requests it again.
- Then: The first request returns HTTP 200 `{ status: "ready", checkoutUrl }` for `cs_fresh_1`. Stripe's session is created in `payment` mode with the campaign price × 1, the campaign coupon discount, the requested success and cancel URLs, `setup_future_usage: "off_session"`, and metadata `{ orgId, campaignKey: "ZERO100", purpose: "one_time_purchase" }` on both the session and payment intent. The second request returns the same checkout URL after retrieving `cs_fresh_1`, without creating a new session.

## billing-redeem-007

- Vitest: "POST /api/billing/redeem/:campaign > resumes to the same Stripe URL when the existing session is still open"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_1` that Stripe still reports as open.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "ready", checkoutUrl }` for `cs_open_1`, and no new Stripe session is created.

## billing-redeem-008

- Vitest: "POST /api/billing/redeem/:campaign > drops the cached session and returns campaign_misconfigured when the coupon was deleted"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_stale` that Stripe still reports as open. Stripe reports the campaign coupon as missing (`resource_missing`).
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin; then, after the coupon is valid again, requests it again.
- Then: The first request returns HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }` and Stripe is asked to expire `cs_open_stale`. The follow-up returns `{ status: "ready", checkoutUrl }` for a newly created session instead of resuming the old one.

## billing-redeem-009

- Vitest: "POST /api/billing/redeem/:campaign > still drops the cached session row when expiring it in Stripe fails"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_expire_fails` that Stripe still reports as open. Stripe reports the campaign coupon as missing, and expiring the session in Stripe fails with an invalid-request error.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin; then, after the coupon is valid again, requests it again.
- Then: The first request returns HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }` and Stripe is asked to expire `cs_open_expire_fails`. The follow-up returns `{ status: "ready", checkoutUrl }` for a newly created session instead of resuming the old one.

## billing-redeem-010

- Vitest: "POST /api/billing/redeem/:campaign > drops the cached session and returns campaign_misconfigured when the coupon is no longer valid"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_invalid` that Stripe still reports as open. Stripe reports the coupon as no longer valid (`valid: false`, redeem-by in the past).
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin; then, after the coupon is valid again, requests it again.
- Then: The first request returns HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }` and Stripe is asked to expire `cs_open_invalid`. The follow-up returns `{ status: "ready", checkoutUrl }` for a newly created session instead of resuming the old one.

## billing-redeem-011

- Vitest: "POST /api/billing/redeem/:campaign > drops the cached session and returns campaign_misconfigured when the price was deleted"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_price_gone` that Stripe still reports as open. Stripe reports the campaign price as missing (`resource_missing`).
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin; then, after the price exists again, requests it again.
- Then: The first request returns HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }` and Stripe is asked to expire `cs_open_price_gone`. The follow-up returns `{ status: "ready", checkoutUrl }` for a newly created session instead of resuming the old one.

## billing-redeem-012

- Vitest: "POST /api/billing/redeem/:campaign > drops the cached session and returns campaign_misconfigured when the price is archived"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_open_price_archived` that Stripe still reports as open. Stripe reports the campaign price as archived (`active: false`).
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin; then, after the price is active again, requests it again.
- Then: The first request returns HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }` and Stripe is asked to expire `cs_open_price_archived`. The follow-up returns `{ status: "ready", checkoutUrl }` for a newly created session instead of resuming the old one.

## billing-redeem-013

- Vitest: "POST /api/billing/redeem/:campaign > rotates to a new Stripe session when the existing one has expired"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_expired_1` that Stripe now reports as expired. Stripe creates a new session `cs_fresh_2`, which it later reports as open.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin, then requests it again.
- Then: Both requests return HTTP 200 `{ status: "ready", checkoutUrl }` for `cs_fresh_2`, and the second request retrieves `cs_fresh_2` from Stripe.

## billing-redeem-014

- Vitest: "POST /api/billing/redeem/:campaign > returns already_granted when credits have landed"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_granted_1`, and a Stripe `checkout.session.completed` webhook for that session has granted 100,000 one-time purchase credits.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "already_granted" }` without creating or retrieving a Stripe Checkout session.

## billing-redeem-015

- Vitest: "POST /api/billing/redeem/:campaign > returns campaign_misconfigured when Stripe rejects the session at create time with a non-invalid-request error"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has no recorded redemption, and Stripe rejects session creation with an API error ("Coupon ZERO100 is expired and cannot be applied.").
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }`.

## billing-redeem-016

- Vitest: "POST /api/billing/redeem/:campaign > returns campaign_misconfigured when Stripe coupon is missing at create time"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has no recorded redemption, and Stripe rejects session creation with an invalid-request error for a missing coupon (`discounts[0][coupon]`).
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "error", reason: "campaign_misconfigured" }`.

## billing-redeem-017

- Vitest: "POST /api/billing/redeem/:campaign > returns processing when Stripe session is complete but webhook hasn't landed yet"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin has already started redemption, so the organization has a recorded open Checkout session `cs_complete_1` that Stripe now reports as complete, but no completion webhook has granted credits yet.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "processing" }`.

## billing-redeem-018

- Vitest: "POST /api/billing/redeem/:campaign > returns billing_unavailable before auth when STRIPE_SECRET_KEY is not configured"
- Mode: run
- Given: Stripe billing is not configured (no Stripe secret key), and the caller sends no authorization header.
- When: The caller requests `POST /api/billing/redeem/ZERO100` with success and cancel URLs on the app origin.
- Then: The API responds with HTTP 200 `{ status: "error", reason: "billing_unavailable" }`.

## billing-redeem-019

- Vitest: "POST /api/billing/redeem/:campaign > rejects successUrl/cancelUrl whose origin does not match APP_URL"
- Mode: run
- Given: Stripe billing is configured, the app URL is `http://app.localhost:3002`, and the one-time campaign `ZERO100` maps to a price and coupon; Stripe reports the coupon valid and the price active by default. A signed-in org admin exists.
- When: The admin requests `POST /api/billing/redeem/ZERO100` with `successUrl` `https://evil.example.com/redeem/callback?stripe=success` and a cancel URL on the app origin.
- Then: The API responds with HTTP 400 and the error `{ message: "successUrl and cancelUrl must match the platform origin", code: "BAD_REQUEST" }`.
