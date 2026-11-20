# Connector lifecycle, setup, and callback coverage

| File                             | Frozen rows | Passing selected rows |
| -------------------------------- | ----------: | --------------------: |
| agentphone-connect-page          |          15 |                     8 |
| cloudflare-access-chat-refresh   |           1 |                     1 |
| cloudflare-access-parity         |           5 |                     3 |
| custom-managed-default-reconnect |           2 |                     1 |
| discord-oauth-compatibility      |          15 |                     8 |
| discord-source-presentation      |           3 |                     2 |
| feishu-appid-lifecycle           |           2 |                     1 |
| feishu-completion-lifecycle      |           2 |                     1 |
| feishu-icon-download             |           6 |                     3 |
| feishu-setup-guide               |          10 |                     5 |
| feishu-token-lifecycle           |           2 |                     1 |
| integration-oauth-callback       |           6 |                     3 |
| integration-uninstall-lifecycle  |           2 |                     1 |
| integrations-lark                |           3 |                     2 |
| lark-official                    |           6 |                     3 |
| teams-connect-page               |          17 |                     9 |
| telegram-callback-v2             |           9 |                     5 |
| telegram-connect-routes          |           6 |                     3 |
| telegram-oauth-connect           |          14 |                     7 |
| whatsapp                         |           4 |                     2 |
| Total                            |         130 |                    69 |

The tests enter through the production Router with local connector HTTP,
browser, download, and realtime fixtures. They cover Feishu and Lark setup
and lifecycle, OAuth callbacks and stale state, connector link and uninstall
behavior, and visible network refresh behavior.

The Feishu icon tests register only the three selected platform and activation
combinations. Both preserved successful download scenarios share the same
original byte and filename assertions. The unreadable-icon scenario retains
its error and navigation checks. The nested Feishu and Lark suite originally
registered frozen IDs 001 and 008 at the same source line. The
[provider account batch](test-rebuild-batch-provider-account-billing.md)
records the completed provider split and its selected rows.

The execution ledger maps actual Vitest expansions to selected IDs in both
directions. The GWT checklist records each scenario in volume 3. Targeted
Vitest, test TypeScript, ESLint, and Oxlint passed before removal of the
corresponding BDD files.
