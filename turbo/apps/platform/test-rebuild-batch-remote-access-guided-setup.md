# Remote access and guided setup

| File                        | Frozen rows | Selected and passing rows |
| --------------------------- | ----------: | ------------------------: |
| remote-network-order        |           3 |                         2 |
| remote-credential-order     |           4 |                         2 |
| remote-access-forward       |           1 |                         1 |
| remote-access-dialog        |           3 |                         2 |
| remote-control-guided-setup |         140 |                        70 |
| Total                       |         151 |                        77 |

The tests open the production Router with local API, browser, and realtime
fixtures. They verify network and credential ordering, permission state across
chat navigation and resize, reconciliation of an unconfirmed permission
update, and the guided setup routes, drafts, credential forms, and error
recovery. Connector and host actions are simulated.

The selected registration bodies preserve the frozen actions and assertions.
The GWT checklist records each scenario, and the execution ledger maps the
actual expanded Vitest names to the selected IDs in both directions.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before the
corresponding BDD files were removed.
