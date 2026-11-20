# Unread through at

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [unread-through-at.test.ts](unread-through-at.test.ts).

## unread-through-at-001

Original test `unread-through instant for an open thread > keeps the Run terminal marker when it is the newer of the two`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/chat-page/__tests__/unread-through-at.test.ts#L6). · **intent review**

- **Given** An open thread has a Run terminal marker at 00:07 UTC and another marker at 00:06 UTC.
- **When** The unread-through instant is calculated.
- **Then** The result is the newer Run terminal marker, 2026-03-10T00:07:00Z.

## unread-through-at-002

Original test `unread-through instant for an open thread > falls back to the local marker when the server reports no unread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/chat-page/__tests__/unread-through-at.test.ts#L12). · **intent review**

- **Given** An open thread has a local marker at 00:04 UTC and the server reports no unread marker.
- **When** The unread-through instant is calculated.
- **Then** The result falls back to the local marker, 2026-03-10T00:04:00Z.
