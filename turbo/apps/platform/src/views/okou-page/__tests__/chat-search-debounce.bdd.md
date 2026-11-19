# Chat search debounce

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-search-debounce.test.tsx](chat-search-debounce.test.tsx).

## chat-search-debounce-001

Original test `Search messages only after the latest input settles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-search-debounce.test.tsx#L79).

- **Given** A conversation is open and workspace search is available.
- **When** The user enters “3”, “32”, “320”, “3205”, then “32059” in quick succession.
- **Then** Only the settled latest keyword, “32059”, is searched, and a matching message is shown.

## chat-search-debounce-002

Original test `Clearing or closing search discards a pending message search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-search-debounce.test.tsx#L107).

- **Given** A conversation is open with workspace search available.
- **When** The user types “discarded” and clears the search before it settles, then searches for “issue”; later they type “dismissed” and close search with Escape, reopen search, and search for “budget”.
- **Then** The cleared and closed pending searches (“discarded” and “dismissed”) are not issued. Clearing shows the conversation title, reopening starts with an empty field, and the completed “issue” and “budget” searches show their keywords.

## chat-search-debounce-003

Original test `Search artifacts only after the latest input settles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-search-debounce.test.tsx#L152).

- **Given** A conversation is open and workspace search can return an artifact titled “Quarterly plan”.
- **When** The user enters “q”, “qu”, “qua”, “quar”, then “quart” in quick succession.
- **Then** Only the settled latest keyword, “quart”, is searched, and the “Quarterly plan” artifact is shown.
