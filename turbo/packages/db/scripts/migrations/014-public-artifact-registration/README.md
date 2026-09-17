# Historical public artifact registration (#32492)

Register existing public file keys, site aliases and immutable deployment URLs
without moving bytes, changing old URLs or modifying ownership. The script only
writes `artifact-delivery/` JSON records to the hosted-sites bucket. Existing
Public records must match exactly; private/revoked/publication records are never
overwritten. Database access is read-only. The script freezes its v1 format and
has no runtime imports from application contracts or ORM schema modules.

## Before running

Deploy the App/API reference readers, compatible CLI consumers, the API's
public registration writers and the compatible host Worker before enabling
`privateArtifacts`. Existing authenticated API references remain readable for
persisted messages; new private writes return hostless references.

Pre-registry organization and `sh-` Public links also remain readable. Reading
their share status preserves the working legacy URL without writing metadata;
an explicit publication update adopts the registry format. These readers remain
until #32492 accounts for every retained pre-registry share link. The historical
Public inventory below does not rewrite existing share policies.

Deploy incremental registration first while `privateArtifacts` stays off. Every
public file write, immutable write, presigned PUT and multipart initiation must
successfully reserve its exact registry metadata before exposing bytes or upload
credentials. Registration failure fails the upload/generation request. Upload
completion registration remains a backstop for credentials issued by older API
instances. Site aliases register before their public pointers are published.
These hooks run regardless of the switch.

Drain earlier API writers and their already-issued upload credentials before
accepting final coverage; current public PUT credentials last up to one hour.
Multipart completion can outlive those signatures. The migration also inventories
all pending public multipart uploads, including their pagination, before its final
object scan. An old session without a valid public registration blocks verified
coverage until it completes or expires in storage; newly pre-registered sessions
can continue. The report includes pending and unregistered multipart counts.
Run an independent verification after this drain. API binary rollback must
retain incremental registration. Use the same
`privateArtifacts` rollout switch for new artifact behavior; there is no second
feature switch. The R2 completion marker records a completed data migration.
After finalization, API binary rollbacks must retain these registration writers;
turning the shared feature switch off remains supported.

Set `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_USER_ARTIFACTS_BUCKET_NAME`,
`R2_USER_ARTIFACTS_ACCESS_KEY_ID`, `R2_USER_ARTIFACTS_SECRET_ACCESS_KEY`,
`R2_HOSTED_SITES_BUCKET_NAME`, `R2_HOSTED_SITES_ACCESS_KEY_ID`, and
`R2_HOSTED_SITES_SECRET_ACCESS_KEY` in the execution environment. Do not pass
credentials as arguments. Public-bucket credentials need object read/list;
hosted-bucket credentials need read/list and, only for migration, object write.
Never point this inventory at the private-artifact bucket.

## Commands

Run from `turbo/packages/db`:

```bash
# Check pending multipart registrations without scanning objects or using the DB.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/multipart.ts --report multipart.json

# Default: two read-only inventories, DB reconciliation and conflict report.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --report inventory.json

# Register missing Public metadata and verify each record immediately.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --migrate --verify --report registered.json

# Independent read-only verification after registration.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --verify --report verified.json

# After old writers drain and coverage is reconciled, close legacy lookup.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --migrate --verify --finalize --report finalized.json
```

`--migrate` always performs exact read-back; `--verify` also permits independent
read-only verification.

The standalone multipart command uses only the R2 environment variables above;
it does not need `DATABASE_URL`. It lists pending uploads and reads their frozen
v1 registry records. It writes an aggregate report before exiting: zero for a
clear multipart gate, one for unregistered sessions. Both outcomes have
`verified: false` and `finalized: false`; this preflight cannot establish full
object coverage. Invalid registrations, incomplete pagination or storage errors
also fail the command. It accepts no migration, verification or finalization
flags and never writes storage, completes uploads or aborts parts.

The report includes the scan interval, pending/unregistered counts, oldest and
newest unregistered initiation times, and a count of sessions whose optional
initiation time is absent. It contains no object keys, upload IDs or filenames.
Missing initiation times stay unknown; a present invalid timestamp fails the
check. Consult the actual bucket lifecycle separately before estimating expiry.
Age alone does not prove storage has aborted a session, so recheck the live
multipart gate before scheduling full verification.

Every pass is paginated and limited to 100,000 objects per bucket by default;
`--max-objects` can explicitly raise that bound. Production already exceeds this
default. R2 operations use bounded concurrency (default 16; `--concurrency` accepts
1–64) and drain in-flight work before reporting failure.

