# Custom connector connect lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-connector-connect-lifecycle.test.tsx](custom-connector-connect-lifecycle.test.tsx).

## custom-connector-connect-lifecycle-001

Original test `Cancel a pending custom connection and connect another account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-connect-lifecycle.test.tsx#L27).

- **Given** A user is connecting an Acme Search account with no existing account connections.
- **When** They enter a first secret and save, close the pending dialog, then start a second connection and enter a different secret while the first server request completes.
- **Then** Closing the first dialog aborts its request. The second dialog starts with a blank secret and retains the second secret despite completion of the first request; saving it opens the account-naming dialog and closes the connection dialog.

## custom-connector-connect-lifecycle-002

Original test `Keep a custom connection pending until its account naming continuation is ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-connect-lifecycle.test.tsx#L105).

- **Given** A user is connecting an Acme Search account while the account-naming continuation is waiting for account details.
- **When** They enter a secret and save while that account lookup is pending.
- **Then** The connection remains pending: the dialog shows a disabled Saving… control and retains the secret, while the account-naming dialog is not yet shown. When the lookup completes, the connection dialog closes and the account-naming dialog opens with an empty account name.
