# Authorized production source-key retirement

The owner authorized deleting the old production KMS key after the current
target-only production verification passes on September 15, 2026. This accepts
loss of recovery for historical ciphertext that still requires the old key.
It supersedes waiting for the September 25 backup-retention checkpoint. Preserve
the original snapshots, branches, credentials, deployments, target key and both
accounts' audit services. This decision does not prove each historical snapshot
independent of the source key.

## Protected operation

Run `KMS Production Retirement` only from reviewed `main`, through the production
environment. Its shared concurrency group excludes other migration operations.
The default `source-status` operation only authenticates the pinned source
principal and describes the exact old key:

`arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8`

For `retire-source`, independently collect the accepted current `verify-target`
run, archive digest and deployment ID. Supply those as `verification_run_id`,
`verification_artifact_sha256` and `expected_deployment_id`, and set
`accept_historical_recovery_loss=true` under the authorization above.

The controller requires a successful, first-attempt, manual `main` preflight run
owned by `hulh122`; verifies the original GitHub artifact's digest and provenance;
and requires its known-field and nested-field recovery counters to be entirely
target-only with no invalid, unknown, uninspected or modified fields. The accepted
target-only STS policy and recovery manifest are pinned. Proof must be less than
six hours old and cover the unchanged production API deployment. A changed
deployment or failed proof stops the operation for review.

Before mutation, the controller refreshes the full source CloudTrail interval
from September 10, including both ARN and key-ID pagination. Cryptographic,
unclassified or failed events stop retirement for review. The audit retains its
15-minute visibility buffer and does not claim to exclude late arrivals.

The immutable Doppler backup supplies existing source credentials only inside
the protected workflow. The controller verifies the exact account, IAM user,
key ARN, key ID, single-region symmetric key type and current state. It calls
`ScheduleKeyDeletion` with a seven-day window and reads `DescribeKey` afterward.
No target or production credentials, data, backup, deployment, grant or audit
configuration is changed. The principal needs `kms:DescribeKey` and
`kms:ScheduleKeyDeletion` on this exact key, plus the already-used CloudTrail
read permission. An access failure does not authorize broadening permissions.

## Receipt and recovery

The `kms-production-retirement-<run>-<attempt>` artifact retains the sanitized
receipt and refreshed audit for 30 days. It records the actual state and AWS
deletion date. **PendingDeletion immediately prevents decryption; it is not
physical deletion.**

The workflow rejects reruns, disables AWS CLI retries for retirement, and writes
an `unknown` mutation-effects checkpoint before submitting the request. If the
request or its readback is uncertain, collect the receipt and run a new
`source-status` operation before considering another mutation. An already
pending key is observed without scheduling again. Do not infer that an error
means the request did not execute.

Before the actual deletion date, cancellation requires `CancelKeyDeletion` on
the exact key, followed by `EnableKey` if decryption must be restored; cancellation
alone leaves it disabled. Any required cancellation must use reviewed protected
Actions and its actual authorization. Preserve the new runtime KMS configuration.
Physical deletion cannot be undone.

After the recorded AWS date, use a finite follow-up to run `source-status` and
reconcile `NotFoundException` against the earlier verified pending-deletion
receipt and the authenticated account. A bare not-found response does not prove
when deletion occurred. Verify relevant production behavior, report the final
state, and stop the finite retirement automations. This retires only the named
production key, not the entire AWS account or issue #32264.
