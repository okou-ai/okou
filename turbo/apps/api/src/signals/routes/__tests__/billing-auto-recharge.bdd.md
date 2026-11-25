# billing-auto-recharge

## billing-auto-recharge-001

- Vitest: "GET /api/billing/auto-recharge > returns 401 when the request is unauthenticated"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller requests `GET /api/billing/auto-recharge` without credentials.
- Then: The response is HTTP 401 with exactly `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## billing-auto-recharge-002

- Vitest: "GET /api/billing/auto-recharge > returns 401 when the user has no active org"
- Mode: run
- Given: A signed-in user has no active organization.
- When: The user requests `GET /api/billing/auto-recharge`.
- Then: The response is HTTP 401 with exactly `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## billing-auto-recharge-003

- Vitest: "GET /api/billing/auto-recharge > returns the org auto-recharge config after a public api update"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin updates auto-recharge via `PUT /api/billing/auto-recharge` with enabled true, threshold 2000 and amount 10,000, then reads `GET /api/billing/auto-recharge`.
- Then: The update returns HTTP 200, and the read returns exactly `{ enabled: true, threshold: 2000, amount: 10000 }`.

## billing-auto-recharge-004

- Vitest: "GET /api/billing/auto-recharge > returns default config for a new org metadata row"
- Mode: run
- Given: A signed-in admin has completed onboarding, so the workspace is on the Limited Free tier with an active billing record and 0 credits.
- When: The admin reads `GET /api/billing/auto-recharge`.
- Then: The response is exactly `{ enabled: false, threshold: null, amount: null }`.

## billing-auto-recharge-005

- Vitest: "GET /api/billing/auto-recharge > returns the legacy default when the org metadata row does not exist"
- Mode: run
- Given: A signed-in admin's workspace has no billing record yet.
- When: The admin reads `GET /api/billing/auto-recharge`.
- Then: The response is exactly `{ enabled: false, threshold: null, amount: null }`.

## billing-auto-recharge-006

