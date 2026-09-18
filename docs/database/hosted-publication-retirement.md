# Hosted publication version retirement

Tracking: [#35240](https://github.com/vm0-ai/okou/issues/35240).
The immutable publication prerequisite
[#35244](https://github.com/vm0-ai/okou/pull/35244) merged as
`899075caeca519ac9202fa17bc9177e18258a58c`. A merge is not a production
promotion or evidence that earlier writers have drained.

## Current executable boundary

Each new prepare owns a new site and deployment. Creation no longer reads or
increments a version counter. Public bytes use
`sites/brands/okou/publications/<deploymentId>`; private bytes retain
`private-sites/<brand>/<deploymentId>`. Existing rows continue using their
stored prefix. No object is moved, overwritten with different bytes, or deleted.

New immutable public completion binds an empty alias or retries its existing
deployment binding; it does not choose the greatest publication version. An old
writer retained for rollback can still add another deployment to that site, so
the immutable marker alone is not a one-deployment database constraint. If that
writer already selected another deployment, retrying the original immutable
publication must not reclaim the alias. Unmarked historical uploads retain the
old ordered completion rule, including when a newer upload finishes first.

`deploymentVersion=1` in each new manifest is a compatibility projection, not
allocated identity. The runtime transition release additionally retains physical
column defaults for its predecessor; the separately gated contraction removes
them. Old API responses, history and version selectors remain supported at the
boundary below. New CLI output and commands
do not expose publication versions; `host clone` accepts the returned slug,
deployment URL or artifact reference. The current App compares share target IDs,
not publication numbers. Newly uploaded artifacts use the allocated filename
without a version suffix.

Manifest `version`, pointer `version`, policy format versions, snapshot formats
and execution-context protocol versions remain unchanged.

## Runtime version-column retirement

The runtime transition release removes publication-version columns from the application
mapping, including implicit `SELECT` and `RETURNING` lists. The canonical
runtime tables share the physical schema's column factories; only the physical
DDL retains the four compatibility columns during that release:

- `hosted_sites.next_deployment_version`
- `hosted_sites.active_deployment_version`
- `hosted_deployments.deployment_version`
- `private_hosted_deployments.deployment_version`

Historical `?version` lookups, upload completion ordering and wire fields read
`manifest.deploymentVersion`. New publications keep the fixed value `1` in that
metadata for retained readers, while deployment IDs remain content identity.
The active version is derived from the public row selected by
`active_deployment_id`; it is no longer independently stored by the API.

The migration copies each existing relational version into its manifest and
removes the manifest key when the old public version is null. It updates only
mismatches and rotates their `manifest_hash` compare-and-swap tokens so an
in-flight dependency collector cannot restore pre-migration metadata. Manifest
files, dependency hashes, object prefixes, IDs, ownership and policies stay
unchanged. An inconsistent public pointer, active version or manifest shape
aborts the transaction. Expression indexes preserve unique historical lookup
and avoid scanning all deployments for a version.

Three column defaults support new inserts while the previous API can still
read the physical columns. The temporary
`mirror_hosted_site_active_version` trigger projects an updated public pointer
into the previous API's active-version column. This bridge exists only because
production migrations run before API promotion; remove it together with the
four columns after the runtime-cleanup release is serving and is the oldest
supported API rollback target. No application query depends on the trigger's
output.

| API binary                                 | Expanded schema                              | Schema after version-column removal                          |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| Preceding API with physical version fields | Supported by defaults and pointer projection | Unsupported: implicit column lists still name removed fields |
| Runtime-cleanup API                        | Supported                                    | Supported: queries and inserts use canonical columns only    |

The physical-drop PR is a separate release. Merging both changes into one
production release would not satisfy this boundary. Confirm the runtime-cleanup
API is serving and older API artifacts have left supported rollback targets
before admitting that PR for release. The current CLI and App already use
artifact identities; retained historical selectors can continue without these
physical columns.

This duplicate-field cleanup does not reparent deployments or consolidate
tables, so it needs no R2 object or policy migration. Full DB/R2 reconciliation
below remains required for changing site/catalog/share identities or table
isolation. It is not a blocker for this metadata-only migration.

## Physical version-column retirement

Migration `1169_retire_hosted_publication_version_columns` is the separate
contraction. It drops the four columns, their two relational version indexes and
the temporary pointer projection trigger/function. The canonical manifest
expression indexes remain. No deployment, site, share or uploaded-file row is
deleted; IDs, manifests, byte locations, policies and legacy selectors stay
unchanged.

Before dropping anything, the migration checks the runtime transition journal,
the old column definitions, exact manifest/version mappings, public bindings,
the known temporary function and persisted SQL dependencies. An inconsistency
or unexpected dependency aborts the complete transaction. Normal migration lock
and statement timeouts still apply. These database guards cannot establish which
API binaries are serving or eligible for rollback.

**Release gate:** ship the runtime transition in its own release first, verify
that API is serving and is the oldest supported API rollback target, and drain
its predecessor before admitting the contraction for release. Keep the
contraction PR in draft until this evidence exists. Merging the runtime PR alone
does not satisfy the gate. This document and the migration do not establish
production readiness or authorize production execution.

The history audit now emits receipt version 2 and reads retained versions from
manifests. It removes observations about the retired duplicate active-version
column; pointer identity, ownership, status and reference checks remain.

## Reader and writer inventory

| Surface                         | Current authority / dependency                                                           | Retirement condition                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Host prepare                    | New site + deployment ID; fixed version projections                                      | Old API serving and rollback writers drained before removing projections                                                |
| Host complete                   | Stored manifest/prefix; public alias binding; legacy version ordering                    | Historical pending uploads accounted for before removing legacy completion                                              |
| API files/history               | Direct deployment URLs, owner slug aliases, optional version selector                    | Historical content discovery replacement and pinned CLI drain                                                           |
| CLI                             | Current package removes `host versions` and `clone --version`                            | Verify the serving API selects the new immutable CLI package; inspect queued, claimed and finalizing execution contexts |
| App sharing                     | `selectedTarget.id` identifies the selected artifact                                     | Retain old response fields until supported older App readers are excluded                                               |
| Catalog                         | `site:<siteId>`, hosted entity ID, presentation's site FK, projection file               | Preserve catalog IDs and map every historical deployment before changing grouping                                       |
| Uploaded files / thumbnails     | Deployment ID, site ID, URL and legacy metadata                                          | Preserve external ID, file ID, preview and artifact-reference mappings                                                  |
| Sharing                         | DB `artifact_shares.target_id` is a **site ID** for HTML; R2 policy selects a deployment | Preserve each share ID, selected target, snapshot, audience and revocation state                                        |
| Delivery / previews / snapshots | Stored manifests, reference index, aliases, policy and object prefixes                   | Validate original links and authorization against retained byte locations                                               |
| Erasure                         | Site/deployment ownership, chat scope and existing cascades                              | Preserve deletion scope; never turn a historical group delete into unrelated publication deletion                       |
| ORM / schema                    | Canonical runtime mapping omits the four physical version columns                        | Runtime transition must serve and define the rollback floor before physical contraction                                 |

The Runner itself does not select a hosted publication version, but execution
contexts pin the CLI by commit. Package semver or the merge time does not prove
that queued and running consumers have finished. Apply the lifetime and rollout
rules in [deployment compatibility](../deployment-compatibility.md).

## Observed history and coverage

The read-only MaskDB projection was fully paged and read twice on 2026-09-18
around 09:09–09:10 UTC. Both projections agreed: 12,976 sites and 22,135 public
deployment rows (22,081 ready, 54 uploading). 1,915 sites contained multiple
public deployment rows, covering 11,103 rows; the maximum was 414. Of these,
1,908 sites had multiple ready rows, covering 11,051 ready rows.

These are a bounded public projection, not a migration receipt. The exposed
schema omitted `private_hosted_deployments`, `artifact_shares` and publication
version columns, and masked deployment IDs and active pointers. Twenty-nine
sites had no visible public deployment; they cannot be classified as empty.
Seventeen public deployment/site user-ID differences require preservation and
investigation rather than ownership rewriting. No missing site or organization
mismatch was observed in that projection. It did not establish private history,
alias validity, object existence or share-policy completeness.

Run the checked-in
[`audit-hosted-publication-history.sql`](../../turbo/packages/db/scripts/audit-hosted-publication-history.sql)
against an authorized complete database view before designing the backfill. It
uses a bounded read-only repeatable-read transaction and returns aggregate
counts. It fails when required tables/columns cannot be read; a missing table
must never mean zero history. Use a fresh `psql -X` session with
`ON_ERROR_STOP=1`. Its result still does not inventory R2 policies or confirm
object existence, and never authorizes a write.

## Preservation contract for the subsequent migration

Inventory all rows and statuses from both deployment tables, including failed,
uploading and deleted rows. Never use `DISTINCT ON (site_id)`, maximum version,
or the active pointer to choose the population to retain. The fixed-content
mapping must include at least:

| Existing key                                            | Required preserved mapping                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Storage class + deployment ID                           | One immutable content identity with its original status, manifest/hash/prefix, owner, org, brand and chat scope |
| Site ID + publication version (including null)          | Legacy lookup for every historical row until supported version selectors retire                                 |
| Brand + public slug                                     | Original public alias target; never the newest private deployment                                               |
| `dpl-<id>` / artifact references / catalog ID / file ID | Original deployment or snapshot, without changing stable URL/ID                                                 |
| Share ID + policy target + snapshot ID                  | Exactly the originally selected deployment and audience, including revocation                                   |

Do not rewrite deployment `site_id` without accounting for manifest `siteId`,
policy `target.siteId`, uploaded metadata and presentation foreign keys. Do not
copy one site's public policy onto all its historical private deployments.
Non-selected private content remains owner-only. The database share row is only
an ownership index; the R2 policy is the authority for audience and selection.

New publications already have independent site/catalog/share identities. The
historical catalog needs a separate deployment-to-artifact mapping and an old
catalog-ID adapter; replacing all entity IDs in place would break saved links.
Migration code must fail on missing/ambiguous mappings, record before/after
cardinality and permissions, and reconcile writes made during any backfill.

## Table consolidation decision

Do not merge or drop the three tables at this frontier. `hosted_sites` owns name
reservations, scope and legacy public aliases. Both deployment tables own upload
state, owner, manifest, hashes, byte count and storage locations; they are not
version lists alone. The private table deliberately prevents older public-only
API binaries from publishing private content. Removing that isolation before
those binaries leave the rollback set creates a disclosure path.

After the complete mapping is verified, migrate these responsibilities to a
fixed-content relation while retaining aliases and public/private storage
classification. Keep the old relation as a compatibility projection until
readers, writers and supported rollback binaries no longer require it. Only
then remove unused tables with Drizzle-generated migration metadata. The
duplicate version-column contraction described above does not perform this
broader identity or table migration.

## Required gates for broader identity and table migration

1. Record the serving API SHA, selected CLI package SHA, supported App floor and
   rollback targets. Verify old redeploy writers no longer serve, and queued,
   claimed and finalizing old CLI contexts have drained.
2. Complete the database and R2 inventory, including aliases, reference indexes,
   snapshots, catalog projections and policies. Reconcile every referenced
   deployment and the observed ownership differences; retain all history.
3. Resolve old incomplete uploads and wait out old unsigned-checksum upload
   credentials before marking historical bytes immutable. Never stamp the cache
   marker merely because the row is ready.
4. Ship and verify an additive data migration/reader transition. Cover old URLs,
   direct deployment downloads, cross-org public downloads, private previews,
   organization/public sharing and revocation, failed and incomplete uploads,
   out-of-order completion and retry through their production entry points.
5. Ship the ORM/wire contraction only after its consumer gates. Physical schema
   cleanup follows in another release after old `SELECT`/`RETURNING` statements
   and rollback targets are gone. Production migration precedes API promotion;
   migration and incompatible old code must not overlap.

The preparation PR supplied the read-only audit. Runtime version-column
retirement normalizes duplicate database metadata; its separately gated
contraction removes that duplication without moving content or identities.
Local acceptance of either migration does not promote production, change
permissions or establish the physical-drop release gate.
