# Custom Connector Skill bundle preparation

This one-time operator prepares references for explicitly selected existing
custom Connectors. It copies each pinned legacy `archive.tar.gz` byte for byte
into `bundles/v1/<sha256>.tar.gz`. It does not regenerate Skill instructions,
change their legacy versions, edit HTTP/OAuth/MCP definitions, activate Run
delivery, or delete any legacy or shared object.

Use an approved operator environment with `DATABASE_URL_FILE` (or
`DATABASE_URL`), `R2_USER_STORAGES_BUCKET_NAME`, `R2_ENDPOINT` (or `R2_ACCOUNT_ID`),
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Never retrieve production
credentials into an agent workspace. Rehearse with a disposable database and an
isolated object-store fixture before an approved production execution.

From `turbo/packages/db`, generate a read-only plan for explicit UUIDs:

```sh
node --import tsx scripts/migrations/029-connector-skill-bundles/backfill.ts \
  --connector-id <uuid> --connector-id <another-uuid> --output plan.json
sha256sum plan.json
```

The plan records only identities, source metadata and bundle descriptors, not
Skill bodies or credentials. A complete plan validates tenant/storage identity,
the legacy file-content hash, bounded safe archive extraction, and existing
target bytes. Existing current references are verified and preserved even when
their archive encoding differs from the legacy archive.

After reviewing that exact plan, confirming outgoing writers have drained, and
obtaining approval for its target environment:

```sh
node --import tsx scripts/migrations/029-connector-skill-bundles/backfill.ts \
  --migrate --writers-drained --plan plan.json \
  --approve-plan-sha256 <reviewed-file-sha256> --output receipt.jsonl
```

Application is bounded to the reviewed UUIDs and scope. Immutable publication
uses conditional creation and full readback before one atomic owner update.
The update checks the observed owner/source identities and changes only the two
bundle metadata columns. A matching rerun performs no metadata update or PUT.
Conflicts fail instead of overwriting a newer owner or object; review a fresh
plan after resolving them. An uncertain upload is resolved by readback, not a
second PUT. Shared immutable bytes are retained if later publication loses a
race. No transaction, automatic schedule or schema change is introduced.

## Controlled production entry point

The manual `Backfill Production Connector Skill Bundles` GitHub workflow runs
only on `main`, behind the existing `production` environment. Its production
wrapper fixes the three approved connector/org/storage/source-version bindings
in `production-plan.ts`; it cannot accept an arbitrary connector inventory.
Neon and R2 credentials remain inside the protected runner, and the temporary
connection file is removed and its absence checked even after failure.

Dispatch `mode=plan` first. Inspect its metadata-only `connector-skill-plan-<run>`
artifact, successful read-only verification and summary SHA-256. Separately
dispatch `mode=apply` with that run ID and exact hash. Both dispatches must use
the same `main` commit and serving API revision. If either advances, generate
a fresh plan. A failed/replayed plan run is rejected. Apply does not generate
its own approval or start automatically after plan generation.

The wrapper independently verifies the protected production Neon branch,
unique writer endpoint, fixed R2 account/bucket, and canonical API deployment.
The serving API must descend from bundle-preparation deployment, and its alias
cutover must be older than the previous deployment's verified 300-second request
limit. Apply retains per-owner receipts, verifies that every other owner field
is unchanged, then runs the successful operation once more and verifies stable
owner `xmin`. The operator performs full object readback on both executions.

Do not rerun a failed or interrupted apply workflow: inspect its partial
receipts and current references, then generate and review a fresh plan. Only a
successful first apply permits the wrapper's explicit idempotence check.
Receipts contain identifiers and hashes, never Skill bodies or credentials.

After acceptance and retirement, remove this operator, its production workflow
and wrapper, its dedicated tests,
the three corresponding Storage dependency baseline entries and its one-time
checker registration together. The registration is limited to these
exact files and counts; it does not admit runtime consumers or permit later
dependency growth or reintroduction after retirement.
