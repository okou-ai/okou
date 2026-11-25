# welcome-chat-threads-automatic

## welcome-chat-threads-automatic-001

- Vitest: "automatic welcome thread delivery > delivers one welcome thread to an invited member"
- Mode: run
- Given: A workspace admin exists and a second user has just been invited to the workspace as `org:member`.
- When: Clerk delivers a signed `organizationMembership.created` webhook for the member to `POST /api/webhooks/clerk`.
- Then: The member's `GET /api/chat-threads/events` shows exactly one created thread, whose metadata reads back with the same ID. Its event rows are exactly one `output.message` at sequence 1 with no Run ID.

## welcome-chat-threads-automatic-002

- Vitest: "automatic welcome thread delivery > delivers personal Instructions guidance to each invited member"
- Mode: run
- Given: A workspace admin has invited two different members as `org:member`.
- When: Clerk delivers a signed `organizationMembership.created` webhook for each member to `POST /api/webhooks/clerk`.
- Then: Each member has exactly one created thread, the two thread IDs differ, and each thread holds one event whose content contains "**Your preferences belong in personal Instructions.**".

## welcome-chat-threads-automatic-003

- Vitest: "automatic welcome thread delivery > delivers a separate welcome to the same member in each workspace"
- Mode: run
- Given: The same user is invited as `org:member` to two different workspaces.
- When: Clerk delivers a signed `organizationMembership.created` webhook for each membership to `POST /api/webhooks/clerk`.
- Then: In each workspace the user has exactly one created thread, the two thread IDs differ, and each thread holds one event whose content contains "**Your preferences belong in personal Instructions.**".

## welcome-chat-threads-automatic-004

- Vitest: "automatic welcome thread delivery > delivers a workspace creator's welcome from organization.created"
- Mode: run
- Given: Row `organization.created`. A user has just created a workspace and storage writes succeed.
- When: Clerk delivers a signed `organization.created` webhook for the creator's workspace to `POST /api/webhooks/clerk`.
- Then: The creator has exactly one created thread, its metadata reads back with the same ID, and it holds exactly one event.

## welcome-chat-threads-automatic-005

- Vitest: "automatic welcome thread delivery > delivers a workspace creator's welcome from organizationMembership.created"
- Mode: run
- Given: Row `organizationMembership.created`. A user has just created a workspace and storage writes succeed.
- When: Clerk delivers a signed `organizationMembership.created` webhook for the creator's membership to `POST /api/webhooks/clerk`.
- Then: The creator has exactly one created thread, its metadata reads back with the same ID, and it holds exactly one event.

## welcome-chat-threads-automatic-006

- Vitest: "automatic welcome thread delivery > keeps one thread across a redelivered event and two concurrent deliveries"
- Mode: run
- Given: A workspace admin has invited a member as `org:member`.
- When: Clerk delivers the member's `organizationMembership.created` webhook twice concurrently to `POST /api/webhooks/clerk`; then the member changes their locale to `zh-Hans` and Clerk redelivers the event.
- Then: Both concurrent deliveries return HTTP 200 and the member has exactly one created thread holding one event. After the locale change and redelivery the thread's event rows are unchanged, the member still has only that thread, and its metadata reads back with the same ID.

## welcome-chat-threads-automatic-007

- Vitest: "automatic welcome thread delivery > never delivers again after the recipient deletes the thread"
- Mode: run
- Given: An invited member received a welcome thread from `organizationMembership.created` and deleted it via `DELETE /api/chat-threads/:id` (HTTP 204).
- When: The member opens the app normally, reading `GET /api/onboarding/status` and `GET /api/chat-threads/snapshot`, then reads the deleted thread via `GET /api/chat-threads/:id`.
- Then: The thread lifecycle events still show only the original created thread, and reading the deleted thread returns HTTP 404.
