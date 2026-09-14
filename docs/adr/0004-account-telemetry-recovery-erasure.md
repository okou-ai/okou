# Erase account telemetry and recovery copies through the parent deletion job

Status: Proposed — 2026-09-14

## Context

[G1 #33853](https://github.com/vm0-ai/vm0/issues/33853) investigates the telemetry
and recovery boundary of [#33745](https://github.com/vm0-ai/vm0/issues/33745).
The accepted product rule preserves necessary **platform billing evidence** and
erases other account-owned data. Prompts, complete runs, profiles, marketing
attribution and nonbilling audit logs have no permanent retention exception.
Banking or Stripe connector business content is not platform billing.

The [dated evidence inventory](../account-erasure-evidence.md) establishes
writers, consumers, visible provider settings and unresolved capabilities.
It is part of this decision. No production erasure or recovery operation was
performed for G1. Merging these documents does **not** complete G2/H, demonstrate
erasure, authorize a release, or close the parent issue.

## Decision

Use the parent's durable deletion job and ownership rules for every sink. Move
product diagnostics out of shared immutable telemetry. Minimize remaining
telemetry at its source. Make historical provider erasure and irrecoverability
of recovery copies explicit work items with verifiable terminal results.

Do not implement an Axiom filtered DELETE, delete a mixed-user Sentry issue,
trim a shared dataset for one account, infer deletion from a missing `users`
preference row, or delete the September 12 recovered account again. The
controller owns historical identity reconciliation, recovered/transferred
account exclusions and subsequent implementation dispatch.

### 1. Parent worker and ownership contract

Slice B owns scheduling, leases, retries, fencing and durable progress; G2 adds
adapters to that worker, not another scheduler. A versioned input contains:

| Input                                                                         | Required semantics                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`, `decisionSequence`, `subjectId`, `deletionGeneration`, `requestedAt` | Immutable identity from the authoritative deletion decision, never email alone; repeated delivery is idempotent. Re-registration/recovery requires the controller's explicit identity disposition.    |
| `scope`                                                                       | Subject-owned roots, owned run/session IDs, applicable organizations, and association-only changes to surviving resources. Membership in an organization is not ownership of every row in it.         |
| `selectorManifestRef`, `manifestDigest`, `captureComplete`                    | Restricted, encrypted, paginated inventory committed before lookup rows disappear. B/C2 must refuse dependent row removal while capture is incomplete.                                                |
| `producerBoundary`                                                            | Fence generation, producer/queue identities, acknowledged terminal sequence or drain watermark, and remaining supported producer versions. Time elapsed alone is not a drain acknowledgement.         |
| `sinkInventoryRevision`                                                       | Every current and historical endpoint/project/dataset/bucket/host lineage, including retired configurations with retained data. New applicable destinations invalidate an older completion inventory. |

Adapters implement `inventory(input, cursor)`, `erase(workItem)` and
`verify(workItem, producerBoundary)`. These are internal interfaces, **not**
claims that providers expose identically named APIs. Persist work item identity,
sink identity, selector reference, cursor, attempt, next retry, provider request
reference, verification deadline, evidence reference and state. Enforce a unique
key on `(jobId, sinkId, itemKey, deletionGeneration)` and compare lease/fence
generation before accepting results from a worker. Never hold a database
transaction open across provider calls.

Use five externally visible outcomes:

- `pending`: discovery, provider processing, producer drain or verification is incomplete.
- `retryable_failure`: a diagnosed transient failure, with a bounded retry time.
- `capability_unresolved`: missing inventory, selector, permission or supported purge/proof.
- `verified_erased`: the named item's deletion and its declared proof scope passed.
- `verified_no_applicable_data`: complete, authorized lineage/selector enumeration proves the item never held applicable data; lack of access is not absence.

`verified_erased` for active PostgreSQL rows cannot cover Neon history, and trace
deletion cannot cover independent exports. Parent erasure completion requires
**every** applicable nonbilling item to have a verified terminal result. The
proof records its scope, authenticated reader, provider/version, cutover,
enumeration completeness and observation time. A 2xx, query filter, empty page,
401/403/404 caused by lost access, or timeout cannot manufacture success.

### 2. Selector lifecycle and export fencing

Capture Clerk subject identity; historical run/session/thread IDs and time
ranges; all spelling variants (`userId`, `user_id`, `runId`, `run_id`); Sentry
project/event/attachment IDs and attributable aliases; PostHog person UUIDs and
all distinct IDs; Langfuse pseudonym derivation versions, trace/session IDs and
project history; and recovery/cache/object identities. Scope aliases by their
actual owner. Do not match everyone sharing an IP, email domain or organization.
An unattributed historical record is a capability gap, not permission to erase
other accounts or declare it anonymous.

For shared records that legitimately belong to a surviving owner, remove the
deleted subject's personal association/content under C2's ownership contract.
If an immutable provider cannot modify that association, the historical
replacement procedure must preserve a sanitized surviving record. An actor ID
match alone is not authorization to destroy an entire shared resource.

B closes account admission, stops active work, rejects late account callbacks
and commits the selector inventory before C2 deletes its source rows. G2 checks
the fence both when accepting an export and immediately before sending a
buffered batch. This includes Axiom SDK/direct/OTel queues, Runner's bounded
channel and local buffers, browser/CLI/Desktop SDK persistence, Langfuse plugin
flushes and PostHog queues. Partition batches by subject so a deleted subject
can be dropped without dropping another subject's events. Billing reconciliation
continues only through A1/A2's content-free billing writer.

Direct browser or installed-client ingest cannot be controlled by a server
fence alone. Route remaining account-linked telemetry through authenticated,
fenced ingress, or remove its account linkage/content before direct ingest.
Retire old credential-bearing producers with a verified supported-version and
credential-scope transition; a page refresh or `setUser(null)` is insufficient.
Do not rotate shared keys during this investigation. Old offline clients that
can still send attributable events keep the sink pending until ingress rejects
them or a supported terminal drain is proven. Coordinate local erasure with F.

Manifests are not diagnostic archives: no prompt, output, command arguments,
attachment body or profile is copied into them. Read access is limited to the
parent worker and the scoped restore verifier. Log job state/error codes, not
selectors or provider response bodies. Retry/dead-letter records carry the same
restriction. Delete detailed selectors and cleanup credentials after their
last dependent item reaches terminal verification; verification failure must
not trigger TTL deletion of the only remaining locator.

The minimal restore decision in section 5 remains only while an affected
recoverable lineage or producer replay can exist. Give each pending item an
owner and deadline; expiration escalates to `capability_unresolved`, never to
success. Once those dependencies are demonstrably gone, erase subject-bearing
decisions, evidence and mappings too. Retain only non-attributable aggregate
completion measurements; billing's minimum stable identity is governed by A1/A2,
not a permanent deletion audit trail. Indefinitely unverified backups are an
unresolved deletion failure, not an approved retention policy.

### 3. Source migration that can be implemented now

#### Account-owned diagnostic schema

Use additive PostgreSQL tables for the three product diagnostic streams. This
avoids inventing a new object locator before B/D's object manifest exists. The
following is the schema contract for the controller's source-migration slice;
it is not a migration in this PR. Use the next available migration number on
then-current `main`.

All three tables carry `run_id uuid`, `owner_user_id text`, `org_id text`,
`schema_version smallint` (initially 1), `occurred_at timestamptz`, and validated
`payload jsonb`. Identity comes from the authorized run, not telemetry input.
Index `(owner_user_id, org_id, run_id)` and reference the run with `ON DELETE
CASCADE`, while retaining B's capture-before-cascade barrier. Do not reference
the optional `users` preference table. Apply the existing run ownership guard
to every read, and B's deletion-generation guard inside each write transaction.

| Table                            | Keys and payload contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_diagnostic_contexts`        | PK `run_id`. One creation-time snapshot: framework, session identity, secret **names**, sanitized environment, firewall/network policy, volume/artifact references and feature state. Reuse the current snapshot normalization and response validation. Read prompt/system prompt/vars from the owned run row; do not duplicate them. Never store raw connector credentials.                                                                                                                                                 |
| `run_diagnostic_agent_events`    | PK `(run_id, sequence_number bigint)`, plus `event_type text`. Persist the accepted `AgentEvent` representation, including tool/output content, in this deletable domain. Duplicate sequence with identical canonical payload is idempotent; a different payload is an invariant error. Index supports both existing sequence cursor orders.                                                                                                                                                                                 |
| `run_diagnostic_network_entries` | PK `(run_id, entry_id text)`; index `(run_id, occurred_at, entry_id)`. Payload follows `networkLogEntrySchema`, including its URL/firewall diagnostic fields. New producers supply an immutable record ID. During actual old-runner drain, use a fresh server receipt UUID plus ordinal for legacy entries; do not content-hash deduplicate indistinguishable legitimate occurrences. Legacy retries may retain duplicates, as the old input has no trustworthy record identity. New producer IDs deduplicate exact retries. |

Add a `run_diagnostic_stream_state` table keyed by `(run_id, stream)` with
`source` (`legacy_axiom` or `owned`), `import_cursor`, `import_complete`, and
`last_committed_sequence` where applicable. Absence, expired historical data,
and failed import remain distinct. Classify a proven historical gap as
unavailable, never invent events or framework values. Persist context with run
creation and agent events with the existing accepted-event transaction before
acknowledgement. Commit network batches before acknowledging their receipt.
Use the validated existing ingress size limits and bounded transactions;
capacity-test the maximum accepted event and long runs before activation.
Do not truncate an acknowledged event merely to fit this new store.
A new context serializer reconstructs firewall auth structure with redacted
credential values (including headers/query/AWS auth), rather than copying the
old snapshot wholesale. Validate that secret values cannot enter stored JSON.
Give stream-state rows the same run FK and erasure barrier. Seed legacy stream
provenance in bounded batches before enabling its reader; new runs write owned
provenance in the run-creation transaction.

This schema chooses relational payload storage, so it creates no new R2
objects. If measured capacity later requires external payload objects, that is
a separate controller-reviewed schema revision: commit bucket/key/version and
digest to B/D's manifest **before** any dependent catalog row can disappear,
including failed writes and temporary objects. A cascade by itself is not an
object purge. PostgreSQL row deletion still leaves the section 5 recovery work.

#### Writers, readers and rollout order

1. Expand the schema with migrations before promoting the new API. Old API SQL
   must remain valid. New code is not served before migration completion.
2. Make owned diagnostics the writer for new runs and migrate all of
   `runContext`, `runAgentEvents`, `runNetworkLogs` in `run-detail.service.ts`,
   `runContextCliAgentType` and its `logs.service.ts` consumer. Preserve the
   `/run-detail` contracts, authorization, status/last-sequence fields,
   ascending/descending pagination and `publicAgentEventData` sanitization.
   Chat projections are not a replacement for complete Activity events.
3. Import surviving historical streams from their **actual** Axiom destination,
   with stable pagination, checksums/count reconciliation and a deletion fence
   checked again at commit. Do not import deleted/recovered-ambiguous accounts
   from a telemetry scan. Reduced historical Axiom events remain reduced;
   unavailable originals cannot be reconstructed. Overlap import with a
   recorded high-water mark and reconcile the tail before `import_complete`. An import page and its row
   ordinals must be durably checkpointed before retrying its insertion. Network
   history without stable record identity requires a consistent provider export
   or sealed source plus verified cursor semantics; if unavailable, leave that
   stream on legacy reads with AX-1 unresolved. Do not deduplicate legitimate
   identical network records by content hash.
4. The sole temporary legacy read is selected by stream-state provenance, never
   by catching an arbitrary database or authorization error. Keep old network
   cursors bound to their legacy stream until a verified client drain. New
   owned streams emit a versioned opaque cursor containing order, timestamp
   and entry ID; the API dispatches by cursor version. An imported stream
   cannot switch its reader while supported clients can still resume its old
   Axiom cursors. Do not reinterpret an Axiom tie-breaker as a PostgreSQL ID.
   [Cursor source](../../turbo/apps/api/src/signals/services/log-pagination.ts)
   uses `cursor_current()`, not an interchangeable event ID. New API writes owned records for old Runner payloads.
   New Runner record IDs must be additive and accepted/ignored safely by the
   supported old API. Existing frontend response shapes remain unchanged.
5. Remove unnecessary content export and switch remaining diagnostic records
   to allowlisted fields. Production rollback targets must understand owned
   diagnostics before stopping the old writer. Drain old API instances, queued
   commit-addressed CLIs, active/finalizing guests, installed clients and SDK
   buffers under [deployment compatibility](../deployment-compatibility.md).
   Never size this gate from nominal pipeline duration. Do not restore the
   content-exporting writer as a rollback after historical erasure begins.
6. Remove the provenance-bound Axiom reader only after imports/gap dispositions,
   all relevant producer/client drains and compatible rollback targets are
   verified. The implementation PR must declare this fallback, its measured
   exposure window and a controller-owned removal follow-up under
   [fallback policy](../fallback.md). G1 creates no implementation owner.

For diagnostic-only exports, use registered operation/command names, build,
component, outcome/error code and aggregate latency/counts. Remove
`process.argv.slice(2).join(" ")`, helper path/stderr, free-form exception and
breadcrumb serialization, raw request IP/user-agent/path fallback, environment
values and full AgentEvent export. Apply allowlists at console/file and exporter
boundaries, including OTel automatic spans; masking a few secrets is insufficient.
Review registered command names without traversing user-supplied flag values.
If troubleshooting genuinely needs account-linked context, use the owned store.
Only demonstrably non-attributable aggregation may remain in shared telemetry;
run IDs, stable hashes, click IDs and organization IDs are not anonymous.

### 4. Historical provider adapters and bounded remedies

Read the [capability table](../account-erasure-evidence.md#provider-capabilities-and-required-access)
before implementing an adapter. Do not build against an unresolved API.

**Axiom:** APL can discover selectors; it does not erase rows. Public dataset
delete/trim/vacuum operations do not establish account-scoped physical erasure.
First require a provider-supported selective purge with replica/export scope
and terminal proof. If unavailable, the controller must authorize a bounded
replacement of each affected shared dataset: fence old writers; export and
validate surviving records into a deletable destination; scrub only applicable
associations in mixed records; prove survivor completeness and billing-domain
independence; switch every reader; and obtain provider-supported destruction
and proof for the retired copy and its replicas. This is a reviewed whole-store
migration, never an automatic per-account shared-dataset delete. Completeness
requires a consistent export/watermark and lossless pagination; if Axiom cannot
provide those or irrecoverability proof, the remedy remains blocked. Keep the
old store inaccessible to deleted accounts while pending, without calling that
erasure. Do not copy surviving content into another immutable shared sink.

**Sentry:** Enumerate all projects/environments, collect attributable event IDs
and attachments before losing aliases, and classify mixed-user issues. The
documented issue DELETE is asynchronous and is eligible only for an issue whose
entire contents are proven in scope. It cannot be used for a mixed issue. Require
Sentry's supported selective privacy operation for those issues, including
attachments, crash reports, session/replay stores and exports. If unavailable,
apply the same survivor-preserving replacement gate as Axiom; verify export
fidelity and provider purge semantics before approving any project retirement.
Future Sentry events must be content-free/non-attributable, or their attributable
diagnostics must use the owned store. Changing fingerprints or resolving issues
does not remove historical events. An attachment-free sample is not an inventory.

**Langfuse, if applicable:** Capture every endpoint/project, the versioned
`vm0-user-<sha256("vm0:pi-langfuse-debug:" + userId)>` selector and normalized
run UUID trace ID, plus plugin-created trace/session IDs. Use documented
`GET /api/public/traces` pagination with account selectors and capture immutable
trace IDs before deleting. Do not delete while walking an offset-paginated
result set: finish a bounded time partition into the durable ID manifest, then
delete that partition; rescan late arrivals after drain. Use batches of at most
50 as an implementation budget, lowered to the deployed API's documented limit,
or the documented single-trace DELETE when batch support is unverified. This
budget is not a claimed provider limit. Persist partial failures per trace;
respect `Retry-After`, back off on 429/5xx and stop on auth/schema errors.
Verify authenticated single-trace absence **and** selector enumeration after
drain; compare access using the unchanged project identity and a surviving
synthetic trace. Usually 15 minutes is not a deadline that implies success;
poll at 1/2/5-minute intervals for at most 30 minutes per worker lease, then
remain pending with a next attempt. Related observations/scores are covered by
the documented trace operation; independently inventory dataset items, dataset
runs, media, audit records and blob exports and give them separate work items.
No saved/exported content receives an exception because tracing is switched off.

**PostHog:** Resolve person UUIDs and all distinct IDs/merged aliases across
projects and historical hosts. The documented person/bulk deletion must request
both `delete_events=true` and `delete_recordings=true`; do not delete shared
organization groups as a substitute. Persist person UUIDs before their records
disappear. Check `persons/deletion_status/` for the matching request and non-null
`delete_verified_at`, then verify profile/event/recording absence and alias
coverage after producer drain. The operation covers events captured before the
request, so late batches require another sweep. Record export destinations
separately. A missing person/status result is not proof for anonymous events or
previously lost aliases. Disable future personal enrichment or use fenced
ingress. PostHog source/configuration is proven; live project capabilities here
remain unverified. Google Ads conversion copies have a separate unresolved
inventory/capability item; conversion retraction is not established as erasure.

**Local and exported copies:** D/E provide owner-aware host/cache and object
manifests to the same parent job. Include Runner rolling logs, stderr/journals,
storage archives, workspace images and **both** history-sidecar body slots plus
temporary files. Coordinate leases and all host incarnations before unlinking;
shared cache objects need surviving-reference checks, not a broad host wipe.
Verify absent bytes, no open producer/reader handles, no re-publication, and
the disk/snapshot/backup layer's applicable erasure guarantee. Inventory log
drains, support/analysis exports and vendor backups separately. Log rotation,
filesystem unlink and S3 delete markers alone are not physical proof.

### 5. Recovery-copy erasure and restore replay

Build a production-lineage graph, not a list of names: provider/project/region,
branch ID and parent/recovery source, snapshot ID and captured LSN/time, deleted
branch recovery metadata, earliest actually restorable frontier, external
backup/object version identities and all derived preview/restore branches.
Manual snapshots without expiry remain pending. Include copies derived before
the deletion even if their creation time is later. Ordinary TEST-project PR
previews are included only if actual production/account lineage is established.

Logical row DELETE cannot rewrite old WAL/pages/snapshots. When selective
physical erasure is unavailable, require a provider-supported replacement:
construct a new root from an authorized, consistent logical export of surviving
nonbilling records and preserved billing ledgers; replay concurrent authorized
writes/deletions through a cutover watermark; verify survivor and billing
reconciliation; then retire every affected old lineage through the provider's
supported purge. Do not clone the old physical lineage and call it clean.
For required historical recovery points, produce sanitized replacement copies
under the same isolation and replay rules before retiring originals. The
controller must resolve export correctness, restore coverage, cutover and
provider irrecoverability evidence before dispatching that operation.

A root branch cannot be removed through Neon's branch-delete operation.
A clean new project plus supported old-project retirement, or another
provider-approved root/history purge, must be established before that remedy
can execute; creating a child branch is insufficient.

Neon's public statement that deleted snapshots cannot be recovered applies to
that snapshot operation, not all branches, provider backups or related history.
Record operation completion, refreshed inventory including deleted branches,
actual recovery frontier and provider guarantee/receipt for each removed copy.
Do not infer these from `history_retention_seconds`, an elapsed expiration,
branch DELETE, a scan that could not run or shared KMS key rotation. Restoring
a copy to verify it can create another copy; record and erase that child too.

Restore safety is necessary while physical work is pending, but it does not
make retained nonbilling content compliant. Use a dedicated PostgreSQL control
database in a separate project/IAM boundary from the recoverable production
project; provisioning and its own recovery/deletion guarantees are unresolved
NE-1 prerequisites. Its `deletion_decisions` table has `sequence bigint` PK,
`subject_id text`, `generation bigint`, `requested_at timestamptz`,
`disposition_version integer` and bounded replay state, with unique
`(subject_id, generation)`. A separate admission table is keyed by restored
project/branch and records attested watermark, schema/worker version and lease
expiry. Append decisions and compare-and-set admission leases in serializable
control-store transactions. This gives atomic watermark/lease decisions
without pretending that the main DB and provider APIs share a transaction.
Define the following interlock:

1. B durably appends a signed, monotonically sequenced deletion decision to a
   dedicated control store **outside the production database's restore lineage**
   before acknowledging the authoritative deletion event. It contains only
   subject identity/generation, requested time, ownership-disposition version
   and replay state. No prompt, full manifest or profile. If its append or
   required fence persistence fails, acknowledgement fails; idempotency bridges
   the external append and main-DB job commit. No cross-provider transaction is
   assumed. The main DB can rebuild missing jobs from this source.
2. A restored database is quarantined: no application credentials, user
   connections, public URLs, timers, Runner claims, connector watches or
   telemetry egress. The restoration role cannot promote it or issue serving
   credentials. An API-only check is insufficient against direct DB access.
3. The restore verifier reads the external decision stream using separate
   credentials. It replays **all retained applicable decisions**, not merely
   those timestamped after the recovery point: an older job might have been
   incomplete in the snapshot. C2/D/E/G2 recompute scoped locators from the
   isolated copy, preserve billing and surviving members, and suppress exports.
   Recovered/transferred-identity decisions require controller reconciliation;
   ambiguous scope blocks promotion.
4. Catch up to an externally read decision watermark; verify residuals,
   billing invariants and all manifests. Publish a signed attestation bound to
   the exact project/branch ID, recovery point, schema/worker versions and
   decision watermark. New decisions arriving during verification invalidate
   stale attestations. Promotion/admission checks current watermark atomically
   with a short-lived admission lease; new writes remain fenced thereafter.
   If the control store is unavailable, fail closed. A saved attestation must
   never grant indefinite permission to serve an older snapshot.
5. Enforce that gate in every production restore/branch/promotion path,
   including the existing KMS inspection path when it is used for account-data
   restores; content inspection remains isolated. Inventory and verify cleanup
   of the restore verifier's own temporary files and derived branches. Retire
   identity decisions under section 2 only after all affected recovery and
   producer lineages are demonstrably unavailable, including control-store
   backups that carry those identifiers.

The control-store implementation, restore IAM/promotion integration and physical
purge mechanism are concrete controller follow-ups, not capabilities implemented
by this document. They depend on B and the evidence gaps below.

### 6. Implementation boundaries and acceptance

The controller may dispatch source minimization/owned diagnostics independently
of historical provider capability work. Adapters depend on B and the relevant
resolved provider operations; recovery enforcement depends on B, production
lineage and the dedicated control-store/access design. Preserve A1 -> B -> A2
and the parent's C2/D/E/F dependencies. G1 does not create follow-up issues,
owners, releases or historical cleanup jobs.

| Fault or transition                                                                                | Required observable result in G2/H                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context, Activity and network migration; old/new API/Runner/client combinations                    | Surviving account retains exact supported response data, both pagination orders and cursor continuity; no fabricated historical values. Unauthorized account gets the existing not-found response. |
| Delayed export, buffered SDK, retry or restored worker after deletion                              | Fence blocks re-creation; final sweep observes no applicable arrivals after a proven producer boundary. Another account's events still arrive.                                                     |
| Provider returns 2xx while data remains; partial batch; 429; network timeout after submission      | Durable per-item state resumes without losing selectors, respects backoff, reconciles uncertain effects and stays pending until verified.                                                          |
| Source rows removed before selector capture                                                        | Transaction/barrier rejects removal. Already-lost historical selectors yield a named unresolved item, never success.                                                                               |
| Deleted account owns private roots under another member's agent; surviving organization            | Own roots erased, surviving roots preserved, personal associations scrubbed, organization billing not cancelled.                                                                                   |
| Platform usage/charges/allowances/orders/refunds versus bank connector content                     | A1/A2 raw and rollup reconciliation passes; required billing remains readable without run content; connector business content is erased.                                                           |
| Account recovered September 12; ambiguous historical identity                                      | Excluded or blocked by controller-approved identity reconciliation; no deletion inferred from `users` absence.                                                                                     |
| Restore older than decision, restore containing an incomplete earlier job, or control-store outage | No credentials/egress/serving before replay and current-watermark attestation; outage and concurrent decisions keep it quarantined.                                                                |
| Configured retention expires, snapshot scan fails, or branch DELETE succeeds                       | Item stays pending until the specific copy's supported irrecoverability proof passes.                                                                                                              |
| Manifests/evidence cleanup; storage/cache reuse                                                    | No locator lost before completion; no permanent subject audit archive; shared surviving references preserved and all affected versions/body slots verified.                                        |

Run these against synthetic deleted and surviving subjects under separately
authorized acceptance. G1 validation is documentation formatting, links and
source/evidence consistency. It cannot run these deletion behaviors safely and
does not claim to have done so.

## Consequences

Product diagnostics become explicitly owned data with transactional deletion
and reader compatibility. PostgreSQL storage/load and historical import volume
must be measured before rollout. This does not solve physical backup erasure
by itself. Shared immutable telemetry, missing historical selectors, provider
exports and unsupported selective purge remain visible parent blockers until
the controller's implementations and production verification resolve them.
