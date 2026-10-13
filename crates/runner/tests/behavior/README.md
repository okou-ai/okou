# Runner native behavior scenarios

These commands exercise Runner config, local execution and host lifecycle on a
provisioned metal host. Driver/remote-worker pairs and the agent-ready benchmark
belong to this suite; `runner-behavior-durable.sh` owns staging, bounded systemd
execution, reconnectable status and cleanup. Keep scenario logic with its owner.

Run a driver from the repository root, for example:

```bash
bash crates/runner/tests/behavior/runner-behavior-exec.sh
```

The Crates behavior lanes provide `METAL_USER`, `HOST`, `BIN_DIR`, `JOB_REF`,
immutable rootfs/snapshot hashes, the official Runner token environment, and
numeric `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`. Preserve those inherited inputs and
the SSH setup action's guarded transport. Manual runs require the same provisioned
host, captured binaries/images and authorization; command failure is a failed
scenario. Remote workers require their driver's arguments and durable owner and
are not standalone host setup commands.

The durable supervisor is also consumed by the
[sandbox native suite](../../../sandbox-firecracker/tests/native/). Their Cargo
test binary build/transport remains in the
[Runner CI adapter](../../../../.github/scripts/runner/runner-native-test-artifact.sh).
Do not substitute a mutable image or retry uncertain native execution.

From the repository root, run the local infrastructure regressions:

```bash
for test in crates/runner/tests/behavior/tests/*-test.sh; do
  bash "$test"
done
```

These regressions control external host/SSH/process boundaries; they do not
establish real metal results. The existing four CI script shards register them
by owner-relative path. Native lanes retain actual execution, resource and
failure/cancellation gates. Follow the
[testing guide](../../../../docs/runner/rust-testing.md) and
[script standard](../../../../docs/github-scripts.md) for changes to consumers,
source inputs, test registration, privilege, locks or cleanup.
