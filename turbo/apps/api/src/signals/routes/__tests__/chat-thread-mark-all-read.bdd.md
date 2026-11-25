# chat-thread-mark-all-read

## chat-thread-mark-all-read-001

- Vitest: "workspace bulk read > publishes nothing when every thread is already read"
- Mode: run
- Given: A workspace member has already marked every thread read.
- When: The member invokes bulk mark-read again.
- Then: The cursors read back unchanged and realtime receives no publication.

## chat-thread-mark-all-read-002

- Vitest: "workspace bulk read > accepts concurrent marks and publishes one indicator update"
- Mode: run
- Given: A workspace member has two unread threads.
- When: The member submits two concurrent bulk mark-read requests.
- Then: Both requests succeed, unread indicators become empty, and the realtime provider receives one indicator update.

## chat-thread-mark-all-read-003

- Vitest: "workspace bulk read > leaves unread threads older than the seven-day window untouched"
- Mode: run
- Given: A member has one unread thread outside the seven-day window and another inside it.
- When: The member marks all threads read and reads the cursors and unread list.
- Then: The stale thread's cursor remains unchanged. When the stale thread is back within the queried time window, it is the only unread thread.

## chat-thread-mark-all-read-004

- Vitest: "workspace bulk read > requires an organization and leaves foreign-user and cross-org requests without effects"
- Mode: run
- Given: A member has unread threads in their workspace. The member can use no workspace or another workspace, and a peer can use the same workspace.
- When: Those three contexts each submit a bulk mark-read request.
- Then: The orgless request returns HTTP 401 and the peer and cross-workspace requests return HTTP 204. The owner's cursors and unread set remain unchanged and there is no realtime publication.

## chat-thread-mark-all-read-005

- Vitest: "workspace bulk read > excludes muted threads from bulk marking but permits explicit single-thread marking"
- Mode: run
- Given: A workspace member mutes a thread while it is unread.
- When: The member marks all threads read, then explicitly marks the muted thread read and unmutes it.
- Then: Bulk read leaves its cursor unchanged and publishes nothing. Explicit marking advances the cursor, publishes one thread-cursor payload and keeps the mute flag until unmuted. After unmute the thread remains read.

## chat-thread-mark-all-read-006

- Vitest: "workspace bulk read > leaves another member's unread threads untouched"
- Mode: run
- Given: Two members have unread threads belonging to their own identities.
- When: One member marks all of their threads read.
- Then: Their unread set becomes empty and the second member's unread set remains intact.

## chat-thread-mark-all-read-007

- Vitest: "workspace bulk read > keeps the newest terminal event as the cursor and never moves a newer cursor backwards"
- Mode: run
- Given: A workspace member marks two threads read, then each receives a newer terminal Run event.
- When: The member reads the new unread timestamps, marks all threads read again and loads the stored cursors.
- Then: Each read cursor advances to the exact latest terminal timestamp returned as unread, without retaining the old value, and no unread threads remain.
