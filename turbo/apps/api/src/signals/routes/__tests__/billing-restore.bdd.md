# billing-restore

## billing-restore-001

- Vitest: "POST /api/billing/restore > returns 401 when not authenticated"
- Mode: run
- Given: Stripe billing is configured. The caller sends no authorization header.
- When: The caller requests `POST /api/billing/restore` with an empty body.
- Then: The API responds with HTTP 401.

## billing-restore-002

- Vitest: "POST /api/billing/restore > returns 403 for non-admin org member"
- Mode: run
- Given: Stripe billing is configured. A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/restore` with an empty body.
- Then: The API responds with HTTP 403 and the error `{ message: "Only org admins can manage billing", code: "FORBIDDEN" }`.

## billing-restore-003

- Vitest: "POST /api/billing/restore > keeps body validation behind configuration, authentication, and admin checks for each request"
- Mode: run
- Given: Each request carries a malformed JSON body (`{`). Billing is first unconfigured (no Stripe secret key), then configured; the caller is first anonymous, then a signed-in `org:member`, then an `org:admin`, then a member again.
- When: The caller sends `POST /api/billing/restore` with the malformed body in each of those states, and finally a well-formed empty body as the member.
- Then: Unconfigured billing returns HTTP 503 `{ message: "Billing not configured", code: "PROVIDER_UNAVAILABLE" }`; the anonymous request returns 401; the member returns 403 `{ message: "Only org admins can manage billing", code: "FORBIDDEN" }`; the admin returns 400 `{ message: "Invalid JSON in request body", code: "BAD_REQUEST" }`; the final well-formed member request returns the same 403 error.

## billing-restore-004

- Vitest: "POST /api/billing/restore > returns 409 when org has no subscription"
- Mode: run
- Given: Stripe billing is configured. A signed-in org admin's organization has no Stripe subscription.
- When: The admin requests `POST /api/billing/restore` with an empty body.
- Then: The API responds with HTTP 409 and the error `{ message: "Org has no active subscription", code: "CONFLICT" }`.

## billing-restore-005

- Vitest: "POST /api/billing/restore > returns 409 when subscription is not scheduled for cancellation"
- Mode: run
- Given: Stripe billing is configured. A signed-in org admin's organization has an active Pro subscription that is not scheduled for cancellation and has no pending schedule.
- When: The admin requests `POST /api/billing/restore` with an empty body.
- Then: The API responds with HTTP 409 and the error `{ message: "Subscription has no scheduled billing change", code: "CONFLICT" }`, and the Stripe subscription is not updated.

## billing-restore-006

- Vitest: "POST /api/billing/restore > restores a subscription scheduled for cancellation"
- Mode: run
- Given: Stripe billing is configured. A signed-in org admin's organization has an active Pro subscription scheduled to cancel at period end, and the Stripe subscription has a default payment method.
- When: The admin requests `POST /api/billing/restore` with an empty body, reads `GET /api/billing/status`, then requests the restore again.
- Then: The first request returns HTTP 200 `{ status: "restored" }` and Stripe updates the subscription with `cancel_at_period_end: false`. Billing status shows `cancelAtPeriodEnd` false, no `scheduledChange` and `canRestorePlan` false. The repeated restore returns HTTP 409 `{ message: "Subscription has no scheduled billing change", code: "CONFLICT" }`.

## billing-restore-007

- Vitest: "POST /api/billing/restore > records a restore that Stripe applied while the organization row was rewritten"
- Mode: run
- Given: Stripe billing is configured. A signed-in org admin's organization has an active Pro subscription scheduled to cancel at period end, with a default payment method. While Stripe applies the restore, the admin changes auto-recharge settings through `PUT /api/billing/auto-recharge`, which rewrites the organization row.
- When: The admin requests `POST /api/billing/restore` with an empty body, then reads `GET /api/billing/status`.
- Then: The restore returns HTTP 200 `{ status: "restored" }`, and billing status shows `cancelAtPeriodEnd` false and no `scheduledChange`.

## billing-restore-008

- Vitest: "POST /api/billing/restore > restores a scheduled downgrade by releasing its subscription schedule"
- Mode: run
- Given: Stripe billing is configured. A signed-in org admin's organization has an active Team subscription (not cancelling) with a pending Stripe schedule downgrading to Pro on 2099-07-04, and a default payment method.
- When: The admin requests `POST /api/billing/restore` with an empty body, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ status: "restored" }`. Stripe releases the pending schedule and does not update the subscription. Billing status shows `cancelAtPeriodEnd` false and no `scheduledChange`.

## billing-restore-009

- Vitest: "POST /api/billing/restore > uses the request brand fallback and preserves an explicit return URL when restore requires a payment method"
- Mode: run
- Given: Stripe billing is configured. The app URL is `https://app.okou.ai`. A signed-in org admin's organization has an active Pro subscription scheduled to cancel at period end, and neither the Stripe subscription nor the customer has a default payment method or source. Stripe creates a setup checkout session URL.
- When: The admin requests `POST /api/billing/restore` from origin `https://app.okou.ai`, first with an empty body and then with `returnUrl: "https://app.okou.ai/settings/billing"`.
- Then: Both requests return HTTP 200 `{ status: "payment_method_required", checkoutUrl }`. The first creates a Stripe `setup` mode checkout session in USD for the customer with success and cancel URLs `https://app.okou.ai` and metadata (on the session and setup intent) `purpose: "billing_restore"`, the org ID and subscription ID; the second uses the explicit return URL for success and cancel. The Stripe subscription is not updated.
