# Settings wallet

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-wallet.test.tsx](settings-wallet.test.tsx).

## settings-wallet-001

Original test `lets a member connect their workspace wallet and disconnect after consent completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L106).

- **Given** A workspace member has no connected wallet and grants consent through Link.
- **When** They select Connect, complete consent, then choose Disconnect from the wallet menu.
- **Then** The authorization URL opens once in a popup that has no opener. The wallet changes to Connected after the workspace notification, with no Reconnect or Disconnect action shown outside the menu; choosing Disconnect calls the disconnect action and returns an enabled Connect button.

## settings-wallet-002

Original test `updates the wallet after a workspace notification`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L158).

- **Given** A workspace member has no connected wallet.
- **When** A wallet-change notification for another workspace arrives, then the member’s workspace notification arrives after the wallet becomes connected.
- **Then** The other workspace notification does not update the wallet; the member’s notification updates the status to Connected and enables Disconnect in the menu.

## settings-wallet-003

Original test `shows authorization errors and allows retry when connectionStatus=not-connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L180).

- **Given** The wallet connection status is not-connected and opening the authorization window fails.
- **When** The member selects Connect.
- **Then** An alert says “Couldn’t complete the action.” and Connect remains enabled for retry.

## settings-wallet-004

Original test `shows authorization errors and allows retry when connectionStatus=connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L180).

- **Given** The connection status reports connected, but starting authorization fails.
- **When** The member selects Reconnect from the wallet menu.
- **Then** An alert says “Couldn’t complete the action.” and Reconnect remains enabled in the menu for retry.

## settings-wallet-005

Original test `shows authorization errors and allows retry when connectionStatus=scope-mismatch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L180).

- **Given** The connection status is scope-mismatch and opening the authorization window fails.
- **When** The member selects Reconnect.
- **Then** An alert says “Couldn’t complete the action.” and Reconnect remains enabled for retry.

## settings-wallet-006

Original test `shows authorization errors and allows retry when connectionStatus=reconnect-required`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L180).

- **Given** The connection status is reconnect-required and opening the authorization window fails.
- **When** The member selects Reconnect.
- **Then** An alert says “Couldn’t complete the action.” and Reconnect remains enabled for retry.

## settings-wallet-007

Original test `reconnects an existing wallet without disconnecting it first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L210).

- **Given** A member has an existing connected wallet and authorization can be opened.
- **When** They choose Reconnect from the wallet menu.
- **Then** The authorization URL opens without first disconnecting the wallet, and Disconnect remains available in the menu.

## settings-wallet-008

Original test `reconnects changed scopes directly and keeps the warning until new consent completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L240).

- **Given** A member’s wallet has changed permissions: user-info permission was added and legacy permission removed.
- **When** They reconnect and the wallet later reports the updated consent.
- **Then** The Update permissions warning remains while consent is pending, then disappears when the status becomes Connected; no Reconnect action remains visible. No separate Connected or Review permissions text appears before consent completes.

## settings-wallet-009

Original test `reconnects an expired authorization directly from its status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L294).

- **Given** A member’s authorization has expired and the wallet status is reconnect-required.
- **When** They choose Reconnect.
- **Then** The authorization URL opens directly without disconnecting. Reconnect required remains visible and Connected is absent while consent is pending; Disconnect remains available, and Reconnect is no longer offered in the menu.

## settings-wallet-010

Original test `offers Disconnect for a previously unfinished provider revocation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L335).

- **Given** A member has no connected wallet, but the provider reports an unfinished revocation.
- **When** They choose Disconnect from the wallet menu.
- **Then** The revocation is completed and an enabled Connect button appears.

## settings-wallet-011

Original test `labels recorded approvals as unconfirmed and retains history when disconnected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L364).

- **Given** A disconnected member has recorded purchase requests for Example Books ($35.00, approved) and Example Stationery (succeeded).
- **When** They open wallet settings.
- **Then** The purchase-request table retains both entries, showing the approval as “Approved, payment unconfirmed,” the other as “Payment succeeded,” and columns Merchant, Date, Amount, and Status. Connect is enabled and the list has no buttons.

## settings-wallet-012

Original test `shows a transaction error separately from connection status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L399).

- **Given** A member’s wallet is connected, but reading transactions is forbidden.
- **When** They open wallet settings.
- **Then** The Link transactions section shows “Couldn’t load transactions.” rather than the empty-state message, while the connection still shows Connected.

## settings-wallet-013

Original test `replaces recorded approvals with actual Link activity after permission is granted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L417).

- **Given** A connected member initially lacks permission to read Link transactions and has a recorded $1.00 approval; Link activity contains a succeeded USD transaction of -100 cents and a JPY transaction of -150 yen.
- **When** The member gains transaction permission and the workspace wallet changes.
- **Then** The recorded approval is replaced by Link activity, displaying -$1.00 and -¥150 with two “Payment succeeded” statuses; the unconfirmed approval label is gone.

## settings-wallet-014

Original test `shows a failed Link activity read as an error rather than recorded approvals`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx#L489).

- **Given** A connected member has permission to read Link transactions, but the Link activity read fails; recorded approvals are available separately.
- **When** They open wallet settings.
- **Then** The transactions section shows “Couldn’t load transactions.” and does not show recorded approvals as a fallback.
