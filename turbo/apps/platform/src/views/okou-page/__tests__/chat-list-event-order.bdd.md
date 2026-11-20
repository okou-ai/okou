# Chat list event order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-list-event-order.test.tsx](chat-list-event-order.test.tsx).

## chat-list-event-order-001

Original test `Conversation lifecycle events produce the current list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-event-order.test.tsx#L22).

- **Given** A cached chat list contains “Old conversation,” and the remote stream includes a rename, activity update, creation of “Current conversation,” and deletion of the old chat.
- **When** The chat page loads, first with the cached list and then with the remote stream.
- **Then** The list initially shows “Old conversation.” After the remote events arrive, it shows only “Current conversation,” linked to that conversation’s chat page.

## chat-list-event-order-002

Original test `A pinned conversation stays above newer unpinned items`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-event-order.test.tsx#L67).

- **Given** The cached list has three unpinned conversations, with “Oldest conversation” oldest and “Newest conversation” newest; the remote stream pins the oldest chat.
- **When** The chat page loads and the remote stream becomes available.
- **Then** Before the remote stream arrives, the list is newest, middle, oldest. After pinning is applied, the pinned oldest chat appears first, followed by newest and middle.

## chat-list-event-order-003

Original test `Pinned ordering follows pin time through activity updates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-event-order.test.tsx#L111).

- **Given** The list has three pinned chats with pin times of 00:50 and 00:51, with the latter time shared by “Second pin” and “Tied pin,” plus older and newer unpinned chats. Activity updates affect the second pin, first pin, and older regular chat; the newer regular chat is renamed.
- **When** The chat page loads and then receives the remote updates.
- **Then** Initially, pinned chats are ordered by pin time with the tied chats ordered “Tied pin” then “Second pin”; unpinned chats are ordered newest first. After the updates, pinned order is unchanged, while regular chats are ordered “Older regular chat” then “Updated regular chat.”

## chat-list-event-order-004

Original test `Unpinning restores activity order and repinning uses the new pin time`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-event-order.test.tsx#L173).

- **Given** The list contains “First pin” pinned at 00:50, “Second pin” pinned at 00:51, and “Regular chat.” The remote stream unpins the first chat.
- **When** The chat page loads, receives the unpin event, and later receives a pin event for the first chat.
- **Then** Before the remote event, the list is “Second pin,” “First pin,” “Regular chat.” After unpinning, it is “Second pin,” “Regular chat,” “First pin.” After repinning, the first chat moves above the second pin and regular chat, reflecting its new pin time.

## chat-list-event-order-005

Original test `Workflow visibility hides cached chats and restores the same conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-event-order.test.tsx#L230).

- **Given** The cached list contains visible “Visible workflow” and hidden “Background workflow” conversations. The remote stream hides the visible conversation and makes the background conversation visible.
- **When** The chat page loads and the remote visibility updates arrive.
- **Then** The cached list initially shows only “Visible workflow.” After the updates, it shows only “Background workflow,” linked to that same conversation.
