# shared-threads

## shared-threads-001

- Vitest: "optional shared-thread titles > creates one private-content-safe snapshot with healthy title"
- Mode: run
- Given: A signed-in Pro member's Thread has a private title, a selected message "Publish the agreed launch checklist" and a later unselected private message. The title model is configured and returns "**Launch checklist**" (row `healthy title`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message ID twice, then the share is read with `GET /api/shared-threads/:id`, `GET /api/shared-threads/:id/meta` and the shared-thread artifact catalog.
- Then: The create returns HTTP 201 with only `id`. The share returns exactly one user message with the selected content and title "Launch checklist" with `cache-control: no-store`; meta returns that title with `no-store`; the catalog lists one `shared-thread` entry with that title whose detail links the share ID; none contain the private title, private message or provider text. Exactly one title request goes to `gemini-3.1-flash-lite` with 2048 max output tokens and minimal thinking, containing the selected content but not the private title or message.

## shared-threads-002

- Vitest: "optional shared-thread titles > creates one private-content-safe snapshot with rate limit"
- Mode: run
- Given: A signed-in Pro member's Thread has a private title, a selected message "Publish the agreed launch checklist" and a later unselected private message. The title model is configured but answers HTTP 429 with private provider text (row `rate limit`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message ID twice, then the share is read with `GET /api/shared-threads/:id`, `GET /api/shared-threads/:id/meta` and the shared-thread artifact catalog.
- Then: The create returns HTTP 201 with only `id`. The share has exactly the one selected user message and title "Shared conversation" (also in meta and the single catalog entry), with `no-store` caching and no private title, private message or provider text exposed. Exactly one title request goes to `gemini-3.1-flash-lite` containing only the selected content.

## shared-threads-003

- Vitest: "optional shared-thread titles > creates one private-content-safe snapshot with empty interpreted title"
- Mode: run
- Given: A signed-in Pro member's Thread has a private title, a selected message "Publish the agreed launch checklist" and a later unselected private message. The title model is configured and returns `---` (row `empty interpreted title`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message ID twice, then the share is read with `GET /api/shared-threads/:id`, `GET /api/shared-threads/:id/meta` and the shared-thread artifact catalog.
- Then: The create returns HTTP 201 with only `id`. The share has exactly the one selected user message and title "Shared conversation" (also in meta and the single catalog entry), with `no-store` caching and no private title, private message or provider text exposed. Exactly one title request goes to `gemini-3.1-flash-lite` containing only the selected content.

## shared-threads-004

- Vitest: "optional shared-thread titles > creates one private-content-safe snapshot with exhausted token budget"
- Mode: run
- Given: A signed-in Pro member's Thread has a private title, a selected message "Publish the agreed launch checklist" and a later unselected private message. The title model is configured and returns a truncated title with finish reason `MAX_TOKENS` (row `exhausted token budget`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message ID twice, then the share is read with `GET /api/shared-threads/:id`, `GET /api/shared-threads/:id/meta` and the shared-thread artifact catalog.
- Then: The create returns HTTP 201 with only `id`. The share has exactly the one selected user message and title "Shared conversation" (also in meta and the single catalog entry), with `no-store` caching and no private title, private message or provider text exposed. Exactly one title request goes to `gemini-3.1-flash-lite` containing only the selected content.

## shared-threads-005

- Vitest: "optional shared-thread titles > uses the fixed title and calls no provider without model configuration"
- Mode: run
- Given: A signed-in Pro member's Thread has a private title, a selected message and a later unselected private message. No title model is configured.
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message, then the share is read.
- Then: The create returns HTTP 201. The share, meta and single catalog entry use title "Shared conversation" with only the selected message and no private data, and no request reaches the title provider.

## shared-threads-006

- Vitest: "optional shared-thread titles > removes forwarded chat and quoted source identities from the public snapshot"
- Mode: run
- Given: A signed-in Pro member has a privately titled source Thread and forwards from its Run into another Thread a message quoting a sent Gmail reply and an artifact file `launch-plan.md` with the note "Keep the deadline".
- When: The member shares the forwarded message with `POST /api/chat-threads/:threadId/shared-threads` and anyone reads `GET /api/shared-threads/:id`.
- Then: The share returns HTTP 201 and has exactly one user message: "The user quoted 2 parts of your reply:" followed by both quotes and the note. The public snapshot contains none of the source Thread title, source Run ID, source Thread ID, mail ID, sent ID, file ID or artifact ID.

## shared-threads-007

