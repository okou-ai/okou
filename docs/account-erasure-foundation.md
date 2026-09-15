# Dormant account erasure foundation

[B1 #34003](https://github.com/vm0-ai/vm0/issues/34003) implements the local
persistence boundary of [#33745](https://github.com/vm0-ai/vm0/issues/33745).
It implements no production deletion entry point or registered worker.

The product rule preserves platform billing and erases other account-owned
data. Banking and Stripe connector business payloads are not platform billing.
User membership does not imply ownership of an organization's or another
member's resources. Subject kinds remain separate even for identical strings.

## Authority and activation

`projectErasureDecision` accepts a syntactically validated projection from a
future authenticated bridge: authority ID, immutable decision reference and
sequence, confirmation reference, subject kind/ID, generation, predecessor,
disposition version, request time, and deadline. Exact redelivery returns the
existing job. Changing a field for the same decision fails. A new generation
must explicitly name its predecessor and advance its sequence; old work cannot
claim, renew, commit, or reopen the new generation. Recovered/transferred
identities need authoritative disposition before projection, never inference
from a missing optional `users` row.

All UUID references accepted by the persistence operations must use lowercase,
hyphenated `8-4-4-4-12` form. Noncanonical references fail with
`account_erasure:invalid_reference` before their transaction can persist any
change. This includes decisions/predecessors, jobs, sinks/adapter versions,
items/dependencies, pages/enumerations, leases, producer boundaries, submission
receipts, terminal proofs, source-capture guards and retirement releases.
Callers must supply the canonical form on the first delivery and every replay;
PostgreSQL returns that same form. Subject IDs and opaque selector payloads
retain their own case-sensitive identity and are never lowercased here. Existing
canonical rows, page digests and references remain unchanged; this dormant repair
adds no migration or historical rewrite.

The confirmation reference is supplied evidence, **not a locally generated
signature or an acknowledgement guarantee**. G2d1 must establish the independent
control database, signing/verification lifecycle, monotonic commit ordering,
separate IAM/restore lineage, and its own identifier retirement. B2 must verify
that authority, bridge external append/main-DB commit idempotently, rebuild
missing projections, and place guards at actual producer commit boundaries.
A committed main-DB job cannot satisfy
[ADR 0004](adr/0004-account-telemetry-recovery-erasure.md)'s independent authority.

The [G2d1a journal](account-erasure-decision-journal.md) now implements dormant
independent PostgreSQL persistence, commit ordering and bounded replay. Its
internal references do not authenticate decisions. G2d1b still owns verified
production trust, infrastructure isolation and finite retirement before activation.

The following production callers remain unchanged and do not call this module:

- `webhooks-clerk.ts` still acknowledges user deletion after `waitUntil` work;
  organization cleanup retains its existing separate billing/background paths.
- `webhooks-clerk-cleanup.service.ts` still invokes usage deletion and deletes
  mixed organization metadata. Moving that routine into this worker is unsafe.
- API/Runner admission, output callbacks, workflow automation claims, provider
  callbacks, upload issuance/finalization, and telemetry exporters remain unwired.
  Cancellation does not fence `agent-event-consumer-run-output.service.ts`'s
  retained cancelled-run materialization. Issued upload URLs last 3,600 seconds.
- No webhook switch, cron/scheduler, collector/erase adapter registration,
  historical admission, backfill, credentials, or production IAM is added.

The functional sequence remains **B1 -> B2 -> A2**, with **full G2d1 required
before B2 activation**. A1's accepted code does not prove release, writer/compactor drain,
or bounded backfill completeness. Broader purge requires accepted A2 billing
isolation plus the relevant C2/D/E/G2 collectors and terminal proofs. B3/F/UX
own trustworthy client confirmation and local data cleanup. No local guard
authorizes deleting live run, usage, allowance, ledger, or other billing anchors.

## Persistence and locking

The five additive tables hold local decisions, required sinks, bounded work,
page receipts, and selector dependencies. They have no business-root foreign
keys. Internal restrictive FKs keep pages and dependencies attached to their
job/work; deleting a source user, run, membership, or object catalog cannot
cascade away the only locator. Empty new tables require no source scan or data
backfill. Existing API SQL remains unchanged.

All operations require PostgreSQL **READ COMMITTED** and reject another
isolation level. This matters when a writer waits behind the very first closure:
a pre-existing repeatable-read snapshot could otherwise miss the new job.
The lock order is:

1. All resolved subject advisory locks, sorted by the serialized kind/ID tuple.
2. The local job, then its work rows. One subject lock serializes job transitions.
3. Business source rows, if the caller is a writer or source remover.

`assertErasureSubjectWritable(tx, subjects)` holds the subject lock through the
writer's transaction commit, including when no deletion job exists. B2 must
resolve resource ownership before calling it, and acquire all relevant subject
locks before any business-row lock. Preflight auth alone cannot substitute for
this transaction boundary. Hash collisions only serialize unrelated subjects;
they cannot merge identity or scope.

`assertErasureSourceCaptured` is a different assertion: it requires the matching
closed subject, current generation/revisions and sealed producer boundary, a
nonempty explicit list of source-dependent items, and retained selectors. It
does not assert billing readiness, actual domain erasure, or A2 authorization.

## Bounded capture, attempts, and proof

`reviseErasureInventory` declares at most 64 required sinks, each identified by
a stable sink UUID, domain, and exact adapter version. It cannot silently remove
an existing sink. A new declaration increments capture and inventory revisions
and clears the producer boundary. Old proof/lease validity fails through that
job revision; targets are refreshed in bounded pages instead of an account-wide
reset. Each retained target must be recaptured in the new revision before seal.
Future collectors must include saved prior-generation manifests where live
source locators no longer exist, using indexed bounded pages.

`claimErasureWork` claims at most eight items for one explicitly named job.
Claims use row locks and `SKIP LOCKED`; this applies to work claiming, never to
source enumeration that would advance a cursor past a locked source row.
Leases last 60 seconds and are explicitly renewable. Every progress write checks
lease ID, generation, revisions, producer boundary, and `clock_timestamp()`
expiry at the final update. Expired workers cannot commit before or after reclaim.
Twenty exhausted attempts or an expired deadline escalate to unresolved.
Retryable results retain references and become available after one minute;
neither elapsed time nor a retry budget can produce success.

`ErasureHandler` provides the internal `inventory(input, cursor)`, `erase(item)`,
and `verify(item, producerBoundary)` contract. B1 registers no handler.
Selectors and cursor payloads must be prepared/encrypted before the capture
transaction; provider calls and KMS calls never span its database transaction.
Process interruption preserves the lease and last committed cursor for reclaim.
An uncertain provider effect must be reconciled using the persisted request
reference; an adapter must not blindly repeat a non-idempotent submission.
An unresolved result with no new request reference preserves the previously
committed receipt. A newly returned unresolved result retains its validated
receipt even if the job deadline crosses during the provider call: the work becomes
`capability_unresolved / deadline_exceeded`, with no accepted terminal proof.
Cancellation observed after an adapter returns also preserves acknowledged
receipts under valid ownership, then throws the abort without starting
verification or accepting success. A pre-aborted execution starts no provider
work. Terminal proof commits recheck cancellation inside their transaction.

Receipt persistence uses the same locked generation/capture/inventory/producer
boundary checks and final lease-expiry CAS as every other progress update.
There is no grace lease and no attachment of an old response to a replacement
claim. Process death before persistence, responses after lease expiry and
providers without stable idempotency/reconciliation remain later-adapter
obligations. The retained selector alone is not evidence that a submission can
be reconciled. Receipt removal belongs to verified projection retirement.

`commitErasureInventoryPage` atomically stores at most 100 stable item keys,
their selector/dependency declarations, a page receipt and the next cursor.
Exact replay is idempotent; conflicting page/item replay rolls back the whole
page. The final page needs an explicit complete-enumeration proof reference.
An empty page is not a verified absence result. Dependency sets are exact within
one capture revision; a later revision can explicitly expand them and cannot
silently drop an earlier obligation. Every work item's dependency declaration
is bound to its capture revision.

`sealErasureCapture` checks every required collector and retained target, calls
the supplied producer-boundary verifier outside the transaction, then rechecks
the exact job revision before sealing. A new sink, late item or changed producer
boundary requires a new capture revision. Nominal drain time is not a boundary.

Verification results must match the work/sink, generation, capture revision,
inventory revision and producer boundary, and include restricted evidence,
authenticated-reader and enumeration references plus observation time. An erase
request receipt is saved before verification and passed to that verifier. A 2xx
is only a submission result. Missing handlers/selectors/permissions, unknown
ownership and failed verification stay pending, retryable, or capability
unresolved. Finalization requires all declared items, including the collectors,
to have applicable proof. No external request can supply a success boolean.

## Minimum data and finite lifetime

The API's `account-erasure-selector.ts` uses the existing persistent KMS secret
envelope. Its strict typed union accepts only subject, object/version, provider
resource, row, and cursor locators; plaintext is capped at 4 KiB, encrypted
payloads at 16 KiB. Stable digests support exact replay; digests do not replace
retrievable ciphertext. Provider/account/storage references must identify
restricted cleanup configuration that outlives the disappearing business root;
later adapters own that concrete resolution and permission contract.

The module emits no logs and stores only bounded error codes and opaque proof
references. It never copies prompts, outputs, command arguments, profiles,
credentials, raw exceptions or provider response bodies. Decode/validation
failures do not echo the rejected selector. These internal exports are not an
HTTP status/selector lookup surface.

`retireErasureSelector` requires sealed current capture, a proven boundary, the
item's current terminal proof, a current complete dependency declaration, its
own dependency and a recovery obligation, and matching terminal proof for every
dependency. Empty/unknown/failed dependencies preserve the only locator.
It removes ciphertext/cursor detail while temporarily retaining proof mappings.
If a later sink contradicts the completeness assertion after lawful retirement,
fresh authoritative recapture is required. An unavailable selector stays
unresolved; this foundation does not manufacture compatible proof or a locator.

`retireErasureProjectionPage` requires a freshly supplied G2d1/G2d2 lineage
release verifier, bound to the exact decision and covering generation/revisions/
producer boundary. **B1 has no verifier and cannot manufacture that release.**
The release must include all producer replay, recovery copies, and control-store
backup obligations, and prevent valid replay of a fully retired local decision.

Current-generation mappings retire only after all selectors and older jobs are
gone. A historical job requires equivalent current sink/item/kind/digest
coverage, a superset of its dependencies, current terminal proof, and completed
selector retirement. Missing coverage blocks. The covering proof rows remain
until older jobs retire. Each transaction removes at most 100 page receipts or
100 work items with their bounded dependencies, then removes the empty job's
sinks and decision. A newer decision between pages requires fresh authority
verification and newly completed covering work before retirement resumes.
No automatic TTL destroys pending data, and no permanent nonbilling audit
exception is introduced.

## Verification and rollout limits

The targeted database suite uses real PostgreSQL concurrent sessions and unique
synthetic subjects. Because no production endpoint exists, it explicitly tests
the dormant persistence contract, including both first-closure orders, lease
expiry/reclaim, restart/cursor recovery, atomic multi-page rollback/replay, stale
proofs, dependency expansion and final generation retirement. Receipt regressions
use deferred provider returns and explicit database deadline/ownership fixtures,
covering null receipt preservation, post-return abort and invalidated owners.
UUID regressions cover rejection before persistence, canonical replay, genuine
conflicts and case-sensitive subjects across the same internal boundaries. The
API codec suite exercises the actual supported encryption path with the centralized
external KMS test client. These are local synthetic tests, not production
fencing, provider erasure, control-store authority, or account acceptance.

The normal [deployment compatibility](deployment-compatibility.md) contract
still applies: migrate before API promotion; outgoing/rollback API code remains
valid because only new tables and dormant exports are added. B1's new code does
not query these tables through any production entry point before or after
migration. Future activation requires its own reviewed integration and observed
old/new API, queued CLI, Runner, installed-client and provider-producer drains.
There is no legacy contraction, release execution, or historical remediation
in this slice. Never operate on the recovered September 12 account.

Before production worker activation, the controller must independently verify a
bounded claim plan as terminal work accumulates (including an appropriate
pending/retryable index or equivalent plan and representative EXPLAIN evidence).
The receipt/UUID repair does not change the current claim index or migration1124.
