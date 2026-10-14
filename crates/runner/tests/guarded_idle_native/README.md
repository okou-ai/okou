# Guarded idle terminal fixture

## Ordinary verification

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host -p runner-lifecycle -p runner-supervisor -p runner \
  -- --test-threads=1
```

The external-boundary tests use real home-image bytes, procfs-format file reads,
an owned child process, blocked kernel I/O and gated provider completions. They
exercise refusal, grant cancellation, missing/failed/lost backing, preparation
and teardown panic, parallel progress, dropped receivers and shutdown ownership.

## Packaged Firecracker fixture setup

The ignored Linux test `guarded_terminal_saving_restores_home_without_private_runtime_bytes`
is executable on a root-owned KVM/NBD test host with current packaged guest
artifacts. It physically parks a Firecracker sandbox, runs terminal private
preparation and freeze, waits for exact backing exit, publishes home, tears down
the factory-owned sandbox, and restores the saved home into another sandbox.
It verifies ordinary bytes survive and the previous private runtime directory
does not. It repeats exact-prune, all-inventory drain/shutdown batches and logical
substitution, atomic park replacement, reserved restore over blank inventory and
aged exact-to-blank replenishment with fresh boot and the matching prepared
snapshot (twenty-six owned cases, including independent job-free pressure,
caller-owned cancellation before
business activation, speculative guest restore failure, and cancelled parked
and fenced running finalizing deliveries).

The fixture captures backing while the parked candidate is exclusively owned,
then enters the real Lifecycle inventory and tracked Supervisor batch API. Both
memory allowances are granted while the entry remains in the pool. Only a
matching insertion can be detached and transferred to accepted physical cleanup.
The fixed original selection never adopts later inventory. Admission refusals,
accepted uncertainty and status-publication failure all fail native acceptance;
each completed full logical lease is released by its independent batch owner.

Logical substitution transfers the complete lease without joining old exit. A
replacement Fresh preparation allowance is granted in the same P2 authority,
and a different guest is prepared before joining old cleanup. The original
required export is then checked through restored home bytes. Ordinary gated
owner tests establish live overlap; the native seam does not impose an old-exit
startup barrier or use logical removal as physical credit.

Replacement and restore enter the concrete borrowed incoming-owner transaction;
both original and incoming physical guests exist under the same host authority.
The replacement's prior exact owner requires real home export. Restore displaces
a tenant-free blank and then retires the restored exact owner through a guarded
batch, verifying its required home too. Aged replenishment drives the real
background component with an explicitly aged insertion and wraps new blank
preparation in a supplied Fresh operation. Its final park uses guarded acceptance.
Each scenario finishes its remaining pool inventory through the guarded batch.
These component seams do not activate the production composition root.

Optional ordinary and aged cases enter `maybe_start_optional` with mandatory
current pressure, the original P2 authority, positive Fresh preparation coverage,
provider creation custody and the original full logical lease. Both share their
pressure controller and global start cadence with a real snapshot prefetch.
The aged case retains the original required home saving independently of its
foreground-preemptible logical lease; both retire final inventory through covered
required cleanup.
Prefetch, blank preparation and pressure producers join before factory teardown.

These cases additionally require `OKOU_TEST_OPTIONAL_MEMORY_POLICY` to name a
separate JSON file with `snapshot_path`, `snapshot_memory_mb` and
`prefetch_overhead_bytes`. Supply an actual snapshot memory file and measured
positive bounds; the overhead must cover at least the retained read buffer.
The existing `replacement_preparation_bytes` supplies the new guest's Fresh
preparation envelope. This seam requires real Ready pressure and headroom,
and rejects missing inputs, unknown pressure and incomplete reads. Ordinary
verification compiles it; native execution and the complete combined P3d
acceptance remain separate.

Caller-owned saving removes an ordinary exact reservation from inventory and
uses the borrowed `IdleActivationOwner`/tracked Supervisor entry after successor
cancellation before activation. Required preparation and freeze run under both
supplied allowances; exact backing exit, publication and factory tail must all
complete. No-progress owners remain separately retained through joined shutdown.
The original full logical lease is explicitly recovered for release only after
the cancelled caller's physical cleanup completes; a lost observer retains it.
This native seam proves required saving for that caller state; mocked partial
unpark/cancellation/panic regressions are separate, and the complete native dirty
activation/session/history corpus remains P3d.

Speculative saving unparks an exact reservation and invokes the real Executor
guest restore with a deliberately absent required timezone, before any business
process. It verifies the specific unavailable-timezone error before cleanup.
The failed preparation retains its original promotion/private context,
backing generation and full lease, then enters the same required covered cleanup.
Both fresh and snapshot modes verify saved ordinary home bytes and removal of
the predecessor private runtime. This fixture does not wire production policy or
replace the broader P3d session/history corpus.

Finalizing saving uses the real `IdleParkRequest` transition and exact
`ActiveRuns` broker. The parked case completes physical park; the running case
requests handoff before balloon submission and requires the provider's fenced
running result. Both carry the original backing proof through
`GuardedFinalizingOffer` and recover queued delivery on successor cancellation
in `GuardedFinalizingAdmission`. Required covered preparation, freeze, exact
exit, publication and factory tail must complete before release of the full
logical lease. Fresh and snapshot restores verify ordinary bytes and absence of
the predecessor private runtime. The native seam carries a local fixture claim;
ordinary provider-boundary tests verify preservation of real returned completion
authorization. This opt-in fixture is compiled by ordinary checks and requires
separate execution on the specified KVM/NBD host to establish native acceptance.

An accepted aged conversion transfers its full logical lease separately from
physical cleanup. Before blank creation it joins old cleanup; foreground
preemption releases that lease and the background CPU permit immediately even
when status or old teardown is held. Physical coverage and shutdown ownership
remain with the tracker, so logical release never predicts memory relief.

Supply `OKOU_TEST_RPC_BASE_DIR` as a disposable directory, plus
`OKOU_TEST_RPC_FIRECRACKER`, `OKOU_TEST_RPC_KERNEL`, `OKOU_TEST_RPC_ROOTFS`,
`OKOU_TEST_RPC_SNAPSHOT_DIR`, `OKOU_TEST_RPC_SNAPSHOT_HASH` and
`OKOU_TEST_IDLE_ROOTFS_HASH` from the matching artifact preparation. Each mode
creates its own temporary Runner workspace/cache below that base and shuts down
its own factory/runtime. No production Runner directory should be used.

`OKOU_TEST_IDLE_MEMORY_POLICY` must name a JSON file containing these required
current test-host measurements and limits (no defaults): `host_total_bytes`,
`operating_floor_bytes`, `cleanup_reserve_bytes`, `critical_available_bytes`,
`recovery_available_bytes`, `live_growth_bytes`, `tail_growth_bytes`,
`replacement_preparation_bytes`,
`max_sample_age_millis`, `max_operations`, `max_cleanup_inflight`. The guest shape
matches the packaged `vm0/default` fixture: two vCPUs, 4096 MiB, 16384 MiB home.
The host observation is a real fresh `/proc/meminfo` read. Arithmetic validation
does not prove calibration or OOM safety. The test must have actual headroom;
rejected admission fails the test and uses the existing fixture cleanup path.

The pressure cases additionally require `pressure_sample_period_millis`,
`pressure_recovery_sustain_millis`, `pressure_wave_cooldown_millis`,
`pressure_optional_start_interval_millis` and `pressure_max_wave_entries` in the
same JSON file. All must be positive. They use the same P2 policy and real fresh
reader, and require an actual critical sample with enough covered cleanup
headroom on this disposable test host. Absent pressure, refused grants and
uncertain outcomes fail acceptance; the fixture does not manufacture pressure
or start business work. Shutdown joins sampling and accepted saving before
factory/runtime teardown. These two seams do not activate production policy or
replace the combined native pressure/session/history corpus in P3d.

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner --test guarded_idle_native \
  guarded_terminal_saving_restores_home_without_private_runtime_bytes \
  -- --ignored --exact --nocapture
```

