# Org usage tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-usage-tab.test.tsx](org-usage-tab.test.tsx).

## org-usage-tab-001

Original test `Review workspace credit balance and additions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L243).

- **Given** The workspace has a 12,000-credit balance and a credit grant dated March 1, 2026, for 10,000 credits with 8,000 remaining.
- **When** The user opens the workspace credit balance.
- **Then** The balance shows Org credits totaling 12,000 and the grant date, +10,000 added, and 8,000 left. It does not show the grant label or separate Pro credits and Purchased credits labels.

## org-usage-tab-002

Original test `Move from workspace credit balance to usage records`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L260).

- **Given** The user is viewing the workspace credit balance.
- **When** They choose to see credit usage.
- **Then** The Credit usage heading appears.

## org-usage-tab-003

Original test `Buy credits from the workspace balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L276).

- **Given** The user is viewing the workspace credit balance and is eligible to buy credits.
- **When** They choose Buy credits.
- **Then** The Billing and Buy credits headings appear.

## org-usage-tab-004

Original test `Hide Buy credits from an ineligible workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L297).

- **Given** The user is viewing the workspace credit balance, but the workspace is not eligible to buy credits.
- **When** The balance finishes loading.
- **Then** The credit grants section is shown, but Buy credits is not shown.

## org-usage-tab-005

Original test `Explain the composition of a workspace credit balance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L308).

- **Given** The workspace credit balance consists of 12,000 purchased credits.
- **When** The user hovers over the purchased-credits segment.
- **Then** A tooltip explains “Purchased credits — 12,000”.

## org-usage-tab-006

Original test `Review credit usage by workspace member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L343).

- **Given** The user is viewing team credit usage for the billing period. Alice has 7,500 total credits, including 6,000 model credits and 1,500 connector credits; Bob has 2,100 model credits.
- **When** They review usage by workspace member.
- **Then** Alice’s 7,500 and Bob’s 2,100 are shown, and the member usage includes Alice’s model and connector categories and Bob’s model category.

## org-usage-tab-007

Original test `Explain a member's model credit usage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L359).

- **Given** The user is viewing Alice’s team usage, where model usage totals 6,000 credits across two provider entries for the same model.
- **When** They hover over Alice’s model usage.
- **Then** The tooltip groups the entries under Models — 6,000 and displays the normalized model name GPT 5.6 Sol with 6,000 credits, not the raw provider identifier.

## org-usage-tab-008

Original test `Team usage groups historical data and new enrichment while conserving non-model credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L374).

- **Given** Alice’s usage is 84 credits: 14 connector credits, 60 other credits, and 10 model credits, with historical and enriched provider records contributing overlapping commerce and data-search categories.
- **When** The user reviews Alice’s team usage and hovers over each usage category.
- **Then** The total is 84. Connector details group the historical and enriched data-search entries into Data Search — 53 and retain Slack — 7; Other shows Legacy Data — 14; Models shows GPT 5.6 Sol — 10.

## org-usage-tab-009

Original test `Review workspace credit usage for the last seven days`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-usage-tab.test.tsx#L516).

- **Given** The user is viewing team usage for the billing period; Alice has 6,000 model credits and Bob has 2,100.
- **When** They change the range to the last seven days and hover over Alice’s model usage.
- **Then** The last-seven-days request is made, Alice’s total is 7,600 and Bob’s is 2,200, and Alice’s model tooltip shows 6,100 credits.
