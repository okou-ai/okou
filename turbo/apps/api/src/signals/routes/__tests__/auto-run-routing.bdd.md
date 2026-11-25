# auto-run-routing

## auto-run-routing-001

- Vitest: "Auto selection through public Thread creation > writes canonical Thread identity for Auto intent null"
- Mode: run
- Given: A signed-in Pro user can create chat threads and has a personal subscription providing the `claude-fable-5-1` model.
- When: The user creates a thread with `POST /api/chat-threads` and sets `model` to `null`.
- Then: Creation returns HTTP 201. `GET /api/chat-threads/events` responds with HTTP 200 and includes a `created` event with the new thread ID and `selectedModel: "auto"`. `GET /api/chat-threads/:id/metadata` returns HTTP 200 with `selectedModel: "auto"`.

## auto-run-routing-002

- Vitest: "Auto selection through public Thread creation > writes canonical Thread identity for Auto intent auto"
- Mode: run
- Given: A signed-in Pro user can create chat threads and has a personal subscription providing the `claude-fable-5-1` model.
- When: The user creates a thread with `POST /api/chat-threads` and sets `model` to `"auto"`.
- Then: Creation returns HTTP 201. `GET /api/chat-threads/events` responds with HTTP 200 and includes a `created` event with the new thread ID and `selectedModel: "auto"`. `GET /api/chat-threads/:id/metadata` returns HTTP 200 with `selectedModel: "auto"`.
