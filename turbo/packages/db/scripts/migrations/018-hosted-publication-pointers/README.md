# Named HTML publication aliases to public site pointers (#36468)

This bounded external-data migration converts explicitly selected historical
Public HTML site aliases into rolling public sites. It preserves the currently
shared snapshot as the initial public deployment. Future ordinary uploads can
then move the site's active pointer forward. It does not migrate file shares,
thread resources, revoked/organization/private shares, or unselected sites.

The migration keeps all old snapshot bytes, private deployment rows, share
identities, token aliases, and immutable deployment URLs. Existing token URLs
continue using the original share policy and snapshot. The named site URL becomes
public independently of that old policy, as approved for these historical sites.
No existing object is deleted, and no source object is rewritten.

## Release prerequisites

1. Deploy the compatible API that serializes hosted-site completion using the
   site row followed by the share row, handles same-site alias conversion, and
   checks both DB and R2 deployment versions before promotion. Drain older API
   writers. The old HTML share creation/update entry point must be closed.
2. Deploy the Worker that reads named HTML delivery records without trusting an
   older 24-hour registry cache entry. Verify the production Worker version; a
   merged source change does not establish that the cache cutover has shipped.
3. Review a fresh, complete inventory of the explicitly selected organization
   and sites. The tool checks the authoritative unmasked database and R2 again;
   a masked-database inventory alone cannot establish migration eligibility.
4. Start with one site. Verify its ordinary URL, token URL, immutable deployment
   URL and a newer normal upload before selecting the remaining sites. A newer
   upload is performed through its normal authenticated owner API, separately
   from this historical-data tool. Exclude this canary from the remaining
   bootstrap batch after its normal upload becomes active; the old bootstrap
   plan correctly refuses to replace that newer publication.

No production execution is performed by adding these files. Run through the
repository's protected production operation after the release prerequisites,
using credentials from its existing secret-injection mechanism. Do not pass
credentials in command arguments or put them in a plan/report.

## Environment and commands

Set `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_HOSTED_SITES_BUCKET_NAME`,
`R2_HOSTED_SITES_ACCESS_KEY_ID`, and `R2_HOSTED_SITES_SECRET_ACCESS_KEY`.
Dry runs need DB SELECT and R2 GET only. Apply also needs writes to
`hosted_deployments`, `hosted_sites`, and (only if missing) the site catalog in
`artifacts`/`presentation_artifacts`, plus conditional R2 PUT. The script uses
the frozen production domains `okou.app` and `sites.vm0.io`.

Run from `turbo/packages/db`:

```bash
# Read-only full preflight; writes a local plan with mode 0600, never production.
pnpm exec tsx scripts/migrations/018-hosted-publication-pointers/backfill.ts \
  --org-id "$SELECTED_ORG_ID" --site-id "$SELECTED_SITE_ID" \
  --plan selected-site.json --report preflight.json

# Apply exactly the reviewed plan; the default maximum is one selected site.
pnpm exec tsx scripts/migrations/018-hosted-publication-pointers/backfill.ts \
  --org-id "$SELECTED_ORG_ID" --site-id "$SELECTED_SITE_ID" \
  --plan selected-site.json --migrate --report migration.json

# Independent read-only recheck of the same initial deployment, before a newer upload.
pnpm exec tsx scripts/migrations/018-hosted-publication-pointers/backfill.ts \
  --org-id "$SELECTED_ORG_ID" --site-id "$SELECTED_SITE_ID" \
  --plan selected-site.json --verify --report recheck.json

# Focused ownership, retry and version-order checks; no live services or Vitest.
pnpm exec tsx --test scripts/migrations/018-hosted-publication-pointers/test-model.ts

# CI entry: creates a random isolated database, applies current migrations,
# runs both suites and drops the database. Also runs in migration-consistency CI.
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  pnpm test:hosted-publication-pointers

# Real SQL/CLI integration against a migrated, explicitly local test database.
# S3 requests are intercepted; every fixture is unique and removed afterward.
HOSTED_MIGRATION_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/hosted_test \
  pnpm exec tsx --test scripts/migrations/018-hosted-publication-pointers/test-integration.ts
```

The integration test exercises an unchanged CLI subprocess with the real
PostgreSQL tables and an intercepted S3 HTTP boundary. It checks no-write dry
runs, a conditional alias-write failure after staging, DB/catalog rollback,
same-plan recovery, presentation metadata, preserved pending newer versions,
idempotent apply, independent verification and rejection of a later newer active
pointer. The test is skipped unless its dedicated local test database variable
is provided; it rejects hosts other than loopback/the CI `postgres` service and
non-test database names. The CI entry always provisions its own random database,
so parallel migration suites cannot share this fixture's rows.

