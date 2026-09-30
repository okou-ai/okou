# Release 1 explicit row lock inventory

Ethan clarified on 2026-09-30 that explicit row locks used as a mutex
(`SELECT … FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE`) are
not part of the terminal state. A necessary short transaction contains only
the bounded reads and writes for one atomic business result and relies on
PostgreSQL's implicit locks from ordinary `INSERT`, `UPDATE`, `DELETE` and
foreign-key checks. Replacements used in this PR:

- conditional state transitions: `UPDATE/DELETE … WHERE <current state,
identity, revision, xmin or updated_at> RETURNING`, where zero rows is a
  deterministic lost/stale result (409, superseded, not published, no-op);
- uniqueness: existing unique constraints and partial unique indexes with
  `INSERT … ON CONFLICT`;
- admission that must see current parents: one `INSERT … SELECT … WHERE
EXISTS(…)` or a conditional statement, with foreign-key checks as the
  implicit protection;
- counts and balances: atomic arithmetic.

Two default-index races and one account-deletion race use a savepoint to turn
a constraint conflict into the serialized result instead of a 500: default
changes and default promotion (partial unique default index) and account
deletion racing a new chat-thread selection (RESTRICT foreign key; late
selections are deleted and counted).

## Syntactic count relative to main

origin/main total 377, HEAD total 328, delta -49 (count of explicit lock clauses in non-test API source; code moved
between files appears as a decrease in one file and an increase in another).

| File                                                    | main | this PR |   Δ |
| ------------------------------------------------------- | ---: | ------: | --: |
| `services/usage-pack-allocation-change.service.ts`      |   11 |       5 |  -6 |
| `services/agent-lifecycle.service.ts`                   |    7 |       2 |  -5 |
| `services/connector-account-lifecycle.service.ts`       |    6 |       1 |  -5 |
| `services/model-policy.service.ts`                      |    5 |       0 |  -5 |
| `services/gmail-automation-event.service.ts`            |    4 |       0 |  -4 |
| `services/google-forms-automation-event.service.ts`     |    4 |       0 |  -4 |
| `services/usage-pack-plan-change.service.ts`            |    4 |       0 |  -4 |
| `services/usage-pack-subscription-migration.service.ts` |    4 |       0 |  -4 |
| `services/connector-connection-write.service.ts`        |    3 |       0 |  -3 |
| `services/credit-usage.service.ts`                      |    3 |       0 |  -3 |
| `services/notion-automation-event.service.ts`           |    3 |       0 |  -3 |
| `services/ssh-connection.service.ts`                    |    3 |       0 |  -3 |
| `services/ssh-credential.service.ts`                    |    3 |       0 |  -3 |
| `services/stripe-automation-event.service.ts`           |    6 |       3 |  -3 |
| `services/vnc-connection.service.ts`                    |    3 |       0 |  -3 |
| `services/agent-webhook-firewall-auth.service.ts`       |    3 |       1 |  -2 |
| `services/chat-thread-connector-selection.service.ts`   |    2 |       0 |  -2 |
| `services/google-calendar-automation-event.service.ts`  |    2 |       0 |  -2 |
| `services/google-meet-automation-event.service.ts`      |    2 |       0 |  -2 |
| `services/vnc-credential.service.ts`                    |    2 |       0 |  -2 |
| `services/vnc-owner-lifecycle.service.ts`               |    2 |       0 |  -2 |
| `services/workflow-automation.service.ts`               |    7 |       5 |  -2 |
| `services/agentphone-connection-code.service.ts`        |    1 |       0 |  -1 |
| `services/builtin-connector-automatic-dcr.service.ts`   |    1 |       0 |  -1 |
| `services/cloudflare-access.service.ts`                 |    6 |       5 |  -1 |
| `services/connector-data.service.ts`                    |    1 |       0 |  -1 |
| `services/cron-billing-entitlements.service.ts`         |    1 |       0 |  -1 |
| `services/custom-connector-automatic-oauth.service.ts`  |    1 |       0 |  -1 |
| `services/custom-connector-oauth2.service.ts`           |    2 |       1 |  -1 |
| `services/get-started-rewards.service.ts`               |    1 |       0 |  -1 |
| `services/morning-brief-preference.service.ts`          |    1 |       0 |  -1 |
| `services/slack-connect.service.ts`                     |    1 |       0 |  -1 |
| `services/social-data.service.ts`                       |    3 |       2 |  -1 |
| `services/webhooks-stripe.service.ts`                   |    4 |       3 |  -1 |
| `services/workflow-schedule-expiry.service.ts`          |    1 |       0 |  -1 |
| `services/workflow-schedule-failure.service.ts`         |    1 |       0 |  -1 |
| `services/x-resource-usage.service.ts`                  |    1 |       0 |  -1 |
| `services/get-started-invitation-acceptance.ts`         |    0 |       1 |  +1 |
| `services/legacy-plan-invoice.service.ts`               |    0 |       1 |  +1 |
| `services/managed-usage-attribution.ts`                 |    0 |       1 |  +1 |
| `services/morning-brief-schedule-claim.service.ts`      |    3 |       4 |  +1 |
| `services/org-credit-expiration.service.ts`             |    0 |       1 |  +1 |
| `services/org-credit-expiration.ts`                     |    0 |       1 |  +1 |
| `services/social-data-settlement-plan.ts`               |    0 |       1 |  +1 |
| `services/usage-allowance-settlement-plan.ts`           |    0 |       1 |  +1 |
| `services/usage-expiry-prefix.ts`                       |    0 |       1 |  +1 |
| `services/usage-grant-prefix.ts`                        |    0 |       1 |  +1 |
| `services/x-resource-usage-values.ts`                   |    0 |       1 |  +1 |
| `services/credit-usage-settlement-plan.ts`              |    0 |       2 |  +2 |
| `services/morning-brief-automation-toggle.service.ts`   |    0 |       2 |  +2 |
| `services/usage-pack-grant-ownership.ts`                |    0 |       2 |  +2 |
| `services/workflow-automation-run-callback.service.ts`  |    1 |       3 |  +2 |
| `services/clerk-lifecycle-plan.ts`                      |    0 |       3 |  +3 |
| `services/morning-brief-materialization.service.ts`     |    0 |       3 |  +3 |
| `services/morning-brief-timezone.service.ts`            |    0 |       3 |  +3 |
| `services/workflow-user-automation-thread.service.ts`   |    4 |       7 |  +3 |
| `services/clerk-agent-lifecycle.service.ts`             |    0 |       7 |  +7 |

