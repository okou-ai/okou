# chat-thread-read-cursor

## chat-thread-read-cursor-001

- Vitest: "chat thread read cursor > advances the native read watermark with OAuth chat read scope"
- Mode: run
- Given: A member has an unread thread and a workspace OAuth token with Chat read scope.
- When: The member posts mark-read with that token.
- Then: HTTP 200 reports an advanced `lastReadAt` matching the thread's readback and the thread disappears from unread indicators.

## chat-thread-read-cursor-002

- Vitest: "chat thread read cursor > advances a read to the latest terminal marker and repeats without a second invalidation"
- Mode: run
- Given: An authenticated member has a thread with an unacknowledged terminal marker.
- When: The member marks it read twice and reads back its cursor.
- Then: The first request advances `lastReadAt` and publishes `chatThreadReadCursorUpdated` with the thread ID and timestamp on the user/workspace channel. Repeating returns the stored timestamp without another realtime publication, and the readback matches it.

## chat-thread-read-cursor-003

- Vitest: "chat thread read cursor > accepts competing marks and publishes only the committed cursor advance"
- Mode: run
- Given: An authenticated user has an unread thread ready to mark read.
- When: The member submits two mark-read requests concurrently, then reads the stored cursor and unread state.
- Then: The cursor advances and at least one response contains the committed timestamp, while each reports either that timestamp or its prior read value. Exactly one realtime event carries the committed cursor, and the thread disappears from unread indicators.

## chat-thread-read-cursor-004

- Vitest: "chat thread read cursor > requires the thread's organization for read cursor writes"
- Mode: run
- Given: A member has an unread thread and can also authenticate without a workspace or with a different workspace.
- When: The member issues mark-read and mark-unread using each mismatched scope, then reads the original thread.
- Then: Both orgless writes return HTTP 400 and both other-workspace writes return HTTP 404. Realtime receives no publication and the original cursor stays unchanged.

## chat-thread-read-cursor-005

- Vitest: "chat thread read cursor > returns 404 for another user's thread and for a missing thread"
- Mode: run
- Given: A user owns a thread and a different user shares the same workspace. An unknown thread ID is available.
- When: The other member marks the owned thread read and unread, then the owner marks the unknown thread read and unread.
- Then: Every request returns HTTP 404 and there is no realtime publication.

## chat-thread-read-cursor-006

- Vitest: "chat thread read cursor > clears the cursor on mark-unread and shows the thread as unread again"
- Mode: run
- Given: An authenticated member owns an unread thread that is then marked read.
- When: The member marks it unread again and reads the thread and unread indicators.
- Then: The read cursor is null and the thread appears as unread again.
