# Release 1 builtin `connector_state` writers

The `connector_state:<org>:<user>:<slug>` advisory key serialized one member's
builtin connector account, credential, watch and projection writers. Release 1
removes every new-writer dependency on it. The replacement protocol, in order
of preference:

1. Exact row locks and conditional writes on the rows a writer depends on
   (account `connectors` row, `workflow_automations`, watch/subscription state),
   with existing unique indexes and `ON CONFLICT`.
2. For writers that change or project the member's whole builtin account set,
   `builtinConnectorAccountRowsLockSql` (ordered `FOR UPDATE` of all of that member's
   account rows for the slug), the same ordering custom accounts use. It is
   `FOR UPDATE` because account writers later lock the same rows; builtin
   sibling reads after it do not lock again, since relocking siblings committed
   meanwhile would take them out of id order and deadlock.
3. An absent owner has no account state to protect; the first account's
   default is decided by `idx_connectors_org_user_slug_default` (a concurrent
   loser inserts as a sibling, or rolls back for retry when the serialized
   outcome would have differed).

Lock order: account rows (by id) → automations → watch/subscription state →
queue/event rows. Accepted product tradeoffs (ordinary refresh reconnect,
Calendar/Meet/Forms gaps, Gmail natural expiry) are relied on directly.

## Writers and disposition

| Writer (file)                                                                                                                      | Disposition                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue admission: Meet, Forms, Notion, Gmail, Calendar (`workflow-*-queue.service.ts`)                                              | Key removed. Automation `FOR UPDATE` and watch/state `KEY SHARE`/`FOR SHARE` (Gmail/Calendar also account `FOR SHARE`) arbitrate against deletion, disable and reprojection by old and new writers. |
| `commitOfficialFormsReconfiguration$`                                                                                              | Account rows lock.                                                                                                                                                                                  |
| Stripe ingress/delivery projection repair                                                                                          | Automation row `FOR UPDATE` before reading selection/default.                                                                                                                                       |
| `lockOfficialAutomationAccountProjection` (official reconciliation)                                                                | Account rows lock per slug; **compat key kept** (outgoing selection writers).                                                                                                                       |
| Gmail `repairGmailAutomationProjections$`, Calendar and Forms projection repair, Notion and Meet projection repair, Meet inventory | Account rows lock.                                                                                                                                                                                  |
| Gmail label publication, Forms activation, Notion pending event, Calendar watch publication                                        | Key removed; existing watch-state/automation CAS and FK checks arbitrate.                                                                                                                           |
| Calendar legacy primary migration                                                                                                  | Credential row → consumer automations → watch states, all row locks.                                                                                                                                |
| Meet subscription publication/removal                                                                                              | Account `KEY SHARE`, consumer automations `FOR SHARE`, unique upsert/delete.                                                                                                                        |
| Account connect (`resolveConnectorConnectionMutation`)                                                                             | Account rows lock; first account via default unique index.                                                                                                                                          |
| Automatic OAuth connection publication                                                                                             | Account rows lock; default from row count; unique index fallback.                                                                                                                                   |
| Set default (generic, Forms)                                                                                                       | Ordered account rows; **compat key kept** (outgoing automation creators read defaults without row locks).                                                                                           |
| Account deletion (`connector-data`, lifecycle deletion)                                                                            | Account rows lock before the exact row. Token-revoke preparation only reads ciphertext inside; decrypt and provider revoke run after commit.                                                        |
| Chat-thread connector selection prepare/update/clear                                                                               | Account rows lock per builtin slug; **compat key kept** on update/clear for automation-account slugs (outgoing automation creators).                                                                |
| Automation create/reconfigure/enable projection and workflow copy (`automationAccountProjectionLocksSql`)                          | Account rows lock; **compat key kept** (outgoing selection writers).                                                                                                                                |
| Credential refresh publication (command and runtime), firewall refresh, automatic MCP resolve/publication                          | Key removed; exact owner-row/stored-token CAS.                                                                                                                                                      |
| DCR retirement and replacement                                                                                                     | Key loops replaced by id-ordered linked account `FOR UPDATE`. The separate `connector-mcp-oauth` lifecycle key is unchanged and remains an R1 item.                                                 |

## Remaining compatibility acquisitions

Six short local acquisitions remain (chat selection update/clear, generic and
Forms set-default, official reconciliation, and the shared automation projection
helper used by automation writers and workflow copy). Each exists because an
outgoing `origin/main` writer — `updateChatThreadConnectorSelection` /
`clearChatThreadConnectorSelection`, or automation creators such as
`insertEventAutomation` — changes projection inputs under the key without
locking account rows. New writers are correct among themselves through row
locks alone. Release 2 removes the key and `builtinConnectorStateLockStatement`
after those writers stop serving, in-flight work drains and rollback targets are
compatible.

## Known residual behavior

- A first connect racing an automation creation for a member with no accounts
  can leave the automation's connector unset until the next reprojection.
- A first-account create that loses the default race when the serialized result
  would have been an update or a rejected sibling rolls back and must be retried.
- During the deploy overlap, outgoing writers that lock rows in a different
  order can deadlock with new writers; PostgreSQL aborts one request without
  corrupting state.
