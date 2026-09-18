# 017: Pi stable-context report and repair

Migration 1168 creates empty additive stable-context tables after retained main
migrations through `1167_private_artifact_absolute_urls`. It intentionally
does not enumerate user x Agent x session combinations or materialize a
production-wide cache. Normal authoritative source writes invalidate existing
heads, and an exact request miss records bounded demand from captured immutable
inputs. The migration also creates an empty legacy-erasure fence containing
only one-way subject digests; rows are written by future Clerk deletion events,
not by this command or a historical backfill.

This command reports existing heads in UUID cursor order. The default is
read-only. With separately authorized `--migrate`, it only requeues a failed
head or an expired running lease that still has immutable input and fewer than
five attempts. It does not create owner/variant combinations, synthesize
credentials, read archives, compose prompts, change feature switches, deploy,
or activate Pi.

Run from `turbo/packages/db` only after migration 1168 is present:

```bash
# Bounded dry-run/report (default).
pnpm exec tsx scripts/migrations/017-pi-stable-context/repair.ts

# Separately authorized repair.
pnpm exec tsx scripts/migrations/017-pi-stable-context/repair.ts \
  --migrate --max-heads 1000

# Resume after the last completed opaque head cursor.
pnpm exec tsx scripts/migrations/017-pi-stable-context/repair.ts \
  --migrate --max-heads 1000 --after-head '<head-uuid>'
```

`DATABASE_URL` is the only required environment value. A pass processes at
most 5,000 heads in pages of 100 with a ten-second statement timeout and
one-second lock timeout. Output contains counts and opaque resume coordinates,
not projection bodies, prompts, resource paths, users, or Agent identifiers.
Re-run a fresh dry-run after an authorized repair. `missing` waits for a real
request to provide canonical immutable input; `pending` waits for the bounded
worker; `unindexable` requires its source/index condition to change; and an
attempt count of five requires diagnosis instead of automatic retry.

Production cardinality must be established from the dry-run before proposing
any wider operation. This implementation owner does not execute this command
against production.
