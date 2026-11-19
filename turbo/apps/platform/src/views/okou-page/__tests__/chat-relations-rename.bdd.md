# Chat relations rename

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-relations-rename.test.tsx](chat-relations-rename.test.tsx).

## chat-relations-rename-001

Original test `Show the current parent title when loading historical sources`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations-rename.test.tsx#L212).

- **Given** A child chat has a historical source reference to a parent chat whose current title differs from the saved title snapshot.
- **When** The user opens the child chat's related-chats panel.
- **Then** The parent appears once with its current title and a “From” label, links to the parent chat, and its messages control is initially collapsed; no separate “From” region appears.

## chat-relations-rename-002

Original test `Update relationship titles immediately and synchronize the saved browser title without a realtime notification`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations-rename.test.tsx#L227).

- **Given** A parent chat and its related-chat entry show the original title.
- **When** The user renames the parent chat while the save is pending, then reopens the child's related-chats panel before the save completes.
- **Then** The relationship entry immediately shows the new title. After the save completes without a realtime notification, the dialog closes and the browser title includes the new title.

## chat-relations-rename-003

Original test `Update the parent chat row when another tab renames the parent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations-rename.test.tsx#L277).

- **Given** A child chat's related-chats panel shows the parent's original title, and relationship data is delayed.
- **When** Another tab renames the parent chat.
- **Then** The related-chat row updates to the new title before the delayed relationship data returns.

## chat-relations-rename-004

Original test `Keep unavailable relationships unlinked even when parent metadata is cached`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations-rename.test.tsx#L295).

- **Given** A child chat has an unavailable relationship to a parent whose metadata is cached.
- **When** The user opens the related-chats panel.
- **Then** The relationship is shown as “Unavailable” with a “From” label and no link; its messages control remains available and initially collapsed.
