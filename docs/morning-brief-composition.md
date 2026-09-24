# Morning Brief composition

How the Simple Morning Brief turns several providers into one model request,
and which facts have to survive that reduction. Collection admission, claiming
and finalization are described in
[the collection contract](morning-brief-collection.md); this document covers
what happens to the evidence in between, and which language the result is
written in.

`FeatureSwitchKey.NativeMorningBrief` is default-off and enabled for the staff org allowlist
only.

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
declared limitations. Request counts are the collector's own exact count of reads
issued, including reads that ended in a classified provider failure, never a
proxy such as the number of calendars enumerated. Zero means the source was
proven not to have issued a read; `null` is reserved for a rejected source job
that could not return its collector accounting.

Deduplication is identity-only. Two calendars' copies of one meeting are two
authorized records, and an email whose subject matches an issue title is not the
same record at all. Relating those facts is the single model pass's job, where
the original identities are still attached.

`coverage` keeps `unconfigured`, `empty`, `complete`, `partial` and `failed`
apart all the way through rendering and delivery. An owner who never connected
GitHub has no GitHub evidence; a connected GitHub account with nothing
outstanding is a healthy answer about their day. Only the second one may be
described as empty.

The composition adds one more value of its own, `not-started`: the source was
applicable and the attempt's budget ran out before it could be admitted. Nothing
was observed about it, so it is neither a healthy empty nor a failed read, and a
report that dropped it would make an exhausted attempt look exactly like an owner
whose morning was quiet. The connector-backed collectors report "never connected"
through the same unavailable envelope they use for a broken credential, so the
composition translates that one failure reason back to `unconfigured`: a Calendar
nobody connected is silent, a Calendar whose credential broke is not.

### What the attempt answers

| Outcome                                                   | Meaning                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `composed`                                                | Authorized evidence survived and a single model request was assembled               |
| `empty`                                                   | Every applicable source answered affirmatively and none of them had anything        |
| `incomplete/all-sources-failed`                           | Nothing contributed and every source that could have answered failed                |
| `incomplete/incomplete-coverage`                          | Nothing contributed and some applicable source failed, was partial or never started |
| `incomplete/deadline-exceeded`                            | The one absolute deadline was reached before the attempt could finish               |
| `incomplete/no-item-fits`, `language-context-unavailable` | Usable evidence existed and no request could be made                                |
| `denied`, `authority-changed`                             | The owner may not run this attempt, or its instruction context moved while reading  |

Healthy empty requires an affirmative answer from **every** applicable source;
unconfigured sources stay silent. Every `incomplete` outcome carries the
per-source outcomes the attempt did establish, because "Chat was never started"
and "Chat was quiet" have to stay different facts for the attempt to be recovered
rather than delivered as silence. None of them assembles a request, calls a model
or delivers anything.

All five sources are attempted. Only a source's own reader knows whether the
member has a usable selected connection, and each reports an unconfigured source
as an unavailable or not-executed read rather than throwing — so an owner with
no connectors still reaches the engine, and Chat still contributes. Slack is the
one exception decided before the wave, because its native installation is the
organization's own bot rather than a per-member connector row.

A source that was never admitted contributes nothing and is reported as
unconfigured or failed, never as a quiet morning.

## Bounded fan-out

| Bound                                        | Value                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Collection phase, admission to COMMIT        | 45 s                                                                                                                               |
| Guarded commit reserve                       | 2 s                                                                                                                                |
| Per-source read reserve                      | the smaller of 3 s and a quarter of that source's remaining budget                                                                 |
| New provider read cutoff                     | 43 s into the phase                                                                                                                |
| Concurrent source jobs                       | 3, in the fixed order below                                                                                                        |
| Fixed source order                           | calendar, gmail, github, slack, chat                                                                                               |
| Per-source ceilings                          | gmail 20 s/44 reads, calendar 20 s/18 reads, github 20 s/24 reads, slack 30 s/40 reads, chat 15 s plus its own SQL/row/text bounds |
| Combined normalized input, metadata included | 1 MiB UTF-8                                                                                                                        |
| Exact serialized model request               | 128 KiB                                                                                                                            |
| Combined output tokens                       | 8192                                                                                                                               |
| Accepted rendered result                     | 32 KiB                                                                                                                             |

