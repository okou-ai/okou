# Chat history message resources

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-history-message-resources.test.tsx](chat-history-message-resources.test.tsx).

## chat-history-message-resources-001

Original test `Loading older messages restores agent references and attachment navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-history-message-resources.test.tsx#L20).

- **Given** A chat has 12 turns, with an older user message containing a reference to agent Ada and two image attachments. The newest answer is initially loaded, and the older references are not yet visible.
- **When** The user scrolls to load older messages, opens the first image, and moves to the next image.
- **Then** The restored agent reference links to Ada’s chat and shows her avatar. The first image opens at its resolved URL, and next-image navigation displays the second image at its resolved URL.
- **Upstream change** Use nine turns so that the two attached images and the historical mention start outside the compact tail. The earlier agent-link retirement still applies. [#49882](https://github.com/okou-ai/okou/pull/49882).
