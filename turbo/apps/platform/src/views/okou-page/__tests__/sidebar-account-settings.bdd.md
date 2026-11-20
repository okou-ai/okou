# Sidebar account settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-account-settings.test.tsx](sidebar-account-settings.test.tsx).

## sidebar-account-settings-001

Original test `Open personal Settings and manage account security`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-settings.test.tsx#L25).

- **Given** Alex is signed in and Debug access is enabled, with personal preferences loaded.
- **When** Alex opens the account menu and chooses Settings.
- **Then** A Settings dialog shows Preference and Account & security with Alex's name and email; the Proactive region contains the morning-brief preference. Focus moves into the dialog. The Manage link opens https://accounts.example.test/user in a new tab with noreferrer.

## sidebar-account-settings-002

Original test `Toggle network-body capture in Debug settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-settings.test.tsx#L92).

- **Given** Alex is signed in, Debug access is enabled, and network-body capture is initially disabled.
- **When** Alex opens Settings, selects Debug, and toggles Capture network bodies on, off with the Space key, and on by clicking its label.
- **Then** Debug settings show the capture control as disabled initially. The control exposes Enabled for the next 3 runs when on and Disabled when off, and the submitted capture counts are 3, 0, then 3.

## sidebar-account-settings-003

Original test `Hide Debug settings without Debug access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-settings.test.tsx#L205).

- **Given** Alex is signed in without Debug access and opens the app directly with the debug settings query parameter.
- **When** The Settings dialog opens.
- **Then** Preference is shown, but Debug is not available in the dialog.