The phase, the attempt's lease and each source's own ceiling are three upper
bounds on the same read, and the tightest one wins. The 2-second reserve is not
a grace period: a source that has not started by the 43-second cutoff does not
start at all, because a read finishing after the commit window has nowhere to be
finalized. It funds the language-context read, the member locale read, request
assembly and the instruction-version fence — the work between the last source
answering and the COMMIT. It has never funded an authority check since #35949,
and collapsing it to zero is what makes a read admitted at 44.9 s settle the
attempt as `deadline-exceeded` instead of reporting the per-source facts it
established. Cancellation stops new admissions and joins work already owned —
there are no detached readers, no sleeping retries and no unbounded queue.

Each source holds a second reserve inside its own budget, and it protects the
payload rather than the commit. A source's cancellation signal and the clock
its collector consults describe the same instant, so a collector that reads
right up to its deadline is always **cancelled** rather than **stopped**: the
abort escapes classification — `settle` re-throws aborts by contract, because
a cancellation must never be mistaken for a result — the source job rejects,
and the wave loop replaces the whole source with a failed collection carrying
zero items. Every pull request, check run and channel history the successful
reads already produced is discarded with it.

That is not hypothetical. GitHub issued twenty reads and Slack twenty-nine, all
answering `200`, and both sources settled as `failed` with no items in every
recorded occurrence, while the two light sources beside them answered normally.
Compounding it, GitHub's collector started a _second_ twenty-second budget of
its own instead of using the one the composition had already allocated, so
every graceful budget check inside the read was measured against a clock
strictly later than the signal that cancels the source — the graceful path was
unreachable by construction.

So new provider reads stop at the read cutoff and the rest of the budget pays
for the bundle projection that turns a read into a collection. The reserve
is a share of what is actually left rather than a flat subtraction: taking three
seconds from a one-second budget would put the cutoff at the moment the source
was asked, and a source that is out of time before its first read would report a
morning it never looked at. A source that runs out of time now hands back the
partial evidence it holds; a source that was refused or revoked before its read
still hands back nothing.

### One deadline, sampled after every wait

The attempt resolves **one absolute deadline before admission**, from the 45-second
phase and the caller's own budget, and the earlier instant wins. A caller may
only tighten it: a scheduled occurrence hands in what is left of its lease rather
than receiving a fresh phase, and a caller asking for more keeps the phase.

That deadline covers admission itself, Slack-binding discovery, every source job,
the language read and the final authority and version checks. It is sampled from
the clock **after each wait and immediately before the attempt commits to a
request**, and equality is expired. Checking once in the middle is the failure
this replaces: an admission that spent the whole phase would leave every source a
zero budget and the attempt would then report a quiet morning, and a final
authority check that started before the deadline would commit a request after it.

A timeout signal is the backstop, never the fence. Its callback can be delivered
arbitrarily late under load, so an undelivered timeout is not evidence of
remaining time and only the sampled clock decides.

### Joining, not racing

Every source job a wave starts is **settled** before the wave is joined. Racing
them returns on the first rejection and leaves an authorized sibling reading a
provider with nobody waiting for it — and discards what the siblings that already
answered had collected. A rejected job is that one source's failure: it records
`failed` and the rest of the attempt continues on the evidence that survived.
Caller cancellation is raised once the work this attempt started has settled, so
cancelling never orphans a reader.

### Measuring, not estimating

The 128 KiB ceiling is on the **whole serialized request**, so evidence is never
budgeted against it directly. The fixed policy, the output schema, the coverage
report and the frozen Agent instruction text are measured first — an instruction
file may be 64 KiB on its own, half the request — and only what is left is
available to items. The response contract travels twice and both copies are
inside that measurement: once inside the message as documentation, and once as
the body's `response_format`, where the provider enforces it. Measuring the
complete body is what keeps the second copy a charge against evidence rather
than a surprise at the transport.

