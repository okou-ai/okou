# Thread activity summaries

Activity summaries are available for every account. Accepted events feed a
bounded snapshot, and the visible main thread requests summary copy on demand.
The initial-thinking producer has been retired; no summary work starts solely
because a run was created.

## API contract

`POST /api/chat-threads/:id/activity-summary` accepts only `{ "runId": "<uuid>" }`.
It requires organization authentication and `chat-event:read`; ownership,
organization, thread association, and the thread's canonical admitted run are
checked on the server. Queued and terminal runs are ineligible. Commentary does
not end eligibility. Responses use `Cache-Control: no-store`.

The typed contract is `chatThreadActivitySummaryContract` in
`@okouai/api-contracts/contracts/chat-thread-activity-summary`.

| Field      | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `runId`    | Requested and verified run identity                                |
| `messages` | At most four plain-text lines of at most 60 grapheme clusters each |
| `status`   | `available`, `ineligible`, or `unavailable`                        |

`available` is the stored batch, which is empty while the first generation is
still pending. `ineligible` is an owned run that is queued, terminal, or not the
thread's admitted run. `unavailable` means the evidence expired.

Authentication/validation errors use the existing 400/401/403 error contract.
Missing, inaccessible, or mismatched thread/run identities receive 404
without cache exposure. An owned but ineligible run
receives 200 with `status: ineligible`, no messages, and no generation. A storage
failure is this service's own defect and reaches the caller as a plain 500
without exposing the snapshot.

Generation provenance is not published: the response includes no revision,
sequence, cursor, completion time, retry delay, raw tool arguments, or activity
entries.

## Storage and concurrency

`run_activity_snapshots` is disposable Postgres state with one row per run and a
cascading run foreign key. The accepted-event consumer is shared by guest
webhooks and Pi API-first delivery. It selects public message/tool/result fields;
private reasoning, images, heartbeats, usage-only records, and unsupported
variants are ignored. Existing runtime masking remains intact; structured
credential-shaped argument keys are additionally redacted.

- Retain at most 16 entries and 16 KiB of serialized activity, with 700-character
  excerpts. Keep sequence and block identity, discard oldest evidence first,
  and canonicalize object keys before hashing so JSONB ordering cannot create
  false revisions. Relevant late events can merge into the retained window.
- Bound every projected string by code points and drop the two code points
  PostgreSQL refuses inside a `jsonb` value: `U+0000` and unpaired surrogates.
  Both are reachable from real tool output, and either one would otherwise
  reject the whole snapshot write instead of the offending excerpt.
- Merge and claim under a short row-locking transaction with a 250 ms lock
  timeout and 3 second statement timeout. Provider I/O runs outside the
  transaction. Optional capture failures cannot reject accepted execution
  events or suppress normal message publication.
- Claims last 15 seconds, so a lease always outlives one whole attempt at the
  10-second provider deadline. The database clock enforces at least 15 seconds
  between attempts across API instances and tabs. A crashed owner's claim
  expires. Completion requires the exact claim ID and claimed revision, an
  unexpired lease/snapshot, and continued run eligibility.
- Load up to eight canonical visible user/assistant messages, including the
  current task, with 700-character excerpts. Queued messages enter the context
  after the runtime acknowledges delivery. Indicator copy is excluded.
- Reuse `FAST_PATH_MODEL` and `generateText`, a reasoning-inclusive 1024-token
  budget with low reasoning, and a 10-second provider deadline, all through the
  shared `generateAuxiliary` boundary that every other optional generation uses.
  No request means no new summarizer call. An unconfigured, rejected or failed
  generation keeps the last phrase or `null`; it never retries inside the request.
- Failed attempts use a fixed 60-second cooldown; HTTP `Retry-After` does not
  extend it. Expired or replaced claim owners cannot write results. An attempt
  whose request lifetime ended first — today the API instance stopping — charges
  no cooldown: its lease expires like any owner that stopped reporting, and the
  attempt interval written at claim time still bounds the next provider call.
- Relevant capture or visible messages retain evidence for at most 24 hours
  from activity; first observing an old message does not restart its retention. Expired evidence is never returned. An expiry index supports
  one cleanup batch of at most 500 rows with `FOR UPDATE SKIP LOCKED`, attached
  to existing sandbox maintenance.

## Production diagnostics

Summary generation itself reports nothing from this service: it runs through the
shared `generateAuxiliary` boundary, so every attempt is counted exactly once in
the shared `auxiliary_generation_result` Axiom event under
`feature: chat_activity_summary`, like every other auxiliary generation, and only
the outcomes that boundary classifies as failures produce a diagnostic. The
remaining records this feature writes are:

| Message                            | Context            | Level | Safe fields besides context        |
| ---------------------------------- | ------------------ | ----- | ---------------------------------- |
| `Activity snapshot capture failed` | `api:run-activity` | warn  | `runId`, `eventCount`, `errorCode` |
| `Activity snapshot cleanup failed` | `api:run-activity` | warn  | `errorCode`                        |

A contended capture (`55P03`) and a run deleted mid-flight (`23503`) are expected
consequences of concurrent delivery for one run and stay silent; any other
capture failure warns with the SQLSTATE class code alone — five characters,
validated before it is published, and omitted when the driver reports no
SQLSTATE. Successful captures and cleanups record nothing. Driver messages,
statement text, constraint details and bound parameters are never attached.

A skipped capture still drops that batch's evidence: the runner already holds
its `200`, and no redelivery or retry is attempted.

These records never contain prompts, phrases, messages, arguments, evidence,
credentials, database-driver errors, or provider response bodies. Production
verification remains controller-owned after release.

## Visible viewer lifecycle

The committed main-thread container owns summary demand through its local
callback-ref AbortSignal and page lifecycle. Sidebar panels and unmounted routes
do not request summaries. A visible viewer requests immediately for the
latest eligible live run from the canonical event fold; the API independently
verifies the admitted-run pointer and authorization. Subsequent requests use a
15-second interval. Each viewer serializes requests, including an aborted
transport still settling after a ref change.

Hiding, navigating away, unmounting, losing thread access, queuing,
ending or replacing a run cancels demand and rejects late responses. An
`ineligible`, 401, 403 or 404 response clears dynamic copy for that run identity.
An `unavailable`, malformed or failed response keeps the current run's last
usable batch, or the existing generic indicator when it never had one.

Identical text preserves the mounted typewriter; changed text restarts it even
after commentary or a completed animation. Run status remains the existing
programmatic projection. All dynamic copy stays in transient page state, outside
chat events, browser persistence, history and model context.

Normal sends do not schedule initial-thinking generation. Thread-title
generation and the main model are independent and remain unchanged.

## Deployment and compatibility

The existing migration created the disposable table and index without
backfilling historical rows. A new App against an older API without this
endpoint receives 404 and retains the generic indicator. Older Apps against a
new API also retain their generic indicator; new runs no longer generate
opening copy. Historical `thinking:initial` events remain readable as chat
history, but no new ones are written.
