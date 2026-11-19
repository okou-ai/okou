# Chat capability history visibility

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-history-visibility.test.tsx](chat-capability-history-visibility.test.tsx).

## chat-capability-history-visibility-001

Original test `Keep a generic assistant failure readable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-history-visibility.test.tsx#L45).

- **Given** An assistant response has failed with formatted error text containing a heading, bold emphasis, a two-item list, and a service-status link.
- **When** The user opens the error details.
- **Then** The details show the heading, bold text, two list items, and the link to the supplied service-status URL, without exposing the raw Markdown heading syntax.

## chat-capability-history-visibility-002

Original test `Preserve selected template labels in chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-history-visibility.test.tsx#L96).

- **Given** Chat history contains selected templates for a presentation, video, illustration, and website.
- **When** The user views the conversation history.
- **Then** The labels Quarterly Storyboard, Warm Documentary, Paper Cutout, and Editorial Landing Page are visible as non-interactive labels.

## chat-capability-history-visibility-003

Original test `Show only the selected conversation when switching chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-history-visibility.test.tsx#L168).

- **Given** The selected conversation is still running while a separate conversation has completed.
- **When** The user switches to the completed conversation.
- **Then** The completed conversation's answer is visible, its URL is selected, the running conversation's prompt is absent, and the Stop control is no longer shown.
