# Sidebar subscription usage

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-subscription-usage.test.tsx](sidebar-subscription-usage.test.tsx).

## sidebar-subscription-usage-001

Original test `Open subscriptions by clicking the rail and open Models in Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L40).

- **Given** An authenticated user has connected ChatGPT and Claude subscriptions with usage remaining.
- **When** The user opens Subscription usage from the navigation rail, reviews provider details, and opens Claude settings.
- **Then** The preview shows ChatGPT at 55% left with one meter and Claude at 88% and 76% left with two meters; the rail summary reports ChatGPT 55% and Claude 76%. Reset dates appear in the configured New York time zone. Claude settings opens at “Use more models.” Escape closes Settings without reopening the preview and returns focus to the rail entry; Enter and Space can reopen the preview, and Enter on ChatGPT usage opens Settings again.

## sidebar-subscription-usage-002

Original test `Keep the usage preview closed after dismissing Settings with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L142).

- **Given** The Subscription usage preview is open and its ChatGPT details have opened Settings.
- **When** The user dismisses Settings with Escape.
- **Then** The preview remains closed and focus returns to the rail entry. Enter can open the preview again.

## sidebar-subscription-usage-003

Original test `Keep the usage preview closed after dismissing Settings with Close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L142).

- **Given** The Subscription usage preview is open and its ChatGPT details have opened Settings.
- **When** The user dismisses Settings with its Close control.
- **Then** The preview remains closed and focus returns to the rail entry. Enter can open the preview again.

## sidebar-subscription-usage-004

Original test `Show zero provider credits when weekly usage is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L209).

- **Given** Weekly usage is exhausted and provider credits have a balance of 0.
- **When** The user opens Subscription usage.
- **Then** The panel shows Credits and a balance of 0.

## sidebar-subscription-usage-005

Original test `Show unavailable provider credits when weekly usage is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L209).

- **Given** Weekly usage is exhausted and provider credits are unavailable.
- **When** The user opens Subscription usage.
- **Then** The panel shows Credits and an unavailable balance marked “—”.

## sidebar-subscription-usage-006

Original test `Show unlimited provider credits when weekly usage is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L209).

- **Given** Weekly usage is exhausted and provider credits are unlimited.
- **When** The user opens Subscription usage.
- **Then** The panel shows Credits and “Unlimited”.

## sidebar-subscription-usage-007

Original test `Show small positive provider credits when weekly usage is exhausted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L209).

- **Given** Weekly usage is exhausted and provider credits have a small positive balance of 0.0001.
- **When** The user opens Subscription usage.
- **Then** The panel shows Credits and the balance “< 0.01”.

## sidebar-subscription-usage-008

Original test `Keep the ChatGPT summary tied to its weekly limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L245).

- **Given** ChatGPT has 12% remaining in its five-hour window and 47% remaining in its weekly window; Claude has 76% weekly usage remaining.
- **When** The user opens Subscription usage.
- **Then** ChatGPT’s summary and meter use the weekly limit, showing one meter at 47% and “47% left.” The rail description reports ChatGPT 47% and Claude 76%.

## sidebar-subscription-usage-009

Original test `Show an exhausted week with its own reset time`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L302).

- **Given** ChatGPT weekly usage is exhausted with reset time January 7, while the five-hour window has invalid reset data and no remaining percentage.
- **When** The user opens Subscription usage and inspects the weekly meter.
- **Then** Only the weekly meter appears, at 0, with “Limit reached” and “Resets in 5d 23h.” The rail summary says “ChatGPT: Limit reached,” and the reset tooltip uses the configured New York time zone.

## sidebar-subscription-usage-010

Original test `Keep the usage preview closed after dismissing reset confirmation with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L358).

- **Given** The Subscription usage preview is open with exhausted Codex weekly usage, and the reset confirmation dialog is open.
- **When** The user dismisses the confirmation with Escape.
- **Then** The preview remains closed, focus returns to the rail entry, and activating the entry opens the preview again.

## sidebar-subscription-usage-011

Original test `Keep the usage preview closed after dismissing reset confirmation with Cancel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L358).

- **Given** The Subscription usage preview is open with exhausted Codex weekly usage, and the reset confirmation dialog is open.
- **When** The user cancels the confirmation with Cancel.
- **Then** The preview remains closed, focus returns to the rail entry, and activating the entry opens the preview again.

