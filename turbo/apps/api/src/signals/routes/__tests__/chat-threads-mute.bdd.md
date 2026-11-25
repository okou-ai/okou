# chat-threads-mute

## chat-threads-mute-001

- Vitest: "chat thread muting > persists idempotent mute changes independently of archive and activity ordering"
- Mode: run
- Given: An authenticated member owns a Chat titled "Keep this title".
- When: The owner archives it, mutes it with an event ID, repeats mute, then unmutes it with another event ID.
- Then: All changes return HTTP 204. Metadata changes muted true then false while keeping archived true and the original title. The event feed returns both client event IDs as `sort_touched` entries with their corresponding mute values.

## chat-threads-mute-002

- Vitest: "chat thread muting > signals indicator changes after muting, unmuting and deleting"
- Mode: run
- Given: An authenticated user owns a Chat and subscribes to realtime indicator updates.
- When: The owner mutes, unmutes and then deletes the Chat.
- Then: Each operation publishes `chatIndicatorsChanged` with a null payload.

## chat-threads-mute-003

- Vitest: "chat thread muting > does not expose threads across user or organization boundaries"
- Mode: run
- Given: A workspace user owns an unmuted thread. An unauthenticated client, another user in the workspace and the owner in a different workspace can try the endpoint.
- When: They attempt to mute or unmute the thread.
- Then: The unauthenticated mute returns HTTP 401. Both signed-in outsiders receive HTTP 404 for mute and unmute. The owner still reads back muted false.
