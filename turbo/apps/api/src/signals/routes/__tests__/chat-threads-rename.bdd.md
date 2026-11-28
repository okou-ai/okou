# chat-threads-rename

## chat-threads-rename-001

- Vitest: "POST /api/chat-threads/:id/rename > renames a thread with an Okou run token carrying chat-thread:write"
- Mode: run
- Given: A member owns a thread titled "Original title" and has a workspace Run token with `chat-thread:write`.
- When: The member renames it to "CLI renamed title" and reads its metadata.
- Then: Rename returns HTTP 204 and metadata returns HTTP 200 with the new title and same thread ID, Auto model, empty model settings, null pin, service tier and computer-use host, false archive, hidden and muted flags, and cloud browser enabled.

## chat-threads-rename-002

- Vitest: "POST /api/chat-threads/:id/rename > keeps the metadata title aligned with concurrent ordered rename events"
- Mode: run
- Given: A signed-in user owns a thread and has two distinct client event IDs.
- When: The user submits two concurrent renames with different titles and IDs, then reads the event feed and thread metadata.
- Then: Both writes return HTTP 204. The feed contains both rename IDs and the metadata title equals the rename with the greatest event sequence.

## chat-threads-rename-003

- Vitest: "POST /api/chat-threads/:id/rename > retains a caller's event identity when the same rename is delivered twice"
- Mode: run
- Given: A signed-in user owns a thread and provides a stable client event ID.
- When: The user delivers the identical rename twice, then reads events and metadata.
- Then: Both deliveries return HTTP 204, the feed contains exactly one rename with that client ID and the requested title, and metadata reports that title.

## chat-threads-rename-004

- Vitest: "POST /api/chat-threads/:id/rename > does not rename a same-user thread from another org"
- Mode: run
- Given: A member owns a thread in one workspace and has a Run token for another workspace.
- When: The member tries renaming the thread using the other workspace's token, then reads the thread in the owning workspace.
- Then: Rename returns HTTP 404 `NOT_FOUND` with "Chat thread not found" and the authorized metadata read returns the original title.
