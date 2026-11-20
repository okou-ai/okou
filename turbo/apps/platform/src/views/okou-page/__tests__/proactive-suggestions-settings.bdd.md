# Proactive suggestions settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [proactive-suggestions-settings.test.tsx](proactive-suggestions-settings.test.tsx).

## proactive-suggestions-settings-001

Original test `starts off, enables hourly checks independently of Morning Brief, and preserves explicit opt-out`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx#L12).

- **Given** Suggestions are disabled, while Morning brief is controlled by a separate rollout.
- **When** The user enables Suggestions and then explicitly disables it again.
- **Then** Suggestions follows both choices, and Morning brief remains off.

## proactive-suggestions-settings-002

Original test `keeps a pending opt-in cancellable when the primary Agent is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx#L60).

- **Given** Suggestions are enabled but still preparing because the primary Agent is unavailable.
- **When** The user turns Suggestions off.
- **Then** The unavailable-workspace message is shown, and the enabled switch remains usable and becomes off.

## proactive-suggestions-settings-003

Original test `a failed opt-out preserves the current preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx#L101).

- **Given** Suggestions are enabled with an error status.
- **When** The user tries to turn Suggestions off, but saving the preference fails.
- **Then** An update error is shown, the attempted choice is an opt-out, and Suggestions remains enabled.

## proactive-suggestions-settings-004

Original test `keeps suggestions opted in during platform recovery without asking the user to restart them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx#L142).

- **Given** Suggestions are enabled with an error status and are reported temporarily unavailable.
- **When** The user turns Suggestions off during platform recovery.
- **Then** The switch becomes off without requiring the user to restart Suggestions.
