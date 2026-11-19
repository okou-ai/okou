# Chat offline cache

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-offline-cache.test.tsx](chat-offline-cache.test.tsx).

## chat-offline-cache-001

Original test `A missing chat is reported only after its current availability is confirmed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx#L271).

- **Given** An authenticated user opens a chat that is absent from the current chat availability response.
- **When** The app requests current chat availability while the response is delayed.
- **Then** The app keeps the loading skeleton visible and does not report the chat as missing until availability is confirmed. After confirmation, it shows “Chat thread not found,” dismisses the app skeleton, and omits the message composer.

## chat-offline-cache-002

Original test `Downloaded chat history replaces loading without a blank gap`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx#L316).

- **Given** An authenticated user opens a chat whose history is being downloaded while housekeeping remains pending.
- **When** The downloaded history becomes available.
- **Then** The loading placeholder is replaced directly by the prompt and answer, without a blank or empty-conversation state; the app skeleton is dismissed.

## chat-offline-cache-003

Original test `A stale remembered thread is replaced by its current availability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx#L363).

- **Given** An authenticated user opens a chat whose saved snapshot contains an outdated title, but current availability has not yet been confirmed and reports no chat.
- **When** The app first loads the remembered chat, then receives confirmation that the chat is absent.
- **Then** The remembered title and an enabled composer appear while availability is pending. After confirmation, the app shows “Chat thread not found,” dismisses the app skeleton, and removes the composer.

## chat-offline-cache-004

Original test `Saved messages appear without an empty-state flash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx#L415).

- **Given** An authenticated user opens a chat with saved messages in the local cache while housekeeping remains pending.
- **When** The saved history is rendered.
- **Then** The saved response appears and the app loading skeleton is dismissed without showing the chat loading placeholder or empty-conversation state.
