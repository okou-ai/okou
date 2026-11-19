# Telegram and remote connection settings

| File                       | Frozen rows | Selected and passing rows |
| -------------------------- | ----------: | ------------------------: |
| telegram-settings          |          15 |                         8 |
| tailscale-settings         |          10 |                         5 |
| ssh-settings               |          19 |                        10 |
| vnc-native-settings        |           7 |                         4 |
| cloudflare-access-settings |          14 |                         7 |
| ssh-tailscale-settings     |          11 |                         6 |
| Total                      |          76 |                        40 |

The tests open the production Router with local fixtures for API responses,
browser events, and realtime updates. They cover Telegram link confirmation
and readback, network and credential draft lifetime, redaction and permission
loss, SSH host identity and rebinding, and VNC configuration and certificate
trust. No live connector or remote host is needed.

The selected registration bodies retain the frozen actions and assertions.
The execution ledger maps each selected ID to its passing Vitest expansion in
both directions. The GWT checklist records each condition, action, and
outcome. Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before
the corresponding BDD files were removed.
