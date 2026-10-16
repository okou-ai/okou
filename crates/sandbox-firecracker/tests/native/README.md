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
images and packaged Firecracker/kernel. The host CPU driver uses the
[Runner durable supervisor](../../../runner/tests/behavior/runner-behavior-durable.sh).
Preserve stable CPU locks, held image locks, bounded systemd work, inherited SSH
transport and original failure/cleanup behavior. Manual commands need the same
host authorization and fixtures; do not replay uncertain native execution.

The `host-cpu-fairness-test` CI job explicitly sets `HOST_CPU_TEST_MODE=placement`,
also the driver's default. It runs only
`real_firecracker_guests_have_managed_host_cpu_placement`: real cgroup delegation,
exact weights, Firecracker thread membership, process launch/cancellation, and
Guest destruction/empty-leaf cleanup. It does not saturate CPUs or measure service
ratios, borrowing, or maximum scheduling gaps on shared PR hosts.

Run the original measurement explicitly on a provisioned host reserved for
verification, following [shared native CI guidance](../../../../docs/testing.md#shared-native-ci-hosts).
First obtain a matching `host_cpu_fairness` artifact as described above and supply
the same environment, including `TEST_BIN`, `METAL_USER`, reserved `HOST`, safe
`JOB_REF`, numeric `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`, and pinned
`DEFAULT_ROOTFS_HASH`. Then run from the repository root:

```bash
HOST_CPU_TEST_MODE=measurement \
  crates/sandbox-firecracker/tests/native/runner-behavior-host-cpu-fairness.sh
```

This selects only `real_firecracker_guests_receive_weighted_host_cpu_service`
with the original saturation, proportional-service, control-progress/delay, and
idle-capacity borrowing assertions. The driver verifies that its exact selected
test exists before execution; a missing test fails. CPU affinity and the stable
per-CPU locks coordinate driver invocations, but do not reserve capacity against
other Runner services or collectors. Provision that isolation before measuring.
Use a new run/attempt identity for a new execution; do not replay an uncertain
measurement by changing its mode under the same durable identity.

Local infrastructure regressions are `tests/*-test.sh`; invoke them with Bash.
They prove command outcomes with controlled external boundaries, rather than real
CPU fairness or guest RPC. Existing CI shards execute them exactly once; real
functional binary execution remains in the existing native PR jobs.
