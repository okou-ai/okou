# Ssh delete conflicts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ssh-delete-conflicts.test.tsx](ssh-delete-conflicts.test.tsx).

## ssh-delete-conflicts-001

Original test `A missing host after HTTP 404 cannot authorize deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L71).

- **Given** A saved SSH connection has generation 4.
- **When** The server returns HTTP 404 and reports that the host is missing.
- **Then** The dialog says the SSH host is no longer available and disables deletion. After canceling, the unavailable-configuration message appears and the dialog closes; the request used expected generation 4.

## ssh-delete-conflicts-002

Original test `A missing host after HTTP 409 cannot authorize deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L71).

- **Given** A saved SSH connection has generation 4.
- **When** The server returns HTTP 409 because the host changed, and the connection list now contains a different host at generation 99.
- **Then** The dialog says the host changed and disables deletion. After canceling, the unavailable-configuration message appears and the dialog closes; the request used expected generation 4.

## ssh-delete-conflicts-003

Original test `A host referenced by VNC cannot be deleted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L115).

- **Given** A saved SSH host is referenced by a VNC route.
- **When** The user confirms deletion and the server reports that the host is in use.
- **Then** The dialog explains that the SSH host is used by a VNC route and disables deletion. The request used expected generation 4.

## ssh-delete-conflicts-004

Original test `A logout change while deletion awaits a token prevents stale submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L131).

- **Given** The user opens deletion for a saved SSH connection, and the request is waiting for an authentication token.
- **When** The user logs out before the token resolves.
- **Then** The deletion dialog closes and no delete request is submitted.

## ssh-delete-conflicts-005

Original test `A owner change while deletion awaits a token prevents stale submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L131).

- **Given** The user opens deletion for a saved SSH connection, and the request is waiting for an authentication token.
- **When** The signed-in owner changes before the token resolves.
- **Then** The deletion dialog closes and no delete request is submitted.

## ssh-delete-conflicts-006

Original test `A session change while deletion awaits a token prevents stale submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L131).

- **Given** The user opens deletion for a saved SSH connection, and the request is waiting for an authentication token.
- **When** The session changes before the token resolves, while the owner remains the same.
- **Then** The deletion dialog closes and no delete request is submitted.

## ssh-delete-conflicts-007

Original test `A same-session token refresh preserves the deletion snapshot and uses the current token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-delete-conflicts.test.tsx#L173).

- **Given** The user opens deletion for a saved SSH connection at generation 4.
- **When** The token refreshes within the same session and the user confirms deletion.
- **Then** The request uses the refreshed bearer token and expected generation 4; the connection disappears and the unavailable-configuration message appears.
