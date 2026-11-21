# Chat composer connector status

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-status.test.tsx](chat-composer-connector-status.test.tsx).

## chat-composer-connector-status-001

Original test `Saved connectors with unavailable defaults stay visible for account repair`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L79).

- **Given** The connector directory contains a saved GitHub account and a saved Acme Search account, and both default accounts require reconnection.
- **When** The user opens the connector directory, searches for GitHub, then switches to Custom connectors.
- **Then** GitHub details and Acme Search remain available. No account values are requested, authorization is not updated, and no manual connection is started.

## chat-composer-connector-status-002

Original test `Healthy saved accounts stay connected while zero-account connectors remain available to add`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L114).

- **Given** GitHub and Acme Search each have healthy saved accounts, while Notion has no account.
- **When** The user opens the connector directory, searches for GitHub, then switches to Custom connectors.
- **Then** Notion remains available to add. GitHub and Acme Search are marked Connected.

## chat-composer-connector-status-003

Original test `A saved custom connector remains available for account management`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L145).

- **Given** Acme Search has a saved account.
- **When** The user opens the connector directory and switches to Custom connectors.
- **Then** Acme Search remains available for account management and is marked Connected.

## chat-composer-connector-status-004

Original test `Connecting a custom account updates the directory when it is reopened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L160).

- **Given** Acme Search has no saved account.
- **When** The user opens its connection form, saves a secret, and reopens the connector directory.
- **Then** Acme Search is marked Connected, and the directory no longer says it has no accounts.

## chat-composer-connector-status-005

Original test `Pending connected membership does not expose an ordinary add action as if no account exists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L191).

- **Given** Acme Search has no saved account, and the connected-connector inventory request is still pending.
- **When** The user opens the Custom connectors directory before that request completes.
- **Then** Acme Search is not shown as an ordinary add action, and no no-accounts message is shown. After the inventory request completes, Acme Search appears with a no-accounts message.

## chat-composer-connector-status-006

Original test `Connected inventory failure leaves managed Feishu in its own lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L212).

- **Given** Acme Search has a saved account, and Feishu is an OAuth custom connector with an account.
- **When** The connected-connector inventory request fails with a service-unavailable response, and the user opens the Custom connectors directory.
- **Then** The directory reports that accounts are unavailable for the connector. Feishu remains available through its own connection lifecycle, while Acme Search and a no-accounts message are absent. No custom authorization update occurs.

## chat-composer-connector-status-007

Original test `Custom definition failure keeps the unavailable directory explicit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L251).

- **Given** Acme Search is defined, but loading custom connector definitions fails with a server error.
- **When** The user opens the Custom connectors directory.
- **Then** The directory explicitly reports that custom connectors could not be loaded, and Acme Search is not offered.

## chat-composer-connector-status-008

Original test `A saved builtin target with no default sends the user to account management without inventing an account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L265).

- **Given** GitHub has saved accounts, none marked as the default, and the catalog says GitHub has no account.
- **When** The user searches for GitHub and opens its details.
- **Then** The user can manage GitHub accounts at /connectors. No Connect action is offered, and no OAuth connection is started.

## chat-composer-connector-status-009

Original test `Saved builtin membership keeps account management available without account names`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L292).

- **Given** GitHub has saved membership and supports manual API-token authentication, but its account names are not available.
- **When** The user searches for GitHub and opens its details.
- **Then** Account management links to /connectors and GitHub is marked Connected. No unnamed account is shown, and no manual connection is started.

## chat-composer-connector-status-010

Original test `Saved builtin targets remain manageable when definitions omit account projections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L315).

- **Given** GitHub has a saved account, while catalog discovery returns its definition without account projections.
- **When** The user searches for GitHub and opens its details.
- **Then** GitHub account management remains available.

## chat-composer-connector-status-011

Original test `A custom definition without account projections does not claim a reconnect is required`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx#L340).

- **Given** Acme Search has a saved account, while its custom definition has no account projection.
- **When** The user opens the Custom connectors directory.
- **Then** Acme Search is available, and the directory does not claim that reconnection is required.
