# Slack connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [slack-connect-page.test.tsx](slack-connect-page.test.tsx).

## slack-connect-page-001

Original test `A bare or returned page reads actual state before offering installation:`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L22).

- **Given** Slack reports the account is not connected or installed, and the user is an admin; the page URL has no query string.
- **When** The user opens the Slack settings page.
- **Then** The page offers “Install to Slack” using the installation URL, shows no connected status, does not launch Slack, and has the canonical settings URL.

## slack-connect-page-002

Original test `A bare or returned page reads actual state before offering installation: ?status=connected&workspace=Forged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L22).

- **Given** Slack reports the account is not connected or installed, and the user is an admin; the URL contains `status=connected` and a forged workspace name.
- **When** The user opens the Slack settings page.
- **Then** The page offers “Install to Slack” using the installation URL, ignores the forged success and workspace details, does not launch Slack, and has the canonical settings URL.

## slack-connect-page-003

Original test `A bare or returned page reads actual state before offering installation: ?installed=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L22).

- **Given** Slack reports the account is not connected or installed, and the user is an admin; the URL contains `installed=1`.
- **When** The user opens the Slack settings page.
- **Then** The page offers “Install to Slack” using the installation URL, shows no connected status, does not launch Slack, and has the canonical settings URL.

## slack-connect-page-004

Original test `A bare or returned page reads actual state before offering installation: ?updated=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L22).

- **Given** Slack reports the account is not connected or installed, and the user is an admin; the URL contains `updated=1`.
- **When** The user opens the Slack settings page.
- **Then** The page offers “Install to Slack” using the installation URL, shows no connected status, does not launch Slack, and has the canonical settings URL.

## slack-connect-page-005

Original test `A confirmed connection opens Slack once and retains the manual action:`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L47).

- **Given** Slack confirms the user is connected and installed as an admin; the URL has no query string.
- **When** The user opens the Slack settings page and then focuses the window.
- **Then** Slack is launched once, the page shows “Slack is connected” and retains an “Open Slack” link, and focusing the window does not launch Slack again.

## slack-connect-page-006

Original test `A confirmed connection opens Slack once and retains the manual action: ?status=connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L47).

- **Given** Slack confirms the user is connected and installed as an admin; the URL contains `status=connected`.
- **When** The user opens the Slack settings page and then focuses the window.
- **Then** Slack is launched once, the page shows “Slack is connected” and retains an “Open Slack” link, and focusing the window does not launch Slack again.

## slack-connect-page-007

Original test `A confirmed connection opens Slack once and retains the manual action: ?updated=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L47).

- **Given** Slack confirms the user is connected and installed as an admin; the URL contains `updated=1`.
- **When** The user opens the Slack settings page and then focuses the window.
- **Then** Slack is launched once, the page shows “Slack is connected” and retains an “Open Slack” link, and focusing the window does not launch Slack again.

## slack-connect-page-008

Original test `An installed member can authorize their account with the retained API shape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L75).

- **Given** Slack reports that the user is not connected, the workspace is installed, and the user is not an admin. The page URL contains `prompt=Hello%20team`.
- **When** The user opens the Slack settings page.
- **Then** The page offers a Connect link with `connectorState=connect` and preserves the prompt as “Hello team”.

## slack-connect-page-009

Original test `A member can connect their Slack identity before bot installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L96).

- **Given** Slack reports that the user is neither connected nor installed and is not an admin, with a connect URL available.
- **When** The user opens the Slack settings page.
- **Then** The page offers a Connect link using the supplied connect URL, allowing the member to connect before bot installation.

## slack-connect-page-010

Original test `A connected identity retains the installation action when its bot is missing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L113).

- **Given** Slack reports that the user is connected but the bot is not installed, and provides an installation URL.
- **When** The user opens the Slack settings page.
- **Then** The page shows “Slack is connected” and retains an “Install to Slack” link using the installation URL.

## slack-connect-page-011

Original test `An existing connection and failed authorization are reported separately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L134).

- **Given** Slack reports that the user is connected to “Actual workspace” as an admin, with a permissions mismatch and an installation URL. The URL also contains an access-denied error and a forged workspace name.
- **When** The user opens the Slack settings page.
- **Then** The page shows the actual connected workspace and separately reports that authorization was not completed. It offers “Update Slack permissions” and “Open Slack”, does not launch Slack, and does not use the forged workspace name.

## slack-connect-page-012

Original test `A retained Slack result reaches the canonical state page: /?tab=works&updated=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L175).

- **Given** The user opens `/?tab=works&updated=1` while onboarding is incomplete, and Slack reports that the user is not connected or installed but is an admin.
- **When** The page loads.
- **Then** The “Install to Slack” action uses the supplied installation URL, and the app navigates to `/settings/slack`.

## slack-connect-page-013

Original test `A retained Slack result reaches the canonical state page: /?tab=works&installed=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L175).

- **Given** The user opens `/?tab=works&installed=1` while onboarding is incomplete, and Slack reports that the user is not connected or installed but is an admin.
- **When** The page loads.
- **Then** The “Install to Slack” action uses the supplied installation URL, and the app navigates to `/settings/slack`.

## slack-connect-page-014

Original test `A retained Slack result reaches the canonical state page: /?tab=works&connected=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L175).

