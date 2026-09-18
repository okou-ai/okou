# Artifact sharing

For private site screenshots, protected Public thumbnails and ten-character
Public file names, see [behavior and required deployment order](artifact-preview-rollout.md).

New-policy private artifacts use the existing `privateArtifacts` switch. Its
code default remains `false`. The API resolves the owner/original-org switch
for new grants and audience/version changes; the app uses the same switch for
its Share menu and standalone viewer. Stored policy enforcement, organization
resolution and stopping an existing share do not depend on the rollout switch.

## Upload storage and historical files

With `privateArtifacts` enabled, new chat attachments (including annotated images
and multipart uploads), integration input/output files, browser screenshots,
Social downloads, and generated preview images use the private artifact bucket.
The upload purpose is not a storage-policy selector. Private objects have an
ownership record with `metadata.storage: "private-artifact-v1"`, the bucket and
object key, and a stable ten-character `/artifacts/` reference. Missing private configuration or
bytes never falls back to a public write or public lookup.

Reads authorize the recorded owner and organization and use the stored location,
regardless of the current switch. Old public URLs, V1/V2 object keys, and canonical
input records with `accessLevel: "private"` but no storage marker retain their
original public storage behavior. Enabling the switch does not migrate or make
historical public bytes private. Existing canonical operations and multipart
uploads retain their allocated bucket on retry. Social jobs record the storage
choice in their request snapshot; older jobs without that field remain public.

Web previews, Agent downloads, image recognition, template import/preview, and
Drive sync resolve the stored location. Providers that fetch bytes receive
temporary signed URLs; durable records retain the stable reference. Teams and
GitHub message links to new private files use the authenticated App URL.
Conversation sharing copies private attachment bytes into private snapshots
controlled by the conversation's existing share policy, including when creation
has subsequently been disabled. Reattaching an existing output preserves its
original run and publication identity.

## User flow

The owner opens an artifact's existing Share menu, which contains only
**Share to organization** and **Share to Public**. Choosing either option shares
the displayed version and copies its link. If that version already has the
chosen audience, the action copies the existing link. An explicit share action
also allocates a short organization reference or named public site URL for an
older share that lacks one. Opening the menu is read-only. Upload, generation,
and hosting create no artifact grants unless their CLI command explicitly
requests organization or public visibility. Thread sharing creates independent resource
snapshots under its own grant; see [shared-thread snapshots](shared-thread-artifact-snapshots.md).
Recipients cannot edit or reshare the original artifact.

- Organization: `https://app.okou.ai/artifacts/<10-character-reference>.<extension>` (the configured
  `APP_URL` in other environments). Signed-out visitors see the access page and
  can choose **Sign in**, returning to the same artifact URL. The app then calls
  the API with its session. The API checks the grant and
  current membership of the **original organization**, even when another org is
  active. With `privateArtifacts` enabled, success opens the standalone Okou
  viewer; otherwise it navigates directly to the signed file or isolated HTML.
  Denial shows an unavailable message without artifact metadata or content.
  The app response and API response are private/no-store and no-referrer.
- Public sites: `https://<site-name>.okou.app/`, using the configured branded
  hosted domain and the same naming rules as `okou host`. A collision adds four
  lowercase alphanumeric characters. Anonymous requests go through the host
  Worker and never require an API or primary database round trip. Public files
  retain their existing artifact-delivery URLs.
- The menu has no separate copy or stop-sharing action. The API retains its
  stop-sharing operation for revocation and rollback. Changing Public to
  organization clears the public token before acknowledging
  organization-only scope. Republishing rotates that token, so an earlier
  revoked public URL stays revoked. A named site URL also belongs to one public
  token: republishing after revocation allocates a new name with a short suffix.

