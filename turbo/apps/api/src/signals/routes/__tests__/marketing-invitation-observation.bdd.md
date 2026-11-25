# marketing-invitation-observation

## marketing-invitation-observation-001

- Vitest: "the source-only operator reports durable progress without settling the public invitation"
- Mode: run
- Given: A signed-in workspace member who completed onboarding invited a teammate through `POST /api/org/invite`, Clerk reports the invitation as pending, and a Marketing rewards event consumer is configured.
- When: The cron caller requests `GET /api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=25` with the cron secret.
- Then: The response is HTTP 200 with `cleaned` 0 and numeric `processed`, `sourcePending` and `unobservedInvitations` counts. The Marketing consumer has received an `invitation.status-observed` event.

## marketing-invitation-observation-002

- Vitest: "durably publishes minimal pending authority from the real invitation flow without issuing credits"
- Mode: run
- Given: A signed-in workspace member who completed onboarding, a Marketing rewards event consumer is configured, and Clerk reports the new invitation as `pending` with a 24-hour expiry plus private invitee email, metadata and ticket URL.
- When: The member invites a teammate with `POST /api/org/invite` and background work completes.
- Then: The consumer receives exactly one `invitation.status-observed` event for the invitation's claim, with version 6, environment `development`, the occurrence and claim times, org, user, claim ID, source key, invitation ID and observation `{ kind: "invitation", status: "pending", expiresAt }`. The events do not contain the invitee email, private metadata or invitation ticket.

## marketing-invitation-observation-003

- Vitest: "durably publishes minimal accepted authority from the real invitation flow without issuing credits"
- Mode: run
- Given: A signed-in workspace member who completed onboarding, a Marketing rewards event consumer is configured, and Clerk reports the new invitation as `accepted` with a 24-hour expiry plus private invitee email, metadata and ticket URL.
- When: The member invites a teammate with `POST /api/org/invite` and background work completes.
- Then: The consumer receives exactly one `invitation.status-observed` event for the invitation's claim, with version 6, environment `development`, the occurrence and claim times, org, user, claim ID, source key, invitation ID and observation `{ kind: "invitation", status: "accepted", expiresAt }`. The events do not contain the invitee email, private metadata or invitation ticket.

## marketing-invitation-observation-004

- Vitest: "durably publishes minimal unavailable authority from the real invitation flow without issuing credits"
- Mode: run
- Given: A signed-in workspace member who completed onboarding, a Marketing rewards event consumer is configured, and Clerk answers the invitation lookup with 404.
- When: The member invites a teammate with `POST /api/org/invite` and background work completes.
- Then: The consumer receives exactly one `invitation.status-observed` event for the invitation's claim, with version 6, environment `development`, the occurrence and claim times, org, user, claim ID, source key, invitation ID and observation `{ kind: "unavailable" }`, and no private invitee email, metadata or ticket.

## marketing-invitation-observation-005

- Vitest: "retains pending state on provider failure instead of inventing unavailability"
- Mode: run
- Given: A signed-in workspace member who completed onboarding, a Marketing rewards event consumer is configured, and Clerk answers the invitation lookup with HTTP 503.
- When: The member invites a teammate with `POST /api/org/invite` and background work completes.
- Then: The consumer receives the invitation attribution event but no `invitation.status-observed` event for that claim.

## marketing-invitation-observation-006

- Vitest: "retains pending state on different organization instead of inventing unavailability"
- Mode: run
- Given: A signed-in workspace member who completed onboarding, a Marketing rewards event consumer is configured, and Clerk returns the invitation as pending but owned by a different organization.
- When: The member invites a teammate with `POST /api/org/invite` and background work completes.
- Then: The consumer receives the invitation attribution event but no `invitation.status-observed` event for that claim.
