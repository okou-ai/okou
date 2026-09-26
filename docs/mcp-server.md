# External MCP server

The Hono API exposes a Streamable HTTP resource server at `/mcp`. It uses the
official MCP SDK and serves `list_agents`, `list_models`, `create_chat_thread`,
`get_chat_indicators`, `list_chat_threads`, `get_chat_thread`,
`get_chat_messages`, `search_chat_messages`, `get_chat_status`, `send_chat_message`,
`revoke_queued_message`, `cancel_run` and `update_chat_thread`. The read tools query current
user/organization-owned conversations; mutations reuse the existing input queue
and run lifecycle. The OAuth
foundation shipped in #34931; discovery and current context are tracked by
#34932 under #34890. Message history is delivered in #34933 and search in
#35100; sending and cancellation are delivered in #34934, status in #35101,
and Agent/model discovery and empty conversation creation in #35102.
Atomic creation with an optional first message is delivered in #35540.
Successful results keep the complete machine-readable value in
`structuredContent` and include a tool-specific human summary of at most 512
UTF-8 bytes in text content; they do not duplicate the full JSON value as text.

## Timestamp contract

All MCP chat output timestamps are UTC RFC 3339 strings with exactly six
fractional-second digits, for example `2026-09-21T01:02:03.123000Z`. Time-filter
inputs continue to accept zero through six fractional-second digits. Each field
names one clock; callers must not substitute another timestamp from the same
response:

| Field               | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `createdAt`         | Conversation creation time.                                                                     |
| `acceptedAt`        | Server acceptance/persistence time for the submitted mutation or input.                         |
| `messageAt`         | Original accepted-input time for a visible user message, or output-event time for an assistant. |
| `sourceEventAt`     | Indexed source-event time used by search bounds, ordering and continuation.                     |
| `metadataUpdatedAt` | Conversation metadata-row update time; ordinary message activity does not advance it.           |
| `lastMessageAt`     | Conversation activity time used by thread bounds, ordering and continuation.                    |
| `observedAt`        | Completion time of a bounded status observation.                                                |
| `retryUntil`        | Absolute end of the relevant idempotent retry window.                                           |

Replacement processing can make `messageAt` and `sourceEventAt` differ for the
same visible message reference. Metadata edits can advance `metadataUpdatedAt`
without advancing `lastMessageAt`; later message activity can do the reverse.
No timestamp proves archive completeness, search-index freshness, message
delivery, or run completion; retain each tool's separate guarantees below.

## Tool errors and CLI exit status

MCP server-declared tool failures use `isError: true` and content for human
inspection; MCP does not require structured error metadata. Okou chat tools also
return the optional `structuredContent.error` extension with a stable `code`,
human-readable `message`, explicit `retryable` boolean, and optional bounded
validation `issues` containing field paths, issue codes and messages. Invalid
tool arguments use `invalid_arguments`; an idempotency key reused for a different
request uses `request_id_conflict`. A retryable value is metadata, not permission
to automatically replay a tool call.

For `okou mcp call`, a successful invocation exits `0`. A server result with
`isError: true`, a protocol failure, a transport failure, or an action-level
client failure exits nonzero. Successful `--json` output remains the raw MCP
result. Failed `--json` output uses `{status:"error", error:{kind,code,message,retryable}}`;
server-declared tool failures also preserve the complete raw MCP result under
`result`. When the optional Okou extension is absent or invalid, the CLI reports
`tool` / `tool_error` with a fixed generic message; it does not infer machine
fields from human text. Without `--json`, tool errors continue to print the
complete raw result for inspection before exiting nonzero. Commander syntax and
option-conflict errors occur before the action and retain the CLI's standard
error format.

The CLI never automatically retries a tool call. A timeout, connection failure,
or error result does not prove that a remote side effect did not happen; follow
the tool's documented idempotency and inspection guidance before retrying.

The catalog publishes `idempotentHint: false` for creation, metadata updates and
message sends because their request identities are retained for a bounded time,
not permanently. Each still supports an identical replay within 24 hours. After
a successful response, use its `retryUntil` as the deadline; after a lost
response, retry the identical request immediately within that documented window.
The positive hints on queued-input revocation and run cancellation instead
describe target-state mutations whose repeated calls do not recreate missing
work.

## Starting a conversation

Call `list_agents` and `list_models` before `create_chat_thread` when selecting
explicit values. Discovery requires `okou:chat:read`; creation additionally
requires `okou:chat:manage`. The optional first-message branch also requires
`okou:chat:send`. All calls retain the endpoint's organization/read-scope
requirements.

`list_agents` accepts optional `limit` (default 20, maximum 50) and `cursor`.
It lists public or caller-owned Agents in the authorized organization, with
`agentId`, name, a description bounded to 500 Unicode characters,
`descriptionTruncated`, and `isDefault`. Instructions and private configuration
are excluded. Pages use ascending Agent UUID order. Follow `nextCursor` with the
same limit; the 16 KiB response budget may shorten a page. Cursors bind the caller,
organization and page size, expire after 24 hours, and recheck current visibility
on each page. Restart without a cursor after an invalid or expired cursor.

`list_models` takes `{}` and reads persisted active model policies without
initializing or repairing them. Each model includes `id`, `name`, `selectable`,
`availability`, and an optional explanation in `reason`. Availability is
`available`, `reconnect_required`, `connection_required`, `plan_restricted`, or
`unavailable`. `selectable` describes whether canonical model selection accepts
the configuration; a selectable model can still require a connection or plan
change before execution. `available` is a metadata observation, not a credential
probe or admission guarantee. `defaultModel` chooses a valid member preference,
then the organization default, or returns null model/source. Provider account
identifiers, credentials and configuration are excluded. Missing policies or
defaults awaiting canonical repair after a plan change return a setup error.
Open model settings to synchronize the policies, then retry discovery. Discovery
reads enforce a 15-second deadline, three-second SQL limits and a 16 KiB data budget.

