# Cached Workspace handoff to a prewarmed Blank

Tracking: [#34729](https://github.com/vm0-ai/okou/issues/34729), under
[#24203](https://github.com/vm0-ai/okou/issues/24203).

This opt-in KVM study evaluates a cached workspace disk on an already-started,
never-assigned Blank. The production admission path remains unchanged. A backend
activation measurement does not establish an improvement in `api_to_spawn` or
the opportunity cost of taking a Blank from other admitted work.

## Lifecycle being evaluated

The fresh arm creates a snapshot-restored VM with an exclusively owned synthetic
workspace seed. The Blank arm creates and mounts an empty disk, parks the VM,
then starts its measured interval before unpark. It performs an ordinary guest
unmount, `blockdev --flushbufs`, transfers the owned seed into the sandbox's
workspace directory, patches the existing Firecracker `workspace` drive to that
absolute path, and remounts through the native workspace helper. Both arms
restore clock, CRNG and UTC timezone before executing the same guest verifier.

The original snapshot bind mount still refers to the old empty inode. The
experimental PATCH names a different, sandbox-owned file visible in the VMM's
private mount namespace. This is deliberately confined to the harness; it does
not update Runner's cache-promotion ownership or active-image path contract.
Every VM is stopped and destroyed after its one trial. No trial enters an idle
pool or promotes its image into a cache.

Ordinary unmount must succeed before replacement. Terminal workspace freeze,
lazy unmount and forced unmount are not used. The dirty-old-image control checks
that completed old writes and old sentinels do not appear in the replacement.
That control does not prove safety for arbitrary concurrent guest I/O.

## Reproduction

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

## Measurement interpretation

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

The predefined backend screen requires no content/metadata/leakage/cleanup
failure, repeated paired median benefit of at least 20 ms and 10%, and no
repeatable p90 regression or disproportionate resource growth. A pass supports
further integrated validation only. A failed or incomplete screen leaves the
production policy unchanged. Keep cohorts separate, use nearest-rank
percentiles, preserve outliers, and do not add independently ranked stage
percentiles.

## Evidence

### Decision: retain the current production policy

The backing-drive replacement primitive worked on the tested artifact. Every
formal trial preserved the synthetic manifest, and all eight control scenarios
reached their expected outcomes with terminal cleanup. However, the predefined
performance screen failed: the shorter mount/state-restore boundary did not
produce a repeated improvement through the completed guest workload. Both
single-VM cohorts regressed, and all four cohorts had a worse observed p90 for
that complete interval. This result does not justify enabling Workspace hits on
Blanks. #34729 remains open for the unproven lifecycle and admission criteria.

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

### Performance results

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
also failed the performance screen. Its paired workload gains were -186.1 and
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

The study does not exercise Runner cache checkout/promotion, tenant transitions,
the actual production rootfs and payload, production DNS/proxy readiness,
Exact/Blank admission precedence, prolonged Blank residency, pool opportunity
cost, shutdown/drain races, abrupt host failure or an ambiguous in-flight PATCH
response. Its owner-abort controls are completed-transition failures, not
integrated cancellation proof. The dirty-image control is not arbitrary
in-flight-I/O proof. The configured guest identity/profile was fixed throughout;
cross-tenant safety remains unproven.

Any production proposal must first explain the observed workload regression,
then establish those ownership/readiness boundaries and measure actual
`api_to_spawn` plus failure/tail behavior under the existing admission budgets.
