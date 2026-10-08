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

The binary input key hashes the committed source/build inventory, target and
embedded CLI content, not the source commit identity. The CLI contribution is
its actual package SHA-256 plus a canonical projection of the validated
manifest fields consumed by `crates/runner/build.rs`: CLI/Pi versions and
session-construction digest. Fixed manifest schema/path and package SHA/size
agreement remain validated before lookup, but are not hashed again. Commit
provenance, JSON formatting/key order and unused manifest fields do not affect
reuse. Manifest validation preserves JSON
integer types and rejects duplicate compilation fields using Python 3, which is
available in the pinned Rust toolchain. Invalid CLI inputs fail before cache
lookup; commit-addressed CLI publication and provenance verification are
unchanged. Input schema 6 intentionally starts a new key space, so the first
build of each input combination misses once without migrating old references.
The digest helper is itself part of the committed build inventory; changing its
hash recipe also rotates keys without changing the cache artifact schema.

### Package-bound CLI identity and local rootfs keys

The CLI postbuild step writes `okouBuildIdentity` into the existing packed
`package.json`. Its mandatory schema version 1 contains `piAgentRuntime`, `piSdk`
(the upstream version plus first-party patch-set digest), and
`sessionConstruction.digest`; the existing package `version` remains the CLI
version. The record contains neither commit provenance nor its own final SHA or
size. Artifact preparation reads identity from the actual packed file, rather
than independently rereading workspace metadata after packing.

Native verification and Rust compilation require one regular packed
`package/package.json`, at most 16 KiB, with valid consumed fields and no duplicate
consumed keys or metadata entries. The compressed package remains bounded at
64 MiB; both readers cap the complete decompressed stream at 256 MiB and never
extract or execute package code. Missing identity or disagreement with the
external identity fails directly; there is no legacy-format fallback.
Commit provenance, actual package SHA/size, ready checksums, canonical asset
checks, captured package URLs and immutable versioned publication remain
mandatory. New package bytes require a new CLI version through the normal
CLI-to-Runner release dependency, not overwriting an existing versioned object.

The build-only native module `crates/runner/cli_package.rs` validates external
inputs inside the existing Runner package. Compilation snapshots the exact
verified package buffer and generates `installed.json` through `guest-contracts`
from that same buffer's identity, SHA and size. Both are embedded resources;
rustc does not reread the mutable external package after validation. Runtime
staging only writes those trusted compiled bytes, without archive parsing,
identity comparison, SHA/size self-checks or installed-manifest regeneration.
External disk state still needs installation verification and exact cached-sidecar
comparison. No separate CLI package crate or runtime decoder is needed.

The **local rootfs** CLI contribution is only the build-time SHA-256 computed from
the verified package. Packed identity uniquely determines the installed versions and
session metadata; package size follows from bytes and installation paths follow
from the CLI version and fixed rules. Installed metadata and exact sidecar
checks remain, but they are not independent hash inputs. Changes to installed
schema, serialization or fixed installation paths must rotate the local rootfs
recipe version. Local rootfs cache version 3 starts a new namespace without old-cache fallback. Shared R2 template
cache version 1, snapshot cache version 3, guest binaries, customization, disk,
CA and DNS inputs are unchanged. The CI binary-key recipe above is unchanged.
This makes the authority and hash contract simpler; it does not establish a
higher cache-hit rate or measured build acceleration.

Targets without an available cache reference use the normal compile job, which
uploads the binary directly to the existing content-addressed R2 cache. Only
after verifying that object does it publish a small R2 manifest scoped to the
workflow run and input digest. Image-build and cache-index
jobs download the fresh binary from R2; neither transfers binary payloads through
GitHub artifacts or uploads the binary again. The cache-index job retains the
existing shadow comparison and optional small GitHub manifest publication.

Fresh publication and download are required: missing configuration, storage
failures, invalid manifests, or binary hash/size mismatches fail the job. Cache-hit
downloads remain required as well. Required runner-binary compilation stays in
the existing compile job. Its transfer step and compiler-cache startup step
receive R2 credentials; credentials are not exported through `GITHUB_ENV` or
added to the build step.

The compile job uses sccache's S3 backend against the existing R2 bucket, under
`runner-sccache/arm64/` or `runner-sccache/x86_64/`. Within each prefix, sccache
derives keys from the compiler and compilation inputs. Crate names and CI job
names are not extra namespace layers, so compatible compilations in other jobs
can reuse the same cache when configured with the same prefix.
These compiler outputs are separate from runner binary objects and manifests.
PR, merge-group, and main builds with
the existing R2 access share this cache; forks without those secrets cannot
populate it. The sccache server retains the startup step's credentials for its
job-local lifetime. Missing R2 configuration fails cache startup explicitly.

### Shared R2 sccache action

Jobs that use the shared compiler cache call
`.github/actions/setup-r2-sccache` once after checkout. The action installs the
pinned sccache version, validates the architecture and R2 configuration, starts
the job-local server, and exports only the compiler settings needed by later
steps:

```yaml
- uses: actions/checkout@v7.0.1

- name: Setup R2 sccache
  uses: ./.github/actions/setup-r2-sccache
  with:
    architecture: ${{ matrix.id }}
    r2-access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
    r2-secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    r2-account-id: ${{ vars.R2_ACCOUNT_ID }}
    r2-bucket-name: ${{ vars.R2_USER_STORAGES_BUCKET_NAME }}
```

The `architecture` input is the runner architecture-group ID, not an arbitrary
cache prefix:

