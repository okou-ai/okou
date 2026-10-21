# Retire instruction Storage (#41367)

Run only after the final instruction release is serving, outgoing API requests
have drained, legacy queued/executing/finalizing consumers are retired, and
supported API/Runner rollback artifacts use database instructions. The owning
issue records acceptance, including any explicitly accepted verification gaps.
PR merge alone does not authorize this production operation.

Provide `DATABASE_URL` and the production `R2_USER_STORAGES_BUCKET_NAME`.
The default mode is read-only and prints a bounded review manifest containing
exact org-owned instruction Storage identities, observed row versions, captured
prefixes, exact version ID/directory pairs and instruction-only publication-token
identities. It never reads instruction bodies. No R2 token is required by this
operator. Manifest format 2 captures each version's actual `s3_key`; regenerate
older manifests before reviewing or applying a batch.

```sh
pnpm exec tsx scripts/migrations/023-retire-instruction-storage/cleanup.ts --limit 100 > /tmp/instruction-cleanup.json
# Review the identities, stored prefixes and version directories, then apply that same batch:
pnpm exec tsx scripts/migrations/023-retire-instruction-storage/cleanup.ts --manifest /tmp/instruction-cleanup.json --migrate --ack-consumer-retirement
```

Writes require the reviewed manifest and explicit retirement acknowledgement.
Each conditional deletion rechecks the observed Storage identity, row version,
HEAD, exact version ID/directory inventory, ownership of every cleanup target and
queued/active/finalizing Run references. Version directories must end in their
captured version ID. Other Storage prefixes, version directories and export
references protect every target, including historical directories outside the
stored prefix. A changed or referenced candidate is skipped and returns exit 2;
re-observe and review it, never force deletion. Missing source archives do not
change Agent instructions.

Cleanup targets the captured Storage prefix plus each exact version directory
outside that prefix. Versions already below the prefix need no separate job;
historical parent directories are never inferred or widened into cleanup targets.
Deleting the Storage row and enqueueing all `storage-object-cleanup` jobs is one
atomic SQL statement. Version rows cascade with their owning Storage. If any job
cannot be registered, the deletion and all job inserts roll back together. Each
`cleanup_queued` receipt lists the job IDs and corresponding target prefixes.
The existing worker checks live Storage-prefix and export references again,
deletes at most one bounded object page per attempt, and owns retries after
failures or lost replies.
No R2 deletion happens in the operator or a schema migration. Publication-token
cleanup targets only the exact reviewed `@agent`/`agent-instructions` keys;
shared generation rows and Workflow tokens remain.

At most 100 Storage rows and 100 tokens are processed per invocation, with a
60-second default wall-clock budget (`--max-ms`, maximum 300000) and 10-second
statement limit. Use `--after` with the dry-run `nextAfter` for inventory paging.
For applied batches, restart inventory without a cursor so changed/skipped rows
are not lost. Repeat until both inventories are empty, then verify all emitted
cleanup job IDs completed. After a lost reply, reconcile jobs by the captured
Storage prefix and exact outside version directories in the reviewed manifest;
an empty Storage inventory alone does not prove R2 deletion. Run a final read-only
inventory and verify normal Agent read/edit/claim and empty overwrite. Retain only
identifier/count receipts.

Unrelated Storage, skills, Memory, Agents, Runs and historical migrations remain.
After cleanup acceptance, retire this operator and its dedicated tests; recover
the exact reviewed revision from Git if a later audit needs it.

Run `pnpm test:instruction-storage-retirement` against a local PostgreSQL cluster
for the native CLI acceptance suite. Run it explicitly when changing this
operator; it is not part of `test:migration-consistency`. The manifest covers
registered instruction Storage; unregistered orphan objects require independent
ownership evidence.
