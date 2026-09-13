# Managed Intro Video cloud rendering

The controlled Intro Video route preserves authored HTML, presentation page
images, audio, and transparent presenter assets. Okou packages those inputs and
uses HeyGen HyperFrames Cloud to render them. This is a separate operation from
Video Agent generation and from generating voice or presenter assets.

## Access and API

New jobs use the existing `FeatureSwitchKey.IntroVideo` switch, video-enabled
workspace plans, credit admission, and run authentication with `file:write`.
The API uses only the server's `HEYGEN_API_KEY`. It accepts neither personal
HeyGen credentials nor arbitrary project URLs. Job reads and replays require
the original user and organization. Disabling creation does not strand an
already admitted job.

Upload the ZIP through the existing `/api/uploads/prepare` and
`/api/uploads/complete` endpoints, then submit:

```http
POST /api/intro-video/renders
Authorization: Bearer <OKOU_TOKEN>
Content-Type: application/json

{
  "requestId": "<durable UUID>",
  "projectFileId": "<owned uploaded ZIP UUID>",
  "composition": "index.html",
  "output": {
    "format": "mp4",
    "resolution": "1080p",
    "fps": 30,
    "quality": "standard",
    "aspectRatio": "16:9"
  }
}
```

`title` is optional. The supported ratios are `16:9` and `9:16`.
POST returns 202 for active work and 200 for terminal work. Reusing the same
request ID and input returns the same job; changed input returns 409. Other
owners receive 404. Missing platform configuration returns 503 before paid
submission. ZIPs are limited to 200 MiB, 10,000 entries, 1 GiB expanded size,
and a 1 MiB selected HTML entry. Unsafe paths and symlinks are rejected.
The composition's declared `data-width`/`data-height` must match the requested
output ratio; both the API and CLI reject a mismatch instead of cropping it.

`GET /api/intro-video/renders/:generationId` returns 200 with the latest job.
GET can reconcile provider status, copy output, and settle completed usage;
it never calls the provider's paid POST endpoint. Responses expose the original
safe API input, a provider render ID when known, a phase, and a recovery action.
They do not expose the private project URL or platform key.

## Submission and recovery

The API stores a digest-addressed immutable input snapshot in
`R2_USER_STORAGES_BUCKET_NAME`, under
`intro-video-render-inputs/<generationId>/<sha256>.zip`. The job records the
actual bucket and key in its private `renderState.projectStorage`, alongside
the exact provider payload. Queued jobs renew access to that recorded location
even if the bucket selected for new jobs changes. A signed input URL lasts
26 hours and is refreshed only before the first submission. Both the object
write and signed download response use `Cache-Control: private, no-store`.

New snapshots use the existing `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`,
with `R2_ACCOUNT_ID` or the configured S3 endpoint. Production currently selects
`vm0-s3-user-storages-prod`. This bucket must be distinct from the public
artifacts, hosted sites, and dedicated private artifacts buckets; the latter
uses a different credential route. The API rejects these aliases before paid
submission. New input snapshots do not require the dedicated
`R2_PRIVATE_ARTIFACTS_*` configuration. Original uploads and final outputs still
follow their existing artifact policy, including its configuration requirements.

Keep the user-storage bucket inaccessible without authorization, including
through R2 development domains and custom domains. The rendering provider
receives a signed GET URL for one object, never storage credentials. Cache
headers do not enforce bucket access control.

Input retention is scoped to `intro-video-render-inputs/`; the shared bucket
also contains persistent Agent, workflow, and session data. Signed URL expiry
does not delete an object. Do not apply an age-only expiration rule to inputs:
a job may wait days before its first submission, and `needs_attention` may
still need provider reconciliation. Cleanup may remove only the recorded input
of a provider-reconciled terminal job, at least 26 hours after completion, once
no pending retrieval or recovery needs it. Retain queued, active, and unresolved
jobs. No automatic per-job cleanup worker or bucket lifecycle configuration is
installed by this change.

Admitted jobs written before this storage change have no `projectStorage`.
Before their first submission, recovery uses their original
`R2_PRIVATE_ARTIFACTS_BUCKET_NAME` and digest-based key, then saves that location.
Keep that bucket, its credentials, and its inputs available while those jobs
drain. Already attempted submissions retain their exact original URL and body.
Remove the legacy location reader only after all pre-cutover jobs have drained
and the previous API is outside the rollback window.

