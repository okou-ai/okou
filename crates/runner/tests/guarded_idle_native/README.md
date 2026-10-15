# Guarded idle terminal fixture

## Critical multiwave suppression

`native_critical_records_bounded_waves_and_suppressed_snapshot_reads` runs fresh
and matching snapshot factories with one original exact Guest and two newly
prepared tenant-free blanks. All share the original P2 authority and full logical
leases, with capacity for a fitting spare profile. Set the supplied policy's
`pressure_max_wave_entries` to one and provide actual host headroom classified
Critical by its explicit watermark; the fixture never changes host availability.
Supply the optional JSON input described below with the original immutable
4 GiB `memory.bin` and a positive overhead covering its retained read buffer.

The real guarded runtime reader is armed under initial Unknown. Three distinct
single-entry pressure waves must finish without refusal, skip or uncertainty,
while the pending reader reports zero accepted operations or bytes throughout.
Each wave must receive a new actual Critical read after its completion is
observed; the controller's deliberate post-wave Unknown state cannot supply it.
The independent sampler records actual `/proc` clocks and availability. Both
additional original backing generations must positively exit; the original exact
home retains its full lease through the required durable 64 MiB tail and restores
every byte of its 64 KiB payload. Cancellation drains the pending reader, then
joins the controller and sampler before P2/tracker/factory teardown. All failed
case directories and raw evidence remain available for diagnosis.

Use the exact-source binary, manifest, packaged inputs and bounded P1 invocation
below, selecting this test by its exact name. Metadata additionally requires
`native_critical_policy_json`, `native_critical_inputs_json` (the exact UTF-8 input
files) and `native_critical_snapshot_bytes` (4294967296). Then validate:

```sh
python3 crates/runner/tests/guarded_idle_native/critical_report.py "$P1_OUTPUT_DIRECTORY"
```

Ordinary Cargo/default Crates CI runs the real-file/CLI refusal regressions through
`native_critical_report_requires_bounded_waves_and_suppressed_reads`; the actual
KVM/NBD entry remains explicitly ignored. The report proves supplied Critical
classification and bounded cleanup, not numerical host shortage, physical RAM
relief, cold-cache behavior or OOM protection. Startup/foreground/heartbeat and
accepted provider/read cancellation or late-result composition remain separate
acceptance; unknown template producer, complete residency and calibrated envelopes
are still unverified.

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

## Separately measured pressure paths

`native_policy_pressure_records_saving_and_free_logical_capacity` selects the
job-free independent pressure owner in fresh and snapshot modes. It requires an
actual fresh Proc/P2 observation at or below the supplied Critical watermark,
while its original full lease remains allocated and another complete profile
fits the logical budget. Its resolved one-entry wave and sampling/controller
shutdown have separate original-identity witnesses.

`native_logical_pressure_records_replacement_and_required_saving` selects logical
substitution in both modes. It requires exhausted logical capacity and actual
availability above the recovery watermark and the full profile/preparation plus
protected bounds. A different Guest must complete accepted preparation through
the same authority before original retirement joins are requested. This ordering
does not assert that old physical exit remains pending or impose an exit barrier.

Use the same exact-source binary, immutable artifact manifest, matched snapshot
creation identity, disposable base and P1 driver requirements above. Each path
uses a separate supplied policy and new P1 output directory; do not manufacture
MemAvailable, induce host-wide pressure or alter existing business resources.
P1 metadata additionally requires `native_pressure_kind` (`physical` or `logical`)
and `native_pressure_policy_json` containing the exact UTF-8 policy file contents.
Its SHA-256 must equal `native_terminal_artifacts.policy_sha256`. Scenario receipts
must agree with those exact parsed bounds and contain valid actual read/age and
budget observations. Missing, stale or mismatched conditions fail acceptance.

```sh
"$OWNED_NATIVE_TEST_BINARY" \
  native_policy_pressure_records_saving_and_free_logical_capacity \
  --ignored --exact --nocapture --test-threads=1

"$OWNED_NATIVE_TEST_BINARY" \
  native_logical_pressure_records_replacement_and_required_saving \
  --ignored --exact --nocapture --test-threads=1

python3 crates/runner/tests/guarded_idle_native/pressure_report.py "$P1_OUTPUT_DIRECTORY"
```

Each report requires its complete two-mode corpus, original data/backing/full
lease/required IO and actual P1 windows, plus pressure or different-Guest/join
witnesses. The original twelve-case terminal report remains separate and strict.
Ordinary Cargo/default Crates CI runs the pressure report's real-file and CLI
regressions through its ordinary Rust wrapper; the native entries remain opt-in.

