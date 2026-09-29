# Initialize memory for existing organization members

This permanent, rerunnable backfill prepares the prerequisite for the S2/S3
read-only storage path in PR #37360. It enumerates one page of **authoritative
Clerk organization memberships**, including members absent from local caches.
It never creates or changes Clerk objects and makes no R2 requests.

Deploy the API that initializes memory synchronously during onboarding completion
and `organizationMembership.created` before running this backfill. Keep the old
runtime initializer until all existing memberships have been verified. The
fail-fast runtime must not ship merely because this PR merged or one page passed.
No production backfill is performed by this change.

From `turbo/packages/db`, supply `DATABASE_URL` and `CLERK_SECRET_KEY` through the
existing operator secret-injection mechanism:

```sh
# Default: read-only preview of one explicitly selected organization/page.
pnpm exec tsx scripts/migrations/019-member-memory-initialization/backfill.ts \
  --org-id "$SELECTED_ORG_ID" --offset 0 --limit 100

# Apply that scope, then repeat its dry run to verify missing=0.
pnpm exec tsx scripts/migrations/019-member-memory-initialization/backfill.ts \
  --org-id "$SELECTED_ORG_ID" --offset 0 --limit 100 --apply
```

`--limit` is bounded to 1–100 members. Follow every reported `nextOffset` until
it is null, for **every organization in a fresh Clerk organization inventory**.
There is no implicit all-organizations operation. Record the inventory, command
scope and aggregate results privately; do not put credentials in arguments or
reports. A local membership cache is not a complete inventory.

Each member commits independently. On failure, the process exits and the current
member transaction rolls back; earlier completed members remain initialized.
Rerun the same page safely. There are no internal retries or sleeps. Concurrent
membership changes can shift offset pagination, so perform a fresh full dry-run
sweep from offset 0 after apply and reconcile the Clerk inventory again before
activating the runtime change. A null cursor only completes that snapshot's
organization page traversal, not a global coverage proof.

Writes only fill a missing `memory` root or an existing root whose HEAD is null.
The canonical key is `(org_id, user_id, name='memory')`; concurrent deliveries
serialize on that root. Existing non-null HEADs, contents, storage prefixes and
captured run versions remain untouched. A corrupt existing HEAD is reported,
not replaced. New empty versions use the existing content hash and retain the
zero-size/zero-file format: no archive or manifest object is needed. Their
extractor-v1 empty file index and pending memory-summary job are inserted in the
same transaction as HEAD. The summary worker handles an empty version without
R2 I/O. Summary content is never synthesized during account initialization.

The backfill's empty format and SQL are deliberately self-contained historical
code. Keep this directory after completion. Existing nonempty versions' missing
indexes/summaries remain owned by their established background backfills.
