# Deployment Compatibility

This document focuses on three independently deployed surfaces that have
cross-version API or persisted-state compatibility boundaries:

- **Frontend**: browser-delivered web application code.
- **Backend**: API service code in `turbo/apps/api`, plus any intentional
  web-origin rewrites that forward selected `/api/*` paths to the API service.
- **Runner**: long-running runner processes plus the guest binaries shipped
  with that runner.

Other release artifacts, such as the desktop app and host-worker deployments,
have their own release paths and are outside this compatibility model unless
they interact with these frontend, backend, or runner boundaries.

New versions are normally deployed together, but they do not become active at
the same instant. Code and tests must account for periods where different
surfaces are on different versions.

## Deployment Model

### Frontend

Frontend deployments publish new browser assets, but users who already have an
app page open keep running the JavaScript that page loaded until the page
navigates or refreshes. The app does not poll for a newer build or automatically
reload an open page.

The current force-upgrade mechanism is driven by API responses. Standard app
API clients send `X-Client-Type: App` and a build-time `X-Client-Version`. Before
route handlers run, the API rejects an app request whose parseable advertised
version is below the floor in
`turbo/apps/api/src/lib/web-client-compatibility.json`. The general floor does
not reject a missing or unparseable `X-Client-Version`.

An incompatible request receives `426 Upgrade Required` with `Cache-Control:
no-store`. The shared contract client and fetch wrapper turn that response into
a global UI state that displays a non-dismissible update dialog. The dialog's
only action calls `window.location.reload()`. The app therefore forces the user
to choose a refresh before continuing; it does not force the reload without
user action, and an idle page does not discover the requirement until it makes
a handled API request.

The shared database Worker reports the same response to its connected tabs as
a `worker-unavailable` event with reason `force-upgrade-required`. Tabs route
that event through the same update dialog instead of reloading automatically.
Worker load and transport failures reject pending requests with their original
error. The Worker reports no separate connection status: tabs observe transport
health through the outcome of their own requests and subscriptions. Queries and
computed reads have no time limit and remain cancellable through their owning
lifecycle. An IndexedDB version change closes the affected connection and
reports it as unavailable.
These failures propagate through the normal error handling without reloading
the page.

The platform app also registers a service worker. Service-worker code is a
browser-resident deployable surface, so changes to its behavior must account for
old controlled clients during rollout. The current service worker calls
`skipWaiting()`, but it does not intercept fetches or reload clients on a
controller change, so it is not the force-upgrade mechanism.

Raise the minimum supported web-client version only after the corresponding app
build is live. Production promotes API traffic before it promotes the app. If
one release both introduces the replacement frontend and raises the API floor
to that new version, the new API can start returning `426` while the frontend
origin still serves the previous build. A user can then accept the prompt,
reload the same unsupported build, and receive another `426`.

Treat a floor increase as a later cleanup boundary, not as the initial rollout
mechanism. First deploy an API that accepts both protocol versions and a
frontend that starts using the new version. In a later release, after the
replacement frontend is live, raise the floor and remove the old API contract.
This ordering also keeps already-open pages working until the API can direct
them to refresh into a build that is actually available.

The backend must therefore tolerate requests from the previous frontend version
after a backend deployment. When changing an API used by the frontend, keep the
old request shape working until old browser clients can no longer reasonably be
active, or introduce a versioned/new endpoint and migrate the frontend first.

#### Connector App retirement

The first singleton-free connector App release is `0.843.1`, built from
`3795939e97660ef4228122a57e3f6425b1e413c2` and promoted on
2026-09-05 at 04:24:28 UTC after #29773 / #31780. Issue #29775 raises the API
App floor to that version in a later release. Verify the deployed artifact,
not only the GitHub deployment's moving-main SHA: the preceding `0.843.0`
release deployed `30aadb42008af91a999faac6170262dd1de881cb`, which predates
the connector producer cleanup.

Older identified App bundles receive `426` before route handling and use the
existing update dialog to refresh into the supported App. This applies to
all handled App API requests, not only connector actions; idle pages are not
automatically refreshed. No passive browser-expiry window or rollback gate
is required for #29775.

The floor does not retire CLI, unidentified, or missing/unparseable-version
requests. Keep singleton request and persisted authorization-state decoding
until their independent gates pass. The later API artifact
`9def066b4f04898a173da14407a10dc6a0cf66e1` (`api-v1.548.1`) enforced the App
floor on 2026-09-05 at 05:52:29 UTC. The pre-cutoff production request evidence
on #29775 is not proof that account mutations were exercised or stored callbacks
have drained.

For #29776, the explicit retirement decision on 2026-09-05 invalidates all
remaining `single-account` authorization attempts, without waiting for natural
completion or requiring a terminal status. Migration `1078` deletes only rows
with that mutation intent from `connector_oauth_states`,
`connector_oauth_device_authorization_sessions`, and
`connector_external_code_sessions`. It preserves explicit `add` / `reconnect`
attempts and does not delete connected accounts, credentials, or permissions.
An old callback or poll that can no longer find its state uses the existing
missing/invalid response; the user must start a new connection attempt.

Deleting a row does not universally cancel requests that already loaded it or
revoke an account they already created. Keep current request and stored-state
decoders in the cleanup release. The normal migration transaction and timeouts
apply; a failed cleanup blocks release and rolls back. #29777 removes the
remaining singleton contract only after this migration release succeeds.
Investigate unexpected new singleton writes rather than adding a cleanup loop.

### Backend

The backend is the compatibility boundary for both frontend and runner traffic.
In the production release workflow, app promotion starts after the API
production lifecycle completes, including any required migration and API
traffic promotion. Newly loaded frontend code therefore follows API promotion,
while already-open browser pages can keep running the previous frontend against
the new backend. Runner promotion still waits for API promotion when the same
release also changes the API. Old runners keep draining against the new backend,
and traffic promotion is not an atomic process visible to every client at the
same instant.

Production database migrations are part of the API release lifecycle and run
before the new API deployment is promoted. Old backend code can therefore
briefly run against the migrated schema. Migrations must be backward-compatible
with the currently deployed backend until that backend is no longer serving
traffic.

Migrations marked with `-- vm0:non-transactional` run one statement at a time
outside a transaction. Successfully executed statements are not rolled back
after a later failure, and the entire migration runs again on retry, so every
statement must be idempotent under a full retry from the beginning. Migration
`0778` demonstrates the required pattern with
`DROP INDEX CONCURRENTLY IF EXISTS` followed by `CREATE INDEX CONCURRENTLY`.

This is a traffic-promotion guarantee, not a guarantee that no deployment
preparation has happened yet. Staged Vercel builds, runner rootfs/snapshot
builds, host provisioning, and other non-serving preparation jobs may complete
before migrations run. API traffic promotion must wait until the required
migrations have completed. App promotion waits for the API production lifecycle,
including its migration and traffic promotion. Runner promotion waits for API
promotion when the same release changes the API.

Backend changes must be safe with:

- old frontend -> new backend
- new frontend -> old backend
- old runner -> new backend
- new runner -> old backend, if traffic propagation or non-production
  deployment order can expose that pairing

### Commit-addressed CLI artifacts

The private CLI used inside supported runs is published as an immutable,
commit-addressed package. When the backend creates run execution context, it
records the configured package URL in `CLI_PKG_URL`. A queued run therefore
keeps the CLI artifact selected at context creation even after a later backend
deployment starts selecting a newer package.

Treat the package commit as the release identity for protocol compatibility.
The package's semantic version may remain unchanged across artifacts and must
not be used as a compatibility floor unless the release process guarantees that
it advances for every relevant artifact change.

When removing a backend response or request variant consumed by the CLI:

1. Deploy a backend that still supports both variants and starts selecting the
   canonical commit-addressed package.
