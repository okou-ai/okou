# Wallet, paid tools, and account preferences

| File                           | Frozen rows | Selected and passing rows |
| ------------------------------ | ----------: | ------------------------: |
| settings-wallet                |          14 |                         7 |
| paid-tools-settings            |          24 |                        12 |
| proactive-suggestions-settings |           4 |                         2 |
| proactive-learning-settings    |           4 |                         2 |
| sidebar-account-settings       |           3 |                         2 |
| my-okou-avatar-settings        |           2 |                         1 |
| Total                          |          51 |                        26 |

The tests open the production Router with local API, browser, and realtime
fixtures. Wallet consent, reconnection, disconnection, and transaction reads
use simulated boundaries. Paid Tools covers preference saves, model selection,
catalog cancellation, and workspace changes. The remaining files exercise
independent Proactive switches, account and Debug settings, and opening workspace instructions from the My Okou avatar.

The selected registration bodies preserve the frozen actions and assertions.
The GWT checklist records each scenario, and the execution ledger maps the
actual expanded Vitest names to the selected IDs in both directions.
Targeted Vitest, the test TypeScript project, ESLint, and Oxlint passed before
the corresponding BDD files were removed.
