# marketing-reward-notification

## marketing-reward-notification-001

- Vitest: "authenticates nonfinancial refreshes before resolving source proofs and rejects another environment"
- Mode: run
- Given: The Marketing projection notification secret is configured. A progress refresh body references a random, unknown source event in environment `development`.
- When: The caller calls `POST /api/internal/marketing/get-started/notifications` with a Clerk session token, the settlement secret, and a source-read secret; then with the projection secret; then with the projection secret and environment `production`; then after the projection secret is unset.
- Then: The three wrong credentials each get HTTP 401 with `cache-control: no-store`. The projection secret with the unknown source gets HTTP 404, the `production` environment gets HTTP 409, and the unconfigured service gets HTTP 503.

## marketing-reward-notification-002

- Vitest: "deduplicates source refreshes durably without changing pending invitations or choosing the recipient from the request"
- Mode: run
- Given: A workspace member invited a teammate, producing an `invitation.attributed` source event. The projection secret is configured and realtime publishing is observed.
- When: The projection service calls `POST /api/internal/marketing/get-started/notifications` with a body that adds `beneficiaryUserId`, then sends the valid progress refresh for that event four times concurrently and once more afterwards.
- Then: The body with a caller-chosen recipient returns HTTP 400. All valid refreshes return HTTP 200 with identical bodies containing the version, environment, source and a `notificationId`. Exactly one realtime publication `getStartedRewardsChanged` is sent on `user:<inviter>`, and the later repeat publishes nothing more.

## marketing-reward-notification-003

- Vitest: "validates the original invitation claim reference and recovers failed nonfinancial delivery without settlement credentials"
- Mode: run
- Given: Two workspace members each invited a teammate. The projection secret is configured and the realtime provider rejects the first publication.
- When: The projection service sends `POST /api/internal/marketing/get-started/notifications` for member A's invitation claim with an unknown claim ID, then with a different invitation ID, then with the correct claim; then sends a progress refresh for member B's event; then repeats A's refresh.
- Then: The unknown claim gets HTTP 404 and the mismatched invitation gets HTTP 409. A's correct refresh returns HTTP 200 with its version, environment and source, but its publication fails. B's refresh publishes `getStartedRewardsChanged` on `user:<B>`. The repeated A refresh returns the same acknowledgement and then publishes `getStartedRewardsChanged` on `user:<A>`.

## marketing-reward-notification-004

- Vitest: "refreshes a signed revocation using its retained original inviter"
- Mode: run
- Given: A workspace member invited a teammate and then revoked the invitation with `DELETE /api/org/invite`, producing a signed `invitation.revoked` source event.
- When: The projection service sends a progress refresh for the revocation event to `POST /api/internal/marketing/get-started/notifications`.
- Then: The request returns HTTP 200, and exactly one realtime publication `getStartedRewardsChanged` is sent on the original inviter's `user:` channel.

## marketing-reward-notification-005

- Vitest: "requires a dedicated projection credential and the exact committed financial receipt before queueing a refresh"
- Mode: run
- Given: A member checked in on Get Started and the resulting check-in reward was settled through the financial settlement route, producing a committed receipt.
- When: The caller sends the settlement refresh to `POST /api/internal/marketing/get-started/notifications` with a Clerk session, a Marketing consumer cron token and the settlement secret; then with the projection secret but receipts altered in org, beneficiary, reward amount or member credit grant ID; then after the projection secret is unset.
- Then: The three wrong credentials each get HTTP 401 with `cache-control: no-store`. Each altered receipt gets HTTP 409, and nothing is published. The unconfigured service gets HTTP 503.

## marketing-reward-notification-006

- Vitest: "cron recovers an acknowledged refresh without caller activity or renewing the financial receipt"
- Mode: run
- Given: A member's check-in reward has a committed settlement receipt. The cron secret and projection secret are configured, and the realtime provider rejects the first publication.
- When: The projection service sends the settlement refresh to `POST /api/internal/marketing/get-started/notifications`, the cron caller runs `GET /api/cron/process-background-jobs`, the service sends the refresh four more times concurrently, and the settlement intent is resubmitted to `POST /api/internal/marketing/get-started/settlements`.
- Then: The first refresh returns HTTP 200 with version 1, the intent ID, the receipt ID and a `notificationId`, but nothing is published. After the cron run, exactly one `getStartedRewardsChanged` publication is sent on the member's `user:` channel. The repeated refreshes return the same acknowledgement without new publications, and the resubmitted settlement returns exactly the original receipt.

## marketing-reward-notification-007

- Vitest: "routes an organization reward refresh only to its original actor and organization"
- Mode: run
- Given: A member installed Slack for their organization and the organization Slack reward was settled with a committed receipt.
- When: The projection service sends the settlement refresh to `POST /api/internal/marketing/get-started/notifications`.
- Then: The request returns HTTP 200 and exactly two realtime publications are sent: `getStartedRewardsChanged` on the actor's `user:` channel and `slack:changed` on the `org:` channel.

## marketing-reward-notification-008

- Vitest: "one user's failed refresh does not block another owner's notification"
- Mode: run
- Given: Three members each have a committed check-in reward receipt. The realtime provider rejects the first publication.
- When: The projection service sends each member's settlement refresh to `POST /api/internal/marketing/get-started/notifications` in turn, then repeats the first member's refresh.
- Then: Each refresh returns HTTP 200. Initially only the second and third members receive `getStartedRewardsChanged`. The repeated first refresh returns the same acknowledgement, after which all three members have a publication (three in total).
