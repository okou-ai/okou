# Sidebar account menu

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-account-menu.test.tsx](sidebar-account-menu.test.tsx).

## sidebar-account-menu-001

Original test `Switch accounts: success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L20).

- **Given** Alex Rivera is signed in with active sessions for Alex Rivera and Jamie Chen, and Jamie's session has no pending task.
- **When** Alex opens the account menu, chooses Switch account, and selects Jamie Chen.
- **Then** The app shell is unmounted while the switch is pending, the app lifecycle is aborted without aborting the shared test context, and no redirect occurs before the switch finishes. On success, the browser redirects to /, no error is reported, and the app shell remains unmounted.

## sidebar-account-menu-002

Original test `Switch accounts: failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L20).

- **Given** Alex Rivera is signed in with active sessions for Alex Rivera and Jamie Chen, and Jamie's session has no pending task.
- **When** Alex opens the account menu, chooses Switch account, selects Jamie Chen, and the session switch fails.
- **Then** The app shell is unmounted while the switch is pending, the app lifecycle is aborted without aborting the shared test context, and no redirect occurs. After failure, there is still no redirect, the failure is reported, and the app shell remains unmounted.

## sidebar-account-menu-003

Original test `Switch accounts: pending task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L20).

- **Given** Alex Rivera is signed in with active sessions for Alex Rivera and Jamie Chen, and Jamie's session has the pending task choose-organization.
- **When** Alex opens the account menu, chooses Switch account, and selects Jamie Chen.
- **Then** The app shell is unmounted while the switch is pending, the app lifecycle is aborted without aborting the shared test context, and no redirect occurs before the switch finishes. On success, the browser redirects to /sign-in/tasks/choose-organization, no error is reported, and the app shell remains unmounted.

## sidebar-account-menu-004

Original test `Add account opens the hosted Clerk account switcher with the shared appearance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L132).

- **Given** Alex is signed in and the app is using the dark theme.
- **When** Alex chooses Add account from the account menu.
- **Then** The hosted Clerk sign-in opens with the shared simple appearance, the light Okou wordmark linked to /, and the primary-button and input styling. Both fallback and forced redirect destinations are /, and the Clerk UI asset is requested from https://app.example.test/assets/clerk-ui-test.js.

## sidebar-account-menu-005

Original test `Sign out from the account menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L165).

- **Given** Alex is signed in on app.okou.ai.
- **When** Alex chooses Sign out from the account menu.
- **Then** Clerk is asked to sign out the current session and redirect to the sign-in route with a redirect_url parameter.

## sidebar-account-menu-006

Original test `Help opens shortcuts and links to the docs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-account-menu.test.tsx#L196).

- **Given** Alex is signed in and has opened the account menu.
- **When** Alex chooses Help and follows the Docs link, then chooses Shortcuts.
- **Then** The Docs link points to https://www.okou.ai/en/docs and opens in a new tab. A Keyboard Shortcuts dialog appears with Show shortcuts.
