# native-oauth

## native-oauth-001

- Vitest: "native organization OAuth grants > reads only the grant owner's projects without granting project mutations"
- Mode: run
- Given: A member owns a project in their workspace; the same user owns a project in another workspace and another member owns a project in the same workspace. The member holds a native organization OAuth access token with scope `okou:project:read`.
- When: The token holder calls `GET /api/projects`, `/api/projects/snapshot`, `/api/projects/events`, the owned project and its threads, the other two projects and their threads, and tries `POST /api/projects`, `PATCH` and `DELETE /api/projects/:id`.
- Then: The list returns HTTP 200 with only the owned project; the snapshot, events, owned project and owned project threads return HTTP 200. Both foreign projects and their threads return HTTP 404. Create, update and delete return HTTP 401.

## native-oauth-002

- Vitest: "native organization OAuth grants > creates one owned thread for repeated requests with the same client thread ID"
- Mode: run
- Given: A member holds one OAuth token with `okou:chat:send okou:chat:read` and another with only `okou:chat:read`.
- When: The read-only token posts `POST /api/chat-threads` with a client thread ID and title "Cardputer Zero"; the send token posts the same payload twice and then reads `GET /api/chat-threads/:id/metadata`.
- Then: The read-only create returns HTTP 403. Both send-token creates return HTTP 201 with the client thread ID as `id` and the given title, and the metadata read returns HTTP 200 for that thread ID.

## native-oauth-003

- Vitest: "native organization OAuth grants > reads metadata and marks only same-workspace owned threads read"
- Mode: run
- Given: A member owns a thread; the same user owns a thread in another workspace and another member owns a thread in the same workspace. The member holds an OAuth token with `okou:chat:read`.
- When: The token holder reads `GET /api/chat-threads/:id/metadata` and calls `POST /api/chat-threads/:id/mark-read` for each thread.
- Then: For the owned thread the metadata returns HTTP 200 with its ID and mark-read returns HTTP 200 with `lastReadAt`. For both foreign threads both requests return HTTP 404.

## native-oauth-004

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/realtime/token (user:org:read okou:chat:send)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:send` (no chat read).
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401.

## native-oauth-005

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/projects (user:org:read okou:chat:read)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:read` (no project read).
- When: The token holder calls `GET /api/projects`.
- Then: The response is HTTP 403.

## native-oauth-006

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/voice-io/quota (user:org:read okou:chat:read)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:read`.
- When: The token holder calls `GET /api/voice-io/quota`.
- Then: The response is HTTP 403.

## native-oauth-007

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/chat-threads/9cc891c4-0b63-4154-99… (user:org:read okou:chat:send)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:send` (no chat read).
- When: The token holder calls `GET /api/chat-threads/:id/metadata` for a random thread ID.
- Then: The response is HTTP 403.

## native-oauth-008

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/chat-threads/406780e0-90d6-45b8-9d… (user:org:read okou:chat:send)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:send` (no chat read).
- When: The token holder calls `POST /api/chat-threads/:id/mark-read` for a random thread ID.
- Then: The response is HTTP 403.

## native-oauth-009

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/voice-io/transcribe/segment (user:org:read okou:chat:read)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:read`.
- When: The token holder calls `POST /api/voice-io/transcribe/segment` with an empty body.
- Then: The response is HTTP 403.

## native-oauth-010

- Vitest: "native organization OAuth grants > rejects insufficient grants on /api/voice-io/polish/segments (user:org:read okou:chat:read)"
- Mode: run
- Given: A member holds an OAuth token with scope `user:org:read okou:chat:read`.
- When: The token holder calls `POST /api/voice-io/polish/segments` with an empty body.
- Then: The response is HTTP 403.

## native-oauth-011

- Vitest: "native organization OAuth grants > bounds chat credentials at the latest redemption time for a 121s grant"
- Mode: run
- Given: A member holds an OAuth token with `okou:chat:read` that expires 121 seconds from now, and Ably signs token requests.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 200 with key name, the current timestamp, TTL of 1,000 ms (remaining time minus 120 s, capped at one hour), subscribe-only capability on `user-org:<user>:<org>` and `run-output:<user>:<org>:*`, the user as client ID, and the signed nonce and MAC. The timestamp plus the 120 s redemption window plus TTL does not exceed the grant expiration.

## native-oauth-012

- Vitest: "native organization OAuth grants > bounds chat credentials at the latest redemption time for a 7200s grant"
- Mode: run
- Given: A member holds an OAuth token with `okou:chat:read` that expires 7,200 seconds from now, and Ably signs token requests.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 200 with key name, the current timestamp, TTL capped at 3,600,000 ms, subscribe-only capability on `user-org:<user>:<org>` and `run-output:<user>:<org>:*`, the user as client ID, and the signed nonce and MAC. The timestamp plus the 120 s redemption window plus TTL does not exceed the grant expiration.

## native-oauth-013

- Vitest: "native organization OAuth grants > rejects a realtime grant with only 0s remaining using the existing 401 envelope"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that has 0 seconds remaining.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`, and no Ably token request is created.

## native-oauth-014

- Vitest: "native organization OAuth grants > rejects a realtime grant with only 30s remaining using the existing 401 envelope"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that has 30 seconds remaining.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`, and no Ably token request is created.

## native-oauth-015

- Vitest: "native organization OAuth grants > rejects a realtime grant with only 119s remaining using the existing 401 envelope"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that has 119 seconds remaining.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`, and no Ably token request is created.

## native-oauth-016

- Vitest: "native organization OAuth grants > rejects a realtime grant with only 120s remaining using the existing 401 envelope"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that has exactly 120 seconds remaining.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`, and no Ably token request is created.

## native-oauth-017

- Vitest: "native organization OAuth grants > rejects credentials when provider work crosses the OAuth expiration"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that expires in 300 seconds, and the clock reaches the expiration while Ably signs the token request.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`.

## native-oauth-018

- Vitest: "native organization OAuth grants > rejects a grant that expires during Clerk membership authentication"
- Mode: run
- Given: A member holds an OAuth token with `user:org:read okou:chat:read` that expires in 300 seconds, and the clock reaches the expiration while Clerk returns the member's organization membership.
- When: The token holder calls `POST /api/realtime/token`.
- Then: The response is HTTP 401 with `{ error: { message: "Authentication required", code: "UNAUTHORIZED" } }`, and no Ably token request is created.
