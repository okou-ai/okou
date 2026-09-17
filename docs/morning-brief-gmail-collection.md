# Morning Brief Gmail collection and the shared OAuth reader

Simple Morning Brief ([#34637](https://github.com/vm0-ai/okou/issues/34637))
needs real authorized source content without an agent Run. This document records
the first consumed OAuth source, Gmail, and the shared authorization boundary
every later source reads through
([#34809](https://github.com/vm0-ai/okou/issues/34809)).

It does not describe scheduling, generation or delivery. Nothing here claims
durable occurrence ownership.

## The shared reader

`turbo/apps/api/src/signals/services/morning-brief-connector-reader.service.ts`
exposes one entry point:

```ts
withMorningBriefConnectorReader<T>(
  { scope, connectorSlug, apiBase, environmentName, budget, db, clerk },
  collect: (reader: MorningBriefConnectorReader) => Promise<T>,
  signal: AbortSignal,
): Promise<MorningBriefAccessResult<T>>;
```

The signal is a separate final parameter, as the repository's lint boundary
requires. `clerk` is the mirrored `ClerkClient`, because membership is read from
the membership authority rather than from a cache row.

A collector supplies a `pathname`, an optional query and a Zod schema. It never
sees a credential, never chooses a host and never decides whether it may read.
The reader performs GET only, against the source's fixed provider base; it is
not an authenticated fetch proxy.

`admitMorningBriefCollection({ db, clerk, orgId, userId, anchor }, signal)`
derives the `MorningBriefCollectionScope` — owner, installation, Agent, bound
thread, anchor, timezone and the immutable membership id — from
`simpleMorningBrief`, the canonical
[migration state](./morning-brief-migration-state.md), the member's current
Clerk membership and erasure admission. Nothing in a request body contributes to
it.

### What "authorized" means here

Every gate must produce an unambiguous allow. Missing metadata, no route match,
an ambiguous route, `deny`, `ask` and an expired grant are all refusals, and
holding a credential is never permission. Each authorization pass re-derives:

1. the member's current Clerk membership generation, compared against the
   immutable id this collection was admitted under, plus transaction-level
   erasure admission,
2. a canonical Morning Brief that is still `installed`, still enabled, and still
   the same installation on the same Agent,
3. the Agent's current visibility to this member,
4. the pinned connector account,
5. the Agent's connector grants,
6. accepted-catalog visibility for this member,
7. the effective URL-level decision from live permission grants, through
   `matchFirewallRequestDecision`.

Items 1-6 are identity; item 7 always names a real URL. There is deliberately
no authorization outcome for "no endpoint": the identity pass runs first and the
credential is decrypted **lazily, behind the first endpoint a live policy
allowed**, so a credential is never touched on the strength of connector
presence alone.

The pass runs **before the credential is decrypted or refreshed**, **before
every request**, and **again after `collect` returns** as a release fence. The
release fence re-evaluates identity plus **every distinct permission whose
result the source still holds**, not only the last request's. A source that read
a list under one permission and bodies under another withholds everything if the
list permission is denied while the final body request is in flight.

The policy map is keyed by the connector's runtime target key, because that is
the firewall name `matchFirewallRequestDecision` looks a policy up by. Keying it
by the bare slug silently misses every active `deny` and `ask` and evaluates as
if the member held no grants at all.

### Account selection fails closed

The explicit selection on the canonical workflow/user thread wins. The org
default applies only when no selection exists at all. An explicit choice that no
longer resolves to a live account of this owner terminates the source; it never
falls back to a default mailbox. This reader deliberately does not reuse the Run
account materializer's invalid-selection fallback.

### Two failure altitudes

- **Endpoint-local denial** is a bounded coverage gap, reported as
  `{ kind: "denied", scope, meta }`. `scope: "policy"` is this member's own
  effective permission refusing the endpoint; `scope: "provider"` is a `403`.
  One resource can refuse a read while its siblings stay authorized, and a
  provider secondary rate limit arrives as `403` with `Retry-After`, so neither
  proves the credential is gone and neither terminates the source.
- **Owner, membership, Agent, installation or selected-account invalidation** is
  terminal. The reader latches, issues no further request, and discards the
  collected payload rather than releasing it. A provider `401` latches the same
  way as `reconnect-required`, because it withdraws the credential itself.

A refusal at admission names what was missing — `not-authorized`,
`not-connected`, `reconnect-required`. The same change observed once collection
is under way is always `source-revoked`, because it invalidates data the source
already holds.

### Response metadata

`ok`, `denied` and `rate-limited` carry `MorningBriefResponseMetadata`: bounded
`X-RateLimit-Remaining`, an ISO `X-RateLimit-Reset`, a clamped `Retry-After`,
and whether an RFC 8288 `Link` header advertises a next page together with its
validated page number. The `Link` URL itself is dropped: adapters learn that a
page exists and keep constructing their own fixed paths, so nothing here can
become a followable provider URL.

### Credentials that do not expire

A null stored expiry means the credential does not expire, not that it expired
now. GitHub OAuth tokens, personal access tokens and every manual method store
`NULL`; forcing a refresh on them drives an unsupported refresh that fails
before a single provider request. Gmail's expiring credential still refreshes
inside its buffer, and a method that genuinely cannot refresh still fails closed
at the next authorization.

### One absolute deadline

`budget.deadlineMs` is established once, before admission, and covers admission,
the membership and credential reads, every provider request and body, and the
release fence. It is both an `AbortSignal` composed into the provider request and
a clock the reader re-reads **after authorization returns and before the request
is admitted**, so authorization that takes real time cannot start a request past
its own deadline. Caller cancellation keeps its own propagation; deadline
exhaustion surfaces as `budget-exhausted / deadline` per request and
`deadline-exceeded` for the source, never as a healthy empty read.

### Limits this reader does not exceed

Provider work already in flight cannot be retracted. The guarantee is admission
fencing plus final-payload fencing, not instantaneous revocation. Erasure
admission runs in its own short transaction with finite `lock_timeout` and
`statement_timeout` and no network call inside it.

## Gmail collection

`morning-brief-gmail-collection.service.ts` collects two branches and merges
them by message ID, retaining every branch that selected a message:

- **recent** — `[anchor - 24h, anchor)`, half-open. Provider `after`/`before`
  filters are second-resolution, so the query is widened to whole seconds and
  each candidate is rechecked against millisecond `internalDate`. List ordering
  is not assumed.
- **unread** — the mailbox's current unread backlog with no invented lower
  bound. It is a read-time snapshot stamped with `unreadObservedAt`, **not**
  unread state as of the anchor.

Detail requests interleave the branches, so the unread backlog cannot starve
behind a busy recent window.

Preserved per message: bounded subject/from/to/date headers, IDs, timestamps,
unread labels, a readable inline excerpt and a safe Gmail deep link whose
`authuser` names the pinned account, so a selected non-default account never
points at another mailbox. No attachment is retrieved and no remote URL is
fetched.

`internalDate` is decoded as epoch milliseconds **at the provider boundary**. A
value outside that shape, or outside the range a `Date` can represent, is
provider data this collector cannot normalize: the message is rejected as a
malformed response so its branch reports a failure, its authorized siblings
survive, and no timestamp is invented. Accepting any string instead dropped an
unusable recent message into a healthy-looking read and threw out of
`toISOString` during normalization, after the reader had already returned.

### Retained text is one budget

Every character the result keeps is charged to the same 40,000-character
normalized budget: the four retained headers as well as the excerpt, in that
order. Each header is first projected to its own small ceiling, because a
provider header is transport-valid long before it is reasonable — a single
50,000-character `Subject` fits comfortably inside the 256 KiB response ceiling.
A value that no longer fits is shortened to what remains rather than dropping
the item that owns it, and the shortfall is named in `coverage.truncations`:
`header-characters` for a per-field ceiling, `text-characters` for the
aggregate. None of this widens a transport, request or aggregate cap.

### Inline text, attachments and MIME caps

Inline `text/plain` is preferred; an HTML-only message goes through the
repository's existing bounded `html-to-text` normalizer, and when that yields
nothing usable the item declares `excerptSource: "html-only"` instead of
inventing content.

A part carrying a filename is an attachment and its **whole subtree** is pruned
before its descendants are visited. A `message/rfc822` attachment contains a
complete message, so walking into it let attached content supply the excerpt of
the message that carried it. Pruning content already present in the response is
not a cap and is not reported as one; it never reaches for another provider
endpoint.

A MIME depth or node cap that stops the walk is its own state:
`excerptSource: "mime-truncated"` plus a `mime-nodes` truncation. Reporting it
as `html-only` claimed the message really carried no inline text, when a
plaintext part may simply never have been reached.

### Caps

| Cap                            | Value    |
| ------------------------------ | -------- |
| List pages per branch          | 2        |
| Candidates per page            | 25       |
| Unique message detail requests | 40       |
| Total API requests (attempted) | 44       |
| Concurrency                    | 3        |
| Deadline                       | 20 s     |
| Bytes per response             | 256 KiB  |
| Cumulative response bytes      | 4 MiB    |
| Characters per excerpt         | 2,000    |
| Characters per subject         | 300      |
| Characters per `From`          | 320      |
| Characters per `To`            | 1,000    |
| Characters per `Date`          | 64       |
| Final text characters          | 40,000   |
| MIME depth / nodes             | 12 / 200 |

Byte ceilings are enforced while streaming, never after an unbounded
`response.text()`. A request slot and its byte allowance are **reserved before
the first await**, so concurrent readers cannot each observe the same remaining
budget. An unattempted request returns its slot. The byte accounting is
deliberately stated as an upper bound rather than an exact count: the bounded
reader stops at the allowance and reports no consumed count for an oversized
body, so an abandoned body keeps its whole reservation charged and only a
completed body releases the difference. Redirects are disabled, so a credential
cannot follow a provider redirect off-host. The earliest cap wins and every
truncation is named in `coverage.truncations`.

`Retry-After` is surfaced as bounded metadata (≤ 60 s); the reader never sleeps
or retries on it. The rate limit itself is recorded as an occurrence, separately
from that optional advice, so a `429` carrying no header stays `rate-limited`
rather than collapsing into a generic provider failure. When several requests
are limited the longest advised delay is retained, so a caller that honors it
never retries earlier than a provider asked; each value is already clamped by
the reader, which keeps the retained one inside the same bound. A provider `403`
stays an endpoint-local denial and a `404` stays a deleted message.

### The envelope

The result is memory-only. It identifies the source, anchor, `collectedAt`,
`unreadObservedAt`, both branch windows, normalized items with branch
provenance, coverage and sanitized failure codes. Status is:

| Status        | Meaning                               |
| ------------- | ------------------------------------- |
| `ok`          | Complete read with content.           |
| `empty`       | Complete read with nothing in it.     |
| `partial`     | Usable content with reduced coverage. |
| `unavailable` | No usable content.                    |

A cap, an unknown page, a malformed response, a denied branch or an all-source
error can never be reported as `empty`. `not-connected`, `not-authorized`,
`reconnect-required`, `source-revoked`, `rate-limited` and `provider-failed` are
distinct. Raw bodies, credentials and provider error payloads are never
persisted or logged; a schema failure logs only the connector slug and org.

## The preview entrypoint

`POST /api/morning-brief/preview/gmail-collection` is registered in the ordinary
application composition (`signals/route.ts`), so the deployed production gate,
authentication and ownership checks are the ones under test. It exists to make
the reader a real consumed boundary, not to ship a feature:

- **Production answers 404 before authentication**, whether or not
  `simpleMorningBrief` is on. The gate is the existing production
  `isTestEndpointAllowed` helper; no test fixture or test-only helper is imported
  into production code.
- Development and protected preview additionally require the authenticated
  org/user, the implementation switch, a live canonical installed **and enabled**
  Morning Brief, valid Agent access and current membership/erasure admission.
- The only request input is a validated anchor. There is no Settings UI.
- The result is ephemeral. It claims no occurrence, no schedule and no delivery,
  and it creates no Run, Chat message, email, LLM call or credit operation.

## Coverage limits, stated exactly

- **`ask` and no-match are not constructible from Gmail's surface.** The
  accepted-catalog fixture allows `messages.read` by default and defaults
  unknown permissions to `deny`, and the collector only builds two allowlisted
  paths. `deny`, an ungranted default-deny permission and an expired allow are
  all exercised end to end; every non-`allow` decision leaves the reader through
  one `decision.kind === "allow"` check, and the remaining shapes are exercised
  by the GitHub adapter's own surface.
- **A dangling account selection cannot be built.** The real account-deletion
  endpoint deletes the thread selection before removing the account, and the
  schema restricts deleting a referenced connector, so a later invocation
  legitimately sees no explicit selection and follows the existing no-selection
  policy. What is proven instead is that an explicit selection that is still
  present but unusable fails closed, and that deleting the pinned account while
  its requests are in flight never substitutes another account.
- **A malformed `internalDate` is proven as a rejected provider response, not
  as a partially usable message.** The message is not normalized at all, so its
  branch reports `failed` and its siblings carry the collection. Which siblings
  survive depends on how many detail requests were already in flight when the
  malformed one arrived; the guarantee is that authorized siblings already read
  are kept, not that every remaining candidate is still fetched.
- **The in-flight body deadline is proven as admission, not as a timed abort.**
  The clock re-read before provider admission is covered deterministically; the
  `AbortSignal.timeout` that bounds a body already streaming is not exercised by
  a test that would have to wait out the real 20-second budget.

## Rollout, scale and compatibility

`simpleMorningBrief` stays default-off and unchanged; existing Settings and
legacy execution remain authoritative. Rollback removes the optional preview
consumer with no source-content cleanup or backfill, because nothing is
persisted. Old and new API binaries can run together: this change adds one route
and reads only tables that already exist, so an older binary simply does not
serve the route. See
[deployment compatibility](./deployment-compatibility.md).

A paginated masked production read on 2026-09-17 at 03:47:44–03:47:45 UTC,
including internal owners, found 94 Gmail account rows across 89 owner pairs
with 3 needing reconnect, and 213 Morning Brief daily-delivery automations — 206
enabled, 7 disabled — across 212 owners and 209 organizations. Those are
inventory counts. They are not a count of selected, granted or authorized
sources: Agent grants and thread account choices were not counted, and
enrollment, canonical thread binding and native state tables are not exposed
through MaskDB. No migration or backfill is proposed here.

S5/S7 will integrate this same collector under real occurrence ownership. They
must call the collection service directly and must never call this public
preview endpoint in production.