A file ID is one version. A hosted site's share ID spans its versions, but its
policy pins one explicitly selected deployment. A new generation or another
`--site` upload does not update the share. Choosing an audience on a newer,
not-yet-shared version explicitly updates the selected version and copies the
link. New organization links reuse the selected version's owner reference, so
the same version has the same short ID before and after sharing. A newer version
has its own reference and remains owner-only until explicitly shared. After
selecting another version, a recipient cannot use the earlier version's source
reference to follow that change; the owner can still open their original version.
Previously copied share-level organization links retain their existing behavior.
Repeating the action for the already shared version only copies that link.
Organization share responses return that same short link in both `url` and
`shortUrl`; they no longer construct a long share-ID URL. An older organization
policy without a short reference returns null for both fields until an explicit
share action allocates one. Previously copied long links remain readable.
CLI/model URLs use the same stable short references. CLI file and hosted-site
consumers resolve owned references with `kind=file` or `kind=html`, respectively,
under the existing `file:read` or `host:read` capability. Those requests cannot
resolve another owner's organization share or cross the resource-type boundary.

## Agent CLI visibility and downloads

`okou artifact` uses the same owner management endpoints and stored policy as
the Share menu. Run tokens receive `artifact:read` and `artifact:write` when
`privateArtifacts` is enabled; file upload and hosting capabilities alone do
not authorize sharing. When that switch is enabled, the run system prompt adds
short pointers to `okou artifact --help` and `okou artifact download -h`.
Command help provides the detailed usage. Existing session/PAT callers remain supported.

Creation commands also accept `--visibility only-me|org|public`: `okou web
upload-file`, `okou host`, managed image/video/avatar-video/voice generation,
and `okou generate image-batch start`. HTML, presentation, sprite, and video
template authoring packets carry the selected visibility into their final
delivery command. Supporting media keeps its default visibility.

With `privateArtifacts` enabled, new artifacts default to `only-me`. Omitting
the option preserves the existing creation flow, including legacy behavior when
the switch is off. An explicit option requires the switch and a compatible API;
it is never silently ignored. `org` and `public` share the completed artifact
through the same owner endpoints as `okou artifact`, and text, JSON, and Markdown
outputs use the returned audience-specific URL. Explicit `only-me` leaves a new
private artifact unshared. For hosted sites it does not revoke an older version's
existing share; use `okou artifact --visibility only-me` to revoke that share.

```bash
okou web upload-file -f report.pdf --visibility org
okou generate image --raw-prompt "A watercolor fox" --visibility only-me
okou host ./dist --site quarterly-report --visibility public
```

Explicit creation first reads `/api/artifact-shares/availability`, then uses a
guarded `/private` variant of the creation endpoint. These variants require the
live switch before accepting bytes or starting paid generation and capture that
same private storage policy for the operation. An older API rejects the new
route rather than ignoring an unknown request field and creating public bytes.
Old CLI requests keep using existing routes, and new CLI commands without the
option remain compatible with old APIs. No rollout activation or storage
migration is part of this change.

If creation succeeds but sharing fails, the command exits unsuccessfully and
returns the created artifact's owner URL plus a read-state recovery command.
Inspect that state before retrying sharing; do not repeat the upload or paid
generation. Image batches apply sharing outside their generation retry loop.

```bash
okou artifact /artifacts/abc123def4.pdf --json
okou artifact /artifacts/abc123def4.pdf --visibility only-me
okou artifact /artifacts/abc123def4.pdf --visibility org
okou artifact /artifacts/abc123def4.html --visibility public
okou artifact download /artifacts/abc123def4.pdf -o /tmp/report.pdf
```

The input accepts an owned artifact reference or an absolute artifact URL on
`OKOU_APP_URL`. A UUID requires `--kind file` or `--kind html`. Reference
resolution uses `kind=artifact` with `artifact:read`, accepts either resource
type, and never resolves another owner's organization share. Legacy UUID
references remain supported. Public delivery URLs and temporary preview URLs
are not management identities.

Without `--visibility`, the command reads the current visibility and URL without
changing permissions. Setting `only-me`, `org`, or `public` uses the existing API
values `private`, `organization`, and `public`. The API returns a stable
`ownerUrl` for the requested artifact version in addition to the existing share
URL fields. The CLI returns that owner URL for `only-me`, and the existing share
URL for `org` or `public`, in both text and JSON output. Historical organization
shares without a short alias still return no share URL until explicitly updated.

