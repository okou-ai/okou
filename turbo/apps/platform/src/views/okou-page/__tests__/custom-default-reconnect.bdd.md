# Custom default reconnect

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-default-reconnect.test.tsx](custom-default-reconnect.test.tsx).

## custom-default-reconnect-001

Original test `Reconnect an expired custom default with 1 saved accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L102).

- **Given** The custom connector’s expired OAuth default account is among 1 saved account.
- **When** The user opens the connector to reconnect and saves a replacement secret.
- **Then** The account reconnects using the existing default account; the save intent identifies that account, and the connector is granted to the agent with no permissions.

## custom-default-reconnect-002

Original test `Reconnect an expired custom default with 2 saved accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L102).

- **Given** The custom connector’s expired OAuth default account is among 2 saved accounts.
- **When** The user opens the connector to reconnect and saves a replacement secret.
- **Then** The account reconnects using the existing default account, not the sibling; the save intent identifies that account, and the connector is granted to the agent with no permissions.

## custom-default-reconnect-003

Original test `Reconnect the current default when a healthy sibling exists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L182).

- **Given** The custom connector’s current default account needs no reconnection, and a healthy sibling account exists.
- **When** The user opens the connector and saves a replacement secret.
- **Then** The save intent reconnects the existing default account rather than adding another account, and the dialog closes.

## custom-default-reconnect-004

Original test `Wait for the initial account inventory before offering a custom connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L370).

- **Given** The custom connector has no saved accounts, but the initial account inventory request is still pending.
- **When** The user opens the connector page and waits for the account inventory to finish loading.
- **Then** No Connect button is offered while the inventory is pending. After it completes, Connect is enabled, and no account mutation has occurred.

## custom-default-reconnect-005

Original test `Keep a failed initial account inventory from offering a custom connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L385).

- **Given** The initial account inventory request for the custom connector fails with “Account access unavailable.”
- **When** The user opens the connector page.
- **Then** The error is shown, Connect is disabled, and no account mutation has occurred.

## custom-default-reconnect-006

Original test `Add the first custom OAuth account after confirming zero accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L399).

- **Given** The account inventory confirms that the custom connector has no saved accounts.
- **When** The user starts connecting and continues to provider authorization.
- **Then** Authorization opens at the provider URL and the account is added with an add intent. Closing the authorization window re-enables Continue.

## custom-default-reconnect-007

Original test `Cancel a pending default lookup before starting provider authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L415).

- **Given** The custom connector’s account inventory request is still pending while the user starts connecting.
- **When** The user continues, then closes the connection dialog before the account lookup completes.
- **Then** Provider authorization does not start, the authorization window closes, and no account mutation occurs, even after the lookup finishes.

## custom-default-reconnect-008

Original test `Keep a failed default lookup from creating another account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L438).

- **Given** The custom connector has saved accounts, and the default-account lookup fails with “Account access unavailable.”
- **When** The user continues from the connection dialog.
- **Then** The error is shown, the authorization window remains closed at its initial location, and no account mutation occurs.

## custom-default-reconnect-009

Original test `Keep a no-default default lookup from creating another account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L438).

- **Given** The custom connector has saved accounts but no default account.
- **When** The user continues from the connection dialog.
- **Then** The message that saved accounts exist but no default is shown, the authorization window remains closed at its initial location, and no account mutation occurs.

## custom-default-reconnect-010

Original test `Authorize an expired OAuth default only after ready completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L451).

- **Given** The custom connector’s expired OAuth default account can complete authorization successfully.
- **When** The user continues through provider authorization and closes the authorization window after completion.
- **Then** The connector becomes connected, the dialog closes, and the existing default account is reconnected. The agent receives a grant with no permissions.

## custom-default-reconnect-011

Original test `Keep an incomplete OAuth reconnect unauthorized`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L475).

- **Given** The custom connector’s OAuth default account is expired, but authorization completion does not return a ready connection.
- **When** The user continues through provider authorization and closes the authorization window.
- **Then** Continue becomes enabled again, but the connector is not shown as connected and no agent grant is created; the existing account was targeted for reconnection.
