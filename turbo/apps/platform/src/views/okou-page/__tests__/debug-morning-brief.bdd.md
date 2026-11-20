# Debug morning brief

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [debug-morning-brief.test.tsx](debug-morning-brief.test.tsx).

## debug-morning-brief-001

Original test `a member runs a real brief, sees its conversation link and requests another`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L34).

- **Given** An organization member opens Debug and can run a Morning Brief.
- **When** The member runs a brief, then requests another after it completes.
- **Then** The first brief completes, a chat link is shown, and the daily schedule is stated to remain unchanged. The second request has a different request ID.

## debug-morning-brief-002

Original test `a queued brief links to its conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L69).

- **Given** The user opens Debug and can run a Morning Brief.
- **When** The run is accepted as queued.
- **Then** The app says the brief is queued and links to its conversation; the action to run another brief is disabled.

## debug-morning-brief-003

Original test `reports a failed run with its conversation for details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L90).

- **Given** The user opens Debug and can run a Morning Brief.
- **When** The run returns a failed status with a conversation ID.
- **Then** The app reports, “Morning Brief failed. Open the chat for details,” and enables the action to run another brief.

## debug-morning-brief-004

Original test `hides the test action without Okou Debug`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L109).

- **Given** Okou Debug is disabled.
- **When** The user opens the settings page.
- **Then** The Morning Brief test action is not displayed.

## debug-morning-brief-005

Original test `supports keyboard activation with one submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L117).

- **Given** The user opens Debug and the Morning Brief action is enabled.
- **When** The user focuses the action and presses Enter.
- **Then** The brief completes, and exactly one request is submitted.

## debug-morning-brief-006

Original test `dismissal cancels a pending request before the Settings closing animation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L140).

- **Given** A Morning Brief request is pending in Debug settings.
- **When** The user dismisses Settings with Escape before its closing animation.
- **Then** The pending request is canceled.