2. Wait through the maximum queue lifetime plus the maximum claimed execution
   and finalization lifetime for contexts created before that deployment.
3. Confirm that no queued or active pre-deployment context, and no explicitly
   supported external caller, can still use the old variant.
4. Remove compatibility in a later backend release.

Presentation runbook content is independent of the CLI release after the
current-template download route is deployed. Current CLIs send only the
resource id and receive the canonical storage HEAD; older CLIs keep using the
existing digest-pinned route and its immutable archive. Publish new template
HEADs only after the current-template route and CLI are in production.

This drain is separate from runner binary drain: a current runner can execute an
older CLI package retained by an older execution context. If the same cleanup
raises the frontend compatibility floor, rolling the frontend below that floor
also requires rolling back the backend floor. Rolling the backend back to the
dual-protocol preparation release remains safe for canonical clients.

#### Instagram nullable views

Instagram stats accepts provider `views` as a nonnegative integer, null, or
omitted. New CLI packages send `x-okou-instagram-views: nullable` on stats
requests so explicit null survives through inspection output. Zero is a verified
count; null is unavailable and is never converted to zero. The optional
`requireViews` input requests the provider's bounded recovery. Its documented
missing-view HTTP 503 returns without managed billing or automatic retries.

The API retains the old response format for callers without that header: only
explicit null views are omitted, preserving engagement, author data, extensions,
and numeric zero. This projection applies to session/PAT and agent/sandbox
requests, alongside the existing provider-identity redaction boundary.

- Old CLI -> new API: unchanged requests receive numeric or omitted views,
  which the pinned older reader accepts. This legacy format cannot distinguish
  unavailable null from an originally omitted field.
- New CLI -> new API: null, omitted, zero, and positive views stay distinct.
- New CLI -> old API: the additional header does not change the old request
  body. Numeric/omitted successes remain readable; the old API can still reject
  provider null. The new strict input is rejected before provider I/O until the
  supporting API is deployed. Deploy that API before selecting the new package.

