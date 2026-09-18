# Morning Brief composition

How the Simple Morning Brief turns several providers into one model request,
and which facts have to survive that reduction. Collection admission, claiming
and finalization are described in
[the collection contract](morning-brief-collection.md); this document covers
what happens to the evidence in between, and which language the result is
written in.

`simpleMorningBrief` is default-off and has no allowlist.

## Source-neutral evidence

Five providers name records five different ways, so a normalized item keeps the
provider's own identity rather than a flattened string:

| Source   | Identity and time semantics                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail    | Exact selected mailbox the shared reader resolved + message id; a recent half-open window and the current unread backlog stay distinguishable                     |
| Calendar | Selected account + calendar id + event id and recurrence instance; frozen local-date window, timed overlap and exclusive-end all-day dates preserved              |
| GitHub   | Selected account + repository + subject kind and number, with notification/outstanding/review/check provenance; stale but still outstanding work is not discarded |
| Slack    | Workspace + channel + the exact fractional timestamp and thread identity; half-open source window and the declared old-root reply limit                           |
| Chat     | Thread + event identity and unread snapshot semantics; the destination and every Morning Brief or unknown-provenance thread excluded by the reader                |

Time is discriminated rather than flattened. Precise activity, timed overlap
and outstanding backlog carry real observed instants. An all-day Calendar item
instead carries `{ kind: "date-only", startDate, endDateExclusive, timezone }`.
It has no `occurredAt` or `endsAt` instant in the serialized evidence: parsing
`2026-11-01` as UTC midnight would describe the previous local afternoon in
America/Los_Angeles and would turn that DST day into the wrong span. A private
ordering key may rank the item, but it never becomes model-visible evidence.
Losing that distinction is how a brief starts describing a three-day conference
as "today" or drops an issue that has been open for a week.

Beside it travels every provider fact the collector already paid to read:
each branch that selected the record with its own reason and unread flag, the
provider's lifecycle state, the verbatim start and end strings, the record and
container timezones, the local day offset, the recurrence series, the observed
check state with the exact head it describes, the attributed actor and how the
body was obtained. None of it is re-derived and none of it is inferred. A title
and a body alone cannot tell one obligation from another: the same pull request
as "review requested, head A failing" and as "assigned, head B green" is two
different mornings, and a normalization that kept only the title produced one
byte-identical item for both.

Each collection also carries the window its evidence is only true within — the
half-open activity range, the frozen local dates and the owner timezone that
make an all-day date a day, the instant an outstanding-work snapshot was taken,
each provider branch with its own window or snapshot, and the collector's own
declared limitations. Request counts are the collector's own count of reads
issued, never a proxy such as the number of calendars enumerated.

Deduplication is identity-only. Two calendars' copies of one meeting are two
authorized records, and an email whose subject matches an issue title is not the
same record at all. Relating those facts is the single model pass's job, where
the original identities are still attached.

`coverage` keeps `unconfigured`, `empty`, `complete`, `partial` and `failed`
apart all the way through rendering and delivery. An owner who never connected
GitHub has no GitHub evidence; a connected GitHub account with nothing
outstanding is a healthy answer about their day. Only the second one may be
described as empty.

All five sources are attempted. Only a source's own reader knows whether the
member has a usable selected connection, and each reports an unconfigured source
as an unavailable or not-executed read rather than throwing — so an owner with
no connectors still reaches the engine, and Chat still contributes. Slack is the
one exception decided before the wave, because its native installation is the
organization's own bot rather than a per-member connector row.

A source that was never admitted produces **no descriptor**. A descriptor is
evidence that a specific input was authorized; fabricating one for a source that
read nothing would give a later permission check something to pass against that
nothing observed.

## Bounded fan-out

