# Cached Workspace handoff to a prewarmed Blank

Tracking: [#34729](https://github.com/vm0-ai/okou/issues/34729), under
[#24203](https://github.com/vm0-ai/okou/issues/24203).

This opt-in KVM study evaluates a cached workspace disk on an already-started,
never-assigned Blank. It includes a standalone backend experiment and a Runner
integration behind the default-disabled `workspace-handoff-study` Cargo feature.
Normal Runner builds retain production admission behavior. The historical backend
measurements below are component evidence; the integrated experiment measures
the existing `api_to_spawn` boundary through a real preview API and Runner.

The corrected integrated candidate does **not demonstrate a reliable
`api_to_spawn` improvement**: its 10-pair cohort splits 5 wins/5 losses, with only
1.5 ms paired median improvement and a worse p90. Keep this as a default-disabled
experiment; the backend component improvement does not justify production activation.

## Integrated Runner lifecycle

Only the isolated candidate Runner is built with `workspace-handoff-study`.
It retains Exact reuse precedence and allows a compatible never-assigned Blank
to serve a Workspace cache candidate. Profile, disk-size, device-limit and
existing admission checks remain in force. After validating the execution
context, the candidate acquires the normal fresh pre-spawn admission permit and
checks out the real workspace cache lease for the selected Blank's sandbox ID.
The permit remains owned through the existing Agent-ready release boundary.

A cache hit supplies an exclusively owned `Move` seed. The backend checks the
running, unparked Blank configuration and requires distinct canonical regular
files of the configured size, on the same filesystem, with an unshared source
inode. It then performs ordinary guest unmount, `blockdev --flushbufs`, synchronous
atomic rename onto the Blank's canonical active-image path, Firecracker PATCH of
only `path_on_host`, and the fixed native workspace mount operation. The old
snapshot bind mount retains the old empty inode; the patched path opens the new
one. Disk limiters are not replaced or reset.

The original cache lease continues to own that canonical active path. The
candidate carries the cached storage fingerprints into normal storage
preparation, resolves the existing history restore plan, and clears the Blank's
prepared-guest marker so the attached image receives required state preparation.
For a hash-backed resume, a study Blank with workspace caching defers history
materialization until checkout, giving the cached history sidecar the same first
opportunity as the fresh path. A cache miss uses the existing remote restore;
Exact reuse and Blanks without workspace caching retain their original strategy.
Normal proxy/readiness, private-file, storage and Agent preparation still precede
shell spawn. Successful writes use the existing terminal cache-promotion path.
A cache miss continues with the Blank's empty disk and normal preparation.

Any handoff error or observed cancellation is terminal for that candidate: drain
owned history work, destroy the VM, invalidate the checked-out cache entry, and
release its lease. A partial handoff cannot return to idle inventory or enter
image promotion. Cancellation does not drop an in-flight handoff operation;
the owner waits for its bounded guest/API stages and checks cancellation before
Agent preparation. A consumed cache hit cannot enter the ordinary Blank
prefetch-replacement retry. A cache-miss replacement releases its admission
permit before fresh preparation reacquires it. Host loss and hard process
termination remain separate recovery boundaries.

No telemetry endpoint is redefined. `api_to_spawn` still subtracts the genuine
API `api_start_time` from the recorded Agent `shell_started_at`; the handoff and
all required preparation are inside that interval. Agent readiness, verifier
completion and post-spawn I/O remain separate observations.

### Integrated reproduction and fixture boundary

Use an isolated preview API/Runner group and an exclusively owned local-11
runtime directory. Both arms must use the same API revision, copied rootfs,
kernel, Firecracker version, Guest executables and configuration. Build the
baseline without the feature and the candidate with it; preserve each binary
and its hash before another build can overwrite it.

```sh
umask 077
cargo build --manifest-path crates/Cargo.toml --locked --profile ci -j 1 \
  -p guest-agent -p guest-storage-apply -p guest-init -p guest-state-restore \
  -p guest-write-file -p guest-workspace-mount -p guest-tool-exec \
  -p runner-rpc-client -p claude-mock -p codex-mock
cargo build --manifest-path crates/Cargo.toml --locked --profile ci -j 1 \
  --target-dir /absolute/build-baseline -p runner
cargo build --manifest-path crates/Cargo.toml --locked --profile ci -j 1 \
  --target-dir /absolute/build-candidate -p runner --features workspace-handoff-study
cargo build --manifest-path crates/Cargo.toml --locked --profile ci -j 1 \
  --target-dir /absolute/build-candidate -p sandbox-firecracker \
  --example workspace_handoff_snapshot
```

Copy a verified generic rootfs into a new owned image directory and install
**all ten** optimized Guest executables at the destinations in
[`guest-binaries.json`](../crates/runner/guest-binaries.json). Verify every embedded
binary by hash against its build output, resolving the copied image's `/sbin`
symlink where necessary. The three-binary preparation script in the historical
backend reproduction is insufficient for real Runner execution.

The snapshot helper takes a JSON file containing `id` (a 64-character hex
identity), absolute `binary_path`, `kernel_path`, `rootfs_path`, and `output_dir`.
Derive and record the identity from the fixed artifacts/profile, and create the
snapshot directly at its final owned Runner image path; the helper refuses an
existing output path and verifies the snapshot completion contract.

```sh
sudo /absolute/build-candidate/ci/examples/workspace_handoff_snapshot \
  /absolute/owned-study/snapshot-config.json
```

Fix both arms at 2 vCPUs, 4096 MiB RAM and a 10240-MiB workspace. The sandbox's
total block budget is 100 MiB/s and 10,000 IOPS, split equally across rootfs and
workspace drives; network RX and TX each receive 50 MiB/s. Do not interpret the
total as a separate 100-MiB/s allowance for each disk. Preserve the same pool and
admission budgets and read back effective VMM limits. The isolated configuration
uses `max_concurrent: 5`, `max_idle: 1` and `concurrency_factor: 1` to permit one
Blank; the experiment controller submits serially, with at most one executing
run plus one Blank. The configured capacity is not permission to load the host
with five simultaneous experimental runs.

Use a dedicated Clerk test user/org, normal device-flow PAT and Stripe TEST
entitlement on the preview. Configure the member mock-Claude provider and
`claude-sonnet-4-6` as in the Runner E2E bootstrap, with
`_realAgentInPreview=false` and mock Claude enabled in the study Runner. Submit
through the real API, verify the assigned Runner group and Workspace path, and
join telemetry by the API-issued run ID. Mock Claude supplies deterministic
shell work without external model calls; this measures real API/Runner/Guest
startup, not model-provider latency or production prompt behavior. Keep tokens
and fixture identities out of published evidence.

Seed and verify matched synthetic content through normal runs, preserve cache
checkout/write-back ownership, alternate baseline/candidate arms, and retain
failed or incomplete attempts separately. Measure the intended cache-hit path;
Exact reuse or a cache miss cannot substitute for a Workspace handoff sample.
Shared local-11 services, host cache state, long Blank residency and pool
opportunity cost constrain interpretation. Audit only the study's processes,
paths, mounts and fixture resources; preserve unrelated services. Numerical
integrated results require matched run records and are not inferred from the
historical CSV.

## Integrated API evidence

The integrated measurements use real `/api/chat/events` requests on the isolated
PR preview, genuine API-issued run IDs and the existing host startup operations
in Axiom's `vm0-sandbox-op-log-dev` dataset. Neither client elapsed time nor guest
verifier completion substitutes for `api_to_spawn`. Both arms retain
`runner_startup_path=workspace` and `sandbox_reuse_result=poolMiss`: a Blank has
not previously served the requested session and is not Exact reuse.

Each arm restarts the owned Runner, waits for one ready Blank and no Exact
inventory, submits one request, checks the intended cache-hit path and content,
then stops and verifies cache promotion before the next request. A synthetic
fixture has 131 hashed file entries, a 32-MiB file, hardlink and relative symlink,
directory, modes, ownership and mtime. Every successful sample checks the prior
counter and writes the next counter, so later runs verify actual write-back.
Pool prewarming is outside the API request; replenishment and ordinary
preparation during the request remain inside the measured path.

### Initial integrated candidate: retained regression

Candidate v1 was measured in two separate 10-pair cohorts on September 17, 2026.
The first cohort alternates baseline/candidate and candidate/baseline; the
replication reverses the first pair. The replication was scheduled before its
results were inspected. Both cohorts completed all 20 requests and all content,
path and promotion checks. Build and test activity had ended before sampling.

The first cohort has complete telemetry for all 10 pairs. `api_to_spawn` became
slower in **10/10 pairs**, with a paired median regression of **116.5 ms (19.82%)**.
Nearest-rank p50 increased from 654 to 747 ms and p90 from 717 to 902 ms. The
candidate handoff itself had a median of 36.5 ms. The separate Agent-ready paired
median improved by 44.5 ms, while its mean and p90 worsened; this does not change
the primary startup verdict.

An exact-run diagnostic query retained 5,760 operation records for that cohort.
It found a real integration asymmetry: baseline used cached session-history
sidecars in 10/10 runs, but v1 prestarted remote history downloads in 10/10. The
remote download median was 197 ms and the restore wait median was 119 ms. The
same-run create versus unpark-plus-handoff component still improved by a paired
median 72.5 ms. Agent shell-start acknowledgement was also later in v1; these
observations do not isolate backing-drive replacement as the cause of the full
startup regression.

The submitted implementation corrects the history asymmetry by deferring the
eligible Blank's history decision until real workspace checkout. Its matching
sidecar can then use the existing local materializer. The v1 cohorts are retained
as earlier-version evidence and must not be pooled with the corrected binary.

The final replication read recovered all initially delayed telemetry: all 10
pairs are complete. V1 regressed by a paired median 65 ms (10.41%), with 3 wins
and 7 losses. No missing run was discarded or replaced by local timing.

### Corrected integrated candidate

Candidate v2 fixes that history decision and was measured as a separate 10-pair
cohort, with five baseline-first and five candidate-first pairs. The baseline
binary and fixture stayed unchanged. All 20 requests completed their content,
path and promotion checks; all 70 selected telemetry records are present, with
no failed, missing or duplicate startup measurements. The corrected executable
SHA-256 is `b075170fcb9b70277e41063f2b531a8eea340f0b848fdf1ded9218f9e9f937ec`.

| Cohort         | Complete pairs | Baseline/candidate spawn median (ms) | Baseline/candidate spawn p50 (ms) | Baseline/candidate spawn p90 (ms) | Paired median gain (ms / %) | Candidate wins/losses |
| -------------- | -------------: | -----------------------------------: | --------------------------------: | --------------------------------: | --------------------------: | --------------------: |
| v1 formal      |             10 |                          660.5 / 765 |                         654 / 747 |                         717 / 902 |            -116.5 / -19.82% |                0 / 10 |
| v1 replication |             10 |                            639 / 709 |                         632 / 704 |                        1070 / 769 |               -65 / -10.41% |                 3 / 7 |
| v2 corrected   |             10 |                            662 / 656 |                         658 / 650 |                        783 / 1191 |               +1.5 / +0.15% |                 5 / 5 |

Positive paired gain means baseline minus candidate, so positive is faster.
Medians are arithmetic medians; p50/p90 use nearest rank. Each percentage is
computed within its pair before taking the median. Cohorts remain separate.
V2's mean `api_to_spawn` is 706.2 ms baseline versus 773.3 ms candidate, a
67.1-ms regression. Its nearly tied paired median and worse tail do not establish
a primary startup benefit on this shared host.

Agent readiness is secondary: v2's paired median gain is 68.5 ms (7.84%), with
6 wins/4 losses; readiness p90 is 995 versus 1302 ms. Handoff duration has a
36-ms arithmetic median and 46-ms p90. Neither replaces the shell-spawn verdict.
The [API results CSV](./workspace-handoff-api-results.csv) retains all 64 requests:
the failed seed, three successful preflight requests, both original 20-request
cohorts, and the corrected 20-request cohort. Version/cohort and eligibility
columns prevent pooling earlier candidates or preflight work into the result.

The final owned-resource audit reports `clean=true`, with all four pre-existing
Runner services unchanged. The retained integrated evidence bundle has SHA-256
`6613bb9025e4b86abf2052379d28c1c290d13b67bf3ed2ac141a4c203a154536`.

The first real seed attempt failed after its shell ran because the test harness
sent Codex framing markers to mock Claude, which executes the whole prompt as
Bash. Its cache promotion was also rejected by the unchanged 50-GiB minimum
free-space policy. The failed request and its separate thread were retained;
the corrected seed used a new request/thread after terminal-state confirmation.
Only a verified, unused duplicate image owned by this study was removed to
restore disk headroom. Earlier launcher failures occurred before any API POST.

## Historical standalone backend lifecycle

The fresh arm creates a snapshot-restored VM with an exclusively owned synthetic
workspace seed. The Blank arm creates and mounts an empty disk, parks the VM,
then starts its measured interval before unpark. It performs an ordinary guest
unmount, `blockdev --flushbufs`, transfers the owned seed into the sandbox's
workspace directory, patches the existing Firecracker `workspace` drive to that
absolute path, and remounts through the native workspace helper. Both arms
restore clock, CRNG and UTC timezone before executing the same guest verifier.

The original snapshot bind mount still refers to the old empty inode. The
experimental PATCH names a different, sandbox-owned file visible in the VMM's
private mount namespace. That standalone implementation is confined to the
harness; unlike the integrated candidate above, it does not update Runner's
cache-promotion ownership or active-image path contract.
Every VM is stopped and destroyed after its one trial. No trial enters an idle
pool or promotes its image into a cache.

Ordinary unmount must succeed before replacement. Terminal workspace freeze,
lazy unmount and forced unmount are not used. The dirty-old-image control checks
that completed old writes and old sentinels do not appear in the replacement.
That control does not prove safety for arbitrary concurrent guest I/O.

## Historical backend reproduction

Use a separately authorized Linux KVM host with root, the backend's documented
network/NBD prerequisites, Python 3.11+, e2fsprogs and coreutils. Reserve capacity
for at most two 2-vCPU/4-GiB VMs, one 4-GiB snapshot and copied image artifacts.
Use a new owner-only study directory. Record existing service/process/resource
inventories before and after; do not stop other services or use live workspace
cache entries.

Build the harness and bundled guest binaries from one revision. Optimized guest
builds are required: debug Guest binaries use a different identity path.

```sh
cargo build --manifest-path crates/Cargo.toml --profile ci -j 1 \
  -p guest-init -p guest-workspace-mount -p guest-state-restore
cargo build --manifest-path crates/Cargo.toml --profile ci -j 1 \
  -p sandbox-firecracker --example workspace_handoff
```

Transfer those outputs and the preparation script through the authorized host
file-transfer interface. The preparation script copies a generic rootfs into a
new directory, installs and verifies the three exact Guest binaries, and builds
a synthetic fixture. Supply absolute paths to fixed, verified artifacts:

```sh
sudo python3 workspace_handoff_prepare.py /absolute/new-study-directory \
  --rootfs /absolute/rootfs.ext4 --kernel /absolute/vmlinux \
  --firecracker /absolute/firecracker --guest-bin-dir /absolute/guest-binaries \
  --source-revision FULL_SOURCE_COMMIT
```

Record the harness hash alongside `artifacts.json`. Each command emits JSONL;
retain stdout, stderr and exit status in new files rather than overwriting an
earlier attempt. Blocks must be unique. Never automatically repeat an uncertain
remote command: inspect owned resources and the existing receipt first.

```sh
sudo ./workspace_handoff /absolute/new-study-directory snapshot setup 1
sudo ./workspace_handoff /absolute/new-study-directory paired preflight 1
sudo ./workspace_handoff /absolute/new-study-directory controls first 1
sudo ./workspace_handoff /absolute/new-study-directory paired cohort1 8
sudo ./workspace_handoff /absolute/new-study-directory paired cohort2 8
sudo ./workspace_handoff /absolute/new-study-directory concurrent cohort1 4
sudo ./workspace_handoff /absolute/new-study-directory concurrent cohort2 4
```

The harness uses existing runtime/factory ownership and always awaits stop,
destroy, factory shutdown and runtime shutdown after an activation error. An
activation timeout drops the operation before terminal cleanup. Abrupt harness
termination, host failure and integrated Runner cancellation/drain require
separate recovery validation; a successful exit does not substitute for the
external cleanup audit. Preserve the owned UUIDs from `allocated` records and
check their process, socket and workspace absence.

Snapshot restore recreates an empty shared `vsock` bind target at
`/run/vm0/sock/<snapshot-id>/vsock`. After all study processes and mounts are
gone, remove that owned empty directory and its empty parent with `rmdir`.
Do not recursively remove unexpected contents. The copied snapshot and image
artifacts can remain in the study directory for evidence and reproduction.

## Historical backend measurement interpretation

- `ready_ms`: fresh create through required mount/state restore, or Blank unpark
  through unmount/replacement/remount/state restore. Fixture-copy work occurs
  before either interval; no production cache checkout is measured.
- Concurrent trials rendezvous before fresh creation or after both Blanks have
  parked, so one candidate's activation is not measured against the other's
  prewarming work. The rendezvous has a bounded deadline and is outside timing.
- `activation_verified_ms`: the same interval plus a completed real guest
  verifier process and result comparison. This is not the exact process-spawn
  timestamp and includes reading/hashing the fixture.
- `prewarm_ms`: Blank construction through park, outside activation. It is a
  real resource cost and must not disappear from an inventory-level decision.
- The fixture checks 128 small files, one 32-MiB file, an empty file, a run
  identity file, a directory, hardlink identity and a relative symlink. It checks
  hashes, size, mode, UID/GID and whole-second mtime. ACLs, xattrs and nanosecond
  timestamp preservation are outside this fixture.
- Controls named `cancel-*` inject an owner abort at a completed transition;
  they are not claims of racing a live Firecracker request with Runner shutdown.
- VMM `/proc` snapshots describe that process. They do not measure all Host
  CPU, cgroup pressure, Runner admission or pool opportunity cost.
- After timed verification, the harness reads back the VMM machine profile and
  both drive/network limiters, and verifies the guest workspace device size.

The primary performance target is `api_to_spawn`, ending at Agent shell spawn.
Runner computes it from `ExecutionContext.api_start_time` and the recorded
`shell_started_at` in `record_api_startup_boundaries`; see
[Agent Start Timing](./runner-guest-process-lifecycle.md#agent-start-timing).
It excludes the team run-concurrency queue but includes the post-admission
durable Runner queue. Required work must remain before its existing spawn
boundary. `api_to_agent_ready` and workload completion are separate metrics.

The original study applied its 20-ms/10% benefit and tail screen to activation
through verifier completion. That was the wrong endpoint for the startup
decision. Following the user's metric clarification, that interpretation is
superseded: `ready_ms` is a promising component measurement; neither it nor
`activation_verified_ms` measures `api_to_spawn`. The verifier remains a content
correctness check and a separate post-spawn workload diagnostic. Its runtime
must not be included in startup latency or used to conclude that startup is
slower. Keep cohorts separate, use nearest-rank percentiles, preserve outliers,
and do not add independently ranked stage percentiles.

## Historical backend evidence

### Decision: proceed to api_to_spawn validation

The backing-drive replacement primitive worked on the tested artifact. Every
formal trial preserved the synthetic manifest, and all eight control scenarios
reached their expected outcomes with terminal cleanup. The measured startup
preparation component improved by a paired median 85–112 ms, with lower observed
p90 in all four final cohorts. This supports continuing the candidate's startup
evaluation. It does not establish the magnitude or sign of a full
`api_to_spawn` change, which the standalone harness did not measure.

Both single-VM cohorts took longer through the completed verifier workload,
and all four cohorts had a worse observed p90 for that separate endpoint.
Those observations remain in the report but do not reject the startup candidate.
The previous "performance screen failed" conclusion confused these endpoints
and is withdrawn. Production admission remains unchanged because the integrated
candidate is default-disabled and production acceptance remains incomplete;
#34729 remains open. These backend results are not a measured `api_to_spawn`
regression.

### Fixed artifacts and conditions

The final matrix ran on local-11 on September 17, 2026, from 03:52:55 to
03:54:04 UTC, after build activity had finished. It used Firecracker v1.16.2,
kernel 6.18.44 and Rust 1.98.1. Backend and optimized Guest source came from
`a2fcba980a4a92c72678d031d9c85e4154b0bc09`; the experimental example's exact source
and executable hashes are below. Every measured VM had 2 vCPUs, 4096 MiB RAM
and a 10240-MiB workspace. Both drives had 50 MiB/s and 5000 IOPS each, while
network RX/TX each had 50 MiB/s. Readback verified those settings after each
successful trial. The configured 256-MiB balloon was the same in both arms.

The host ran its four existing Runner services throughout. This was a bounded
two-VM contention check on a shared host, not a saturation benchmark. Each
cohort had eight samples per arm: eight alternating pairs for single-VM work,
or four alternating batches of two simultaneous VMs per arm. Blanks were used
immediately after prewarming; prolonged idle residency was not evaluated.
Fixtures were copied before activation and used no live tenant data. Host
filesystem caches were not dropped.

Raw JSONL, command receipts, stderr, artifact identities and before/after
inventories are retained on the authorized host under
`/home/ubuntu/codex-work/issue-34729-handoff-20260917/`; the complete archive is
`evidence-final2.zip`.

| Artifact                                              | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| Experimental Rust source                              | `d7bd6dd134a562d9690ac461a71b41c9bf9ba5b48bf992f40ab148eabf94e144` |
| Optimized harness executable                          | `6e08d6ff7d84cab0d902988f54bbb517ef8bbb5447abd9fa84ec8620fe5b628d` |
| Firecracker                                           | `8227875ceda44177a4d501052dae4a2f9d7837362f5399f02cf0748e68418377` |
| Kernel                                                | `d8ced68bd61e27b6813e2c993cc53a4029c59e13210672180591c84109684fe4` |
| Rootfs with exact Guest binaries                      | `1dc8ca212d36c2d8b49aef6d283393c199c2975b257e86802556099bae59921a` |
| Fixture ext4                                          | `fdf86cb8060189978fa398db4df28d2d54ec711ededda95690c37b0d7da0a78c` |
| Expected manifest                                     | `a03063b67a36a15b09769c6d1d40c677c78f1ce341bf00c3236d24b054ef2615` |
| Complete evidence archive, including earlier attempts | `f18f5207effa55f784e884b2bf0363a0a529d945caf735afba57a52b159fe74d` |

### Component startup and separate workload results

[All 128 measured samples](./workspace-handoff-results.csv) retain complete
intervals, individual stages and VMM CPU/RSS. The tables below use only the
64 final-version samples, identified by `final1` and `final2`; the earlier
`cohort1`/`cohort2` samples remain separate. Times below are milliseconds;
p50/p90 use nearest rank. With only eight samples per arm, p90 is also the
observed maximum, not a population tail estimate. No outlier was removed.

| Cohort      | Arm   | Ready p50 / p90 | Activation through verifier p50 / p90 |
| ----------- | ----- | --------------: | ------------------------------------: |
| Single VM 1 | Fresh |   133.1 / 142.3 |                       1084.8 / 1190.7 |
| Single VM 1 | Blank |     41.7 / 47.1 |                       1187.1 / 1283.5 |
| Single VM 2 | Fresh |   127.0 / 145.9 |                       1110.6 / 1178.6 |
| Single VM 2 | Blank |     41.5 / 45.2 |                       1272.8 / 1293.7 |
| Two VMs 1   | Fresh |   155.4 / 172.2 |                       1221.0 / 1232.8 |
| Two VMs 1   | Blank |     48.3 / 52.6 |                       1182.1 / 1297.0 |
| Two VMs 2   | Fresh |   155.5 / 169.0 |                       1132.1 / 1224.5 |
| Two VMs 2   | Blank |     48.4 / 55.3 |                       1191.3 / 1308.2 |

Matched differences use `fresh - blank` for each round/member, then the
arithmetic median of those differences. Positive values favor Blank; this is
not subtraction of independently ranked percentiles.

| Cohort      | Median ready gain | Median gain through verifier | Matched workload wins |
| ----------- | ----------------: | ---------------------------: | --------------------: |
| Single VM 1 |   94.3 ms (69.2%) |           -130.7 ms (-11.9%) |                 2 / 8 |
| Single VM 2 |   84.8 ms (67.2%) |           -127.2 ms (-11.3%) |                 1 / 8 |
| Two VMs 1   |  111.6 ms (69.8%) |             -13.8 ms (-1.0%) |                 4 / 8 |
| Two VMs 2   |  107.9 ms (69.1%) |             -28.8 ms (-2.5%) |                 3 / 8 |

The verifier's workload includes hashing a 32-MiB file and all small files under
the unchanged block limits. Its p50 was 946/965 ms for Fresh versus 1143/1229 ms
for Blank in the single-VM cohorts. The measurements locate the lost benefit in
that interval but do not establish the cause. Limiter state, guest I/O behavior
and cache effects need a controlled follow-up before attributing the difference.
Resetting limits or inserting idle time would change this experiment and is not
part of the reported result.

Blank prewarming itself cost p50/p90 151/159 and 150/156 ms in single-VM cohorts,
and 176/184 and 172/186 ms in concurrent cohorts. It is outside activation.
VMM lifetime CPU p50 was 570–670 ms for Fresh and 610–650 ms for Blank, including
Blank prewarming. End-of-trial RSS p50 was 113.6–113.7 MiB for Fresh and
115.0–115.2 MiB for Blank; maximum observed RSS was 114.7 and 116.8 MiB,
respectively. These process figures exclude the host's snapshot page cache,
NBD workers, Runner and memory reservation cost, so they cannot establish a
pool-level memory or capacity benefit.

### Correctness, controls and cleanup

The 64 formal samples had zero content/metadata mismatches, unexpected
activation failures or per-VM cleanup failures. All 134 manifest entries matched,
including hardlink identity. Both final preflight arms also passed. The eight
controls ran separately from the performance cohorts:

| Control                              | Observed outcome                                                       |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Dirty old image and old-run sentinel | Ordinary unmount completed; new manifest matched; old files absent     |
| Guest process holds workspace as cwd | Ordinary unmount rejected the busy mount; handoff passed after release |
| Missing replacement image            | Firecracker rejected PATCH with HTTP 400; VM destroyed                 |
| Invalid filesystem                   | PATCH succeeded, native mount rejected the filesystem; VM destroyed    |
| Owner abort before unmount           | VM destroyed                                                           |
| Owner abort after unmount            | VM destroyed                                                           |
| Owner abort after PATCH              | VM destroyed                                                           |
| Owner abort after remount            | VM destroyed                                                           |

Raw `ok: false` on the six expected-error controls describes the injected
activation error; the command succeeded only after matching the expected error
and completing cleanup. Controls do not contribute to performance percentiles.

The external audit covered all 159 allocated trial VMs, including earlier
preflights and control attempts. All 159 recorded successful stop and removal of
their process, runtime socket directory and workspace. The initial audit found
only the backend-created empty snapshot bind directories described above; they
were inspected and removed with `rmdir`. A second audit found no owned process
or runtime path residue. The four pre-existing Runner MainPIDs and activation
timestamps were unchanged. Retained copied images and raw evidence are study
artifacts, not reusable inventory.

Earlier attempts are retained separately: the initial backend preflight and
controls passed, while a later configuration-readback preflight failed because
the checker omitted Firecracker's explicit null limiter fields. Correcting that
comparison produced the first fixed harness. Its 03:43:35–03:44:44 UTC matrix
also showed faster startup preparation and mixed workload completion results.
Its paired workload gains were -186.1 and
-99.7 ms for single-VM cohorts, and +80.2 and -2.6 ms for concurrent cohorts;
all four observed p90s regressed. The executable hash was
`763cf6fa9caadc41b01e0c5ac4766f334de897eba9b102a9d89877b554145d69` and source hash
was `d843a24264321a08ab66a905c5438b5243f95550da90eb0b75c89aac52520e19`.

Clippy then required replacing generic JSON indexing with typed object writes.
The final version passed Clippy and repeated the entire matrix and all controls.
Its results above are not pooled with earlier samples. The affected crate's
903 unit tests and five integration tests passed; two existing opt-in integration
tests stayed ignored. Formatting and documentation compilation passed. The
generic preparation script also ran independently and reproduced the exact
expected manifest, verifying the embedded Guest binaries by hash.

### Remaining acceptance boundaries

The historical standalone study did not exercise Runner cache checkout/promotion,
tenant transitions,
the actual production rootfs and payload, production DNS/proxy readiness,
Exact/Blank admission precedence, prolonged Blank residency, pool opportunity
cost, shutdown/drain races, abrupt host failure or an ambiguous in-flight PATCH
response. Its owner-abort controls are completed-transition failures, not
integrated cancellation proof. The dirty-image control is not arbitrary
in-flight-I/O proof. The configured guest identity/profile was fixed throughout;
cross-tenant safety remains unproven.

The integrated startup experiment runs matched baseline and candidate requests
through an isolated API/Runner path on an authorized host such as local-11.
Capture the genuine API start and Agent shell-spawn boundary for each run; do
not substitute a synthetic API timestamp or generic verifier process completion.
Use the existing `record_api_startup_boundaries` telemetry and join by `run_id`,
with fixed API/Runner/Guest artifacts, matched workspace manifests and resource
limits. Record complete, missing and failed-run counts and compare per-run
`api_to_spawn` distributions. Include the candidate's real unmount, replacement,
remount, required state/identity/device validation, DNS/proxy readiness and
required private-file writes before shell spawn. Preserve Exact precedence and
capacity/admission budgets; do not move required work past the timing boundary.

The default-disabled integration above supplies that Runner path; the historical
CSV cannot reconstruct its measurements. Its ownership, cancellation and cache
promotion coverage does not establish arbitrary cross-tenant or host-failure
safety. Keep content equality and ownership,
cancellation/drain and cleanup checks as correctness gates. Report post-spawn
I/O, Agent readiness and Blank pool opportunity cost separately, without
renaming any of them `api_to_spawn` or using verifier completion as its proxy.
