# Debug openrouter preset

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [debug-openrouter-preset.test.tsx](debug-openrouter-preset.test.tsx).

## debug-openrouter-preset-001

Original test `lets the administrator select a preset, restore the system default, and select another preset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L21).

- **Given** An organization administrator opens Debug with the system default OpenRouter preset selected.
- **When** The administrator selects @preset/okou-1-0-dsf, restores System default, then selects @preset/okou-experimental.
- **Then** Each selection is displayed in turn, and the final selection is identified as applying to the entire organization. The selectable choices are System default, @preset/okou-1-0, @preset/okou-1-0-dsf, and @preset/okou-experimental.

## debug-openrouter-preset-002

Original test `hides the preset control for role member with Debug true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L67).

- **Given** The organization role is member and Okou Debug is enabled.
- **When** The user opens Debug settings.
- **Then** The OpenRouter preset control is not displayed, and the organization preset is not requested.

## debug-openrouter-preset-003

Original test `hides the preset control for role admin with Debug false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L67).

- **Given** The organization role is admin and Okou Debug is disabled.
- **When** The user opens settings.
- **Then** The OpenRouter preset control is not displayed, and the organization preset is not requested.

## debug-openrouter-preset-004

Original test `keeps the saved preset when saving @preset/okou-experimental fails and permits retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L82).

- **Given** The saved organization preset is @preset/okou-1-0.
- **When** The administrator selects @preset/okou-experimental, the save fails with a forbidden error, and the administrator retries.
- **Then** The app displays “Preset update denied” and retains @preset/okou-1-0 after the failure. The retry succeeds and displays @preset/okou-experimental.

## debug-openrouter-preset-005

Original test `keeps the saved preset when saving System default fails and permits retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L82).

- **Given** The saved organization preset is @preset/okou-1-0.
- **When** The administrator selects System default, the save fails with a forbidden error, and the administrator retries.
- **Then** The app displays “Preset update denied” and retains @preset/okou-1-0 after the failure. The retry succeeds and displays System default.

## debug-openrouter-preset-006

Original test `displays an existing operator preset without adding it to the selectable allowlist`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L126).

- **Given** The organization already has the operator-only preset @preset/operator-only saved.
- **When** The administrator opens the OpenRouter preset control.
- **Then** The current operator-only preset is displayed, but it is not offered as a selectable option; @preset/okou-experimental remains selectable.
