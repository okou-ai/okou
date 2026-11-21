# Search result number shortcuts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [search-result-number-shortcuts.test.tsx](search-result-number-shortcuts.test.tsx).

## search-result-number-shortcuts-001

Original test `Limit empty search to 25 cached chats in sidebar order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/search-result-number-shortcuts.test.tsx#L156).

- **Given** The sidebar has 26 cached chats, with the first two pinned, and the remote chat list has not responded.
- **When** The user hides the chat list and opens an empty workspace search.
- **Then** Search shows 25 chats in sidebar order: Chat 1, Chat 2, then Chat 26 down through Chat 4. The remote chat-list request remains pending.

## search-result-number-shortcuts-002

Original test `Number only the first nine search results and open the ninth on Mac Chrome`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/search-result-number-shortcuts.test.tsx#L211).

- **Given** On Mac Chrome, the sidebar has 10 cached chats, with the first two pinned, and the remote chat list has not responded.
- **When** The user opens empty search with Command, then presses Command+9.
- **Then** The first nine results have numbered shortcuts and the tenth has none; the first shortcut is ⌘1. Pressing 9 opens Chat 4, closes search, and leaves the chat list hidden; the remote request remains pending.

## search-result-number-shortcuts-003

Original test `Open a resource from numbered search results in All`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/search-result-number-shortcuts.test.tsx#L302).

- **Given** Search results for “budget” include the chat “Budget planning,” the agent “Budget agent,” the workflow “Budget review,” and the file artifact “Budget report.”
- **When** The user selects the All filter and presses Control+4.
- **Then** The search navigates to /artifacts with the Budget report selected and the file tab active.
