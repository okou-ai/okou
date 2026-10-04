# Issue #37513: bounded Thread read-cursor ownership

Related to #37513. E1 covers only mark-read and mark-Agent-threads-read, based
on fresh main `a243235f5661255b6f4a1d46bdf7c4e0956c597c`.

## Actual call graph and public surface

- Single-thread route authentication remains user-only. Its request-derived
  computed constructs `createChatThreadReadPreparation({ threadId, userId })`.
  The private graph reads the owned Thread, its Agent organization and newest
  terminal watermark once each. Missing Thread/Agent remains 404; organization
  absence or an unrelated active organization does not reject an owned Thread.
- Agent route retains organization auth and body validation before constructing
  `createAgentThreadReadPreparation({ agentId, userId, orgId })`. Its private
  graph reads the organization-scoped Agent, caller-owned bounded candidates
  and their terminal watermarks. Candidate IDs derive inside the watermark
  computed from the shared candidate source; no second candidate query or
  executor input is introduced. Unknown/cross-org Agent remains effect-free 204;
  a missing organization remains 401.
- Each factory returns one business computed, not a node bundle. The single
  result carries publication identity, the pre-read cursor and watermark;
  the Agent result carries only eligible `{ threadId, watermark }` advances,
  or null for an absent authorized Agent.
- Both entry handlers consume derived plain facts and call module-scope
  `advanceChatThreadReadCursor$(args, signal)`. This command alone gets
  `set(writeDb$)` and executes the guarded single-row UPDATE. The route owns
  publication after committed writes; it publishes only actual CAS winners.

The two old `Pick<Db, "selectDistinctOn">` / `Pick<Db, "update">` helper
interfaces are deleted and both actual callers migrated. There are no database,
accessor, node, signal or executor parameters/slots/callbacks in the new graph.
Factories are instantiated in request-derived computeds, not handler commands.
Private dependencies share lexical scope and memoized sources; no state is added.
The only ordinary shared helper builds a pure SQL predicate and executes no I/O.

## SQL, races and publication

For admitted, non-aborted requests, query counts are unchanged:

| Path                          | Reads                                            | Writes                                  |
| ----------------------------- | ------------------------------------------------ | --------------------------------------- |
| Single missing/unowned Thread | One owned-Thread query                           | None                                    |
| Single missing Agent          | Thread + Agent                                   | None                                    |
| Single valid Thread           | Thread + Agent + one DISTINCT ON watermark query | Zero or one CAS                         |
| Agent absent/cross-org        | One Agent query                                  | None                                    |
| Agent with no candidates      | Agent + candidate query; zero watermark queries  | None                                    |
| Agent with candidates         | Agent + candidates + one batched DISTINCT ON     | One CAS per eligible cursor, no retries |

Candidates retain the seven-day lookback, 128 limit and descending
`lastMessageAt` / `id` order. Watermarks retain only terminal event types,
`DISTINCT ON(threadId)` and `threadId, createdAt DESC, id DESC`, scoped to those
candidate IDs, not all Threads or the global newest event. Empty input starts
no watermark query. Schema columns retain null/Date decoding and encoders.

The CAS retains `id + userId + (lastReadAt IS NULL OR lastReadAt < watermark)`
and `RETURNING id`. Equal/newer cursors and lost races do not retry. Single
responses use the original pre-read cursor unless this request wins the CAS;
there is no post-race refresh. Active/started/newer-input events do not replace
terminal watermarks with the current clock.

Publication payload/status/header contracts remain unchanged. Agent marking
publishes exact winning IDs through 100 IDs, then Agent-scoped invalidation.
CAS statements commit independently; later failure/cancellation does not roll
back earlier advances, force publication, or add recovery coordination. Pure
computed reads capture no signal and may finish after caller cancellation;
handlers check cancellation after awaiting preparation, and the write command
checks before/after its non-signal DB await. No later mutation/publication is
started once cancellation is observed.

Transaction ledger: removed **0**, combined **0**, moved **0**, retained **0**
in this slice. The pre-existing nontransactional boundary is unchanged.

An offline AST-extracted builder comparison checks all seven new owning query
builders against the six old shared/route builders, including one/two-ID
watermarks. SQL, ordered/encoded bindings, selected field names/nullability and
schema-column encoder/decoder functions match. It executes no SQL and is
supplementary serialization evidence, not HTTP/database behavior acceptance.
No material plan shape, literal, index predicate or decoder changes require an
invented EXPLAIN/performance claim. Query counts and early exits are separately
source-reviewed, not asserted through internal query mocks.

## Public coverage and verification boundaries

Existing endpoint coverage is retained in `chat-thread-mark-agent-read.test.ts`,
`chat-thread-read-cursor.test.ts`, `chat-thread-indicators.test.ts`,
`chat-threads.bdd.test.ts` and `chat-files.bdd.test.ts`: unread/active indicators,
historical terminal event types, repeated marks, ownership/404s, lookback,
exact-ID versus Agent-scope notification budgets and newest terminal cursors.
Existing bulk fixture exceptions are not expanded or newly used for assertions.

Three added public scenarios fill specific gaps: competing single marks with
only one committed-cursor publication; actual cursor advancement without an
organization and with a different active org; and batch missing-org,
foreign-user, cross-org and unknown-Agent no-effect responses. Setup and cursor
assertions use production APIs; only auth/storage/provider/realtime boundaries
are mocked. Concurrent endpoint success does not force a particular SQL
interleaving or prove a deterministic losing CAS; the unchanged CAS predicate
and pre-read response semantics are also source-reviewed. No internal node,
service, DB-row or log assertions, locks, retry, timeout, hook or sleep is added.

No local Vitest or dev server is run. Affected formatting, ESLint, Oxlint and
type-aware Oxlint pass. Local repository Knip stopped with an Oxc parser
`RangeError: Array buffer allocation failed`; this is incomplete, not a pass,
and was not blindly rerun. Full type/static and all eight API shard acceptance
must come from normal new-head PR CI, recorded with the SHA in the PR body.
Independent review and merge remain separate permissions.

Explicit residual scope: other Thread read/mutation helpers and all broader
`chat-thread.service.ts` handle interfaces, Thread admission/launch, Pi and
callback bookkeeping remain outside E1. No whole-module completion is claimed.
