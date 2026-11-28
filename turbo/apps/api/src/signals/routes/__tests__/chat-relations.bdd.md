# chat-relations

## chat-relations-001

- Vitest: "chat relationships > returns all created chats once without inferring human-created children"
- Mode: run
- Given: An entitled workspace member has a source chat with a running `claude-fable-5-1` Run whose sandbox carries an `OKOU_TOKEN`. The member also created a separate thread in the app.
- When: The Run's token creates 50 child chats with `POST /api/chat-threads`, creates a 51st twice concurrently with the same `clientThreadId`, and calls `POST /api/chat-threads` with the member's existing thread ID as `clientThreadId`; the member then reads `GET /api/chat-threads/:id/relations/children` and `GET /api/chat-threads/:id/relations/communications` for the source chat.
- Then: The concurrent replay returns the same thread ID. The children list contains exactly the 51 created chats (not the human-created thread), with the first item linked to the source Run and status `idle`, and the communications list is empty.

## chat-relations-002

- Vitest: "chat relationships > records both directions between existing chats and attributes only consumed messages"
- Mode: run
- Given: An entitled workspace member has a source chat with a running Run and a separate peer thread.
- When: The source Run's token sends the same message to the peer twice concurrently via `POST /api/chat/events`; the resulting peer Run replies to the source chat; the source Run declares the reply steered twice; the source sends a message that the member then recalls; the source sends itself a follow-up and the member forwards a message to the peer with `sourceRunId` set to the source Run. The member reads the relations endpoints after each step.
- Then: `GET /api/chat-threads/:id/relations/communications/:peerId/messages` first lists exactly two items: the sent message from the source Run to the peer Run (with its text) and the received reply from the peer Run with no target Run. After steering, the newest item is the reply with the source Run as target. The recalled message has no target Run. Communications show the peer with 2 sent and 1 received from the source side and the source with 1 sent and 2 received from the peer side, and the source has no children.

## chat-relations-003

- Vitest: "chat relationships > returns all six communicating chats"
- Mode: run
- Given: An entitled workspace member has a source chat with a running Run and six peer threads (row "returns all six communicating chats": 6 peers, 1 message to the first peer).
- When: The source Run's token sends one message to each peer via `POST /api/chat/events`, and the member reads the source chat's communications and its messages with the first peer.
- Then: Communications list exactly the six peer threads; the first peer's messages contain exactly the sent message, ordered newest first by creation time.

## chat-relations-004

- Vitest: "chat relationships > returns all 21 messages in order"
- Mode: run
- Given: An entitled workspace member has a source chat with a running Run and one peer thread (row "returns all 21 messages in order": 1 peer, 21 messages).
- When: The source Run's token sends 20 messages to the peer in concurrent batches of four and then one final message via `POST /api/chat/events`, and the member reads the source chat's communications and its messages with the peer.
- Then: Communications list exactly the peer; the messages endpoint returns all 21 message event IDs, ordered newest first by creation time, with more than one distinct creation timestamp.

## chat-relations-005

- Vitest: "chat relationships > records implicit creation and enforces user and organization boundaries"
- Mode: run
- Given: An entitled workspace member has a source chat with a running Run; another user is in the same organization, and the same user also exists in another organization.
- When: The source Run's token sends the same message with a new `clientThreadId` twice concurrently via `POST /api/chat/events`, the member reads the source chat's children and messages with the new chat, the same-organization user reads children for the source chat and an unknown chat, and the other-organization identity reads the source chat's communications.
- Then: Both sends return HTTP 201 with the client thread ID. Children list exactly the new chat linked to the source Run, and messages list the sent event from the source Run. The other user gets HTTP 404 `{ error: { code: "NOT_FOUND", message: "Chat thread not found" } }` for both chats, and the other-organization identity gets HTTP 404.
