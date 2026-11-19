# Computer Use and shell authorization

| File                            | Frozen rows | Selected and passing rows |
| ------------------------------- | ----------: | ------------------------: |
| computer-use-authorization-page |           4 |                         2 |
| computer-use-authorization-card |          12 |                         6 |
| chat-capability-computer-use    |          12 |                         6 |
| ssh-authorization               |           4 |                         2 |
| desktop-shell-authorization     |          28 |                        14 |
| Total                           |          60 |                        30 |

The tests open the production Router with local API, browser, clock, and
realtime fixtures. They verify eligible computers, saved chat choices,
blocked and completed authorization, revocation, expiry, and continuation
after approval. The fixtures simulate host and authorization actions.

The selected registration bodies preserve the frozen actions and assertions.
The GWT checklist records each accepted scenario, and the execution ledger
maps the actual Vitest expansions to selected IDs in both directions.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before removal
of the corresponding BDD files.
