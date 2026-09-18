# Morning Brief calendar collection

Simple Morning Brief needs the recipient's own schedule for today and the next
two days. This document describes the bounded multi-calendar read that supplies
it, and the boundaries that read must not cross.

## Why this is not the webhook sync reader

`google-calendar-automation-event.service.ts` keeps automation triggers current
from a sync token. It is unbounded by design and it renders date-only values by
appending UTC midnight, which places every all-day event on the wrong local day
outside UTC and misreports daylight-saving boundaries. Morning Brief needs the
opposite properties: a frozen window, a hard budget, and truthful coverage. The
two readers therefore stay separate, and this one never creates a sync token,
a watch channel, or any provider write.

## The window

`resolveMorningBriefCalendarWindow` freezes the reporting window from a
validated anchor and the owner's canonical Morning Brief timezone. The timezone
is never taken from the request.

- The window starts at the first instant of the local day containing the anchor
  and ends at the first instant of the local day three calendar days later.
  Day 0 is today; days 1 and 2 are the near term.
- Three local days are 71, 72 or 73 hours depending on daylight saving. The
  window is computed with calendar arithmetic, never as a fixed 72-hour offset.
- When a spring-forward skips local midnight entirely, the day starts at the
  first instant that actually belongs to it, found by bisecting the local date
  over absolute time.
- An unusable timezone or anchor fails closed. The collector never guesses one.

Known limitation: that bisection assumes the local date never moves backwards.
A historical rule that turns the clock back across midnight breaks it —
`America/Goose_Bay` fell back at 00:01 on 2009-11-01, where the computed start
is `04:00Z` and the day really begins at `03:00Z`. Morning Brief anchors on the
current day, where no such rule is in force, so this is recorded rather than
repaired here. No claim is made that every IANA history resolves exactly.

## Time semantics

A provider timestamp is only useful if it names one instant. Everything below
exists so that a value which does not name one becomes declared coverage
instead of a meeting the recipient never had.

### Reading a timestamp

- `dateTime` is parsed as strict RFC3339 and its calendar components are
  validated before any instant is constructed. `2026-02-30T01:00:00Z` is not a
  date, so it is unreadable; it never rolls forward into March.
- An explicit offset, including `Z`, identifies the instant by itself and is
  honoured exactly. An accompanying `timeZone` is provenance and never
  reinterprets it. Sub-millisecond digits are dropped, never rounded.
- Google's documented offsetless shape — a wall time plus an IANA `timeZone` —
  is resolved in that zone, per endpoint, so an event that starts and ends in
  different zones stays correct. A wall time a daylight-saving jump skipped, or
  one a fall-back makes true twice, names no single instant and is unreadable.
- A value with no offset and no usable zone is unreadable. The machine
  timezone of the process running the collection is never consulted, and that
  behaviour is covered under a non-UTC server timezone.
- Anything outside these shapes is unreadable. The response schema stays
  permissive on purpose: rejecting the value at the page level would cost the
  whole calendar, while rejecting it per event keeps valid siblings.

### Placing an interval

- **Timed events** overlap the half-open window `[startAt, endAt)`. An event
  ending exactly at the window start, or starting exactly at the window end, is
  outside it. An event crossing local midnight stays whole. A zero-length
  `start === end` event is a real Google shape and keeps its point semantics.
- An end **before** its start describes no interval and is unreadable.
- **All-day events** are calendar dates with an exclusive end date, not
  instants. They are compared as dates, and their original date range and
  calendar timezone are preserved. They are grouped under the owner's local
  days. They are never converted through a fabricated UTC midnight.
- An all-day exclusive end at or before its start covers no day at all and is
  unreadable. Unlike the timed case, there is no point in time to fall back to.
- An endpoint stating both a `date` and a `dateTime`, or neither, and a pair
  mixing the two representations, are unreadable rather than silently resolved
  in favour of one of them.

An event whose time is unreadable for any reason above marks its calendar
`truncated` and records an `unreadable-event-time` truncation, rather than
being dropped silently. Its valid siblings on the same calendar survive, and
recurrence identity (`recurringEventId`, `originalStartTime`) on those siblings
is preserved as the provider stated it.

## Calendar selection

`GET /calendar/v3/users/me/calendarList` is enumerated from the exact selected
`google-calendar` account.

- `reader`, `writer` and `owner` calendars are readable. Deleted entries are
  omitted.
- `freeBusyReader` grants busy blocks, not event detail. Such a calendar is
  reported as `free-busy-only` coverage and is never requested.
- A missing or unrecognized access role is reported as `unknown-access`
  coverage. Whether such a calendar holds anything is unknown, and an entry
  that was silently skipped would make an account this reader cannot interpret
  look like an account with nothing on it.