- Vitest: "optional shared-thread titles > preserves a valid share when telemetry ingest fails"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message and a later unselected private message. The title model answers HTTP 429 and telemetry ingest fails (row `ingest`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message, and background work finishes.
- Then: The create returns HTTP 201 and background work completes without error. The share, meta and single catalog entry use title "Shared conversation" with only the selected message and no private data.

## shared-threads-008

- Vitest: "optional shared-thread titles > preserves a valid share when telemetry flush fails"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message and a later unselected private message. The title model answers HTTP 429 and telemetry flush fails (row `flush`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message, and background work finishes.
- Then: The create returns HTTP 201 and background work completes without error. The share, meta and single catalog entry use title "Shared conversation" with only the selected message and no private data.

## shared-threads-009

- Vitest: "optional shared-thread titles > preserves a valid share when telemetry phase-abort fails"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message and a later unselected private message. The title model answers HTTP 429 and ingest of `shared_thread_phase` telemetry is aborted (row `phase-abort`).
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting the message, and background work finishes.
- Then: The create returns HTTP 201 and background work completes without error. The share, meta and single catalog entry use title "Shared conversation" with only the selected message and no private data.

## shared-threads-010

- Vitest: "optional shared-thread titles > preserves API owner cancellation before the provider completes"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message, and the title model holds its response until released.
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` and the caller aborts the request while the title request is in flight; the provider later returns.
- Then: The request rejects with the caller's abort reason, and the provider request's signal is aborted with that same reason. The Thread has no shared-thread catalog entry, both immediately and after the provider returns and background work finishes.

## shared-threads-011

- Vitest: "optional shared-thread titles > keeps authentication, ownership and selection failures outside optional generation"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message and the title model is configured. Another member of the same organization and a user from another workspace exist.
- When: `POST /api/chat-threads/:threadId/shared-threads` is called unauthenticated, by each of the other two users, and by the owner with an unknown event ID.
- Then: The unauthenticated call returns HTTP 401, both other users receive HTTP 404, and the unknown selection returns HTTP 400 with `NO_SHAREABLE_MESSAGES`. The Thread has no shared-thread catalog entry.

## shared-threads-012

- Vitest: "optional shared-thread titles > rejects oversized selections before title generation"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message of 2 MiB and the title model is configured.
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` selecting that message.
- Then: The response is HTTP 413 with `SHARED_THREAD_TOO_LARGE`, and the Thread has no shared-thread catalog entry.

## shared-threads-013

- Vitest: "client-generated shared-thread IDs > publishes the share under the ID the client already copied"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message and no title model is configured.
- When: The member calls `POST /api/chat-threads/:threadId/shared-threads` with a client-generated share ID.
- Then: The response is HTTP 201 with that ID, and the share, meta and catalog entry under that ID use title "Shared conversation" with only the selected message.

## shared-threads-014

- Vitest: "client-generated shared-thread IDs > rejects an ID that already names another user's share without touching it"
- Mode: run
- Given: One Pro user already published a share. Another Pro user has their own Thread with a selected message.
- When: The second user calls `POST /api/chat-threads/:threadId/shared-threads` with the first user's existing share ID.
- Then: The response is HTTP 409 with `CONFLICT`. The original share still reads with its owner's content and title "Shared conversation", and the second user's Thread has no shared-thread catalog entry.

## shared-threads-015

- Vitest: "conversation share visibility > creates a private snapshot without publishing its content or title"
- Mode: run
- Given: A signed-in Pro member's Thread has a selected message, and the member is the only member of their original workspace. A user from another workspace exists.
- When: The member creates a share with `POST /api/chat-threads/:threadId/shared-threads/visibility` using an uppercase client ID and audience `private`; anonymous, owner and stranger callers read it.
- Then: The create returns HTTP 201. Anonymous `GET /api/shared-threads/:id` and its meta return HTTP 404 with `no-store` and without the content. The owner's read returns HTTP 200 with the selected content; the stranger's read returns 404 and the stranger's `GET /api/shared-threads/:id/visibility` returns 403 or 404.

## shared-threads-016

- Vitest: "conversation share visibility > changes an existing text-only link and checks membership in its original workspace on every read"
- Mode: run
- Given: A signed-in Pro member published an ordinary text-only share of a Thread message. Workspace membership is checked live against the member's original workspace.
- When: The owner reads `GET /api/shared-threads/:id/visibility`, updates it with `PUT /api/shared-threads/:id/visibility` (uppercase ID) to `organization`, a recipient reads while a member and after removal, the owner switches to `private` with the recipient re-added, then to `public`.
- Then: The initial audience is `public`. The organization update returns HTTP 200 naming the original workspace; anonymous read and meta then return 404. The recipient reads the content (HTTP 200) while a member and gets 404 after removal and while the share is private. After switching to public (HTTP 200) the anonymous read returns HTTP 200 with the same messages.

## shared-threads-017

- Vitest: "conversation share visibility > rejects stale edits and unauthorized changes while preserving private access"
- Mode: run
- Given: A signed-in Pro member created an organization-audience share with `POST /api/chat-threads/:threadId/shared-threads/visibility` and changed it to `private`. A user from another workspace exists.
- When: The owner retries `PUT /api/shared-threads/:id/visibility` to `public` with the stale revision, the other user tries it with the current revision, and the owner tries it while signed into the other user's organization; then anonymous and owner reads follow.
- Then: The change to private returns HTTP 200. The stale edit returns HTTP 409, the other user receives 404, and the wrong-organization session receives 403 or 404. Anonymous `GET /api/shared-threads/:id` still returns 404 and the owner's read returns HTTP 200 with the selected content.
