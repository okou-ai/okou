# email

## email-001

- Vitest: "POST /api/email/inbound > rejects missing or invalid Svix signatures"
- Mode: run
- Given: The inbound email webhook expects a valid Resend Svix signature.
- When: Resend-style inbound events arrive first with missing signature headers and then with an invalid signature.
- Then: Both requests return HTTP 401. The first response is exactly `Missing signature headers` and the second is exactly `Invalid signature` in the error field.

## email-002

- Vitest: "POST /api/email/inbound > acknowledges unrelated signed Resend events without background work"
- Mode: run
- Given: Resend can deliver a valid signed event about an already sent email.
- When: Resend posts that `email.sent` event to `POST /api/email/inbound`.
- Then: The API returns HTTP 200 with exactly `{ "received": true }` and no outbound provider send occurs after pending work settles.