| Bound                                        | Value                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Collection phase, admission to COMMIT        | 45 s                                                                                                                               |
| Final checks and guarded commit reserve      | 5 s                                                                                                                                |
| New provider read cutoff                     | 40 s into the phase                                                                                                                |
| Concurrent source jobs                       | 3, in the fixed order below                                                                                                        |
| Fixed source order                           | calendar, gmail, github, slack, chat                                                                                               |
| Per-source ceilings                          | gmail 20 s/44 reads, calendar 20 s/18 reads, github 20 s/24 reads, slack 30 s/40 reads, chat 15 s plus its own SQL/row/text bounds |
| Combined normalized input, metadata included | 1 MiB UTF-8                                                                                                                        |
| Exact serialized model request               | 128 KiB                                                                                                                            |
| Combined output tokens                       | 8192                                                                                                                               |
| Accepted rendered result                     | 32 KiB                                                                                                                             |

The phase, the attempt's lease and each source's own ceiling are three upper
bounds on the same read, and the tightest one wins. The 5-second reserve is not
a grace period: a source that has not started by the 40-second cutoff does not
start at all, because a read finishing after the commit window has nowhere to be
finalized. Cancellation stops new admissions and joins work already owned —
there are no detached readers, no sleeping retries and no unbounded queue.

### Measuring, not estimating

The 128 KiB ceiling is on the **whole serialized request**, so evidence is never
budgeted against it directly. The fixed policy, the output schema, the coverage
report and the frozen Agent instruction text are measured first — an instruction
file may be 64 KiB on its own, half the request — and only what is left is
available to items.

Item sizes are measured the same way, by serializing the exact projection the
request carries. Summing field lengths is not the same number and is not
conservative: for 32 items whose text is entirely quote characters, a field sum
reports about half the real size, because every `"` becomes `\"` and property
names, separators, braces and `null`s cost nothing in the sum and real bytes in
the request. A budget that undercounts by 2x does not bound anything.

The 1 MiB combined ceiling bounds **one aggregate document**, not a pile of
bodies: each source's coverage, provenance window, request count, omission
account and items are serialized together, and that document's UTF-8 size is
the number. A budget blind to the metadata travelling beside the items bounds
something nobody holds. Each item is charged exactly what it adds — its own
serialization plus the one separator byte every element after the first in its
array costs — including the exact `partial` to `complete` metadata transition
when the final item fits. The returned size is then re-measured from the
consumer's document rather than trusted from a parallel counter.

Request coverage is not reserved through a synthetic "widest" report. Included
and omitted counts can cross different digit boundaries, so no one extreme is
always widest. Packing instead builds the final coverage metadata and exact
request, lowers only the whole-item budget by any measured overflow, and repeats
monotonically until the consumed serialization fits or no item remains. Agent
instruction text is never sliced.

Both ceilings measure documents this pipeline builds. The **provider body** that
carries the request is the integration consumer's own boundary and is a
different number: a wrapper that escapes this document into a JSON string field
roughly doubles a quote-heavy payload, and a 127,390-byte inner document became
251,113 bytes inside a minimal message envelope. The 128 KiB transport limit has
to be enforced against the complete outgoing body; reusing an inner-document
measurement as transport proof is exactly how a request that "fit" arrives
oversized.

The preview's `evidenceDigest` fingerprints the serialized evidence items only;
it is not a digest of coverage, language instructions, the provider wrapper or
the complete outgoing body. The integration consumer owns that complete-body
digest and transport fence.

The combined ceiling and the request ceiling both drop **whole items**. A
half sentence attributed to a real message is worse evidence than no message, so
nothing is sliced and the omission counts are what the coverage note reports. An
item whose source clipped its own text is marked `truncated`, and that mark
travels into the request: a fragment presented as a whole message is how a brief
confidently summarizes only the half that happened to fit.

Request capacity is filled in rounds, one item per nonempty source at a time, in
the fixed order, each source drawing from its own priority ranking. Concatenating
sources in order is the failure this replaces: a busy inbox would take every byte
and the brief would silently claim the owner had no meetings. A single oversized
item is skipped without ending its source's turns.

Round-robin alone is not enough for the **first** round: one early item can be
large enough to consume everything left, and a later source with a small first
item then contributes nothing. So until every source has placed one item, an
admission must also leave room for the first item of each source still waiting.

