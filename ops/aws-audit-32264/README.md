# Target AWS audit operations

Owner: the AWS migration operation in
[#32264](https://github.com/okou-ai/okou/issues/32264), assigned to `hulh122`.
This directory owns the retained target-audit command and its inert regression
fixtures. Shared script standards remain in
[GitHub scripts](../../docs/github-scripts.md).

## Protected entry point

Use [AWS Audit Target Setup](../../.github/workflows/aws-audit-target-setup.yml)
through a separately approved manual dispatch on `main` and its protected
`production` environment. The workflow installs `boto3==1.40.0` and invokes
`aws-audit-target-setup.py` from the checked-out repository root. The command
resolves policy inputs relative to its source file, so the policy path does not
depend on the working directory.

The command accepts no target arguments. It requires GitHub's repository/run
metadata, the exact main/manual/workflow identity, the job's OIDC request URL
and token, and `RUNNER_TEMP`. It assumes only
`arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264` and verifies that
identity before resource work in account `251964670836`, region `us-west-2`.
The approved role/trust permissions and audit configuration remain authoritative
under [`.github/aws-audit-32264`](../../.github/aws-audit-32264/); the
[migration identity guide](../../.github/kms-migration-32264/README.md) describes
the immutable repository OIDC subject and protected environment prerequisite.
Do not fabricate workflow metadata to run this command locally.

This is a write-capable setup operation: it configures the fixed CloudTrail and
AWS Config buckets, recorder role, trail and recorder, then verifies matching
delivered audit records. Existing-resource conflicts fail rather than broaden
the target. It does not change KMS, the old account, or historical audit logs.

## Outputs and lifecycle

The command emits sanitized JSON and writes `RUNNER_TEMP/aws-audit-target.json`;
the workflow retains that report for 30 days, including failed setup attempts.
Exit 0 means the command completed its setup and fresh-delivery verification;
exit 1 and `incomplete_inspect_report` require review of the retained report.
Failure or cancellation can follow partial resource changes. Reconcile the
actual fixed resources before another approved run; a missing report does not
prove nothing happened.

The [permanent retirement record](../../.github/kms-migration-32264/permanent-retirement.md)
owns the migration/recovery requirements. A setup report or source relocation
does not clear key/account retirement. Retire this command only after its
operational owner confirms no supported setup/reconciliation caller remains
and updates the protected workflow and CI adapter together. Preserve required
audit services, policy inputs and historical evidence.

## Inert verification

From the repository root:

```bash
bash .github/scripts/tests/aws-audit-target-setup-test.sh
```

The CI adapter installs the pinned SDK into an owned temporary directory, runs
`tests/aws-audit-target-setup-test.py`, propagates its exit status and cleans up.
The suite uses synthetic credentials and botocore stubs; it exercises identity,
authorization, delivery evidence and redaction without live AWS access. The
adapter remains registered in the workflow-script test shard manifest.
