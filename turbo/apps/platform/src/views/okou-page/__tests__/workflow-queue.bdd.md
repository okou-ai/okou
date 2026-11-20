# Workflow queue

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [workflow-queue.test.tsx](workflow-queue.test.tsx).

## workflow-queue-001

Original test `Active-run prompts stay in the conversation while automation events wait in the queue`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workflow-queue.test.tsx#L228).

- **Given** A chat has an active run, a regular follow-up prompt, and two pending automation events.
- **When** The conversation and its queue are displayed.
- **Then** The active-run prompt and regular follow-up prompt remain in the conversation. The queue contains exactly the two automation events in submission order, each identified as a pending automation event, and neither appears more than once.

## workflow-queue-002

Original test `Pending automation events keep submission order around conversation prompts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workflow-queue.test.tsx#L280).

- **Given** A chat has an active run, a pending automation event, a regular prompt, and a second pending automation event, in that submission order.
- **When** The conversation and queue are displayed.
- **Then** The queue shows exactly the two automation events in their original order, while the regular prompt remains in the conversation and outside the queue.

## workflow-queue-003

Original test `Skip one pending automation event without removing the others`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workflow-queue.test.tsx#L325).

- **Given** A chat has two pending automation events: “Check deployment” and “Publish digest.”
- **When** The user skips “Check deployment.”
- **Then** That event disappears, “Publish digest” remains, and the skipped event is the one revoked.
