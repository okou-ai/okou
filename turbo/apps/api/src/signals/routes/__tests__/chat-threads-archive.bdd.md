# chat-threads-archive

## chat-threads-archive-001

- Vitest: "POST /api/chat-threads/:id/archive and /unarchive > toggles the archived flag and thread events without touching the title"
- Mode: run
- Given: A workspace user owns an unarchived thread titled "✅ Launch plan" and has a Run token for the owning workspace.
- When: The user archives it with a client event ID, repeats archive, then unarchives it with a second client event ID and reads metadata and the thread event feed.
- Then: All mutations return HTTP 204. Metadata keeps the exact title and changes archived from false to true and back to false. The feed exposes archived and unarchived events with the two provided IDs.

## chat-threads-archive-002

- Vitest: "POST /api/chat-threads/:id/archive and /unarchive > does not archive a same-user thread from another org"
- Mode: run
- Given: A thread is unarchived in one workspace, and its owner has a Run token for a different workspace.
- When: The owner uses the other workspace's token to archive the thread, then reads it in the owning workspace.
- Then: The archive request returns HTTP 404 `NOT_FOUND` with "Chat thread not found", and the original still reads back as unarchived.
