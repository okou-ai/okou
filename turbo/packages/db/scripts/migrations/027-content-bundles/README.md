# Prepare current content bundle references

This operator prepares Agent instructions and ordinary Workflow references for #44164.
It never activates the claim producer or deletes shared R2 objects. Run only against
an isolated branch for rehearsal; production apply is a separately authorized operation.

Prerequisites: preparation schema and compatible writers are serving; outgoing writers
have drained; incompatible rollback writers are excluded; all source attachments are
converted. R2 credentials must read source attachments and write `bundles/v1/`.
Use `DATABASE_URL_FILE` for a private connection file (or the development
`DATABASE_URL`); configure `R2_ACCOUNT_ID`, or an explicit native R2
`R2_ENDPOINT`. Loopback HTTP endpoints support isolated provider rehearsals.
The new bundle prefix must have no expiration rule or legacy cleanup owner.

From `turbo/packages/db`, with the target `DATABASE_URL` and R2 environment configured:

```bash
node --import tsx scripts/migrations/027-content-bundles/backfill.ts --kind agent --limit 50 --output /private/agents-plan.json
sha256sum /private/agents-plan.json
node --import tsx scripts/migrations/027-content-bundles/backfill.ts --kind agent --limit 50 --migrate --writers-drained --plan-file /private/agents-plan.json --expect-plan-sha256 <reviewed-sha256> --output /private/agents-apply.json
```

Repeat for `--kind workflow`. Continue bounded dry-run pages with `--after <nextAfter>`;
apply one reviewed page at a time with a limit at least its row count and no cursor.
Existing references are reconciled too; NULL never means empty. Source changes are
skipped rather than overwritten. Replan skipped/missing/deleted candidates and reconcile
all current owners after apply. Plans are bound to the database address, bucket, and R2 endpoint.
Receipts contain only target scope, identity, source tuple, hashes, and file/byte counts;
do not publish credentials, source text, binary files, or signed URLs.

Default dry-run downloads referenced attachments and builds/validates local archives,
but performs no database or R2 writes. Apply re-reads sources, verifies reviewed hashes,
uploads complete bytes, and conditionally publishes against the captured row identity.
A lost receipt may leave a published reference: re-read/replan rather than undoing it.
The output file is reserved privately before mutation; choose a fresh path for each invocation.
Shared immutable objects are retained even if publication loses. Do not run the old
per-Workflow cleanup against this shared prefix.

Native operator verification (disposable local PostgreSQL or the owned migration-consistency CI database):

```bash
DATABASE_URL=postgresql://user@127.0.0.1:55432/okou_bundle_test pnpm test:content-bundles
```

This creates and removes fixture owners and uses a local S3-compatible HTTP peer.
It covers dry-run, reviewed scope, exact text/binary bytes, concurrent source
changes, failed upload, and subsequent recovery. It is not a production receipt.
