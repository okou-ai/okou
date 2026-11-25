# chat-threads-get

## chat-threads-get-001

- Vitest: "GET /api/chat-threads/:id/metadata > hides the thread from the same user's other workspace"
- Mode: run
- Given: A user owns a thread in one workspace and has a Run token with authority in another workspace.
- When: The user sends `GET /api/chat-threads/:id/metadata` for the owned thread with the other workspace's token.
- Then: The request returns HTTP 404 with `NOT_FOUND`.

## chat-threads-get-002

- Vitest: "GET /api/chat-threads/:id/metadata > returns thread metadata with an Okou run token carrying chat-thread:read"
- Mode: run
- Given: A workspace member owns a new thread named "Launch plan" and has a Run token with `chat-thread:read` for its workspace.
- When: The member sends `GET /api/chat-threads/:id/metadata` using the token.
- Then: HTTP 200 returns exactly the thread ID and title, Auto selected model, empty model settings, null service tier, pin and computer-use host, false archived, hidden and muted flags, and cloud browser enabled.
