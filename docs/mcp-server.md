# External MCP server

The Hono API exposes the official MCP SDK's stateless Streamable HTTP resource
server at `/mcp`. MCP is identity/parameter adaptation to ordinary Web chat
commands and simple result serialization, not a second execution product.
OAuth, scopes, current organization membership, tenant and conversation ownership
remain required. Successful results return machine-readable `structuredContent`
and a human summary of at most 512 UTF-8 bytes; JSON is not duplicated as text.

## Breaking protocol simplification (#37513)

There is no `create_chat_thread` tool. `send_chat_message` takes `agentId`,
`prompt`, optional `threadId` and optional `model`, just like ordinary Web text
sending. Omit `threadId` to create a conversation; provide it to continue an
owned conversation belonging to that Agent. Discovery through `list_agents` and
`list_models` helps select values; it never authorizes execution.

```json
{
  "agentId": "<Agent UUID>",
  "prompt": "Summarize the risks and propose next steps."
}
```

```json
{
  "agentId": "<Agent UUID>",
  "threadId": "<conversation UUID>",
  "prompt": "Continue with a plan."
}
```

The same `sendNormalEvent$` command as Web performs auth, model selection, queue
acceptance and dispatch. MCP supplies a fresh internal `clientEventId` and returns
`{threadId, eventId, createdAt}` only after acceptance. `eventId` is the original
persisted input identity, not a replacement row ID or a Run. This is an explicitly
breaking MCP tool contract (#37750); Web/CLI responses are unchanged.

Follow that exact input with `get_chat_input({threadId,eventId})`. It reports
original acceptance time, `inputStatus`, nullable safe `error`, and a separate
nullable native `run: {runId,status}` observation:

| Input state | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `queued`    | Accepted input has not been consumed, rejected or recalled; no Run.         |
| `consumed`  | A canonical replacement binds the input to a new or existing Run.           |
| `rejected`  | Execution admission rejected the input; no Run and safe rejection metadata. |
| `recalled`  | Recall won; metadata remains readable without resurrecting prompt content.  |

A consumed input remains consumed when its Run finishes, fails, times out or is
cancelled. Several inputs can share a Run; this does not promise an independent
answer for each input. Known credit/plan rejection markers get safe reasons;
unrecognized stored admission detail is not returned verbatim. Unknown,
unauthorized, replacement, control, output and hidden automation IDs are not
valid original-input selectors. Unreadable history or an unavailable consuming
Run is an explicit error, never a fabricated queued result.

Use `get_run_status({runId})` for the ordinary Web Run response. It replaces the
old Run-only tool name directly, without an alias, and does not wait or derive
another lifecycle, outcome or output-readiness state. Sending enqueues input;
it does not prove launch, completion, delivery or readable output. No public MCP
Events subscription/webhook or durable replay is introduced by this contract.

MCP no longer accepts `requestId`, `inputRef`, `waitMs` or the old `text` input.
It returns no receipt, disposition, replay flag, retry deadline, waiter admission,
observation count or `nextAction` chain. There is no 24-hour exact replay contract,
combined derived UUID, old-protocol fallback or dual send path. Each new send is
new intended work. **Never automatically retry an uncertain send.** A failed or
lost response can follow a committed operation; inspect the conversation before
intentionally sending new work. Web client-event identities and historical
persisted source decoding are unchanged. Verified MCP source annotations remain
ordinary message provenance, not replay evidence.

`update_chat_thread` takes `{threadId, patch:{title?, model?}}` and uses the same
metadata command as Web without an MCP mutation identity. Omitted fields stay
unchanged; `model:null` clears the pin. Changes do not reroute queued inputs or
an active Run. Read `get_chat_thread` after an uncertain update. Its result
contains current metadata, `selectedModel`, `metadataUpdatedAt` and the App URL.

`revoke_queued_message` takes `{agentId, threadId, eventId}` using the original
input ID. It resolves the current physical target, calls the ordinary Web recall
command with its Agent/thread authorization and atomic revoke edge, and checks
canonical recall before acknowledging `{threadId,eventId,createdAt}`. The time
is the recorded recall time, not original acceptance time. Live insufficient-credit
rejections are recallable just like Web. Repeated recalls preserve the original
identity; consumed and other rejected inputs are refused without cancelling a Run.
Retained inputs can remain readable after their live rows disappear without being
recallable; an unrecorded recall returns an explicit reference error rather than
accepting Web's historical missing-target success. Recall performs up to two
separately bounded canonical history reads. It does not cancel a Run. `cancel_run` takes `{runId}` and uses Web's
cooperative cancellation command and side effects. Cancellation neither undoes
past effects nor recalls unrelated queued inputs; worker cleanup can finish
later. Completed/failed Runs cannot be cancelled.

## Errors and timestamps

Invalid arguments return `isError:true` with `structuredContent.error` containing
`code`, `message`, `retryable` and optional bounded validation issues. Business
rejections preserve the common command's error; uncertain mutation failures are
not automatically retryable. `retryable` on a read is metadata, not authorization
for a new send. The CLI exits nonzero on tool, transport or protocol errors and
never automatically retries a call.

Send and Run timestamps use their ordinary Web response formats. MCP thread,
message, search and metadata projection timestamps remain UTC RFC 3339 with six
fractional digits. Message filters accept zero through six digits. `messageAt`
is original accepted-input time for users and output-event time for assistants;
`sourceEventAt` is search ordering time, `lastMessageAt` conversation activity,
and `metadataUpdatedAt` metadata change. These clocks are not interchangeable
and none proves delivery, index/archive completeness or Run success.

`list_models` adapts the ordinary Web model catalog (Auto, with a `null` id,
plus the caller's personal subscription routes) and the current member
preference; without a preference the default is Auto (`null`, `org_default`). It does not maintain a second route/admission implementation;
`selectable` and `availability` remain observations, and actual permission,
credentials, money and quota are checked on send. The read does not cause
MCP-specific repair writes.

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
A null stored selection is Auto: `source` reports `org_default` and
`effectiveModel` is null because Auto resolves its run model on send. Pass
`model: null` to `send_chat_message` or `update_chat_thread` to select Auto.
Enqueue captures the run model for the input without
rewriting the thread selection. A model selected after enqueue does not change
that input or an already-running execution.

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
`get_run_status` to inspect execution. Reading indicators does not mark any
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
Replaced user messages preserve the original submission time and original
`ref.eventId`; assistant outputs keep their own immutable output-event IDs.
`ref.seqId` is the current visible physical revision/order coordinate, not the
input identity. `get_chat_input` uses the same archive-plus-tail reader and
supported history limits, but also reads recalled metadata before visibility
filtering. It does not return prompt content.

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
`ref.seqId` is a sequence number; `ref.eventId` is the original input ID for user
messages or the output ID for assistants. An event-ID-only input anchor follows
its current visible replacement. Supplying both coordinates requires the current
sequence revision; hidden, absent, stale-sequence or run-filtered anchors return
an explicit unavailable-reference error. Around
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
is promised. For recently sent content, read `get_chat_messages` with the accepted `threadId`
and `around:{eventId}`; use `get_chat_input` for exact input-to-Run association.
An empty search does not prove send failure or that a topic was never discussed. References can become stale after a result is returned; the context
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

| Tool                                  | Additional required scope |
| ------------------------------------- | ------------------------- |
| `update_chat_thread`                  | `okou:chat:manage`        |
| `send_chat_message`                   | `okou:chat:send`          |
| `revoke_queued_message`, `cancel_run` | `okou:run:cancel`         |

Mutation tools requiring a missing scope are not advertised. Direct invocation
without the applicable scope is rejected and performs no operation. A tool
argument cannot select or override the organization. Existing grants do not automatically gain scopes; clients must
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
contain no `$ref` or `$defs`; field types and validation constraints match their current contracts.

No persistent MCP session, standalone event feed, subscription, or resumability
is offered; stateless GET/DELETE requests return 405. POST bodies are limited to
64 KiB. Transport/request cancellation stops request-owned work; it never acts as
business-run cancellation. A mutation may already have committed before a
disconnect, so an uncertain send must not be automatically retried.

Browser Origins must exactly match the fixed allowlist in
[`mcp-server-config.ts`](../turbo/apps/api/src/lib/mcp-server-config.ts). The list
starts empty; add exact HTTPS origins in code when a browser client needs access.
There is no environment variable for this list. Unlisted Origins, including `null`
and empty values, are rejected before authentication, including preflight requests.
Native clients without an Origin work. For listed origins, preflight allows
bearer/protocol headers and responses expose the authentication
challenge and protocol headers. Cookie credentials are not used. Protected-resource
metadata supports public cross-origin discovery.

## Acceptance boundary

Route tests retain token/membership/transport isolation and canonical history,
search, pagination, byte limits and archive integrity coverage. New public-boundary
tests cover SDK registration without creation, ordinary create/continue sends,
strict removal of protocol fields, sparse metadata and ordinary Run reads.
Synthetic signed tokens do not prove real Clerk consent/issuance/refresh or
production activation. Those require the provider setup gate above.

History SQL owns one short repeatable-read transaction for authorized snapshot
pointer, byte preflight and tail consistency; archive S3 reads occur after that
transaction commits. Agent/thread/candidate reads retain short read-only
transactions only to scope their existing three-second `SET LOCAL` deadline.
No mutation-specific transaction, lock, retry or coordination protocol is added.
