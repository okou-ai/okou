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
snapshot (twenty owned cases, including caller-owned cancellation before
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

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner --test guarded_idle_native \
  guarded_terminal_saving_restores_home_without_private_runtime_bytes \
  -- --ignored --exact --nocapture
```

Ordinary CI compiles this fixture but does not execute its ignored native test.
Compilation or mocked proof does not establish native execution, real host
capacity savings, restored session/history correctness, or the parent P3d corpus.