To create an empty conversation, only `requestId` is required:

```json
{
  "requestId": "<new UUID for this intended conversation>"
}
```

The response points `nextAction` to `send_chat_message`; no message is submitted
and no run starts. Sending later uses its own request ID and self-contained text.

To atomically create a conversation and accept its first input, add `message`.
All selection fields remain optional:

```json
{
  "requestId": "<new UUID for this intended conversation and input>",
  "message": "Summarize the risks and propose next steps."
}
```

In either mode, optional `agentId`, `title`, and `model` select explicit values.
An omitted Agent resolves to the currently visible organization default and is
stored concretely on the thread. An omitted title stays null until the first
text run triggers automatic title generation. An omitted model leaves the
thread without a stored selection until first run admission. That admission
resolves the current member default, then the organization default, and persists
the resolved model as the thread pin. Later default changes do not affect the
thread. The response exposes the selected/effective model and `source`. `message`
uses the same nonblank, 32,000 UTF-16-unit limit as `send_chat_message` and
preserves its exact accepted text.

The thread and canonical input event commit in one transaction. Only after that
commit does the shared scheduler attempt to start, queue, or steer execution.
The response therefore reports the durable `input` receipt and its current
`disposition`; it does not claim delivery or run success. Its `nextAction`
points to `get_chat_status` with only the complete stable `inputRef`. Use that handoff
and then `get_chat_messages` to observe output.

Both modes return `threadId` (the normalized `requestId`), the concrete Agent,
current title, selected/effective model, service tier, creation time in `createdAt`,
authenticated App URL, `replayed`, and `retryUntil`. Existing media/reasoning
defaults apply and service tier starts unset. Credentials, quota, and execution
policy are checked when the initial or later input is dispatched, as indicated
by `admission: "checked_on_send"`.

Retry an uncertain creation within 24 hours using the identical request ID,
operation mode, exact values, and optional-field presence. Combined retries keep
the same derived input reference. Concurrent identical requests converge on one
thread and, when present, one input. Switching between empty and combined modes,
changing a message, or changing omitted-versus-explicit Agent/title/model intent
is a conflict. Replay returns current stored thread settings without undoing
later edits. An originally omitted model follows current defaults only while the
thread remains unpinned before first run admission; after admission persists the
resolved model, replay reports that thread pin. Deleted conversations, expired
retries, or missing canonical evidence return an error while either half of the
retained identity remains. Thread events become eligible for snapshot-backed
pruning after seven days. If the thread remains after its creation event is
pruned, the missing evidence still conflicts; if the thread was also deleted,
the same old arguments can create new work because neither identity remains.
There is no permanent request-ID ledger. This complete lifecycle is why the
catalog does not mark creation as generally idempotent. Never automatically
retry an uncertain old request after the window; inspect the original thread
before intentionally creating new work. No new table or schema migration is
introduced.

Creation checks current Agent visibility and account-content admission in its
transaction, including the Agent owner's account. It uses the existing creation
event and publishes thread-list changes after commit. Once admitted, finite
mutation work retains server ownership if the HTTP client disconnects; the
client must use the same retry identity when the result was not received.

## Updating conversation metadata

`update_chat_thread` requires `okou:chat:manage` and accepts one explicit sparse
patch:

```json
{
  "requestId": "<new UUID for this intended update>",
  "threadId": "<owned conversation UUID>",
  "patch": {
    "title": "Quarterly plan review",
    "model": "<selectable model id, or null>"
  }
}
```

The patch must contain `title` and/or `model`. Omitted fields remain unchanged;
`model: null` clears the thread model pin until the next admitted run resolves
the current member or organization default and persists it as the new pin. Later
default changes do not affect the thread. A title is nonblank and at most 200
UTF-16 units. The patch never implicitly changes service tier, per-model
reasoning settings, image/video models, computer-use or browser settings. A
preserved setting that is incompatible with the requested model makes the whole
update fail.

Title and model validation, metadata changes and durable sidebar events commit in
one transaction. Failure leaves both fields and their events unchanged. A title
patch is a manual rename: it records rename precedence, so a title generation that
finishes later cannot overwrite it. A model patch changes only later run creation.
An existing run retains its run-scoped model, and a message steered into that run
continues with the existing model.

The result contains the current bounded title, selected/effective model and source,
current service tier, `metadataUpdatedAt`, authenticated App URL and retry metadata.
Generate one UUID `requestId` for each intended patch. Retry an uncertain response
with the identical request ID, thread ID, exact field presence and exact values
within 24 hours. Concurrent identical requests converge. Exact replay does not
reapply old intent: it returns current state, so retrying update A after update B
cannot restore A. Reusing the key with a different patch conflicts.

After the retry window, inspect `get_chat_thread` before making a new intended
change. Do not automatically retry an uncertain old request. Deduplication is not
promised beyond retained mutation identity. Thread mutation events become
eligible for snapshot-backed pruning after seven days; once those event IDs are
gone, reusing an old request ID is a new update and can restore its old patch.
The catalog therefore does not mark updates as generally idempotent. As with
other MCP mutations, admitted finite work remains server-owned after HTTP
disconnection, and thread-list invalidation is published only after a new
commit.

## Conversation discovery

