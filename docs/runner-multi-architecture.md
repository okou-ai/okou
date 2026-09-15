# Runner Multi-Architecture Rollout

This document describes the operational contract for running Okou runners on
more than one host CPU architecture.

## Core Invariant

Runner host architecture determines every architecture-specific runner output:

- Rust target triple
- Runner image manifest target
- Release asset name
- Deploy, promote, and rollback asset
- Host-bound test target

Do not choose these values independently in workflows. Use the shared helper
scripts so CI, release, deploy, rollback, and local development keep the same
mapping.

## Supported Targets

`.github/scripts/runner-image-target.sh` is the implementation source of truth
for supported runner targets and derived metadata.

| Host `uname -m` | Rust target triple           | Cache suffix   | Release asset suffix | Release asset                      |
| --------------- | ---------------------------- | -------------- | -------------------- | ---------------------------------- |
| `aarch64`       | `aarch64-unknown-linux-musl` | `aarch64-musl` | `aarch64-linux`      | `runner-v${VERSION}-aarch64-linux` |
| `x86_64`        | `x86_64-unknown-linux-musl`  | `x86_64-musl`  | `x86_64-linux`       | `runner-v${VERSION}-x86_64-linux`  |

Runner release tags use `runner-rs-v${VERSION}`. Runner release assets use
`runner-v${VERSION}-${assetSuffix}`.

## Host Inventory

`AWS_METAL_RUNNER_HOSTS` is the single metal runner inventory for this rollout.
There is no separate architecture-specific host secret.

`.github/scripts/runner-host-architecture-groups.sh` derives architecture
groups by probing each host with SSH:

```bash
ssh "${METAL_USER}@${host}" uname -m
```

The helper accepts the configured host inventory and emits architecture groups
for the supported target triples. Unsupported host architectures fail early.

The full local contract includes host lists and is intended for same-job use:

- `id`
- `label`
- `hosts`
- `target`
- `unameM`
- `cacheSuffix`
- `assetSuffix`

The cross-job matrix contract is sanitized and excludes host lists:

- `id`
- `label`
- `target`
- `unameM`
- `cacheSuffix`
- `assetSuffix`

The deploy and rollback target matrix contains only:

- `id`
- `label`
- `target`

Host lists must not be passed through GitHub Actions job outputs or matrix JSON.
Jobs that need concrete hosts resolve them locally for the selected group:

```bash
.github/scripts/runner-host-architecture-groups.sh hosts "$RUNNER_HOST_GROUP_ID"
```

Jobs that need one representative host use the deterministic selector:

```bash
.github/scripts/runner-host-architecture-groups.sh select-host "$RUNNER_HOST_GROUP_ID" "$JOB_REF" "$HOSTS"
```

## Workflow Consumers

Runner image production resolves architecture groups, builds one runner image per
configured group, and validates the manifest under that group's target triple.

Runner binary cache reuse is target-specific. Prepare resolves small references
for the current build-input digest; each image-build job downloads its own
binary directly from the trusted R2 cache. GitHub cache metadata is a lookup
index, not a second source of provenance validation for R2 objects. Cached
binaries are not re-uploaded as a combined GitHub artifact.

Targets without an available cache reference use the normal compile job, which
uploads the binary directly to the existing content-addressed R2 cache. Only
after verifying that object does it publish a small R2 manifest scoped to the
repository, workflow run, target, and input digest. Image-build and cache-index
jobs download the fresh binary from R2; neither transfers binary payloads through
GitHub artifacts or uploads the binary again. The cache-index job retains the
existing shadow comparison and optional small GitHub manifest publication.

Fresh publication and download are required: missing configuration, storage
failures, invalid manifests, or binary hash/size mismatches fail the job. Cache-hit
downloads remain required as well. Compilation stays in the existing compile
job; only its transfer step receives R2 credentials.

Required consumer GETs use `runner-binary-download.sh`: at most three complete
download attempts, with 1s/2s backoff and a new partial file each time. Cached
GETs retain their 60s attempt deadline and have a 198s total transfer budget.
Each fresh manifest/binary GET retains a 120s attempt ceiling and has a 240s
total budget. The helper reserves the 5s termination grace and shortens later
attempts to fit the remaining budget. Two fresh GETs therefore consume at most
480s of transfer time within the cache-index job's existing 10-minute timeout;
validation and job setup still consume that enclosing budget.

Only these GETs set `AWS_MAX_ATTEMPTS=1` and `AWS_RETRY_MODE=standard`, so the
helper owns whole-download retries without multiplying SDK request attempts.
Socket connect/read limits remain 5s/30s. Timeouts (exit 124), throttling,
temporary service failures and recognized transport interruptions are retried.
Authorization, configuration, missing artifacts, unknown errors and signal
exits fail without another attempt. Validation failures are outside the retry
loop. Exhaustion fails the required job; there is no compile fallback or
automatic workflow rerun. PUT and cache lookup/publication policies are unchanged.

