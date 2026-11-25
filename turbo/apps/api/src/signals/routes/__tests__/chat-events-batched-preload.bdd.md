# chat-events-batched-preload

## chat-events-batched-preload-001

- Vitest: "batched identity preload through chat entry > accepts member chat input and settles the empty preload"
- Mode: run
- Given: A workspace member has no existing organization snapshots.
- When: The member posts a Chat prompt selecting Claude Fable 5.1.
- Then: The send returns HTTP 201 with a thread ID and queued processing settles without an error.

## chat-events-batched-preload-002

- Vitest: "batched identity preload through chat entry > keeps independent member preferences and paid-tool snapshots in one organization with no slot subscriptions or expired credits"
- Mode: run
- Given: Two users belong to a paid workspace with no slot subscriptions or expired credits. The owner turns off the default cloud browser and disables Data Search and Social paid tools. A newly registered member has default preferences. Both have personal Claude Fable access.
- When: Both users send prompts selecting Claude Fable 5.1 and inspect their thread metadata and Runner dispatches.
- Then: The owner sees the browser disabled and exactly Data Search and Social in the dispatch's disabled tool list. The member sees the browser enabled and an empty disabled tool list. Both threads have empty model settings.
