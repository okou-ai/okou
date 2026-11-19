# Chat thread link chips

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thread-link-chips.test.tsx](chat-thread-link-chips.test.tsx).

## chat-thread-link-chips-001

Original test `Links to App chats read as chat chips in messages and replies`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-link-chips.test.tsx#L101).

- **Given** A user message and assistant reply contain Okou chat URLs, an external URL, a deep link with query and hash, a labeled chat link, and a chat URL inside code.
- **When** View the message and reply.
- **Then** Okou chat URLs render as chat chips linking to the app's internal chat path; deep-link query and hash are preserved, and authored link labels remain. External URLs retain their original destinations and open in a new tab with safe link attributes. The URL inside code remains code, and the reply contains three links.
