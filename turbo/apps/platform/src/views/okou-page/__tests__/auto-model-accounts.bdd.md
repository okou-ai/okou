# Auto model accounts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auto-model-accounts.test.tsx](auto-model-accounts.test.tsx).

## auto-model-accounts-001

Original test `Offer a direct connection action in each empty provider section and keep it after cancelling authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L97).

- **Given** The user has no connected accounts and opens model settings.
- **When** They start connecting from either the Claude or ChatGPT (Codex) section, then close the authorization dialog.
- **Then** Each provider section has its own enabled Connect account action without an intervening provider menu. Both sections say no accounts are connected, and the action remains available after authorization is cancelled.

## auto-model-accounts-002

Original test `Show a connected account in its provider section only after authorization is confirmed by the account list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L137).

- **Given** The user has no connected accounts and starts Claude authorization; the authorization completion response arrives before the refreshed account list shows the new account.
- **When** They submit the authorization code while the refreshed account list is still pending, then the list returns the connected account.
- **Then** While the list is pending, the account is not shown. After the list confirms it, the Claude section shows the account email and Connected status; both provider sections retain enabled Connect account actions, and the empty ChatGPT section still says no accounts are connected.

## auto-model-accounts-003

Original test `Keep both provider sections after disconnecting the final saved account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L196).

- **Given** The user has one saved ChatGPT (Codex) account.
- **When** They disconnect that account and confirm the disconnection.
- **Then** The account is removed, but both provider sections remain and each says no accounts are connected; a Connect account action is available.

## auto-model-accounts-004

Original test `Keep expired accounts in management and expose their existing reconnect flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L221).

- **Given** The user has a saved Claude account that needs reconnection because its refresh token expired.
- **When** They open model settings and choose Reconnect for that account.
- **Then** The account remains in management with an Attention indicator, and the existing Claude authorization flow opens.

## auto-model-accounts-005

Original test `Connect ChatGPT directly without selecting a provider from a menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L237).

- **Given** The user has no connected accounts and opens model settings.
- **When** They choose Connect account in the ChatGPT (Codex) section.
- **Then** The Codex authorization dialog opens and displays its verification code without showing a provider-selection menu.

## auto-model-accounts-006

Original test `Disable only the provider that has reached the ten-account limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L268).

- **Given** The user has ten saved Claude accounts and no ChatGPT accounts.
- **When** They open model settings.
- **Then** The Claude Connect account action is disabled at ten accounts, while the ChatGPT (Codex) Connect account action remains enabled.

## auto-model-accounts-007

Original test `Show loading rather than a connect prompt before the first account read completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L288).

- **Given** The initial account read is still pending when the user opens model settings.
- **When** They view the settings before that read completes, then the read returns an empty account list.
- **Then** A loading status is shown and no Connect account action appears while the read is pending. After it completes, the Connect account action becomes available.

## auto-model-accounts-008

Original test `Keep account read failures distinct from having no connected accounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/auto-model-accounts.test.tsx#L317).

- **Given** The account list request fails while the user opens model settings.
- **When** They view the account-management section after the failed read.
- **Then** The section reports that the accounts could not be loaded, rather than showing an empty-account prompt or a Connect account action.
