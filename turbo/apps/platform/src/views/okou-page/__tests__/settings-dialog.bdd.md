# Settings dialog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-dialog.test.tsx](settings-dialog.test.tsx).

## settings-dialog-001

Original test `Offer only the workspace's supported languages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L152).

- **Given** The workspace supports English, Brazilian Portuguese, and German.
- **When** The user opens the Language picker in Settings.
- **Then** The picker offers exactly English, Português (Brasil), and Deutsch.

## settings-dialog-002

Original test `Persist the browser language when the workspace has no preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L165).

- **Given** The workspace has no saved language preference, and the browser language is Indonesian.
- **When** The user opens Settings on app.okou.ai and then selects English.
- **Then** Indonesian is initialized and displayed as the saved language and document language. After selecting English, the saved and document language become en-US.

## settings-dialog-003

Original test `Select and persist a supported interface language`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L217).

- **Given** The saved interface language is English, and the workspace supports English, Brazilian Portuguese, and German.
- **When** The user selects Deutsch in Settings.
- **Then** German is saved as de-DE, displayed as the selected language, and applied as the document language.

## settings-dialog-004

Original test `Use the saved workspace language ahead of locale hints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L250).

- **Given** The saved workspace language is Indonesian, while the locale cookie says French and the browser language is German.
- **When** The user opens Settings on app.okou.ai and then selects English.
- **Then** Settings initially displays Indonesian and the document language is id-ID, ahead of the cookie and browser hints. Selecting English changes the document language to en-US.

## settings-dialog-005

Original test `Navigate workspace settings without closing Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L273).

- **Given** An administrator has Settings open on General and can see workspace settings, including People.
- **When** The administrator navigates to People.
- **Then** The People heading appears while the Settings dialog remains open.

## settings-dialog-006

Original test `Navigate workspace settings with the named section select`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L299).

- **Given** An administrator has Settings open on General, with the Settings section selector showing General.
- **When** The administrator selects People using the named section selector.
- **Then** The People heading and selected section appear, the Settings dialog remains open, and the URL query becomes ?settings=people.

## settings-dialog-007

Original test `Route members away from administrator-only workspace settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L324).

- **Given** A workspace member opens Settings.
- **When** The member views the available settings.
- **Then** Workspace settings are absent, while Theme is visible.

## settings-dialog-008

Original test `Measure the threads inside a singleton snapshot on demand`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-dialog.test.tsx#L408). · **intent review**

- **Given** A debug-enabled page has loaded a singleton chat snapshot containing three threads, and the snapshot diagnostics are open but not yet measured.
- **When** The user requests a snapshot measurement.
- **Then** The measurement control is disabled while measuring, then re-enabled; the diagnostics report 3 threads, a positive size in KB, and a duration in milliseconds.
