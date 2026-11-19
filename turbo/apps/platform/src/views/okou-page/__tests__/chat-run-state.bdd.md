# Chat run state

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-state.test.tsx](chat-run-state.test.tsx).

## chat-run-state-001

Original test `Show one cancellation outcome for an interrupted run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L46).

- **Given** A run has produced partial assistant text and was interrupted, followed by a cancellation event.
- **When** The user opens the chat.
- **Then** The partial text remains visible with exactly one “Run paused — resume anytime.” outcome, and no Stop button is shown.

## chat-run-state-002

Original test `Finish a run and return the composer to send mode`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L84).

- **Given** A run is active after the user sent “Finish the release notes.”
- **When** The run completes with release notes and a deployment-ready status.
- **Then** The composer returns to Send mode, the result heading and deployment status are visible, and Stop is no longer shown.

## chat-run-state-003

Original test `Show thinking as soon as a new prompt is sent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L113).

- **Given** The chat is ready and a new prompt has not yet been acknowledged by the run service.
- **When** The user sends “Summarize the launch risks.”
- **Then** The prompt immediately appears once in history with “Thinking...” and no queued-message row. After acceptance, Stop appears while thinking continues; after completion, the result appears, Send returns, and Stop disappears.

## chat-run-state-004

Original test `Keep the composer and transcript in sync as a sent prompt is queued, claimed and finished`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L143).

- **Given** The chat is ready and a newly sent prompt awaits service acknowledgement.
- **When** The user sends “Prepare the launch checklist,” then the prompt is queued, claimed by a run, and completed.
- **Then** Initially the prompt appears once with “Thinking...”. While queued, “Waiting in” and the queue control appear, Send remains available, and neither Thinking nor Stop appears. Once claimed, the queue control is replaced by Stop and Thinking; after completion, the result appears, Send returns, Thinking and Stop disappear, and the prompt remains in history once.

## chat-run-state-005

Original test `Keep a prompt waiting for steer delivery in the message history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L226).

- **Given** A run is active for “Draft the rollout,” and “Add the appendix” is persisted awaiting steer delivery.
- **When** The user opens the chat.
- **Then** “Add the appendix” remains in message history while the run shows “Thinking...”; no queued-message row is shown.

## chat-run-state-006

Original test `Show waiting in queue for a persisted prompt without a run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L252).

- **Given** A completed run has produced “The rollout draft is ready,” and “Add the appendix” is persisted without an associated run.
- **When** The user opens the chat.
- **Then** The waiting prompt appears in history with “Waiting in” and the queue control. The previous result remains visible, Thinking and Stop are absent, and Send is available; no queued-message row is shown.

## chat-run-state-007

Original test `Open the queue drawer from waiting in queue`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L289).

- **Given** A persisted prompt without a run is waiting in the queue.
- **When** The user opens the queue control.
- **Then** A dialog titled “Your agent is waiting in line” appears and explains that the user can see concurrent run usage and upgrade to skip the wait.

## chat-run-state-008

Original test `Show waiting in queue for a persisted automation event without a run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-state.test.tsx#L315).

- **Given** A persisted automation event without an associated run is present in the chat.
- **When** The user opens the chat.
- **Then** “Waiting in” and the queue control appear, while “Thinking...” is absent.
