# Feishu setup guide

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-setup-guide.test.tsx](feishu-setup-guide.test.tsx).

## feishu-setup-guide-001

Original test `feishu screenshots and secret controls preserve the current draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L19).

- **Given** A Feishu bot setup draft contains an app ID and secret.
- **When** The user shows the secret, opens and closes the setup reference, zooms the reference, presses Escape, visits the bot list, and starts adding a bot again.
- **Then** The app ID and secret remain unchanged while viewing and closing the reference, including after Escape. Starting a new bot draft clears the secret and presents it as a password field.

## feishu-setup-guide-002

Original test `lark screenshots and secret controls preserve the current draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L19).

- **Given** A Lark bot setup draft contains an app ID and secret.
- **When** The user shows the secret, opens and closes the setup reference, zooms the reference, presses Escape, visits the bot list, and starts adding a bot again.
- **Then** The app ID and secret remain unchanged while viewing and closing the reference, including after Escape. Starting a new bot draft clears the secret and presents it as a password field.

## feishu-setup-guide-003

Original test `feishu review guide navigates steps and resets reference screenshots`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L74).

- **Given** A Feishu installation is being reviewed using its setup guide, with the permissions guide showing its first reference screenshot.
- **When** The user selects the second permissions step, expands the permission JSON, advances to event delivery, then returns to Permissions from the step selector.
- **Then** The second permissions screenshot is shown and the expanded JSON includes tenant and user scopes. Advancing to event delivery and returning to Permissions each shows the first reference screenshot.

## feishu-setup-guide-004

Original test `lark review guide navigates steps and resets reference screenshots`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L74).

- **Given** A Lark installation is being reviewed using its setup guide, with the permissions guide showing its first reference screenshot.
- **When** The user selects the second permissions step, expands the permission JSON, advances to event delivery, then returns to Permissions from the step selector.
- **Then** The second permissions screenshot is shown and the expanded JSON includes tenant and user scopes. Advancing to event delivery and returning to Permissions each shows the first reference screenshot.

## feishu-setup-guide-005

Original test `feishu setup deep links preserve admin access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L128).

- **Given** A user who is not an organization admin opens the Feishu setup deep link while the Feishu feature is enabled.
- **When** The setup page loads.
- **Then** The page says an organization admin must configure the app and that the user can connect their own account from the Feishu bot list after setup is complete. No Next button is shown.

## feishu-setup-guide-006

Original test `lark setup deep links preserve admin access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L128).

- **Given** A user who is not an organization admin opens the Lark setup deep link while the Lark feature is enabled.
- **When** The setup page loads.
- **Then** The page says an organization admin must configure the app and that the user can connect their own account from the Lark bot list after setup is complete. No Next button is shown.

## feishu-setup-guide-007

Original test `feishu setup links cannot bypass its feature switch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L148).

- **Given** The Feishu feature switch is off and a user opens the Feishu setup deep link.
- **When** The setup page loads.
- **Then** The user is redirected away from Feishu setup, and the Create an Agent app step is not shown.

## feishu-setup-guide-008

Original test `lark setup links cannot bypass its feature switch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L148).

- **Given** The Lark feature switch is off and a user opens the Lark setup deep link.
- **When** The setup page loads.
- **Then** The user is redirected away from Lark setup, and the Create an Agent app step is not shown.

## feishu-setup-guide-009

Original test `feishu setup does not substitute another bot for a missing installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L164).

- **Given** A user opens the Feishu setup deep link for an installation ID that is missing.
- **When** The setup page loads.
- **Then** The user is returned to the Feishu bot list, and no App Secret field is shown.

## feishu-setup-guide-010

Original test `lark setup does not substitute another bot for a missing installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx#L164).

- **Given** A user opens the Lark setup deep link for an installation ID that is missing.
- **When** The setup page loads.
- **Then** The user is returned to the Lark bot list, and no App Secret field is shown.
