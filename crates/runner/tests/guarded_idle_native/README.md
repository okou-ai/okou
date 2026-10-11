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
does not. It repeats with fresh boot and the matching prepared snapshot.

The fixture captures backing while the parked candidate is exclusively owned,
then enters the real Lifecycle inventory and Supervisor retirement API. Both
memory allowances are granted while the entry remains in the pool. Only a
matching insertion can be detached and transferred to accepted physical cleanup.

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
