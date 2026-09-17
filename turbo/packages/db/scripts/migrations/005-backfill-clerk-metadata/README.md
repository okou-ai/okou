# 005: Backfill Clerk Metadata to Local DB

> Historical migration: this script preserves its original schema/write
> contract and Clerk field mappings. For current metadata repairs and the
> explicit entitlement write required by #33747, follow
> [Database trigger retirement](../../../../../../docs/database-trigger-retirement.md#repair-and-backfill-writes).

## Clerk Metadata Migration Overview

Issue #5508 migrates org/membership/user metadata from Clerk to local DB tables.
Lazy migration (#5591) handles active users, but inactive orgs/users never
trigger a read. This script ensures complete data coverage.

| Phase              | Status          | Description                                     |
| ------------------ | --------------- | ----------------------------------------------- |
| Schema + Tables    | Deployed        | `org_metadata`, `org_members_metadata`, `users` |
| Lazy Migration     | Deployed        | Fallback reads from Clerk on cache miss (#5591) |
| **Batch Backfill** | **This script** | Backfill ALL data from Clerk API                |
| Remove Fallbacks   | Pending         | Remove lazy migration code (#5514)              |

## What This Script Does

Reads ALL organizations, memberships, and users from Clerk API and writes
their metadata to the corresponding DB tables:

1. **org_metadata** — `tier` and `default_agent_compose_id` from org publicMetadata
2. **org_members_metadata** — preferences from membership publicMetadata
3. **users** — `email_unsubscribed` from user publicMetadata

### Conservative Strategy

- `org_metadata`: only updates `tier` if DB has default "free", only updates
  `default_agent_compose_id` if DB has NULL
- `org_members_metadata`: `ON CONFLICT DO NOTHING` — never overwrites existing rows
- `users`: only writes `email_unsubscribed = true` (never writes false)

## Prerequisites

- Node.js 18+
- `pnpm install` completed in the `turbo` directory
- Database migrations applied (`pnpm -F @okouai/db db:migrate`)

## Environment Variables

| Variable           | Required | Description                  |
| ------------------ | -------- | ---------------------------- |
| `DATABASE_URL`     | Yes      | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Yes      | Clerk API secret key         |

## Usage

Run from the `turbo/packages/db` directory:

```bash
# Dry run (default) — preview what would be backfilled
pnpm exec tsx scripts/migrations/005-backfill-clerk-metadata/backfill.ts

# Actual migration
pnpm exec tsx scripts/migrations/005-backfill-clerk-metadata/backfill.ts --migrate
```

## Options

| Flag        | Description                           |
| ----------- | ------------------------------------- |
| `--migrate` | Actually execute (default is dry-run) |

## Idempotency

Safe to re-run. The script uses conservative upsert strategies that never
overwrite user-modified data. Running twice produces the same result.

## Error Handling

- **Per-item failure**: logs and skips; does not block other items
- **Error threshold**: aborts if more than 50 items fail (likely systematic issue)
- **Rate limiting**: ~100ms delay between Clerk API pages (~10 req/s)

## Verification

After running, check lazy migration logs — they should drop to zero:

```bash
# Search for lazy migration log entries (should be empty after backfill)
grep "lazy migration" <app-logs>
```
