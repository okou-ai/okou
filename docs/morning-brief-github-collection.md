# Morning Brief GitHub collection

`simple-morning-brief` collects the recipient's actionable GitHub work through
their own authorized connector account, with no agent Run, no sandbox and no
tool loop. This documents the slice that reads GitHub: its authorization
boundary, its provider semantics, its budgets and what it deliberately does not
promise.

## Preview entrypoint

`POST /api/morning-brief/preview/github-collection` is registered in the
ordinary production route table (`turbo/apps/api/src/signals/route.ts`). That
registration is deliberate: a preview that exists only inside its own test
suite proves nothing about the deployed application's ingress.

Two independent things keep it away from production users:

- `isTestEndpointAllowed` is evaluated **before** authentication, so production
  answers `404` without doing any auth work — including for a caller who has
  `simpleMorningBrief` enabled.
- The route requires an authenticated organization and user, the `github:read`
  capability, the default-off `simpleMorningBrief` switch, a live canonical
  installed and enabled Morning Brief, a usable pinned Agent, and a current
  Clerk organization membership.

The only request input is `scheduledFor`, the scheduled anchor. No owner,
Agent, connector account, repository, query or URL can be supplied. The result
is memory-only: nothing about a preview invocation is persisted, so there is no
migration, no occurrence row and no rollback data to clean up.

## Authorization

