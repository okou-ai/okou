# billing-invoices

## billing-invoices-001

- Vitest: "GET /api/billing/invoices > returns 401 when the request is unauthenticated"
- Mode: run
- Given: The caller sends no authorization header.
- When: The caller requests `GET /api/billing/invoices`.
- Then: The API responds with HTTP 401 and the error `{ message: "Not authenticated", code: "UNAUTHORIZED" }`.

## billing-invoices-002

- Vitest: "GET /api/billing/invoices > returns 401 when the user has no active org"
- Mode: run
- Given: A signed-in user has no active organization.
- When: The user requests `GET /api/billing/invoices`.
- Then: The API responds with HTTP 401 and the error `{ message: "Not authenticated", code: "UNAUTHORIZED" }`.

## billing-invoices-003

- Vitest: "GET /api/billing/invoices > returns 403 for a non-admin org member"
- Mode: run
- Given: A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `GET /api/billing/invoices`.
- Then: The API responds with HTTP 403 and the error `{ message: "Only org admins can view invoices", code: "FORBIDDEN" }`.

## billing-invoices-004

- Vitest: "GET /api/billing/invoices > returns invoices for an admin's org with active subscription"
- Mode: run
- Given: A signed-in org admin's organization has a Stripe customer and an active Pro subscription. Stripe lists two paid invoices for that customer (`inv_001` / `INV-2026-001` and `inv_002` / `INV-2026-002`, each 4000 paid, with hosted URLs).
- When: The admin requests `GET /api/billing/invoices`.
- Then: Stripe invoices are listed for the organization's customer ID, and the API responds with HTTP 200 and both invoices mapped to `id`, `number`, `date` (Stripe created time), `amount` (4000), `status: "paid"` and `hostedInvoiceUrl`, in Stripe's order.

## billing-invoices-005

- Vitest: "GET /api/billing/invoices > returns an empty list when the org has no Stripe customer"
- Mode: run
- Given: A signed-in org admin's organization has no Stripe customer, and listing Stripe invoices would fail.
- When: The admin requests `GET /api/billing/invoices`.
- Then: The API responds with HTTP 200 and `{ invoices: [] }` without listing Stripe invoices.

## billing-invoices-006

- Vitest: "GET /api/billing/invoices > returns an empty list when Stripe returns no invoices"
- Mode: run
- Given: A signed-in org admin's organization has a Stripe customer and an active Pro subscription, and Stripe returns no invoices for the customer.
- When: The admin requests `GET /api/billing/invoices`.
- Then: The API responds with HTTP 200 and `{ invoices: [] }`.