Keep the old response projection until the backend selects a capable
commit-addressed CLI artifact and the maximum queue, execution, and finalization
lifetimes have passed. Confirm no pre-deployment context or supported external
caller still depends on the old format before removing it in a later release.
CLI semantic versions and runner binary drain alone are insufficient evidence.
Removal is tracked in [#34047](https://github.com/vm0-ai/vm0/issues/34047).

### Instagram search collection limits

Instagram Reels Search exposes one anonymous batch of up to 12 results. The
request accepts only page 1 and a query of at most 100 characters after trimming.
Keyword, hashtag and encoded leading-hash inputs share normalization. The CLI's
request preserves case because Unicode case folding can expand a validated
100-character input; the provider performs its documented lowercase conversion.
The CLI's `--limit` truncates returned items locally; it does not request more
source coverage or forward the OpenAPI's unbounded `limit` parameter.

Search responses retain the existing `provider_limited` collection state and
`provider_ceiling` reason, adding optional
`sourceLimit: { kind: "single_batch", maxItems: 12 }`. Empty and short batches,
including `hasMore: false`, do not establish exhaustive search. The provider's
`count` describes the batch and is not a reported global total.

Retained CLI response schemas accept these existing discriminants and ignore
the new optional field. Current CLI public projection also applies the fixed
source limit to older API responses, including `complete` and page-2 `more`
metadata, so it never follows the unsupported continuation. Aggregate and
streamed terminal output preserve the source limit; `callerLimited` independently
records whether the fetched batch was trimmed. `status: complete` still means
the caller's requested count was satisfied, while collection state describes
source completeness. Unsatisfied source-limited requests remain partial.

No response variant is retired and no CLI drain, schema migration, or release
floor change is required. Rolling back the API retains request compatibility
for the current CLI; it does not restore pagination in that CLI.
Remove the old-API metadata projection and its compatibility-only tests after
every serving API and retained rollback target emits the canonical source limit;
[issue #34053](https://github.com/vm0-ai/vm0/issues/34053) owns that removal gate.

### Social download accounting and media metadata

Social download admission uses the caller's maximum duration rounded up to
started minutes and the requested format/quality tier: audio and SD video use
one provider credit per minute; 720p/1080p video uses four. TikTok ready jobs use
the delivered tier, capped at the requested tier, so a 720p request delivered at
576p uses the SD rate. The default request remains 720p. These are **provider
usage units**; managed usage applies the separately configured Okou retail
price to the validated actual `creditsCost`, once per download job.

The [provider API overview](https://docs.socialkit.dev/api-reference#credit-costs)
documents a 30-day legacy-account pricing transition. Admission conservatively
uses current published tiers, while settlement accepts only the exact current
cost or the prior one-credit-per-minute cost from the authenticated ready job.
It does not assume the production account's transition date or bill the
preflight maximum. Remove the legacy allowance only after verifying the managed
account's transition and that no recoverable historical jobs need the old rate.
Follow-up [#34056](https://github.com/vm0-ai/vm0/issues/34056) owns these gates
and the old-API normalization cleanup described below.
An explicitly unbilled ready response is rejected. Polling headers may report
zero new usage on a paid-link refresh; the original job cost remains authoritative.

The additive response fields distinguish media intent from delivery evidence:

- `quality` and `format` remain request aliases for older CLI artifacts;
  `requested` explicitly contains those same values.
- `provider.quality` and `provider.format` preserve the accepted ready metadata.
  Provider-reported resolution accepts renditions such as `576p`, independently
  of the finite request-quality choices. It is not a byte-level resolution
  measurement.
- `artifact.format` records the byte-sniffed MP4, M4A or MP3 type, or null when
  unrecognized. `delivered.format` uses only that evidence. Existing filenames
  and content types may be request-derived and are not used to infer it.
- `delivered.quality` uses stored provider reporting and is null for audio.
  Missing historical delivery metadata remains null. New artifact recovery can
  establish a sniffed format without fabricating missing original quality.

No relational migration or stored-job rewrite is required. Old JSONB writers
legitimately omit the new optional media fields; new readers keep their original
usage and return unknown delivery metadata. Interrupted settlement and paid-link
refresh keep the same job and usage idempotency key. Refresh metadata must match
the original accepted duration and cost, rather than reprice a paid download.

| Pairing            | Supported behavior                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old CLI, new API   | Existing request aliases and response fields remain valid; additional fields can be ignored.                                                                                                    |
| New CLI, old API   | Optional response fields allow parsing; output adds explicit requested values and null delivered values. Remove this normalization only when old API targets leave the rollout/rollback window. |
| Old API, new JSONB | Additive keys do not change existing required values; rollback retains the old API's pre-existing HD validation limitation.                                                                     |
| New API, old JSONB | Completed jobs remain readable; pending settlement and artifact recovery preserve original usage and unknown media fields.                                                                      |

### Pi Gen1 wire-field retirement

[#33966](https://github.com/vm0-ai/vm0/issues/33966) removes only the optional
Gen1 `piModelConfig.api` field. Slice 1
[#32632](https://github.com/vm0-ai/vm0/pull/32632) stopped writing it while keeping
readers tolerant. The [September 14 controller receipt](https://github.com/vm0-ai/vm0/issues/31085#issuecomment-5660026283)
accepted the writer-cutoff release, supported rollback targets, executable
context census, retained callers and Runner/Sandbox/CLI drain. Its
[dispatch admission](https://github.com/vm0-ai/vm0/issues/33966#issuecomment-5660179289)
reconciled all 17 Pi runs among 50 nonterminal runs and both empty queues. These
are dated complete observations, not current counters.

Old cutoff-safe writers and new readers share the field-absent Gen1 shape;
new writers remain readable by the retained cutoff-safe readers. Strict
TypeScript boundaries reject a Gen1 object containing `api`. Rust keeps its
existing general unknown-field policy, discarding unknown fields during decode;
the generated Gen1 DTO no longer represents, emits or retains this key. Gen1
itself, Gen2/3/4, active subscription dialects and upstream Pi `Model.api` are
unchanged. No stored context rewrite, migration, backfill or rollback-floor
change is required or included. Parent #31085 still owns independent acceptance,
release and final production verification.

### Pi native session history

Pi checkpoint persistence shares the Runner's 128 MiB raw and encoded history
bound. The API-first execution budget remains 16 MiB. Before resource loading or
provider ownership, a larger saved checkpoint selects sandbox-first execution
from blob metadata. A V4 ownership-transfer manifest carries a presigned history
reference; only the sandbox downloads and decompresses H0 for the next turn. The
API still validates complete H2 history at checkpoint time, so its peak memory
and validation work can exceed the raw file size.

V3 manifests remain the active format for API-produced H1 and small
sandbox-first H0. The CLI accepts both formats and retains the same V2 Guest
boundary control; Runner job and launch-config schemas are unchanged. API and
CLI changes must ship through the same commit-addressed CLI artifact selection.
Previously captured contexts retain their package and history reference; new
contexts select the new reader. Old Runners already support 128 MiB history.

Pi remains staff-only behind `PiLoop`. Rolling the API back below this change
restores its 16 MiB validation and resume limit: larger saved histories stay in
storage, but continuing those sessions requires the fixed API and CLI again.
There is no history truncation, migration, or alternate reader for that rollback.

### Runner

#### Pi maintenance usage journal retirement

Producer retirement in [#32787](https://github.com/vm0-ai/vm0/issues/32787)
removes the CLI's private usage journal and Guest forwarding. The existing
runner proxy remains the accounting authority established by
[#32639](https://github.com/vm0-ai/vm0/pull/32639). The independent private
checkpoint validation marker remains required for publication.

The API ACK and journal-only contract are retired by
[#32788](https://github.com/vm0-ai/vm0/issues/32788), under delivery parent
[#32783](https://github.com/vm0-ai/vm0/issues/32783). The parent's dated production
receipt records the endpoint-specific gate:

- Producer stop shipped in Runner 0.189.0 / Guest 0.86.22 and CLI artifact commit
  `82d1a6ff154c9ca81fd8e08d6764290733eb324d`. API and Runner promotion completed
  at 07:00:31 and 07:02:02 UTC on 2026-09-09, respectively.
- The 09:05–09:09 UTC fleet inspection found only Runner 0.189.0 and 0.189.1
  services running on prod-11, prod-12 and prod-13. All older services were
  stopped with no active runs or idle/blank sandboxes. The last old reporting
  service exited at 09:00:56.020 UTC.
- Shutdown destroys owned tasks and stops runtime workers. The old Guest's
  awaited journal retries were process-local, with no durable replay queue.
  Deployed Guest versions no longer read or forward journals, and the serving
  API/Runner versions include the proxy-only accounting prerequisite.

New run contexts select the latest deployed CLI. Although a queued context can
retain its creation-time package URL, that cannot restore forwarding in a new
Guest. Once report-capable Guests and their finalization have exited, waiting
for older CLI URLs adds no endpoint-specific protection. The receipt uses
artifact/source/process evidence, not a database queue census or a claim of zero
endpoint traffic; elapsed time and missing telemetry are not the proof.

Rollback to a journal-reporting Guest is explicitly outside this retirement's
approved compatibility boundary. Such a Guest may fail completion against the
removed endpoint. This cleanup does not change rollback workflows or authorize
production operations.

The 122-minute private binding retention starts at terminal settlement to
protect late proxy usage. It remains unchanged, along with ordinary
pending-usage/callback cleanup blockers, provider-result usage, lifecycle
observation and private checkpoint validation.

#### Runner process drain

Runner deployment is draining, not instant. The production promote playbook
starts the new runner service, verifies it, and then sends a soft-drain signal
to old runner services. Promotion observes a bounded acknowledgement from the
same live process and status generation: Draining/Stopping, or service/process
exit. This acknowledgement does not wait for active runs to finish. Discovery,
signal, status, identity, or acknowledgement failures for an old runner are
reported as promotion warnings while a healthy new runner remains promoted;
promotion does not force-kill the old runner. Before the signal arrives, there
can be a short overlap where both old and new runners are running. After old
runners enter draining, they stop claiming new runs but keep executing already
claimed runs until those runs finish. During that drain window, old runners
continue calling backend APIs with the old protocol.

The backend must support old runner requests until old runners have fully
drained. Runner changes that require backend support must be staged so a new
runner can also survive briefly talking to an old backend.

Rootfs locks are also a host-local cross-version boundary. Every supported
Runner release coordinates through `rootfs-{hash}.lock`, and callers acquire
all rootfs locks before any snapshot lock. A canonical-only release can overlap
and roll back with bridge-capable predecessors through that shared identity.
Keep the rollback floor bridge-capable. Delivery parent vm0-ai/vm0#30478 remains
open until the canonical-only artifact is promoted, bridge processes drain, and
the final fleet verification completes.

Rootfs build scripts retain those same flock descriptions in an external
`unshare --fork` waiter until their private PID namespace has terminated. The
waiter starts in a separate session so owner death cannot orphan a stopped
process group and send it a job-control `SIGHUP` before cleanup completes. The
owning runner's death or cancellation closes a process-local control channel;
namespace init then exits and the kernel terminates its descendants, including
workers behind `sudo`. The waiter must not be killed as a cancellation shortcut:
lock availability is the boundary that allows another builder or GC to touch
staging. In-process shared ownership also keeps the flock and extracted scripts
alive until the blocking spawn-and-wait task finishes. Existing builders and GC
need no new lock file or persisted metadata to respect this exclusion.

This containment applies to scripts launched by the new runner, not orphaned
workers already launched by an older artifact. PID values are namespace-local;
shared build caches must use independently unique temporary filenames instead
of treating a script's PID as a host-wide unique attempt identity. Debootstrap
cache staging uses `.tmp.mktemp.<random>.tar`; new GC recognizes both that format
and the previous `.tmp.<pid>.tar`. Older GC still respects the shared cache lock,
but counts leftover new-format staging files toward stable-cache retention until
it is upgraded (potentially causing a cache miss, not exposing an active build).

Runner and guest binaries are deployed as one runner artifact. Compatibility is
not required between a runner binary and a guest binary from a different version.

Use **sandbox** for provider-neutral runner lifecycle, ownership, status,
network-policy, and operator concepts. Use **VM** only for concrete
Firecracker/KVM implementation details such as the Firecracker `/vm` API, VM
pause and resume, snapshots, vCPUs, VMGenID, KVM, and Firecracker processes.
Product brand names, the established environment-variable namespace, and fixed
paths are not lifecycle terminology and remain unchanged.

Each runner version's `status.json` is a host-local persisted cross-version
boundary. Current runner maintenance commands can inspect status files written
by previous runner versions, rollback can expose an older command to a newer
status writer, and the independently deployed host monitoring collector scans
every versioned runner directory. Status schema changes must cover those
old/new combinations rather than treating the file as process-private state.

Current status writers publish exact inventory in `idle_sandboxes` and ready
blanks in `blank_sandboxes`, omitting each collection when empty. Exact entries
contain `reuse_key` and `sandbox_id`; blank entries contain only `sandbox_id`,
never a run ID or tenant reuse identity. Both collections are captured from one
pool revision and applied together, including preparing/running ownership
transitions. The migration tracked by
[#32071](https://github.com/vm0-ai/vm0/issues/32071) separates these identities
without changing shared pool lifecycle rules.

Internally, the same `IdlePool` owns exact reuse-key and blank sandbox-ID
indexes. They share capacity limits, budget ownership, parking gates and a
mutation revision; they are not independent pools. Exact lookup, exact-first
restoration, blank-first pressure eviction and conditional exact aging retain
their existing policies. Heartbeat reuse inventories contain exact entries only.

Doctor and the host collector read `blank_sandboxes: [{"sandbox_id": "..."}]`
directly. Missing collections default to empty, including exact-only historical
statuses without `blank_sandboxes`; malformed present collections are invalid.
Blank identity is never inferred from an idle reuse key. Explicit blank IDs
suppress same-file idle mirrors, and duplicate blank IDs count once. Doctor lists
exact reuse keys under Idle and sandbox-ID-only entries under Blank, recognizes
both as owned processes, and never treats an unclaimed blank as an active job.
Active mappings take priority over duplicate blanks.

The collector exports `vm0_runner_sandboxes{state="blank"}` (including zero).
`state="idle"` now counts exact inventory only; total parked inventory is the
sum of `idle` and `blank`. Active, preparing and unknown counts keep their meaning.
Use `sum by (instance) (vm0_runner_sandboxes{state=~"idle|blank"})` for a per-host
parked total; replace/group additional host identity labels as needed. Summing
all states gives total recorded sandbox inventory. UUID deduplication across
non-stopped version files uses `idle > active > preparing > unknown > blank`:
an active/claimed record supersedes a duplicate old blank, preserving the existing
priority between non-blank states. Stopped files are excluded. Sandbox IDs, run
IDs and reuse keys are never metric labels. Existing Grafana panels selecting
only `idle` will now show exact inventory; this change does not edit dashboards.

The collector is installed by host provisioning, independently of Runner
releases. Both its systemd timer and Alloy textfile scrape run every 15 seconds.

The reader-first rollout delivered doctor and collector support in
[#32092](https://github.com/vm0-ai/vm0/pull/32092), followed by the explicit writer in
[#32269](https://github.com/vm0-ai/vm0/pull/32269). The first explicit-writer release
is `runner-rs-v0.188.0`, commit `f4b9a172cf76e04b845f2337c14cf87831c82adb`.
Legacy blank input recognition is retired by
[#32084](https://github.com/vm0-ai/vm0/issues/32084), based on read-only production
verification on 2026-09-07 at 14:20 UTC:

- `prod-11.gcp.vm3.ai`, `prod-12.gcp.vm3.ai` and `prod-13.gcp.vm3.ai` each had
  `v0.188.3` running and `v0.188.2` draining. Both releases contain explicit-writer
  commit `bd9cddcf6719c90848ed4ec497baca8cfd3191ea`. The remaining draining release
  therefore does not require legacy input recognition.
- The legacy writers were stopped. All 18 retained versioned status files parsed
  successfully and contained no synthetic blank entries.
- Each installed collector matched repository SHA-256
  `560cb9b86e29357249582273253716f48be63df93cd6f04f12dabb4ffa499f42`, and each
  collector timer was active. This is the pre-cleanup, bridge-capable collector
  checksum, not the checksum of the retired-reader implementation.

The explicit retirement decision excludes rollback compatibility with legacy
writers; this cleanup does not change rollback resolution or promise that those
writers remain readable as blank inventory. Current explicit writers work with
both bridge and post-cleanup readers during deployment. No production process or
status file was modified to establish the evidence. Verify the final doctor and
independently provisioned collector rollout before closing delivery parent
[#32071](https://github.com/vm0-ai/vm0/issues/32071); a merged PR alone does not
establish that deployment.

The proxy registry and embedded mitm-addon are also a runner-private contract.
The runner binary embeds the addon sources, recreates the addon directory and
registry at startup, and keeps them in its version-specific base directory.
Their registry schema and process-local flow metadata can therefore change
atomically in one runner release without fallback keys or cross-version readers.
This exemption does not extend to registry data persisted outside that runner
artifact or consumed by an independently deployed component.

Each sandbox is owned exclusively by the runner process that created it. A
different runner never adopts that sandbox, and stopping the owning runner also
destroys its sandboxes. Sandbox-local runtime files are therefore private to one
runner artifact and one sandbox lifetime. They do not need schema versions or
cross-version readers; this includes metadata exchanged only between the runner
and its bundled guest binaries, such as final session-history identity metadata.

Workspace caches have a different lifetime. A cache image, its metadata, and
its session-history sidecar can outlive the runner process that produced them
and be consumed by a later runner artifact. Treat workspace-cache formats as a
persisted cross-runner compatibility boundary. A format change must either keep
older cache entries readable or explicitly invalidate and purge incompatible
entries before a new reader depends on the change.

## What Requires Compatibility

Compatibility is required across deployable boundaries:

- Frontend -> backend API requests and responses.
- Runner -> backend poll, claim, heartbeat, log, artifact, completion, and other
  runner-facing APIs.
- Backend data written by one version and read by another version during a
  rollout.
- Database schema migrations applied before every backend instance is running
  the new code.
- Queue, persisted job payload, and run/session state consumed by runner or
  backend code from different versions.
- Workspace-cache images, metadata, and sidecars that can be written by one
  runner artifact and read by a later runner artifact.

Compatibility is not required inside one deployed artifact:

- Frontend package-to-package internals inside the same browser build.
- Backend package internals that are deployed as one API build.
- Runner internals shipped in the same runner binary.
- Runner-to-guest binary internals shipped in the same runner artifact.
- Sandbox-local files and state that exist only for one runner-owned sandbox
  lifetime.

## Required Change Patterns

Prefer additive changes at cross-version boundaries:

- Add optional request fields before making them required.
- Add response fields without requiring old clients to read them.
- Keep accepting old enum values while old clients can still send them.
- Keep old endpoint paths or add a forwarding/versioned path during migration.
- Make readers tolerant of missing newly added persisted fields.
- Keep migrations additive or otherwise compatible with the old backend during
  the rollout window.
- Write data in a format that the previous deployed reader can ignore or safely
  process during the rollout window.

An optional response or persisted field is not automatically compatible with
strict readers. When retaining the same protocol version, deploy tolerant
readers first while writers omit the field. Activate writers only after every
old strict reader and rollback target has drained or is excluded by an enforced
compatibility floor.

Chat Event V7 failure reasons use this pattern. Reader commit
`c093e0ffdab988d2a8a071809f90d87fa3e79f20` shipped in release
`89c6a521944e2ac8550da424f164db08f4f80f0c` before writers were enabled. App
builds below `0.830.0` are excluded by the API client floor, commit-addressed
CLI contexts must drain through queue, execution, and finalization, and the
production rollback resolver rejects targets that do not contain the reader
commit. The reason is stored outside strict payload JSON so old API instances
remain compatible during the additive database migration and traffic overlap.

Avoid one-shot protocol flips:

- Do not require a new request field from frontend or runner in the same PR that
  first adds the client sender.
- Do not remove a response field while old frontend or runner code may still
  read it.
- Do not delete runner-facing endpoints or payload variants until old runners
  have drained in production.
- Do not persist data that the previous backend or runner version cannot parse
  unless the old reader is no longer active before the writer is deployed.

When an incompatible change is unavoidable, split it into phases:

1. **Prepare**: backend accepts both old and new protocol; readers tolerate both
   old and new persisted data.
2. **Migrate**: frontend or runner starts using the new protocol.
3. **Clean up**: remove compatibility logic only after the old deployed version
   is no longer active.

Before a destructive clean-up migration, verify that the replacement version is
healthy and every reader that needs the old schema has drained. After the
cleanup, rolling back to a version that requires the removed schema is unsafe;
recovery must restore compatibility first or roll forward.

Compatibility code should be temporary and explicit. Include a short comment
with the rollout reason and the condition for deletion, or track the cleanup in
a follow-up issue when the deletion cannot happen in the same PR.

### Okou Goal retirement rollback floor

The production rollback resolver requires the release/API target to contain
Goal retirement commit `6d391117e4fead19e2105136fb2792a6e77801d8`. The first
compatible release is `1f68f182a2457ec3aea52d8063be2bd2d2263abd` (API 1.571.1).
This permanent floor prevents canonical rollback from restoring Goal creation,
reactivation, or continuation. It rejects pre-boundary targets before API or
Runner artifact resolution and output publication, even if the rollback
dashboard still lists those historical releases.

S5 additionally requires **both** accepted consumer-removal commits:
`2c231766e383b651867893852cfb47dcc78af0bd` (original S4) and
`077a9a644986e13bed4750796f91e55c4a876aad` (ordinary-write repair).
The first independently verified compatible release is
`4a4881bf84cb1d79723fd38c83e00f2215bb1e31` (API **1.580.0**),
[accepted in production](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5618238710).
S1/S2/S3-only targets and original S4 without the repair fail before API or
Runner artifact resolution or output publication. The S1 retirement floor and
all unrelated reader, main ancestry, release-tag and artifact checks remain.
This stronger resolver was effective from current main before physical
contraction shipped.

Apply these API floors only to the release/API target: the first compatible release
retained an older Runner tag. All independent Runner ancestry, reader, host
architecture, and release-asset checks still apply. The rollback workflow loads
the resolver from current `main`, so merging the guard constrains future
canonical executions without a release or test rollback.

The accepted S1 gate verifies the currently serving normal production version
rejects Goal creation/reactivation and cannot continue Goal work. Historical
Vercel/fixed-deployment inventory is outside that gate under the
[user decision](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5595137042);
this does not claim those deployments were disabled. Keep the rollback floors and
permanent [history/accounting contracts](goal-retirement-archival.md) in
[EPIC #32653](https://github.com/vm0-ai/vm0/issues/32653).

S4 [#33061](https://github.com/vm0-ai/vm0/issues/33061) removed application Goal
schema consumers while preserving physical state; its ordinary-write repair was
also required before contraction. **The S1 floor alone remains insufficient.**
Never select an S1/S2/S3-only target or unrepaired S4 after contraction.

**S5 was independently production accepted on 2026-09-10.** The
[acceptance record](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780)
distinguishes #33253's failed production DDL (`40P01`) from Ethan's successful
#33307 at `9c777819776d2bed0cfdb110653e46dcaffc0e8b` (API 1.582.0 / App 0.884.1).
Actual production 1106 DDL, helper cleanup/timeout resets and the awaited journal
INSERT preceded `Migrations complete` at **17:21:49.5878347 UTC**. The controller
byte-verified that path and fresh physical metadata with unchanged masking policy;
MaskDB exposes no journal or constraint/procedure catalogs, so no direct SELECT
of those rows is claimed. This closes the physical-schema transition under
[the migration retirement gates](../turbo/packages/db/MIGRATIONS.md#retired-goal-transition-validators-2026-09-10).

S6a removes the expired Goal validators and pre-contract fixture variants, while
retaining permanent current-schema SQL, literal history, accounting, race and
security coverage. The [S4 record](goal-retirement-archival.md#s4-application-consumer-removal-33061)
still documents historical/security references and bounded captured contexts.
Numbered 014 remains a completed historical operation, not a current execution
path. Both rollback floors remain unchanged; this cleanup authorizes no release,
rollback, production operation or official resource/workflow disposition.

### Computer Use host client_product rollback floor

The production rollback resolver requires the release/API target to contain
`669d0befc9a181e44e3f1f9e39093efddabcc0f8`, which removed the
`computer_use_hosts.client_product` ORM declaration and dropped the physical
column in migration `1107`. Drizzle builds column lists from the declaration
rather than from usage, so the declaration removal and the physical contraction
had to ship in one release. That release is therefore a rollback barrier.

Canonical rollback promotes App, Runner, and API artifacts and does not restore
an older database schema. Once `1107` has run, an earlier API build still names
the dropped column in every insert, bare select, and bare returning, failing
with `42703` and taking out host registration, heartbeat, host stop, and
host-command claiming until a forward fix. This permanent floor rejects
pre-drop targets before API or Runner artifact resolution and output
publication, even while the rollback dashboard still lists those releases.

The floor is effective from `main` as soon as it merges, and no tagged release
satisfied it at that point. Canonical production rollback is therefore
unavailable by design until the release carrying `1107` is promoted: the
resolver rejects every target as predating the drop, and recovery in that
interval is roll-forward. Promoting that release closes the interval.

The first compatible release is the one carrying migration `1107`; record its
tag here once that release ships. Apply this floor only to the release/API
target: the independent Runner ancestry, reader, host architecture, and
release-asset checks are unchanged. The rollback workflow loads the resolver
from current `main`, so merging the floor constrains future canonical
executions without a release or test rollback.

### Usage pack visibility compatibility retirement

`showUsagePack` has an explicit API writer and billing response starting with
commit `65ac0518bde2310887470cb0874aeae06c0c0397`, first released in
`api-v1.570.0` (`22c62b9e92f42078ae314e505b983a62eda35dac`). Its
[API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34227208941/job/102068385804)
completed on 2026-09-08 at 12:54:51 UTC. The later `api-v1.572.1` artifact
(`561b7d6bf0da6ccca2542c0f9cd053d67151ba31`) also completed
[API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34297728653/job/102298538957)
on 2026-09-09 at 01:11:34 UTC.

Migration `1092` removes the temporary legacy-writer trigger and function after
this rollout. The billing response now requires the flag, and the frontend
reads it directly. The existing Okou Goal retirement rollback floor requires
commit `6d391117e4fead19e2105136fb2792a6e77801d8`, which descends from the
explicit usage-pack writer commit. Its first compatible release is API 1.571.1,
so every permitted rollback target also contains the required writer and
response. The resolver runs from current `main` and rejects older targets before
artifact resolution, including entries still retained in the rollback dashboard.
Keep this enforced boundary when retiring the usage-pack compatibility bridge;
all other deployment and Runner rollback checks continue to apply.

The cleanup retains existing visibility values, the physical
`member_invite_usage_pack_required` column and its ORM declaration, and all
existing admin requirements. It does not change usage-pack balances or purchase
eligibility. Further legacy-column retirement remains tracked in
[issue #32575](https://github.com/vm0-ai/vm0/issues/32575).

#### Invitation and Free-member contract cleanup (2026-09-14)

The Free-member API and App shipped in commit
`b8b18c4aed6a054791b7a3a5209ad7a6112c4217` (#32573). Release
`3d58eaa4609967a4f655f7cd61d0d7cd454ba2a1` contains that commit and promoted
API 1.575.2 at 2026-09-09 09:48:46 UTC and App 0.873.0 at 09:50:38 UTC.
The [App promotion log](https://github.com/vm0-ai/vm0/actions/runs/34335229479/job/102417989571)
verifies that exact artifact SHA, rather than a moving deployment SHA. App
0.873.0 uses billing `status` for invitations and accepts an empty all-Free
migration configuration. It ignores `memberInvitationAllowed` when `status`
is present.

The later [API promotion](https://github.com/vm0-ai/vm0/actions/runs/34794788803/job/103826080723)
and [App promotion](https://github.com/vm0-ai/vm0/actions/runs/34794788803/job/103826582194)
of `826d131351049b7f35f45cad577618e01b231544` succeeded on 2026-09-14 at
01:11:42 and 01:13:20 UTC. The App log verifies the 0.893.7 artifact at that
SHA. Both the serving release and the existing enforced API rollback floor
`669d0befc9a181e44e3f1f9e39093efddabcc0f8` descend from #32573. Those API
readers use `status` and `show_usage_pack`, and their catalog and management
responses always advertise `supportsFreeMembers: true`.

This cleanup raises the App floor from 0.857.0 to the already-live 0.873.0,
removes the derived `memberInvitationAllowed` response alias, requires explicit
Free-member support, and removes paid-only catalog/management fallbacks. The
API returns all-Free migration configuration without requiring an opt-in. The
App's existing migration query opt-in remains necessary when it reaches a
supported rollback API; keep the query and its contract until every supported
API returns configuration unconditionally. The general floor's existing
handling of missing/unparseable versions and other client types is unchanged.

All application entitlement access now uses `runtime/org-plan-entitlement`.
That mapping excludes both old invitation columns from INSERT, SELECT and
RETURNING, and the canonical writer stops mirroring `show_usage_pack` into
`member_invite_usage_pack_required`. The migration-only schema declarations,
physical columns, status-mirror trigger/function and transition validator stay
in place. Removing them in this same release would break outgoing API SQL
between migration and promotion. No schema migration or rollback-floor change
is part of this preparation release.

Migration 1130 below subsequently handles the three entitlement triggers and
enforces the canonical-only rollback artifact. To finish the remaining #32575
column/client cleanup:

1. Preserve the 1130 serving/rollback evidence below and confirm its production
   journal completion before treating its trigger contraction as shipped.
2. Generate the column-drop migration with Drizzle. Audit remaining persisted
   SQL first, then drop both legacy columns. The entitlement triggers/functions
   are removed by #33747 migration 1130; preserve its journal and transition
   evidence. Unrelated triggers are outside #32575.
3. Remove the App migration query opt-in and contract. Retire the invitation
   transition validator only after its contraction has shipped and permanent
   coverage retains active Free invitations, suspended direct/paid rejection,
   admin authorization, reactivation and explicit `showUsagePack: false`.

### Prepared billing, OAuth and hosting trigger contraction (2026-09-15)

Migration `1130_retire_prepared_domain_triggers` removes A–D's eight triggers
and functions from #33747. The supported rollback floor is API 1.600.1,
`api-v1.600.1`, at `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`; it contains
all four prepared writers, their webhook/cron paths and the canonical-only
invitation mapping. Its [production promotion](https://github.com/vm0-ai/vm0/actions/runs/34915532910/job/104212801721)
records checkout/build and alias publication at 2026-09-15 01:07:30 UTC.
A bounded Vercel read verifies exactly one READY production artifact for that
SHA. The 2026-09-15 02:56–02:57 UTC alias/deployment read resolved API 1.601.0 at
`3ace38cfefa54eb9df33715131a3ee8be1be3c27`, a descendant of that floor.
The rollback resolver enforces the floor before resolving API/Runner artifacts;
the workflow always loads the resolver from `main`.

The prepared API works on both schemas, so migration-before-promotion and an
API rollback to that floor preserve the explicit writes. Current route tests
run with all eight absent; private service suites preserve retained/outgoing
SQL controls until contraction has actually shipped. The migration keeps its
1s lock / 10s statement limits and validates catalog/data under locks before
any drop. Production smoke and production journal completion are distinct
release gates; no production deletion is asserted by this source change.

The invitation status-mirror trigger is included; its obsolete physical columns
and App query opt-in remain #32575 work. E's privacy trigger is excluded, and
the withdrawn feature remains withdrawn. See the
[writer inventory, repair rules and migration receipts](database-trigger-retirement.md#a-d-contraction-migration-1130).

### Workflow automation connector-account projections

Connector-backed workflow event automations persist account authority in an
additive relational projection and, for providers with pre-existing strict
bindings, in provider-specific JSON. The workflow owner's automation chat
thread remains authoritative; persisted connector IDs are derived state for
provider registration, repair, matching, and exact run-source admission.

Gmail, Google Calendar, and Google Meet keep connector identity outside their
strict JSON config and use the nullable relational projection. Google Forms and
Notion retain a JSON connector mirror. Stripe retains its JSON connector,
external account, and mode binding. New writers converge these forms, while new
readers continue repairing legacy null or mismatched state during rolling
deployment.

Do not contract the nullable projection, JSON mirrors, or legacy repair paths
until production evidence shows both that supported old API/rollback versions
have drained and that persisted rows and durable provider work no longer need
the compatibility path. A current writer producing only converged rows is not
evidence that older readers, queued work, or existing rows have drained.

The complete authority, provider, lifecycle, ingress, and failure model is in
[Connector-account workflow automations](./connector-account-workflow-automation.md).

### Locale compatibility

Locale-capable clients receive a `supportedLocales` handshake derived from the
capabilities in their client version. The API projects a stored locale to
`en-US` when the requesting client cannot parse that locale and rejects locale
writes that the client did not advertise. Keep this compatibility layer until
stale browser clients and API rollback windows have closed.

### Treat Database/API Transitions as a First-class Boundary

Schema changes have two independent compatibility directions:

- **Old code after migration**: the migration has changed the schema while
  previous API instances are still serving or draining. Every statement the old
  API can issue must remain legal, including columns that an ORM adds to
  `SELECT` or `RETURNING` lists even when application logic does not otherwise
  read them.
- **New code before migration**: the new API is serving before the migration is
  visible to it. New readers and writers must not require the new column, enum
  value, relation, constraint, or function until the migration is complete.

The normal production release enforces migration-before-promotion in
`promote-api-production`: it builds one API artifact, runs required migrations
against the Neon `production` database, and deploys that exact artifact only
after the migrations succeed. A failed migration stops the job before API
promotion.

For a successful normal release, this closes the new-code-before-migration gate
for its release target. Old code after migration remains a separate boundary:
outgoing, draining, and retained rollback API targets must stay compatible with
the current schema. The production rollback workflow promotes App, Runner, and
API artifacts; it does not restore an older database schema.

The ChatEvent schema-contraction releases from July 27-29, 2026 provide concrete
examples:

- [PR #23148](https://github.com/vm0-ai/vm0/pull/23148), migration `0697`,
  added `event_type`. From about 09:11 to 10:52 UTC on July 27 (102 minutes),
  new App reads, crons, and the automation poller queried it before the migration
  ran and received PostgreSQL error `42703` (`column does not exist`). An
  additive column still breaks a new reader when code wins the race.
- The [PR #23252](https://github.com/vm0-ai/vm0/pull/23252)-era migration
  `0700` added the `teams_user_message` enum value. From about 00:38 to 00:47 UTC
  on July 28 (10 minutes), new code used the value before the migration ran and
  received `22P02` (`invalid input value for enum`), including a 57% failure
  spike on `/chat-threads/:threadId/events`. Enum additions are schema changes,
  not data changes.
- [PR #23656](https://github.com/vm0-ai/vm0/pull/23656), migration `0722`,
  dropped `chat_messages.role`. From about 06:55 to 06:57 UTC on July 29 (two
  minutes), the draining previous API still included the declared column in
  `INSERT ... RETURNING` and received `42703`. Read-never and write-never are
  insufficient while the old ORM schema can still generate the column name.
- [PR #23451](https://github.com/vm0-ai/vm0/pull/23451), migration `0714`,
  at 12:42 UTC on July 28 and
  [PR #23741](https://github.com/vm0-ai/vm0/pull/23741), migration `0725`, at
  09:34 UTC on July 29 produced zero-incident releases. They used in-place
  renames with same-name auto-updatable compatibility views, including column
  aliasing in `0725`. Temporary no-op or mirror triggers from `0714` and
  [PR #23594](https://github.com/vm0-ai/vm0/pull/23594), migration `0719`, kept
  both versions' statements legal during the transition.
- [PR #23696](https://github.com/vm0-ai/vm0/pull/23696), migration `0723`,
  renamed the table. Its compatibility view protected old code after migration,
  but new crons queried `chat_events` before migration from about 08:42 to 08:53
  UTC on July 29 (12 minutes) and received `42P01` (`relation does not exist`).
  User chat routes remained clean. Migration-before-promotion ordering, or
  explicitly tolerant new code, is still required for the other direction.

Persisted database objects are also consumers of table names: PL/pgSQL
functions, triggers, and column defaults can retain references that no source
scan will find, so query the PostgreSQL catalogs before contracting a schema.
[PR #23816](https://github.com/vm0-ai/vm0/pull/23816) had to retarget
`queue_artifact_catalog_file()` in migration `0736`, while
[PR #23858](https://github.com/vm0-ai/vm0/pull/23858) demonstrates the broader
catalog audit required before removing a compatibility relation.

Use one of the following proven schema-transition patterns. Keep each
compatibility layer only until the release it protects has fully drained.

#### Nullable Transition Column, Then Backfill and Contract

**When to use:** A new required field must be populated for existing rows. Add
the nullable column before any code requires it, backfill it in a later release,
and add the constraint only after both old and new writers populate it. The
`0697` -> `0698` -> `0701` sequence followed these three phases; the `0697`
incident also shows why new readers cannot precede the first migration.

```sql
-- Release 1: expand.
ALTER TABLE messages ADD COLUMN event_type text;

-- Release 2: backfill while the column remains nullable.
UPDATE messages
SET event_type = 'message'
WHERE event_type IS NULL;

-- Release 3: contract after every writer supplies the value.
ALTER TABLE messages ALTER COLUMN event_type SET NOT NULL;
```

#### Drop a Column as a Two-release Contract

**When to use:** A physical column is no longer needed. In the first release,
remove it from the ORM schema declaration and from every explicit reader and
writer. Wait for the preceding API version to drain. Only a later release may
drop the physical column. Migration `0722` violated this rule because the
previous Drizzle declaration still changed the generated `RETURNING` shape.

```sql
-- Release 1 changes code only; the physical column remains.

-- Release 2, after the previous API has drained:
ALTER TABLE messages DROP COLUMN legacy_role;
```

#### Rename in Place and Preserve the Old Name with a View

**When to use:** A table or column needs a canonical name while old API
instances still use the old name. Rename the base object in place and create a
simple same-name view over it in the same migration. A single-table view with
direct column references remains auto-updatable; aliases can expose old column
names. Drop the view in a later release after old code drains. Migrations `0723`
and `0725` used this pattern.

```sql
ALTER TABLE old_messages RENAME TO messages;

CREATE VIEW old_messages AS
SELECT
  id,
  event_type AS legacy_type
FROM messages;

-- A later release, after old code drains:
DROP VIEW old_messages;
```

This pattern protects old code after migration. It does not make `messages`
exist for new code before the rename migration, so migration ordering or a
separate new-code fallback must protect that direction.

#### Build Temporary Compatibility Objects in the Migration

**When to use:** The outgoing release issues a narrow statement that a normal
rename view cannot satisfy, or temporarily writes both the legacy and canonical
shape. Create the smallest trigger or zero-row view that preserves that exact
statement. Mirror triggers can keep transition columns synchronized; a zero-row
view plus an `INSTEAD OF` trigger can retain a retired write target without
persisting the obsolete row. Migrations `0714` and `0719` used temporary no-op
and mirror triggers.

```sql
CREATE FUNCTION mirror_legacy_type() RETURNS trigger AS $$
BEGIN
  NEW.event_type := COALESCE(NEW.event_type, NEW.legacy_type);
  NEW.legacy_type := COALESCE(NEW.legacy_type, NEW.event_type);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mirror_legacy_type
BEFORE INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION mirror_legacy_type();

CREATE VIEW retired_messages AS
SELECT id FROM messages WHERE false;

CREATE FUNCTION ignore_retired_message() RETURNS trigger AS $$
BEGIN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ignore_retired_message
INSTEAD OF INSERT ON retired_messages
FOR EACH ROW EXECUTE FUNCTION ignore_retired_message();
```

These objects are contracts, not generic fallbacks. Verify the exact outgoing
SQL against them, record the release they protect, and remove the functions,
triggers, and views after that release drains.

## Cloudflare Access for SSH

The #31996 delivery adds a protected transport to the existing SSH host domain.
#34077 is additive database/API authority preparation, including the minimal
current Runner contract reader and Platform diagnostic translations.
`sshAccess` is staff-only, and `cloudflareAccess` stays disabled, including for staff.
Under the [pre-GA policy](fallback.md), this feature keeps one canonical contract:
no profile selector, duplicate old/new DTO, or legacy diagnostic projection.

Before the first protected configuration or binding is written in a deployed
environment, every serving API must understand protected authority, Runners from
#34080 must own new Run admission, and incompatible active Runs must have drained.
#34081 owns Access management UI and full real-Run acceptance before activation.
Management stays inside `/connectors/ssh`. Access is a reusable host connection
setting under the existing SSH Agent grant, not a separately authorized service.
The Access feature switch controls rollout; it does not add an Agent permission.
Native Service Auth interoperability must be verified; S1 contract tests are not
provider E2E evidence. Do not use a production feature override as a test fixture.

| State                                                                 | Required behavior                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Existing Direct data after the additive migration                     | Hosts, credentials, pins, grants and observations remain unchanged; bindings are null. |
| Current API and S1 Runner with protected handoff                      | Runner returns unavailable without dialing Direct SSH or forwarding the token.         |
| Current API with an unauthorized protected host or Access feature off | Private authority is unavailable; guest inventory omits that host.                     |
| Pre-Access API with protected rows                                    | Forbidden: the old reader can interpret the row as Direct.                             |
| Protected writes before the native carrier and real-Run acceptance    | Forbidden outside controlled local tests.                                              |

Feature disable does not make a protected row safe for a pre-Access reader.
Do not deploy such a reader after protected writes exist; no automatic deletion
or conversion is part of deployment.

Run cache invalidations are best-effort and identifier-only. Token/SSH-grant changes
may leave cached authority usable for the remainder of an active Run if a notice
is missed. End those Runs when immediate revocation is required.

## Testing Expectations

Tests should cover cross-version behavior when a change touches a deployment
boundary.

For frontend/backend API changes:

- Test the current request shape.
- Test the previous frontend request shape while it can still reach the API
  during rollout; after an enforced floor and completed drain, test rejection
  of the retired shape instead.
- Test missing new response fields or old response shapes when frontend code can
  receive them during rollout.

For runner/backend API changes:

- Test old runner requests against the new backend handler.
- Test new runner code with old/missing backend response fields when the runner
  can be deployed before all backend instances are updated.
- Include poll, claim, heartbeat, completion, artifact, and session-resume paths
  when those protocols change.

For persisted state changes:

- Test reading rows or payloads written by the previous version.
- Test old backend behavior against the migrated schema when the migration runs
  before code promotion.
- Populate the pre-migration schema, upgrade it, and exercise the previous API's
  real statement shapes through every compatibility view or trigger. Include
  `INSERT ... RETURNING` and `INSERT ... ON CONFLICT` paths, plus ORM-generated
  column lists; testing only handwritten reads missed the `0722` failure mode.
- Test that new writes do not break the previous deployed reader during the
  rollout window, or document why the old reader cannot observe the new data.

Do not add broad defensive fallbacks just to hide incompatibility. The goal is a
specific compatibility contract for the rollout window, with clear deletion
criteria after the old version is gone.

## Pi native provider reader preparation

For the generation 4 reader-first release, see [Pi native provider preparation](pi-native-provider-preparation.md). Its model generation is independent of launch snapshot V3. Native writers remain absent until the controller verifies compatible API readers and rollback targets, Runner capabilities, pinned CLI artifacts and existing-route health. The preparation merge alone does not close these gates.

## Connector OAuth completion receipts

Successful browser authorization start responses require `oauthAttemptId` for built-in OAuth/OpenID and custom HTTP/MCP OAuth. Custom automatic-no-auth `connected` responses do not start browser authorization and do not carry an attempt ID. A successful callback records a short-lived receipt only after credential persistence and required Agent authorization/linking finish. The authenticated, uncached `/api/connector-accounts/oauth-completions/:attemptId` lookup validates the current user, organization, connector target, and actual connected account. Receipts expire 15 minutes after success; account deletion cascades to receipts, and the existing OAuth-state cleanup cron removes expired receipts in bounded batches.

The App uses the exact attempt receipt, not account timestamps, account counts, or sibling-account presence, to continue the flow. The callback's existing single-use state claim remains unchanged. Counts still determine the first-account Agent-grant policy, not OAuth success.

- Old App → new API: existing requests remain valid; the new response field is additive. Already-loaded old pages retain their previous completion heuristic until refreshed.
- New App → receipt-capable API: the start ID is required, but an ID alone does not prove completion. Pending, missing, expired, or inaccessible receipts and reconnect account mismatches never continue the flow or grant access.
- The new table is additive and does not change existing OAuth-state or connector-account rows. No Runner protocol changes or immediate App minimum-version increase are required.

The receipt-capable writer from [#32880](https://github.com/vm0-ai/vm0/pull/32880) shipped in release `3d58eaa4609967a4f655f7cd61d0d7cd454ba2a1`: API `1.575.2` completed [production promotion](https://github.com/vm0-ai/vm0/actions/runs/34335229479/job/102417239410) on 2026-09-09 at 09:48:46 UTC, followed by App `0.873.0` at 09:50:38 UTC. Cleanup [#32870](https://github.com/vm0-ai/vm0/issues/32870) retires the optional response field and absent-ID branch after that release. The maintainer explicitly excludes old API rollback compatibility; no rollback restriction is added or changed. Pre-receipt APIs are outside this cleanup's supported boundary. Existing App requests remain accepted, and already-loaded pre-receipt App bundles are not retired by this change; no App version floor increase is included.

## Pi memory summary storage and injection budget

A valid `memory_summary.md` may exceed 2500 exact o200k tokens on disk. The
2500-token budget belongs to the summary excerpt injected into the model prompt,
including its truncation marker, not to the stored artifact. The 64 KiB UTF-8
source ceiling, `sourceHash`/`sourceSize`/`tokenCount` full-source metadata, the
frozen storage version identity and the immutable-path guards are unchanged.

The reader slice of [#33351](https://github.com/vm0-ai/vm0/issues/33351) widened
acceptance only:

- `piMemoryRecallSelectionSchema` bounds the ready selection's full-source
  `tokenCount` by the 64 KiB source ceiling instead of the injection budget.
- API-first and sandbox recall authenticate the complete source bytes, hash,
  size, content and exact token count, and then render one bounded excerpt
  through the shared deterministic truncator.
- The API projection read path no longer treats an authentic larger source as a
  read-integrity mismatch, so it does not requeue that row.

That reader shipped in release
[#33469](https://github.com/vm0-ai/vm0/pull/33469) /
`9ce193854ab828baeec40579a6d36cdf2d4dbf73` (API `1.584.1`, `pi-agent-runtime`
`1.25.1`, `api-contracts` `1.428.1`, CLI `9.323.12`). The producer slice then
stopped capping sources by tokens:

- Phase 2 output validation rejects only genuine problems: invalid UTF-8, a
  missing `v1` header, a source above 64 KiB, immutable-path violations and a
  failed or incomplete atomic publication. A valid larger source publishes in
  full together with its `MEMORY.md` and skills. `summary_tokens` remains a
  parseable historical diagnostic; new runs no longer produce it.
- Projection materialization classifies token-only excess as `ready` and stores
  the complete source with its original `sourceHash`, `sourceSize` and exact
  `tokenCount`. Archive, file-size, path, link, duplicate, hash and encoding
  rejections are unchanged, and existing terminal `over_limit` rows are neither
  mutated nor requeued by this change.
- `phase2_write` and `phase2_edit` return content-free numeric feedback for the
  resulting whole `memory_summary.md`: UTF-8 bytes, the 64 KiB ceiling, exact
  o200k tokens and the 2500-token injection target. Above the byte ceiling the
  token count is reported as `unmeasured` so feedback stays bounded, and output
  validation still rejects that source.

Rollout ordering is a correctness requirement, not a preference:

- old runner -> new backend: a `pi-agent-runtime` without the widened reader
  rejects a larger source and injects no memory. Producers must not emit larger
  sources while such runner versions remain eligible to consume them; the
  reader release above is the gate that made this safe.
- new runner -> old backend: unchanged. An old backend keeps producing sources
  within the injection budget, which the new reader accepts and leaves intact.
- Frozen selections are pinned per run, so a resumed or pinned run keeps the
  epoch and reader decision it started with. New launch contexts bind the
  serving API's commit-addressed CLI package; a package tag alone does not
  prove runtime availability.

Rolling the backend back below the reader change restores the old read-side cap:
an already stored larger projection is then read as a read-integrity mismatch
and requeued, and materialization re-classifies it as `over_limit`. Rolling back
below the producer change only stops new larger sources; it does not rewrite
what was already published. The stored source itself is never truncated or
rewritten by any reader, producer or rollback.

## PostHog CIMD OAuth

PostHog OAuth uses a public client identified by
`https://app.okou.ai/connectors/posthog/metadata.json`, with PKCE and no
client secret. Deploy the API support for static public authorization-code
clients and the updated public metadata before publishing the companion
`vm0-ai/vm0-connectors` catalog change. Earlier API versions reject the public
client during catalog relationship validation; catalog publication must wait
until those versions no longer serve traffic. If the API must roll back below
this support, restore a compatible catalog first through the normal catalog
release process.

The new API can load the old confidential-client catalog. Its capability
filter hides only the incompatible PostHog OAuth method until the companion
catalog is published; the personal API-key method remains available. PostHog
OAuth is available to all users when its catalog method is compatible and visible.

OAuth storage version 2 adds the account's region and API base URL and changes
the client identity. Version 1 OAuth accounts must reconnect through the
existing storage-version lifecycle. US provider user IDs remain unchanged;
EU IDs have an `eu:` prefix to distinguish independent regional ID namespaces.
The personal API-key storage version stays at 1. No frontend, Runner, or
production data migration is required.

## Storage presigned URLs use a fixed two-day lifetime

All first-party object-storage GET, PUT, and multipart-part URLs are signed for
172800 seconds. API responses that advertise expiration use the same shared
constant, including reference images, private previews, registry archives, chat
snapshots, and exports. Private hosted preview tokens retain that same two-day
lifetime. Provider-owned URLs and OAuth token lifetimes are unchanged.

The app no longer renews preview credentials on a timer or after media errors.
Presigned uploads and Runner/Guest object downloads make one application-level attempt;
errors remain visible to the caller. Existing preview-resolution API contracts
remain available to deployed older app and CLI versions. Old Runner versions can
consume the longer-lived URLs without a wire-format change.

Storage URL caches are read on demand and reuse unexpired entries. Missing or
expired entries are signed once during the normal API request. There is no
proactive refresh or retry. The cron endpoint is now
`/api/cron/prune-storage-presigned-urls` and only removes expired cache rows.
Cache keys include the lifetime, so new code does not reuse the previous shorter
policy. The database's required `refresh_after` and `last_requested_at` columns
remain writable for deployment coexistence; new rows set `refresh_after` to their
expiration and new code does not use either column to schedule renewal.
