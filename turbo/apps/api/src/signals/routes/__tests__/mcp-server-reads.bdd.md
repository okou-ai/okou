# mcp-server-reads

## mcp-server-reads-001

- Vitest: "thin MCP Web adapters > discovers and calls the same tools through the SDK (modern=true)"
- Mode: run
- Given: A member on limited free onboarding holds a valid MCP OAuth access token with the full Web scopes, and an MCP SDK client pins the modern protocol version `2026-07-28`.
- When: The client connects to `POST /mcp` with streamable HTTP, lists tools, calls `search_chat_messages`, calls `send_chat_message` with a structured user message (text, feedback and a Slack source part), and then calls `get_chat_messages` and `get_chat_thread_list`.
- Then: Exactly the 14 expected tools are listed, all with valid input and output JSON schemas; the search tool documents CJK tokenization and UTF-16 match ranges, and the send tool accepts `userMessage` but not together with `prompt`. Search returns `{ results: [] }`. The send returns structured content equal to its text JSON. History contains the `input.prompt` event with the content parts and the source replaced by `{ kind: "mcp", clientId: "mcp_test_client" }`, and the thread list contains a `created` event for the thread.

## mcp-server-reads-002

- Vitest: "thin MCP Web adapters > discovers and calls the same tools through the SDK (modern=false)"
- Mode: run
- Given: A member on limited free onboarding holds a valid MCP OAuth access token with the full Web scopes, and an MCP SDK client uses legacy version negotiation.
- When: The client connects to `POST /mcp` with streamable HTTP, lists tools, calls `search_chat_messages`, calls `send_chat_message` with a structured user message (text, feedback and a Slack source part), and then calls `get_chat_messages` and `get_chat_thread_list`.
- Then: Exactly the 14 expected tools are listed, all with valid input and output JSON schemas; the search tool documents CJK tokenization and UTF-16 match ranges, and the send tool accepts `userMessage` but not together with `prompt`. Search returns `{ results: [] }`. The send returns structured content equal to its text JSON. History contains the `input.prompt` event with the content parts and the source replaced by `{ kind: "mcp", clientId: "mcp_test_client" }`, and the thread list contains a `created` event for the thread.

## mcp-server-reads-003

- Vitest: "thin MCP Web adapters > does not fall back from expired OAuth to a browser identity or enable unscoped Web routes"
- Mode: run
- Given: A member has an MCP OAuth token and also a valid browser session.
- When: The member calls `GET /api/run-models` with an expired MCP token, and `GET /api/billing/status` with a valid MCP token.
- Then: Both requests return HTTP 401; the expired token does not fall back to the browser identity and billing status is not reachable with an MCP token.

## mcp-server-reads-004

- Vitest: "thin MCP Web adapters > keeps OAuth signing-key outages distinct from invalid credentials on the Web entry"
- Mode: run
- Given: A member holds a valid MCP OAuth token, and Clerk's JWKS endpoint returns HTTP 503.
- When: The member calls `GET /api/run-models` with the MCP token.
- Then: The response is HTTP 503 with code `PROVIDER_UNAVAILABLE`.

## mcp-server-reads-005

- Vitest: "thin MCP Web adapters > preserves send/manage/cancel grants and checks each Web event operation's scope"
- Mode: run
- Given: A member holds MCP OAuth tokens with read scopes plus one of `okou:chat:send`, `okou:run:cancel` or `okou:chat:manage`, and has sent a chat message.
- When: For each token the client lists tools and calls a tool outside its scope over `POST /mcp`; then `POST /api/chat/events` is called to revoke a message with only the send scope and to send a message with only the cancel scope.
- Then: The send token lists `send_chat_message` but not `revoke_queued_message`, the cancel token lists `revoke_queued_message` but not `send_chat_message`, and the manage token lists `rename_chat_thread` but not `cancel_run`; each out-of-scope call returns a JSON-RPC error. Both mismatched Web event requests return HTTP 403.

## mcp-server-reads-006