- A calendar whose ID cannot be carried — longer than the identity ceiling, or
  not encodable as a URL component, as a lone surrogate is — is never requested
  and is reported through an `oversized-identity` truncation. It gets no
  coverage entry of its own, because naming it would require a clipped ID that
  identifies a different calendar.
- If the list itself is denied, `coverage.calendarList` is `denied` and no
  events are read. The collector does not fall back to `primary`: that would
  claim coverage the account never proved.
- The readable set is ordered primary-first _within the calendars actually
  enumerated_, then by stable calendar ID, and capped. Calendars beyond the cap
  are reported as `not-read` with a `calendars` truncation.
- An account with **no** readable calendar read nothing, so it is never
  `empty`. It reports `unavailable`, and `not-authorized` once the whole list
  was enumerated and nothing in it grants event detail.

## Budgets

| Limit                                | Value                                  | Owner         |
| ------------------------------------ | -------------------------------------- | ------------- |
| Calendar list pages × page size      | 2 × 50                                 | this module   |
| Readable calendars read              | 8                                      | this module   |
| Event pages per calendar × page size | 2 × 50                                 | this module   |
| Events kept                          | 200                                    | this module   |
| Attendees kept per event             | 20                                     | this module   |
| Final text characters                | 40,000                                 | this module   |
| Provider requests                    | 18                                     | shared reader |
| Response bytes                       | 256 KiB per response, 2 MiB cumulative | shared reader |
| Deadline                             | 20 s                                   | shared reader |
| Concurrency                          | 2                                      | this module   |

Byte ceilings are enforced while streaming, inside the shared reader — the only
component that touches the network. Every **attempted** request is charged
there, so a failing provider cannot buy extra attempts.

A cap, an unfollowed continuation token, an unread calendar or a dropped event
is always explicit coverage; it is never reported as a complete empty read.

### The final text budget

A provider byte ceiling is not a final-text ceiling. Five small responses stay
far inside 256 KiB and 2 MiB while carrying 200 events whose ordinary displayed
fields — a summary, an organizer and a repeated calendar name — are already
100,000 characters. The 40,000-character budget is therefore charged against
the **real retained representation** of each item: every provider-derived string
that can reach composition, including the provenance repeated on each item, the
organizer, recurrence metadata, response statuses and the display link.

Fields the provider can make arbitrarily long are projected to their own
ceilings before being charged, so no single transport-valid value can carry the
result past the aggregate bound:

| Retained field                       | Ceiling |
| ------------------------------------ | ------- |
| Calendar/event ID, `iCalUID`, series | 512     |
| Original start instant               | 64      |
| Timezone name                        | 64      |
| Response status                      | 64      |
| Display link                         | 2,048   |

These ceilings only decide how much of an arrived response is kept; none of
them widens a request, byte, event or deadline cap.

Identities and links are different in kind from presentation text. Clipping an
event ID, a recurrence ID or a URL does not shorten a value — it names a
different event or a different page — so those are kept whole or dropped:

- An event whose identity cannot be carried is dropped whole, with an
  `oversized-identity` truncation. Valid siblings in the same response survive,
  and no prefix is ever retained as a new, possibly colliding identity.
- A display link past its ceiling is dropped to `null` with an `oversized-link`
  truncation. A URL is never rebuilt from a prefix.

When the shared caps are reached, items are dropped rather than presented
half-accounted, and the owning calendar becomes `truncated`.

## Result envelope

The result is memory-only. It carries the fixed anchor, `collectedAt`, the
owner timezone, the actual window, normalized items with their calendar
provenance, per-calendar coverage, the truncations that applied, the request
count and a sanitized source failure.

`status` follows the shared source convention:

- `ok` — a complete read that produced content.
- `empty` — a complete read that produced none. This is a normal quiet day.
- `partial` — usable content survived, but some coverage was lost.
- `unavailable` — no usable content was produced.

`coverage.calendarList` reports whether the account's calendar list itself was
`complete`, `truncated`, `denied` or `failed`. Each calendar the list named then
carries its own outcome: `complete`, `free-busy-only`, `unknown-access`,
`denied`, `not-found`, `rate-limited`, `truncated`, `failed`, or `not-read` when
it was enumerated but never requested.

These stay distinguishable from one another, and all of them from a genuinely
quiet day: a fully read calendar holding nothing is `empty` with a `complete`
entry and no failure, while free-busy-only scope, an uninterpretable role, a
denied list and an account with no calendars at all each report `unavailable`
with their own coverage and failure.