`list_chat_threads` accepts these optional arguments:

| Argument          | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `agentId`         | Restrict to one Agent UUID.                                                                   |
| `title`           | Case-insensitive literal substring, up to 200 characters. `%` and `_` are literal characters. |
| `since`, `before` | ISO timestamps filtering last-message time: inclusive lower and exclusive upper bounds.       |
| `limit`           | Page size, default 20 and maximum 50.                                                         |
| `cursor`          | Continuation from `nextCursor`; keep the same filters.                                        |

For example, call `list_chat_threads` with `{"title":"release","limit":10}`,
then pass a result's `threadId` to `get_chat_thread` as
`{"threadId":"<thread UUID>"}`. Discovery returns `threads` and `nextCursor`;
detail returns `thread`.

Each thread includes its current title, Agent identity/name, selected and
effective model metadata, `createdAt`, `metadataUpdatedAt`, `lastMessageAt`
and authenticated App URL.
`since`, `before`, ordering and continuation use `lastMessageAt`, not the
metadata clock. Titles are bounded to 500 Unicode
characters, with an explicit truncation flag. Agent names retain their existing
256-character storage bound. Private drafts, Agent
instructions, message content and provider credentials are excluded.

Model metadata is a read-only view of current policy. A null `effectiveModel`
means no usable policy route was resolved; it does not invent a default or
repair stored settings. `admission: "checked_on_send"` means credentials, quota,
policy and other execution checks still apply when a future message is sent.
When the stored selection is null, `source` may temporarily report
`member_default` or `org_default`; the next run admission persists the resolved
model, and later reads report `source: "thread"`. The selected thread model does
not change an already-running execution.

Pagination orders by last-message time descending, then thread ID descending.
The opaque cursor preserves database timestamp precision, expires after 24
hours and is authenticated and bound to the user, selected organization and
filters. Invalid or expired cursors require restarting without a cursor.
Every page rechecks current ownership. This is live pagination: new activity
can move a thread ahead of the cursor, and edits/deletions can change matches.
Start a fresh traversal when a complete refreshed collection is required; the
cursor is not a global metadata snapshot or the App's pinned-sidebar order.

Filters run in SQL before the page limit. An owner/recency index supports
ordered reads, and read transactions enforce a three-second statement deadline.
Selective filters can still inspect many candidates; a deadline failure returns
a tool error, not a partial result. Retry or narrow the Agent/time filters.

Listing and reading never mark a thread read, change recency or reconcile model
settings.

## Activity and unread indicators

Call `get_chat_indicators` with `{}` to get the same `agents`, `threads` and
`unreadAt` response as `GET /api/indicators` for the authorized user and selected
organization. It uses the same visibility, recency, read-cursor and active-Run
rules as the App; it does not run a separate MCP unread query. A thread marked
`active` has a queued, pending or running Run, not proof of a successful result.
Use `get_chat_thread` to read metadata for an indicated thread, and
`get_chat_status` to inspect execution. Reading indicators does not mark any
thread read or change its lifecycle.

## Message history

`get_chat_messages` reconstructs the current canonical history from its verified
schema-7 gzip snapshot and PostgreSQL tail in one read-only repeatable-read
transaction. It checks thread ownership and the selected Agent organization
before accessing archive storage. Reading does not change read markers, recency,
run state or artifact visibility. It reuses the App's semantic visibility,
replacement/revocation and run-turn ordering rules. Output contains ordinary
visible user messages and assistant message events, including work the App may
collapse. Thinking, usage, bookkeeping and hidden `additional_info` are excluded.
Replaced user messages preserve the original submission time.

| Argument   | Meaning                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `threadId` | Required conversation UUID from discovery.                                                                                     |
| `runId`    | Optional filter to visible messages associated with this run.                                                                  |
| `around`   | Initial context anchor containing a genuine `eventId`, `seqId`, or both. Both must identify the same visible event.            |
| `limit`    | Maximum messages per page, default 20, maximum 50; byte limits can produce fewer.                                              |
| `cursor`   | An `olderCursor`, `newerCursor`, or message's `nextContentCursor`. Keep thread, run filter and limit unchanged; omit `around`. |

For example, begin with `{"threadId":"<thread UUID>","limit":20}`. The latest
page is returned in conversation order. Follow `olderCursor` to read earlier
messages. To inspect a message-search hit, use
`{"threadId":"<thread UUID>","around":{"seqId":123},"limit":10}`. In each hit,
`ref.seqId` is a sequence number; `ref.eventId` is its canonical event ID. A revoked, replaced, absent or
run-filtered anchor returns an explicit unavailable-reference error. Around
pages expose older and newer continuations where applicable.

Every message includes `ref: {threadId,eventId,seqId}`, `role`, `eventType`,
`messageAt`, nullable `runId`, visible `text`, `files` and the actual authenticated
conversation `url`. Files retain original `fileId`, filename and content type,
plus `annotatedFileId` when present. Assistant Markdown keeps its original
artifact links. Neither an event reference nor a file/artifact identifier grants
access; normal owner authorization still applies. No per-message URL or public
artifact copy is invented.

Messages can be segmented. A response segment contains at most 8,192 UTF-16 text
units without splitting a surrogate pair, eight file records and 64 KiB of
serialized message data. `textOffset` and `fileOffset` identify the segment's
starting positions; `textComplete` and `filesComplete` identify its completion.
Whenever either is false, follow `nextContentCursor` through the same tool and
concatenate text and files in offset order. Content continuation returns one
message segment and no history-page cursors; retain the original page's cursors
separately. A large attachment can occupy a segment on its own; its text resumes
from the unchanged text offset in later segments. Oversized indivisible metadata
fails explicitly. Complete structured responses are capped at 160 KiB, leaving
transport, human-readable summary and JSON-envelope headroom within a 512 KiB
tool result.