The final pass re-inventories storage, reconciles the database again, and reads
every registry record. Concurrent additions are accepted only when their exact
registration already exists. Missing registrations, unknown keys, incomplete
pagination, missing manifests, deleted/unready DB deployments, conflicting aliases
and private metadata block verification. Conditional writes are restartable; a
retry fills missing records without overwriting existing ones. Every existing alias is checked for conflicts
before the first write. A blocked `--report` includes the complete conflicting
alias-key inventory; successful reports contain counts and an inventory digest.
Reports never include credentials or artifact contents. Unclassified file keys must be
reconciled before finalization rather than silently treated as Public.

Historical brandless metadata retains its existing VM0 interpretation. Old site
aliases continue to follow the same mutable active pointer; deployment URLs stay
pinned. The completion marker makes unregistered site aliases unavailable.
Keep it after feature-switch rollback: already-established permissions remain
enforced. Follow-up #32492 removes the pre-registration compatibility reader
after complete production coverage and the old-writer drain are verified.

The 2026-09-09 public inventory also contains legacy `html-edit-drafts/<uuid>.html`
objects and 29 Desktop recording sidecars without R2 Content-Type. Drafts undergo
the same private-metadata and authoritative-database checks as all public files.
Missing HTTP metadata first uses an exact existing public registration or a
unique non-null `run_uploaded_files.content_type`. Desktop recorder uploads can
have neither: the old Blob PUT omitted Content-Type, and the DB row is created
only when the recording is attached to chat. For the recorder's exact filename
and storage-key patterns, the migration can recover `application/json` by reading
at most 1 MiB with the HEAD ETag as an `If-Match` condition and verifying the byte
length, UTF-8 JSON and frozen v1 recording signature. A changed object, invalid
JSON, unknown format or oversized body blocks the pass before any registration.
This is limited to the migration; ordinary missing MIME types still fail.
Pre-registration also covers an uploaded object whose
client has not called completion yet. Existing upload headers/signature semantics
remain compatible with already-deployed App, CLI and Desktop clients. This
persisted-data compatibility is owned by #32492 and can be retired when historical
delivery no longer requires this migration. No MIME type is inferred from a file
extension alone, and no source object is rewritten. The read-only audit of all 29
historical sidecars found matching v1 JSON bodies (269–54,078 bytes); both older
click-only records and later optional pointer/typing fields are recognized.

## Production phases

1. Release incremental registration with `privateArtifacts` off. Keep `a.okou.io`
   on its current public R2 path, including its existing Cloudflare cache and image
   transformations. No Worker route or cache-rule changes belong to this phase.
2. Run the protected **Public Artifact Registration** GitHub Action on `main`: first
   `dry-run`, then `migrate` after the old-writer and upload-credential drain.
   After a successful backfill, `migrate` starts a separate read-only `--verify`
   process with fresh storage inventories and database reconciliation. The same
   protected job continues through both passes and succeeds only if both succeed.
   Its artifact preserves `public-artifact-registration.json` for the backfill
   and `public-artifact-registration-verification.json` for the independent pass,
   including the first report if the second pass fails. The `verify` mode remains
   available for a standalone read-only run. It first checks multipart registrations
   before resolving the database or scanning objects. The explicit `multipart-check`
   mode runs only that same preflight, preserving
   `public-artifact-registration-multipart.json` even when sessions block it.
   It never resolves the production database or starts the historical inventory.
   A clear preflight still requires the full independent pass, including the
   original multipart check immediately before its final object inventory; the
   early check does not replace this race boundary. The historical `dry-run` and
   `migrate` modes keep their existing sequence, so a pending upload cannot stop
   an authorized backfill of already-completed objects before its writes.
   All modes use production R2 credentials; full inventories also use read-only
   Neon queries. No workflow mode passes `--finalize`. Accept coverage only
   with zero missing, conflicting or unclassified records and zero unregistered
   pending multipart uploads.
