# Chat message history

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-history.test.tsx](chat-message-history.test.tsx).

## chat-message-history-001

Original test `A claimed queued message restores as the active run after refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-history.test.tsx#L18).

- **Given** A queued message has been claimed by an active run, with the claimed event revoking the queued event.
- **When** The chat is opened after refresh.
- **Then** The prompt appears once, is no longer marked as queued, and the active run shows a Stop control and “Thinking...” indicator.

## chat-message-history-002

Original test `A chat with no artifacts shows an empty resources panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-history.test.tsx#L56).

- **Given** A completed chat has no artifacts.
- **When** The user opens the Artifacts and chats panel.
- **Then** The panel displays “No artifacts yet.”

## chat-message-history-003

Original test `Show a migrated brief as ordinary chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-history.test.tsx#L97).

- **Given** A migrated brief is represented by a user request and a completed assistant response in chat history.
- **When** The chat is opened.
- **Then** The request appears as a user message and the result appears as an assistant message.
