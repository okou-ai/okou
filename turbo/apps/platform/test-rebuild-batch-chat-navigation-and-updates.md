# Chat navigation, updates, and composer behavior

| File                                 | Frozen rows | Passing selected rows |
| ------------------------------------ | ----------: | --------------------: |
| chat-codex-execution                 |           5 |                     3 |
| chat-conversation-locator            |           5 |                     3 |
| chat-emoji                           |          12 |                     6 |
| chat-engagement-telemetry            |           4 |                     2 |
| chat-fork                            |           7 |                     4 |
| chat-image-navigation-shortcuts      |           8 |                     4 |
| chat-member-model-route              |           5 |                     3 |
| chat-mentions                        |           3 |                     2 |
| chat-metadata                        |           9 |                     5 |
| chat-missing-agent-recovery          |           6 |                     3 |
| chat-model-projection-refresh        |           5 |                     3 |
| chat-navigation-position-restoration |          11 |                     6 |
| chat-rename-focus                    |           7 |                     4 |
| chat-run-usage-localization          |           5 |                     3 |
| chat-search-debounce                 |           3 |                     2 |
| chat-selection-actions               |           6 |                     3 |
| chat-send-read-status                |           5 |                     3 |
| chat-sync-recovery                   |           6 |                     3 |
| chat-upload-diagnostics              |           3 |                     2 |
| chat-whitespace-drafts               |           5 |                     3 |
| Total                                |         120 |                    67 |

The tests open the production Router with the shared chat, API, browser,
and realtime fixtures. They cover chat identity and route restoration,
model and agent recovery, delivery and read status, request metadata,
composer input, shortcuts, media navigation, and chat actions.

The execution ledger matches each selected frozen ID to a passing Vitest
expansion in both directions. The GWT checklist records each scenario.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before removal
of the corresponding BDD files.

The conversation locator fixture fixes its timezone to UTC so the original
timestamp text and machine-readable instant are deterministic. The two forward
tests select the named destination dialog, leaving their original passage,
send, and refresh assertions intact. The Slack source link click uses a local
HTTP response.
