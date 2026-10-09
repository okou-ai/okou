# Sandbox artifact previews

The first delivery of [#36205](https://github.com/okou-ai/okou/issues/36205)
lets the agent produce and inspect one cover locally, upload it with a hosted
publication, and use it for the HTML artifact's card in Artifacts. OG metadata
and anonymous image delivery are a separate delivery; this change does not
make preview storage public.

## Feature switch

`artifactPreviews` is off by default for every account, including staff. Enable
it for the testing user in Lab only after the compatible API fleet and CLI
have shipped. It is independent of `privateArtifacts`; enabling covers never
changes a site's visibility or grants permission to read an image. Later OG
work uses this same switch.

The switch gates the CLI's HTML/presentation authoring packets, selected
presentation/website prompts in new runs and steered messages, local
`host screenshot`, `host --preview`, and API preview prepare/complete admission.
The CLI reads the authenticated caller's effective state from
`GET /api/feature-switches`. Agent/sandbox credentials may read their own state,
but cannot use that endpoint to update or delete overrides. Unauthenticated
source-selection packets contain the existing publishing instructions.

With the switch off, `host screenshot` exits successfully without output or
file changes, and `host --preview` ignores the cover before reading its file.
The API also ignores supplied previews and publishes normally through the
existing backend screenshot path. Prepare acknowledges an ignored cover with
`previewSkipped: true` instead of issuing a preview upload URL. If the switch
is disabled after prepare, completion skips image processing, publishes the
page and returns `previewSkipped: true`; the CLI emits no warning or error.
Already issued upload URLs expire normally and grant access only to staged
bytes. The prepared metadata remains available, so re-enabling the switch and
retrying `host complete` can attach the originally prepared cover after upload.
The check happens at request admission; it does not cancel an already admitted
completion or an already running local capture.

Disabling the switch retains published sites and their saved covers. Existing
Artifacts cards and authorized image reads continue to work; no objects are
deleted or permissions changed. This makes rollback preserve user data.

## Author and publish

```bash
okou host screenshot ./dist --out ./generated/previews/cover.png --spa
# Inspect the PNG before publishing. Re-capture after changing the bundle.
okou host ./dist --site my-site --spa --preview ./generated/previews/cover.png
```

For a presentation, add `--artifact-kind presentation-html` to the publishing
command. A user-selected PNG/JPEG can be passed directly with `--preview`.
Keep all covers outside the hosted directory. The capture command writes a
1280-by-800 PNG (16:10, matching the Artifacts card) and an adjacent
`.okou-preview.json` receipt containing the bundle and image checksums.
The viewport also matches the existing backend screenshot producer. PR 2
handles social-specific OG sizing from this same source image.
It serves a frozen, read-only bundle over loopback
so root-relative resources and modules behave as HTTP resources, and uses an
isolated `agent-browser` session with no owner browser profile. It requires the
sandbox's existing browser and fonts; it installs nothing.

Capture has a 60-second browser-operation budget and bounded session cleanup.
It waits for fonts and visible images/background images, finishes finite
animations and samples continuous ones. Generated asynchronous content can
set `window.__OKOU_PREVIEW_READY__` to a promise or to `false` until ready, then
`true`. The agent still inspects the result for loading skeletons, clipping and
blank content. Failure is explicit, without remote rendering fallback.

The publisher checks the screenshot receipt against the final bundle and
checks each uploaded file against its scanned checksum. User-selected covers
without a receipt are accepted as deliberately selected images. No screenshot
is a cryptographic proof of what an arbitrary publisher actually rendered.

## Storage and completion

`prepare` accepts optional `preview: {size, sha256, contentType}` and returns a
separate, one-hour PUT URL plus the acknowledged checksum. This is not an entry
in the public site's `files` manifest. The private artifact bucket stores the
staging object under `private-artifacts/<preview-id>/upload`; the preview ID is
derived from the deployment ID and supplied image checksum.

Completion reads at most 5 MiB, verifies actual length and SHA-256, decodes a
single PNG/JPEG with a 16-megapixel bound, strips metadata and writes a PNG to
the existing private artifact storage. The final filename carries the source
checksum and the final key never receives PUT credentials. Replacing staged
bytes therefore cannot mutate a completed cover. Normalized output must also
fit the 5 MiB limit. Completion deletes the staging object; cleanup failure is
retryable with the same deployment. This delivery does not introduce a worker
to collect abandoned staging uploads or backfill historical previews.

When enabled, the image must complete before the site's manifest/active pointer
is published.
Invalid or missing images leave the deployment uploading and leave the existing
site active. Provider failures remain errors. Completion returns a stable
`previewImageUrl`; `run_uploaded_files.preview_image_url` and the artifact
catalog reference the same image. The Artifacts page resolves it through the
existing authenticated private-file reader. The image is not a separate
catalog card. Public-site catalog covers follow the active deployment, so a
late completion for an older version cannot replace them.

After all uploads have finished, a lost completion response can be retried
without creating another deployment:

```bash
okou host complete <deployment-id> --json
```

## Deployment compatibility

- Old CLI / retained deployment with no `preview`: the existing backend
  screenshot producer remains. Removing it is PR 3 after producer coverage and
  old-run drain, not part of this PR.
- New CLI with a cover / old API: missing acknowledgement fails before any
  file uploads or activation. Only explicit `previewSkipped: true` permits
  ignoring a requested cover.
- New CLI / new API: enabled completion requires and registers the supplied
  cover; neither validation nor rendering failures invoke Browser Rendering.
  Disabled prepare/completion skips the cover and uses ordinary hosting.
- Old Platform / new API: the existing private `previewImageUrl` and catalog
  thumbnail shapes are reused. No client or database migration is required.

Deploy and drain the API readers (including authenticated feature-state reads)
before releasing the new CLI and generation instructions, then opt in through
`artifactPreviews`. Keep the switch off during the deployment. A new CLI must
not prepare against a new API and complete against an older API that ignores
`manifest.preview`. Keep API rollback targets capable
of enforcing this requirement once new writers are active. Disabling new
writers does not remove the obligation to read already-prepared deployments.
CLI `host complete` retries use the original deployment's current authorization.
The API build includes Sharp's native addon and libvips inside the Vercel
function; deployment builds must use the target Linux/glibc architecture.

This seals only the new preview object. It does not change the separate,
existing hosted-bundle PUT URL/checksum compatibility contract.
