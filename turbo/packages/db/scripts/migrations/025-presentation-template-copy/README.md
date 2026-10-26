# Copy legacy presentation templates

Copy the current `presentation_templates` records into `user_templates`, keeping
the legacy records and packages intact. The custom catalog can use the copied
templates, while retained presentation references still resolve the original
records and packages. Retiring the legacy table is a separate change.

This is an external-data operator because the new catalog resolves a different
package name. It copies the current package archive to a new Storage/prefix,
computes its version with the canonical storage-content hash, and writes the new
manifest. It verifies both uploaded objects before atomically inserting Storage,
version and template records. It never renames or updates the original package.
Source uploads and page images are independently owned objects; their keys are
preserved, along with the template UUID, organization, owner and audit fields.
Legacy `public` maps to `organization`.

## Run

The manual **Copy Production Presentation Templates** GitHub workflow runs this
operator from `main` inside the protected `production` environment. It defaults
to `dry-run`; `copy` inspects before writing, verifies every destination package,
and compares legacy row/Storage/HEAD fingerprints afterward. It stops if the
inventory exceeds 100 records. It retains identifier-only receipts and refuses
an apply job rerun; reconcile any uncertain result before dispatching again.

Run from `turbo/packages/db` with locked workspace dependencies. Set
`DATABASE_URL_FILE` to a private file containing the database URL. Supply
`R2_ENDPOINT`, `R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` securely through the environment.

```bash
node --import tsx scripts/migrations/025-presentation-template-copy/copy.ts
node --import tsx scripts/migrations/025-presentation-template-copy/copy.ts --migrate
```

The default is read-only, including object-store reads. Review `attention` before
applying. Each invocation processes at most 100 templates; use `--after <uuid>`
with the returned `lastTemplateId` to continue, or `--template-id <uuid>` to
inspect/copy one. On an apply error, stop using the cursor and inspect the reported
template; later rows in that page have not been attempted. No writer drain or
feature-flag prerequisite is needed for this non-destructive snapshot copy.

Reruns recognize copies by their retained initial Storage version marker,
verify their current packages, and leave subsequent new-catalog edits unchanged.
Unrelated target identities or incomplete packages fail instead of being
overwritten. A source changed during upload is skipped without publishing any
database rows. Each successful template is committed independently. An uncertain
write stops the batch, retains uploaded objects, and requires an authoritative
database/object-store read before another apply; there is no automatic retry or
cleanup. Receipts contain identifiers and counts, not template content or secrets.

This copies a snapshot, not ongoing updates between catalogs. Before retiring
the legacy table, account for imports/edits that happened after the copy. After
apply, run the read-only command over every page: require zero `attention` and
zero new `ready` candidates, and verify a copied private and organization-visible
template through the respective catalog/generation paths. Existing copies can
have intentionally diverged after user edits; parity is not silently restored.
Archives above 128 MiB or manifests above 8 MiB are reported for investigation.

## Verification

`DATABASE_URL=postgresql://... pnpm test:presentation-template-copy` runs the real
CLI against disposable local PostgreSQL and an in-memory HTTP S3 fixture. It is
also part of `test:migration-consistency`. It covers unchanged legacy data and
objects, new package identity and bytes, permissions/audit/page preservation,
independent edits and replay, missing/mismatched packages, target collisions,
source changes during upload, and failed object publication. Ordinary PR CI and
the normal schema-migration runner never perform production copies. Retire this
operator and its manual workflow after the production copy is accepted.
