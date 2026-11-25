# chat-threads-pin-order

## chat-threads-pin-order-001

- Vitest: "pinned thread ordering > persists client ranks in events without changing pin time"
- Mode: run
- Given: A member owns two pinned threads and has a Run token for the workspace.
- When: The member reads the first thread's metadata, sends a reorder with rank `Zy` and a client event ID, then reads metadata and replays public thread events.
- Then: Reorder returns HTTP 204, the metadata including pin time is exactly unchanged, and the feed includes a `sort_touched` event with that ID and rank. The event-driven ordering places the first thread before the second.

## chat-threads-pin-order-002

- Vitest: "pinned thread ordering > accepts equal client ranks with deterministic id ordering"
- Mode: run
- Given: A workspace member owns two threads and is authorized to pin them.
- When: The member pins both with the same fractional rank `a0` and reads and replays thread events.
- Then: Both pins return HTTP 204 and the replay orders the tied threads deterministically by descending thread ID.

## chat-threads-pin-order-003

- Vitest: "pinned thread ordering > does not reorder an unpinned or other-org thread"
- Mode: run
- Given: A workspace member owns an unpinned thread and also has authorization in another workspace.
- When: The member reorders it while unpinned, then pins it and uses the other workspace's token to reorder it.
- Then: Both reorder attempts return HTTP 404.

## chat-threads-pin-order-004

- Vitest: "pinned thread ordering > validates fractional rank keys"
- Mode: run
- Given: A workspace member owns a pinned thread.
- When: The member asks to reorder and to pin it using the invalid fractional rank `a00`.
- Then: Each request returns HTTP 400.
