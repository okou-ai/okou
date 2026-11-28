# chat-input-status

## chat-input-status-001

- Vitest: "retained chat input observation > supports SDK discovery and calls (modern=true)"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and has an empty thread; the MCP SDK client pins protocol version `2026-07-28` (row `modern=true`).
- When: The SDK connects to the MCP server at `/mcp`, lists tools, and calls `get_chat_input_status` for the thread and an unknown event ID.
- Then: The tool list contains `get_chat_input_status`, the call is not an error, and its structured content equals the body returned by `GET /api/chat-threads/:threadId/inputs/:eventId/status` (HTTP 200, `Cache-Control: no-store`, within the maximum response size).

## chat-input-status-002

- Vitest: "retained chat input observation > supports SDK discovery and calls (modern=false)"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and has an empty thread; the MCP SDK client uses legacy version negotiation (row `modern=false`).
- When: The SDK connects to the MCP server at `/mcp`, lists tools, and calls `get_chat_input_status` for the thread and an unknown event ID.
- Then: The tool list contains `get_chat_input_status`, the call is not an error, and its structured content equals the body returned by `GET /api/chat-threads/:threadId/inputs/:eventId/status` (HTTP 200, `Cache-Control: no-store`, within the maximum response size).

## chat-input-status-003

- Vitest: "retained chat input observation > correlates MCP inputs sharing a Run and returns bounded, body-free terminal outcomes"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and a Runner is heartbeating.
- When: The member calls MCP `send_chat_message`, reads the input status, sends a second 32,001-character prompt to the same thread via MCP, the Runner fetches and declares the second input steered into the running Run via `/api/runners/runs/:runId/steerable-inputs/...`, and the Run then completes.
- Then: The first input reads `consumed` with its Run and no terminal; the second reads `queued` with no Run until steered, then `consumed` with the same Run, a replacement event different from itself, the same response size as the first, and no copy of the prompt; the MCP `get_chat_input_status` result equals the HTTP body within the size limit. After completion both inputs read `completed` with the thread's `run.completed` event ID, sequence and time as terminal (also via MCP), and the thread's `lastReadAt` is unchanged.

## chat-input-status-004

- Vitest: "retained chat input observation > returns the matching Chat failed event without its error body"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and sent a chat message with a known client event ID that started a Run (row "failed").
- When: The sandbox reports the Run failed with exit code 1 and error "private failure detail" via `POST /api/webhooks/run/complete`, and the member reads `GET /api/chat-threads/:threadId/inputs/:eventId/status`.
- Then: The status is `failed` with the Run ID and a terminal event ID, sequence number and timestamp, and the response does not contain "private failure detail".

## chat-input-status-005

- Vitest: "retained chat input observation > returns the matching Chat cancelled event without its error body"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and sent a chat message with a known client event ID that started a Run (row "cancelled").
- When: The member cancels the Run (HTTP 200) and reads the input status, then the sandbox reports exit code 1 with "private failure detail" and the member reads `GET /api/chat-threads/:threadId/inputs/:eventId/status` again.
- Then: Right after the cancel request the status is `consumed` with the Run ID and no terminal. Afterwards it is `cancelled` with the Run ID and a terminal event ID, sequence number and timestamp, and the response does not contain "private failure detail".

## chat-input-status-006

- Vitest: "retained chat input observation > keeps each input's Chat outcome when a later execution uses the same thread"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token; a first input with a known event ID ran and completed.
- When: The member sends a second input to the same thread that starts a new Run, the second Run fails, then object storage becomes unavailable and the member reads the first input and an unknown event ID via `GET /api/chat-threads/:threadId/inputs/:eventId/status`.
- Then: The first input reads `completed` with its Run and terminal event, and that body stays identical throughout. The second input reads `consumed` with the new Run and no terminal, then `failed` with a terminal event. With storage unavailable the first input still returns the same completed body and the unknown event reads `unavailable` with no input, replacement, Run or terminal.

## chat-input-status-007

- Vitest: "retained chat input observation > distinguishes an unassigned queued input, its recall and unavailable evidence"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and has a thread with an executing Run.
- When: The member sends another input with a known event ID via `POST /api/chat/events` (HTTP 201), reads its status, revokes it with MCP `revoke_queued_message`, reads it again, and reads an unknown event ID.
- Then: The input first reads `queued` with the input event, no replacement, Run or terminal; after the revoke it reads `revoked` with a replacement event and no Run or terminal; the unknown event reads `unavailable` with no input, replacement, Run or terminal.

## chat-input-status-008

- Vitest: "retained chat input observation > reports pre-Run rejection from the canonical replacement"
- Mode: run
- Given: A workspace owner completed onboarding, activated a Pro subscription without credits, and the subscription was cancelled by Stripe so the workspace is suspended with 0 credits; the owner holds an MCP OAuth access token.
- When: The owner sends `POST /api/chat/events` with model `null` and a known client event ID (HTTP 201), and then reads its status via `GET /api/chat-threads/:threadId/inputs/:eventId/status`.
- Then: The status is `rejected` with the input event, a replacement event, and no Run or terminal.

## chat-input-status-009

- Vitest: "retained chat input observation > exposes observation by default and enforces the read scope and validation"
- Mode: run
- Given: An entitled workspace member has an empty thread and MCP OAuth access tokens with the default scopes and with only `user:org:read okou:chat:send`.
- When: The member lists MCP tools, requests the input status for an unknown event ID with the restricted token, then with the default token over HTTP and via MCP `get_chat_input_status`.
- Then: `get_chat_input_status` is listed with `readOnlyHint: true`, the restricted token gets HTTP 403, and both the HTTP read and the MCP call report status `unavailable`.

## chat-input-status-010

- Vitest: "retained chat input observation > preserves user and organization isolation and requires original input identity"
- Mode: run
- Given: An entitled workspace member holds an MCP OAuth access token and sent an input with a known event ID that started a Run; the input status exposes a replacement event.
- When: The member reads the input under a different own thread, reads the replacement event's status, reads the input under an unknown thread, and then tokens for another user in the same organization and for the same user in another organization read the input over HTTP and via MCP `get_chat_input_status`.
- Then: The other-thread read is `unavailable` with no input, replacement, Run or terminal; the replacement event ID returns HTTP 400; the unknown thread returns HTTP 404. For both foreign identities the HTTP read returns HTTP 404 `NOT_FOUND` and the MCP call is an error.
