# Canonical event SQL interface increment

Base: `9900095aaafb9386daeedfea5d51dcfcac9734b5` on the approved
`refactor/api-ccstate-terminal-37513` branch. This is an integration increment for
Draft #37525, not completion of the entire #37513 call chain.

## Closed event-layer interface

`chat-event.service.ts` and `chat-event-append.service.ts` execute no database
operations and accept no DB, transaction, narrowed executor, accessor, node,
callback, or runtime capability. They create no Store or signal graph.

| Export                                               | Contract                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `prepareChatEvent(values)`                           | Prepare identity, timestamp, canonical row, and display-context facts.                                                     |
| `chatEventContextInsertSql(values)`                  | Required input context INSERT, or `null` when the event has no context to write. The input must have an explicit event ID. |
| `chatEventInsertSql(values, conflict = "none")`      | One event's existing atomic sequence reservation and append. Does not persist context.                                     |
| `chatEventsInsertSql(values)`                        | Batch reservation and append with `"any"` conflict semantics; an empty input reserves nothing and returns no rows.         |
| `chatEventReplacementInsertSql(source, replacement)` | Validate the immutable revoke edge and prepare the replacement append from the caller's authoritative source snapshot.     |
| `chatEventReplacementTargetSql(eventId)`             | SQL read for an owner that does not already possess that snapshot.                                                         |
| `chatEventReplacementTargetSchema`                   | Decode the raw target read, including timestamps, event enum and canonical model selection.                                |
| `requireChatEventReplacementTarget(rows)`            | Require the loaded target; preserve the missing-target error.                                                              |
| `appendCanonicalChatEventsSql(rows, conflict)`       | Existing sequence reservation and insert SQL; its SQL body is unchanged.                                                   |
| `chatEventCommandResultSchema`                       | Validate append output, returning exactly `{ id, createdAt, seqId }`.                                                      |
| `chatEventAppendResultSchema`                        | Batch output, additionally including nullable `sequenceNumber`.                                                            |

The handle-taking `insertChatEvent`, `insertChatEvents`,
`insertChatEventContext`, `replaceChatEvent`, `replaceLoadedChatEvent`,
`revokeChatEvent` and `appendCanonicalChatEvents` exports are removed.

## Parent integration: already-loaded pick/claim source

The parent now owns rejection preparation and the SQL-only commit transaction.
Adapt its two calls inside that existing owner; do not replace its newer pick
helper or add another source read or independently committing command.

```ts
const [rejected] = await executeRawRows(
  tx,
  chatEventReplacementInsertSql(source, replacement),
  chatEventCommandResultSchema,
);
const [assistant] = await executeRawRows(
  tx,
  chatEventInsertSql(assistantValues),
  chatEventCommandResultSchema,
);
```

Import the SQL constructors from `./chat-event.service`, the result schema from
`./chat-event-append.service`, and `executeRawRows` from
`../../lib/db-raw-rows`. The source satisfies
`LoadedChatEventReplacementTarget`: `id`, `chatThreadId`, `createdAt`,
`eventType`, `contextType`, `contextId`, and optional nullable `modelSelection`.
Extra prepared source fields such as `userMessage` are fine. Keep the parent's
existing result checks, fencing, sort write, recovery and transaction owner.

For an owner without a loaded source, use `chatEventReplacementTargetSql` and
`chatEventReplacementTargetSchema` on its **same connection**, then pass the
result through `requireChatEventReplacementTarget`. A recall now includes these
immutable fields in its existing authoritative target read instead of querying
the target again. A control revocation is an ordinary replacement with
`eventType: "control.revoke"` and `content: null`.

A context owner executes the context INSERT before its event append:

```ts
const contextInsert = chatEventContextInsertSql(event);
if (contextInsert) {
  await tx.execute(contextInsert);
}
```

Keep that SQL in the owning command's transaction when required. Do not pass
`tx` to another helper or replace a transaction-local read/write with a new
command that commits on another connection.

## Actual changed callers

There were 69 matching occurrences in the original API `src` scan: 54 caller
operations adapted here, four parent-owned caller operations left untouched,
and eleven event-layer declarations/internal calls eliminated. The source
callers changed are:

- `chat-events.command.ts` (Web send/context, recall and interrupt).
- `chat-queued-event.service.ts` (loaded-target queue association).
- `active-input-delivery.service.ts` (loaded-target consumption and budget revoke).
- `workflow-automation-enqueue.service.ts` (context/append and scheduled revoke).
- `canonical-discord-ingress-processor.service.ts` (failure event append).
- `internal-chat-run-callback.service.ts` (error, fallback, terminal marker and followups).
- `chat-event-shared.service.ts` (assistant batch).
- `chat-run-finished-automation-event.service.ts` and
  `cron-steer-run-time-budget.service.ts` (budget events).
