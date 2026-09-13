# Pi resource version index backfill (extractor 1)

Issue: https://github.com/vm0-ai/vm0/issues/33619

Run after the additive `pi_resource_version_indexes` schema, producers, and
`/api/cron/materialize-pi-resource-indexes` worker are deployed. This permanent
script enqueues exact existing Storage versions; the worker performs archive
downloads and extraction outside publication transactions. It does not modify
Storage HEAD, resource contents, captured run mounts, or memory epochs.

From `turbo/packages/db`, with an operator-supplied `DATABASE_URL`:

```sh
pnpm exec tsx scripts/migrations/015-pi-resource-version-indexes/backfill.ts
pnpm exec tsx scripts/migrations/015-pi-resource-version-indexes/backfill.ts --migrate
pnpm exec tsx scripts/migrations/015-pi-resource-version-indexes/backfill.ts --all-retained --limit 500
```

The default is a read-only preview of up to 500 missing current-HEAD indexes.
Use the reported `nextAfterVersionId` as `--after-version-id` for the next batch.
Use `--all-retained` after current heads to cover older versions referenced by
retained run/checkpoint contexts. Repeat `--version-id <id>` to include specific
pinned historical versions alongside current heads. Inspect each dry run before
using `--migrate`; keep batches between 1 and 2000. Concurrent enqueue/worker
activity is safe: the composite primary key deduplicates work.

The report distinguishes enqueued work from ready indexes. Observe pending age,
worker retry counts, and production resource-phase cache misses before expanding
the backfill. Re-running without a cursor is safe and finds missing rows skipped
by concurrent changes. Current-HEAD coverage alone is not proof that all pinned
historical contexts are covered. `unindexable` means the bounded index cannot
represent that archive; launch preserves authoritative archive discovery and its
errors for that version.

Do not execute this script against production as part of development setup.
Retain this directory after the migration; future extractor generations need
their own explicitly versioned backfill.