| Architecture input | Rust target                  | sccache prefix           |
| ------------------ | ---------------------------- | ------------------------ |
| `arm64`            | `aarch64-unknown-linux-musl` | `runner-sccache/arm64/`  |
| `x86_64`           | `x86_64-unknown-linux-musl`  | `runner-sccache/x86_64/` |

Callers pass the existing R2 configuration explicitly. They do not pass a raw
prefix or add job, crate, branch, or commit namespaces. Use the action only once
per job so the server keeps the startup credentials for the complete compiler
lifetime without exposing them to later build steps.

Rust coverage is an `x86_64` consumer of this architecture-only namespace.
Pushes, merge groups, and same-repository pull requests start the shared action;
fork and Dependabot pull requests skip the credentialed setup and run the same
coverage command without sccache. A trusted run that selects the action still
fails when its R2 configuration is missing instead of silently falling back.

### Production release compilation

`build-runner-release-assets` uses the same shared action before its existing
release rust-cache. The release matrix resolves its Rust target through
`runner_image_sccache_architecture`, then passes the repo-level R2 secrets and
variables shown above. The job intentionally has no `environment: production`,
so compiler caching uses the test/development R2 bucket shared with CI rather
than the production-scoped user-storage bucket.

This is separate from the downstream `resolve-image-cache` handoff. Production
host image builds require `environment: production`, so that resolver reads the
repo-level image-cache configuration outside the environment and transfers the
encrypted credentials into the environment-bound job. Release-asset compilation
must not replace or redirect that handoff.

The production release job retains its separate guest and embedded Runner
compilation phases together with the existing release creation, asset upload,
Slack notification, and deployment behavior.

The shared R2 compiler cache avoids GitHub's branch-scoped storage and quota.
Cache backend statistics in the compile job report actual hits, misses, and
write errors; binary and image validation remain required.

### Runner dependency-cache prewarming

The additional Cargo dependency cache uses GitHub and saves only on main. PR
and merge-group compilations restore it without saving. Ordinary main compiler
misses still populate their own architecture-specific dependency cache.

Main often reuses an R2 runner binary and skips the compiler. To keep a trusted
writer in that case, Runner Image starts an independent `prewarm-rust-cache`
job for binary-hit targets on non-release main pushes that need a runner image.
The planner partitions the configured targets into hit and compile matrices,
so a target already requiring main compilation is not also prewarmed.

The producer uses the same pinned Rust Cache action, toolchain container,
sccache/compiler environment, `crates/target` directory, canonical `ci` build,
and `aarch64-musl-ci` or `x86_64-musl-ci` shared key as consumers. It first checks
the exact key with `lookup-only` and saving disabled. An exact hit skips cache
restore, CLI-input download, and compilation. Otherwise it restores compatible
dependency artifacts and builds only if restore does not report an exact hit;
an exact hit appearing between lookup and restore also skips the build. The
normal successful-job post action saves dependencies with workspace crates excluded.

Prewarming is a best-effort optimization, not an image, release-asset, or
deployment prerequisite. It never publishes its runner outputs. A prewarm
failure does not relax any required compilation, transfer, binary validation,
or image gate. Its summary reports actual step outcomes and the cache-hit
outputs emitted by the action; an empty output is not fabricated as a skipped
step or a cache hit. A successful prewarm build alone does not prove that the
subsequent cache-save post action succeeded.

The first use of a new or evicted dependency key can still be cold, and an
initial prewarm can extend its main workflow's concurrency slot. Before claiming
a speedup, verify main saves and subsequent PR exact restores for both targets,
then measure cache archive costs and compiler duration. This does not replace
R2 sccache statistics or the existing runner-binary reuse policy.

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
References use `runner-binaries/transports/<run_id>/<binary_input_digest>.json`
and contain only metadata. This prefix serves this repository, and the input
digest already includes the target. The manifest still validates the repository,
run ID, target, and input digest. Producer and consumer jobs use the same checked-out
scripts, so older runs and their reruns keep using their original key format.
Binary objects keep their existing keys and cache schema. This workflow does not
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

Native CPU fairness and guest RPC tests compile as soon as `runner-host-groups`
selects a target, in parallel with `runner-build` waiting for the image. The
`host-cpu-fairness-build` and `guest-rpc-firecracker-build` jobs retain their
existing `release` and `ci` profiles and separate Cargo cache keys. Compilation
does not use a metal host, rootfs, or snapshot. Execution waits for both its
compiled test and the selected image, then uses the same host and immutable image
hashes supplied by `runner-build`.

Each producer uploads its compressed test binary and provenance to R2 under
`runner-binaries/<target>/<run_id>/<producer_attempt>/<test>.zst` and the matching
`.json` key. This follows the existing runner binary layout: the first directory
is the validated target triple (`aarch64-unknown-linux-musl` or
`x86_64-unknown-linux-musl`). These objects transfer a compiled test between jobs in the same
workflow run; they are not reused across runs or PRs. They use the existing
seven-day lifecycle policy for the `runner-binaries/` prefix.

Before contacting metal, the consumer validates the source SHA, repository,
workflow run, producer attempt, test identity, target, and binary hash. A
consumer-only rerun uses the earlier successful producer's attempt, even when its
own attempt has advanced. Missing, expired, or invalid artifacts fail the job;
rerun the producer to publish a fresh artifact after expiration. There is no
fallback to another run or target.

The Crates gate requires both compilation and execution when a native test is
selected. A failed or skipped producer cannot turn its dependent execution into
an allowed skip. The existing selection rules still allow CPU fairness to be
omitted for unrelated changes and all native tests for release-only workflows.

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