Signed cursors bind the user, selected organization, thread, run filter, page
size and operation, and expire 24 hours after the initial page. History cursors
fingerprint visible content and ordering: visible changes require restarting
without the cursor, optionally using a still-visible `around` reference.
Storage-only snapshot advancement and invisible bookkeeping preserve them.
Content cursors fingerprint only their target message, so unrelated appends do
not prevent finishing a long message. Changed or hidden targets require a fresh
read. All continuations recheck current authorization.

### Supported history limits

This initial reader reconstructs the complete supported history on **each**
request; it does not offer indexed random access. Limits are cumulative:

- 8 MiB compressed archive download.
- 32 MiB decoded archive plus conservatively measured PostgreSQL tail. Tail
  payload text sizes are checked in bounded metadata pages before bodies load.
- 50,000 canonical event rows, including hidden events.
- Three seconds per SQL statement and a 15-second caller-visible operation
  budget, including waiting for a database connection. Cancellation propagates
  to storage reads. PostgreSQL acquisition and transaction cleanup are not
  themselves abortable: if acquisition completes after cancellation, the
  transaction rolls back before reading history. An already-running statement
  finishes or reaches its bounded deadline before connection release.

Histories exceeding these limits return an explicit resource error, never an
apparently complete prefix. Lowering `limit` or adding `runId` does not avoid full
reconstruction and cannot make an oversized history fit. Missing/corrupt archive
storage returns an unavailable error, not an empty conversation. Repeated event
IDs in the combined archive and tail also return an unavailable error until the
canonical snapshot writer repairs the identities; reads never deduplicate or
rewrite them. Empty accessible threads return an empty successful page.
Invalid/expired cursors, changed views, unavailable references and inaccessible
threads have separate recovery messages.

Synthetic measurements on Node 24.21 used the actual bounded reader, semantic
projection and cursor generation with local PostgreSQL and simulated R2: 25,000
events, 30,749,912 decoded bytes, 7,804,275 compressed bytes, including one 2 MiB
message. Latest-page, older-page and content-continuation reads took 1,142 ms,
958 ms and 779 ms respectively. Process RSS was 650 MB before reads (including
Vitest and fixture generation), and 688/707/810 MB after those reads. This is
not an isolated per-request allocation measurement, a production distribution
sample, or an OAuth/network/concurrency benchmark. Byte caps bound source data,
not absolute process allocation. Larger supported histories would require
measured justification and a separate indexed/chunked history design.

## Message search

`search_chat_messages` finds indexed visible user and assistant text, including
retained messages whose live database events have been archived. It accepts:

| Argument              | Meaning                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `query`               | Required, trimmed, 1–200 UTF-16 units. Whole words are case-insensitive; CJK phrases are literal substrings. All groups must match. |
| `threadId`, `agentId` | Optional UUID filters.                                                                                                              |
| `role`                | Optional `user` or `assistant`.                                                                                                     |
| `since`, `before`     | UTC ISO timestamps, up to six fractional digits; inclusive lower/exclusive upper source-event bounds.                               |
| `limit`               | Default 20, maximum 50.                                                                                                             |
| `cursor`              | Follow `nextCursor` with the identical query, filters and limit.                                                                    |

For example, search with `{"query":"上海发布","limit":10}`. For each match,
pass `ref.threadId` as `threadId` and `{eventId: ref.eventId, seqId: ref.seqId}`
as `around` to `get_chat_messages`. Search returns a bounded excerpt, its UTF-16
offset and `hasBefore`/`hasAfter`, thread title/truncation, current Agent, role,
nullable run ID, `sourceEventAt`, authenticated conversation URL and the
real canonical `ref`. Excerpts contain at most 1,000 UTF-16 units and do not split
surrogate pairs. Use the message reader for complete text/files. This is lexical
text search, not semantic search or attachment-content indexing. Punctuation-only
queries and single-character CJK groups return a useful unsupported-query error.

The durable search projection supplies candidates, never final visibility.
Current owner, organization, Agent and request filters are checked before the
SQL limit. The bounded candidates are verified against canonical archive plus
tail history using the message reader's visibility rules and text fingerprints.
Revoked, replaced, hidden or changed candidates are skipped. A missing/corrupt
archive fails the whole call instead of returning a successful partial page.
Search does not advance read state, run work, update projections or repair data.

Order is indexed `sourceEventAt` descending, then thread UUID and sequence descending;
cursor ordering preserves the stored PostgreSQL microseconds. The live JavaScript
projector stores millisecond dates; historical SQL-produced rows may have finer
precision. Replacement-event timestamps
can differ from the original input-submission time displayed by the message
reader. Signed cursors bind the user, organization, query, every filter and page
size and expire 24 hours after the initial page. Every request reauthorizes.
Indexing is asynchronous and pages read live state, not a global snapshot. A
newly indexed match can fall ahead of an existing cursor; restart for refreshed
results. No total count, completeness, indexing-delay bound or global watermark
is promised. For recently sent content, read `get_chat_messages` using the known
thread ID; an empty search does not prove send failure or that a topic was never
discussed. References can become stale after a result is returned; the context
reader then reports the unavailable anchor.