- Vitest: "PUT /api/billing/auto-recharge > returns 401 when the request is unauthenticated"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller calls `PUT /api/billing/auto-recharge` without credentials, enabling with threshold 1000 and amount 5000.
- Then: The response is HTTP 401 with exactly `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## billing-auto-recharge-007

- Vitest: "PUT /api/billing/auto-recharge > enables auto-recharge for pro tier org"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 1000 and amount 5000, then reads `GET /api/billing/auto-recharge`.
- Then: The update returns HTTP 200 with exactly `{ enabled: true, threshold: 1000, amount: 5000 }`, and the read returns the same body.

## billing-auto-recharge-008

- Vitest: "PUT /api/billing/auto-recharge > creates and pays an invoice when enabling auto-recharge below threshold"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription, and its credit balance is below the requested threshold. Stripe returns the customer with default payment method `pm_test`, creates and finalizes an invoice, and pays it.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = current credits + 1000 and amount = threshold + 5000.
- Then: The response is HTTP 200 with exactly the enabled config. Stripe receives an invoice for the customer with `auto_advance` false, payment method `pm_test` and metadata type `auto_recharge`, the organization ID and the credits amount; an invoice item for that invoice in USD costing the amount rounded up to the next 1000 credits at 100 cents each; and a payment for that invoice.

## billing-auto-recharge-009

- Vitest: "PUT /api/billing/auto-recharge > uses an attached card when no default payment method is configured"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription, its credit balance is below the requested threshold, and neither the Stripe customer nor the subscription has a default payment method, but the customer has an attached card `pm_attached_card`.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = current credits + 1000 and amount = threshold + 5000.
- Then: The response is HTTP 200. Stripe is asked to list one card for the customer, the invoice is created with payment method `pm_attached_card` and `auto_recharge` metadata for the organization and amount, and the invoice is paid.

## billing-auto-recharge-010

- Vitest: "PUT /api/billing/auto-recharge > keeps a zero-due invoice pending until its webhook grants credits exactly once"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe returns the customer with default payment method `pm_test`, creates and finalizes an invoice, and pays it, except that finalization returns the invoice already `paid` with 0 due, and a payment attempt would fail with `invoice_already_paid`.
- When: The admin calls `PUT /api/billing/auto-recharge` twice with the same enabling config; Stripe then delivers a signed `invoice.paid` event for the auto-recharge invoice to `POST /api/webhooks/stripe` twice with different event IDs; the admin then enables with a new threshold above the new balance.
- Then: Before the webhook, credits are unchanged, exactly one invoice is created and no payment is attempted. After the webhooks, credits increase by exactly the amount and there is exactly one `auto_recharge` credit grant with that amount remaining. The later update creates a second invoice and leaves credits unchanged.

## billing-auto-recharge-011

- Vitest: "PUT /api/billing/auto-recharge > keeps a payment invoice pending until its webhook grants credits exactly once"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe returns the customer with default payment method `pm_test`, creates and finalizes an invoice, and pays it, and the payment returns status `paid`.
- When: The admin calls `PUT /api/billing/auto-recharge` twice with the same enabling config; Stripe then delivers a signed `invoice.paid` event for the auto-recharge invoice to `POST /api/webhooks/stripe` twice with different event IDs; the admin then enables with a new threshold above the new balance.
- Then: Before the webhook, credits are unchanged, exactly one invoice is created and it is paid once. After the webhooks, credits increase by exactly the amount and there is exactly one `auto_recharge` credit grant with that amount remaining. The later update creates a second invoice and leaves credits unchanged.

## billing-auto-recharge-012

- Vitest: "PUT /api/billing/auto-recharge > keeps a already-paid invoice pending until its webhook grants credits exactly once"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe returns the customer with default payment method `pm_test`, creates and finalizes an invoice, and pays it, but the payment fails with `invoice_already_paid` and retrieving the invoice shows it `paid`.
- When: The admin calls `PUT /api/billing/auto-recharge` twice with the same enabling config; Stripe then delivers a signed `invoice.paid` event for the auto-recharge invoice to `POST /api/webhooks/stripe` twice with different event IDs; the admin then enables with a new threshold above the new balance.
- Then: Before the webhook, credits are unchanged, exactly one invoice is created, payment is attempted once, and the invoice is retrieved by ID. After the webhooks, credits increase by exactly the amount and there is exactly one `auto_recharge` credit grant with that amount remaining. The later update creates a second invoice and leaves credits unchanged.

## billing-auto-recharge-013

- Vitest: "PUT /api/billing/auto-recharge > keeps a already-paid-no-code invoice pending until its webhook grants credits exactly once"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe returns the customer with default payment method `pm_test`, creates and finalizes an invoice, and pays it, but the payment fails with an "Invoice is already paid" error without an error code and retrieving the invoice shows it `paid`.
- When: The admin calls `PUT /api/billing/auto-recharge` twice with the same enabling config; Stripe then delivers a signed `invoice.paid` event for the auto-recharge invoice to `POST /api/webhooks/stripe` twice with different event IDs; the admin then enables with a new threshold above the new balance.
- Then: Before the webhook, credits are unchanged, exactly one invoice is created, payment is attempted once, and the invoice is retrieved by ID. After the webhooks, credits increase by exactly the amount and there is exactly one `auto_recharge` credit grant with that amount remaining. The later update creates a second invoice and leaves credits unchanged.

## billing-auto-recharge-014

- Vitest: "PUT /api/billing/auto-recharge > keeps payment-failed on the failure path without granting credits"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe invoice creation and finalization succeed, but the payment is declined with `card_declined`.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = credits + 1000 and amount = credits + 6000, reads `GET /api/billing/status`, and (with a fresh successful Stripe invoice setup) repeats the update.
- Then: Both updates return HTTP 200 and credits stay unchanged after each. The second update creates a second invoice.

## billing-auto-recharge-015

- Vitest: "PUT /api/billing/auto-recharge > keeps already-paid-but-open on the failure path without granting credits"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe invoice creation and finalization succeed, but the payment fails with `invoice_already_paid` but retrieving the invoice shows it still `open`.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = credits + 1000 and amount = credits + 6000, reads `GET /api/billing/status`, and (with a fresh successful Stripe invoice setup) repeats the update.
- Then: Both updates return HTTP 200 and credits stay unchanged after each. The second update creates a second invoice.

## billing-auto-recharge-016

- Vitest: "PUT /api/billing/auto-recharge > keeps status-lookup-failed on the failure path without granting credits"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe invoice creation and finalization succeed, but the payment fails with `invoice_already_paid` and retrieving the invoice fails temporarily.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = credits + 1000 and amount = credits + 6000, reads `GET /api/billing/status`, and (with a fresh successful Stripe invoice setup) repeats the update.
- Then: Both updates return HTTP 200 and credits stay unchanged after each. The second update creates a second invoice.

## billing-auto-recharge-017

- Vitest: "PUT /api/billing/auto-recharge > keeps finalized-void on the failure path without granting credits"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe creates the invoice, but finalization returns it `void`.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = credits + 1000 and amount = credits + 6000, reads `GET /api/billing/status`, and (with a fresh successful Stripe invoice setup) repeats the update.
- Then: Both updates return HTTP 200 and credits stay unchanged after each. No payment is attempted. The second update creates a second invoice.

## billing-auto-recharge-018

- Vitest: "PUT /api/billing/auto-recharge > keeps payment-still-open on the failure path without granting credits"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe invoice creation and finalization succeed, but the payment returns the invoice still `open`.
- When: The admin calls `PUT /api/billing/auto-recharge` enabling auto-recharge with threshold = credits + 1000 and amount = credits + 6000, reads `GET /api/billing/status`, and (with a fresh successful Stripe invoice setup) repeats the update.
- Then: Both updates return HTTP 200 and credits stay unchanged after each. The second update creates a second invoice.

## billing-auto-recharge-019

- Vitest: "PUT /api/billing/auto-recharge > turns off after three consecutive failures and resets when enabled again"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold, and Stripe declines every invoice payment with `card_declined`.
- When: The admin calls `PUT /api/billing/auto-recharge` three times with the same enabling config, reads `GET /api/billing/auto-recharge` and `GET /api/billing/status`, then calls `PUT /api/billing/auto-recharge` three more times with the same config.
- Then: The first two responses echo the config; the third returns it with `enabled` false and `disabledReason: "consecutive_failures"`. The read and the billing status's auto-recharge show that disabled config, and credits are unchanged. Re-enabling returns the enabled config, the next failure still returns it, and the third failure in the new streak returns the disabled config again.

## billing-auto-recharge-020

- Vitest: "PUT /api/billing/auto-recharge > starts a new failure streak after a paid recharge"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. Stripe declines the first two invoice payments and accepts the third.
- When: The admin calls `PUT /api/billing/auto-recharge` three times with the enabling config; Stripe delivers a signed `invoice.paid` event for the auto-recharge invoice to `POST /api/webhooks/stripe`; with Stripe now declining every payment, the admin calls `PUT /api/billing/auto-recharge` twice with a threshold above the new balance.
- Then: After the webhook, credits increase by exactly the recharge amount. The second failed update after the paid recharge still returns the enabled config (auto-recharge is not turned off).

## billing-auto-recharge-021

- Vitest: "PUT /api/billing/auto-recharge > clears a failed recharge after its organization row is rewritten"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription with credits below the threshold. The first Stripe customer lookup for a recharge is held and then fails with a temporary error; later Stripe calls succeed.
- When: The admin calls `PUT /api/billing/auto-recharge` with the enabling config; while it is held, the admin saves the same config again; the held lookup then fails; the admin saves the config a third time.
- Then: No invoice is created while the first recharge is pending or after it fails. The third save creates exactly one invoice and pays it, and credits are unchanged.

## billing-auto-recharge-022

- Vitest: "PUT /api/billing/auto-recharge > disables auto-recharge after a public recharge trigger"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription, and the admin has enabled auto-recharge with a threshold above the current balance, which triggered a recharge invoice.
- When: The admin calls `PUT /api/billing/auto-recharge` with `{ enabled: false }` and reads `GET /api/billing/auto-recharge`.
- Then: The update returns HTTP 200 with exactly `{ enabled: false, threshold: null, amount: null }`, and the read returns the same.

## billing-auto-recharge-023

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when enabling for a Limited Free workspace"
- Mode: run
- Given: A signed-in admin has completed onboarding on the Limited Free tier with 0 credits.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 1000 and amount 5000.
- Then: The response is HTTP 400 with exactly `{ error: { message: "Auto-recharge is only available for Pro or Team workspaces", code: "BAD_REQUEST" } }`.

## billing-auto-recharge-024

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when enabling without threshold and amount"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with `{ enabled: true }` and no threshold or amount.
- Then: The response is HTTP 400 with exactly `{ error: { message: "threshold and amount are required when enabling auto-recharge", code: "BAD_REQUEST" } }`.

## billing-auto-recharge-025

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when amount is below minimum"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 1000 and amount 500.
- Then: The response is HTTP 400 with exactly `{ error: { message: "amount: Too small: expected number to be >=1000", code: "BAD_REQUEST" } }`.

## billing-auto-recharge-026

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when amount exceeds the maximum"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 1000 and amount 10,000,001.
- Then: The response is HTTP 400 with exactly `{ error: { message: "amount: Too big: expected number to be <=10000000", code: "BAD_REQUEST" } }`.

## billing-auto-recharge-027

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when threshold exceeds the maximum"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 10,000,001 and amount 10,000,000.
- Then: The response is HTTP 400 with exactly `{ error: { message: "threshold: Too big: expected number to be <=10000000", code: "BAD_REQUEST" } }`.

## billing-auto-recharge-028

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when threshold equals amount"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 5000 and amount 5000.
- Then: The response is HTTP 400 with message "threshold must be less than amount to avoid recharge loops".

## billing-auto-recharge-029

- Vitest: "PUT /api/billing/auto-recharge > returns 400 when threshold is greater than amount"
- Mode: run
- Given: A signed-in admin has a Pro workspace with a Stripe customer and subscription.
- When: The admin calls `PUT /api/billing/auto-recharge` with enabled true, threshold 6000 and amount 5000.
- Then: The response is HTTP 400 with message "threshold must be less than amount to avoid recharge loops".

## billing-auto-recharge-030

- Vitest: "PUT /api/billing/auto-recharge > returns 403 for non-admin member"
- Mode: run
- Given: An admin's workspace has a Pro entitlement, and a non-admin member (`org:member`) of that workspace is signed in.
- When: The member calls `PUT /api/billing/auto-recharge` with enabled true, threshold 1000 and amount 5000.
- Then: The response is HTTP 403 with exactly `{ error: { message: "Only org admins can update auto-recharge settings", code: "FORBIDDEN" } }`.