- **Given** The user opens `/?tab=works&connected=1` while onboarding is incomplete, and Slack reports that the user is not connected or installed but is an admin.
- **When** The page loads.
- **Then** The “Install to Slack” action uses the supplied installation URL, and the app navigates to `/settings/slack`.

## slack-connect-page-015

Original test `A retained Slack result reaches the canonical state page: /slack/failed?error=access_denied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L175).

- **Given** The user opens `/slack/failed?error=access_denied` while onboarding is incomplete, and Slack reports that the user is not connected or installed but is an admin.
- **When** The page loads.
- **Then** The “Install to Slack” action uses the supplied installation URL, and the app navigates to `/settings/slack`.

## slack-connect-page-016

Original test `A success hint cannot bypass the authenticated account mismatch check`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L200).

- **Given** The authenticated Slack link-status response identifies an account mismatch between current user `U_CURRENT` and requested user `U_REQUESTED`, despite a connected success hint in the URL.
- **When** The user opens the Slack settings page.
- **Then** The page offers an enabled “Switch to U_REQUESTED” button and a “Keep U_CURRENT” link, remains at the canonical settings URL, and does not launch Slack.

## slack-connect-page-017

Original test `A verified provider link opens the conversation and keeps a manual return link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L228).

- **Given** The provider confirms a connected Slack identity for the actual workspace, team `T_ACTUAL`, and channel `C_ORIGIN`; the URL also contains a forged workspace name and other context.
- **When** The user opens the Slack settings page.
- **Then** Slack opens the channel URL for team `T_ACTUAL` and channel `C_ORIGIN`. The page retains “Open Slack” as a link, shows the actual workspace, and has the canonical settings URL.

## slack-connect-page-018

Original test `Leaving the page during verification cancels the automatic Slack launch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L259).

- **Given** Slack link verification is pending for a connection that would otherwise be confirmed.
- **When** The user leaves for `/works` before verification finishes, then verification completes.
- **Then** Slack is not launched, and the current route remains `/works`.

## slack-connect-page-019

Original test `Changing accounts during verification prevents the old account from opening Slack: /settings/slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L292).

- **Given** Slack authorization verification is pending while the user is on `/settings/slack`.
- **When** The authenticated user changes to a replacement account before verification completes.
- **Then** The pending response does not launch Slack.

## slack-connect-page-020

Original test `Changing accounts during verification prevents the old account from opening Slack: /settings/slack?w=T_ACTUAL&u=U_ACTUAL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L292).

- **Given** Slack authorization verification is pending while the URL includes `w=T_ACTUAL&u=U_ACTUAL`.
- **When** The authenticated user changes to a replacement account before verification completes.
- **Then** The pending response does not launch Slack.

## slack-connect-page-021

Original test `A member without an installation gets an admin action rather than an install grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L339).

- **Given** Slack reports that the user is not connected or installed and is not an admin, with no installation grant.
- **When** The user opens the Slack settings page.
- **Then** The page says “Ask your admin to install the Slack integration” and offers “Back to settings”, rather than an installation action.

## slack-connect-page-022

Original test `A canonical preview page preserves access to its own API authorization URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L354).

- **Given** The user is on the canonical preview app host, and Slack returns an installation authorization URL; the page URL includes a preview protection-bypass query parameter.
- **When** The user opens the Slack settings page.
- **Then** The “Install to Slack” URL preserves the `x-vercel-protection-bypass=preview-secret` parameter.

## slack-connect-page-023

Original test `A retained Slack result survives login and organization selection (signed in: false): /?tab=works&updated=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L403).

- **Given** A signed-out user opens `/?tab=works&updated=1#public-context`.
- **When** The user is redirected through sign-in and organization selection.
- **Then** The sign-in page retains the final Slack settings URL `/settings/slack?updated=1#public-context` as its forced redirect destination.

## slack-connect-page-024

Original test `A retained Slack result survives login and organization selection (signed in: true): /?tab=works&updated=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L403).

- **Given** A signed-in user with no active organization or memberships opens `/?tab=works&updated=1#public-context`.
- **When** The user is redirected through sign-in and organization selection.
- **Then** The organization-selection route is shown, and the sign-in page retains `/settings/slack?updated=1#public-context` as its forced redirect destination.

## slack-connect-page-025

Original test `A retained Slack result survives login and organization selection (signed in: false): /slack/failed?error=access_denied&w=T12…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L403).

- **Given** A signed-out user opens `/slack/failed?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two#public-context`.
- **When** The user is redirected through sign-in and organization selection.
- **Then** The sign-in page retains `/settings/slack?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two#public-context` as its forced redirect destination, including both context values.

## slack-connect-page-026

Original test `A retained Slack result survives login and organization selection (signed in: true): /slack/failed?error=access_denied&w=T12…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L403).

- **Given** A signed-in user with no active organization or memberships opens `/slack/failed?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two#public-context`.
- **When** The user is redirected through sign-in and organization selection.
- **Then** The organization-selection route is shown, and the sign-in page retains `/settings/slack?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two#public-context` as its forced redirect destination, including both context values.

## slack-connect-page-027

Original test `An unrelated root query is not treated as a Slack completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/slack-connect-page.test.tsx#L432).

- **Given** An authenticated user with no active organization or memberships opens `/?tab=works&updated=1&prompt=Unrelated`.
- **When** The app redirects the user to organization selection.
- **Then** The URL has no query string; the unrelated root query is not treated as a Slack completion.
