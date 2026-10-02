# Required shared-helper caller adapters

Base: `100ac473ee6501f93105d3ac261796208096cc10`, the published parent head
including the financial and shared-boundary integrations plus the single
admission alias fix. This is a narrow second increment for Draft #37525.

## Production changes

- `internal-chat-run-callback.service.ts`: `insertAssistantErrorEvent$` and
  `insertRunLifecycleMarker$` are stable package-scope commands. Their inputs
  omit the old `db` field; they obtain `writeDb$` themselves and call
  `touchChatThreadLastMessageAtIndependently$` with ordinary thread/time/org/
  unarchive facts and the caller's final positional signal. Failed/completed
  callers use `set(...)` directly. Marker outcomes, replay work, callback IDs,
  timestamp facts and cancellation checks are preserved.
- The completed marker timing span no longer sends a closure containing `set`
  into the old timing wrapper. The command launches directly; the existing
  elapsed reporter records success and rejection using only its timing value
  and captured start time. No accessor, node or DB is a helper argument.
- `agent-event-consumer-run-output.service.ts`: the preparation/materialization
  path uses stable private commands and calls `appendAssistantEventRows$` from
  its owning command. The existing public `materializeRunOutputEvents$`
  signature, diagnostic cleanup/error path, immutable preparation facts,
  ownership assertion, idempotent insertion count and publication decision are
  retained. No transaction or lock is added or split.

The raw `materializeRunOutputEvents(db, ...)` export had no other consumers and
is removed rather than retained as a handle-forwarding wrapper.

## Existing infrastructure acceptance programs

`chat-event-auxiliary/acceptance.ts` and
`chat-event-context/acceptance.ts` each own a test-only Store and AbortController
and invoke the real named production commands directly. Production creates no
new Store and receives no injected Store, DB, accessor or alternate node.

The existing `mockEnv` primitive selects the test's UUID-owned local database
through configuration values, not a DB/pool mock. The context program includes
its isolated schema's search path in that connection URL. Test environment
initialization runs before database/environment imports. Existing local-host
checks, schema migrations, synthetic faults and all assertions are preserved.

Teardown cancels that command lifetime, closes the production pool owned by the
harness and clears the existing environment override before dropping the test
DB. Existing manual fixture/read pools remain independently owned and closed.
No production test hook, new row assertion, retry, lock or timeout was added.

## Concrete residual block-3 boundaries

This increment fixes the required shared command interfaces, not the entire
legacy callback/output subsystem. The following pre-existing execution chains
still carry handles and need their own later ownership conversion:

- `insertAssistantErrorEventTransaction` still receives the command's database
  and a legacy input containing `db`.
- `insertRunLifecycleMarkerProjection` and its delivery callback registration
  helpers still receive the existing projection `tx`/runtime database.
- Completed-output loading, `recordLastEventToComplete`, and the broader
  completed/failed callback input objects still retain their prior DB shape.
- `prepareRunOutputOwnership` still receives a DB for its legacy reads.
- `materializeAdmittedRunOutputEvents` still receives its prior runtime `db`.

No new wrapper was created to take `set/get/db`; these are unchanged legacy
sub-chains behind the newly owned operations. They are explicitly not claimed
terminal. The core shared touch/append commands themselves receive only
ordinary values and a final positional signal.

## Verification and scope

- Affected Prettier, ESLint and normal Oxlint pass.
- Static caller scans find no remaining calls/imports of the removed shared
  helpers in these production paths or the two acceptance programs.
- No full typecheck, Knip, Vitest, dev server or infrastructure acceptance run
  was executed; the parent owns integrated verification. Parser/lint success
  is not a claim that full types or behavior CI are green.
- Only the two production caller files, two acceptance programs and this
  handoff document changed. Shared publication/artifact column corrections,
  financial SQL, empty-RETURNING/schedule fixes and admission alias code are
  untouched. No additional PR, review, merge, queue, release or automation.
