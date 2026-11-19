# Main test inventory through dd337098

Compared main `4bf10b89` and `dd337098` (16 commits). Seven Platform test
files that this branch has cleared changed upstream. The merge keeps them
deleted until each file is rebuilt and preserves all upstream product code
and shared test helpers.

The [scenario ledger](test-rebuild-upstream-dd337098-scenarios.tsv) maps
187 registrations in those files to stable IDs. Of these, 148 have
unchanged declarations and 39 have changed declaration bodies. No
registration was added, removed or renamed in this range, so there are no
upstream additions and no new BDD supplement. The counts measure this
upstream range and do not affect the frozen denominator.

| File                       | Mapped | Unchanged | Modified | Modified and retained |
| -------------------------- | -----: | --------: | -------: | --------------------: |
| chat-capability-connectors |     15 |        12 |        3 |                     0 |
| chat-cards                 |     32 |        31 |        1 |                     0 |
| connectors-auth-methods    |     18 |        18 |        0 |                     0 |
| connectors-custom          |     23 |        22 |        1 |                     1 |
| project-chat-list          |     11 |        10 |        1 |                     1 |
| projects                   |     57 |        45 |       12 |                     7 |
| sidebar-virtualization     |     31 |        10 |       21 |                    10 |

## User behavior

- `3202044a` retires the chat connector client compatibility. Tests no
  longer mock the per-agent connector access endpoints
  (`mockConnectorAgentAccess`, `agentConnectorAccessContract.agent`).
  The connector user steps and assertions are unchanged. Rebuilt connector
  scenarios must not depend on those endpoints.
- `71af7ce1` makes project switch dependencies asynchronous. Project fold
  toggles now settle inside `act`, and the inbox waits for the expanded
  state. Scenarios keep their user steps and outcomes. Rebuilt project and
  sidebar tests must wait for the observable fold state.

Every modified row keeps its prior disposition. The changes affect fixtures
or timing only, and each scenario's Given/When/Then is unchanged. Seven
rows already marked `review-prior-upstream-or-remapped` in the earlier
`eaae30ac` ledger remain under review. Resolve them before those files are
rebuilt.

## Shared helpers

`src/__tests__/page-helper.ts` no longer passes `store.watch` to
`bootstrap$`. Every rebuilt file starts through `setupPage`, so the
accepted rebuilt suite must be rerun on the merged head. The changed
connector helpers (`chat-composer-connectors-test-helpers.ts`,
`connector-page-test-helpers.ts`) have no consumers among the accepted
rebuilt files.
