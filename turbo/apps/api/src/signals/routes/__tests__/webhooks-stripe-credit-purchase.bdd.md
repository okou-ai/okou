# webhooks-stripe-credit-purchase

## webhooks-stripe-credit-purchase-001

- Vitest: "grants a paid credit invoice once across distinct webhook events"
- Mode: run
- Given: A newly onboarded limited-free organization can buy credits and has no subscription. Stripe has a paid credit-purchase invoice with subtotal 10,000 and an expiry 90 days later.
- When: Stripe delivers the signed paid invoice and then delivers the same invoice using a different event ID. The administrator reads billing after each delivery.
- Then: Both deliveries return HTTP 200. The first adds exactly 100,000 credits and one purchase grant with matching amount, remaining balance, and expiry, leaving previous grants, the free tier and restricted-model policy intact and auto-recharge unavailable. The second delivery leaves credits and the entire grant list unchanged.