An explicit visibility change checks the selected target, version, audience and
allocated alias before writing; an already shared version returns its current
link. The Share button sees the same policy and reuses that link. A newer hosted
version remains private until explicitly selected for sharing. Setting an
already private artifact to `only-me` returns its owner URL without creating a grant. There is one active
audience, so switching Public to organization or private revokes the old public
link; later Public sharing allocates a new public token. Previously issued
temporary previews retain their existing expiration.

`okou artifact download <file-id> [-o|--out <path>]` and
`okou web download-file` share the same download implementation. Artifact
references require `artifact:read` and follow the viewer's current only-me,
organization, or public access. Raw file UUIDs and authenticated web-download
URLs retain `file:read` and their existing file authorization.

Standalone files, including uploaded HTML files, stream to the requested file
path and return `{ path, mimetype, size }`. Hosted sites download the complete
deployment manifest, including every HTML page and asset, into an empty or new
directory specified by `--out`. Their JSON result additionally contains
`fileCount` and `entrypoint`; `path` is the directory and `size` is the total
size of its files. Directory structure is preserved, every file's size and hash
are verified, and external URLs are not mirrored. Conversation references that
select a non-HTML file inside a site retain single-file download behavior; clone
accepts the site's HTML references. For example:

```bash
okou artifact download /artifacts/abc123def4.html --out ./site
okou host clone /artifacts/abc123def4.html ./site
```

`okou host clone` uses the same visibility rules. Organization recipients need
current membership in the original organization, even when another organization
is active; public recipients need no membership in that organization. Private
sites remain owner-only. Shared downloads use the selected shared version and
its stored snapshot, including rewritten dependency assets. Specifying another
version does not grant access to an unpublished deployment. Both commands leave
visibility unchanged and fetch delivery URLs without forwarding the CLI token.
Cloning a public URL follows that publication, even for its owner. Cloning an
owned site's bare canonical slug retains the owner's latest-version editing
behavior. Public sites embedded in shared conversations follow the conversation's
live sharing policy and independent artifact snapshot.

If an update fails or its response is lost, rerun without `--visibility` before retrying: the
policy write may already have succeeded. Deploy the API and CLI together before
using these commands; older run tokens lack the new capabilities and require a
new run. No storage migration or host Worker protocol change is required.

## Standalone artifact viewer

The shared `privateArtifacts` switch applies to
`/artifacts/<compact-reference>[.<extension>]` and the legacy
`/share/artifacts/<shareId>` route. Both use page-local access checks rather than
the authenticated route guard. Signed-out visitors resolve the public share's
delivery URL and preview metadata without a session, and see its content inside
the standalone viewer at the original App URL. Signed-in visitors use the
authenticated resolver first and can also preview an explicitly public version
when they lack owner or organization access.

Private, organization-only, revoked, missing and unselected versions show the
existing access page without disclosing artifact metadata. Its primary action
is **Sign in** for signed-out visitors and **Switch account** for signed-in
visitors. Signing in is an explicit action and preserves the complete current
artifact URL, including query and fragment, as a same-origin return destination.

The viewer reuses the lightbox's media and document previews,
image zoom controls, and download action in a full-page canvas with the shared
thread page's brand header. There is no fullscreen action. The header restores
the app's theme preferences and **Continue with Okou** uses the shared primary
button colors.

The viewer's **Share** button directly copies the current app URL and reports
clipboard success or failure. It never creates a grant, changes an audience,
publishes content, or copies the temporary preview credential. Download resolves
the canonical reference again for authenticated previews and uses the published
delivery URL for public previews, saving the original filename. Public viewers
copy the App link directly without loading owner permission controls. HTML remains in
the isolated preview origin inside a sandboxed iframe; URL fragments, including
slide and PDF page positions, are retained. **Continue with Okou** opens a new
chat with the canonical artifact link as its prompt, without importing the
source thread.

