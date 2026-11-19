# Chat runless delivery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-runless-delivery.test.tsx](chat-runless-delivery.test.tsx).

## chat-runless-delivery-001

Original test `renders a thread whose only message carries no run identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx#L119).

- **Given** A chat thread contains only one assistant message, with no Run identity or associated Run events.
- **When** The user opens the thread.
- **Then** The message “Message delivered without a Run” is displayed.

## chat-runless-delivery-002

Original test `renders a delivery that carries no run identity after a Run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx#L136).

- **Given** A chat thread contains a completed Run followed by an assistant message with no Run identity or associated Run events.
- **When** The user opens the thread.
- **Then** The message “Message delivered without a Run” is displayed after the Run.

## chat-runless-delivery-003

Original test `keeps run work history off a delivery that has no Run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx#L144).

- **Given** A chat thread contains a completed Run with work and a response, followed by a separate assistant message with no Run identity.
- **When** The user opens the thread and views the delivery.
- **Then** The Run response appears before “Message delivered without a Run.” The delivery is a separate response, not part of the Run response; the Run response has a work-history toggle, while the delivery does not.