A single calendar's denial, `404`, rate limit, malformed body or oversized body
is local: a valid sibling calendar survives it. The shared reader reports a
denial with its scope — this member's effective policy refusing the endpoint, or
the provider answering `403` — and Calendar treats both as the same bounded
coverage gap on that one calendar.

Owner, Agent grant, membership generation, installation or selected-account
invalidation is global. The shared reader latches it, stops issuing requests and
discards the payload instead of releasing it, so the whole source reports
`source-revoked` rather than a partial read.

Bounded provider metadata is consumed rather than ignored: `Retry-After` from an
explicit `429`, and from a provider `403` that is really a secondary rate limit,
lands on the calendar's coverage entry and on the envelope. The collector never
sleeps on it and never retries inside a collection.

The source-level failure is classified from what the collection observed, never
from the presence of that hint. A `429` is `rate-limited` whether or not the
provider said for how long, and a `403` that volunteered a wait is still a
denial rather than throttling.

One classification is deliberately coarse. The shared source-failure vocabulary
has no value for "the collector's own caps left nothing", so a collection that
produced no content purely because it stopped at its own page, request or byte
budget reports the generic `provider-failed`. The specific limit is still named
in `coverage.truncations`, which is where a reader should look; widening the
shared vocabulary would change every other source.

## Concurrent worker lifetime

The per-calendar reads run at concurrency two. Two properties follow from that,
and neither may depend on network timing:

- **The shared caps are allocated once, deterministically.** A worker that
  spent the 200-event and 40,000-character budgets as its pages arrived would
  let response order decide which calendars reach the brief. Each calendar
  therefore collects only up to what the shared caps could ever grant it, and
  the allocation happens after every worker has been joined, walking calendars
  in the stable selection order.
- **Every started read is joined.** Both workers are started, so both are
  awaited through `joinAll`, and the collection never settles while a read it
  issued is still running. The first error still propagates and caller
  cancellation is never masked: a cancelled caller receives the cancellation
  rather than a partial day, and no further provider request is issued after
  the cancellation reaches the started reads.

## What is retained

Bounded summary, location, a description excerpt, start/end and all-day flag,
calendar identity and timezone, organizer, the recipient's own response status,
and at most 20 attendees, with truncation flagged. Recurrence identity (`id`,
`recurringEventId`, `originalStartTime`) and `iCalUID` are kept so instances
stay distinguishable; the same meeting seen on two calendars keeps both
provenances rather than being collapsed without evidence.

Every one of those strings is charged to the final text budget above, the
calendar identity and name repeated on each item included. A field retained for
free is still text the brief has to carry.

Only absolute HTTP(S) display links survive, and they are never fetched.
Description, meeting and attachment URLs are not followed. Raw provider bodies,
credentials and provider error payloads are never logged or persisted.

## Authorization boundary

This module owns Google Calendar semantics only. `admitMorningBriefCollection`
derives the scope — owner, installation, Agent, thread, timezone and the frozen
Clerk `membershipId` — and every request then goes through the shared Morning
Brief connector reader, which resolves the exact selected account and
re-authorizes before credentials, before each next request, and before the
payload is released.

Nothing here widens that decision, and the anchor is the only caller-supplied
value on the path — there is no caller-supplied owner, Agent, account, calendar
ID, query or URL. The membership generation is what stops a member who left and
rejoined from releasing content the previous membership started collecting.

## Scope

Preview and future scheduled collection only. No provider writes, no calendar
creation or update, no watch channel, no Run or sandbox, no LLM call, no credit
admission or debit, no Chat or email, no schema or migration, and no legacy
schedule mutation. The result has no durable lifetime of its own; S5/S7 will
call this same collector internally under occurrence ownership.

## Rollout, scale and compatibility

`simpleMorningBrief` stays default-off, and the preview route is unavailable in
production regardless of it. Existing Settings and the legacy scheduler remain
authoritative; nothing here changes a user's preference, schedule, timezone or
thread.

One collection issues at most 18 provider requests and releases at most 200
normalized events and 40,000 characters, so a single read is bounded
independently of how many calendars the owner can see. Each calendar's
candidates are held until the shared caps are allocated, which is bounded by
the same 2 MiB cumulative response ceiling the reader already enforces: a
calendar cannot offer more than the two pages of 50 events it was allowed to
fetch, and it stops collecting once it alone reaches a shared cap. Concurrency
is 2 per collection, and the read holds no database transaction across a
network call.

There is no schema change, no migration and no persisted output, so old and new
application versions can run side by side: an older deployment simply does not
serve the route, and a newer one adds an endpoint that production never
admits. Rollback removes the optional preview consumer with no data to clean
up and no backfill.
