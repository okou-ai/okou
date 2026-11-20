# Chat resources navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-resources-navigation.test.tsx](chat-resources-navigation.test.tsx).

## chat-resources-navigation-001

Original test `Start the next chat closed and show only its own resources once its messages load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-navigation.test.tsx#L36).

- **Given** The user is viewing the first of two chats, whose resources panel shows first.pdf.
- **When** The user navigates to the second chat while its messages are still loading, then opens its resources panel and waits for loading to finish.
- **Then** The new chat starts with the panel closed; it shows a loading status, not first.pdf, and after loading shows second.pdf without first.pdf.

## chat-resources-navigation-002

Original test `Start the next chat closed and show only its own resources once its artifacts load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-navigation.test.tsx#L36).

- **Given** The user is viewing the first of two chats, whose resources panel shows first.pdf.
- **When** The user navigates to the second chat while its artifacts are still loading, then opens its resources panel and waits for loading to finish.
- **Then** The new chat starts with the panel closed; it shows a loading status, not first.pdf, and after loading shows second.pdf without first.pdf.

## chat-resources-navigation-003

Original test `Keep chat shortcuts blocked by the rename dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-navigation.test.tsx#L226).

- **Given** The user is in a chat with the Rename chat dialog open and its title field focused.
- **When** The user presses the chat-navigation shortcut while typing in the title field.
- **Then** The URL remains on the same chat and focus stays in the title field.

## chat-resources-navigation-004

Original test `Pause chat shortcuts while the artifacts panel is open, like other header panels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-navigation.test.tsx#L240).

- **Given** The user is viewing a chat with the resources panel open.
- **When** The user presses the shortcut for the adjacent chat, closes the panel with Escape, then presses the shortcut again.
- **Then** The first shortcut leaves the current chat selected; after the panel closes, the same shortcut navigates to the newer chat.
