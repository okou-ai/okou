# Chat capabilities and independent chat flows

| File                               | Frozen rows | Passing selected rows |
| ---------------------------------- | ----------: | --------------------: |
| capability-home-page               |          31 |                    16 |
| chat-activity-summary              |           4 |                     2 |
| chat-capability-billing-recovery   |           8 |                     4 |
| chat-capability-mail               |           6 |                     3 |
| chat-capability-message-actions    |           7 |                     4 |
| chat-core-behavior                 |           2 |                     1 |
| chat-expected-failures             |           3 |                     2 |
| chat-heic-preview                  |           3 |                     2 |
| chat-history-message-resources     |           1 |                     1 |
| chat-home-compliance               |           1 |                     1 |
| chat-localization                  |           2 |                     1 |
| chat-navigation-conversation-state |           2 |                     1 |
| chat-offline-cache                 |           4 |                     2 |
| chat-plan-upgrade-card             |           1 |                     1 |
| chat-project-reading               |           1 |                     1 |
| chat-run-mobile                    |           1 |                     1 |
| chat-runless-delivery              |           3 |                     2 |
| chat-thinking-brand-motion         |           1 |                     1 |
| chat-unsupported-image-previews    |           2 |                     1 |
| composer-capability-menus          |           8 |                     4 |
| Total                              |          91 |                    51 |

The tests open the production Router with local HTTP, browser, and realtime
fixtures. They cover email details and draft actions, billing recovery,
composer and home capabilities, and independent chat entry, navigation,
rendering, delivery, offline, and failure states. Email actions use in-process
mock API handlers. The existing chat-capability-mail-003 test is preserved and
reverified, and its ledger row is refreshed without duplication.

The GWT checklist records the original conditions, actions, and outcomes.
The execution ledger maps all expanded Vitest rows to their selected frozen
IDs in both directions. Targeted Vitest, test TypeScript, ESLint, and Oxlint
passed before the 20 BDD files were removed.

Cumulative frozen coverage includes passing IDs whose execution files were
renamed. The separate upstream ledger is counted independently.
