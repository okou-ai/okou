# sandbox-firecracker native drivers

## Request controls for native fixture authors

The non-default `test-support` API
`sandbox_firecracker::api_request_gate::gate_request` owns one caller-bound Unix
listener and an explicit invocation-owned backend path. Select `Transition::Resume`
or `Transition::Pause`. Keep the returned producer and complete native resource
owner outside observer timeouts; the separate arrival/release controls own neither.
Arrival means a complete validated request is captured **before backend dispatch**.
Only explicit release connects and forwards the original bytes once.

To intercept a lifecycle method's internally constructed `ApiClient`, create
`RequestRoute::new(original_api_socket, front_socket)` and await
`route.scope(sandbox.unpark())` (or the intended park future). This opt-in route
matches lexical `Path` equality and only `PATCH /vm`; balloon and other API
traffic use their original transport. It never resolves symlinks, renames sockets
or retries the backend after a selected front fails. Both paths and the front
listener must belong to this invocation. Gate capture still precedes dispatch.

The route is active only while polling the supplied future. Completion, panic
and cancellation restore the prior scope, including nested scopes. Spawned tasks
do not inherit it; put `scope` inside a deliberately spawned task when needed.
The operation itself is never spawned or transferred by `scope`. Keep the gate
producer and complete native capsule outside that future and its observation
timeouts. Original `Dirty`/`NotParkable` fences remain authoritative after a
cancelled lifecycle operation, even if its independent response later drains.

`producer.join()` borrows its handle, so cancelling a bounded wait leaves accepted
work joinable. Dropped arrival/release observers or a cancelled client cannot abort
an already dispatched backend drain. Before release, losing its sender produces
`NotForwarded` without backend dispatch. Explicitly join accepted producers or retain
them with unresolved native owners. Dropping a producer detaches rather than aborts
its task; detachment or runtime shutdown is not completed cleanup. Capture and
drain have no internal deadline: bound observation and preserve the owners when
work remains pending. Inspect `RequestFailure::stage` for uncertainty after a
partial write or incomplete response.

The gate validates bounded HTTP/1 Content-Length framing and the exact selected
PATCH /vm command; it does not support chunked framing, replace/adopt live sockets
or change production ApiClient/lifecycle cancellation. `ResponseDrained` preserves
the actual backend status/body independently of local client delivery. Even a
successful delivery is no acknowledgement from the client application. Transport
completion grants no Guest readiness, reuse, required saving or backing-exit
authority. A pre-dispatch receipt is not native backend acceptance. Native tests
must independently establish those boundaries and retain original data/full leases.

Ordinary real ApiClient/Unix-peer regressions run with:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p sandbox-firecracker --features test-support --test api_request_gate \
  -- --test-threads=1
```

These tests do not execute Firecracker/KVM or prove in-flight native cancellation.

## Native execution

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
