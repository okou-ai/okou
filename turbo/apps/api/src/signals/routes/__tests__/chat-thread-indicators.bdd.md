# chat-thread-indicators

## chat-thread-indicators-001

- Vitest: "GET /api/indicators > reports unread timestamps for an Okou token without changing read state"
- Mode: run
- Given: An authenticated user has a cancelled unread thread and another cancelled thread already marked read, and a Run token for their workspace.
- When: The user requests the thread indicator projection and then reads both threads.
- Then: HTTP 200 lists only the unread thread with the matching unread timestamp. Neither thread's read timestamp changes.

## chat-thread-indicators-002

- Vitest: "GET /api/indicators > scopes unread indicators to the token user and organization"
- Mode: run
- Given: A user has an unread thread in their workspace. A peer in that workspace and the same user in another workspace each have unread threads.
- When: The user requests indicators with a Run token scoped to the owning identity and workspace.
- Then: HTTP 200 exposes exactly the caller's unread thread and its unread timestamp.

## chat-thread-indicators-003

- Vitest: "GET /api/indicators > reports read-cursor changes through indicators while mark responses carry no unread snapshot"
- Mode: run
- Given: A member owns two unread threads.
- When: The member marks one read, reads indicators, then marks it unread again and rereads indicators.
- Then: Mark-read returns a body containing only a non-null last-read timestamp and indicators list only the untouched thread as unread. Mark-unread returns only a null last-read timestamp, and indicator readback lists both threads and their unread timestamps.

## chat-thread-indicators-004

- Vitest: "GET /api/indicators > keeps an archived active thread unread on request until its terminal watermark is acknowledged"
- Mode: run
- Given: A member has two unread threads with terminal markers, then launches another Run on one of them, marks that thread unread and archives it.
- When: The member queries indicators with the default, an invalid active-unread flag and `includeActiveUnread=true`, then marks the active thread read, and later marks it unread and mutes it.
- Then: The default and invalid flag show the archived thread as active and only the other thread's unread timestamp. The true flag also exposes the active thread's terminal unread timestamp. Mark-read returns that timestamp as the watermark and removes it from indicator readback. Marking unread and muting keeps it omitted.

## chat-thread-indicators-005

- Vitest: "GET /api/indicators > keeps the most recent active threads independent of unread state"
- Mode: run
- Given: A member has three active threads and the indicator route is configured to retain the two most recent. The oldest has prior unread activity.
- When: The member asks for indicators with and without active-unread detail, then marks the oldest thread read.
- Then: HTTP 200 normally returns only the two newer active threads and no unread timestamps. Opting into active-unread detail also shows the older thread as unread without changing those two active result entries. Marking the older thread read returns its terminal timestamp and removes it from the expanded result.
