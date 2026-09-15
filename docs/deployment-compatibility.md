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

#### Artifact share names and short references

Share status adds optional `shortUrl`; `url` continues returning the legacy
32-character organization reference for already-open App bundles. New Apps
prefer `shortUrl` and fall back to `url` when talking to an older API. An explicit
share action allocates the new alias when a current API reports `shortUrl: null`;
opening the menu does not mutate a share. Both organization reference formats
resolve through the same membership and policy checks.

The R2 policy fields `organizationReference` and `publicSlug` are optional, so
old policies remain readable. The immutable reference index and public alias
registry survive an older writer dropping those optional fields. Current APIs
reuse the same organization index and retain the legacy public-token registry
entry. Named public sites use the existing generic Worker publication reader;
they require no database migration or new Worker routing format. Current APIs
must serve short-reference resolution before Apps begin copying those links.
Rolling the API back removes short-reference support until it is restored;
existing legacy organization URLs remain available in the `url` response.

The compatibility scope preserves the explicitly requested existing links;
`privateArtifacts` being non-GA does not independently require a rollback bridge.
Issue [#32492](https://github.com/vm0-ai/vm0/issues/32492) owns later retirement:
the optional response reader can be removed once older APIs leave serving and
supported rollback targets. The legacy organization `url` projection can be
removed only after the short-reference App is live and an App minimum version
excludes earlier bundles. Open pages have no passive expiry. Neither gate is
closed in this PR. Durable-link readers and aliases remain until a separate
retirement decision accounts for the stored references; a deployment or App
floor alone cannot invalidate links already copied by users.

The iframe loading correction spans the App's explicit first-party iframe
referrer policy and the host Worker's same-origin resource policy. Both must be
deployed to verify full HTML resource loading against the hosted-domain WAF.
The viewer and sharing use the existing `privateArtifacts` rollout switch.

#### Private attachment uploads

The API accepts the previous attachment prepare request without `purpose`, and
selects private storage from the existing `privateArtifacts` switch. The current
App completes a private single PUT before exposing a ready attachment; multipart
completion finalizes the ownership record on the API. Older composers omit the
single-upload complete call, so authenticated reference resolution verifies the
owned object with HEAD before signing it. An incomplete multipart upload has no
readable object. This previous-App bridge can be removed only after a later App
floor excludes those composers; #32492 owns that retirement.

Storage reads are independent of the rollout switch. Historical public objects
and canonical `accessLevel: private` records without a versioned storage marker
remain public objects; new private IDs never fall through to public storage.
This is a durable-data compatibility boundary, with no bulk migration in this
change. Template records select storage from their persisted source/page key
namespace, and Social job snapshots use an optional `privateArtifacts` field
(absent means the historical public mode). These readers must remain until the
corresponding persisted records have been migrated or explicitly retired.

Integration upload and Social responses use the existing stable `/artifacts/`
reference format for new private files. API, App and CLI consumers must support
that format before enabling the cohort; existing public response values are
unchanged. Signed provider/preview URLs are issued on reads and are not stored as
the durable file identity. No database migration, force-upgrade floor, Worker
protocol change, or infrastructure change is introduced here.

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

#### Slack connector OAuth rollout cleanup

The combined Slack integration and user OAuth flow from
[#33421](https://github.com/vm0-ai/vm0/pull/33421) first shipped in App `0.887.0`
and API `1.584.1`, release
`9ce193854ab828baeec40579a6d36cdf2d4dbf73`. Its
[API promotion](https://github.com/vm0-ai/vm0/actions/runs/34578216432/job/103198883138)
completed on 2026-09-11 at 08:30:58 UTC, followed by
[App promotion](https://github.com/vm0-ai/vm0/actions/runs/34578216432/job/103199718280)
at 08:33:05 UTC. App `0.886.0` still omitted `requestUserScopes`.

On 2026-09-15, production App HTML identified App `0.899.2` from
`05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`. Its
[API promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
completed at 07:25:09 UTC with API `1.603.2`, followed by
[App promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104291320762)
at 07:27:07 UTC. The canonical rollback resolver already requires
`PREPARED_DOMAIN_TRIGGER_RELEASE`
`eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, which contains #33421. Pre-OAuth
APIs are outside the supported production rollback boundary without adding a
new rollback restriction.

Cleanup [#34306](https://github.com/vm0-ai/vm0/pull/34306) raises the App floor
from `0.873.0` to `0.887.0` in this later release, after the replacement App is
live. Identified App versions below that floor receive `426` before route
handling and must refresh on their next handled API request. Idle pages are
not reloaded automatically. This affects all handled App API requests. An App
rollback must also remain at or above `0.887.0` while this floor is enforced.

Slack Connect requires `requestUserScopes: true` and returns only
`202 { authorizationUrl }` on success. The App follows that URL; connection
binding and notifications happen after the existing OAuth callback verifies
the grant. The direct-connect branch, its response shape, and rollout-only
tests are removed. Existing callback identity, workspace, membership, and
single-use-state checks remain in force.

The floor does not exclude non-App callers or missing/unparseable versions;
they can use the same canonical OAuth request. Authenticated requests without
`requestUserScopes: true` receive the contract's `400` validation response.
Current repository production code has one caller, the App, which already
sends that field; no CLI caller was found. The complete retained 72-hour
request-log query ending 2026-09-15 at 07:14:20 UTC contained one POST: App
`0.893.2`, response `202`. It found no non-App or unidentified POST; this is
bounded caller evidence, not a guarantee about every external client.

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

Instagram stats preserves provider `views` as a nonnegative integer, null, or
omitted for every caller, without capability-header negotiation. Zero is a
verified count; null is unavailable and is never converted to zero. Engagement,
author data, extensions and the existing provider-identity redaction boundary
remain unchanged. The optional `requireViews` input requests the provider's
bounded recovery. Its documented missing-view HTTP 503 returns without managed
billing or automatic retries.

The [#34047 retirement receipt](https://github.com/vm0-ai/vm0/issues/34047#issuecomment-5676398885)
records the first capable API release, `api-v1.597.0`, promoted on September 14,
2026 at 13:54:04 UTC. That release selected the immutable CLI artifact
`1c1d6963d034592bc9b3ca671f5f9475c2314234`. On September 15, after the queue,
execution and finalization window, the operator explicitly confirmed both queues
empty, all pre-cutoff runs finished, and no supported independently pinned older
CLI caller. This is operator-confirmed drain, not an automated database census
or an inference from runner versions alone.

- Capable pre-cleanup CLI -> canonical API: nullable results remain readable;
  the old capability header is no longer needed.
- Headerless CLI -> canonical API: null, omitted, zero and positive views stay
  distinct.
- Headerless CLI -> capable bridge API: null is temporarily omitted but remains
  readable; strict lookup remains supported. This also applies to rollback to
  the bridge API until the canonical API serves again.

Pre-reader CLI artifacts are outside the confirmed supported caller set. This
cleanup changes no persisted format, Runner protocol, or other social operation.

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
the new optional field. The API owns source-limit normalization; public projection
preserves its canonical metadata. Aggregate and streamed terminal output preserve
the source limit; `callerLimited` independently
records whether the fetched batch was trimmed. `status: complete` still means
the caller's requested count was satisfied, while collection state describes
source completeness. Unsatisfied source-limited requests remain partial.

The old-API metadata projection is retired by
[#34053](https://github.com/vm0-ai/vm0/issues/34053), using the following
production and supported rollback evidence from 2026-09-15:

- Writer commit `e43a677e7508192b61801356f234dbcf231a0fbe` (#34067) first
  shipped in API 1.596.0. The [API 1.603.2 production promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
  checked out and built `05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`, which
  contains that writer, and published the production alias at 07:24:43 UTC.
- The existing rollback resolver requires
  `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24` (API 1.600.1) for prepared
  domain writers. That release already contains the Instagram writer, so every
  supported rollback target emits canonical source-limit metadata. The rollback
  workflow loads the resolver from current `main`.

No response variant is retired and no CLI drain, schema migration, or additional
release floor is required. Old CLI -> current API remains readable. New CLI ->
supported rollback API preserves the same single-batch metadata. Pre-fix APIs
are no longer repaired by the new CLI; historical fixed deployment URLs or a
manual bypass of the official rollback workflow are outside this boundary.

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
Parent [#34056](https://github.com/vm0-ai/vm0/issues/34056) retains these
unverified provider-account and historical-job gates. Its response-only child
[#34320](https://github.com/vm0-ai/vm0/issues/34320) removes the separately
drained old-API normalization described below; it does not remove legacy rates.
An explicitly unbilled ready response is rejected. Polling headers may report
zero new usage on a paid-link refresh; the original job cost remains authoritative.

The response fields distinguish media intent from delivery evidence:

- `quality` and `format` remain request aliases for older CLI artifacts;
  the required `requested` block explicitly contains those same values.
- `provider.quality` and `provider.format` preserve the accepted ready metadata.
  Provider-reported resolution accepts renditions such as `576p`, independently
  of the finite request-quality choices. It is not a byte-level resolution
  measurement.
- `artifact.format` records the byte-sniffed MP4, M4A or MP3 type, or null when
  unrecognized. `delivered.format` uses only that evidence. Existing filenames
  and content types may be request-derived and are not used to infer it.
- `delivered.quality` uses stored provider reporting and is null for audio.
  The `delivered` block is required, but both members remain nullable. Missing
  historical delivery metadata remains null. New artifact recovery can establish
  a sniffed format without fabricating missing original quality.

No relational migration or stored-job rewrite is required. Old JSONB writers
legitimately omit the new optional media fields; new readers keep their original
usage and return unknown delivery metadata. Interrupted settlement and paid-link
refresh keep the same job and usage idempotency key. Refresh metadata must match
the original accepted duration and cost, rather than reprice a paid download.

The response-envelope retirement was verified on **2026-09-15**:

- [#34070](https://github.com/vm0-ai/vm0/pull/34070), merge
  `9c55bc983c52f37369576d36eb32fbb0aec94994`, first shipped the unconditional
  create/get/list writer in API **1.598.0**.
- The [API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
  checked out and built `05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`, API
  **1.603.2**, and published `api.vm0.ai` at **07:24:43 UTC**. This is the
  build's release SHA, not the moving GitHub deployment metadata SHA.
- The [rollback resolver](../.github/scripts/resolve-production-rollback-target.sh)
  already enforces `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, API **1.600.1**,
  which contains that writer. The [rollback workflow](../.github/workflows/rollback-production.yml)
  loads the resolver from `main`, so a historical target cannot replace the guard.
  No additional rollback floor is introduced.

APIs without these blocks are therefore outside supported canonical serving and
rollback targets. The CLI passes through the API's redacted response without
synthesizing missing blocks. This receipt retires only absent response blocks:
it proves neither a provider-rate transition nor an old-CLI drain, and does not
replace the independent MP3 compatibility requirements below.

| Pairing                      | Supported behavior                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Old CLI, new API             | Existing request aliases remain valid for mutually supported formats; additional blocks can be ignored.                    |
| New CLI, supported old API   | Writer-capable APIs already emit both blocks, including explicit nulls. No CLI normalization is needed.                    |
| Supported old API, new JSONB | Additive media keys preserve existing required values for mutually supported formats.                                      |
| New API, old JSONB           | Completed jobs remain readable; pending settlement and artifact recovery preserve original usage and unknown media fields. |

#### Explicit MP3 social downloads

`social download --format mp3` requests audio through the existing download
lifecycle. MP4 remains the default, M4A remains supported, and both audio
formats use one provider unit per started minute regardless of video quality.
The provider's ready format must match the request. Artifact bytes still
determine the delivered extension and MIME: detected MP3 is `audio/mpeg`, and
a different detected type is reported truthfully. For unrecognized bytes, the
filename and MIME are request-derived hints (MP3 uses `audio/mpeg`) while
`delivered.format` remains null. Sniffing does not validate an entire media file.

MP3 requests become available when the capable API is deployed, using the
existing authentication, capability, credit and active-task checks. MP3 extends
values inside existing response and JSONB fields. Older API and CLI schemas
reject those values, including when listing tasks that contain an MP3 request.

Coordinate MP3-capable serving, reconciling and rollback API artifacts with
compatible commit-addressed CLI selection and the incompatible queued, active
and finalizing context drain described above. Upgrade supported external
callers that may list or resume MP3 tasks. These compatibility conditions must
be addressed as part of deployment because the new API accepts MP3 immediately.

| Pairing                            | Behavior                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Old CLI, new API, MP4/M4A jobs     | MP4/M4A requests, polling and discovery retain their existing contract.                                                           |
| New CLI, old API                   | MP4/M4A keep working. Explicit MP3 is rejected by the old API; never silently substitute a format or resubmit.                    |
| New API, old JSONB                 | MP4/M4A tasks remain readable/resumable; missing historical delivery metadata stays unknown. No migration or rewrite is required. |
| MP3-capable CLI/API, new MP3 JSONB | Creation, listing, polling and same-job recovery use the widened format contract.                                                 |
| Old CLI/API, new MP3 JSONB         | Unsupported; exclude this pairing from supported deployment and rollback combinations once MP3 tasks exist.                       |

After the first MP3 task is created, rollback must retain MP3-capable readers
for as long as MP3 tasks remain readable or recoverable.

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

### Pi Langfuse trace relay

New run contexts no longer store or inject platform Langfuse credentials.
The commit-pinned CLI exports
OTLP to `POST /api/webhooks/agent/:runId/langfuse/traces` using its existing
`OKOU_TOKEN`. The API checks that token's run/user/org and the run's captured
`langfuseTraceEnabled`, then forwards only the OTLP body and encoding headers
with server-owned Langfuse credentials. Connector account selection cannot
change this destination or authentication. API execution, ownership transfer,
Sandbox Wait, and Sandbox Execution are sibling observations under the
deterministic Run End-to-End parent. LLM and tool observations stay inside their
execution phase. Both V3 and V4 sandbox handoffs carry that run parent and a
required `sandboxWaitStartedAt` timestamp when tracing is admitted. This
staff-only trace contract has no legacy shape or historical rewrite.

The API phase ends when handoff preparation starts. Transfer preparation ends
when manifest publication starts; the sandbox emits Sandbox Wait from that same
timestamp through native execution start. Publication, handoff restoration, and
runtime startup therefore belong to waiting. Publication failures still mark
the transfer as failed. Cross-host clock skew never produces a fabricated or
negative wait; invalid intervals are omitted.

The relay sets `x-langfuse-ingestion-version: 4` on its upstream request so
Langfuse stores native observations without synthesizing an extra trace span.
The API owns this version declaration; incoming headers cannot downgrade it.
This staff-only feature requires v4 ingestion and has no legacy ingestion
fallback or historical trace backfill.

The API and its pinned CLI must ship together through the existing deployment
pipeline. Existing Guests already pass the first-party API URL, run token, and
trusted platform environment to that CLI; no Runner promotion is needed.

The relay first reached production on 2026-09-15 at 05:11:55 UTC in API 1.603.0
and CLI 9.331.0, at commit `4a60b74daa3cba9e11fdb6a072fa989dd1a242d3`
([deployment](https://github.com/vm0-ai/vm0/actions/runs/34931381962/job/104260645155)).
[#34256](https://github.com/vm0-ai/vm0/issues/34256) explicitly retires optional
legacy tracing support: claim-time credential extraction and the Guest bootstrap
file are removed. The 07:19 and 07:21 UTC observations found empty admission and
runner queues and only post-rollout nonterminal Pi runs. Those observations do
not certify complete draining of captured legacy contexts or close the rollback
window; the retirement decision accepts loss of optional tracing for such contexts.

An older context retains its captured CLI URL. That CLI treats an absent bootstrap
path as tracing disabled, so agent execution continues without legacy exports.
Guests still filter platform Langfuse project keys from tracing-enabled Pi child
environments. The current CLI only configures the relay and has no direct-export
fallback. This change does not repair exports from an already-running legacy CLI.
An API rollback that removes the relay route drops optional trace exports from
relay-enabled runs; agent execution continues independently. This retirement does
not change production rollback policy.

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

The extracted storage cache is a separate, host-local cross-version boundary.
New readers use `storages/<name-hash>/decoded-v1-<version-hash>/` containing an
identity/content index and real files. Existing compressed readers continue to
use their original hashed version directory and `archive.tar.gz`; neither
reader interprets the other format. Selection validates and pins usable extracted
files before archive prefetch, so an admitted hit does not download or publish a
missing compressed entry. New entries use the existing name/version-key flock,
including the final-version lock for `.tmp` staging, so both old and new storage
GC recursively account and evict them with the existing best-effort byte and
entry targets. These targets are not hard disk-usage limits. Directory admission
also bounds each extracted entry's inode footprint.

Unsupported-archive admission records use separate
`decoded-v1-rejected-<version-hash>/` keys under the same GC and lock rules.
Only background fill reads these records; foreground lookup probes positive
file entries only, so unsupported archives do not pay a rejection-record lock
and read on every startup. Each reader validates its expected entry kind.

Readers hold that lock while validating the bounded index, identity, file types,
sizes and content digests, then pin owned bytes through Guest apply. GC can evict
the disk entry afterward without invalidating an in-flight delivery. Orphaned
lock GC may remove an unlocked lock while retaining its data; a reader recreates
and revalidates the lock only for a present entry, then reopens the directory
under the lock. Missing, busy or unsupported entries keep ordinary delivery;
malformed present cache data is an error, not an unverified hit.

The bounded binary-manifest check is computed once on the first usable ready
hit, before omitting archive staging. Miss-only runs do not clone and serialize
the manifest just to decide whether an unused binary input would fit.

Lookup windows admit at most 128 identities with 128 KiB of owned key bytes,
retaining the per-key limits. Non-admitted keys retain ordinary delivery;
this bounds metadata even when a plan contains unusually long identities.
Ready-file read-ahead stops after reaching 15 MiB of content, with at most one
additional storage's size in that last read; the wider miss-probe window does
not increase the former 16-MiB content read-ahead bound.

First-fill extraction belongs to the existing bounded background-fill owner and
starts only after Agent spawn. Before that point, selected work owns no task,
cache lock or open file. Publication uses private staging and atomic rename;
this is a disposable cache, not a power-loss-durable source of truth. Runner
shutdown joins background work and extracted-cache blocking tasks. The binary
final-file input is private to the bundled Runner/Guest storage operation;
ordinary HTTP downloads, API manifests and generic exec-stdin limits do not
change. No backend reader-first deployment is required for that bundled input.

After a run actually selects extracted-file delivery and successfully spawns its
Agent, that same bounded background owner may retire the corresponding compressed
archive. Retirement never downloads data. It takes the old archive's exclusive
lock without waiting and validates the complete positive replacement under its
own lock, retaining both locks through deletion. Busy, missing or non-admitted
replacement work is skipped; malformed data is reported as a background error.
It removes only the regular archive and an empty version directory, not unrelated
files. GC can independently evict either format after those locks are released.

Conversion alone does not delete an archive: a never-used converted entry may
retain both formats until direct use or GC. Old Runners, rollback, instructions,
artifacts and other archive-required consumers keep their original delivery and
may refill a compressed cache miss. Queued archive-fill demand takes precedence
over queued retirement for the same identity. This is use-driven best-effort
cleanup, not a guarantee of exactly one representation across mixed consumers.

Positive lookup includes a metadata-only archive-existence hint for maintenance
admission. Already retired entries do not consume the background queue again,
so a decoded prefix cannot repeatedly displace later warming or retirement.
The hint neither reads compressed content nor authorizes deletion: retirement
reopens and validates under locks. Metadata errors are left to that background
validation rather than failing an otherwise valid extracted-file delivery. An
orphaned source lock is recreated only for observed archive data, following the
same lock repair rule as cache readers.

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

Balance failures keep `insufficient_credits` for vm0 credit admission and add
`provider_insufficient_credits` for upstream model-account balance. Completion
stores that real failure reason for both BYOK and built-in runs. Public presentation
uses persisted run ownership to display a platform-owned balance failure as
"The current model is unavailable." and omit its billing reason from public chat
metadata. Model unavailability is presentation, not a completion failure reason.
The webhook and Chat Event V7 schemas accept all valid reason tokens; older readers
use generic failure copy for an unknown token instead of rejecting the run or
showing the vm0 recharge card. No schema migration is required.

Prefer API readers before the runner writer for this change. Old runners and
retained rows can still have missing reasons or legacy upstream affordability
text labeled `insufficient_credits`; exact legacy presentation remains supported
without inferring an unobserved status or suppressing unknown diagnostics. Remove
that compatibility only after old runners drain and affected retained rows are
gone or migrated. Public run, activity, HTTP callback, model-error event, and network-export
projections keep built-in balance details internal; rolling back these readers
can restore the prior disclosure behavior even though the tokens remain readable.

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

Migration 1132 below subsequently handles the three entitlement triggers and
enforces the canonical-only rollback artifact. Its production completion and
the remaining #32575 column/client contraction are recorded next.

#### Legacy invitation column contraction (2026-09-15)

The [API 1.603.1 production job](https://github.com/vm0-ai/vm0/actions/runs/34936717500/job/104278924406)
checked out and built `caa4352ddba6ef4b1912cbbb7838afb94ac4aa82`. Its **Run
Production Migrations** step records the real production 1132 receipt at
2026-09-15 06:38:10.5347961 UTC: eight matched/retired triggers, eight matched
functions and zero audited invariant violations on PostgreSQL 17.10. This is
separate from the preceding smoke-clone receipt. `Migrations complete` follows
at **06:38:10.7737004 UTC**. The shipped migration runner and entry point are
byte-identical to this change's base: the runner awaits the transaction including
the journal insertion before the entry point reports completion. This establishes
the 1132 journal frontier, `when=1789448024786`; no direct production journal
SELECT is claimed.

The 2026-09-15 serving-alias read resolves both `api.vm0.ai` and `api.okou.ai`
to READY production deployment `dpl_i8s7vaEvyqeKFD7m2hTa2W2CAKYW` at that same
artifact. It descends from the enforced API 1.600.1 rollback floor,
`eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, which in turn contains #33909's
canonical-only mapping and unconditional all-Free migration response. The
resolver continues to load from current main and reject earlier artifacts.
Current and supported rollback APIs therefore neither name the old columns in
SQL nor require the App's migration query opt-in.

Drizzle-generated migration `1137_retire_legacy_invitation_columns` removes
`member_invite_usage_pack_required` and `member_invitation_allowed`. It locks
only `org_plan_entitlements`, checks the predecessor journal frontier, exact
column definitions, persisted routine bodies in user schemas, and all recorded
column dependencies before either drop. Only the columns' own defaults and
native NOT NULL constraints may disappear; unexpected indexes, checks, views,
triggers or functions abort the transaction. The normal 1s lock / 10s statement
limits and atomic journal insertion remain in force. Historical migrations and
1132's evidence remain unchanged.

The App removes `supportsFreeMembers=true` from the migration GET request and
its request contract. Catalog/management responses still explicitly advertise
Free-member support. Existing route coverage checks all-Free configuration
without a query parameter; invitation admission continues to use normalized
status and administrator authorization, and package controls use `showUsagePack`.

The final #32575 cleanup follows production release [#34303](https://github.com/vm0-ai/vm0/pull/34303),
which promoted API 1.604.0 and App 0.900.0 from
`8a391b88833ae0b075c4df194010641955d4f936`. That actual artifact contains
#34317. The release PR's earlier branch head does not contain #34317 and is
not the production artifact used for this verification.

The [API production job](https://github.com/vm0-ai/vm0/actions/runs/34957141130/job/104345191059)
checked out that exact artifact and completed **Run Production Migrations** at
**2026-09-15 10:31:12.0275988 UTC**. This is the real production completion,
separate from the preceding smoke clone's 10:31:09.4559442 UTC completion. The
artifact's final journal entry is 1137, `when=1789460587817`. Its 1137 SQL,
migration runner and entry point are byte-identical to #34317: the runner awaits
both column drops and the journal insertion in one transaction before the entry
point prints `Migrations complete`. That acknowledged execution establishes the
committed frontier and column contraction; no direct production journal or
catalog SELECT is claimed.

Fresh serving-alias reads resolve both `api.vm0.ai` and `api.okou.ai` to READY
production deployment `dpl_AFZ3enCuHEt768R3HaqanNg8ZxtH` at that same artifact.
The [App production job](https://github.com/vm0-ai/vm0/actions/runs/34957141130/job/104346013714)
verified the immutable App artifact and assets, then completed promotion at
10:33:12 UTC. The serving `https://app.okou.ai/` HTML reports that exact SHA and
version 0.900.0. Current main still loads the rollback resolver from main and
enforces API 1.600.1 at `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24` as the
prepared-writer floor. Both that floor and the serving API use the canonical
entitlement mapping and return migration state without a query opt-in. The
serving/rollback compatibility cycle covered by the invitation validators is
complete.

The cleanup removes both invitation transition validators, the frozen outgoing
API projection, and the retained/trigger-free private-schema variants. Permanent
schema validation exercises the canonical projection on both replayed and freshly
generated schemas. Historical `showUsagePack` backfill checks remain. Current API
coverage retains infrastructure failure/transaction cases and verifies
persisted status normalization through the billing endpoint; existing invitation
and page suites retain Free, suspended, administrator, reactivation and explicit
`showUsagePack: false` behavior. Close #32575 after the final cleanup merges.

### Prepared billing, OAuth and hosting trigger contraction (2026-09-15)

Migration `1132_retire_prepared_domain_triggers` removes A–D's eight triggers
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
[writer inventory, repair rules and migration receipts](database-trigger-retirement.md#a-d-contraction-migration-1132).

### Withdrawn marketing privacy storage contraction (2026-09-15)

Migration 1139 drops the three withdrawn privacy tables and their trigger/function
under #33747. The old `user.deleted` cleanup still unconditionally names
`privacy_choices`, so preparation #34296 must be released and its old writers
drained before contraction can merge/release. The prepared cleanup handles all
three relations present or absent under the shared advisory lock also taken
exclusively by the migration. Current contraction code removes that temporary
helper and schema dependency entirely.

The rollback resolver derives the preparation's actual introduction from main's
first-parent history of `marketing-privacy-cleanup.service.ts`, preserving that
boundary after the file is deleted and across a squash merge. It rejects absent
history and targets predating preparation before looking up artifacts. The retained
target must also be a released READY artifact. The canonical preparation
introduction is `e98391290d01e88ece8bf1acfcfc258b3f1e3c13`. Record the immutable
production artifact and old-invocation drain on
[contraction #34305](https://github.com/vm0-ai/vm0/pull/34305) before it becomes
ready; this source guard alone does not prove serving or drain. See the
[explicit release and rollback gates](marketing-privacy-choices.md#required-release-order-and-rollback-boundary).
API rollback cannot recreate the retired rows. The withdrawn feature stays
withdrawn, and #33275 owns any replacement privacy design.

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

The management UI uses the existing canonical Access endpoints; it adds no
schema or private Runner contract. With Access off it keeps Direct management
available and hides Access creation. Already-bound hosts still identify their
protected transport; editing, resetting keys and deleting them remain unavailable
under the canonical API gate. Removing a binding requires Access eligibility and
an explicit Direct selection. Losing the feature or changing
owner clears open secret forms and cancels their pending UI work. API authorization
and same-owner foreign keys remain authoritative; frontend visibility is not an
access check.

| State                                                                 | Required behavior                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Existing Direct data after the additive migration                     | Hosts, credentials, pins, grants and observations remain unchanged; bindings are null.                 |
| Current API and S1 Runner with protected handoff                      | Runner returns unavailable without dialing Direct SSH or forwarding the token.                         |
| Current API and S2 Runner with authorized protected handoff           | Runner uses native WSS/443, verifies gateway TLS and SSH identity separately, without Direct fallback. |
| Current API with an unauthorized protected host or Access feature off | Private authority is unavailable; guest inventory omits that host.                                     |
| Pre-Access API with protected rows                                    | Forbidden: the old reader can interpret the row as Direct.                                             |
| Protected writes before the native carrier and real-Run acceptance    | Forbidden outside controlled local tests.                                                              |

Feature disable does not make a protected row safe for a pre-Access reader.
Do not deploy such a reader after protected writes exist; no automatic deletion
or conversion is part of deployment.

#34080 changes the Runner transport without changing guest CLI terminal enums or
the S1 private API contract. Existing Direct requests keep their behavior. A
missing/incompatible authority response fails closed; no pre-GA dual decoder is
introduced. The feature remains default-off after the carrier code lands, pending
authorized real-provider evidence and #34081's integrated acceptance.

Run cache invalidations are best-effort and identifier-only. Token/SSH-grant changes
may leave cached authority usable for the remainder of an active Run if a notice
is missed. End those Runs when immediate revocation is required.

#34353 changes only Runner-local authority ownership, not the API, guest RPC or
persisted data contracts. New Runners preserve SSH authority and healthy work
across Ably connection loss, recovery and initial subscription unavailability;
draining old Runners retain their previous disconnect-eviction behavior. First
use/cache misses still authorize through the same API. Delivered invalidation,
failure eviction and Run/sandbox teardown remain effective. The accepted
Run-lifetime missed-notification window includes observed outages; this introduces
no reconnect grace deadline, periodic reauthorization or new TTL. No coordinated
API rollout or migration is required for this Runner change.

## Integration input attachments

New Feishu/Lark, Teams, Telegram, and AgentPhone trigger attachments use the
existing canonical input asset rows and `R2_USER_ARTIFACTS_BUCKET_NAME`, as Slack
does. Successful imports emit the existing `userMessage` file part and
`[Web file]` prompt format; existing frontends and pinned CLIs can read them
without a coordinated release. Provider download commands continue to accept
their original IDs.

Feishu, Telegram, and AgentPhone store the resolved prompt in their existing
launch context. Teams adds an optional `messageFiles[].canonicalAsset` object;
new readers fall back to the original provider reference when it is absent,
and old readers can still resolve that retained provider reference. Both queue
launch and active input delivery read this persisted context. No database
migration or historical attachment backfill is required. Failed imports retain
the canonical file part and the provider-native prompt reference, matching
Slack. Only ready imports emit a `[Web file]` prompt.

All adapters share MIME validation, streamed size enforcement, a 10-second
per-file import timeout, and retry classification: HTTP 429/5xx and transient
failures remain retryable; other HTTP failures and invalid/unsupported/oversized
files do not. The general size limit is 100 MiB; Telegram retains its Bot API
20 MiB download limit.

The new adapters deduplicate across messages by user, organization, installation,
and stable upstream file identity. Message IDs remain provenance, not identity.
Telegram uses `file_unique_id`; Teams uses file `uniqueId` where available.
Resources without a provider file ID use a hash of the full resource URL, so
unrelated attachments with the same message-local attachment number cannot
collide. Slack retains its existing user/file-ID identity, including existing
canonical asset rows. This does not deduplicate equal bytes under distinct
upstream resource identities.

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

## Pi inference lifecycle reader floor (#34242)

The [Pi inference lifecycle contract](pi-inference-lifecycle.md) adds a strict v4
launch discriminator without a Runner profile and three sparse ownership/intent/lease
tables. Full-launch v1–v3 and historical NULL writes remain legal. The generated
expand migration replaces the launch CHECK as NOT VALID; a separate bounded
validation transaction scans retained runs before API promotion. New runtime
writers are absent and `piDeferredSandbox` is org-scoped and off, including staff.

After future v4 activation, disabling starts must retain phase/epoch-aware readers,
consumer/recovery, cancellation, capacity counting, credential retention and erasure.
A v1–v3-only application is below the rollback floor while v4 records remain.
Do not shrink the CHECK or cascade away releasing leases. See the linked contract
for exact DDL timeouts, failure/retry behavior, scale receipts and activation gates.

## DeepSeek V4.1 Flash Pi coverage

The [V4.1 Pi catalog and deployment contract](../turbo/packages/pi-agent-runtime/src/deepseek-v41-catalog.md)
requires the API's matching commit-addressed CLI for new admission and preserves
old captured contexts. Existing Responses schemas and Runner claims are unchanged.
Retain the V4.1 reader and API billing writer in serving/recovery and rollback
targets while admitted V4.1 Pi work remains.

## Durable Run stop intent (#34383)

The [Run cancellation reconciliation contract](run-cancellation-reconciliation.md)
adds nullable `agent_runs.runner_cancellation_mode` and an authenticated v1 read
endpoint. Apply migration 1143 before promoting API code. Its CHECK remains
`NOT VALID` because all existing rows receive NULL; new writes are constrained
without a historical scan. Old writers remain valid with NULL. Rollback retains
the additive column.
Deploy the API across the serving fleet before enabling the Runner consumer in
#34384. Unsupported endpoints and other inconclusive reads must not become
disappearance decisions. This API slice alone adds no new stop-delay bound.
