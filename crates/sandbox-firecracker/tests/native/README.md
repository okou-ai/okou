# sandbox-firecracker native drivers

`runner-behavior-host-cpu-fairness.sh` executes the `host_cpu_fairness` integration
target. `runner-behavior-guest-rpc.sh` executes the `guest_rpc` target. Their names
describe the host fixture; the binary targets and test ownership belong to this
crate. Run each command from the repository root after obtaining its exact native
test artifact through the existing
[CI transport](../../../../.github/scripts/runner/runner-native-test-artifact.sh).

Crates CI supplies an executable `TEST_BIN`, `METAL_USER`, `HOST`, safe `JOB_REF`,
numeric run/attempt identity and pinned `DEFAULT_ROOTFS_HASH`; guest RPC also needs
`DEFAULT_SNAPSHOT_HASH`. The selected host needs KVM, NBD, the matching immutable
images and packaged Firecracker/kernel. The fairness driver uses the
[Runner durable supervisor](../../../runner/tests/behavior/runner-behavior-durable.sh).
Preserve stable CPU locks, held image locks, bounded systemd work, inherited SSH
transport and original failure/cleanup behavior. Manual commands need the same
host authorization and fixtures; do not replay uncertain native execution.

Local infrastructure regressions are `tests/*-test.sh`; invoke them with Bash.
They prove command outcomes with controlled external boundaries, rather than real
CPU fairness or guest RPC. Existing CI shards execute them exactly once; real
binary execution remains in the existing native PR jobs.