The physical label means observed policy classification under supplied disposable
test limits. It does not prove calibrated real-host shortage, RAM relief, a
production envelope or OOM protection. Residency unknowns remain lower bounds;
rootfs producer provenance, complete continuation, optional/foreground/recovery,
native races and parent numerical/aggregate acceptance remain separate gates.

## Complete native session/history continuation

`native_continuation_records_complete_session_history_and_required_saving`
selects ten cases: logical admission, replacement, reserved restore, aged
replenishment and nonzero terminal saving, each with fresh and snapshot factories.
It runs the public Executor and packaged mock Codex app-server against an owned
synthetic history/storage/finalization peer. Every byte of the original committed
JSONL and its canonical thread must survive native preparation/execution, final
metadata, export/freeze, original positive backing wait, saved-home continuation
and joined continued saving. The actual process checks the original full prefix
and 64 KiB home payload.

Nonzero execution must retain complete history/home data and withhold reusable
session identity, matching Executor's success-only finalization contract. Its
first successful continuation therefore restores the complete supplied history
without a prior cache history binding; that successful assignment must produce a
new verified identity. The next assignment must consume the resulting bound
history, and joined saving must preserve the final verified cache identity.

After saving the first continuation, a second Executor assignment reopens that
image and checks the entire continued history and original home again. Its own
fresh final identity goes through required saving, so validation preserves a
usable session/history binding in the final cache rather than promoting a
read-only assignment without an Agent identity.

Keep the existing artifact and supplied P2 policy environment. Additionally set
`USE_MOCK_CODEX=true` and `OKOU_TEST_NATIVE_API_HOST` to the authorized test host's
actual private IPv4 address reachable by its disposable Guests. The synthetic peer
uses no real model credentials. Missing input, verified final identity, matching
artifacts or safe headroom fails the native run.

The synthetic Agent request explicitly supplies the canonical Guest HOME with
its mock scenario/timestamp environment; the fixture does not assume an inherited
shell environment when the control server starts the Agent.

Select the exact ignored entry through bounded P1. Its metadata must contain
`native_continuation_policy_json` equal to the raw supplied policy file bytes.
Validate the resulting directory:

```bash
python3 crates/runner/tests/guarded_idle_native/continuation_report.py <p1-directory>
```

The strict report preserves original terminal phase/wait/tail requirements and
binds complete input/original/continued history and home hashes, distinct run and
Guest identities, actual policy/observation and final identity/cache/saving proof.
It rejects incomplete, duplicated, mixed, truncated, stale or mismatched evidence.
The original lease has a non-owning test-support witness which survives an atomic
one-for-one same-shape substitution. An unrelated reservation cannot replace it.
Production builds allocate no witness and change no memory policy or protocol.

Default Crates CI runs the ordinary Rust wrapper and ten real-file/CLI report
regressions, the resource-budget lifetime/transfer regressions, and the synthetic
peer's complete-history prepare/upload/completion round trip through its separate
Guest and loopback Host listeners. A separate peer regression requires rejection
as soon as a chunked request exceeds 4 MiB, before its terminating chunk or EOF;
the peer enforces this bound while reading, before buffering the complete request.
Actual KVM/NBD
cases remain ignored/opt-in and require separate submitted-source/binary/artifact
verification. Terminal12 and pressure4 contracts remain unchanged. The remaining
optional/recovery/full failure/race, provenance/residency/conservative-envelope,
parent aggregation and P4 activation gates remain #39997/#39998 and the parents.

## Guarded Ready optional preparation and snapshot reads

`native_optional_records_ready_preparation_prefetch_and_required_saving` selects
ordinary and aged optional preparation, each with fresh and snapshot factories.
It exercises the concrete blank/prefetch owners under one shared pressure and
P2 authority, verifies actual fresh Ready/headroom observations, and requires
successful preparation/publication and complete original snapshot reads. The
original home/backing/full logical lease and durable 64 MiB post-exit tail remain
required even while independent optional inventory exists. All accepted readers,
blank producers and pressure sampling join before inventory/factory teardown.
Final saving first joins the exact-home batch while its optional blank remains,
then joins the remaining inventory batch. Concurrent one-shot batch admissions
may correctly refuse stale accounting; such a refusal is never accepted as
completed saving or retried against replacement inventory by this corpus.

Use the existing packaged artifact and supplied P2 policy inputs. The separate
`OKOU_TEST_OPTIONAL_MEMORY_POLICY` JSON keeps the three fields `snapshot_path`,
`snapshot_memory_mb` and `prefetch_overhead_bytes`. Its snapshot must be the
original `memory.bin` in `OKOU_TEST_RPC_SNAPSHOT_DIR`, with the manifest's complete
SHA-256, positive complete byte length within the supplied memory shape, and
overhead covering at least the 1 MiB read buffer. Verification hashes the original
file; a positive partial read is insufficient. Preserve immutable inputs and
their original creation paths throughout native execution.

