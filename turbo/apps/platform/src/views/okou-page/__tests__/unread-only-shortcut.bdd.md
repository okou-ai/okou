# Unread only shortcut

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [unread-only-shortcut.test.tsx](unread-only-shortcut.test.tsx).

## unread-only-shortcut-001

Original test `Toggle unread-only chats and expose the shortcut`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unread-only-shortcut.test.tsx#L60).

- **Given** The user is viewing a chat on macOS and the chat list contains “Release plan,” with no unread chats.
- **When** They select the unread-only filter, then focus the message box and press Meta+Shift+U.
- **Then** The filter shows “No unread chats” without changing the current chat. The menu advertises Meta+Shift+U and Control+Shift+U and displays ⌘⇧U; the keyboard shortcut is handled and “Release plan” appears again.

## unread-only-shortcut-002

Original test `Show all chats from the empty unread state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unread-only-shortcut.test.tsx#L91).

- **Given** The user is viewing a chat on macOS and the chat list contains “Release plan,” with no unread chats.
- **When** They select the unread-only filter and then choose “Show all chats” from the empty unread state.
- **Then** “Release plan” appears in the list again and “No unread chats” is no longer shown.

## unread-only-shortcut-003

Original test `Open the first unread chat from the shortcut`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unread-only-shortcut.test.tsx#L112).

- **Given** The user is viewing “Release plan” on macOS. The chat list also contains “Incident follow-up,” which is unread.
- **When** They press Meta+Shift+U.
- **Then** The app navigates to “Incident follow-up,” the first unread chat.

## unread-only-shortcut-004

Original test `Only the latest shortcut toggle navigates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unread-only-shortcut.test.tsx#L143).

- **Given** The user is viewing “Release plan” on macOS. The chat list also contains “Incident follow-up,” which is unread.
- **When** They press Meta+Shift+U twice in succession.
- **Then** “Release plan” remains visible in the chat list and the current route stays on “Release plan”; the earlier toggle does not navigate to the unread chat.

## unread-only-shortcut-005

Original test `Keep the current chat when the selected filter lists it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/unread-only-shortcut.test.tsx#L176).

- **Given** The user is viewing “Incident follow-up” on macOS, and the chat list also contains “Release plan.”
- **When** They select the unread-only filter, then choose “Inbox” from the chat list menu.
- **Then** “Release plan” appears in the chat list again, while the current route remains “Incident follow-up.”