## Remaining increases and why they are kept

All remaining increases are locks moved from main files by this PR's
refactors (for example `credit-usage.service.ts`, `agent-lifecycle.service.ts`,
`social-data.service.ts`, `get-started-rewards.service.ts`,
`ensureWorkflowUserAutomationThread`) that still protect a guarantee no
equivalent conditional statement was found for in this round. They are R1
work, not release 2 compatibility:

- Credit settlement (`credit-usage-settlement-plan`, `usage-grant-prefix`,
  `usage-expiry-prefix`, `usage-allowance-settlement-plan` entitlement,
  `org-credit-expiration*`, `usage-pack-grant-ownership`, `legacy-plan-invoice`,
  `social-data-settlement-plan`, `managed-usage-attribution` run key share,
  `x-resource-usage-values`, `get-started-invitation-acceptance`): the grant and
  lot deductions must become xmin/`remaining >=` conditional updates with the
  orchestrator rejecting short row counts before the wallet-first ordering can
  be removed.
- Morning Brief (`morning-brief-schedule-claim`, `-automation-toggle`,
  `-timezone`, `-materialization`) and `workflow-automation-run-callback`:
  settlement recomputes the next run from the current cron/timezone; the
  lock-free form needs a deterministic lost-race outcome that does not leave a
  claim unsettled.
- `workflow-user-automation-thread`: binding creation/deletion ordering.
- Clerk deletion (`clerk-agent-lifecycle`, `clerk-lifecycle-plan`): ordered
  parent deletion with blob reference release; the blob `FOR UPDATE NOWAIT`
  also needs a design decision.

Pre-existing main locks in untouched paths are not increased. The advisory
key compatibility acquisitions (for example the six `connector_state` sites)
remain the only compatibility mechanism; no row lock is used for
compatibility.