That reservation is chosen up front and is always jointly satisfiable: smallest
first item first, taking each while the running total still fits. Reserving for
_every_ waiting source instead is how a reservation nobody could honour
suppressed the items that could have been. A 247-byte Calendar item and a
40,242-byte Chat item sharing 1,000 bytes of capacity both got dropped, because
Calendar was charged a reserve for a Chat item no allocation could ever place,
and the attempt then reported that nothing fitted while holding something that
did. A source left out of the reservation is not excluded from the request: it
carries no reservation and still takes its ordinary turn in every round, so a
source whose first item is impossible can still contribute a later one.

Nonempty authorized evidence may produce one honestly partial brief even when
every applicable source is partial. Only when no usable evidence remains does the
attempt take an explicit incomplete or failed outcome — with zero model calls,
and never relabelled as healthy-empty.

## The coverage statement the brief must carry

A brief built from a bounded read and a request that dropped candidates reads
exactly like a brief about a quiet day. The reduction used to be recorded only
in HTTP metadata and in the prompt — neither of which the reader ever sees.

Three independent reductions can each shorten a day, and they act on disjoint
records: the collector's own caps, the combined normalized ceiling and request
packing. Each is reported as itself, so the known counts add without
double-counting. A cap that ended a provider read never enumerated what was
behind it, so the remainder stays an explicit unknown rather than a number
nothing observed — the count of _truncation kinds_ is not a count of messages,
and reporting one as the other states a total the collector never made. Chat is
the one source that can count what it dropped, because every skipped thread is a
thread it looked at; its deliberate policy exclusions, the destination thread
and threads that have hosted Morning Brief content, are not losses at all.

So the note is written by the program, from the same numbers the request was
built from, and the model can neither produce it, edit it nor suppress it.
There is no second model call: the wording is a fixed translation table covering
the ten Settings locales plus both Chinese scripts, selected by the language the
generation was frozen to, with the base subtag matching a supported variant and
the declared default as the last resort. A complete read that dropped nothing
carries no note, because a line on every brief teaches readers to skip it.

Every published string must also survive sanitization. `trim()` removes
whitespace and a C0 control character is not whitespace, so `U+0001` passes both
trimming and a minimum-length check and is then escaped to a space and trimmed
away — leaving a title, heading or bullet that renders as nothing. Validation
therefore runs against the escaped value that actually gets published, not the
raw one.

## The account a source is admitted with

Every OAuth source's account choice is resolved **once, before any source of the
attempt reads**, and the frozen choice decides both authorization and which
credential is loaded. Resolving a selection when each reader happens to start
lets an account chosen after admission decide what a later source reads, so the
attempt would stop being the attempt that was admitted.

Explicit absence is frozen too. A source the owner had not connected at
admission does not acquire an account mid-attempt; connecting one belongs to the
next attempt. A different account selected afterwards revokes the source — the
material the previous account produced is not released, and the read never
silently continues on the new one.

## Retained source authority

A collection deadline does not make old authority valid forever. Result
acceptance, persisted-result readback, a new Chat commit and a new email
admission each happen later than the read, so each asks the single shared
authorizer whether that exact input is still allowed.

What is retained for those questions is a credential-free descriptor: source,
the exact selected connection and account reference, a digest of the
authorization surface actually exercised, **one endpoint per permission whose
result the input still holds**, the membership generation, the Agent, when it
was captured, **the containers the evidence actually came from**, and whether it
entered the model input. At most one per source, at most 24 containers, at most
8 endpoints, 2 KiB each and 8 KiB in total. No raw source body, prompt,
credential or unrestricted URL blob is persisted or logged.

The digest is taken over the **effective permissions the read was admitted
under**, never over constant method names: a digest of method names hashes
identically after a grant is withdrawn, so it cannot detect the narrowing it
exists to detect. The endpoints are the same representative URLs the shared
reader's release fence already re-evaluates, which is what makes a later check a
repeat of the same live check rather than a narrower question.

