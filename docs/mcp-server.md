# External MCP server

The Hono API exposes a Streamable HTTP resource server at `/mcp`. It uses the
official MCP SDK and serves `list_chat_threads`, `get_chat_thread` and
`get_chat_messages`. These
read-only tools query current user/organization-owned conversations. The OAuth
foundation shipped in #34931; discovery and current context are tracked by
#34932 under #34890. Message history is delivered in #34933; message search and
mutations are separate slices. Results include both structured content and a
JSON text representation.

## Conversation discovery

`list_chat_threads` accepts these optional arguments:

| Argument          | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `agentId`         | Restrict to one Agent UUID.                                                                   |
| `title`           | Case-insensitive literal substring, up to 200 characters. `%` and `_` are literal characters. |
| `since`, `before` | ISO timestamps filtering last-message time: inclusive lower and exclusive upper bounds.       |
| `activity`        | `active` or `idle`, using the canonical queued/pending/running projection.                    |
| `unread`          | Filter the canonical retained-watermark unread state.                                         |
| `limit`           | Page size, default 20 and maximum 50.                                                         |
| `cursor`          | Continuation from `nextCursor`; keep the same filters.                                        |

For example, call `list_chat_threads` with `{"title":"release","limit":10}`,
then pass a result's `threadId` to `get_chat_thread` as
`{"threadId":"<thread UUID>"}`. Discovery returns `threads`, `nextCursor` and
`unreadCoverage`; detail returns `thread` and `unreadCoverage`.

Each thread includes its current title, Agent identity/name, selected and
effective model metadata, timestamps, authenticated App URL, queued/pending/
running activity flags and unread state. Titles are bounded to 500 Unicode
characters, with an explicit truncation flag. Agent names retain their existing
256-character storage bound. Private drafts, Agent
instructions, message content and provider credentials are excluded.

Model metadata is a read-only view of current policy. A null `effectiveModel`
means no usable policy route was resolved; it does not invent a default or
repair stored settings. `admission: "checked_on_send"` means credentials, quota,
policy and other execution checks still apply when a future message is sent.
The selected thread model does not change an already-running execution.

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

`unreadCoverage` is `retained_terminal_events_and_native_deliveries`. It combines
retained run terminal events with durable native Morning Brief deliveries,
compares the latest watermark to the user's read cursor, and suppresses unread
while a queued/pending/running run with a trigger source exists. It has no sparse
50-thread/seven-day cap, but terminal-event retention means it is not an
archive-complete unread history. Missing activity does not prove a run succeeded;
`unread: false` does not prove every historical result was read.

Listing and reading never mark a thread read, change recency or reconcile model
settings. The MCP catalog replaces `get_indicators` with these two tools; the
first-party indicators API and its existing sparse semantics remain unchanged.

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
messages. To inspect a future message-search hit, use
`{"threadId":"<thread UUID>","around":{"seqId":123},"limit":10}`. A search
position is a sequence number, not an event UUID. A revoked, replaced, absent or
run-filtered anchor returns an explicit unavailable-reference error. Around
pages expose older and newer continuations where applicable.

Every message includes `ref: {threadId,eventId,seqId}`, `role`, `eventType`,
`createdAt`, nullable `runId`, visible `text`, `files` and the actual authenticated
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
fails explicitly. Complete structured responses are capped at 160 KiB,
reserving space for the SDK's duplicate text representation and JSON escaping
within a 512 KiB tool result.

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

## Configuration and authorization

The `McpServer` feature switch defaults to off. Standard per-user/per-organization
overrides apply to the verified OAuth principal. Metadata is public; discovery and
tool calls require authorization and the feature override.

Configure these optional API environment variables before enabling an account:

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
These deployment variables do not enable the `McpServer` feature switch or
configure OAuth settings in either Clerk instance.

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
an already issued token can remain usable until expiry, subject to membership and
feature checks. Short token lifetimes and the provider's actual revoke/refresh
behavior must be verified before rollout.