Ordinary CI compiles this fixture but does not execute its ignored native test.
Compilation or mocked proof does not establish native execution, real host
capacity savings, restored session/history correctness, or the parent P3d corpus.

## Measured terminal corpus

`native_terminal_corpus_records_data_and_phase_ownership` selects twelve cases:
exact and all-inventory retirement, caller-owned cancellation, speculative guest
restore failure, and parked/running finalizing cancellation, each with fresh boot
and the matching snapshot. It preserves the complete older fixture above.
Every case writes a 64 KiB home payload containing its original run identity,
saves it through the real owner, restores and verifies its digest, and checks
removal of the predecessor private runtime.

Compile this test with `OKOU_TEST_BUILD_SOURCE_SHA` set to the exact checked-out
commit. Prepare an immutable copy of the matching rootfs, kernel and Firecracker
under a new experiment root; never use an existing Runner workspace. The ignored
`prepare_native_terminal_snapshot` test creates a new matching snapshot directory
using these explicit inputs. Supply a new invocation-owned snapshot ID in
`OKOU_TEST_RPC_SNAPSHOT_HASH` before preparation and retain that exact value for
restore. The provider encodes this ID into the vsock bind path; replacing it with
a digest of the resulting files creates an incompatible restore path. File
digests are recorded separately. The fixture also requires
`OKOU_TEST_IDLE_ROOTFS_HASH`.
The rootfs must contain the current Guest programs and initialization settings.
An older packaged Guest can boot while failing the current control handshake;
prepare the image through the existing source-derived Guest build and rootfs
customization flow rather than relaxing the connection or data checks.

