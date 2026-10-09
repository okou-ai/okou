# 020: Canonical selected-model snapshot history

Release-three maintenance for #38114. This is external object-store work, not
part of the SQL migration transaction. No production execution is authorized by
adding this tool. It remains usable for one explicitly owned head at a time.

## Prerequisites

- Confirmed serving/rollback, installed-consumer and retained-history gates
  recorded in the owning PR #38389; confirmation does not execute this tool.
- Read access to the exact database and object bucket for dry-run. `--migrate`
  additionally requires database UPDATE and object PUT permission.
- `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_USER_STORAGES_BUCKET_NAME`. Never put credentials in arguments or reports.
- A supported thread projection gzip JSON head or a V8 event gzip NDJSON head.
  Unsupported revisions, ownership mismatches, absent object keys, invalid
  contents and cursor/hash mismatches fail rather than guessing.

From `turbo/packages/db`:

```bash
# One exact owner-scoped thread-list snapshot, read-only by default.
pnpm exec tsx scripts/migrations/020-canonical-model-selections/backfill.ts \
  --user-id <owner> --org-id <org>

# One V8 event head, with owner and organization verified through the thread.
pnpm exec tsx scripts/migrations/020-canonical-model-selections/backfill.ts \
  --user-id <owner> --org-id <org> --thread-id <thread>

# Only after reviewing that scope and obtaining execution authorization,
# repeat the corresponding command with --migrate.
```

JSON output contains only `heads`, `changedRows`, `published`, and `conflicts`.
A missing owned head reports zero heads; it is not a completed migration. A
pointer conflict returns exit code 2. A failed operation returns a failure exit.
Use the relational aggregate audit alongside a separately authorized inventory
of heads, export references and native-history references. A single successful
scope is not complete archive coverage.

## Determinism and recovery

Thread selected null/Auto replacement aliases become `auto`; explicit personal
selections and non-Auto effort keys remain. Event snapshots change only the
`okou-1.0` user-message model annotation and remove its unsupported service tier.
They preserve non-model payloads, framing, sequence order and physical/terminal
watermarks. No uncaptured input decision is fabricated.

The compressed object's SHA-256 must match its source key before transformation.
Uploads use `If-None-Match: *`. An existing destination must contain identical
bytes. Source and destination ownership prefixes are checked, and the exact
previous pointer/cursors are compared after upload; thread timestamps retain
microsecond precision. User/org authority is rechecked for event publication.
No external I/O occurs in a database transaction.

A failed PUT leaves the old pointer. A crash after PUT or rejected/stale pointer
publication leaves an immutable orphan; rerun against the current head to
reconcile. A same-content destination can be reused, and an already canonical
head is a no-op. No source object is deleted, no export pointer is moved, and
no bucket-wide scan runs. Existing reference-aware garbage collection owns
orphan cleanup.

This tool does not mutate Runs, queued execution contexts, native history
bodies, content-addressed native blob hashes or account/key bindings. Retained
export references continue to read their original immutable snapshots; they
must be accounted for before retiring legacy readers. Agentless/deleted event
ownership cannot be inferred by the tool and requires separate investigation.
Neither database reference existence nor a successful synthetic restore proves
that a retained native session resumes correctly.

## Local verification

```bash
DATABASE_URL=<disposable-local-database> pnpm test:canonical-model-snapshots
DATABASE_URL=<disposable-local-database> pnpm test:canonical-selected-model-history
```

The snapshot test invokes the real CLI against real PostgreSQL and an external
S3 HTTP fixture. It covers dry-run, deterministic hashed publication, idempotence,
upload failure, stale-pointer conflict, partial-failure reconciliation, destination
reuse, ownership/integrity rejection and V8 replay. It is not a production R2
read or real native-session restoration test.
