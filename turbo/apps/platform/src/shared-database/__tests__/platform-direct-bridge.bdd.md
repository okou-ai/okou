# Platform direct bridge

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [platform-direct-bridge.test.ts](platform-direct-bridge.test.ts).

## platform-direct-bridge-001

Original test `Preserve exact UTF-8 snapshot bytes across the worker protocol`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L87). · **intent review**

- **Given** An authenticated user opens the app with a chat-thread snapshot containing non-ASCII text, including Chinese characters and an emoji.
- **When** The app loads the snapshot through the worker and measures the IndexedDB snapshot payload.
- **Then** The loaded thread retains its exact title, and the reported payload size equals the UTF-8 byte size of the serialized snapshot, which exceeds its character count. This test verifies a worker-protocol byte contract rather than user-facing UI behavior.

## platform-direct-bridge-002

Original test `Show cached chat data before catching up live`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L151).

- **Given** An authenticated user has one chat event cached locally, and the initial server catch-up request is held pending.
- **When** The user opens the conversation, allows catch-up to return a second event, then a realtime notification exposes a third event.
- **Then** The cached event appears before catch-up completes; afterward the conversation contains events in sequence 1, 2, 3. Catch-up requests use successively increasing cursors without duplicates, and no new request starts after the conversation's lifecycle is reset.

## platform-direct-bridge-003

Original test `Cache incoming chat messages before the conversation is opened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L273).

- **Given** An authenticated user has an unread conversation that has not been opened, and the server can return its incoming events during catch-up.
- **When** A realtime notification announces a new message for that conversation before the user opens it, then the user opens it.
- **Then** The app requests catch-up for the unopened conversation, and opening it shows both incoming events in sequence order.

## platform-direct-bridge-004

Original test `Preserve every message during a burst of realtime notifications`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L351).

- **Given** An authenticated user has one cached event in an open conversation, while catch-up for the next events can be held pending; a separate conversation is unread and unopened.
- **When** A realtime notification starts catch-up, two more notifications arrive before the response is released.
- **Then** The open conversation eventually contains all three events in sequence order, without losing messages from the burst. The unread unopened conversation is also included in prewarming.

## platform-direct-bridge-005

Original test `Subscribe shared chat data through the worker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L460).

- **Given** An authenticated user opens the app with the shared-worker transport enabled.
- **When** The app initializes shared chat data.
- **Then** The app subscribes to the realtime channel and its chat-indicators topic through the worker.

## platform-direct-bridge-006

Original test `Keep the chat list current with realtime thread changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts#L492).

- **Given** An authenticated user opens the app when a chat-thread snapshot is followed by one remote rename event.
- **When** A realtime thread-list change announces a later rename event.
- **Then** The chat list first shows the snapshot thread with the first remote title, then updates it to the second remote title.
