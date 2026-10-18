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

The selected image generation contains both `rootfs.ext4` and `runtime.ext4`.
Guest RPC CI also runs `packaged_runtime_executes_real_agents_tools_and_children`:
the actual packaged Claude, Codex and Pi use bounded local synthetic model peers
to execute tools and child Agents (Claude's native Agent tool, Codex's namespaced
native subagent, and Pi's managed subagent command). Pi reads a real image through its packaged
worker/WASM assets. The scenario covers fresh boot, restored snapshots, park and
reassignment, and fresh boot without a home drive. It checks the public tool CLI
and its independent Node installation, while fixed Agent paths ignore poisoned
PATH entries. The image-directory lease retains both source files through both
native tests. The additional payload scenario has an explicit bounded lifetime;
its resource observations do not establish production savings or caller MAC.

For manually supplied owned pairs, the ignored `prepare_packaged_runtime_snapshot`
test invokes the production snapshot creator with the same `OKOU_TEST_RPC_*`
paths, a new snapshot directory, and the 2-vCPU/4-GiB/16-GiB-home test profile.
Record the exact source, producer binary and image hashes before and after this
fixture preparation. Restore consumes the production `runtime-source.json`
generation binding. This helper does not produce the separate
`guarded_idle_native` preparation receipt or qualify its lifetime/resource gates.
The payload test starts each framework through `StartAgentProcess`; the local
model peer is a separately supervised process. Explicit no-home fixtures prepare
the normal CLI cwd before launching Agents.

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
