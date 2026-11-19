# Chat list optimistic

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-list-optimistic.test.tsx](chat-list-optimistic.test.tsx).

## chat-list-optimistic-001

Original test `A new conversation appears before server confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L142).

- **Given** A user is composing a new conversation and the server has not confirmed its creation.
- **When** They send “Start the local conversation.”
- **Then** A single “New chat” appears in the sidebar with the requested thread ID before confirmation. No draft is requested.

## chat-list-optimistic-002

Original test `An optimistic QuickTime preview does not list artifacts before thread creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L160).

- **Given** A user is composing a new conversation and attaches a QuickTime video named recording.mov; thread creation remains unconfirmed.
- **When** They send the message with the attachment.
- **Then** A preview for recording.mov appears using the video URL with a start time of 0.001 seconds. The missing-thread artifact response produces no visible error toast, and creation remains unconfirmed.

## chat-list-optimistic-003

Original test `Thread actions wait for optimistic creation to settle (desktop: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L216).

- **Given** A user is composing a new conversation on desktop, and its server creation is pending.
- **When** They send a message, then the server confirms creation and the thread-list event arrives.
- **Then** Before confirmation, Change icon, Share messages, and Artifacts and chats are absent. After confirmation and the event, all three actions are visible.

## chat-list-optimistic-004

Original test `Thread actions wait for optimistic creation to settle (desktop: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L216).

- **Given** A user is composing a new conversation on a non-desktop device, and its server creation is pending.
- **When** They send a message, then the server confirms creation and the thread-list event arrives.
- **Then** Before confirmation, Change icon, Share messages, and More actions are absent. After confirmation and the event, all three actions are visible.

## chat-list-optimistic-005

Original test `The changed model survives the first send before server confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L257).

- **Given** A user is composing a new conversation with GPT 5.6 Luna selected, and server creation is pending.
- **When** They change the model to Claude Sonnet 5 and send their first message.
- **Then** The creation request uses Claude Sonnet 5, the composer still shows Claude Sonnet 5, no draft is requested, and creation remains unconfirmed.

## chat-list-optimistic-006

Original test `Sending in an older conversation moves it to the top`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L270).

- **Given** The sidebar lists an older conversation before a newer conversation, and the user opens the older conversation.
- **When** They send “Continue the older work” while the send request is still pending.
- **Then** The older conversation moves to the top of the sidebar, the optimistic message is visible, and the first sidebar link points to that older conversation.

## chat-list-optimistic-007

Original test `Server confirmation settles a new conversation without duplication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx#L323).

- **Given** A user starts a new conversation with Claude Sonnet 5 selected while server creation is pending.
- **When** They send a message, then the server confirms creation and the thread-list event arrives.
- **Then** The sidebar initially shows one “New chat” link. After confirmation, it shows one link for the same thread titled “Confirmed conversation,” with no duplicate.
