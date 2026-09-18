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

`deploymentVersion=1` and `nextDeploymentVersion=2` are temporarily written as
compatibility projections, not allocated identity. The latter prevents a retained
old writer from trying to insert version 1 again. The private deployment table
also still requires a non-null version. Old API responses, history and version
selectors remain supported at the boundary below. New CLI output and commands
do not expose publication versions; `host clone` accepts the returned slug,
deployment URL or artifact reference. The current App compares share target IDs,
not publication numbers. Newly uploaded artifacts use the allocated filename
without a version suffix.

Manifest `version`, pointer `version`, policy format versions, snapshot formats
and execution-context protocol versions remain unchanged.

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
| ORM / schema                    | Naked `select()` / `returning()` include version columns                                 | Deploy code without those references, drain that predecessor, then drop columns in a later release                      |

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
then remove obsolete counters, ordering fields/indexes and unused tables with
Drizzle-generated migration metadata. No destructive migration is included in
this preparation change.

## Required release gates and validation

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

The current preparation PR changes code and supplies the read-only audit. It
does not promote production, migrate historical rows, change permissions, or
claim that these release gates have passed.
