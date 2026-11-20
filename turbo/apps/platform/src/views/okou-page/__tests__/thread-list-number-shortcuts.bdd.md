# Thread list number shortcuts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [thread-list-number-shortcuts.test.tsx](thread-list-number-shortcuts.test.tsx).

## thread-list-number-shortcuts-001

Original test `Reveal only the first nine hints after a 500 ms hold`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-list-number-shortcuts.test.tsx#L74).

- **Given** The user is viewing a chat list containing eleven chats in standalone mode on Mac Chrome.
- **When** The user holds the Command key for at least 500 ms, then releases it.
- **Then** No number hints appear before the hold reaches 500 ms. During the hold, hints appear only for the first nine chats and are labeled ⌘1 through ⌘9; releasing Command hides them.

## thread-list-number-shortcuts-002

Original test `Open the ninth chat using its visible hint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-list-number-shortcuts.test.tsx#L95).

- **Given** The user is viewing a chat list with at least nine chats in standalone mode on Mac Chrome.
- **When** The user holds Command and presses 9.
- **Then** The ninth chat in the visible list opens, and the number hints disappear.

## thread-list-number-shortcuts-003

Original test `Keep browser mode free of number shortcuts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-list-number-shortcuts.test.tsx#L109).

- **Given** The user is in browser mode viewing a chat, with two chats in the sidebar.
- **When** The user presses Ctrl+1.
- **Then** No number hints appear, the current chat remains open, and the browser does not prevent the key event’s default behavior.