Direct API collection does not inherit the Runner firewall, so authorization is
owned by the **shared** Morning Brief connector reader
(`morning-brief-connector-reader.service.ts`), implemented and owned by
[#34809](https://github.com/vm0-ai/okou/issues/34809). This slice consumes that
exact implementation and adds no second authorization engine:

- `admitMorningBriefCollection({ db, clerk, orgId, userId, anchor }, signal)` is
  the preview gate: the default-off `simpleMorningBrief` switch, a canonical
  installed and enabled Morning Brief, the member's current Clerk membership
  generation, and erasure-subject admission. It returns the frozen
  `MorningBriefCollectionScope` — owner, installation, pinned Agent, canonical
  thread, anchor, timezone and `membershipId`. None of it can be supplied by a
  caller; a removal and rejoin issues a new `membershipId`, so a new membership
  cannot release what the previous one collected.
- `withMorningBriefConnectorReader(args, collect, signal)` takes the shared
  `clerk` client alongside `db` and a separate final `AbortSignal`, and owns one
  absolute deadline covering admission, credentials, every request and body, and
  the release fence. It re-derives live authority before the credential is
  resolved, before every request, and again before the payload is released:
  canonical ownership, membership, the pinned connector account, the Agent's
  grants, accepted catalog visibility and effective URL policy. Holding a
  credential is not permission; every gate must produce an unambiguous `allow`.
- An explicit account selection that no longer resolves fails closed
  (`not-connected`); it never falls back to the member's default account.

This adapter supplies only the GitHub path vocabulary, its budget, its fixed API
host and its token environment name. It never holds the credential, builds its
own request, or decides whether it may read. There is no `GH_TOKEN` process
credential, controller credential, organization admin account, GitHub App or
installation token, and no Run materialization anywhere on this path.

### Endpoint-local refusal versus a lost source

`getJson` distinguishes the two refusals that matter for GitHub, and neither
terminates the source:

- `denied` with `scope: "policy"` is this member's own effective permission
  refusing the endpoint. The branch records `denied-endpoint` and its siblings
  keep their data.
- `denied` with `scope: "provider"` is GitHub answering `403`. One repository's
  check surface can refuse while `/notifications` and `/search/issues` stay
  authorized, so the branch records `provider-forbidden` and the rest of the
  bundle survives.
- A provider `403` that is GitHub's own rate limiter is throttling, not a lost
  credential and not a permission refusal. It is recorded as `rate-limited`.
  GitHub delivers the **secondary** limit as a `403` carrying `Retry-After` and
  the **primary** limit as a `403` reporting an exhausted allowance, usually
  with no hint at all, so both shapes are recognized.

`Retry-After` is an optional provider hint and never decides the cause. A `429`
without it is still rate limiting, a `403` with an exhausted allowance is still
rate limiting, and a refusal that is neither stays a permission refusal. The
failure codes therefore stay independent of the hint: `rate-limited`,
`denied-endpoint`, `provider-forbidden`, `missing-item`, `malformed-response`,
`oversized-response` and `provider-failed` each mean one thing.

A refused `GET /user` happens before any branch exists, so the three provider
branches are skipped and cannot carry its cause. The identity read classifies
the whole source itself: `rate_limited` when GitHub throttled it,
`permission_denied` when it was refused, and `provider_failed` otherwise.

Only an established loss of authority — revoked membership, changed ownership,
a different selected account, a credential that no longer loads — latches and
discards the whole source.

### Bounded response metadata

Every successful read returns validated, allowlisted `meta`: `hasNextPage` and a
bounded `nextPageNumber` derived from GitHub's own `Link` header, plus
`rateLimitRemaining`, `rateLimitResetAt` and `retryAfterMs`. The collector uses
`hasNextPage` to state truthfully whether a page it did not read exists, and
carries the rate-limit facts into the envelope as metadata. **No provider URL is
ever followed** — the next request is still a path this module constructs from a
bounded page number.

## GitHub semantics

| Branch          | Request                                                       | Window                             |
| --------------- | ------------------------------------------------------------- | ---------------------------------- |
| Identity        | `GET /user`                                                   | once, before any query is built    |
| Notifications   | `GET /notifications`                                          | half-open `[anchor - 24h, anchor)` |
| Assigned work   | `GET /search/issues?q=is:open assignee:<login>`               | current snapshot                   |
| Review requests | `GET /search/issues?q=is:open is:pr review-requested:<login>` | current snapshot                   |
| Checks          | pull detail, check runs, combined status                      | current snapshot                   |

- The login comes from `GET /user`, validated against GitHub's own login
  grammar before any server-owned search query exists. It is never inferred
  from platform identity, display name or installation owner.
- `since` and `before` are second-resolution provider filters, so notifications
  are filtered again against the exact millisecond window. A notification
  updated at the anchor belongs to the next occurrence; one updated at the
  window start belongs to this one. Notifications are never marked read.
- The two search branches are **current outstanding-work snapshots** carrying
  `observedAt`, with no 24-hour lower bound. An assignment nobody touched
  yesterday is still a priority. They are not a reconstruction of open state at
  the anchor and they do not share a database snapshot with the notification
  branch.
- The three branches are merged by stable repository plus issue/pull number.
  Every contributing reason is retained, including GitHub's own notification
  `reason` and unread flag. When the item cap refuses a new identity, the
  branch that found it records `items` and does not count it, so a dropped
  assignment is visible in the branch as well as in the bundle.
- A search branch's coverage is measured from the **distinct result identities
  it observed**, never from requested page capacity. Twenty-five requested
  slots are not twenty-five results; a page may be short, empty, or re-serve a
  row an earlier page already returned because the result set shifted. When a
  branch stops without a next page it is claiming it read the whole result set,
  so any disagreement with `total_count` — in either direction — is recorded as
  `search-total-exceeded`.
- At most five deterministic relevant pull requests get check coverage: review
  requests first, then the member's assigned pull requests, then anything a
  notification surfaced; ties break on recency and then stable identity. Only
  paths attributable to those pull requests are read — never an organization's
  repository inventory.
- Check state is what was observed, not branch-protection satisfaction. A
  denied, paginated or unreadable check surface is `unknown`, never `success`.
  Check runs and combined status each get one bounded page, and a `Link` next
  page keeps that surface incomplete even when `total_count` claims the
  returned array is all of it. Conflicting pagination facts resolve to an
  explicit gap, never to green. An actually observed failing or pending context
  is a stronger fact than the unread page and still reports `failing` or
  `pending`. Page two is never requested.

### Provider-supplied URLs are data

`subject.url`, `latest_comment_url`, search `url`, `Link` next URLs and
`details_url` are never fetched. Where enrichment needs a repository or item
identity, the URL is required to be exactly the HTTPS `api.github.com` origin
with no userinfo, other host or port, query or fragment, and a path shaped
exactly `/repos/<owner>/<repo>` or
`/repos/<owner>/<repo>/(issues|pulls)/<number>`.

The path is read from the **raw text before any parser sees it**. A general URL
parser percent-decodes and then resolves dot segments, so
`/repos/acme/old/%2e%2e/api/pulls/7` becomes `/repos/acme/api/pulls/7` and a
check against the parsed pathname would find nothing wrong with a repository
the provider never named. Any percent escape, backslash, `.` or `..` segment is
therefore refused first, and the surviving literal segments are validated
individually. Paths are then **rebuilt** from those segments. Pagination is
constructed internally from bounded page numbers. Display links are likewise
rebuilt, so an HTTP(S) link in the bundle is data the summarization step may
show, not a fetch instruction.

## Budgets

| Bound                     | Value                              |
| ------------------------- | ---------------------------------- |
| `/user`                   | 1 request                          |
| Notifications             | 2 pages × 50                       |
| Each search               | 2 pages × 25                       |
| Relevant pull requests    | 5 × 3 reads, one bounded page each |
| Total attempted requests  | 24                                 |
| Concurrency               | 2                                  |
| Deadline                  | 20 s                               |
| Per response              | 256 KiB, enforced while streaming  |
| Cumulative response bytes | 2 MiB                              |
| Items                     | 50                                 |
| Final text characters     | 40,000                             |

Every attempted request consumes the budget, including denials and failures.
The earliest cap wins and all truncation is explicit.

### The final text projection

`counts.textCharacters` and the 40,000-character cap are measured over the same
documented projection of the items the bundle actually emits:

`repository` + `title` + `excerpt` + `actor` + `url` + every
`reasons[].notificationReason` + every `checks.failingNames[]` +
`checks.headSha`.

Every one of those is provider-influenced text that reaches the summarization
step, so charging only the title and excerpt would report a bound that is not
being enforced: fifty items with a 140-character repository name and a
39-character actor are already past 40,000 characters before a single title is
counted. Fixed enum-like fields, numbers and timestamps are bounded by the item
cap instead and are deliberately not charged.

Items are emitted most-recently-updated first, and the first item that would
cross the cap stops the projection. Dropping items that way records
`text-characters`, so a clipped bundle is always `partial`. Individual fields
are clipped to their own bounds with an ellipsis and never between the halves
of a surrogate pair.

## Coverage and failure classification

The envelope records the source, anchor, `collectedAt`/`observedAt`, the actual
branch windows, normalized items with provenance, coverage, and sanitized
failure and truncation codes. It distinguishes:

- healthy `empty` from `partial`
- policy denial, provider `403` and a missing item (`not-found`) from each other
- primary rate limiting (`429`) and GitHub's secondary rate limit (a `403`
  carrying `Retry-After`), with the bounded hint as metadata
