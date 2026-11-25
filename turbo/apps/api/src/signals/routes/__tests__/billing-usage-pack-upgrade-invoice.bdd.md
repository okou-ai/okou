# billing-usage-pack-upgrade-invoice

## billing-usage-pack-upgrade-invoice-001

- Vitest: "completes and replays a 20 USD to 50 USD upgrade with 1 seconds remaining (pending=false)"
- Mode: run
- Given: A signed-in admin bought a Pro usage pack plan with a $20 pack on 2035-01-16 through checkout and a signed paid invoice, giving 20,000 purchased and 400 bonus credits in two grants. The clock is 1 second before the period end, and Stripe prices a $50 upgrade at 1,500 cents now and applies the change immediately (not pending).
- When: The admin previews the change to $50 with `POST /api/billing/usage-pack-subscription/changes/preview`, confirms it with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`, and Stripe delivers the signed paid upgrade `invoice.paid` webhook 8 times concurrently and once more afterwards.
- Then: The preview's proration date is 1 second before the period end and confirmation returns `completed`. All 8 deliveries return HTTP 200, and the allocation shows $50 with no pending change. Credits stay at 20,000 purchased, 400 bonus and 20,400 total with only the two original grants, and the final redelivery leaves credits and management unchanged. Stripe receives exactly one subscription update (`pending_if_incomplete`, `always_invoice`, the proration date, key `usage-pack-change:<changeId>:apply`) and no credit note or refund.

## billing-usage-pack-upgrade-invoice-002

- Vitest: "completes and replays a 20 USD to 50 USD upgrade with 1 seconds remaining (pending=true)"
- Mode: run
- Given: A signed-in admin bought a Pro usage pack plan with a $20 pack on 2035-01-16 through checkout and a signed paid invoice, giving 20,000 purchased and 400 bonus credits in two grants. The clock is 1 second before the period end, and Stripe prices a $50 upgrade at 1,500 cents now and holds it as a pending update with an open invoice.
- When: The admin previews the change to $50 with `POST /api/billing/usage-pack-subscription/changes/preview`, confirms it with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`, and after Stripe applies the update it delivers the signed paid upgrade `invoice.paid` webhook 8 times concurrently and once more afterwards.
- Then: The preview's proration date is 1 second before the period end, confirmation returns `pending_payment`, and credits are unchanged while payment is pending. All 8 deliveries return HTTP 200, and the allocation shows $50 with no pending change. Credits stay at 20,000 purchased, 400 bonus and 20,400 total with only the two original grants, and the final redelivery leaves credits and management unchanged. Stripe receives exactly one subscription update (`pending_if_incomplete`, `always_invoice`, the proration date, key `usage-pack-change:<changeId>:apply`) and no credit note or refund.

## billing-usage-pack-upgrade-invoice-003

- Vitest: "completes and replays a 20 USD to 50 USD upgrade with 87 seconds remaining (pending=true)"
- Mode: run
- Given: A signed-in admin bought a Pro usage pack plan with a $20 pack on 2035-01-16 through checkout and a signed paid invoice, giving 20,000 purchased and 400 bonus credits in two grants. The clock is 87 seconds before the period end, and Stripe prices a $50 upgrade at 1,500 cents now and holds it as a pending update with an open invoice.
- When: The admin previews the change to $50 with `POST /api/billing/usage-pack-subscription/changes/preview`, confirms it with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`, and after Stripe applies the update it delivers the signed paid upgrade `invoice.paid` webhook 8 times concurrently and once more afterwards.
- Then: The preview's proration date is 87 seconds before the period end, confirmation returns `pending_payment`, and credits are unchanged while payment is pending. All 8 deliveries return HTTP 200, and the allocation shows $50 with no pending change. Credits become 20,001 purchased, 400 bonus and 20,401 total: the original two grants plus one 1-credit purchased grant fully remaining and expiring at the period end. The final redelivery leaves credits and management unchanged. Stripe receives exactly one subscription update (`pending_if_incomplete`, `always_invoice`, the proration date, key `usage-pack-change:<changeId>:apply`) and no credit note or refund.

## billing-usage-pack-upgrade-invoice-004

- Vitest: "completes and replays a 20 USD to 50 USD upgrade with 1296000 seconds remaining (pending=true)"
- Mode: run
- Given: A signed-in admin bought a Pro usage pack plan with a $20 pack on 2035-01-16 through checkout and a signed paid invoice, giving 20,000 purchased and 400 bonus credits in two grants. The clock is 15 days (1,296,000 seconds) before the period end, and Stripe prices a $50 upgrade at 1,500 cents now and holds it as a pending update with an open invoice.
- When: The admin previews the change to $50 with `POST /api/billing/usage-pack-subscription/changes/preview`, confirms it with `POST /api/billing/usage-pack-subscription/changes/:changeId/confirm`, and after Stripe applies the update it delivers the signed paid upgrade `invoice.paid` webhook 8 times concurrently and once more afterwards.
- Then: The preview's proration date is 15 days before the period end, confirmation returns `pending_payment`, and credits are unchanged while payment is pending. All 8 deliveries return HTTP 200, and the allocation shows $50 with no pending change. Credits become 35,000 purchased, 1,500 bonus and 36,500 total: the original two grants plus a 15,000-credit purchased grant and a 1,100-credit bonus grant, both fully remaining and expiring at the period end. The final redelivery leaves credits and management unchanged. Stripe receives exactly one subscription update (`pending_if_incomplete`, `always_invoice`, the proration date, key `usage-pack-change:<changeId>:apply`) and no credit note or refund.
