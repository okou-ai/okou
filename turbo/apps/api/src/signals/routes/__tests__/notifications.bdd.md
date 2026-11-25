# notifications

## notifications-001

- Vitest: "agent mail notifications > delivers only the requested notification and recovers its failed delivery without caller activity"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token; email delivery is configured with no drain delay. Resend rejects the first send with `rate_limit_exceeded` and accepts later sends. Another owner with a disposable verified address belongs to a staff workspace, and the inbound mail provider holds that owner's message.
- When: The Run sends two notifications via `POST /api/notifications/mail` ("First notification", then "Next notification"); after the clock advances 2 seconds a signed `email.received` webhook arrives at `POST /api/email/inbound` for the other owner, and finally the cron `GET /api/cron/drain-email-outbox` runs with the cron secret.
- Then: Both sends return HTTP 200. The first Resend attempt carries the first notification's HTML and text with an `okou-email-outbox/v1/` idempotency key, the second carries the second subject and text, and the second notification reads `sent` via `GET /api/notifications/:id`. The inbound webhook leads to a third send to the other owner saying the message "did not pass our security checks" while the first notification is still `queued`. After the cron drain a fourth send exactly repeats the first attempt and the first notification reads `sent`.

## notifications-002

- Vitest: "agent mail notifications > rejects Morning Brief purpose from an ordinary run without silently downgrading"
- Mode: run
- Given: A Pro member's ordinary thread Run is running and holds an Okou run token.
- When: The Run posts `POST /api/notifications/mail` with `kind: "morning-brief"`, then the same subject without a kind, then that same request with `kind: "notification"`, then the Morning Brief request again.
- Then: The Morning Brief request returns HTTP 403 `FORBIDDEN` mentioning the official Morning Brief automation. The plain request returns HTTP 200 `queued` and not deduplicated, the `notification` kind replay returns the same notification ID deduplicated, and the repeated Morning Brief request still returns HTTP 403.

## notifications-003

- Vitest: "agent mail notifications > does not authorize a custom automation merely named morning-brief"
- Mode: run
- Given: A workspace member created a custom workflow named `morning-brief` with an hourly loop automation (`POST /api/workflows/:workflowId/automations`, 201), and the automation has started a Run holding an Okou run token.
- When: The automation Run posts `POST /api/notifications/mail` with `kind: "morning-brief"`, then an ordinary notification.
- Then: The Morning Brief request returns HTTP 403, and the ordinary notification returns HTTP 200 `queued` and not deduplicated.

## notifications-004

- Vitest: "agent mail notifications > rejects caller-supplied presentation and source URLs"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token.
- When: The Run posts `POST /api/notifications/mail` with caller-supplied `manageUrl`, `runUrl` and `heroUrl`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## notifications-005

- Vitest: "agent mail notifications > does not turn a recipient-provider failure into a no-email skip"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token, and Clerk fails the next user lookup.
- When: The Run posts `POST /api/notifications/mail`, then retries the same request.
- Then: The first request returns HTTP 500, and the retry returns HTTP 200 `queued` and not deduplicated.

## notifications-006

- Vitest: "agent mail notifications > does not consume a key when delivery is unconfigured, and validates content before admission"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token.
- When: The Run posts `POST /api/notifications/mail` with a subject containing a newline, then posts a valid request while the Resend API key is unset, then repeats the valid request after the key is restored.
- Then: The invalid subject returns HTTP 400, the unconfigured delivery returns HTTP 503, and the retry with delivery configured returns HTTP 200 `queued` and not deduplicated.

## notifications-007

- Vitest: "agent mail notifications > deduplicates concurrent requests, rejects changed content, and preserves receipts after run termination"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token.
- When: The Run sends four concurrent identical `POST /api/notifications/mail` requests with one idempotency key, then the same key with different text; the member cancels the Run; the same request is replayed and a new key is sent.
- Then: All four return HTTP 200 with one notification ID, exactly one is not deduplicated and it is `queued` on channel `mail` to recipient `me` with no reason. The changed content returns HTTP 409. After cancellation `GET /api/notifications/:id` reads `sent`, the replay returns deduplicated, and the new key returns HTTP 403.

## notifications-008

- Vitest: "agent mail notifications > accepts only one payload when different content races for the same key"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token.
- When: The Run concurrently posts two `POST /api/notifications/mail` requests with the same idempotency key but different text, then replays the accepted one.
- Then: One returns HTTP 200 `queued` not deduplicated and the other HTTP 409 `CONFLICT`. Replaying the accepted payload returns the same notification ID, `sent` and deduplicated, and reading it returns `sent` with no reason.

## notifications-009

- Vitest: "agent mail notifications > requires an Okou run token; human sessions cannot send"
- Mode: run
- Given: A member is signed in with a human Clerk session.
- When: The member posts `POST /api/notifications/mail` with the session token.
- Then: The response is HTTP 403 with error code `FORBIDDEN`.

## notifications-010

- Vitest: "agent mail notifications > records an unsubscribe skip and keeps it on replay after resubscription"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token, and the member has unsubscribed via `PUT /api/preferences/email-subscription`.
- When: The Run sends a notification via `POST /api/notifications/mail`; the member resubscribes via `PUT /api/preferences/email-subscription`; the Run replays the same notification request and then sends a new one.
- Then: The first send returns HTTP 200 `skipped` with reason `unsubscribed` and not deduplicated. The replay returns HTTP 200 with the same notification ID, still `skipped` and deduplicated, and the new notification returns HTTP 200 `queued`.

## notifications-011

- Vitest: "agent mail notifications > skips an address suppressed by a signed provider webhook"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token, and a signed Resend `email.bounced` webhook for the member's address has been accepted at `POST /api/email/inbound` (200).
- When: The Run posts `POST /api/notifications/mail`.
- Then: The response is HTTP 200 `skipped` with reason `suppressed`.

## notifications-012

- Vitest: "agent mail notifications > skips a user without an account email"
- Mode: run
- Given: A Pro member's thread Run is running and holds an Okou run token, and Clerk reports no email address for the member.
- When: The Run posts `POST /api/notifications/mail`.
- Then: The response is HTTP 200 `skipped` with reason `no-email`.

## notifications-013

- Vitest: "agent mail notifications > scopes lookup to the owner and workspace and rejects missing membership"
- Mode: run
- Given: A Pro member's Run has queued a notification. Another user in another workspace, and the same user in a different workspace, are signed in; then a signed Clerk `organizationMembership.deleted` webhook removes the member from the workspace.
- When: The other user and the same user in the other workspace read `GET /api/notifications/:id`; after the membership deletion webhook the Run posts a new notification.
- Then: Both foreign reads return HTTP 404, and the post-departure send returns HTTP 400.

## notifications-014

- Vitest: "agent mail notifications > erases queued and skipped receipts on departure, preserves other owners, and permits a living member to rejoin"
- Mode: run
- Given: A Pro member's Run has a notification stuck `queued` after Resend rate-limits it and a `skipped` (unsubscribed) notification. The same user in another workspace and a peer member in the same workspace each have a delivered notification.
- When: Clerk delivers `organizationMembership.deleted` for the member twice to `POST /api/webhooks/clerk`, then `organizationMembership.created` for the same living user; the signed-in member and the other owners read their receipts via `GET /api/notifications/:id`.
- Then: The queued notification first reads `queued`. After departure and rejoin both of the departed member's receipts return HTTP 404, while the other-workspace and peer receipts still return HTTP 200 with status `sent`.
