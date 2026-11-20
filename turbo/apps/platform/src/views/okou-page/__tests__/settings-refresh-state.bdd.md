# Settings refresh state

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-refresh-state.test.tsx](settings-refresh-state.test.tsx).

## settings-refresh-state-001

Original test `saving send mode keeps a disabled cloud browser preference unchanged during refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L67).

- **Given** Settings is open on Chat, and Cloud browser is disabled.
- **When** The user selects Enter, and the updated preferences are being refreshed.
- **Then** The selected send mode changes to ⌘ Enter. Cloud browser remains unchecked and enabled throughout refresh; the selected mode remains after refresh completes.

## settings-refresh-state-002

Original test `saving cloud browser keeps the selected send mode unchanged during refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L92).

- **Given** Settings is open on Chat, and ⌘ Enter is selected while Cloud browser is unchecked.
- **When** The user enables Cloud browser, and the updated preferences are being refreshed.
- **Then** Cloud browser remains unchecked and unavailable during refresh, while ⌘ Enter remains selected and enabled. After refresh completes, Cloud browser is checked and enabled, and ⌘ Enter remains selected.

## settings-refresh-state-003

Original test `saving Learning (initially false) keeps enabled Suggestions unchanged during refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L117).

- **Given** Suggestions is enabled, and Learning is initially off.
- **When** The user turns Learning on while its saved preference is being refreshed.
- **Then** During refresh, Learning remains off and unavailable, while Suggestions remains checked and enabled. After refresh completes, Learning is on and available, and Suggestions remains checked.

## settings-refresh-state-004

Original test `saving Learning (initially true) keeps enabled Suggestions unchanged during refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L117).

- **Given** Suggestions is enabled, and Learning is initially on.
- **When** The user turns Learning off while its saved preference is being refreshed.
- **Then** During refresh, Learning remains on and unavailable, while Suggestions remains checked and enabled. After refresh completes, Learning is off and available, and Suggestions remains checked.

## settings-refresh-state-005

Original test `reopening Settings refreshes a Learning preference changed elsewhere`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L186).

- **Given** Learning is off in Settings.
- **When** The user closes Settings, the preference is changed elsewhere to on, and the user reopens Settings.
- **Then** Learning is checked and enabled in the reopened Settings.

## settings-refresh-state-006

Original test `returning to Preference refreshes a Learning preference changed elsewhere`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L186).

- **Given** Learning is off in Settings.
- **When** The user switches to Chat, the preference is changed elsewhere to on, and the user returns to Preference.
- **Then** Learning is checked and enabled in Preference.

## settings-refresh-state-007

Original test `saving time zone keeps enabled Morning brief unchanged during refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L250).

- **Given** Morning brief is enabled in Settings.
- **When** The user changes the time zone to Eastern Time (ET) while preferences are being refreshed.
- **Then** Morning brief remains checked and enabled during the refresh and remains checked after the new time zone appears.

## settings-refresh-state-008

Original test `keeps Morning brief pending until its saved preference has been read back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L286).

- **Given** Morning brief is enabled and its preference has not yet been read back after saving.
- **When** The user turns Morning brief off and interacts with an independent preference while the read-back is pending.
- **Then** Morning brief remains checked and unavailable until the saved preference is read back, then becomes unchecked and enabled. The independent preference can be turned on and remains enabled.

## settings-refresh-state-009

Original test `keeps Suggestions pending until its saved preference has been read back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L286).

- **Given** Suggestions is enabled and its preference has not yet been read back after saving.
- **When** The user turns Suggestions off and interacts with an independent preference while the read-back is pending.
- **Then** Suggestions remains checked and unavailable until the saved preference is read back, then becomes unchecked and enabled. The independent preference can be turned on and remains enabled.

## settings-refresh-state-010

Original test `keeps Learning pending until its saved preference has been read back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L286).

- **Given** Learning is enabled and its preference has not yet been read back after saving.
- **When** The user turns Learning off and interacts with Morning brief while the read-back is pending.
- **Then** Learning remains checked and unavailable until the saved preference is read back, then becomes unchecked and enabled. Morning brief can be turned on and remains enabled.

## settings-refresh-state-011

Original test `a Morning brief refresh failure still reports the error and disables the switch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L348).

- **Given** Morning brief is enabled and its preference can be saved.
- **When** The user turns it off, but refreshing the saved preference returns an error.
- **Then** An error indicating the preference could not be loaded or updated is shown, and the Morning brief switch is unavailable.
