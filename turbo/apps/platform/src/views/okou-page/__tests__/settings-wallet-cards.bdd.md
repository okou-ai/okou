# Settings wallet cards

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-wallet-cards.test.tsx](settings-wallet-cards.test.tsx).

## settings-wallet-cards-001

Original test `shows Link CARD methods with the default first and one management action in a new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L104).

- **Given** A workspace member has a Link wallet with a default Visa card, a non-default Mastercard, and a bank account.
- **When** They open wallet settings.
- **Then** The cards appear with the default Visa first, showing brand, last four digits, and matching artwork; the bank account is omitted. One Manage cards link points to Link’s wallet in a new tab with safe link attributes, and no management button appears.

## settings-wallet-cards-002

Original test `uses the provider name when card details are absent and does not invent a default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L144).

- **Given** The Link wallet has a bank account marked default and a card without card details.
- **When** The member opens wallet settings.
- **Then** Only the card appears, using its provider name; no default marker or card artwork is shown. Manage cards remains available.

## settings-wallet-cards-003

Original test `keeps cards usable when the brand is unknown or its artwork fails to load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L169).

- **Given** The Link wallet has a Visa card with uppercase brand text and a card with an unknown brand.
- **When** The member opens wallet settings and the Visa artwork fails to load.
- **Then** Both cards remain usable with their names, brand text, last four digits, and the Visa default marker; failed or unknown artwork is not shown. Manage cards remains available.

## settings-wallet-cards-004

Original test `keeps management available while loading and when the wallet is empty`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L208).

- **Given** The member opens wallet settings while the cards request is pending, and the eventual wallet response is empty.
- **When** They view the cards section before and after the response arrives.
- **Then** Manage cards is available while loading and when the empty-wallet message is shown.

## settings-wallet-cards-005

Original test `keeps cards and transactions on tab return and refreshes both after a wallet change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L225).

- **Given** A connected member sees an Everyday card and a recent purchase in Link activity.
- **When** They return to the tab and focus it, then the workspace wallet changes to a Business card and updated purchase.
- **Then** Returning to the tab preserves the existing card and transaction without extra requests. During refresh the old data remains visible; after refresh, Business is marked default and replaces Everyday, and the updated purchase replaces the recent purchase.

## settings-wallet-cards-006

Original test `shows a wallet refresh failure while keeping card management available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L319).

- **Given** A connected member initially sees cards in wallet settings.
- **When** A workspace wallet change triggers a refresh that fails.
- **Then** The cards section shows “Couldn’t load your cards.” and removes the previous card, while Manage cards remains available.

## settings-wallet-cards-007

Original test `does not fetch or show cards when disconnected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L340).

- **Given** The wallet connection status is disconnected.
- **When** The member opens wallet settings.
- **Then** Cards are neither fetched nor shown, and the purchase-request empty state appears.

## settings-wallet-cards-008

Original test `does not fetch or show cards when missing permission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L340).

- **Given** The wallet is connected but the member lacks payment-method permission.
- **When** The member opens wallet settings.
- **Then** Cards are neither fetched nor shown, and the purchase-request empty state appears.

## settings-wallet-cards-009

Original test `does not fetch or show cards when revocation pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L340).

- **Given** The wallet has a revocation pending.
- **When** The member opens wallet settings.
- **Then** Cards are neither fetched nor shown, and the purchase-request empty state appears.

## settings-wallet-cards-010

Original test `hides cards after disconnect even when an earlier refresh completes later`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx#L366).

- **Given** A connected member sees an Everyday card and a wallet refresh is still in progress.
- **When** The wallet disconnects before that refresh completes.
- **Then** The Connect action appears, and the late refresh does not restore the cards section or Everyday card.
