# Retire instruction Storage (#41367)

Run only after the final instruction release is serving, outgoing API requests
have drained, legacy queued/executing/finalizing consumers are retired, and
supported API/Runner rollback artifacts use database instructions. The owning
issue records acceptance, including any explicitly accepted verification gaps.
PR merge alone does not authorize this production operation.

Provide `DATABASE_URL` and the production `R2_USER_STORAGES_BUCKET_NAME`.
The default mode is read-only and prints a bounded review manifest containing
exact org-owned instruction Storage identities, observed row versions, captured
prefixes, version IDs and instruction-only publication-token identities. It never
reads instruction bodies. No R2 token is required by this operator.

```sh
pnpm exec tsx scripts/migrations/023-retire-instruction-storage/cleanup.ts --limit 100 > /tmp/instruction-cleanup.json
# Review the exact identities/prefixes, then explicitly apply that same batch:
pnpm exec tsx scripts/migrations/023-retire-instruction-storage/cleanup.ts --manifest /tmp/instruction-cleanup.json --migrate --ack-consumer-retirement
```

Writes require the reviewed manifest and explicit retirement acknowledgement.
Each conditional deletion rechecks the observed Storage identity, row version,
HEAD, exact version inventory, prefix ownership and queued/active/finalizing Run references. A changed
or referenced candidate is skipped and returns exit 2; re-observe and review it,
never force deletion. Missing source archives do not change Agent instructions.

Deleting the Storage row and enqueueing the existing `storage-object-cleanup`
job is one atomic SQL statement. Version rows cascade with their owning Storage.
The existing worker checks live prefix references again, deletes at most one
bounded object page per attempt, and owns retries after failures or lost replies.
No R2 deletion happens in the operator or a schema migration. Publication-token
cleanup targets only the exact reviewed `@agent`/`agent-instructions` keys;
shared generation rows and Workflow tokens remain.

At most 100 Storage rows and 100 tokens are processed per invocation, with a
60-second default wall-clock budget (`--max-ms`, maximum 300000) and 10-second
statement limit. Use `--after` with the dry-run `nextAfter` for inventory paging.
For applied batches, restart inventory without a cursor so changed/skipped rows
are not lost. Repeat until both inventories are empty, then verify all emitted
cleanup job IDs completed. After a lost reply, reconcile jobs by the captured
prefixes in the reviewed manifest; an empty Storage inventory alone does not
prove R2 deletion. Run a final read-only inventory and verify normal
Agent read/edit/claim and empty overwrite. Retain only identifier/count receipts.

Unrelated Storage, skills, Memory, Agents, Runs and historical migrations remain.
After cleanup acceptance, retire this operator and its dedicated tests; recover
the exact reviewed revision from Git if a later audit needs it.

Run `pnpm test:instruction-storage-retirement` against a local PostgreSQL cluster
for the native CLI acceptance suite. The existing required
`test:migration-consistency` command includes this suite; no Workflow change is
needed. The manifest covers registered instruction Storage; unregistered orphan
objects require independent ownership evidence.
