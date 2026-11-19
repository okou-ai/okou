# Proactive learning settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [proactive-learning-settings.test.tsx](proactive-learning-settings.test.tsx).

## proactive-learning-settings-001

Original test `groups proactive preferences in Preference and keeps their opt-ins independent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L9).

- **Given** Both proactive-learning and agent-suggestion rollouts are enabled on the Preference settings page, and Morning brief, Suggestions, and Learning are initially off.
- **When** The user enables Learning and then Suggestions.
- **Then** The three switches appear in the order Morning brief, Suggestions, Learning; enabling either switch leaves the other two unchanged.

## proactive-learning-settings-002

Original test `offers Morning brief independently of the other rollout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L77).

- **Given** The Preference settings page has both proactive-learning and agent-suggestion rollouts disabled.
- **When** The user views Proactive settings.
- **Then** Only the enabled Morning brief switch is offered.

## proactive-learning-settings-003

Original test `offers Suggestions independently of the other rollout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L77).

- **Given** The Preference settings page has proactive learning disabled and agent suggestions enabled.
- **When** The user views Proactive settings.
- **Then** The enabled Morning brief and Suggestions switches are offered, but Learning is not.

## proactive-learning-settings-004

Original test `offers Learning independently of the other rollout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L77).

- **Given** The Preference settings page has proactive learning enabled and agent suggestions disabled.
- **When** The user views Proactive settings.
- **Then** The enabled Morning brief and Learning switches are offered, but Suggestions is not.
