# Chat idb

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-idb.test.ts](chat-idb.test.ts).

## chat-idb-001

Original test `Local conversation data is isolated by user and workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/chat-idb.test.ts#L28).

- **Given** A user and workspace each have local conversation databases, and Alice's private thread snapshot is saved in her primary workspace.
- **When** The snapshot is read from Alice's other workspace and from Bob's database.
- **Then** It exists in Alice's primary workspace and is absent from both other databases.

## chat-idb-002

Original test `A local chat-cache upgrade closes the old connection and notifies its owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/chat-idb.test.ts#L68).

- **Given** An older local chat database contains a thread snapshot record.
- **When** The current chat database is opened, then another connection opens a newer version.
- **Then** The existing record is preserved, the database has all expected chat and project stores and an event-order index, and events with sequence IDs 1, 2, and 3 are returned in that order. The newer open triggers exactly one version-change notification to the existing owner.