- Vitest: "thin MCP Web adapters > returns unmodified Web project and model lists"
- Mode: run
- Given: A member holds a valid MCP OAuth token.
- When: The member calls `GET /api/projects` and `GET /api/run-models` directly with the token, and the MCP tools `list_projects` and `list_models`.
- Then: Both Web requests return HTTP 200, and each tool returns exactly the same body as its Web route.

## mcp-server-reads-007

- Vitest: "thin MCP Web adapters > starts a Chat in an owned Project and continues a retained Agent Chat by thread ID"
- Mode: run
- Given: A member created a Project "Research" with `POST /api/projects` and holds an MCP token; a peer user in the same organization holds their own MCP token. The member also has a retained chat thread.
- When: Both call MCP tools `list_projects`, `list_project_threads` and `send_chat_message` for the Project; the member sends into the Project, reads `get_chat_thread_list` and `list_project_threads` (limit 1), sends with both `threadId` and `projectId`, and continues the retained thread by ID.
- Then: The member sees the Project and the peer sees none; the peer's thread list and send return `NOT_FOUND`. The member's Project send creates a thread recorded as `created` in the Project and listed with `nextAfter` null. Sending with both IDs returns `BAD_REQUEST`. Continuing the retained thread returns that thread ID and its event appears in the thread rows.

## mcp-server-reads-008

- Vitest: "thin MCP Web adapters > reflects committed Run transitions without marking indicator or history reads as read"
- Mode: run
- Given: A member with an MCP token has a running chat run whose thread has never been read.
- When: The member calls MCP `get_chat_indicators`, the Runner starts executing, the member calls it again, cancels with `cancel_run`, reads `get_chat_messages`, and calls `get_chat_indicators` once more.
- Then: The first two indicator reads return the thread as `active` with no unread entries. The cancel returns status `cancelled`. History has no snapshot, no more pages and a `run.cancelled` row for the run. The final indicators show the thread `unread` at the cancellation row's time, and the thread's `lastReadAt` stays null.

## mcp-server-reads-009

- Vitest: "thin MCP Web adapters > returns the generated input identity and persists plain text through the ordinary event stream"
- Mode: run
- Given: A member holds an MCP token issued to client `https://client.example.test/oauth/metadata`.
- When: The member sends the plain-text prompt "Figma logo\n请展示最终方案" with MCP `send_chat_message` twice (the second continuing the thread), then posts the same text to `POST /api/chat/events` with the first `eventId` as `clientEventId`.
- Then: The second send stays in the same thread with a new event ID. The thread has exactly one row for the first event, an `input.prompt` with the text part and an MCP source part carrying the client ID. The Web post returns HTTP 201 with the same thread ID and `createdAt`, and no duplicate row is created.

## mcp-server-reads-010

- Vitest: "thin MCP Web adapters > uses ordinary Web send semantics for independent requests"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The member sends the same message twice with MCP `send_chat_message` without a thread ID.
- Then: The two sends create different threads and different event IDs.

## mcp-server-reads-011

- Vitest: "thin MCP Web adapters > projects raw-row entity references and preserves payloads, event identities and paired cursors"
- Mode: run
- Given: A member sent a chat message through MCP.
- When: The member calls MCP `get_chat_messages` with limit 1, compares it with `GET /api/chat-threads/:id/event-rows?sinceSeqId=0&limit=1`, pages forward with the returned cursor, and retries with a mismatched cursor event ID and with `sinceSeqId` alone.
- Then: The MCP page equals the Web page with no snapshot and each row's `id`/`chatThreadId` renamed to `eventId`/`threadId`; it has one row and `hasMore` true. The next page's row has a higher sequence number. The mismatched cursor returns `CHAT_EVENTS_EXPIRED` and the unpaired `sinceSeqId` returns `BAD_REQUEST`.

## mcp-server-reads-012

- Vitest: "thin MCP Web adapters > projects lifecycle events without exposing execution identities"
- Mode: run
- Given: A member sent a chat message through MCP.
- When: The member calls MCP `get_chat_thread_list`, compares it with `GET /api/chat-threads/events`, and calls it again with `sinceSeqId` set to the last event's sequence number.
- Then: The MCP result equals the Web events with an empty snapshot and `id`/`chatThreadId` renamed to `eventId`/`threadId`, and includes the sent thread. The follow-up has no snapshot, no events and `hasMore` false.

