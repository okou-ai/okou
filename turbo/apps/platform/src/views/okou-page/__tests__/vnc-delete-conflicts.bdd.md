# Vnc delete conflicts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-delete-conflicts.test.tsx](vnc-delete-conflicts.test.tsx).

## vnc-delete-conflicts-001

Original test `A stale VNC host generation blocks deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-delete-conflicts.test.tsx#L92).

- **Given** A VNC connection has generation 4.
- **When** The user confirms deletion, but the server reports a generation conflict and returns an updated connection.
- **Then** Deletion remains blocked, an alert appears, and the delete action is disabled; only one deletion attempt was made using expected generation 4.

## vnc-delete-conflicts-002

Original test `A VNC credential deletion rejected with VNC_CREDENTIAL_REVISION_CONFLICT remains blocked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-delete-conflicts.test.tsx#L134).

- **Given** An unassigned VNC credential has revision 3.
- **When** The user confirms deletion and the server rejects it with VNC_CREDENTIAL_REVISION_CONFLICT, returning an updated credential.
- **Then** Deletion remains blocked, an alert appears, and the delete action is disabled; only one attempt was made using expected revision 3.

## vnc-delete-conflicts-003

Original test `A VNC credential deletion rejected with VNC_CREDENTIAL_IN_USE remains blocked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-delete-conflicts.test.tsx#L134).

- **Given** An unassigned VNC credential has revision 3.
- **When** The user confirms deletion and the server rejects it with VNC_CREDENTIAL_IN_USE, returning an updated credential.
- **Then** Deletion remains blocked, an alert appears, and the delete action is disabled; only one attempt was made using expected revision 3.