Repeat `--site-id` and explicitly raise `--max-sites` for a reviewed batch (maximum
50). There is no implicit all-sites or all-organizations mode. All selected sites
must pass preflight before the first production write. Existing plans are never
overwritten; apply requires an existing plan and can select a subset of its sites.
The read-only `--verify` mode also requires the existing plan and checks the
committed DB/catalog state, active and immutable pointers, aliases and public
destination bytes in an independent process. It cannot be combined with
`--migrate`.
The protected `hosted-publication-pointers.yml` workflow keeps plans in the
nonserved R2 prefix `hosted-publication-migration-plans/<run-id>.json` and loads
the original plan by its run ID for apply/verify. The script's dry run is
read-only for the database, site contents and routes; the workflow additionally
writes this private plan metadata. Never attach plans to public GitHub Actions
artifacts: they contain ownership identifiers and public-share tokens. Only
aggregate reports belong in those artifacts. Reports/stdout contain aggregate
progress, not tokens or file contents.
Saved workflow plans are limited to 32 MiB. Use a smaller reviewed selection if
the plan exceeds that bound; a saved plan is never overwritten on a rerun.
The numbered source is self-contained and intentionally imports no application
contracts, ORM mappings or mutable runtime helper implementations.

## Validation and execution

For each site, preflight reconciles its owner, organization, brand, requested
name and public alias with the durable share identity, active Public HTML policy,
private source deployment and the snapshot manifest. Both named and token
registrations must identify that exact share/token; unrelated aliases are never
replaced. Every source file is read, size checked, SHA-256 checked and bound to
its ETag in the reviewed plan. `/index.html` is required, traversal/reserved paths
are rejected, and bounds are 5,000 files, 100 MiB per file and 512 MiB per site.
The full snapshot manifest and private deployment preserve `presentation-html`
kind even though the share policy's embedded manifest omits that field.

Apply commits a durable `uploading` public deployment before staging its public
files. Its deterministic UUID depends on the organization, site and snapshot;
the plan is required on retries. It reuses the snapshot's **historical version**
in the separate public deployment table. It does not allocate `max + 1`, which
would incorrectly outrank already pending newer uploads. A different public
deployment already claiming that version blocks the operation. Subsequent
normal allocation still uses the maximum across both tables.

Each public file is written with `If-None-Match: *`, with exact size/hash/type
readback. The public manifest uses the canonical manifest/content hashes, public
namespace and no private-access marker. Unregistered staged files and manifests
are not public routes. Both the immutable `dpl-` URL and the rolling site wait
for the final locked authorization check before publication.

The final transaction locks `hosted_sites FOR UPDATE`, then
`artifact_shares FOR UPDATE`, matching the API lock order. It rechecks identity,
policy, preserved token and both DB/R2 active state. Any other active deployment
or pointer, including a newer pointer whose DB transaction failed, stops this
old bootstrap. It validates/preserves the existing catalog projection or creates
a missing site/presentation projection without inventing a historical run output.
It then:

1. Removes the policy's advertised named slug using its ETag, making the existing
   token URL the advertised snapshot URL. Authorization and selected bytes stay
   the same; the named alias still serves the old snapshot at this point.
2. Creates and reads back the immutable deployment pointer and `dpl-` alias
   while still holding both locks. A revocation that wins during file copying
   prevents either public route from being created.
3. Creates and reads back the complete active pointer, accepting only exact
   matching content on retry.
4. Uses the named registration's ETag to change its `publication` record to the
   exact `legacy-site` record for that active pointer.
5. Marks the bootstrap deployment `ready` and commits the site's active binding.

DB statement/lock timeouts are 10 seconds/1 second. A 90-second idle-transaction
timeout limits stalled storage calls while row locks are held. File copying is
outside that lock interval and holds only one bounded file in memory at a time.

## Recovery and verification

R2 and PostgreSQL do not share a transaction. A failure leaves earlier durable
steps intact; rerun **the same plan**. Conditional writes accept only identical
objects or the exact expected original publication. A policy whose named slug
was already removed is accepted only with the same active Public owner, share,
token, site and snapshot. A different slug, scope, snapshot or revoked policy
blocks recovery.

| Interrupted after                      | State and retry                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Reserving the DB row or copying a file | Old named and token URLs still serve the snapshot; retry fills missing public objects.                                 |
| Redirecting the policy URL             | Token is advertised; named alias still serves the snapshot.                                                            |
| Writing the active pointer             | Old alias still serves the snapshot, or the new alias serves identical public bytes.                                   |
| Converting the alias before DB commit  | Public bytes/pointer are complete; retry repairs DB `ready` and active binding.                                        |
| A newer upload becomes active          | This old plan fails closed; verify the newer publication through the normal API. Never force the old snapshot over it. |

Successful apply independently rereads the policy/token/name registrations,
immutable pointer/alias, public manifest, every copied public file and committed
DB rows. A repeated dry run checks source integrity and current plan ownership;
it is not a replacement for HTTP/Worker verification or a success claim about a
later normal upload. Do not delete source snapshots or token records as a
rollback shortcut: the accepted rolling-site semantics cannot safely be undone
after users publish newer content. Use forward repair for interrupted operations.
