# Chat navigation conversation state

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-navigation-conversation-state.test.tsx](chat-navigation-conversation-state.test.tsx).

## chat-navigation-conversation-state-001

Original test `Explain unavailable email cards in a conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-conversation-state.test.tsx#L156).

- **Given** A conversation contains links to a deleted email draft whose details are unavailable and to a draft that requires Gmail to reconnect.
- **When** The user opens the conversation.
- **Then** The deleted draft appears as a visible, disabled email card labeled “Deleted.” The other card indicates “Need reconnect” and offers the accessible action “Reconnect Gmail to access email: Quarterly access review.”

## chat-navigation-conversation-state-002

Original test `Keep the work being read expanded as a later run arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-conversation-state.test.tsx#L228).

- **Given** A user has expanded work history and scrolled so the response “Response the reader is reviewing” is their reading position, with later content below it.
- **When** A new run arrives with a prompt and response, then that run completes.
- **Then** The new response appears and the work history remains expanded, including after completion. The response being read stays at the same screen position, and the scroll position remains 540.
