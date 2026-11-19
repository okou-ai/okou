# Chat capability mail feedback

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-mail-feedback.test.tsx](chat-capability-mail-feedback.test.tsx).

## chat-capability-mail-feedback-001

Original test `Keep inline feedback tied to the source email`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-mail-feedback.test.tsx#L116).

- **Given** A chat response contains a link to a Gmail draft, and its email details are open.
- **When** The user selects “launch review to Monday morning,” adds “Rewrite this as a clear scheduling request,” and sends the feedback.
- **Then** The submitted feedback quotes “launch review to Monday morning,” includes the comment, and identifies the source as the draft email. The comment appears in chat with “Quoted from an email draft.”
