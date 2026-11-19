# Chat list entry navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-list-entry-navigation.test.tsx](chat-list-entry-navigation.test.tsx).

## chat-list-entry-navigation-001

Original test `Chat navigation passes For you and New chat above the list without consuming a card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-entry-navigation.test.tsx#L136).

- **Given** The newest chat is open, For you is enabled, and a suggestion card is available.
- **When** Use Ctrl+Shift+Up and Down to navigate from the chat through For you and New chat, then back down through For you to the chat; navigate up to For you again.
- **Then** Up from the newest chat selects For you, then New chat. From New chat, Down selects For you and then returns to the newest chat. The suggestion card remains available on the next visit to For you.

## chat-list-entry-navigation-002

Original test `Without For you, the first chat moves up to New chat and New chat moves down into the list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-entry-navigation.test.tsx#L181).

- **Given** The newest chat is open and For you is disabled.
- **When** Use Ctrl+Shift+Up to move to New chat, then Ctrl+Shift+Down.
- **Then** Up selects New chat; Down returns to the newest chat.

## chat-list-entry-navigation-003

Original test `The side pane moves only between chats and never onto the entries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-entry-navigation.test.tsx#L202).

- **Given** The older chat is open with the newest chat in the side pane, and For you is enabled.
- **When** Focus the side-pane composer and use Ctrl+Shift+Up, then Ctrl+Shift+Down.
- **Then** The side pane moves to the middle chat while the main page remains on the older chat; navigation does not move onto New chat or For you.
