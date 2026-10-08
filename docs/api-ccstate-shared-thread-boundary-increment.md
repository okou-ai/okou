# Shared thread/event boundary increment

Base: `0ad8faa5e97867362fcbf4a5837b83c926103fcd`. This increment is for the
existing Draft #37525; it neither creates another PR nor completes upper
execution/Pi ownership.

## Closed interfaces

The three owned files no longer accept DB/Tx/narrowed executors, callbacks,
accessors, or injected computed/command nodes. Their database execution is in
stable package-scope commands; transaction continuations are pure SQL/value
builders executed by the transaction's existing owner.

- `chatThreadOrganizationCondition(orgId: string)` and its existing predicate
  implement the same correlated Agent/org EXISTS without an ignored DB argument.
- `visibleChatEventCondition()` and its existing predicate retain revocation,
  error/input, Run ownership and interrupt visibility without a DB argument.
- `updateOwnedChatThreadWithEvent$(args, signal): Promise<boolean>` takes owned
  scope, thread ID, UPDATE values, optional SQL predicate and **plain event
  fields**, not an event callback. The computer-use event uses the UPDATE's
  returned `cloudBrowserEnabled`, not a proposed value or another read. Repeated
  matching writes still append optimistic client event IDs.
- `touchChatThreadLastMessageAtIndependently$(threadId, options, signal)` owns the
  identity read and independent weak timestamp, sort and optional unarchive
  actions. A timestamp failure does not suppress sort; only a successful actual
  unarchive produces its unarchive event. The caller's cancellation stops later
  work; no locks, retries or timeout changes were added.
- `touchSentChatThreadSort$(args, signal)` uses the caller's authorized identity
  without another thread read, independently attempts the weak timestamp and
  sort event, and does not unarchive.
- `appendAssistantEventRows$(args, signal)` returns
  `{insertedRowCount, shouldAttemptFirstAssistantEventClaim}`. It reads the Run
  once in its command and owns the existing atomic append. Empty batches return
  zero without querying or writing.
- `insertAssistantEvents$(args, signal)` preserves its public command signature;
  it composes the named append command and the first-message/publication action
  without sending its database to a helper.

All command signals remain the final positional argument. No new Store or
runtime command construction was introduced.

## Existing transaction continuation

The old `touchChatThreadLastMessageAt(tx, ...)` is removed. Its two statements
remain in the caller's original transaction, not a separately committing
command:

```ts
const rows = parseRawRows(
  chatThreadLastMessageTouchSchema,
  await tx.execute(chatThreadLastMessageTouchSql(threadId, touchedAt, scope)),
);
const sortSql = chatThreadLastMessageSortSql(rows, eventId, scope);
if (sortSql) {
  await tx.execute(sortSql);
}
```

The result schema is `{id: string, userId: string, agentId: string | null,
lastMessageAt: Date}`. The continuation is `SQL | null`: an unscoped missing
thread is a no-op; a scoped miss keeps the existing error. The ordering event
uses the returned monotonic timestamp and actual owner/Agent. Raw results are
parsed with the existing timestamp decoder, not asserted or coerced. These
SQL statements were inlined at the existing claim rejection and Discord
failure owners, with no new transaction or changed connection/snapshot.

## Necessary caller expansion

Beyond the three named files, the increment changes:

- Five thread mutation routes: pin, unpin, reorder, archive and computer-use
  host. The archive wrapper and host/thread existence helpers become named
  commands with plain inputs; authorization, feature/capability gates, host
  ownership/revocation checks and optimistic IDs remain.
- `chat-events.command.ts` only the organization predicate calls and the
  already-owned normal-send sidebar touch.
- `claim-run-context.ts` only visibility predicate calls and the inline
  transaction touch; `canonical-discord-ingress-processor.service.ts` only that
  touch and its immutable schema-column selection extraction to satisfy lint.
- `chat-incomplete-context.service.ts`, `web-chat-session-prompt.service.ts`,
  `cron-project-chat-event-search.service.ts`, and the existing `chat-events`
  fixture only remove the ignored visibility argument.
- `native-chat-event-write.service.ts` closes its command boundary; it no
  longer exports a handle-taking wrapper.
- `chat-first-assistant-event-metric.service.ts` is the necessary publication
  leaf. Its named command owns the existing one-row acknowledgement CAS and
  metric; it no longer sends DB to metadata/publication helpers. Existing
  eligibility and acknowledgement metric value functions are retained.
- `chat-event-write-side-effects.service.ts` adds
  `reportChatEventSideEffect(operation, threadId, startedAt, settledResult)`.
  Shared commands report settled owned work as data, rather than send DB or
  accessor closures through the legacy callback-based attempt helper.
- `chat-run-finished-automation-event.service.ts` only its budget-error append
  and weak sidebar touch become a named command, with the existing event UUID
  derivation and publication decision preserved.

No launch writer, upper execution function, Pi function, pricing/selection
owner or pending-launch SQL file was edited. The base's empty-RETURNING fix is
therefore preserved.

## Explicit remaining owner adapters

The following **unmodified upper-owner functions still call deleted helpers**:

- `internal-chat-run-callback.service.ts`: `insertAssistantErrorEvent` and
  `insertRunLifecycleMarker` each call the old independent touch. Once their
  owner is a command, use
  `set(touchChatThreadLastMessageAtIndependently$, threadId, options, signal)`
  with their existing org/time/unarchive facts, after committed projection.
  Do not add `set` to helper parameters or create a new Store.
- `agent-event-consumer-run-output.service.ts`:
  `materializePreparedRunOutputEvents` calls old `appendAssistantEventRows`.
  Its owning command should call `set(appendAssistantEventRows$, args, signal)`
  and use the same insertion result. It has no transaction/run lock to split.

Two existing isolated-database infrastructure acceptance programs also retain
old direct helper calls: `chat-event-auxiliary/acceptance.ts` (independent touch)
and `chat-event-context/acceptance.ts` (native touch). They need an owned command
harness rather than DB injection or test hooks; this increment does not
silently delete their fault assertions or claim those programs compile/run.

These are real integration gaps, not terminal completion or a reason to revive
legacy handle wrappers. Stable production replacements are
`touchNativeChatThread$(args, signal)` and the shared commands above. No
plumbing-bypassing hooks or compatibility helpers are included.

## Verification

- Affected Prettier, ESLint and normal Oxlint: pass.
- API-wide normal Oxlint: fails only the two existing `max-lines-per-function`
  diagnostics in unchanged `agent-run-execution.service.ts` at the pinned base;
  that owner was not edited to fix them.
- No local Vitest, dev server, full typecheck, Knip or type-aware lint was run.
  The parent owns heavy integrated checks. The known upper/infra adapter gaps
  mean this increment is not independently type-green.
- No extra PR, review, queue, merge, release or automation action.
