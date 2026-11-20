# Chat capability feedback submission

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-feedback-submission.test.tsx](chat-capability-feedback-submission.test.tsx).

## chat-capability-feedback-submission-001

Original test `Reconcile inline feedback when the selected model is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-feedback-submission.test.tsx#L43).

- **Given** A user has drafted feedback on a quoted assistant passage, but their selected model is unavailable.
- **When** They send the feedback.
- **Then** The sent message contains the quoted passage and comment, the composer editor closes, and the submitted comment is visible in the conversation.
