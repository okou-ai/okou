# Connector state key retirement

## Current September 30 decision

Ethan accepted recoverable failures for essentially all nonfinancial operations.
Do not retain old-version compatibility acquisitions or replace advisory locks
with row locks, empty writes, coordination retries, CAS or savepoint arbitration
solely to serialize low-frequency settings. Existing authorization and natural
primary/foreign-key/unique constraints remain. A later save, reconnect or task
may recover a transient failure. Amounts/payments/credits are not covered by this
relaxation. The two-release migration/trigger plan is unchanged.

## Keys actually deleted

`auth-state-lock.service.ts` is deleted. No new source references its former
`builtinConnectorStateLockStatement` or `modelProviderStateLockStatement`.
`automationAccountProjectionCompatLockSql` and its callers are also deleted.
There is no R2 lock-removal gate.

| Writers                                                             | Removal / current natural boundary                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat selection update/clear                                         | No key; existing selection identity and account/thread FKs remain.                                                                                   |
| Generic and Forms default changes                                   | No key; existing default-account unique index remains.                                                                                               |
| Official reconciliation                                             | No connector-state acquisition before projection.                                                                                                    |
| Automation create/change/enable and account projection              | Shared compatibility wrapper and every call removed; existing account/automation ownership remains.                                                  |
| Workflow copy                                                       | No connector-key loop; copied automations use normal projection repair.                                                                              |
| Credential refresh / firewall / automatic MCP                       | Already key-free publication paths are retained; no new compatibility acquisition is introduced.                                                     |
| Model-provider save/delete                                          | Both remaining model-provider-state acquisitions are removed; existing provider identity/uniqueness remains.                                         |
| DCR registration, OAuth exchange/refresh and connection publication | Lifecycle helper, SQL definition and all acquisitions are removed; existing registration uniqueness and binding FKs remain. HTTP/KMS is outside SQL. |
| Gmail watch                                                         | Mailbox key is also deleted; watch HTTP precedes local publication. Rolling old-stop gaps are accepted without forced renewal.                       |

Earlier account row-ordering replacements were already removed. Their former
lock-order descriptions are not a terminal protocol. Some earlier nonfinancial
savepoint/CAS/version machinery still needs simplification; key removal alone
does not certify that additional instruction complete. Do not move that work
to R2. Follow the [current per-key inventory](./advisory-lock-release-1-key-retirement.md)
for remaining financial keys and the six application triggers.

## Verification boundary

Tests must use public account, selection, automation, copy, OAuth and webhook
APIs. Keep authorization and permanently valid references, not exact winners or
call ordering. No internal waiter or lock gate is an acceptance test. Final
verification belongs to the combined latest HEAD; earlier green commits and
source scans are not current-head CI or deployed-version evidence.
