# Runner native behavior scenarios

These commands exercise Runner config, local execution and host lifecycle on a
provisioned metal host. Driver/remote-worker pairs and the agent-ready benchmark
belong to this suite; `runner-behavior-durable.sh` owns staging, bounded systemd
execution, reconnectable status and cleanup. Keep scenario logic with its owner.

Required Crates lanes cover native execution, process containment, memory
reclaim, cancellation, keep-alive and upgrade behavior. Cache publication,
checkout, contention and rootfs-independent reuse are covered by the isolated
real-file/flock [Rust cache tests](../../../runner-lifecycle/src/home_image_cache/tests/)
and [finalization tests](../../../runner-supervisor/src/sandbox_finalization.rs).
These tests use temporary cache roots rather than the shared metal-host cache.

Run a driver from the repository root, for example:

```bash
bash crates/runner/tests/behavior/runner-behavior-exec.sh
```

`runner-behavior-process-containment.sh` owns one shared Runner fixture and runs
three scenario programs: native managed tasks and their CLI/Pi consumers,
detached-descendant/bootstrap reuse with live CPU and mixed-identity cleanup,
and independently threaded memory/PID pressure. Keep each pressure/reuse pair
and the complete leak/reuse/CPU lifecycle together. The lifecycle program owns
its active pressure submit; the coordinator stops the Runner after success or a
scenario failure. Support programs are checksum-verified before durable execution.

All containment local submissions use the coordinator's same 240-second boot-time
deadline through `runner-behavior-process-containment-submit.sh`. Each receives
only the remaining budget, including sandbox finalization before the local result.
The durable owner retains its 270-second result guard and the Actions step its
five-minute bound. These are operational deadlines; elapsed cleanup/recovery or
control-latency measurements do not decide functional success on shared hosts.
The coordinator emits bounded invocation/run-scoped failure diagnostics before
bounded transient-service cleanup and retains state if inactivity is unconfirmed.

The required nested-task global-OOM case uses
`@guest-wide-task-oom-injected`. Four workers each retain 96 MiB, report readiness
through an owned pipe after touching their allocation, and remain in the nested
task runtime. Only after all reports and cgroup/priority checks does the mock
request a kernel global OOM through the disposable Guest's SysRq interface.
The kernel still chooses the victim. The test requires group kill, main/sibling
survival, task-family retirement, reclaimed charge, contained-tool attribution
and a successful same-sandbox follow-up. Guest-only injection does not measure
physical-exhaustion or reclaim latency.

`@guest-wide-task-oom` retains the real distributed memory-pressure regression.
On a reserved provisioned host with an owned, locally configured Runner and
matching binaries/images, run it explicitly, then submit a follow-up using the
same thread/session:

```bash
TASK_PRESSURE_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --timeout 240 \
  --chat-thread-id "$TASK_PRESSURE_THREAD_ID" --session-id nested-task-pressure \
  --feature-flag sandboxReuse=true --prompt '@guest-wide-task-oom'
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --timeout 240 \
  --chat-thread-id "$TASK_PRESSURE_THREAD_ID" --session-id nested-task-pressure \
  --feature-flag sandboxReuse=true --prompt 'true'
```

Retain the Guest `guest_wide=true`, `memcg_ooms=0` and `trigger=pressure` evidence,
and verify the follow-up's Runner terminal record has
`reused=true`. The injected mode reports `trigger=sysrq`; it preserves the same
native cleanup contract without allocating toward Guest exhaustion. Both nested
cases retain private task stderr; failures emit a bounded tail with the last
completed stage and child error. Neither marker is a standalone host setup command.

Home-cache restoration and Agent-ready measurements are **manual verification**,
outside required per-PR CI. Different PRs can share a metal host and its global
cache entry/GC locks. Optional publication may correctly skip under IO contention,
and the restoration fixture itself holds the GC lock across its restore submit.
Use a provisioned host reserved for these commands, without concurrent CI or
other cache-mutating workloads.

Run `bash crates/runner/tests/behavior/runner-behavior-home-cache-promotion.sh`
to verify live-writer rejection, freeze-based publication and Guest home contents
across a changed rootfs and Runner restart. It pins the committed entry through
the rootfs build and Runner startup, then acquires the routine-GC lock before
releasing the entry pin. The restore submit has a 60-second deadline; success,
failure and cleanup release the GC lock before service teardown. This
native Guest filesystem integration is additional evidence beyond ordinary Rust
tests and is not asserted by required CI on every PR.

Run Agent-ready measurement with
`bash crates/runner/tests/behavior/runner-behavior-agent-ready.sh`. It owns a
separate fixture and captured systemd invocation and calls the existing benchmark
worker. `AGENT_READY_BENCHMARK_SAMPLES` defaults to one (six submissions across
fresh, home-cache and exact reuse); explicit measurement runs may select 1–100.
Missing/invalid durations, incorrect reuse and failed home promotion fail the
command. Timing summaries are observations, not a performance-regression gate.

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

The exec driver supplies the `exec/` entry directory to the durable supervisor.
It stages one archive, verifies its digest, and atomically publishes immutable
assets before launching `worker.sh`. Existing file workers keep their invocation
contract. The same durable identity recovers a lost launch reply without replay.

`exec/worker.sh` owns one service, long-running submit and sandbox for the suite.
`network.sh` keeps idle-pool identity, live DNS/isolation and retained-lock stop
assertions in one lifecycle; sourcing it only defines functions. Independent
scenario commands receive `<binary-directory> <sandbox-id>`:

| Command        | Contract                                                      |
| -------------- | ------------------------------------------------------------- |
| `commands.sh`  | Privilege, argv, exit status and one-shot descendant cleanup. |
| `inventory.sh` | 21 runtime + 8 user + 8 root checks in three exec probes.     |
| `postgres.sh`  | Guest PostgreSQL/pgvector with owned cluster/process cleanup. |
| `clients.sh`   | Complete packaged Claude/Codex compatibility programs.        |
| `https.sh`     | Runtime proxy/CA checks with separate build/request budgets.  |

The Chromium HTTPS probe uses a fresh profile and the packaged browser's CDP pipe
to navigate to a static HTTPS document, require HTTP 200 and expected response
content, and close the whole browser. It retains certificate validation and the
30-second Guest / 40-second Runner bounds, without depending on `--dump-dom`'s
implicit tab-close lifecycle. Failure or cancellation retires its owned browser
process group and removes the temporary profile. The local Chromium regression
controls the external CDP peer; the native lane owns actual browser/proxy results.

For an already-owned sandbox on the provisioned host, an individual scenario
can be invoked as `bash inventory.sh "$BIN_DIR" "$SANDBOX_ID"` from its staged
entry directory. It inherits the caller's environment and returns nonzero on
failure; it does not create or take ownership of an unrelated sandbox. Run the
driver for full service/network lifetime and actual native CI verification.

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