A call processes at most 100 candidates and reads one additional metadata row to
detect continuation. `nextCursor` means more indexed candidates remain, not that
another visible match is guaranteed. Stale candidates consume scan budget; an
empty page can carry a cursor. `scanLimited: true` reports the candidate cap with
more candidates remaining. Follow the cursor until it is null. Byte-limited
pages never advance past an undelivered match.

Canonical validation shares a **single** 32 MiB decoded/database-tail,
50,000-event and 15-second budget across all encountered threads, with the
reader's 8 MiB compressed limit per archive and three-second SQL deadline.
Each distinct thread is reconstructed once per call. Index text fingerprints
are calculated only after the candidate limit, and bodies over 32 MiB are
rejected before hashing. Structured pages are capped at 160 KiB, leaving
transport, summary and JSON-envelope headroom within 512 KiB. Resource errors
recommend narrowing thread/Agent/time filters or retrying; reducing page size cannot make
one oversized history readable. These source-size caps are not absolute process
memory limits. Search reuses existing lexical indexes and adds no migration.

## Sending and cancellation

`send_chat_message` sends text to an existing conversation. It requires
`threadId`, nonblank `text` of at most 32,000 UTF-16 units, and a caller-generated
UUID `requestId`. Text is preserved exactly, including surrounding whitespace.
UUID letter case is normalized; uppercase and lowercase identifiers resolve to
the same submission. Withdrawal and run cancellation normalize their UUID
inputs in the same way before applying lifecycle locks or selecting an active
cancellation controller.
The 64 KiB HTTP request-body limit also applies. The server derives the Agent
from the authorized thread and uses its current model configuration and ordinary
admission checks. This tool does not accept Agent/model overrides, attachments,
or an explicit choice between a new run and steering an active run.

The existing scheduler can leave the input queued, associate it with a new run,
or reserve it for delivery to an active run. The response returns:

| Field                      | Meaning                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `inputRef`                 | Original durable `{threadId,eventId,seqId}` input reference; `eventId` equals `requestId`.                |
| `acceptedAt`, `retryUntil` | Input persistence time and the absolute end of its 24-hour retry window.                                  |
| `replayed`                 | Whether this request resolved a previously persisted matching submission.                                 |
| `disposition`              | Current bounded observation: `queued`, `reserved`, `associated`, `rejected`, `revoked`, or `unavailable`. |
| `runId`                    | Known associated/reserving run, or null.                                                                  |
| `url`                      | Authenticated conversation URL.                                                                           |
| `nextAction`               | Ready-to-use `get_chat_status` call containing the complete `inputRef`.                                   |

Acceptance means an input was persisted. It does not guarantee model admission,
delivery, compliance, completion, or a new run. `reserved` does not prove the
runner received the input, and `associated` does not prove successful execution.
A definitive admission failure after input persistence can leave its disposition
`rejected` or `revoked`. `unavailable` means retained live evidence cannot resolve
its current disposition; it does not mean the input was never accepted.
This call does not wait for the whole run. A later read can observe a newer state.

`inputRef` identifies the original submission for withdrawal and input
status reads. Queue dispatch or active-input delivery can append a replacement
event, so the currently visible message from `get_chat_messages` can have a
different reference. Do not assume the original input is a valid visible
`around` anchor after association. Use message-reader references for visible
history and retain the original `inputRef` separately.

For a retry after timeout or a lost response, use the **same requestId, threadId
and exact text within 24 hours of acceptance**. A matching authorized request
reuses the original input without submitting it again. Changed text, thread,
user or organization conflicts. The UUID shares the existing `clientEventId`
namespace: an equivalent authorized original text-only input can be reused
regardless of which client submitted it; an input with different structured
content conflicts. Refreshing an OAuth token does not change the retry identity.
To intentionally submit another message, generate a new request ID.

There is no deduplication guarantee after 24 hours. A retained original input
past that window is rejected as expired. Once its live event has been removed
by retention, its old request ID may be treated as a new submission. Inspect
the conversation before intentionally submitting new work after the window;
do not retry an uncertain old request automatically. The catalog therefore does
not mark sends as generally idempotent even though exact replay remains safe
before the returned `retryUntil`.

Retry protection covers input creation and dispatch. Ordinary send preparation
can reconcile obsolete model settings with current policy before a later
admission failure or concurrent identity conflict, as it does for first-party
sends. MCP does not accept explicit model or service-tier changes here.

Retry resolution reads the original immutable `chat_events` input, compares its
full canonical text-only user document and derives the receipt from its ID,
sequence and creation time. The existing 30-day live-event retention covers the
24-hour retry window. A locked recheck and the event's unique ID prevent
concurrent duplicate enqueue; losing writes roll back. No extra table,
fingerprint, permanent identity record or migration is added. Current thread
ownership is checked before resolving a receipt; deleting the thread ends the
retry contract. The OAuth configuration is unchanged.

### Input, execution and output status

Call `get_chat_status` with the complete original `inputRef` returned by send
(`threadId`, `eventId`, `seqId`) to observe only that input's associated or
reserved run. Execute the send or combined-creation `nextAction.arguments`
unchanged; do not repeat the thread identity outside the reference. To observe
the latest authorized run instead, call status with exactly `threadId`. Latest
selection uses creation time with run ID as a deterministic tie breaker. A
queued, revoked, missing or inaccessible exact-input association never falls
back to another run in the conversation.

The result exposes lifecycle as its complete public status model. Internal
input, delivery, run, cancellation-recovery and output observations are used to
derive it but are not returned:

