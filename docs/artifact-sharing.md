# Artifact sharing

New-policy private artifacts use the existing `privateArtifacts` switch. Its
code default remains `false`. The API resolves the owner/original-org switch
for new grants and audience/version changes; the app uses the same switch for
its Share menu and standalone viewer. Stored policy enforcement, organization
resolution and stopping an existing share do not depend on the rollout switch.

## User flow

The owner opens an artifact's existing Share menu, which contains only
**Share to organization** and **Share to Public**. Choosing either option shares
the displayed version and copies its link. If that version already has the
chosen audience, the action copies the existing link. An explicit share action
also allocates a short organization reference or named public site URL for an
older share that lacks one. Opening the menu is read-only. Upload, generation,
hosting create no artifact grants. Thread sharing creates independent resource
snapshots under its own grant; see [shared-thread snapshots](shared-thread-artifact-snapshots.md).
Recipients cannot edit or reshare the original artifact.

- Organization: `https://app.okou.ai/artifacts/<10-character-reference>.<extension>` (the configured
  `APP_URL` in other environments). The app uses existing login with a same-origin
  return path, then calls the API with its session. The API checks the grant and
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
link; the organization link stays stable. Repeating the action for the already
shared version only copies that link.
CLI/model URLs continue to be stable authenticated API references.

## Standalone artifact viewer

The shared `privateArtifacts` switch applies to
`/artifacts/<compact-reference>[.<extension>]` and the legacy
`/share/artifacts/<shareId>` route. Both retain the existing login and resolver
authorization. The viewer reuses the lightbox's media and document previews,
image zoom controls, and download action in a full-page canvas with the shared
thread page's brand header. There is no fullscreen action. The header restores
the app's theme preferences and **Continue with Okou** uses the shared primary
button colors.

The viewer's **Share** button directly copies the current app URL and reports
clipboard success or failure. It never creates a grant, changes an audience,
publishes content, or copies the temporary preview credential. Download resolves
the canonical reference again and saves the original filename. HTML remains in
the isolated preview origin inside a sandboxed iframe; URL fragments, including
slide and PDF page positions, are retained. **Continue with Okou** opens a new
chat with the canonical artifact link as its prompt, without importing the
source thread.

Organization references contain 10 lowercase alphanumeric characters, matching
generated image reference length. An immutable R2 record at
`artifact-references/<reference>.json` maps the reference to the internal share
UUID. Conditional creation retries collisions without overwriting another share.
The reference grants no access: every resolution still checks the authoritative
share policy and original-organization membership. Existing 32-character
`/artifacts/` references and `/share/artifacts/<shareId>` links remain supported.

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