Owner and organization references contain 10 lowercase alphanumeric characters.
An immutable version-2 R2 record at `artifact-references/<reference>.json` maps
each reference to a file or hosted deployment UUID. Creation allocates the
reference without creating any sharing grant. Files retain it in their storage
metadata; deployments retain their URL. Deterministic candidates and conditional
creation preserve the ID across retries and handle collisions without overwrites.
Owner reads check ownership; recipient reads require an active policy selecting
that exact version and current original-organization membership. The reference
itself grants no access. Version-1 index records still map old organization
references to a share UUID. Existing 32-character `/artifacts/` references and
`/share/artifacts/<shareId>` links remain supported.

Named public sites use the existing immutable artifact-delivery registry. Name
allocation checks other hosted sites, historical public pointers and registered
aliases before acknowledging the policy write. Already allocated aliases are
never reassigned. Legacy public token URLs continue to resolve through their
original policy and revocation checks.

The outer app page keeps `Referrer-Policy: no-referrer`. Its HTML iframe sends
only the app origin to the configured first-party hosted domains, allowing the
hosted-domain WAF to recognize it. Private and shared hosted responses use
`Referrer-Policy: same-origin`: local CSS, JS and image requests identify their
isolated origin, while cross-origin requests disclose no preview credential.
External HTML previews retain `no-referrer`.

## Storage authority and immutable bytes

`artifact_shares` contains the durable owner, original org, brand and logical
file/site identity, with one row per target. It is an ownership index, not a
second mutable policy authority. The versioned R2 object at
`artifact-shares/<brand>/<shareId>.json` is the **single authoritative policy**:
owner, original org, selected version/snapshot, audience, active/revoked status
and current public token. The API validates its identity against the database
row; the Worker validates its schema, brand, share ID, state and public token.
Missing/invalid/unavailable policy never authorizes content.

Sharing first copies the selected bytes into private snapshot keys. File copies
stay in the private artifact bucket; HTML bundles stay in the hosted-sites
bucket under `shared-artifacts/<brand>/<snapshotId>/<deploymentId>`. No upload
credentials are issued for those keys. This prevents still-valid upload PUT
credentials from modifying already shared content. A snapshot is reused for
later audience changes to the same version. No public bucket or mutable legacy
site pointer is created or updated; no thumbnail renderer or image-transform
URL is introduced.

The identity is committed before publishing. Owner mutations serialize with a
row lock, copy all required objects, then write the authoritative R2 policy.
No grant is written if a copy fails. A successful response follows the R2 write;
R2 provides strongly consistent object reads and writes. Writes use `If-Match`
against the ETag from the same policy read, or `If-None-Match: *` for creation.
Every mutation includes a unique revision, preventing identical audience changes
from reusing an earlier validator. A delayed writer that loses its DB lock cannot
overwrite a newer acknowledged state; conditional-write failure returns an error
and requires reloading the current policy. There is no KV policy
replica or policy cache. If the connection/response fails after a write, the
client must reload sharing state; the write may already have applied. The next
status read uses the same R2 authority, so a failed DB commit cannot restore a
previous public scope. Failed copies can leave unreachable private snapshots.

## Delivery, caches and revocation

Organization resolution calls the existing Clerk infrastructure with the exact
original org and recipient user filter on **every resolve**. It bypasses the
60-second role cache, so no membership-cache TTL is added. The same fresh
membership check also protects owner management. The existing member
removal path still clears that role cache for other consumers. Clerk errors
fail closed. The API then issues a file signature or an isolated `ps-` HTML
preview credential lasting 15 minutes. Organization credentials are stored under
`shared-previews/`, separate from owner `private-previews/` credentials; changing
the hostname prefix cannot turn one into the other. HTML grants include the selected snapshot;
all HTML, CSS, JS, images, navigation and downloads use that isolated origin.
Normal app cookies/tokens never enter it. CSP disables workers/service workers.

