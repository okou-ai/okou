# email-subscription

## email-subscription-001

- Vitest: "email subscription preferences > persists the current user's preference across workspaces and isolates other users"
- Mode: run
- Given: A signed-in member in a workspace has a primary email address and no saved preference; another user also exists.
- When: The member reads `GET /api/preferences/email-subscription`, unsubscribes with `PUT /api/preferences/email-subscription` (`subscribed: false`), reads it from a different workspace, the other user reads theirs, and the member resubscribes in the original workspace and reads again.
- Then: The first read is exactly `{ subscribed: true, email: <primary>, deliveryStatus: "available" }`. After unsubscribing, the member reads `subscribed: false` from the other workspace while the other user still reads `subscribed: true` with their own email. After resubscribing the member reads `subscribed: true`.

## email-subscription-002

- Vitest: "email subscription preferences > reads one-click opt-outs and allows explicit resubscription"
- Mode: run
- Given: A signed-in member holds a valid signed unsubscribe token for their user.
- When: The token is opened with `GET /api/email/unsubscribe`, then submitted with `POST /api/email/unsubscribe`, and the member later resubscribes with `PUT /api/preferences/email-subscription`, reading the preference after each step.
- Then: The GET returns HTTP 302 and the preference stays subscribed. The POST returns HTTP 200 and the preference reads `subscribed: false`. After the explicit update it reads `subscribed: true`.

## email-subscription-003

- Vitest: "email subscription preferences > keeps email.bounced suppression after resubscribing"
- Mode: run
- Given: Row `email.bounced`. A signed-in member has a primary email address.
- When: A signed Resend `email.bounced` event addressed to the member's email in upper case is delivered to `POST /api/email/inbound`, and the member then sets `subscribed: true` with `PUT /api/preferences/email-subscription`.
- Then: The webhook returns HTTP 200, and the preference reads `subscribed: true` with `deliveryStatus: "suppressed"`.

## email-subscription-004

- Vitest: "email subscription preferences > keeps email.complained suppression after resubscribing"
- Mode: run
- Given: Row `email.complained`. A signed-in member has a primary email address.
- When: A signed Resend `email.complained` event addressed to the member's email in upper case is delivered to `POST /api/email/inbound`, and the member then sets `subscribed: true` with `PUT /api/preferences/email-subscription`.
- Then: The webhook returns HTTP 200, and the preference reads `subscribed: true` with `deliveryStatus: "suppressed"`.

## email-subscription-005

- Vitest: "email subscription preferences > unsubscribes a known complaint recipient through a cache hit and isolates other users"
- Mode: run
- Given: Row `cache hit`. Two users with primary emails exist; the owner has already read their preference (`subscribed: true`, `available`), and the identity provider's user search now fails so the recipient must come from the cached address.
- When: A signed Resend `email.complained` event for the owner's email is delivered to `POST /api/email/inbound`, and both users read `GET /api/preferences/email-subscription`.
- Then: The webhook returns exactly `{ received: true }`. The owner reads exactly `{ subscribed: false, email: <owner>, deliveryStatus: "suppressed" }` and the other user reads exactly `{ subscribed: true, email: <other>, deliveryStatus: "available" }`.

## email-subscription-006

- Vitest: "email subscription preferences > unsubscribes a known complaint recipient through a provider lookup and isolates other users"
- Mode: run
- Given: Row `provider lookup`. Two users with primary emails exist in the identity provider and the owner has not read their preference before.
- When: A signed Resend `email.complained` event for the owner's email is delivered to `POST /api/email/inbound`, and both users read `GET /api/preferences/email-subscription`.
- Then: The webhook returns exactly `{ received: true }`. The owner reads exactly `{ subscribed: false, email: <owner>, deliveryStatus: "suppressed" }` and the other user reads exactly `{ subscribed: true, email: <other>, deliveryStatus: "available" }`.

## email-subscription-007

- Vitest: "email subscription preferences > reports a missing recipient without inventing an email address"
- Mode: run
- Given: A signed-in member whose user record the identity provider reports as not found.
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The response is exactly `{ subscribed: true, email: null, deliveryStatus: "no-email" }`, and the identity provider is queried once.

## email-subscription-008

- Vitest: "email subscription preferences > retains the first email when the primary address no longer resolves"
- Mode: run
- Given: A signed-in member whose primary email ID points to a deleted address but who still has one other email address.
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The response is exactly `{ subscribed: true, email: <remaining address>, deliveryStatus: "available" }`, and the identity provider is queried exactly once for that user.

## email-subscription-009

- Vitest: "email subscription preferences > does not disguise unexpected failure as an unavailable recipient"
- Mode: run
- Given: Row "unexpected failure": a signed-in member, and the identity provider user lookup fails with a generic error.
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The API responds with HTTP 500.

## email-subscription-010

- Vitest: "email subscription preferences > does not disguise rate limit as an unavailable recipient"
- Mode: run
- Given: Row "rate limit": a signed-in member, and the identity provider user lookup fails with HTTP 429 (retry delays elapse immediately).
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The API responds with HTTP 500.

## email-subscription-011

- Vitest: "email subscription preferences > does not disguise server failure as an unavailable recipient"
- Mode: run
- Given: Row "server failure": a signed-in member, and the identity provider user lookup fails with HTTP 503 (retry delays elapse immediately).
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The API responds with HTTP 500.

## email-subscription-012

- Vitest: "email subscription preferences > does not disguise transport failure as an unavailable recipient"
- Mode: run
- Given: Row "transport failure": a signed-in member, and the identity provider user lookup fails with a transport error carrying no status (retry delays elapse immediately).
- When: The member reads `GET /api/preferences/email-subscription`.
- Then: The API responds with HTTP 500.

## email-subscription-013

- Vitest: "email subscription preferences > requires an active workspace"
- Mode: run
- Given: A signed-in user whose session has no active workspace.
- When: The user reads `GET /api/preferences/email-subscription` and updates it with `PUT /api/preferences/email-subscription`.
- Then: Both requests return HTTP 401; the read's error code is `UNAUTHORIZED`.

## email-subscription-014

- Vitest: "email subscription preferences > requires a signed-in session and rejects run credentials"
- Mode: run
- Given: An unauthenticated caller, and separately a Run execution token belonging to a member.
- When: Each caller reads `GET /api/preferences/email-subscription` and updates it with `PUT /api/preferences/email-subscription`.
- Then: Unauthenticated requests return HTTP 401. Run-token requests return HTTP 403, and the read's error code is `FORBIDDEN`.
