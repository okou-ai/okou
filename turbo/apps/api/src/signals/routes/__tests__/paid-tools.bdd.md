# paid-tools

## paid-tools-001

- Vitest: "lets an ordinary member disable and re-enable a tool idempotently"
- Mode: run
- Given: A signed-in ordinary workspace member with no disabled paid tools.
- When: The member reads `GET /api/paid-tools`, sets `web-search` via `PATCH /api/paid-tools/web-search` to disabled false, true and true, disables `social`, re-enables `web-search` twice, and lists again between steps.
- Then: The initial list is empty. Each `web-search` update returns exactly `{ toolId: "web-search", disabled: <value> }`. After disabling `social` the list is `["social", "web-search"]`, and after the two re-enables it is `["social"]`.

## paid-tools-002

- Vitest: "saves and re-enables the data-search preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `data-search`).
- When: The member disables `data-search` via `PATCH /api/paid-tools/data-search`, lists `GET /api/paid-tools`, re-enables `data-search`, and lists again.
- Then: The disable returns exactly `{ toolId: "data-search", disabled: true }` and the list is `["data-search", "web-search"]`. The re-enable returns `{ toolId: "data-search", disabled: false }` and the list is `["web-search"]`.

## paid-tools-003

- Vitest: "saves and re-enables the future-family preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `future-family`).
- When: The member disables `future-family` via `PATCH /api/paid-tools/future-family`, lists `GET /api/paid-tools`, re-enables `future-family`, and lists again.
- Then: The disable returns exactly `{ toolId: "future-family", disabled: true }` and the list is `["future-family", "web-search"]`. The re-enable returns `{ toolId: "future-family", disabled: false }` and the list is `["web-search"]`.

## paid-tools-004

- Vitest: "saves and re-enables the image-generation preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `image-generation`).
- When: The member disables `image-generation` via `PATCH /api/paid-tools/image-generation`, lists `GET /api/paid-tools`, re-enables `image-generation`, and lists again.
- Then: The disable returns exactly `{ toolId: "image-generation", disabled: true }` and the list is `["image-generation", "web-search"]`. The re-enable returns `{ toolId: "image-generation", disabled: false }` and the list is `["web-search"]`.

## paid-tools-005

- Vitest: "saves and re-enables the video-generation preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `video-generation`).
- When: The member disables `video-generation` via `PATCH /api/paid-tools/video-generation`, lists `GET /api/paid-tools`, re-enables `video-generation`, and lists again.
- Then: The disable returns exactly `{ toolId: "video-generation", disabled: true }` and the list is `["video-generation", "web-search"]`. The re-enable returns `{ toolId: "video-generation", disabled: false }` and the list is `["web-search"]`.

## paid-tools-006

- Vitest: "saves and re-enables the voice-generation preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `voice-generation`).
- When: The member disables `voice-generation` via `PATCH /api/paid-tools/voice-generation`, lists `GET /api/paid-tools`, re-enables `voice-generation`, and lists again.
- Then: The disable returns exactly `{ toolId: "voice-generation", disabled: true }` and the list is `["voice-generation", "web-search"]`. The re-enable returns `{ toolId: "voice-generation", disabled: false }` and the list is `["web-search"]`.

## paid-tools-007

- Vitest: "saves and re-enables the avatar-video-generation preference"
- Mode: run
- Given: A signed-in workspace member has disabled `web-search` (row `avatar-video-generation`).
- When: The member disables `avatar-video-generation` via `PATCH /api/paid-tools/avatar-video-generation`, lists `GET /api/paid-tools`, re-enables `avatar-video-generation`, and lists again.
- Then: The disable returns exactly `{ toolId: "avatar-video-generation", disabled: true }` and the list is `["avatar-video-generation", "web-search"]`. The re-enable returns `{ toolId: "avatar-video-generation", disabled: false }` and the list is `["web-search"]`.

## paid-tools-008

- Vitest: "isolates preferences across members and workspaces"
- Mode: run
- Given: A member has disabled `web-search`; a peer in the same workspace and the same user in another workspace have their own sessions.
- When: The peer lists `GET /api/paid-tools` and disables `finance`; the same user in the other workspace lists and disables `scrape`; then each identity lists its tools.
- Then: The peer and other-workspace identity each start with an empty list. Finally the member sees `["web-search"]`, the peer `["finance"]`, and the other-workspace identity `["scrape"]`.

## paid-tools-009

- Vitest: "preserves independent tool changes submitted concurrently"
- Mode: run
- Given: A signed-in workspace member with no disabled paid tools.
- When: The member concurrently disables `maps` and `seo` via `PATCH /api/paid-tools/:toolId`, then lists `GET /api/paid-tools`.
- Then: The list is `["maps", "seo"]`.

## paid-tools-010

- Vitest: "rejects caller-selected owners"
- Mode: run
- Given: A signed-in workspace member with no disabled paid tools.
- When: The member sends `PATCH /api/paid-tools/web-search` with `disabled: true` plus `userId: "another-user"`, and again plus `orgId: "another-org"`.
- Then: Both requests return HTTP 400, and the member's list stays empty.

## paid-tools-011

- Vitest: "requires a workspace session and rejects run credentials"
- Mode: run
- Given: A workspace member has disabled `web-search`; an anonymous caller, the user's session without an active organization, and run-scoped Okou and sandbox tokens for the member exist.
- When: The anonymous caller and the organization-less session read `GET /api/paid-tools`; each run token reads `GET /api/paid-tools` and tries to re-enable `web-search` via `PATCH`.
- Then: The anonymous and organization-less reads return HTTP 401. Every run-token read and update returns HTTP 403, and the member's list is still `["web-search"]`.

## paid-tools-012

- Vitest: "membership deletion clears exactly its paid tool preferences"
- Mode: run
- Given: A member, a peer in the same workspace, and the same user in another workspace have each disabled `web-search`.
- When: Clerk delivers a verified `organizationMembership.deleted` webhook for the member's membership to `POST /api/webhooks/clerk`, then each identity lists `GET /api/paid-tools`.
- Then: The webhook returns HTTP 200. The departed member's list is empty, while the peer and other-workspace identity still list `["web-search"]`.
