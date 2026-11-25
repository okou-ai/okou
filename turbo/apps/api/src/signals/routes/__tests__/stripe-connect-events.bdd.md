# stripe-connect-events

## stripe-connect-events-001

- Vitest: "Stripe Connect account notifications > requires the configured Connect signing secret before changing an account"
- Mode: run
- Given: A user has connected a Stripe account through OAuth. The Stripe Connect signing secret is configured, and a separate billing webhook secret also exists.
- When: A live `account.application.deauthorized` event for that account is posted to `POST /api/webhooks/stripe-automation-events` signed with the billing secret, then without a `stripe-signature` header, then correctly signed after the Connect signing secret is removed from configuration.
- Then: The billing-signed and unsigned requests return HTTP 401, the request without a configured Connect secret returns HTTP 503, and the user's default Stripe account is unchanged.

## stripe-connect-events-002

- Vitest: "Stripe Connect account notifications > ignores test-mode and unrelated events"
- Mode: run
- Given: A user has connected a Stripe account through OAuth, and the Connect signing secret is configured.
- When: Correctly signed events are posted to `POST /api/webhooks/stripe-automation-events`: a test-mode deauthorization for the account, a test-mode deauthorization without an account, and a `customer.created` event for the account.
- Then: Each request returns HTTP 200 with body `OK`, and the user's default Stripe account is unchanged.

## stripe-connect-events-003

- Vitest: "Stripe Connect account notifications > marks matching OAuth accounts across owners and preserves unrelated connections on repeated notifications"
- Mode: run
- Given: Two users have connected the same Stripe account through OAuth, and the first user also added it again as "Shared Stripe" and has a separate Stripe API-token connection. A third user has OAuth connections to a different Stripe account and to GitHub.
- When: The same signed live `account.application.deauthorized` event for the shared account is posted to `POST /api/webhooks/stripe-automation-events` at 2026-10-08T11:00:00Z and again at 11:01:00Z.
- Then: Each delivery returns HTTP 200, and after each one all three OAuth connections to that account show `reconnect-required` with reason `authorization_expired_or_revoked` and `updatedAt` equal to that delivery time. The API-token connection, the third user's other Stripe account and their GitHub connection are unchanged.
