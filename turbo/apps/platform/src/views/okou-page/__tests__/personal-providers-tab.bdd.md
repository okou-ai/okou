# Personal providers tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [personal-providers-tab.test.tsx](personal-providers-tab.test.tsx).

## personal-providers-tab-001

Original test `Review personal subscription identity and usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L267).

- **Given** Three personal ChatGPT accounts are connected: one active account has 1,250.5 credits and two resets left, another has zero credits and no five-hour usage, and a third has unavailable reset counts.
- **When** The user opens model settings.
- **Then** Each row shows its email and connected status, with the available credit balance and reset count shown; unavailable resets are marked unavailable. The active account is identified, the others can be selected, and the active account’s usage rings show 82% and 55% remaining.

## personal-providers-tab-002

Original test `Show connection status without a credit snap… in the personal account row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L319).

- **Given** A personal ChatGPT account is connected and has no credit snapshot.
- **When** The user opens model settings.
- **Then** The account row shows its email and “Connected,” without a numeric credit balance.

## personal-providers-tab-003

Original test `Show connection status when the credit balan… in the personal account row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L319).

- **Given** A personal ChatGPT account is connected but its credit balance is unavailable.
- **When** The user opens model settings.
- **Then** The account row shows its email and “Connected,” without a numeric credit balance.

## personal-providers-tab-004

Original test `Show unlimited credits without a numeric bal… in the personal account row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L319).

- **Given** A personal ChatGPT account is connected with unlimited credits and no numeric balance.
- **When** The user opens model settings.
- **Then** The account row shows its email and “Connected · Unlimited ChatGPT credits.”

## personal-providers-tab-005

Original test `Show no 5h availability when the weekly allowance is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L331).

- **Given** A connected personal ChatGPT account has a fully exhausted weekly allowance, despite 100% remaining in its five-hour window.
- **When** The user opens model settings and hovers over the five-hour usage indicator.
- **Then** Both usage indicators show 0% remaining. The five-hour indicator’s details show 0% left and a reset in 5d 23h, with the weekly reset date displayed in America/New_York time.

## personal-providers-tab-006

Original test `Organize personal subscriptions in accessible provider tables`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L381).

- **Given** The personal account list contains ChatGPT accounts but no Claude accounts.
- **When** The user opens model settings.
- **Then** ChatGPT (Codex) appears before Claude, and the ChatGPT accounts are in an accessible table labelled by the ChatGPT heading. Claude shows “No accounts connected” and has no empty table.

## personal-providers-tab-007

Original test `Reset personal Codex account usage from the reset count`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L410).

- **Given** A connected personal Codex account has two resets left.
- **When** The user selects the reset count, confirms “Reset usage,” and completes the action.
- **Then** The reset confirmation closes and “Codex usage reset” appears.

## personal-providers-tab-008

Original test `Disconnect an active personal subscription account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L451).

- **Given** An active personal subscription account is connected.
- **When** The user chooses to disconnect it and confirms the action.
- **Then** The confirmation explains that disconnecting removes the account from Okou but does not cancel the provider subscription. The account row and confirmation disappear, and “Account disconnected” appears.

## personal-providers-tab-009

Original test `Keep a failed disconnect open and finish a successful retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L500).

- **Given** An active personal subscription account is connected and disconnecting it initially fails.
- **When** The user confirms disconnect, receives a server failure, and retries the disconnect.
- **Then** During the request, the disconnect and cancel controls are disabled. After failure, “Disconnect failed” appears while the dialog and account remain, and disconnect can be retried. The successful retry closes the dialog, removes the account, and shows “Account disconnected.”

## personal-providers-tab-010

Original test `Review personal subscriptions through account switching`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L562).

- **Given** Two personal ChatGPT accounts are connected; account A is active and has 1,250.5 credits, while account B has zero credits.
- **When** The user switches to account B, closes Settings with Escape, and opens subscription usage.
- **Then** Account B is active and account A is not; both rows retain their respective credit balances. Subscription usage shows “Limit reached,” “Credits,” and 0.

## personal-providers-tab-011

Original test `View personal account groups by default in an external workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L599).

- **Given** An authenticated member is in an external workspace with no personal provider accounts connected.
- **When** The user opens model settings.
- **Then** Claude and ChatGPT (Codex) groups each show “No accounts connected” and an enabled “Connect account” control.

## personal-providers-tab-012

Original test `Start and close personal Claude login directly from its account group`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L635).

- **Given** No personal provider accounts are connected.
- **When** The user starts Claude login from the Claude account group and closes the login dialog.
- **Then** The login starts for personal scope in add mode and explains that a Claude subscription can be used with Claude Code-backed agents. The dialog closes and the group’s connect control is enabled again.

## personal-providers-tab-013

Original test `Connect a personal Claude subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-providers-tab.test.tsx#L689).

- **Given** No personal provider accounts are connected and Claude device authorization is pending.
- **When** The user submits an authorization code to connect a personal Claude subscription.
- **Then** The account appears with the email, Pro plan, and usage indicators showing 88% five-hour and 76% weekly remaining; “Claude connected” appears.
