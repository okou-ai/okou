# Provider account, subscription, and billing coverage

| File                        | Frozen rows | Passing selected rows |
| --------------------------- | ----------: | --------------------: |
| auto-model-accounts         |           8 |                     4 |
| banking-card-realtime       |           1 |                     1 |
| billing-checkout-completion |           3 |                     2 |
| billing-plans-entry         |           9 |                     5 |
| billing-survey              |          10 |                     5 |
| credit-usage-display        |          12 |                     6 |
| feishu-connect-flow         |          14 |                     7 |
| marketing-checkout          |           3 |                     2 |
| org-invoices-tab            |           1 |                     1 |
| org-switcher                |           4 |                     2 |
| org-usage-tab               |           9 |                     5 |
| organization-refresh        |           2 |                     1 |
| personal-providers-tab      |          13 |                     7 |
| personal-usage-tab          |          15 |                     8 |
| settings-wallet-cards       |          10 |                     5 |
| sidebar-account-credits     |           6 |                     3 |
| sidebar-account-menu        |           6 |                     3 |
| sidebar-subscription-usage  |          22 |                    11 |
| subscription-linking        |          13 |                     7 |
| subscription-reset-card     |          17 |                     9 |
| Total                       |         178 |                    94 |

The tests use the production Router with local HTTP, browser, and realtime
fixtures. They cover account authorization, provider linking and reset,
checkout and billing state, wallet presentation, organization switching,
and usage summaries.

Feishu and Lark use separate named groups. Feishu registers 001, 002, 003,
004, and 007. Lark registers 009 and 011. The expanded Feishu login row 001
has no corresponding Lark login row 008. Shared helpers retain signed
identity submission, redirect, and incomplete-link guidance assertions.

The execution ledger maps the selected IDs to passing Vitest expansions in
both directions. GWT evidence is recorded in checklist volume 3.

Targeted Vitest, Platform test TypeScript, ESLint, and Oxlint passed before
the corresponding BDD removals. Main `92fb54ac` updates the For you Undo
toast teardown. The fix is applied in the retained deck fixture and its
nine existing cases passed alongside this batch.