The helper requests `AWS_CLI_ERROR_FORMAT=json` and classifies service errors
by code, never provider message text. AWS CLI's general transport exceptions
remain unstructured, so only known SDK-owned transport prefixes are recognized.
Unsupported or changed error formats remain unknown rather than guessed.
Logs contain only fixed operation/target labels, attempt count, elapsed time,
byte count, exit status and a safe category. Raw provider output stays private
and is removed with temporary files. SIGINT/SIGTERM/SIGHUP interrupt both
downloads and backoff, terminate owned work and prevent retry/publication.

References: [AWS CLI retry ownership](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html),
[CLI error formatting](https://github.com/aws/aws-cli/blob/v2/awscli/errorhandler.py),
[post-call streaming output](https://github.com/aws/aws-cli/blob/v2/awscli/customizations/streamingoutputarg.py),
and [Botocore transport exceptions](https://github.com/boto/botocore/blob/develop/botocore/exceptions.py).

Fresh reference keys omit the attempt number so a consumer-only rerun can read
an earlier successful producer. The manifest retains the producer attempt.
References live under `runner-binaries/transports/` and contain only metadata;
binary objects keep their existing keys and cache schema. This workflow does not
delete the small run references or configure bucket expiration. Cache-Control is
not an object-retention policy. Small image manifests also continue to use GitHub
artifacts; this is a binary-transport change, not complete artifact-service removal.

Crates host-bound tests resolve the same sanitized matrix and run architecture
specific checks, including NBD COW tests, on matching metal. Jobs that need an
actual host resolve the host subset inside the job instead of reading hosts from
the matrix.

Crates plans image validation with `validation-plan KEY` using the same
deterministic host selection as `runner-build`. That job validates the entire
selected architecture group; a parallel manifest matrix validates only the
remaining groups. The full matrix still drives NBD COW and rootfs process tests.
The CI gate requires both validation paths when applicable, including on reruns.

Playwright uses the same metal inventory to bootstrap the runner exercised by
the deployed product chat flow. Architecture-specific runner behavior remains
in the host-bound crates checks instead of being duplicated in product E2E.

Release publishing builds runner assets for all supported target triples. The
asset names come from `.github/scripts/runner-image-target.sh`.

Production build, promote, and rollback resolve the deploy/rollback target
matrix from the configured inventory. Each matrix leg downloads or uses the
runner binary matching that group's target and passes `runner_target` to Ansible.

Ansible deploy and rollback validate the remote host architecture before
installing, promoting, or rolling back a runner binary. A target and remote
architecture mismatch should fail before mutating the runner service.

## Local Development

`scripts/dev-runner.sh` derives the runner target from the remote host
architecture by default.

Set `RUNNER_TARGET_TRIPLE` only when you need to force a supported target. The
script validates that the forced target matches the remote host `uname -m` before
building and uploading the runner.

## Dispatch Boundary

Current runner dispatch is not architecture-aware. The mixed-architecture rollout
selects the correct binary and image artifacts for each runner host, but it does
not guarantee that a profile or run always lands on a fixed CPU architecture.

Workspace and sandbox reuse are runner-local, so a local workspace is not shared
across different runner machines. If the product needs fixed-architecture
scheduling semantics later, that should be handled as a separate control-plane
design.

## Validation Checklist

Record dated validation evidence in the rollout issue or PR, grouped by
architecture group. Do not mark an architecture as runtime-validated solely
because cross-compilation or release asset publication succeeded.

For each configured architecture group, record evidence for:

| Area                      | Evidence to record                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Runner image production   | The matrix leg built the image and uploaded a target-specific manifest.                          |
| Runner image consumption  | Consumers resolved the matching target-specific manifest.                                        |
| NBD COW tests             | Host-bound NBD COW tests ran on matching metal.                                                  |
| Runner setup              | `runner setup` downloaded and verified Firecracker, kernel, and mitmdump artifacts.              |
| Rootfs and snapshot       | `runner build --profile vm0/default` built the template, rootfs, and snapshot on matching metal. |
| Snapshot restore          | A sandbox restored from the snapshot successfully.                                               |
| Local runner smoke        | A local runner claimed and completed a smoke job.                                                |
| Guest CLIs                | Chromium, Claude Code, Codex, Node global packages, PostgreSQL, Go, and Rust work in the rootfs. |
| Release asset             | The expected `runner-v${VERSION}-${assetSuffix}` asset exists.                                   |
| Deploy, promote, rollback | The host used the matching asset and passed architecture preflight.                              |

If a host architecture is not configured in `AWS_METAL_RUNNER_HOSTS`, record that
state explicitly instead of marking the architecture complete.