Select this exact ignored entry through bounded P1. Include these metadata fields:

- `native_optional_policy_json`: exact raw supplied P2 policy file text.
- `native_optional_inputs_json`: exact raw optional input file text.
- `native_optional_snapshot_bytes`: original `memory.bin` byte length.
- `native_terminal_artifacts`: the existing source/binary/kernel/Firecracker/
  rootfs/snapshot/policy/profile/tail manifest.

Validate the resulting files with:

```sh
python3 crates/runner/tests/guarded_idle_native/optional_report.py <p1-directory>
```

The strict four-case report requires ordered, original-generation input,
preparation, publication and producer-join witnesses in addition to all shared
terminal/P1 data, backing wait, tail and cleanup checks. Its eleven real-file/CLI
regressions run through a non-ignored Rust wrapper in default Crates CI. Actual
KVM/NBD execution remains opt-in and requires separate final-source proof.

This report establishes the guarded Ready component success contract. Startup
prefetch, fitting foreground/progress under contention, Critical/Unknown/stale
suppression, paced recovery and cancellation/late-result integration remain
#40173 under #39997. Full native failures and provenance/residency/envelopes remain
#39998 and the parents/P4. No calibrated RAM relief, OOM protection or production
composition-root activation follows from these supplied test-policy observations.

## Native observation gaps and recovery

For a bounded native run using the local profile, optimize the verification hash
dependency while retaining complete artifact and snapshot byte checks:

```sh
OKOU_TEST_BUILD_SOURCE_SHA="$(git rev-parse HEAD)" \
  cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  --config 'profile.local.package."sha2@0.11.0".opt-level=3' \
  -p runner --test guarded_idle_native --no-run --message-format=json
```

Record this package override and the returned compiler artifacts with the frozen
binary. Unoptimized hashing of complete rootfs/COW/memory inputs can exhaust the
P1 window before optional work starts. Keep the supplied P2 limits, full reads,
test assertions and collector guards when preparing the verification build.

`native_recovery_records_stale_revocation_and_paced_snapshot_reads` selects
`Recovery-fresh` and `Recovery-snapshot`. It delays the external observation
source before real `/proc/meminfo` reads, retaining the unchanged independent
pressure owner and original shared P2 authority. It never fabricates memory
availability or renews a cached observation's timestamp.

The corpus requires initial Unknown, fresh sustained recovery, a shared cadence
refusal after another real read, and an opportunity revoked across a real P2
admission wait until stale. A single fresh burst must expire with no runtime
read accepted; sustained recovery then permits two complete reads of separately
named, hash-verified immutable copies of the original packaged snapshot. The
source reopens before every shutdown, including failures, so accepted observation,
admission and prefetch owners are joined before required original home saving.
Original full-lease, positive backing wait and durable 64 MiB tail checks remain.
Copies live inside the measured case directory: failures preserve them, and only
full case success permits the outer owner to remove them with the other files.

Use the same `OKOU_TEST_OPTIONAL_MEMORY_POLICY` JSON as the Ready corpus, and
set a supplied optional interval longer than the actual stale admission wait plus
sustained recovery. The native source records actual read-start/completion clocks and costs.
Scheduling-offer cadence and observed physical acceptance clocks are distinct;
IO latency is not an exact scheduling timestamp or a performance measurement.
Input hashing and copying warm the file cache; this corpus does not establish
cold-cache IO or snapshot residency.

Include exact raw `native_recovery_policy_json`, `native_recovery_inputs_json`,
`native_recovery_snapshot_bytes` and the original `native_terminal_artifacts`
manifest in bounded P1 metadata. Validate with:

```sh
python3 crates/runner/tests/guarded_idle_native/recovery_report.py <p1-directory>
```

The report rejects missing/replayed/stale/short recovery, revived opportunities,
premature/partial reads and incomplete physical joins. Its real-file/CLI
regressions run through an ordinary Rust test in default CI. Actual KVM/NBD runs
still require separately verified committed source, binary and matching Guests,
rootfs and snapshot. Observation gaps do not establish numerical host shortage,
physical RAM relief, calibrated envelopes or production protection.

This is #40230 under #40173/#39997. #40231 retains Critical bounded-wave optional
suppression, startup readers, independent foreground/heartbeat progress and
Guest/provider/cancellation/late-result integration. #39998 and higher/P4 retain
full provenance, residency, envelope and activation gates; no parent closes here.