## mcp-server-reads-013

- Vitest: "thin MCP Web adapters > shares rename and model-selection responses and emits the same Web model/tier events"
- Mode: run
- Given: A member sent a chat message through MCP.
- When: The member calls MCP `rename_chat_thread` with a new title and `update_chat_thread_model` with model null and supplied event IDs, then reads the chat thread events and `get_chat_thread_list`.
- Then: Both tools return `{ content: [] }`. The thread title becomes "Renamed with Web". The Web thread events include `model_selection_updated` with `selectedModel` `auto` and `service_tier_updated` with `serviceTier` null under the supplied IDs, and the MCP lifecycle list contains both events.

## mcp-server-reads-014

- Vitest: "thin MCP Web adapters > recalls the supplied event directly and returns the native Web response"
- Mode: run
- Given: A Pro member has an active run holding the thread's queue and sends another message through MCP.
- When: The member calls MCP `revoke_queued_message` for that event with a cancel-scoped token, posts the same revoke to `POST /api/chat/events`, and reads `get_chat_messages`.
- Then: The MCP recall succeeds and returns the Web send response plus `runId` null. History contains a `control.revoke` row revoking the sent event.

## mcp-server-reads-015

- Vitest: "thin MCP Web adapters > preserves Web search filters and empty results"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The member calls `GET /api/chat/search?keyword=plain%20keyword` and MCP `search_chat_messages` with the same keyword.
- Then: The MCP search returns `{ results: [] }`, identical to the Web response.

## mcp-server-reads-016

- Vitest: "thin MCP Web adapters > keeps ownership and organization checks in the Web routes"
- Mode: run
- Given: A member sent a chat message through MCP; a peer in the same organization holds their own MCP token, and another organization has its own thread.
- When: The peer calls MCP `get_chat_messages`, `rename_chat_thread`, `revoke_queued_message` and `send_chat_message` on the member's thread, and the member sends into the other organization's thread.
- Then: Every call returns an MCP error with code `NOT_FOUND`.

## mcp-server-reads-017

- Vitest: "thin MCP Web adapters > binds OAuth snapshots and raw rows to the grant organization even for the same user"
- Mode: run
- Given: A member's MCP grant is bound to their first organization; the same user has a thread in a second organization.
- When: The member calls `GET /api/chat-threads/:id/event-snapshot` and `GET /api/chat-threads/:id/event-rows?sinceSeqId=0` for that thread with the MCP token, MCP `get_chat_messages`, and `get_chat_thread_list`.
- Then: Both Web requests return HTTP 404 `NOT_FOUND`, `get_chat_messages` returns `NOT_FOUND`, and the thread list does not include that thread.

## mcp-server-reads-018

- Vitest: "thin MCP Web adapters > preserves Web validation errors rather than inventing MCP error codes"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The member calls MCP `send_chat_message` with an empty prompt and posts the same empty message to `POST /api/chat/events`.
- Then: The MCP result is an error with code `BAD_REQUEST`, identical to the Web response body.

## mcp-server-reads-019

- Vitest: "thin MCP Web adapters > authorizes OAuth cancellation through the same Web entry, preserving peer denial and cancellation side effects"
- Mode: run
- Given: A Pro member has a running chat run, holds an MCP token, and a peer user holds their own MCP token.
- When: The member calls MCP `get_chat_activity_summary` and `POST /api/chat-threads/:id/activity-summary`; `POST /api/runs/:runId/cancel` is called with a read-only token and by the peer; the peer calls MCP `cancel_run`; the member calls `cancel_run` with the upper-case run ID; then the member calls the Web cancel again.
- Then: Both activity summaries return the run ID (Web HTTP 200). The read-only Web cancel returns HTTP 403 `FORBIDDEN`, and the peer's MCP cancel returns the same body as the peer's Web denial. The member's cancel returns run ID, status `cancelled` and "Run cancelled successfully", and the run reads back `cancelled`. The repeated Web cancel returns HTTP 200 with the same ID, status and message.