A source that supplied material and cannot prove a connection, an account and an
endpoint is **rejected**, not described. A null account is "not observed", never
"any account": a descriptor without one would make every later check pass by
having nothing to ask about.

The containers matter: a digest of constant method names proves which API was
called, not which channels, threads or mailboxes the owner's evidence came from,
so on its own it cannot tell a later check what to revalidate. A collection that
drew from more containers than the bound is **rejected**, never trimmed — a
descriptor set that quietly lost a source would let every later permission check
pass by having nothing to check while the evidence went out anyway.

It is evidence about an input, never a bearer capability and never a cached
allow — every field exists so a later check can be re-run, and none of them can
stand in for its answer.

Revalidation runs on the composition path itself, after the last network await
and before any reservation. It re-enters the **existing** authorizers rather
than a second engine: connector sources re-run the shared reader's identity and
URL-policy gates for the frozen account and every retained endpoint, native
Slack re-runs the same shared-conversation enumeration its collector proves
against, and Chat re-resolves the same ownership, visibility and provenance
predicates its collector resolved. No credential is decrypted and no provider
payload is fetched: whether an input may still be used is a permission question,
not a reason to fetch it again.

The whole phase is bounded at 5 seconds and further constrained by the attempt's
own reservation, whichever is nearer; shared-channel and permission work is
counted inside it rather than given a budget of its own. A check that does not
finish inside the phase is not a proof of authority, so its source is withheld
like a revoked one.

Material whose authority was withdrawn is removed and the authorized siblings
are planned again, with that source's day reported as failed rather than as a
quiet morning. Whole-owner loss — a lost membership, a disabled or reinstalled
brief, an Agent the member can no longer act through — yields no plan at all, and
losing every supplied source is an authority change rather than an empty brief.

Contribution is decided by the material the final request actually carries. An
item dropped by allocation supplied nothing, and marking its source contributing
would make a later check defend evidence the model never received.

An external permission check **cannot** atomically prevent a revoke that lands
after it answers. Network preflight therefore runs outside every transaction,
and the consumer that finally releases the material re-evaluates its own local
predicates inside its own fence. What is bounded here is that material whose
authority is already gone never reaches that consumer.

Everything that entered the model input is revalidated, **including material the
model never cited**: it may have used a message without citing it, so reducing
the later checks to the output's citation ids would check the wrong set. A source
that supplied no content does not veto a brief built from the owner's other
authorized sources, and an existing committed delivery is a historical fact
rather than an invitation to send again.

Retention is `max(result expiry, the linked obligation's original outbox
deadline)`. S5 content lasts 24 hours from reservation and an outbox request has
15 minutes from its own creation, so a Chat commit made just before expiry can
require up to **24 h 15 m** of descriptor lifetime from reservation. Neither
deadline is reset by a retry, and the extension carries metadata only — no result
body and no source content. Result-content expiry must not destroy the
content-free occurrence and delivery facts.

## Language

The precedence is fixed, and all of it is resolved inside the single
summarization call:

1. **Pipeline constraints always prevail** — one call, no tools, grounded
   sources, validated output and the delivery rules. A non-language request
   inside Agent context does not change any of them.
2. **The admitted canonical Agent's complete instruction text may steer the
   output language only.** There is no language-detection model, no regular
   expression pulling directives out of free-form prose and no inferring a
   language from a prefix.
3. **Otherwise the persisted member locale decides**, and with no locale the
   declared `en-US` default does.

Source text is data. A message that says "reply in French" is evidence about
someone's day, never an instruction to this pipeline.

Output languages are deliberately wider than the ten-value UI locale
enumeration and kept separate from it: Chinese has no UI locale, yet an Agent
configured in Simplified Chinese must be able to produce a Simplified Chinese
brief, and the Simplified/Traditional distinction has to survive because they are
not interchangeable for a reader. This adds no Settings field and does not
broaden the UI locale feature.

