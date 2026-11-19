# Chat composer connectors

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connectors.test.tsx](chat-composer-connectors.test.tsx).

## chat-composer-connectors-001

Original test `Configure connector permissions from the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L119).

- **Given** Scout has an authorized Axiom connector with the permission annotations|create.
- **When** Scout opens connector permissions, changes that permission to Deny, then cancels.
- **Then** The permissions dialog closes, and the connector list is not shown again.

## chat-composer-connectors-002

Original test `Apply composer connector permissions as the agent's grants`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L163).

- **Given** Scout has an authorized Axiom connector with the permission annotations|create.
- **When** Scout changes that permission to Deny and applies the change.
- **Then** The permission update is applied as a deny grant for annotations|create on Scout's Axiom connector, and the dialog closes.

## chat-composer-connectors-003

Original test `connecting a custom connector for the active agent > cancel a custom connector for only the active agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L249).

- **Given** Scout is viewing custom connectors and Acme Search requires a secret.
- **When** Scout enters a secret and cancels, then reopens Acme Search setup.
- **Then** The secret field is empty, and no custom connection or authorization update is made.

## chat-composer-connectors-004

Original test `connecting a custom connector for the active agent > connect a custom connector for only the active agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L262).

- **Given** Scout is viewing custom connectors and Acme Search requires a secret.
- **When** Scout enters a secret and saves the connection.
- **Then** Acme Search is added for Scout alone using that secret, and it appears as removable in the connector list.

## chat-composer-connectors-005

Original test `Reconnect the expired custom default from the composer with healthy siblings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L297).

- **Given** Acme Search has an expired default account requiring reconnection and a healthy sibling account.
- **When** Scout enters a replacement secret in Acme Search setup and saves.
- **Then** The expired default account is reconnected with the replacement secret, without replacing the healthy sibling, and Acme Search is authorized for Scout.

## chat-composer-connectors-006

Original test `Show only the connector actions that are useful in chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L359).

- **Given** Scout has authorized Axiom with Work and Personal accounts and GitHub with a Work account.
- **When** Scout opens connector actions and removes Axiom.
- **Then** Axiom's account action appears before its permissions action, while GitHub has an account action. Removing Axiom changes its row to Add Axiom without opening a permissions dialog or removing the row.

## chat-composer-connectors-007

Original test `Start connector setup from chat, chat accounts=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L434).

- **Given** The ConnectorChatAccountAccess capability is disabled, and Google Analytics is available through OAuth.
- **When** Scout starts Google Analytics setup from chat and closes the authorization window.
- **Then** OAuth setup is requested with Scout's agent authorization enabled; the provider URL opens once, and the connect action becomes available again while the search remains intact.

## chat-composer-connectors-008

Original test `Start connector setup from chat, chat accounts=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L434).

- **Given** The ConnectorChatAccountAccess capability is enabled, and Google Analytics is available through OAuth.
- **When** Scout starts Google Analytics setup from chat and closes the authorization window.
- **Then** OAuth setup is requested without agent-specific authorization; the provider URL opens once, and the connect action becomes available again while the search remains intact.

## chat-composer-connectors-009

Original test `Complete or cancel connector authorization from chat (null)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L498).

- **Given** Google Analytics is available through OAuth, and authorization is in progress from chat.
- **When** The authorization window is left open, an account becomes available, and OAuth completion is reported.
- **Then** The window is not marked closed, and after it is closed the chat reports that Google Analytics connected and was authorized for Scout; the catalog closes.

## chat-composer-connectors-010

Original test `Complete or cancel connector authorization from chat (Close)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L498).

- **Given** Google Analytics is available through OAuth, and authorization is in progress from chat.
- **When** The catalog is closed while authorization is in progress, then an account becomes available and OAuth completion is reported.
- **Then** The authorization window is closed, and no connected-and-authorized success message is shown.

## chat-composer-connectors-011

Original test `Respect integration-managed connector availability in chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L564).

- **Given** Scout is authorized for integration-managed Feishu, which has Primary and Secondary accounts.
- **When** Scout opens the connector list in chat.
- **Then** Feishu can be removed, but no account-for-this-chat action is available.

## chat-composer-connectors-012

Original test `Require a permission choice before adding a permissioned custom connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L615).

- **Given** Acme Search is a connected custom connector with a permission bundle, but no permission choice has been made.
- **When** Scout selects Add Acme Search.
- **Then** No authorization update is made, and Acme Search remains available to add.

## chat-composer-connectors-013

Original test `Search beyond featured connectors from chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L640).

- **Given** GitHub is featured, while Axiom is available in the full connector catalog with API Token authentication.
- **When** Scout searches for Axiom and selects it.
- **Then** Axiom is absent before the search; the search opens one Axiom setup dialog showing the API Token field.

## chat-composer-connectors-014

Original test `Add or remove a connected connector for the active agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L677).

- **Given** GitHub is available but not enabled for Scout, while connected DeepWiki is enabled for Scout.
- **When** Scout adds GitHub and removes DeepWiki.
- **Then** GitHub becomes removable and is added to Scout's enabled connectors; DeepWiki becomes addable and is removed from Scout's enabled connectors.

## chat-composer-connectors-015

Original test `Exclude unconnected integration-managed connectors from chat setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L725).

- **Given** Feishu is an unconnected integration-managed connector, and Acme Search is an ordinary unconnected custom connector.
- **When** Scout opens custom connector setup in chat.
- **Then** Acme Search can be connected, while Feishu is neither listed nor offered for connection.

## chat-composer-connectors-016

Original test `Enable a credential-free connector directly from chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L758).

- **Given** Public Stripe is available with public access and requires no credentials.
- **When** Scout selects Connect Public Stripe.
- **Then** Public Stripe is enabled for Scout without opening a browser window or leaving a dialog open, and it appears as removable in the connector list.
