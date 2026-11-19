# Preference settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [preference-settings.test.tsx](preference-settings.test.tsx).

## preference-settings-001

Original test `keeps the Morning Brief switch on while the platform recovers its schedule`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L14).

- **Given** Morning Brief is enabled but its schedule is temporarily unavailable while the platform recovers it.
- **When** The member turns off the Morning Brief switch.
- **Then** The unavailable message is shown while the switch initially remains on; after the action, the switch turns off.

## preference-settings-002

Original test `unified preference settings > maps the legacy preference URL /settings into unified Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L56).

- **Given** A member opens the legacy /settings URL.
- **When** The settings page loads.
- **Then** Unified Settings opens to Preference at /agents?settings=preference, with no legacy tab parameter.

## preference-settings-003

Original test `unified preference settings > maps the legacy model URL /settings?tab=model-configuration into unified Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L66).

- **Given** A member opens the legacy /settings?tab=model-configuration URL.
- **When** The settings page loads.
- **Then** Unified Settings opens to Use more models at /agents?settings=model, without the legacy tab parameter, and shows Claude and ChatGPT (Codex).

## preference-settings-004

Original test `unified preference settings > retains the unified Debug visibility fallback for legacy links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L82).

- **Given** A member follows the legacy /preferences?tab=debug link.
- **When** Unified Settings loads.
- **Then** The URL becomes /agents?settings=debug, but the dialog shows Preference and does not show Debug.

## preference-settings-005

Original test `unified preference settings > shows Morning Brief without requiring Official Workflows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L94).

- **Given** A member opens Preference settings without Official Workflows being required, and Morning Brief is paused and off.
- **When** The preference settings load.
- **Then** The Morning Brief preference is visible.

## preference-settings-006

Original test `unified preference settings > a rejected Morning Brief update preserves the confirmed preference and reports conflict`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L114).

- **Given** Morning Brief is paused and off; enabling it succeeds, but a subsequent update to turn it off returns a conflict.
- **When** The member enables Morning Brief, then tries to turn it off.
- **Then** The successful enable leaves the switch on. The rejected update reports that Morning Brief is temporarily unavailable, disables the switch, and preserves its checked state.

## preference-settings-007

Original test `shows pending Morning Brief enrollment and accepts cancellation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L169).

- **Given** Morning Brief is enabled and preparing its first brief.
- **When** The member turns it off, then turns it back on.
- **Then** The preparation message says it can be turned off at any time, and the enabled switch remains interactive. The switch reflects each cancellation and re-enrollment action.

## preference-settings-008

Original test `keeps the Morning Brief toggle disabled while an unavailable reason is reported`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx#L213).

- **Given** Morning Brief is paused and off, with the workspace's default agent unavailable.
- **When** The preference settings load.
- **Then** The page explains that Okou is unavailable in this workspace and advises contacting an administrator. The Morning Brief switch is disabled.