| Field          | Meaning                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`    | Sole `{phase, outcome, output}` status result. Its strict union permits only documented combinations.                                                      |
| `messages`     | A `get_chat_messages` call with the selected thread/run and limit 20. Follow its page and content cursors for complete bodies and existing artifact links. |
| `wait`         | For positive `waitMs`, requested/effective wait, elapsed time, observation count, and the `ready`, `deadline`, or ordinary `status` outcome.               |
| `messagePage`  | First bounded `get_chat_messages`-compatible page when a positive wait observes ready output; otherwise null.                                              |
| `retryAfterMs` | Minimum suggested delay for another observation, or null when no automatic poll is suggested.                                                              |

Lifecycle does not expose or prove launch versus steer delivery, model
compliance, timestamps, cancellation-recovery details or internal output
reasons. Several inputs may share one run and its conversation output. Reads
never submit, revoke, cancel, change recency or mark a conversation read.

`lifecycle.phase` is `idle`, `queued`, `running`, `finalizing`, `settled`, or
`unavailable`. Its `outcome` is `completed`, `failed`, `timeout`,
`cancelled`, `rejected`, `revoked`, or null; `output` is `pending`, `partial`,
`ready`, `none`, or `unavailable`. Exact-input observation takes precedence:
missing or inaccessible input is unavailable, rejected and revoked
inputs are settled with no output, and queued or reserved inputs remain queued
without inheriting output from a shared run. With no selected run, the phase is
idle and output is none; this means no work was selected by that observation,
not that the conversation has no queued input in latest-thread mode.

For a selected run, queued and pending run states map to the queued phase, and
running maps to the running phase. A terminal run with pending or partial output
is finalizing while preserving its completed, failed, timeout, or cancelled
outcome. It becomes settled only when output is ready or confirmed absent
(`none`). Failure, timeout and cancellation remain visible even if output is
ready. Pending cancellation recovery also remains finalizing. This summary is a
current server observation, not proof of delivery mode, model compliance, or a
single immutable final answer.

Internally, actual visible assistant output plus the matching canonical
terminal marker is required for `ready`; unresolved cancellation recovery keeps
the lifecycle finalizing. Without messages, lifecycle output stays `pending`
until materialization completes and then becomes `none`. Missing associations
map to idle or the exact-input outcome above. Terminal error/control markers
are not fabricated as messages. Read `lifecycle.outcome` to distinguish
success, failure, timeout and cancellation.

`ready` describes the current materialized view, not an immutable final answer:
late output can still arrive. Internally, cancellation recovery can be pending,
complete or not applicable; a stale recovery barrier does not count as complete
merely because the scheduler permits another run. Those details are not exposed
in the public status response.

Status uses the same verified archive plus live tail as message history, with
run/receipt metadata inside that reader's repeatable-read, read-only snapshot.
`observedAt` records completion of that bounded observation; concurrent later
changes appear on the next call. Every call reconstructs the supported history
and inherits the limits above, including three-second SQL statements and a
15-second overall budget. Disconnect cancels the read only.
Status data is capped at 16 KiB, leaving transport, summary and JSON-envelope
headroom below 64 KiB. Oversized historical reference metadata fails
explicitly instead of truncating identities. Poll no faster
than `retryAfterMs` (currently 2 seconds), use increasing delays when unchanged,
and stop automatic polling when it is null or the tool returns a resource
error. A queued input with no run has `lifecycle.output: "pending"` plus a
non-null retry delay: continue tracking that original input instead of
submitting it again.

Set `waitMs` only with the complete exact `inputRef`. Omission or zero keeps the
exact-input observation immediate; latest-thread `{threadId}` status is always
immediate. A positive value is a client preference up
to 60 seconds and is currently clamped to an 8-second server dwell after the
initial observation. Each fresh observation keeps its independent 15-second
history budget, so total request time also includes the initial and final
bounded reads. The waiter follows `retryAfterMs`, completes at most five
canonical observations, and never holds a transaction, connection, snapshot or
authorization decision between them.

`wait.outcome` is `ready` only at the same materialized-output condition used by
ordinary status. `deadline` returns the last fresh retryable state after the
effective dwell; `status` returns a non-retryable state or a capacity fallback.
Inspect `returnReason` to distinguish those cases. Deadline, capacity and the
observation limit are successful reads, not run completion or tool failure.
Ready wait responses include `messagePage`, a first limit-20 page made from the
same final authorized history snapshot. Its signed page/content cursors,
segmentation and artifact authorization are identical to `get_chat_messages`.
The combined status and page data is capped at 192 KiB; follow the existing
handoff/cursors for more content.

At most two active waits per principal and 32 per API runtime are admitted after
the initial retryable observation. Capacity exhaustion returns current status
immediately. Cancellation or disconnect releases the abortable timer and slot
and stops only this read; it never cancels or revokes accepted work. These are
runtime resource limits, not a deployment-global lease. MCP Tasks remains the
longer-term negotiated protocol for durable work; bounded status wait is the
compatibility optimization for current clients.

Each positive wait also adds an identifier-free `mcp.chat_status.wait` event to
the request trace. It records requested/effective/elapsed milliseconds,
observations, outcome and return reason, principal/runtime occupancy and
capacity, final input/run/output state categories, and whether content was
included. Use these fields to validate live timeout margin and capacity before
raising the server dwell limit.

Original input lookup lasts while the exact canonical input and linkage remain
in readable retained thread history. It continues through archives after the
30-day live-event window, within the stated history limits; it is not a new
permanent identity store. Deleted/mismatched/absent references return
`lifecycle.phase: "unavailable"`; corrupt, missing or oversized required
archives fail the tool explicitly. Historical launch/steer provenance is not
part of the status response. None of this extends the independent 24-hour send
retry guarantee. References and artifact links retain their existing
user/org/thread authorization and grant no new access.

Combined native Codex acceptance in #34936 should exercise send returning a
null run ID → status by inputRef → queued/associated execution → partial/ready
output → `get_chat_messages`, then repeat with an active steer, queued revoke
and cancellation recovery. Also verify that a missing reference does not show
an unrelated latest run. ChatGPT acceptance remains deferred.

`revoke_queued_message` takes the complete original `inputRef` unchanged. It
validates `threadId`, `eventId`, and `seqId` under the canonical queue lock
before mutation and returns that reference, a nullable `runId`, and
`outcome`: `revoked`, `already_revoked`, `not_revocable`, or `unavailable`.
Withdrawal uses the canonical queue lock and appends a revocation event; it
does not delete history or cancel a run. Only a pending, unreserved input can be
withdrawn. If reservation or association wins the race, the result is
`not_revocable` with reason `reserved_or_associated`; this is not delivery
confirmation. Other nonqueued inputs use reason `not_queued`. An inaccessible
thread or unavailable input returns `unavailable`. Repeated withdrawal of a
retained revoked input returns `already_revoked`.

`cancel_run` takes `runId` and returns `{runId,status:"cancelled",alreadyCancelled}`.
It cancels the whole authorized user's run in the selected organization through
the existing cooperative cancellation path. Already-cancelled runs succeed
idempotently and can redrive retry-safe recovery effects. Other terminal runs
return a tool error. The response confirms canonical cancellation, not that the
executor has physically stopped or that callback/queue recovery has finished.
Cancelling a run can allow queued input to proceed; use `revoke_queued_message`
to withdraw a specific input that has not been reserved or associated.

Both target-state tools retain `idempotentHint: true`: repeating revocation or
cancellation converges on the retained target state, and an unavailable target
is not recreated by either operation.

After a mutation is admitted, its finite business operation and cancellation
effects are tracked independently of the HTTP response. Disconnecting stops
waiting for a response; it does not undo accepted input or cancel a business run.
Use the same send identity to recover an ambiguous outcome.

## Configuration and authorization

Metadata is public; discovery and tool calls require authorization.

Configure these optional API environment variables to enable the MCP surface:

| Variable           | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `MCP_RESOURCE_URL` | Exact HTTPS resource identifier ending in `/mcp`, including the deployment's real origin. |
| `MCP_OAUTH_ISSUER` | Exact trusted HTTPS Clerk OAuth issuer for that deployment.                               |

Missing resource/issuer configuration makes the MCP surface return 503 and does
not change first-party API authentication. Resource and issuer are never derived
from the request Host or an unverified token. Configure the deployed environment
through its normal deployment process; this code does not configure Clerk or
activate production.

The shared `.github/actions/web-api-env` deployment action injects these values
only into the API service. It builds `MCP_RESOURCE_URL` from the trusted
`api-backend-url` deployment input (the API origin, with an optional trailing
slash), followed by `/mcp`. Preview workflows supply each PR/staging API alias;
production supplies its configured API origin. Do not set a shared
`MCP_RESOURCE_URL` repository variable: it is not read, and each deployment must
use its own audience. API deployments require `api-backend-url`; if it is empty,
the action fails before creating an environment file. Web deployments may omit it.

Set the non-secret `MCP_OAUTH_ISSUER` GitHub repository variable to the test Clerk
instance's exact OAuth issuer. Override the same variable in the `production`
GitHub Environment with `https://clerk.okou.ai`, matching that environment's
Clerk credentials. Without an issuer, MCP returns 503 while the existing API
remains available.
These deployment variables do not configure OAuth settings in either Clerk
instance.

