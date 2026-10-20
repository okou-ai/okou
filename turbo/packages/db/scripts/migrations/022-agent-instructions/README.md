# Agent instruction backfill (release 1 of #41367)

Retire this operator after migration acceptance. It reads the current HEAD for
each live Agent, verifies bounded R2 manifest/archive bytes, and preserves raw
UTF-8 including whitespace, BOMs and legacy profile blocks. No history or orphan
Storage is copied. NULL is not empty content.

Prerequisites: the additive schema and all bridge writers are serving, outgoing
pre-bridge API requests have drained, and incompatible rollback writers are
excluded. Do not run against production as part of preparing or testing the PR.

From `turbo/packages/db`, provide `DATABASE_URL`, `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_USER_STORAGES_BUCKET_NAME`.
Optional `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` support local S3.
Use credentials limited to source reads and the intended database operation.

```sh
pnpm exec tsx scripts/migrations/022-agent-instructions/backfill.ts --help
pnpm exec tsx scripts/migrations/022-agent-instructions/backfill.ts --limit 100
# Only after dry-run review and verified writer drain:
pnpm exec tsx scripts/migrations/022-agent-instructions/backfill.ts --limit 100 --migrate --ack-writer-drain
```

Each invocation is bounded by `--limit` (maximum 10000 Agents), `--max-ms`
(default 60000, maximum 300000), finite object/decompression limits, and a 10s
database statement timeout. Paginate using the reported `nextAfter` as `--after`;
`--org-id` optionally narrows scope. A timed-out invocation must be reconciled
again, not assumed complete. No checkpoint or retry state is persisted.

Missing, malformed, divergent, nonregular, non-UTF-8 or PostgreSQL-unrepresentable
content produces `source_exception`, never empty instructions. Single-file
archives also require review: use `--allow-single-file` only after confirming
the existing framework alternate-file behavior for those sources. The operator
never follows archive links or extracts files to disk. Manifest hashes and
sizes must match the actual files.

The backfill compares the observed Agent tuple's ephemeral `xmin` plus source
identity/HEAD in a conditional UPDATE. All publication writers must update that
Agent row atomically with HEAD first. Pre-bridge and generic writers that can
change instruction HEAD without touching the Agent invalidate this prerequisite.
Recheck skipped/deleted/edited Agents; never force an overwrite. `updated_at`
is preserved because this operation does not change user-authored content.

JSONL reports contain identities, hashes and outcomes, never bodies. Exit 2
means pending differences, exceptions, concurrent skips or more pages; exit 0
alone covers only the reported page, not the entire database. After mutation,
repeat a complete dry-run scan from the beginning, account for every live Agent
(including concurrent creations), confirm NULL=0 and no unresolved exceptions,
and attach reports to #41367. The bridge keeps later edits in sync. Freeze the
accepted writer/rollback floor before release 2; do not reuse this operator after
Storage ceases to be authoritative.
