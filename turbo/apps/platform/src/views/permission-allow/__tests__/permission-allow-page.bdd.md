# Permission allow page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [permission-allow-page.test.tsx](permission-allow-page.test.tsx).

## permission-allow-page-001

Original test `A user grants a time-limited connector permission and resumes the chat (Chat access: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L256).

- **Given** A user is asked to grant Slack's catalog.analytics:read permission for 24 hours and resume a chat, with connector chat-account access disabled.
- **When** The user confirms the grant.
- **Then** The permission is granted for 24 hours, the page confirms the update, and the chat resumes with the specified thread and prompt. The grant is scoped to the agent and connector.

## permission-allow-page-002

Original test `A user grants a time-limited connector permission and resumes the chat (Chat access: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L256).

- **Given** A user is asked to grant Slack's catalog.analytics:read permission for 24 hours and resume a chat, with connector chat-account access enabled.
- **When** The user confirms the grant.
- **Then** The permission is granted for 24 hours, the page confirms the update, and the chat resumes with the specified thread and prompt. The grant is scoped to the built-in Slack connector rather than the agent.

## permission-allow-page-003

Original test `Permission confirmation stays pending across a grant notification until its callback succeeds`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L415).

- **Given** A user is confirming a permission grant that has a chat-continuation callback in progress.
- **When** A connector permission-updated notification arrives before the callback succeeds.
- **Then** The confirmation remains pending and disabled, with neither a permissions-updated nor already-allowed message. Once the callback succeeds, the page reports that permissions were updated.

## permission-allow-page-004

Original test `Permission confirmation shows callback failure after a grant notification and disables further changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L424).

- **Given** A user is confirming a permission grant that has a chat-continuation callback in progress.
- **When** A connector permission-updated notification arrives and the callback fails.
- **Then** The page reports that permissions could not be updated. Confirm and the permission-duration control are disabled, and no already-allowed message appears.

## permission-allow-page-005

Original test `A user can allow a connector's uncatalogued endpoints without exposing an internal token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L436).

- **Given** A user is asked to allow Cloudflare's uncatalogued endpoints for one hour.
- **When** The user confirms the grant.
- **Then** The page describes the permission as Other endpoints without displaying the internal unknown-permission token, confirms the update, and submits the allow grant for one hour.

## permission-allow-page-006

Original test `An already effective permission does not ask for confirmation again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L487).

- **Given** A permission is already effectively allowed by policy and an existing grant that expires one hour after the current time.
- **When** The user opens the permission page.
- **Then** The page says Already allowed; it shows no duration or expired indication and offers no Confirm button.

## permission-allow-page-007

Original test `An already denied permission does not ask for denial again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L515).

- **Given** A permission is already denied by an existing permanent denial.
- **When** The user opens a page to deny that permission.
- **Then** The page says Already denied, shows no duration or expiry, and offers no Confirm button.

## permission-allow-page-008

Original test `An older permission link can still deny connector access safely`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L535).

- **Given** A user follows an older permission link using the ref connector parameter to deny Slack access; the permission currently has an allow grant.
- **When** The user confirms the denial.
- **Then** The page reports Permissions denied, shows no expiry, and submits a permanent deny for admin.analytics:read on Slack.

## permission-allow-page-009

Original test `An expired or invalid allow grant (not-a-date) requires fresh confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L574).

- **Given** A user's existing allow grant expires at the invalid value not-a-date.
- **When** The user opens a permission page with a 24-hour grant option.
- **Then** The page asks the user to update permissions rather than treating the grant as already allowed; Confirm is enabled and the duration is 24 hours.

## permission-allow-page-010

Original test `An expired or invalid allow grant (2030-01-01T00:00:00.000Z) requires fresh confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L574).

- **Given** A user's existing allow grant expires exactly at the current time, 2030-01-01T00:00:00.000Z.
- **When** The user opens a permission page with a 24-hour grant option.
- **Then** The page asks the user to update permissions rather than treating the grant as already allowed; Confirm is enabled and the duration is 24 hours.

## permission-allow-page-011

Original test `Permission grants that cannot be loaded fail closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L598).

- **Given** Permission grants cannot be loaded because the service returns 403.
- **When** The user opens the permission page.
- **Then** The page reports that permission grants failed to load and offers no Confirm button.

## permission-allow-page-012

Original test `A missing connector cannot be authorized`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L615).

- **Given** The connector catalog reports that hidden-connector does not exist.
- **When** The user opens a permission link for that connector.
- **Then** The page identifies the unknown connector and offers no Confirm button.

## permission-allow-page-013

Original test `An unsupported permission action fails closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L636).

- **Given** A user opens a permission link with the unsupported action approve.
- **When** The page loads the permission request.
- **Then** The page identifies the unknown permission action and offers no Confirm button.