The enforced copy is derived from the result validator rather than written
alongside it, so both state the same lengths and the same counts. They did not
always: the validator bounded the title, the heading, the item text, the
citations, the sections and the items per section while `response_format`
bounded none of them, and an answer that satisfied the provider completely was
still thrown away. Deriving costs a few hundred bytes of the evidence budget and
removes the place the two could disagree.

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
next attempt. A different account selected afterwards is not adopted: the read never silently
continues on the new one, and nothing is read through it.

## Authorization happens before the read

Every provider request is authorized against live state immediately before it is
issued: the member's current membership generation, canonical ownership, Agent
visibility, the frozen account's selection and liveness, the Agent's grants,
catalog visibility and the effective URL policy for that exact endpoint. That is
the gate, and it is the only one.

A read that completed under a valid authorization is the brief's evidence. It is
not re-litigated afterwards. In-flight provider work cannot be retracted, so a
second check after the bytes are already held cannot prevent the access it
claims to guard — it can only discard evidence the owner was entitled to.

The pipeline used to re-ask, after collection, whether each completed read had
been allowed, by retaining a credential-free descriptor per source and re-running
the authorizer against it before the model request, on result readback, on Chat
commit and on email admission. It was removed (#35949). Its measured record was
worse than what it protected against: two separate defects inside the re-check
destroyed three consecutive briefs while collection itself had none, and because
one source's verdict could void the whole occurrence, the healthier the morning
the more it stood to lose. On 2026-09-21T23:00Z five sources collected 268 items
under valid authorization and all of it was discarded, with the model never
invoked, because one source's descriptor named more endpoints than a descriptor
was allowed to name.

A source's fate is now its own. A source that fails, is refused or is revoked
**before or during** its read contributes nothing and is reported as the failed
or unconfigured day it was; it never removes another source's material and never
settles the occurrence.

Ownership and destination coherence are separate questions and still apply: the
owner epoch, the collection lease, the attempt CAS and the occurrence binding
continue to guarantee one slot, one model request, one Chat receipt and one
logical email.

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
is left of the collection budget, and reaching it is already expired. A positive
remaining duration is admitted before the phase timer is constructed, so a clock
that crosses the deadline between the initial check and timer creation returns
the normal timeout outcome rather than passing a negative delay to the timer.
The clock and cancellation are rechecked after every wait and after manifest
decode, JSON parsing, target filtering and archive extraction, so a successful
response whose own timer has not fired yet cannot release absence or text late
or authorize another archive read. An exhausted budget asks storage for nothing
at all.

The registered composition-route coverage uses the real database, canonical
instruction publisher and an object-storage boundary double. It proves
before/equality/after behavior at the nearest real manifest and archive response
boundaries and joined cancellation while a storage read is held. A production
route cannot yield between source finalization and language admission or between
two synchronous parsing instructions. The pure production admission helper
therefore pins the exact before/equality/after rule used at those synchronous
edges, including genuinely tighter outer-deadline selection and the nonpositive
entry that returns before timer or storage construction; no internal reader,
planner or authorizer is replaced. Held-I/O
cases use arrival and settlement barriers rather than sleeps. This is
deterministic integration and helper evidence for admission and ownership, not
evidence of real model language compliance. The single-model migration/cohort
limitation below remains open.

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

Composition adds no schema change: the normalized items and language plan exist
in memory for the attempt and nothing about a source's authority outlives it.
`morning_brief_generations.retained_sources` and `retained_until` are no longer
written; both are nullable, so ceasing to write them needs no migration, and
dropping the columns is a separate follow-up (#35950) that may only run once
this change is in production.

The phase reserve that once funded the post-read authority check survives at a
smaller size as the commit reserve, because it also protected finalization: a
read admitted in the last instant of the phase has to have somewhere to be
finalized.

Old result versions keep their explicit handling. No default fabricates healthy
coverage, byte sizes, source authority or a language. The source set, the model
and schema or prompt revisions are provenance, never a second production
invocation identity.
