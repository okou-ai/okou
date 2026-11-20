# Chat mentions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-mentions.test.tsx](chat-mentions.test.tsx).

## chat-mentions-001

Original test `A conversation reference renders as a recognizable chip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-mentions.test.tsx#L115).

- **Given** An agent chat draft contains the text “Review ”, a reference to the titled conversation “Weekly sync,” and the text “ before planning.”
- **When** The user opens the chat composer.
- **Then** The reference appears as a distinct, non-editable chip labeled “Weekly sync” between the surrounding text, while the composer’s text reads “Review Weekly sync before planning.”

## chat-mentions-002

Original test `Ordinary links are not mistaken for conversation mentions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-mentions.test.tsx#L153).

- **Given** An agent chat draft contains an external URL, an agent-chat URL, an invalid conversation link, a link to an untitled conversation, and a valid reference to “Weekly sync.”
- **When** The user opens the chat composer.
- **Then** Only the valid titled conversation reference appears as a conversation chip; the ordinary links and the untitled conversation link are not mistaken for conversation mentions.

## chat-mentions-003

Original test `Special characters in a conversation title survive saving and restoring`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-mentions.test.tsx#L206).

- **Given** An agent chat draft contains a reference titled `Release [QA] \ notes`.
- **When** The user edits the draft, navigates away, and returns to the chat.
- **Then** The saved mention retains its conversation ID and exact special-character title, and the restored composer displays that title in the reference chip.