The provider idempotency key is `okou:hf:<generationId>`. After the first
submission attempt, both the key and body remain fixed. HeyGen documents a
24-hour idempotency window; Okou permits replay for 23 hours. A missing provider
ID after that window returns `manual_check`, without automatically creating
replacement work. A known provider ID can still be polled after the window.
An authenticated, provider-verified callback can recover an unknown identity.

A database lease coordinates submission, status reconciliation, callbacks,
artifact persistence, and settlement. Provider identities are recorded with a
compare-and-set so an early callback and a late submission response cannot
replace each other with different IDs. Callback bodies are hints: the API
checks the provider's authenticated status response before accepting one.

The existing webhook endpoint drives completion independently of the agent
connection and asks the provider to retry while work remains unfinished.
Status/resume also perform reconciliation. This change does not add a new
periodic worker; a missing callback requires a later status/resume request.

## CLI

```bash
okou video render PROJECT --dry-run --json
okou video render PROJECT --json
okou video render status GENERATION_ID --json
okou video render resume GENERATION_ID --json
```

Dry-run packages locally without authentication, upload, or rendering. Packaging
honors `.hyperframesignore`, omits development and generated output directories,
and reports the largest files. Keep all assets referenced by the composition.
No presentation restyling, video frame extraction, or local final rendering
is performed by this command.

Before submission, the CLI records its request ID and original input in
`.okou/cloud-render.json`. After an interruption, reuse that ID. `resume`
first reads status and replays only if the server returns `replay_submission`.
A changed project requires an intentional new `--request-id`. Closing the CLI
does not cancel a cloud job. Pack/upload durations are client measurements;
server phase transition times are persisted and logged, while provider times
observed through polling are estimates.

## Artifacts and billing

Completion downloads and validates a bounded MP4 before storing it through the
existing Okou artifact service and linking it to the run. Provider download
URLs are not final artifacts. Duration and optional dimensions/frame rate come
from the provider; the video skill still decodes and probes the actual MP4
before accepting it for delivery.

Render usage has its own pricing row:
`video / heygen-hyperframes-render / output_video_seconds`. Migration 1116 seeds
125 credits per 120 output seconds from HeyGen's published 1080p/30 fps list
price of $0.05/minute, the existing 1,000 credits/USD conversion, and 1.25 markup.
See [HeyGen pricing](https://developers.heygen.com/docs/enterprise-pricing).
This is list pricing; the platform account's negotiated rate and live access
must be checked separately. Existing voice/presenter usage is billed separately.

A unique usage-event key prevents duplicate settlement. The result copies the
actual processed ledger charge, including allowances, into the durable job.
An unfinished artifact transfer or settlement remains pending with a null
charge; it is not reported as a completed zero-credit render.

## Release and verification

Ship the additive migration and API before selecting the new commit-addressed
CLI package. Publish the companion `intro-video` skill only after both are
available. Existing clients and the existing global generation status enum are
unchanged; render phases live inside the new task's opaque request state.
Do not roll the API below this implementation while these jobs are active:
older servers cannot reconcile the new task. Disabling `IntroVideo` stops new
jobs while the current API drains existing ones.

Local verification uses production route handlers, a real isolated PostgreSQL
database, mocked provider/storage boundaries, and the actual CLI parser. A live
acceptance test must use the deployed API and platform account: enable
`IntroVideo`, submit a preserved-page project, resume the same ID, and verify
one provider render, one ledger charge, and a playable permanent artifact.

For the input-storage cutover, pause new creation during API traffic promotion
and resume it on the updated API. Do not roll back to an API that reconstructs
every input location from the dedicated private bucket while new user-storage
jobs can still need their first submission. No database schema migration or
CLI/template change is required for this cutover.

Before production acceptance, verify authenticated write/read and denied
anonymous access at the new prefix, including any configured public domains.
Inspect bucket lifecycle rules against the retention requirements above and
inventory unfinished pre-cutover jobs. Use one existing project for the cloud
render smoke test; regenerating voice or presenter assets is unnecessary.
