# Chat capability connectors

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-connectors.test.tsx](chat-capability-connectors.test.tsx).

## chat-capability-connectors-001

Original test `with an unconnected banking conversation > connect banking and expose the connected accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L350).

- **Given** A banking conversation requests access for “Review recent cash-flow activity,” and the user has no banking connection.
- **When** The user opens the request and selects Connect a bank.
- **Then** A bank sign-in window opens and the request shows that the user should finish there and return to Chat. After banking access changes to a connected state, the request shows the Operating account checkbox.

## chat-capability-connectors-002

Original test `with connected accounts awaiting a banking grant > grant connected banking access and continue`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L433).

- **Given** A banking access request has the connected Operating account and defaults the access duration to 7 days.
- **When** The user selects the account, grants access, and continues.
- **Then** The request shows access active for 1 account, and the grant records that account, the request purpose, and a 7-day duration. Continuing sends “Continue the banking review.”

## chat-capability-connectors-003

Original test `with an active banking grant > revoke active banking access after continuing the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L521).

- **Given** Banking access is active for one account in a conversation with a continuation prompt.
- **When** The user continues twice, then confirms revocation.
- **Then** Both sends use the same client event and thread-sort event IDs. Revocation returns the request to account selection, leaves the account unchecked, and disables Grant access; one revoke request is recorded.

## chat-capability-connectors-004

Original test `Read a canonical custom default only on action activation (connected)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L569).

- **Given** A canonical custom MCP connector default is connected.
- **When** The user activates Connect on its conversation action.
- **Then** The account is read only after activation; the connector becomes Authorized without a dialog, and “Resume workspace search” is sent. The Authorized button is disabled.

## chat-capability-connectors-005

Original test `Read a canonical custom default only on action activation (reconnect-required)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L569).

- **Given** A canonical custom MCP connector default requires reconnection.
- **When** The user activates Connect on its conversation action.
- **Then** The account is read only after activation and a connection dialog opens. No authorization update or continuation prompt is sent.

## chat-capability-connectors-006

Original test `Read a canonical custom default only on action activation (configuration_incomplete)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L569).

- **Given** A canonical custom MCP connector default requires reconnection because the required apiSecret field is missing.
- **When** The user activates Connect on its conversation action.
- **Then** The account is read only after activation and a connection dialog opens. No authorization update or continuation prompt is sent.

## chat-capability-connectors-007

Original test `Connect or reconnect a custom MCP default before resuming (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L730).

- **Given** A custom MCP connector has no saved account.
- **When** The user connects it successfully through the conversation action.
- **Then** The connector becomes Authorized, an empty permission grant is recorded, and “Resume workspace search” is sent without a permissions section or dialog.

## chat-capability-connectors-008

Original test `Connect or reconnect a custom MCP default before resuming (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L730).

- **Given** A custom MCP connector has a saved account that needs reconnection.
- **When** The user reconnects it successfully through the conversation action.
- **Then** The connector becomes Authorized, an empty permission grant is recorded, and “Resume workspace search” is sent without a permissions section or dialog.

## chat-capability-connectors-009

Original test `Keep an incomplete custom MCP reconnect unauthorized without resuming`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L749).

- **Given** A custom MCP connector has a saved account with an incomplete reconnect configuration.
- **When** The user opens its connection dialog and reaches the enabled Save action without completing a successful reconnection.
- **Then** No authorization update or continuation prompt is sent, and the connection dialog remains open.

## chat-capability-connectors-010

Original test `Connect a single available connector without an unnecessary chooser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L760).

- **Given** A single available builtin connector, Drive Demo, uses provider sign-in and has no connected account.
- **When** The user selects Connect and completes provider authorization.
- **Then** The provider authorization URL opens without a connector chooser, and “Resume after Drive authorization” is sent after the connection completes.

## chat-capability-connectors-011

Original test `Authorize a healthy canonical builtin using its target default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L827).

- **Given** Canonical Drive is healthy, has a target default account, and is not yet authorized for the agent.
- **When** The user selects Authorize.
- **Then** Canonical Drive becomes authorized, the action shows a disabled Authorized button with no dialog, and “Resume canonical drive” is sent.

## chat-capability-connectors-012

Original test `A connector card observes a connection completed elsewhere`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L911).

- **Given** Shared Drive is not connected, though it is enabled for the agent.
- **When** A connection for Shared Drive is completed elsewhere and a connector-change event arrives.
- **Then** The action updates to a disabled Authorized button.

## chat-capability-connectors-013

Original test `Enable a single no-auth connector without an unnecessary dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L949).

- **Given** A single available public-data connector needs no authorization.
- **When** The user selects Connect.
- **Then** The connector is enabled without a dialog, and “Resume with public data” is sent.

## chat-capability-connectors-014

Original test `Require an explicit permission selection for a custom connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L999).

- **Given** Permissioned Search is a custom HTTP connector that requires an API secret and has a permission bundle.
- **When** The user enters an API secret, saves the connection, and selects Authorize.
- **Then** The Authorize action remains enabled and no continuation prompt is sent.

## chat-capability-connectors-015

Original test `Preserve an existing custom connector permission during reconnection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L1044).

- **Given** Permissioned Documents is a custom HTTP connector with an existing grant for documents.read.
- **When** The user reconnects it with a replacement API secret and saves.
- **Then** The connector is shown as Authorized with the action disabled, and “Resume document lookup” is sent.

## chat-capability-connectors-016

Original test `Reconnect an expired connector before resuming the task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L1089).

- **Given** Expired Drive is enabled but its authorization has expired, and the conversation says to reconnect before continuing the report.
- **When** The user selects Reconnect and a connector-change event arrives before OAuth completion is available, then another arrives after the connection is restored.
- **Then** The task is not resumed on the early event; once OAuth completion becomes available, “Continue the report after reconnection” is sent.
