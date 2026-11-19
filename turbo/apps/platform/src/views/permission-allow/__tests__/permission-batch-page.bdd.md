# Permission batch page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [permission-batch-page.test.tsx](permission-batch-page.test.tsx).

## permission-batch-page-001

Original test `Grouped permissions remain allowed after continuation success (My Okou=false, chat accounts=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L173).

- **Given** A user is asked to allow Slack chat:write and GitHub issues:read for one hour, with My Okou and connector chat-account access disabled.
- **When** The user allows both permissions and chat continuation succeeds.
- **Then** Both one-hour grants are applied, the page shows 2 of 2 permissions allowed, and the chat has continued. The displayed scope applies to the agent, not only the current task.

## permission-batch-page-002

Original test `Grouped permissions remain allowed after continuation failure (My Okou=false, chat accounts=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L173).

- **Given** A user is asked to allow Slack chat:write and GitHub issues:read for one hour, with My Okou and connector chat-account access disabled.
- **When** The user allows both permissions but chat continuation fails.
- **Then** Both one-hour grants remain allowed and the page shows 2 of 2 permissions allowed, but reports that permissions were allowed and the chat could not continue. The displayed scope applies to the agent, not only the current task.

## permission-batch-page-003

Original test `Grouped permissions remain allowed after continuation success (My Okou=false, chat accounts=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L173).

- **Given** A user is asked to allow Slack chat:write and GitHub issues:read for one hour, with My Okou disabled and connector chat-account access enabled.
- **When** The user allows both permissions and chat continuation succeeds.
- **Then** Both one-hour grants are applied, the page shows 2 of 2 permissions allowed, and the chat has continued. The displayed scope applies to each connector across all chats and agents.

## permission-batch-page-004

Original test `Grouped permissions remain allowed after continuation success (My Okou=true, chat accounts=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L173).

- **Given** A user is asked to allow Slack chat:write and GitHub issues:read for one hour, with My Okou enabled and connector chat-account access disabled.
- **When** The user allows both permissions and chat continuation succeeds.
- **Then** Both one-hour grants are applied, the page shows 2 of 2 permissions allowed, and the chat has continued. The displayed scope applies to the user's Okou use in the workspace, not only the current task.

## permission-batch-page-005

Original test `Grouped permissions remain allowed after continuation success (My Okou=true, chat accounts=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L173).

- **Given** A user is asked to allow Slack chat:write and GitHub issues:read for one hour, with My Okou and connector chat-account access enabled.
- **When** The user allows both permissions and chat continuation succeeds.
- **Then** Both one-hour grants are applied, the page shows 2 of 2 permissions allowed, and the chat has continued. The displayed scope applies to each connector across chats in the workspace, while teammates have their own permissions.

## permission-batch-page-006

Original test `Navigating from a dismissed batch isolates the next agent's permissions and continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L284).

- **Given** A user dismisses a batch permission request, then navigates to a different agent's batch request for GitHub issues:read and a different chat continuation.
- **When** The user allows the next agent's permission.
- **Then** The next request uses a one-hour grant for the next agent only, and continuation uses the next thread and prompt.

## permission-batch-page-007

Original test `Navigating from a continued batch isolates the next agent's permissions and continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L284).

- **Given** A user allows a batch permission request and continues its chat, then navigates to a different agent's batch request for GitHub issues:read and a different chat continuation.
- **When** The user allows the next agent's permission.
- **Then** The next request uses a one-hour grant for the next agent only, and continuation uses the next thread and prompt.

## permission-batch-page-008

Original test `Policy-allowed batches show their completed state without requiring a grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L414).

- **Given** Both requested permissions are allowed by policy by default.
- **When** The user opens the batch permission page without a callback.
- **Then** The page shows Permissions allowed and the chat:write description without requiring the user to submit a grant.

## permission-batch-page-009

Original test `Missing connector metadata fails closed and Not now dismisses without changing permissions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L421).

- **Given** Metadata for one requested connector permission cannot be found.
- **When** The user opens the batch permission page and chooses Not now.
- **Then** The page says it could not verify all permissions and that none can be changed; allowing all permissions is disabled. Dismissing reports that no permissions were changed.

## permission-batch-page-010

Original test `A malformed batch URL renders an unavailable page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L432).

- **Given** The batch permission link contains malformed item data.
- **When** The user opens the link.
- **Then** The page says the permission link is invalid or unavailable.

## permission-batch-page-011

Original test `A successful HTTP response without all grant acknowledgments cannot continue`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L439).

- **Given** A batch permission request includes two permissions, but the service returns a successful response with no grant acknowledgments.
- **When** The user attempts to allow all permissions and continue the chat.
- **Then** The page shows an alert and 0 of 2 permissions allowed; allowing all is disabled, and no completed Permissions allowed state appears.
