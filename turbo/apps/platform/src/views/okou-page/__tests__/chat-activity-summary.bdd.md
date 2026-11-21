# Chat activity summary

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-activity-summary.test.tsx](chat-activity-summary.test.tsx).

## chat-activity-summary-001

Original test `A chat event starts demand for the newly active run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.test.tsx#L54).

- **Given** A chat is open with an active run and no run prompt event yet.
- **When** A prompt event for that run arrives.
- **Then** The app requests the run’s activity summary and displays “Preparing the launch checklist.”
- **Rebuilt** `751e6afbec` (batch 15) accepted this scenario; the file stays because 002 is unverified.

## chat-activity-summary-002

Original test `A completed run cannot revive the previous indicator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.test.tsx#L80).

- **Given** An active run’s activity-summary request is still pending.
- **When** The run completes before that response arrives.
- **Then** The stale response does not revive the activity indicator; the Send control is visible and neither the old summary nor “Thinking...” appears.
- **Unverified** The batch 15 case (`751e6afbec`) waits until the summary handler has answered and a later typed draft can be sent. A sendable composer does not prove that the app processed the late summary, so the timing gap is unverified and this scenario is not accepted. Evidence: `generated/test-app-rebuild/r41/`.

## chat-activity-summary-003

Original test `A 403 response clears the displayed summary`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.test.tsx#L107).

- **Given** The activity summary “Preparing the launch checklist” is displayed.
- **When** The summary service responds with HTTP 403.
- **Then** The old summary is cleared and “Thinking...” is displayed.

## chat-activity-summary-004

Original test `A replacement run shows its own summary once it arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.test.tsx#L130).

- **Given** The first active run displays “Preparing the launch checklist.”
- **When** A replacement run starts and its activity summary arrives as “Checking the release evidence.”
- **Then** The replacement summary is displayed and the previous summary is removed.
