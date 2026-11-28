# 001: R2 Artifact Share Policy → PostgreSQL `artifacts.visibility` Backfill

## Purpose

Before Release 2 makes PostgreSQL `artifacts.visibility` the sole visibility authority for file-backed artifacts (replacing legacy R2 `artifact-shares/<segment>/<shareId>.json` writes), any historical file whose active `public` or `organization` share policy existed only in R2 (created prior to Release 1 dual-write) must be mirrored into `artifacts.visibility`.

- **File policies (`target.kind === "file"`)**: upgrades matching active (`deleted_at IS NULL`) `artifacts.visibility` monotonically (`private < organization < public`). Never downgrades an already broader visibility.
- **Legacy HTML snapshot policies (`target.kind === "html"`)**: intentionally **skipped**. `hosted_site_visibility` was already backfilled into `artifacts.visibility` in migration `1655`, and historical `private_hosted_deployments` (`legacy-html-deployment`) snapshots must never overwrite a modern live hosted site's visibility.
- **Idempotency**: conditional `UPDATE ... WHERE visibility = $previous` makes repeated runs a zero-write no-op.

## Required Environment Variables

- `DATABASE_URL`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_HOSTED_SITES_BUCKET_NAME` (or `--bucket <name>`)

## Runbook

### 1. Dry-run (default, read-only)

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/001-r2-artifact-visibility-backfill/backfill.ts
```

Inspect `plannedUpdates`, `htmlSnapshotPoliciesSkipped`, and `unmatchedFilePolicies`.

### 2. Apply backfill

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/001-r2-artifact-visibility-backfill/backfill.ts --migrate
```

### 3. Post-run verification (must report `plannedUpdates: 0`)

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/001-r2-artifact-visibility-backfill/backfill.ts
```
