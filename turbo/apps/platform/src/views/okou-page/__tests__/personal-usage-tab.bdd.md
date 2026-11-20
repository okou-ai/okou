# Personal usage tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [personal-usage-tab.test.tsx](personal-usage-tab.test.tsx).

## personal-usage-tab-001

Original test `Review your member-package credit balance and grant rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L307).

- **Given** A workspace member has a usage pack with 20,400 total credits, including 20,000 purchased credits and 400 bonus credits, with purchased and bonus grant records.
- **When** The member opens usage settings.
- **Then** The usage pack card shows the total and purchased balances and a credit-additions table with dates, credits, and remaining amounts, including +25,000 and +400 grants. It does not show organization credit information, team usage, today’s usage, usage records, or package configuration.

## personal-usage-tab-002

Original test `Show a zero usage pack balance for a free admin without a package`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L336).

- **Given** A free workspace admin has no usage pack.
- **When** The admin opens usage settings.
- **Then** The usage pack balance is 0, organization credit information is present, and package configuration is unavailable.

## personal-usage-tab-003

Original test `Show a zero usage pack balance for a free member without a package`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L336).

- **Given** A free workspace member has no usage pack.
- **When** The member opens usage settings.
- **Then** The usage pack balance is 0, organization credit information is absent, and package configuration is unavailable.

## personal-usage-tab-004

Original test `Show bonus credits and hide package configuration when the capability is disabled for limited-free-1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L359).

- **Given** A limited-free-1 user has 1,000 bonus usage-pack credits and the package capability is disabled.
- **When** The user opens usage settings.
- **Then** Credit balance information and the 1,000-credit usage pack balance are shown, but package configuration is unavailable.

## personal-usage-tab-005

Original test `Show bonus credits and hide package configuration when the capability is disabled for pro`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L359).

- **Given** A Pro user has 1,000 bonus usage-pack credits and the package capability is disabled.
- **When** The user opens usage settings.
- **Then** Credit balance information and the 1,000-credit usage pack balance are shown, but package configuration is unavailable.

## personal-usage-tab-006

Original test `Start package configuration from an empty Atom balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L387).

- **Given** A Pro user with an Atom grant has no usage-pack subscription and can configure member packages.
- **When** The user selects “Configure member packages” from the empty usage-pack balance.
- **Then** The “Choose a plan” heading appears.

## personal-usage-tab-007

Original test `Show one-time bonus credits without an active package`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L407).

- **Given** A member has 10,000 one-time bonus usage-pack credits but no active package.
- **When** The member opens usage settings.
- **Then** The usage pack card shows the bonus balance and a +10,000 bonus grant.

## personal-usage-tab-008

Original test `Configure member packages from personal Credit balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L438).

- **Given** A Pro admin has a 20,400-credit package offering, with a 20 USD member allocation and a member eligible for packages.
- **When** The admin selects “Configure member packages” from personal Credit balance.
- **Then** The configuration dialog opens at step 2 of 3 and the member’s usage option shows 20,400 credits with a 2% discount.

## personal-usage-tab-009

Original test `Review every workspace member’s package balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L522).

- **Given** A workspace admin has two members, only one of whom has a 20,400-credit balance with purchased grants; the other has no credits.
- **When** The admin opens member balances, expands the funded member’s grants, and views organization credits.
- **Then** The member list shows both names and emails, with balances of 20,400 and 0. The funded member’s grant shows its date, +20,000 amount, remaining 20,000, purchased type, and April 1, 2026 expiry. Organization credits show 12,500.

## personal-usage-tab-010

Original test `Review personal credit-usage records by date range`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L660).

- **Given** Personal credit-usage records include 21 threads in March and usage across connectors, data search, and translation.
- **When** The user opens usage records, examines today’s usage details, and switches the range to the last seven days.
- **Then** Today’s records show the planning and Slack chats, 1.1K credits, 21 threads, and Mar 21, while the Feb 28 audit is absent. Connector details total 1,080 under Data Search, excluding the 3-credit translation; other details show 3 credits of Translation. The range changes to Last 7 days and the corresponding date range is requested.

## personal-usage-tab-011

Original test `Usage links keep Settings open for browser activations and close on click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L704).

- **Given** A usage record links to a chat while Settings is open and the browser can open new tabs.
- **When** The user activates the link with a normal click after testing modifier, middle, and right clicks.
- **Then** Modifier, middle, and right clicks leave Settings open and the current path unchanged. A normal click navigates to the chat and closes Settings.

## personal-usage-tab-012

Original test `Usage links keep Settings open for browser activations and close on Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L704).

- **Given** A usage record links to a chat while Settings is open and the browser can open new tabs.
- **When** The user activates the focused link with Enter after testing modifier, middle, and right clicks.
- **Then** Modifier, middle, and right clicks leave Settings open and the current path unchanged. Enter navigates to the chat and closes Settings.

## personal-usage-tab-013

Original test `Merge historical data and new enrichment into Connectors without double counting credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L748).

- **Given** A usage record has historical and enriched provider details, including overlapping Data Search providers, separate X and Slack connector usage, legacy data, and model usage.
- **When** The user examines connector, other, and model usage details.
- **Then** Connectors total 125: X is 12, Data Search is 110 without double counting, and Slack is 3. Other shows 8 credits of Legacy Data, and Models shows 10 credits for GPT 5.6 Sol.

## personal-usage-tab-014

Original test `Refresh all loaded usage pages after billing changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L902).

- **Given** Usage records span two loaded pages, with the second page loaded before a billing-change event.
- **When** The billing-change event occurs after the records have changed.
- **Then** The displayed records refresh to show the new 450-credit usage row, and rows from both previously loaded pages disappear.

## personal-usage-tab-015

Original test `Personal billing merges model aliases and historical Auto presets without changing totals`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/personal-usage-tab.test.tsx#L981).

- **Given** Personal model usage includes two aliases for GPT 6 Luna totaling 30 credits, plus 5 credits of Okou and 25 credits from a removed historical preset.
- **When** The user examines model usage details.
- **Then** Models total 60 credits; GPT 6 Luna shows 30 and Auto shows 30. The removed preset identifier is not displayed.
