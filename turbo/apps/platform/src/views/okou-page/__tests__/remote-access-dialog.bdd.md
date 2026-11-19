# Remote access dialog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-access-dialog.test.tsx](remote-access-dialog.test.tsx).

## remote-access-dialog-001

Original test `Allowed filtering retains a changed connection and keyboard focus until the filter changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-access-dialog.test.tsx#L99).

- **Given** A chat has 12 SSH connections, with Host 1 allowed by default.
- **When** The user filters to allowed connections, changes Host 1 to Off using the keyboard, then switches to All and back to Allowed before choosing Show all connections.
- **Then** Host 1 remains visible with Off and retains keyboard focus until the filter changes. The dialog says changed connections stay visible until switching filters. All and Show all display 12 connections, while Allowed shows that no connections are allowed.

## remote-access-dialog-002

Original test `An unconfirmed write is reconciled by reading saved permissions before another change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-access-dialog.test.tsx#L129).

- **Given** A chat has Host 1 allowed by default, and a permission change is saved by the service but its response fails.
- **When** The user turns Host 1 Off, then reloads permissions after the app cannot confirm the save.
- **Then** The app warns that it could not confirm the change and requires reloading before another change. Before reloading, Host 1 still shows Default (On) and cannot be changed. After reloading, it shows Off, is editable, and the chat reports SSH as not allowed.

## remote-access-dialog-003

Original test `A pending permission read shows loading rather than exposing default permissions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-access-dialog.test.tsx#L152).

- **Given** A chat has Host 1 allowed by default, but its permission read has not completed.
- **When** The user opens Remote access while the permission read is pending, then the read completes.
- **Then** The dialog shows a loading status without exposing default permissions. After the read completes, Host 1 shows Default (On), and the chat reports SSH as allowed by default.
