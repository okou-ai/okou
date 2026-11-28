# 002: `files` Parity Reconciliation & Unclaimed Email Invitation Cleanup

## Purpose

Pre-cutover audit and cleanup tool for Release 2:

1. **Unclaimed email invitation cleanup (`user_id IS NULL`)**: Under the end-state charter, `artifact_user_shares` requires a resolved `user_id` (no unclaimed email invitations). Audits and (with `--migrate`) deletes `user_id IS NULL` rows from legacy `hosted_site_shares` and `artifact_file_shares` in bounded batches.
2. **`files` parity & FK readiness audit** (read-only):
   - Verifies 0 real binary rows in `run_uploaded_files` are missing from `files`.
   - Verifies 0 empty `org_id` rows and 0 hosted-site placeholder pseudo-rows exist in `files`.
   - Reports pre-`1656` counts of shadow/orphan `image_artifacts` and historical `kind = 'video'` / `display_kind = 'video'` rows (must both drop to `0` after migrations `1656`/`1657`).
   - Verifies 0 claimed shares (`user_id IS NOT NULL`) in `artifact_file_shares` / `hosted_site_shares` are missing from `artifact_user_shares`.

## Runbook

### 1. Dry-run audit (default, read-only)

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/002-r2-files-reconciliation-and-invite-cleanup/reconcile.ts
```

### 2. Clean unclaimed email invitations (`user_id IS NULL`)

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/002-r2-files-reconciliation-and-invite-cleanup/reconcile.ts --migrate --strict
```

### 3. Post-migration verification (after `1656` + `1657`)

```bash
pnpm -F @okouai/db exec tsx scripts/migrations/002-r2-files-reconciliation-and-invite-cleanup/reconcile.ts --strict
```

Confirm `orphanImageArtifactsShadowCount === 0`, `orphanImageArtifactsOtherCount === 0`, `legacyVideoArtifactsCount === 0`, and `hasStrictFailures === false`.