Initial and invalid-token `401` challenges request the complete default grant:

```text
openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access
```

Protected-resource metadata advertises the same nine scopes for clients that
select scopes through discovery. The defaults include identity information,
organization selection, the planned chat operations and refresh-token access, so
clients can request them in one consent flow without relying on incremental
authorization support.

Only `user:org:read` and `okou:chat:read` are required for the current endpoint and
all three conversation read tools. Tokens with just these two scopes remain valid. A
`403 insufficient_scope` challenge names those required scopes. Each future tool
must enforce its own permissions; listing a scope does not
implement or authorize that operation. A tool argument cannot select or override
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
   a substitute. If the provider cannot issue this contract, keep the feature off
   and resolve the authorization design before rollout.
3. Verify reauthorization into a different organization, token refresh, expiry,
   revoked grants and membership removal using that actual application.

Synthetic signed-token tests prove verification and isolation, not provider-side
consent or token issuance. Do not treat their success as completing this gate.

### Login and consent return

Keep Clerk's default Account Portal OAuth consent page. The App derives its
trusted Account Portal origin from the active Clerk publishable key and preserves
only that instance's HTTPS `/oauth-consent` return. This origin is shared with
Clerk's redirect validation; client callback URLs are not App login destinations.
The original consent query survives login, registration and switching between
them. A fully active session on a root auth route continues through
`clerk.redirectWithAuth()`, which carries development browser authentication
across origins. Pending session tasks, factor routes and explicit authentication
or account-selection intents remain with Clerk's forms. Consent and organization
selection still happen on Clerk's hosted page.

In the development Clerk Dashboard **Paths**, point sign-in and sign-up to the
local App (`https://app.vm7.ai:8443/sign-in` and
`https://app.vm7.ai:8443/sign-up`). The Marketing service does not host these
pages. Keep OAuth consent on the default Account Portal. Production uses
`https://app.okou.ai/sign-in`, `https://app.okou.ai/sign-up` and
`https://accounts.okou.ai/oauth-consent`. No additional App environment variable
is needed for the default hosted consent page.

## HTTP behavior

Clients start with `/.well-known/oauth-protected-resource/mcp`, or follow the
`resource_metadata` URL in a 401 `WWW-Authenticate: Bearer` challenge. The metadata
publishes the resource and authorization server. A valid token without the read
scope receives 403 `insufficient_scope`; a disabled account receives 403
`access_denied`. Authenticated responses use `Cache-Control: no-store`.

The SDK handles JSON-RPC discovery (`tools/list`), invocation (`tools/call`),
initialization and protocol errors. 2025 protocol traffic uses stateless Streamable
HTTP with SSE responses. The 2026-07-28 protocol uses the SDK's envelope and
`MCP-Method`/`MCP-Name` headers with automatic JSON/SSE response selection. Clients
should use a conforming SDK instead of implementing these envelopes themselves.
No persistent MCP session, standalone event feed, subscription, or resumability
is offered; stateless GET/DELETE requests return 405. POST bodies are limited to
64 KiB. Transport/request cancellation stops request work and never cancels a
business run.

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
the membership service, feature overrides and the indicators projection. Only
external provider/network boundaries are simulated. They cover both protocol
eras, complete response consumption, invalid grants, scope/membership isolation,
Origin checks and provider outages.

Before enabling broader access, record a generic MCP client/Inspector check
against a real hosted preview or staging endpoint, including complete JSON and
SSE response delivery. Then record basic OAuth, discovery and indicators results
for Claude, ChatGPT, Claude Code and Codex, with client version/account conditions.
Local HTTP tests do not establish hosted-client reachability. OAuth foundation
and discovery shipped separately in #34931 and #34932. The client matrix for the
full tool set remains #34936; the new message-reader tests do not establish that
broader hosted acceptance.
