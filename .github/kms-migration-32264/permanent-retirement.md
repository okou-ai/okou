# Permanent production KMS retirement

The requested end state is permanent deletion of the old **production** key:
`arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8`.
Its replacement is
`arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947`.
Keep the old key enabled while retained recovery paths still need it. This plan
does not retire staging, the old account, historical audit logs, CloudTrail, or
AWS Config.

## Accepted evidence and remaining dependencies

- [Full verification 34449151278](https://github.com/vm0-ai/vm0/actions/runs/34449151278)
  completed at `2026-09-10T07:38:23.484Z`: 77,331 verified fields with no source
  or nested source references. The backfill is complete; do not repeat it.
- [Target audit 34556455859, attempt 2](https://github.com/vm0-ai/vm0/actions/runs/34556455859/attempts/2)
  verified actual CloudTrail and Config delivery into the new S3 buckets.
- [Dependency inspection 34569228115](https://github.com/vm0-ai/vm0/actions/runs/34569228115)
  read 59 target headers and no source headers from 15 runner registries.
  Three missing registries are stable configuration-only `v0.190.0` directories,
  without a loaded service, service PID, or matching runner process. The automated
  inventory remains incomplete; its gate has not been weakened.
- The same inspection listed 14 daily Neon snapshots with 14-day retention and
  one manual snapshot without reported expiration. Snapshot timestamps/LSNs were
  absent. Creation dates alone do not prove which historical data is stored.
  The latest reported expiration was `2026-09-25T00:00:14Z`; actual disappearance
  must be checked later.
- The configured 24-hour PITR window clears the accepted verification timestamp
  at `2026-09-11T07:38:23.484Z`. This arithmetic does not verify the earliest
  actually restorable point or remove independent snapshot history.
- [Source audit 34567634207](https://github.com/vm0-ai/vm0/actions/runs/34567634207)
  verified the old IAM identity, then failed with `AccessDeniedException` on
  `cloudtrail:LookupEvents`. No event pages were collected. The temporary read
  grant remains required on `arn:aws:iam::072707626411:user/vm0-kms-prod`, scoped
  to `us-west-2`; this is not a zero-usage result.

## Isolated snapshot inspection

Run **KMS Recovery Snapshot Inspect** from `main` through the protected
`production` environment. Select the exact snapshot ID SHA-256 and creation
timestamp from a reviewed **KMS Production Exit Dependencies** artifact. The
defaults identify the manual snapshot created `2026-02-16T05:57:00Z`:
`02762df9fab6d6f04a398d5ff4e1afd10bf5fa0a6e270855fff4e7df2bbcbe37`.

The workflow pins the project and uniquely resolves production. It records the
production branch/endpoint identities and snapshot metadata, then restores one
snapshot to a new deterministic preview with `finalize_restore: false`.
It never calls the finalize endpoint. Existing inspection previews block a new
run, including after an uncertain request.

The new branch must have the exact snapshot provenance and must not be an
existing, default, or protected branch. Snapshot restore may return a primary
compute and read replicas. The workflow selects the unique `read_write` primary
and records endpoint type counts; multiple primaries and duplicate identities
are rejected. If no primary exists, one 0.25-CU preview primary is created with
60-second idle suspend. Connection discovery pins the branch, endpoint and type;
production endpoints and pooled connections are rejected. Database transactions
remain read-only regardless of the compute type.

The workflow reads every database returned for the preview in PostgreSQL
read-only, repeatable-read transactions. It scans physical user tables, partition
leaves, and materialized views for `vm0secret:` and the old key UUID. Only counts
and operational identifiers leave the database. Foreign tables, large objects,
and binary fields are reported as coverage limitations. Provider and SQL errors
never export their bodies.

Finally, it deletes only the newly created and revalidated preview, checks that
it is no longer live, and separately inspects its provider recovery window.
A deleted but recoverable copy still belongs in the retirement inventory.
Production branch/endpoint identities and the original snapshot set are read
back; cleanup or preservation uncertainty makes the run incomplete. Cancellation
or an uncertain provider response can leave a preview: inspect the deterministic
name before cleanup, and never blindly retry a restore.

This operation creates a temporary recovery copy and compute. It does not write
production data, modify existing snapshots, change credentials or deployments,
finalize a restore, or schedule key deletion. The default marker-only mode does
not call KMS. `collectionComplete` only means the declared scan completed.
The marker-only scan does not authenticate ciphertext,
inspect plaintext nested inside encryption, decode arbitrary opaque formats, or
prove application-level recovery. `retirementCleared` is always false.

For a retained target-era snapshot, enable `verify_target_ciphertext`. The same
preview isolation and cleanup checks run, followed by the existing migration
CLI's **read-only `--verify`** mode against each preview database. Its reviewed
storage manifest and queue payload decoder check the listed stored fields and
nested queue ciphertext. This mode does not run old-key canaries, `--migrate`, or production
verification.

The workflow assumes the existing GitHub migration role through OIDC with an
inline session policy: allow only target-key `kms:Decrypt` with the stored-secret
encryption context, explicitly deny KMS on every other key, and explicitly deny
all other actions except caller-identity lookup. This does not modify the role,
key grants, static credentials, or deployments. Source-key ciphertext cannot be
silently decrypted using the role's broader migration grants; encountering it
makes the verification fail. Such an attempted decrypt can still appear as a
denied inspection request in CloudTrail and must be attributed accordingly.

Success requires a complete, unresumed report bound to the preview connection,
nonzero ciphertext count, every row verified on target, zero source/nested source,
invalid/unknown/uninspected values, and zero database updates. Only aggregate
verification counters and manifest hashes are retained. If a verifier fails,
cleanup still runs and no cryptographic success is claimed. `kmsCallsMade: null`
means a started verification failed before its call count could be established.
Target mode has a 90-minute inspection budget and separately reserved cleanup
time; the default marker-only mode keeps its 20-minute inspection budget.

The provider contract is documented in
[Neon's snapshot restore API](https://neon.com/docs/reference/api/snapshots/restore-snapshot).
Run `bash .github/scripts/tests/kms-recovery-snapshot-inspect-test.sh` for the
external-boundary CLI scenarios and real isolated PostgreSQL aggregate tests.

## Resolve recovery paths before scheduling deletion

1. Inspect the non-expiring manual snapshot. If it contains KMS envelopes,
   verify its historical schema and ciphertext in isolation, re-encrypt source
   and nested source values under the target key, then create and restore a
   replacement backup and verify the target-only result. A separate reviewed
   operation must pin the isolated branch; do not bypass the existing production
   migration workflow's branch guards.
2. Preserve daily backups through their configured retention. Wait for the
   identified snapshots to actually expire, or preserve each required recovery
   point through the same verified replacement process for an earlier retirement.
   Do not delete historical recovery points merely to reduce the count.
3. Refresh snapshot, PITR, live branch, and recoverable-deleted-branch inventories.
   Perform target-only restore verification against a retained recovery point.
   Resolve any other concrete backup locations in the operational inventory.
   Metadata counts alone do not certify recovery.
4. Complete the source CloudTrail audit after its read permission is granted.
   Review the full paginated interval, visibility buffer and late arrival, and
   classify every old-key call. Do not generate old-key canaries during the quiet
   observation.
5. Retire the old-key configuration rollback path in the operational runbook.
   After permanent retirement, approved code rollbacks must retain current target
   KMS configuration. The immutable Doppler pre-cutover configuration remains
   historical evidence, not an executable restoration procedure. Preserve it
   without recreating or exposing credentials.
6. Only after accepted live, retained-state, backup, and rollback evidence is
   complete, prepare an exact-key `ScheduleKeyDeletion` operation. Verify identity,
   state, waiting period, and returned deletion date. KMS requires a 7–30 day wait
   and the key is unusable while pending deletion. Maintain a tested cancellation
   and re-enable procedure during that period, and observe failures before the
   irreversible deadline.

Do not substitute `DisableKey`, a successful metadata job, configured expiration,
or an empty denied query for these dependency checks.