- `routes/test-cron-monitor-chat-event-queue-state.ts` and existing
  `test-fixtures/{chat-events,chat-event-search,chat-event-retention,official-workflow-queue}.ts`.

The three existing infrastructure acceptance programs under
`scripts/chat-event-{context,sequences,auxiliary}/acceptance.ts` also use the SQL
constructors. Their assertions and exception scenarios are retained, not
weakened. Pure value preparation was extracted from the annotation fixture to
keep the existing function-size rule; no fixture verification was deleted.

## SQL, consistency and provenance

- Seven provider/automation context INSERTs use `PgDialect.buildInsertQuery`
  with the real schema column encoders. SQL construction has no session.
- `agent_run` context source ownership becomes one `INSERT ... SELECT` joining
  `chat_threads` to `agents` by both source identities. A missing joined source
  still inserts no context. Owner and tenant come from that source, not the
  destination or an untrusted argument. Its nested builder uses `.getSQL()`.
- Immutable target validation still rejects a different thread, self-revocation,
  non-earlier source timestamp and invalid event-type edge. Replacements retain
  context provenance, including explicit nulls and `usage.recorded`, and retain
  the prior model-selection fallback behavior.
- Context is written before the input that points to it. Append never creates
  context. ID, revoke-edge, run-event and run-lifecycle conflict policies and
  sorted sequence allocation are unchanged; intentional conflicts consume
  positions and SQL failures roll back reservation with insertion.
- No explicit transaction was added, removed or moved by this increment.
  Existing caller transactions remain on their original connection. Combining
  the agent-run context read and INSERT is not removal of an explicit transaction.
  Parent queue/admission ownership is not claimed complete here.
- No schema, persisted encoding, authorization, money, claim fencing, external
  resource publication or MCP protocol was changed. Existing weak side effects
  and orphan/recovery owners are not replaced with a new protocol.
- The old event-helper append-duration debug/warn instrumentation disappears
  with the executing helper. Restoring that specific diagnostic, if required,
  belongs at owning execution sites; this increment does not claim identical
  helper-level timing telemetry.

## Verification and remaining boundaries

- Affected Prettier and ESLint: pass.
- API-cwd Oxlint and affected type-aware Oxlint: pass.
- `TSC_CHECKERS=1` full API aggregate: attempted; stops in core with exactly four
  missing-export errors in the untouched pick/claim imports. These are the
  parent integration steps above, not suppressed errors.
- After core emitted declarations, routes, bootstrap, both test programs,
  bootstrap wiring and chat-event acceptance type projects were checked
  separately with one checker: pass. This does **not** make the aggregate green.
- API-cwd Knip with `KNIP_DISABLE_RAW_TRANSFER=1`: nonzero. Its normalized issue
  output exactly matches a separate checkout of the pinned base; no new Knip
  issue is claimed. The first invocation without that flag failed at OXC buffer
  allocation before analysis.
- An agent-side, connection-free SQL construction check compared SQL, ordered
  encoded parameters and driver typings of all seven ordinary context INSERTs
  against their existing Drizzle INSERTs: exact matches. It also checked the
  agent-run source SQL, replacement aliases, edge validation and serialized
  provenance. It is not PostgreSQL execution, a public API test or CI acceptance.
- No local Vitest, dev server, PR, review, merge, automation or release action.

### Honest residual scope

The core event constructors are capability-free; the broader callers are **not
all terminalized** merely by migrating their event operation. Existing handles
remain in `appendAssistantEventRows`/`insertAssistantEvents`, active-input
consumption/expiry, terminal callback helper/runtime objects, Discord failure
persistence, autonomy-budget helpers, and queue association/admission helpers.
`workflowAutomationQueueEventWriter` still returns a transaction-taking closure;
that is parent-owned workflow queue orchestration, not solved by this increment.
Existing Web-send transaction helpers such as asset registration and network
capture also remain outside the event constructor conversion.

`pick-chat-run.service.ts`, `claim-run-context.ts`,
`agent-run-execution.service.ts`, `usage-allowance.service.ts`, model catalog and
switch workers were not edited. `chat-thread-event.service.ts` was also untouched,
so newer parent rename-builder options cannot be overwritten by this increment.
The parent must integrate the pick/claim APIs, finish applicable caller ownership
and verify CI/public behavior before calling the overall target complete.
