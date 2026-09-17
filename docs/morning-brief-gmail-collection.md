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
  { scope, connectorSlug, apiBase, environmentName, budget, db, signal },
  collect: (reader: MorningBriefConnectorReader) => Promise<T>,
): Promise<MorningBriefAccessResult<T>>;
```

A collector supplies a `pathname`, an optional query and a Zod schema. It never
sees a credential, never chooses a host and never decides whether it may read.
The reader performs GET only, against the source's fixed provider base; it is
not an authenticated fetch proxy.

`admitMorningBriefCollection(db, { orgId, userId, anchor })` derives the
`MorningBriefCollectionScope` — owner, installation, Agent, bound thread,
anchor and timezone — from `simpleMorningBrief`, the canonical
[migration state](./morning-brief-migration-state.md) and membership/erasure
admission. Nothing in a request body contributes to it.

### What "authorized" means here

Every gate must produce an unambiguous allow. Missing metadata, no route match,
an ambiguous route, `deny`, `ask` and an expired grant are all refusals, and
holding a credential is never permission. Each authorization pass re-derives:

1. membership and transaction-level erasure admission,
2. a canonical Morning Brief that is still `installed`, still enabled, and still
   the same installation on the same Agent,
3. the Agent's current visibility to this member,
4. the pinned connector account,
5. the Agent's connector grants,
6. accepted-catalog visibility for this member,
7. the effective URL-level decision from live permission grants, through
   `matchFirewallRequestDecision`.

That pass runs **before any credential is decrypted or refreshed**, **before
every request**, and **again after `collect` returns** as a release fence.

### Account selection fails closed

The explicit selection on the canonical workflow/user thread wins. The org
default applies only when no selection exists at all. An explicit choice that no
longer resolves to a live account of this owner terminates the source; it never
falls back to a default mailbox. This reader deliberately does not reuse the Run
account materializer's invalid-selection fallback.

### Two failure altitudes

- **Endpoint-specific denial** is a bounded coverage gap. Other branches keep
  collecting and the envelope reports reduced coverage.
- **Owner, membership, Agent, installation or selected-account invalidation** is
  terminal. The reader latches, issues no further request, and discards the
  collected payload rather than releasing it. A provider 401/403 latches the same
  way as `reconnect-required`.

### Limits this reader does not exceed

Provider work already in flight cannot be retracted. The guarantee is admission
fencing plus final-payload fencing, not instantaneous revocation. Erasure
admission runs in its own short transaction; no transaction is held open across
a network call. `org_members_cache` remains a read-through cache, so admission
bounds this reader, not the world.

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
points at another mailbox. Inline `text/plain` is preferred; an HTML-only
message goes through the repository's existing bounded `html-to-text`
normalizer, and when that yields nothing usable the item declares
`excerptSource: "html-only"` instead of inventing content. No attachment is
retrieved and no remote URL is fetched.

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
| Final text characters          | 40,000   |
| MIME depth / nodes             | 12 / 200 |

Byte ceilings are enforced while streaming, never after an unbounded
`response.text()`. Every attempted request is charged, so a failing provider
cannot buy retries. Redirects are disabled, so a credential cannot follow a
provider redirect off-host. `Retry-After` is surfaced as bounded metadata
(≤ 60 s); the reader never sleeps or retries on it. The earliest cap wins and
every truncation is named in `coverage.truncations`.

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
