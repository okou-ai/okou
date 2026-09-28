# 019: Retired Pi API-first handoff object cleanup

Release 7 removes the API-first handoff writer, reader, completion cleanup and
cron sweep. Earlier APIs wrote manifests and session copies under
`pi-api-first-turn/<runId>/` in `R2_USER_STORAGES_BUCKET_NAME`. This one-time
operation deletes that retired prefix, following the repository's standalone
object-storage migration pattern in migration 007. It does not read object
contents or touch the canonical session-history blobs outside that prefix.

## Execution ownership and prerequisites

**Operations runs this manually after Release 7 is deployed.** SQL migrations,
API deployment and cron do not invoke it, and adding this script does not change
bucket lifecycle settings. Run it separately for each environment being retired.

Before deletion, confirm that all old API writers have drained and no pre-release-6
Runner/CLI handoff readers remain. Keep the Release 7 API rollback floor in
place. The deletion is irreversible; rolling back the script does not restore
the objects. Release 7 and its supported release 6 Runner/Guest predecessor do
not read them. The script does not attempt to discover deployment state or infer
that a deployment finished from an object's age.

## Configuration

Use the same R2 credentials and bucket as the retired API writer:

| Variable                                   | Requirement                                       |
| ------------------------------------------ | ------------------------------------------------- |
| `R2_USER_STORAGES_BUCKET_NAME`             | Required; the environment's user-storage bucket   |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Required; list and delete access to this bucket   |
| `R2_ACCOUNT_ID`                            | Required unless `S3_ENDPOINT` is set              |
| `S3_ENDPOINT`                              | Optional existing S3-compatible endpoint override |
| `S3_REGION`                                | Optional; defaults to `auto`                      |
| `S3_FORCE_PATH_STYLE`                      | Optional; `true` enables path-style requests      |

No database connection is required. The prefix is fixed in source and cannot be
overridden by an argument or environment variable.

## Run and verify

From `turbo/packages/db`, first review a complete read-only inventory count:

```bash
pnpm exec tsx scripts/migrations/019-pi-api-first-turn-cleanup/cleanup.ts
```

After confirming the environment and deployment prerequisites, execute:

```bash
pnpm exec tsx scripts/migrations/019-pi-api-first-turn-cleanup/cleanup.ts --execute
```

The script lists at most 1,000 objects per page and deletes one page at a time.
It follows all continuation pages, stops on request errors or per-object delete
errors, and makes no automatic retries. A successful execution independently
lists the fixed prefix again and reports `verifiedEmpty: true`. Output contains
the mode, bucket, prefix and counts, never object contents or individual keys.

Keep the successful aggregate report as the cleanup record. A fresh dry run must
report `objects: 0`. A failed pass may have deleted earlier batches; diagnose the
failure before manually executing another pass, which enumerates only remaining
objects. No run loop or deployment hook repeats the operation automatically.

CI coverage exercises the real command argument parser and S3 HTTP boundary for
read-only inventory, multi-page deletion with unrelated-object preservation,
partial delete errors and an invalid out-of-prefix listing. The implementation
change itself does not execute this operation against any remote bucket.