- malformed (`malformed-response`), oversized (`oversized-response`) and
  transport or other provider failures (`provider-failed`)
- request, byte and deadline budget exhaustion
- the shared reader's terminal source-unavailable reasons: `not-connected`,
  `not-authorized`, `reconnect-required`, `source-revoked`, `deadline-exceeded`
  and `provider-failed`, none of which release a bundle

An unread next page, `incomplete_results`, a `total_count` that disagrees with
the results actually observed, an unprocessed relevant pull request, an
unsupported notification subject, an unsafe provider link, a byte, deadline,
item or text cap, and a denied endpoint are each recorded as an explicit
coverage limitation.

`limits` is the single source of coverage truth: every branch gap joins the
bundle's own before the outcome is decided, and a non-empty `limits` can never
be reported as `complete` or as a healthy `empty`. A mixed partial result keeps
its valid sibling data, and a gap charged to one branch never turns a healthy
sibling partial.

Bounded `Retry-After` is metadata for the caller. This path never sleeps on it
and never retries on its own.

Raw provider bodies, provider error payloads and credentials are never stored
or logged.

### Notes for envelope consumers

Composition consumers of `MorningBriefGithubBundle` should read the envelope,
not re-derive coverage from the items:

- `limits` gained `provider-failed`, which used to arrive as
  `malformed-response`. Treat it as a transport or provider status failure.
  Consumers that validate through `morningBriefGithubLimitSchema` need no
  change beyond recognizing the new value.
- `outcome` is `complete` or `empty` only when `limits` is empty. A bundle that
  dropped an item, clipped its text, or left a provider page unread is
  `partial`, so a coverage note is warranted whenever `coverage` is `partial`.
- `counts.textCharacters` is the projection documented above rather than title
  plus excerpt, so the same bundle now reports a larger number and can carry
  fewer items. Consumers must not assume the collector's cap leaves room for
  their own budget; they should measure the items they receive.

## Non-goals

No notification mutation, issue/comment/reaction write, workflow dispatch, new
grant or default account, occurrence schema, migration, Run/sandbox/LLM, credit
admission or debit, Chat or email delivery, schedule or cutover change,
production provider read, release or feature activation. No whole-organization
repository inventory. The other source collectors and the shared authorization
implementation are owned elsewhere.

## Deployment compatibility

The preview adds one route and no persisted state, so old and new application
versions can run side by side: an older version simply does not serve the path,
and a newer one serves `404` in production regardless. `simpleMorningBrief`
stays default off, and the existing Settings surface and legacy scheduling
remain authoritative. Rollback removes the route with no source-content
cleanup or backfill. S5/S7 will call this collector internally under real
occurrence ownership rather than through a public preview endpoint.