3. Prepare the cache policy and review the separate `a.okou.io` delivery cutover
   (#32959). It serves registered public files and opaque public-share aliases
   through `zero-host-worker`. Preserve old URLs, one-year caching and public
   image transformations; new shares require policy checks before byte-cache
   reads. Follow the cutover order and the explicitly accepted production
   exception below. That exception does not certify full registration coverage.
4. Finalize registration and enable new private artifact behavior only as separate
   rollout decisions. Completion markers close the legacy site fallback, so they
   are intentionally excluded from the first production phase.

The unlaunched `f.okou.io` domain is retired; it is not a rollout prerequisite.
The current API/Worker file-share host configuration is changed by #32959, not by
this registration rollout. Private preview URL lifetime and renewal are tracked
separately in #32977; image derivatives and private video/HTML previews remain
follow-ups in #32492.

## Unified public file domain

Both historical public files and new Public file shares use `a.okou.io`.
Historical aliases resolve their `legacy-file` record to the same object in the
public bucket. This also covers new flag-off writes, whose exact registration
precedes upload. GET/HEAD/Range and the one-year cache policy depend on that
registration kind, not the object's creation date. Existing `cdn.*` endpoints
keep their direct public storage behavior.

New shares resolve a `publication` record and read the current R2 share policy
before private snapshot bytes or any content-cache hit. Their browser response
is `private, no-store`. Only canonical file-share paths are accepted, including
the temporary `/artifacts/` rewrite form; encoded or trailing-slash variants
must not expose share bytes through the legacy cache rule.

The unlaunched `f.okou.io` DNS and route were removed on 2026-09-09; #33017
already removed its deployment route. Retain the shared `zero-host-worker`,
`*.okou.app/*` and `*.sites.vm0.io/*` routes. Staging continues to use
`files.sites.vm7.io` on its existing wildcard. Never attach a public domain to
the private bucket, move public bytes or delete historical objects.

### Accepted production state on 2026-09-10

Incremental registration is deployed. Backfill wrote the missing registrations;
independent run [34422606017](https://github.com/vm0-ai/vm0/actions/runs/34422606017)
passed its completed-object missing/unclassified assertions but failed on three
old unregistered multipart sessions. The subsequent
[preflight](https://github.com/vm0-ai/vm0/actions/runs/34453611593) confirmed those
sessions still blocked full acceptance. Under the
[maintainer decision in #32492](https://github.com/vm0-ai/vm0/issues/32492#issuecomment-5599918851),
these three sessions no longer block advancing #32959. They are not registered,
verified or finalized by this decision. Preserve their parts and lifecycle; do
not bypass the verifier or write completion markers. A late completion of one
of those old sessions can still require reconciliation.

Cache preparation was applied and independently read back on 2026-09-10. The
existing one-year override excludes the prospective public-share filename
shape on both short and `/artifacts/` paths. A full 145,548-object public-bucket
listing found no existing paths excluded. Cold requests for a post-change
upload and recent generated/completed-multipart samples showed MISS then HIT
with a one-year cache header; old image resizing, HEAD and Range remained
usable. This cache inventory does not replace database/registry verification.

### Production cutover order

Releasing the Worker configuration attaches `a.okou.io/*` even while
`privateArtifacts` is off. A code merge alone does not deploy that route.

1. Retain the deployed incremental registration hooks and the completed-object
   backfill. Carry the three-session exception above explicitly; final coverage
   and completion markers remain separate decisions.
2. Preserve the applied one-year cache rule for legacy paths and its exclusions
   for a 24-character basename plus a 1-12 character extension, both with and
   without the `/artifacts/` prefix. Preserve error-response no-cache behavior
   and unrelated `cdn.*`/static rules. Do not change the entire host to
   `respect_origin` while direct R2 delivery is active: most historical objects
   have no origin Cache-Control, so that would shorten their cache lifetime.
3. Keep the R2-managed `a.okou.io` DNS/custom-domain binding. Deploy the reviewed
   Worker with `a.okou.io/*`, `PUBLIC_ARTIFACT_HOST=a.okou.io` and its existing
   public/private bucket bindings. The file reader accepts the live rewrite's
   `/artifacts/` prefix, preserving registered links across this transition.
4. Verify legacy GET/HEAD/Range and resized-image requests through the Worker.
   Disable the rewrite named
   `Serve a.okou.io short artifact paths from /artifacts in R2` after this
   verification. Verify the original short paths again. Once the Worker
   supplies the one-year legacy response headers, the entire host's browser
   and edge TTLs can separately move to `respect_origin`. That optional rule
   cleanup was not performed by the cache preparation above. Restore the R2
   rewrite and legacy one-year rule before any rollback to direct R2 delivery.
5. Deploy the matching API configuration
   `PUBLIC_ARTIFACT_SHARES_BASE_URL=https://a.okou.io` and App URL recognition.
   Keep `privateArtifacts` off; the hostname change does not enable it or add a
   second switch. Before later activation, use an authorized test cohort to
   verify Public access, warm-cache access, revocation, organization audience
   and republishing on the exact production origin, including rejection of
   noncanonical paths. Confirm new shares remain `private, no-store`.

Image Resizing has a separate derivative cache that cannot enforce current
share permissions. The Worker rejects Image Resizing source requests for
publication records. The [protected thumbnail and short-file rollout](../../../../../../docs/artifact-preview-rollout.md)
adds binding-based thumbnails with authorization before every cache read and
requires extending the cache exclusion to ten-character filenames. Follow that
deployment order before an API emits the shorter Public file links.

Immutable alias metadata has its own cache; the mutable policy remains an R2
read on every share request. Missing aliases are not cached. File aliases use
one global namespace across both brands. Measure regional cold/warm latency
before feature activation. Under #32492, remove the temporary prefix
normalization after the rewrite is disabled and supported infrastructure
rollback no longer depends on it. Finalization and private-preview lifetime
work remain independent of the domain cutover.