Removal or stopping blocks subsequent organization resolution. Already-issued
file signatures and HTML origins are bearer capabilities: copies can still be
used until their expiry. Allow for an in-flight resolution plus the 15-minute
delivery lifetime; this is not instant revocation of issued credentials. Content
already downloaded or rendered cannot be recalled. Owner `pv-` previews remain
separate owner credentials with their existing lifetime.

Public delivery reads the authoritative policy before every content-cache lookup,
including HEAD and HTML assets. The policy includes routing/manifest data, so
there is no second manifest fetch on the public path. Only immutable content is
cached with Cloudflare Cache API, keyed by snapshot and resource. Responses sent
to browsers/downstream CDNs are private/no-store, requiring requests to re-enter
the Worker. A revoked token cannot use a warm content cache. Requests already
authorized and in flight can finish. Public state has no propagation TTL.

Public single-file delivery currently serves whole objects (the existing host
Worker does not implement Range delivery). Measure large media and native
browser downloads during rollout acceptance.

## Rollout and remaining acceptance

Deploy the additive migration and new API, host Worker bindings/code, app Worker
handoff headers and frontend before enabling a test cohort. The host Worker adds
bindings to the already-created `user-artifact-private-dev` / `-prod` buckets.
This PR does not change live infrastructure, credentials, CORS or activation.
The new `ps-` prefix and separate grant namespace ensure an older Worker cannot
serve an owner bundle in place of its shared snapshot. New links may be unavailable during a
mixed deployment; the non-GA switch stays off until all surfaces are ready.
Historical public objects, aliases and flag-off creation behavior are unchanged.

The issue remains open until full per-PR/staging acceptance and the controlled
warm P95 TTFB target (no more than 10 ms regression) pass. Measure single files
and HTML waterfalls, cold/warm authorization and cold/warm bytes separately,
and report client-observed P50/P95/P99 by region. Local Worker tests or CPU time
are not regional latency evidence. The PR pipeline currently does not deploy a
per-PR host Worker; exact-origin CORS, wildcard TLS/routing, native downloads and
all-cookie-blocked browser behavior require the corresponding dev deployment.

Retain follow-ups for private snapshot/expired-grant retention and lifecycle
cleanup, direct connector outputs, arbitrary hosted-asset ingestion by providers,
and the remaining derivative/consumer audit from #32492. Sharing selected user
messages copies their attached files into immutable public objects under
`artifacts/shared-threads/<shareId>/`. The snapshot stores their filenames,
content types, sizes and public URLs; annotated images publish their rendered
annotation copy. Every source is resolved for the sharing owner and original
organization before publication. Private artifact references in message content
use the parent conversation grant described in
[shared-thread snapshots](shared-thread-artifact-snapshots.md), without changing
the source artifact's policy. Copy or registration failures reject creation;
there is no partial snapshot, retry or failed-copy reclamation. This change adds
no organization-recipient Drive export or editing authority.

Shared-thread attachment metadata is stored in `shared_threads.message_attachments`,
keyed by the snapshot's message index. The existing `messages` JSON keeps its
previous strict shape, so old API readers can still serve the text. The additive
column defaults to an empty object for historical shares and old writers; no
attachment backfill or cleanup phase is required. The current API combines these
columns into the optional `messages[].attachments` response field. Apply the
migration before promoting that API through the normal release workflow.

## Local verification for slice 4

Targeted route tests use real HTTP handlers and PostgreSQL, with only storage
and Clerk mocked at their external boundaries. Browser verification uses the
actual host Worker with synthetic private R2 and Cache API storage in local
Chromium; it is not a staging App/API deployment.

With all cookies blocked, public content/resources, warm-cache revocation,
organization preview, direct/nested navigation and expiry denial passed. Native
CSV downloads were cancelled in the all-cookie-blocked and recording contexts. A control run allowing
first-party cookies while blocking third-party cookies confirmed that the
cross-site iframe could not write cookies, then successfully downloaded and
verified the CSV from the direct organization origin. Default-cookie downloads
also passed. Full staging, deployment routing and regional latency remain open.
