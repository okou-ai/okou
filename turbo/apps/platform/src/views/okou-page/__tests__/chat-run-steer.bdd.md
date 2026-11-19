# Chat run steer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-steer.test.tsx](chat-run-steer.test.tsx).

## chat-run-steer-001

Original test `Keep the work boundary and elapsed time stable through steer delivery and completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-steer.test.tsx#L138).

- **Given** A live run has produced an API review result and artifact, and a steer has been queued 12 seconds into the run.
- **When** The steer is delivered, a new result appears after it, and the run completes.
- **Then** The messages remain ordered as the original result, steer, and new result; the queued status disappears, and both results retain their own copy action and artifact association. The original work duration stays at 12 seconds, while the new result shows 8 seconds after completion.

## chat-run-steer-002

Original test `Keep separate histories, artifacts and actions on both sides of a steer in the same run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-steer.test.tsx#L179).

- **Given** A live run has an API review result with four earlier history entries and an artifact, followed by a steer and a later result with its own history entry.
- **When** The conversation is opened while the run is active.
- **Then** The original result and artifact remain separate from the later result, and the messages appear in result-steer-result order. Earlier history entries are collapsed, each result has its own actions, the later result offers history expansion, and the active-run status follows the later result.

## chat-run-steer-003

Original test `Keep the selected prompt and status row when a run claims the prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-steer.test.tsx#L298).

- **Given** A queued prompt reading “Review the API” is visible, and the user has selected from that prompt through the run status row.
- **When** A run claims the queued prompt and the status changes to “Thinking...”.
- **Then** The queued-message status disappears, only one copy of the prompt remains, and the selection still begins with the prompt and ends with “Thinking...”.

## chat-run-steer-004

Original test `Keep the selected steer and status row through steer delivery and the first result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-steer.test.tsx#L332).

- **Given** A live run has a queued steer, and the user has selected from the steer through the run status row.
- **When** The steer is delivered and the first result after it appears.
- **Then** The status follows the new result, and the selection still begins with the steer, includes the new result, and ends with “Thinking...”.

## chat-run-steer-005

Original test `Stop interrupts the live run and keeps the queued follow-up`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-steer.test.tsx#L360).

- **Given** A run is active and a steer is queued for follow-up.
- **When** The user selects Stop.
- **Then** The active run is interrupted, no queued message is recalled, and the steer remains visible without a queued-message status.
