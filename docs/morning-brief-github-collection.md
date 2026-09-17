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

- `admitMorningBriefCollection` is the preview gate: the default-off
  `simpleMorningBrief` switch, a canonical installed and enabled Morning Brief,
  and live membership/erasure admission. It returns the frozen
  `MorningBriefCollectionScope` — owner, installation, pinned Agent, canonical
  thread, anchor and timezone — none of which a caller can supply.
- `withMorningBriefConnectorReader` re-derives live authority before the
  credential is accessed, before every request, and again before the collected
  payload is released: canonical ownership, membership, the pinned connector
  account, the Agent's grants, accepted catalog visibility and effective URL
  policy. Holding a credential is not permission; every gate must produce an
  unambiguous `allow`.
- An explicit account selection that no longer resolves fails closed
  (`not-connected`); it never falls back to the member's default account.
- A URL the effective policy refuses is an endpoint-local `denied`, which this
  adapter records as a branch coverage gap. A terminal loss of authority
  latches and discards the whole source.

This adapter supplies only the GitHub path vocabulary, its budget, its fixed
API host and its token environment name. It never holds the credential, builds
its own request, or decides whether it may read. There is no `GH_TOKEN` process
credential, controller credential, organization admin account, GitHub App or
installation token, and no Run materialization anywhere on this path.

### Known shared-reader limitation

The shared reader currently latches **every** provider `401`/`403` as
`reconnect-required` and discards the whole source. GitHub's secondary rate
limit is delivered as a `403` carrying `Retry-After`, and a single repository
can legitimately refuse one read while the rest remain authorized, so that
classification is recorded here as present behaviour rather than the desired
contract. The concrete capability is requested in #34809; until it lands, this
adapter's endpoint-local denial coverage is exercised through the effective
permission policy, which is the authorization path that actually decides
access. No second engine is maintained to work around it.

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
  `reason` and unread flag.
- At most five deterministic relevant pull requests get check coverage: review
  requests first, then the member's assigned pull requests, then anything a
  notification surfaced; ties break on recency and then stable identity. Only
  paths attributable to those pull requests are read — never an organization's
  repository inventory.
- Check state is what was observed, not branch-protection satisfaction. A
  denied, paginated or unreadable check surface is `unknown`, never `success`.

### Provider-supplied URLs are data

`subject.url`, `latest_comment_url`, search `url`, `Link` next URLs and
`details_url` are never fetched. Where enrichment needs a repository or item
identity, the URL is parsed and required to be exactly the HTTPS
`api.github.com` origin with no userinfo, port, query, fragment or percent
encoding, and a path shaped exactly `/repos/<owner>/<repo>` or
`/repos/<owner>/<repo>/(issues|pulls)/<number>`. Paths are then **rebuilt** from
the validated segments. Pagination is constructed internally from bounded page
numbers. Display links are likewise rebuilt, so an HTTP(S) link in the bundle is
data the summarization step may show, not a fetch instruction.

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

## Coverage and failure classification

The envelope records the source, anchor, `collectedAt`/`observedAt`, the actual
branch windows, normalized items with provenance, coverage, and sanitized
failure and truncation codes. It distinguishes:

- healthy `empty` from `partial`
- endpoint policy denial (`denied`) from a missing item (`not-found`)
- rate limiting, with the provider's bounded `Retry-After` as metadata
- malformed, oversized and other provider failures
- request, byte and deadline budget exhaustion
- the shared reader's terminal source-unavailable reasons: `not-connected`,
  `not-authorized`, `reconnect-required`, `source-revoked` and
  `provider-failed`, none of which release a bundle

An unread next page, `incomplete_results`, a `total_count` beyond what was
read, an unprocessed relevant pull request, an unsupported notification
subject, a byte, deadline or item cap, and a denied endpoint are each recorded
as an explicit coverage limitation. None of them can be reported as a complete
or healthy-empty read, and a mixed partial result keeps its valid sibling data.

Bounded `Retry-After` is metadata for the caller. This path never sleeps on it
and never retries on its own.

Raw provider bodies, provider error payloads and credentials are never stored
or logged.

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