## sidebar-subscription-usage-012

Original test `Keep Codex reset pending until refreshed sidebar usage is ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L413).

- **Given** Codex weekly usage is exhausted, two resets remain, and the refreshed provider data is delayed after a reset succeeds.
- **When** The user confirms Reset usage.
- **Then** The confirmation remains open while refreshed usage is pending, and Cancel is disabled. After refresh completes, the dialog closes, focus returns to the rail entry, and reopening the preview shows 100% left.

## sidebar-subscription-usage-013

Original test `Keep reset unavailable when the reset balance is 0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L512).

- **Given** Codex weekly usage is exhausted and the reset balance is 0.
- **When** The user opens Subscription usage.
- **Then** Reset usage is unavailable, while a reset countdown is shown.

## sidebar-subscription-usage-014

Original test `Keep reset unavailable when the reset balance is null`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L512).

- **Given** Codex weekly usage is exhausted and the reset balance is null.
- **When** The user opens Subscription usage.
- **Then** Reset usage is unavailable, while a reset countdown is shown.

## sidebar-subscription-usage-015

Original test `Keep an active session open when provider loading remains unauthorized (saved locale: null)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L541).

- **Given** An authenticated user is on Workflows, has a saved locale of null, and the provider usage request remains unauthorized.
- **When** The user opens the account menu and Settings.
- **Then** The account menu still shows 12,500 credits, Workflows remains open, and neither sign-in redirect nor sign-out occurs. Settings opens successfully.

## sidebar-subscription-usage-016

Original test `Warn when codex-oauth-token weekly has little remaining usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L591).

- **Given** Connected Codex usage has 12% remaining in its weekly window.
- **When** The user opens Subscription usage and interacts with the panel and ChatGPT usage details.
- **Then** The rail entry warns that less than 20% remains, and the panel shows 12% left. Closing and reopening the preview works, and ChatGPT details open Settings at “Use more models.”

## sidebar-subscription-usage-017

Original test `Warn when claude-code-oauth-token fiveHour has little remaining usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L591).

- **Given** Connected Claude usage has 12% remaining in its five-hour window.
- **When** The user opens Subscription usage and interacts with the panel and Claude usage details.
- **Then** The rail entry warns that less than 20% remains, and the panel shows 12% left. Closing and reopening the preview works, and Claude details open Settings at “Use more models.”

## sidebar-subscription-usage-018

Original test `Warn when claude-code-oauth-token weekly has little remaining usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L591).

- **Given** Connected Claude usage has 12% remaining in its weekly window.
- **When** The user opens Subscription usage and interacts with the panel and Claude usage details.
- **Then** The rail entry warns that less than 20% remains, and the panel shows 12% left. Closing and reopening the preview works, and Claude details open Settings at “Use more models.”

## sidebar-subscription-usage-019

Original test `Keep the account menu available without connected subscriptions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L652).

- **Given** An authenticated user has no connected subscriptions.
- **When** The user opens the account menu.
- **Then** The menu remains available and shows 12,500 credits.

## sidebar-subscription-usage-020

Original test `Describe connected usage with an unknown percentage without treating it as empty`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L666).

- **Given** Claude is connected, but its weekly used and remaining percentages are unknown.
- **When** The user checks the navigation rail and opens Subscription usage.
- **Then** The rail description reports “Claude: —,” and the panel shows “—” rather than treating usage as empty.

## sidebar-subscription-usage-021

Original test `Show exhausted Claude usage with Resets in 4h 12m`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L696).

- **Given** Claude five-hour usage is exhausted and resets at 5:00 AM from a current time of 12:48 AM.
- **When** The user opens Subscription usage.
- **Then** The five-hour meter is 0, the panel shows “Limit reached” and “Resets in 4h 12m,” and the rail summary says “Claude: Limit reached.”

## sidebar-subscription-usage-022

Original test `Show exhausted Claude usage with Reset time unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-subscription-usage.test.tsx#L696).

- **Given** Claude five-hour usage is exhausted and its reset time is unavailable.
- **When** The user opens Subscription usage.
- **Then** The five-hour meter is 0, the panel shows “Limit reached” and “Reset time unavailable,” and the rail summary says “Claude: Limit reached.”