Instruction text is read from the same canonical storage, path and
legacy-frontmatter semantics the application already uses, but not through
`agentInstructions`: that call has no size ceiling, and a 45-second phase cannot
adopt an unbounded download. The bounds are a 256 KiB manifest, a 1 MiB
compressed archive, a 2 MiB decompressed archive enforced by gunzip itself, a
64 KiB complete instruction file, strict UTF-8, a unique validated canonical
target and a 5-second absolute storage phase inside the collection budget.
Nothing executes instructions or follows links, includes or imports inside them.

These outcomes are distinct and stay distinct:

| Outcome                                                                                                               | Meaning                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No instructions volume, no promised target, or a valid empty file                                                     | Absence. The locale/default path applies with no model interpreting anything.                                            |
| A complete, valid, nonempty file                                                                                      | It stays in the sole request, which may apply the locale/default when the text carries no applicable language directive. |
| Inaccessible storage, corrupt archive, duplicate or missing promised target, oversize, invalid UTF-8, storage timeout | Failure. Missing data under an existing promised version is never absence.                                               |

Absence is reported as the state it was read in and the configuration it was
read from: `no-storage` (no volume was ever published, so there is no version),
`no-target` (that version carries no instructions file) and `empty-file` (that
version's file is empty). The manifest is decoded strictly, because replacing a
byte it cannot read would turn a promised path into a path that matches
nothing — and "matches nothing" is absence. Inside the archive, every entry
claiming the canonical path is counted before any type filtering: a regular file
beside a same-path symlink or directory is ambiguous, not a single file, and no
link, include or URL is ever followed. An archive that decompresses past the
ceiling is oversize rather than corrupt, because the ceiling is this pipeline's
bound and not a fault in the owner's data.

A read error must never masquerade as either usable case: an owner whose
instructions are unreadable has not asked for English. If the complete policy and
request cannot fit, that is recorded as language-context-unavailable before the
model reservation and handed to the finite configuration-defer and settlement
path — never auto-disabling the owner and never leaving an unowned NULL
schedule.

Language context is resolved **only when candidate content warrants generation**.
A healthy empty collection settles with zero generation and zero delivery without
any storage I/O.

The version is resolved before network reads and that immutable version is read
outside any transaction. One absolute deadline starts before that resolution and
bounds everything the phase owns; it is the tighter of the five seconds and what
is left of the collection budget, and reaching it is already expired. The clock
and cancellation are rechecked after every wait and after the synchronous parse
and extraction, so a successful response whose own timer has not fired yet
cannot be released late, and an exhausted budget asks storage for nothing at
all.

Every frozen outcome is revalidated against live configuration before the
generation reservation, absence included: an available or empty file must still
be that version, a missing target must still be missing under that version, and
`no-storage` must still be unconfigured. A failure is never absence and never
reaches this boundary. Once reserved, the language policy is frozen for that
invocation: a later instructions-only edit applies to the next occurrence and
authorizes neither another POST nor a silent rewrite. The policy, version and
digest are frozen with the generation; the raw text stays ephemeral. A validated
model-reported language tag is recorded as provenance — it is not independent
linguistic verification, and a mocked response proves nothing about a real
model's compliance. An unrecognized tag is dropped rather than coerced, because
storing the fallback locale in its place would assert a language nothing
observed.

### Compatibility boundary

This contract preserves declared canonical Agent language steering and
locale/default behavior. It does **not** reproduce arbitrary old conversation,
memory or external-file language steering. That remains a pre-activation
compatibility gate requiring controller evidence for the actual migration cohort;
Agent-context plumbing passing unit tests does not close it. Production
instruction sizes and language sources have not been censused.

## Deployment and retention

Composition adds no schema change: the descriptors, normalized items and
language plan exist in memory for the attempt, and only the bounded descriptor
set is intended to travel beside the existing accepted-result lifecycle.

Old result versions keep their explicit handling. No default fabricates healthy
coverage, byte sizes, source authority or a language. The source set, the model
and schema or prompt revisions are provenance, never a second production
invocation identity.