The resource server accepts only `Authorization: Bearer` OAuth access JWTs signed
by the configured Clerk instance. It requires an access-token header type
(`at+jwt` or `application/at+jwt`), exact issuer, the configured resource in `aud`,
unexpired `exp`, a user `sub`, selected `org_id`, `client_id`, and scopes from
`scope` or `scp`. If both scope claims are present they must agree. Session/ID
tokens, API/PAT tokens, machine subjects and opaque access tokens are not accepted.
The existing first-party token parser is unchanged.

The signed organization is the organization selected at consent. Every request
checks current membership using the existing membership service; positive cached
membership can remain valid for up to 60 seconds. A removed member is rejected;
a Clerk/key-service outage returns 503 rather than pretending the user is invalid.
Local JWT verification does not provide immediate provider token revocation:
an already issued token can remain usable until expiry, subject to membership
checks. Short token lifetimes and the provider's actual revoke/refresh
behavior must be verified before rollout.

Initial and invalid-token `401` challenges request the complete default grant:

```text
openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access
```

Protected-resource metadata advertises the same nine scopes for clients that
select scopes through discovery. The defaults include identity information,
organization selection, chat operations and refresh-token access, so
clients can request them in one consent flow without relying on incremental
authorization support.

The endpoint and all read tools require `user:org:read` and `okou:chat:read`.
Tokens with just these two scopes remain valid for reads.
A `403 insufficient_scope` challenge names those required scopes.
Mutation permissions are checked on every tool invocation:

| Tool                                  | Additional required scope                                           |
| ------------------------------------- | ------------------------------------------------------------------- |
| `create_chat_thread`                  | `okou:chat:manage`; plus `okou:chat:send` when `message` is present |
| `send_chat_message`                   | `okou:chat:send`                                                    |
| `revoke_queued_message`, `cancel_run` | `okou:run:cancel`                                                   |