Select the executable from Cargo's `compiler-artifact` JSON for the
`guarded_idle_native` target with `profile.test` set, requiring exactly one
non-null executable. A dependency/profile change can change the executable's
filename; never reuse a previous filename or hash a different test binary.
For large rootfs and snapshot files, compile with
`--config 'profile.local.package.sha2.opt-level=3'` so their cryptographic
preflight fits the bounded collector's workload. Record that build option in the
experiment metadata; it does not establish a calibrated memory envelope.

`OKOU_TEST_TERMINAL_ARTIFACTS` names a JSON object with `source_sha`,
`test_binary_sha256`, `firecracker_sha256`, `kernel_sha256`, `rootfs_sha256`, `snapshot_id`,
`snapshot_files` (filename to SHA-256) and `policy_sha256`. All hashes are lower-case
hexadecimal. The test verifies the compiled source value and hashes its actual
executable and supplied artifacts before starting a VM. Preserve the source
checkout and build log alongside the manifest; the compiled value is not a
signature proving where a rootfs was produced.

The measured factory adds an explicit **fixture** post-exit tail: it writes and
syncs 64 MiB in 1 MiB chunks, then reads and verifies every byte. The original full
logical lease must remain allocated throughout that accepted blocking IO. This
work belongs to the factory's joined physical tracker; it is not a calibration of
production teardown. `tail_growth_bytes` must cover at least the complete 64 MiB
file and 1 MiB buffer. All supplied policy bounds are test limits, and observations
below them do not establish a production upper envelope or OOM protection.

Each receipt records Linux monotonic and wall clocks, the original sandbox and
backing generation, a positive owned backing wait, physical-tail completion and
the restored data result. Case directories are removed only after success and
dependency shutdown. Failed cases preserve their directories and never emit a
completion receipt. Native admission, saving, teardown or data failures must be
investigated; forced cleanup cannot substitute for native success.

Run the exact test through the repository's bounded
[P1 collector](../../../../.github/scripts/runner-memory-calibrate.md), using
an owned driver that supplies these non-secret fixture inputs before executing
the native test binary. P1 deliberately removes the caller's environment. Put
`native_terminal_artifacts` in its metadata, containing the manifest plus
`profile: {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384}` and
`required_fixture_tail_bytes: 67108864`.
The owned driver must also explicitly supply the standard system-tool PATH,
including `/usr/sbin` and `/sbin` for the provider's iptables, conntrack and sysctl
prerequisites. Keep the collector's environment isolation intact; do not inherit
the caller's credentials or substitute fake provider commands.

```sh
"$OWNED_NATIVE_TEST_BINARY" \
  native_terminal_corpus_records_data_and_phase_ownership \
  --ignored --exact --nocapture --test-threads=1

python3 crates/runner/tests/guarded_idle_native/report.py "$P1_OUTPUT_DIRECTORY"
```

The report requires all twelve cases, stable original identities, every phase
and actual samples in both live saving and the added required fixture IO. The
total post-exit window also includes publication and teardown before the added
tail starts. It reports
RSS/PSS **lower bounds**, sample/read age and host availability. Missing process
residency stays unknown; a missing phase/window fails validation. P1's generic
`calibrated` and `native_vm_exit_confirmed` flags remain false. Complete
session/history continuation, combined pressure/foreground/optional work and
native cancellation races remain the separate parent acceptance gate.

Ordinary `cargo test -p runner --test guarded_idle_native` executes the report
consumer's real-file regressions through Python 3 and compiles the opt-in native
tests. The report regressions do not substitute for executing KVM/NBD cases.
The ordinary provider-boundary refusal test also drives actual finalizing park
with controlled external park errors, an unexpected parked return and an
unexpected running handoff point. It verifies the original file bytes and cache
lock remain owned, the complete logical lease stays allocated and no destruction
occurs until explicit disposal of the ordinary mock fixture.
