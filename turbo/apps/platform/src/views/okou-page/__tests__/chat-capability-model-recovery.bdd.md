# Chat capability model recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-model-recovery.test.tsx](chat-capability-model-recovery.test.tsx).

## chat-capability-model-recovery-001

Original test `Match model-provider recovery guidance to the failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-model-recovery.test.tsx#L40).

- **Given** A chat run fails because no model provider is available.
- **When** The user views the failure and chooses “Manage subscriptions.”
- **Then** The failure explains that a personal subscription must be connected, and the Settings dialog opens with the “Use more models” heading.