`create_chat_thread` is advertised when manage scope is present so the empty
mode remains discoverable; its message branch independently checks send scope
at invocation. Other mutation tools requiring a missing scope are not
advertised. Direct invocation without the applicable scope is rejected and
performs no operation.
Title/model editing is delivered separately. A tool argument cannot select or override
the organization. Existing grants do not automatically gain scopes; clients must
reauthorize to obtain additional permissions.

## Provider setup gate

Clerk is the authorization server; this API does not implement authorization,
token exchange, client registration or a consent UI. Before hosted acceptance:

1. In **OAuth applications → Settings**, enable **Publish CIMD support**, disable
   **Publish DCR support**, and select **Any compatible CIMD client**. Use JWT
   access tokens with **Include Audience**, require PKCE S256, and configure the
   supported scopes. Under **Client onboarding → Default scopes for dynamic
   clients**, set the same nine default scopes listed above. Clerk applies these
   defaults when a client omits `scope`; it does not expand an explicitly requested
   scope set. Creating or advertising scopes alone does not set these defaults.
   Compatible clients identify themselves through their HTTPS metadata document;
   no manual OAuth application or callback registration is
   required for each client. Verify that issuer metadata advertises CIMD and
   omits the DCR registration endpoint.
2. Configure organization selection during consent and the provider's organization
   permission (`user:org:read` where required). Obtain a real grant and establish
   that its signed access JWT includes the selected `org_id`, resource `aud`,
   `client_id` and intended custom scopes. An ordinary Clerk session JWT is not
   a substitute. If the provider cannot issue this contract, keep the MCP surface
   unconfigured and resolve the authorization design before rollout.
3. Verify reauthorization into a different organization, token refresh, expiry,
   revoked grants and membership removal using that actual application.

Synthetic signed-token tests prove verification and isolation, not provider-side
consent or token issuance. Do not treat their success as completing this gate.

### Login and consent return

Host Clerk's prebuilt `<OAuthConsent />` on the App's `/oauth-consent` route.
The component keeps Clerk's consent metadata, organization selection, scope
rendering, allow/deny submission and redirect validation while avoiding the
Account Portal's separately challenged static assets. The App accepts only its
own exact HTTPS `/oauth-consent` URL as a completed-session consent continuation;
client callback URLs are not App login destinations. The original consent query
survives login, registration and switching between them. A fully active session
on a root auth route continues through `clerk.redirectWithAuth()`. Pending
session tasks, factor routes and explicit authentication or account-selection
intents remain with Clerk's forms.

In the development Clerk Dashboard **Paths**, point sign-in and sign-up to the
local App (`https://app.vm7.ai:8443/sign-in` and
`https://app.vm7.ai:8443/sign-up`) and set **OAuth consent** to
`/oauth-consent`; Clerk resolves that path on the configured local development
host. The Marketing service does not host these pages. Production uses
`https://app.okou.ai/sign-in`, `https://app.okou.ai/sign-up` and
`https://app.okou.ai/oauth-consent`. Deploy the App route before changing either
Clerk instance's path, then verify one allow and one deny flow in that environment.
No additional App environment variable is required.

## HTTP behavior

Clients start with `/.well-known/oauth-protected-resource/mcp`, or follow the
`resource_metadata` URL in a 401 `WWW-Authenticate: Bearer` challenge. The metadata
publishes the resource and authorization server. A valid token without the read
scope receives 403 `insufficient_scope`. Authenticated responses use
`Cache-Control: no-store`.

The SDK handles JSON-RPC discovery (`tools/list`), invocation (`tools/call`),
initialization and protocol errors. 2025 protocol traffic uses stateless Streamable
HTTP with SSE responses. The 2026-07-28 protocol uses the SDK's envelope and
`MCP-Method`/`MCP-Name` headers with automatic JSON/SSE response selection. Clients
should use a conforming SDK instead of implementing these envelopes themselves.

The 12 advertised tools each include a human-readable `annotations.title`. Their
input and output JSON Schemas inline local references, so the advertised schemas
contain no `$ref` or `$defs`; field types and validation constraints are unchanged.

No persistent MCP session, standalone event feed, subscription, or resumability
is offered; stateless GET/DELETE requests return 405. POST bodies are limited to
64 KiB. Transport/request cancellation stops reads or waiting for an admitted
mutation response; it never acts as business-run cancellation.

Browser Origins must exactly match the fixed allowlist in
[`mcp-server-config.ts`](../turbo/apps/api/src/lib/mcp-server-config.ts). The list
starts empty; add exact HTTPS origins in code when a browser client needs access.
There is no environment variable for this list. Unlisted Origins, including `null`
and empty values, are rejected before authentication, including preflight requests.
Native clients without an Origin work. For listed origins, preflight allows
bearer/protocol headers and responses expose the authentication
challenge and protocol headers. Cookie credentials are not used. Protected-resource
metadata supports public cross-origin discovery.

## Acceptance evidence

Automated route tests use real Hono routing, SDK transport, RSA signature checks,
and the membership service. Only external provider/network
boundaries are simulated. They cover both protocol eras, complete response
consumption, invalid grants, scope/membership isolation, Origin checks and
provider outages.

Before enabling broader access, record a generic MCP client/Inspector check
against a real hosted preview or staging endpoint, including complete JSON and
SSE response delivery. Then record basic OAuth, discovery and current-tool
workflow results for Claude, ChatGPT, Claude Code and Codex, with client
version/account conditions. Local HTTP tests do not establish hosted-client
reachability. OAuth foundation and discovery shipped separately in #34931 and
#34932. The client matrix for the full tool set remains #34936; the new
message-reader tests do not establish that broader hosted acceptance.
