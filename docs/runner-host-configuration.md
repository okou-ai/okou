# Runner Host Configuration

## Diagnostic Host Attribution

`runner.yaml` may contain an optional `hostname` used only to identify the
physical runner in claims, sandbox telemetry, Runner Axiom warning/error
events. Production automation writes the exact Ansible `inventory_hostname`;
it does not derive the value from DNS or the operating system at runtime.

The value must be non-empty and no longer than 255 JavaScript string units
(UTF-16 code units). `runner config --hostname <value>` validates and preserves
the raw value. Existing configuration files without `hostname` continue to
load and omit the canonical hostname fields.

Hostname does not select a service, directory, release, or rollback target.
Systemd service suffixes are opaque local instance names. Production currently
passes its explicit `runner_release` value as the service name and Runner
directory name, but version logic uses `runner_release` directly and does not
interpret a runner name as a version. Live processes are selected by their
exact config path and process identity, and rolling log files use the release
compiled into the Runner binary. Current Runner binaries send optional
canonical `runnerHostname` from configuration and canonical `runnerVersion`
compiled into the binary. They no longer send legacy `runnerName` in
heartbeats or sandbox telemetry. Current API revisions no longer declare,
persist, or map that field. During deployment overlap, an extra `runnerName`
from an older Runner payload is tolerated but discarded before request
handling.

Current `runner.yaml` has no legacy `name` field. Repository automation writes
`hostname` through `runner config`, while `--runner-dirname` and systemd service
`--name` remain opaque local lifecycle inputs. Live-runner records contain exact
config/process metadata and no legacy runner name. Readiness and doctor select
live processes by the unit's exact config path.

Operational queries and alerts should use `runner_hostname` and
`runner_version`. A bounded historical fallback may use `runner_name` only for
records that lack the canonical dimensions from before the cutover. Never
interpret `runner_name` as a hostname.

Runner Axiom warning/error events similarly include optional
`runner_hostname` and required `runner_version`. The rollout order is compatible
API and nullable heartbeat storage, Runner producer cutover, then logical API
receiver removal, followed by physical state-column removal after pre-cutover
serving API instances drained. The current schema no longer contains
`runner_state.runner_name`. Canary each transition and verify claim snapshots,
telemetry/Axiom dimensions, and distinct hostnames on two hosts running one
version. Remove any historical query fallback only after its bounded
observation window expires.

## Active and Parked Sandbox Memory

Active Guests keep a traditional balloon target of zero. Stable free-page
reporting returns pages the Guest has already freed; it does not evict live
file cache. OOM deflation remains enabled. There is no periodic active
inflation policy or available-memory threshold that a workload must cross
before regaining its configured capacity.

This can increase active Firecracker RSS, particularly for file-cache-heavy
workloads. Admission still accounts for profile memory and applies
`concurrency_factor`; it does not measure RSS or reserve host memory overhead.
Overcommit therefore has no worst-case resident-memory safety guarantee.
Size concurrency against the full active profile working set plus host/Runner
overhead, and measure host headroom and parked residency as well as latency.
Free-page reporting and parked reclamation are not substitutes for that budget.

Tenant-free sandboxes prepared for the blank pool retain their full profile
resource budget. Firecracker pauses vCPUs without requesting aggressive idle
balloon inflation. Guest quiesce and operation fencing still complete before pause. This avoids a
large idle-only inflate/deflate cycle when a prepared sandbox is claimed.

Reusable exact/session park inflates the balloon under the existing bounded
reclamation policy, then requests target zero and completes deflation before
pausing vCPUs. Deflation returns capacity to the Guest allocator without eagerly
repopulating backing discarded by Firecracker; subsequent Guest accesses can
fault that backing in again. Reclamation diagnostics and severe-retention
rejection are decided against the original positive target before deflation.
Background park allows up to 30 seconds for deflation convergence, including
in-flight statistics requests, to tolerate slow deflation without discarding a
reusable sandbox at the foreground deadline. This wait remains interruptible by
an exact-successor handoff. The deadline starts after the target-zero PATCH
completes; it does not bound the whole park operation. A stalled sandbox retains
its full resource budget until recovery destroys it. A longer park can delay
hard-cancellation cleanup and local-provider completion, which wait for finalization.

Unpark of a completed reusable park resumes vCPUs and Guest operations without
another balloon request or statistics query. Park already completed deflation,
and no other owner changes the target while idle; blank preparation never
inflated. Running handoffs and non-reusable cleanup still request target zero
and wait for exact target/actual page counts to reach zero before reopening Guest
operations. Their convergence wait, including in-flight statistics requests, is
bounded at five seconds; failures keep operations fenced and use the existing
destroy/fresh-create recovery. An accepted handoff starts this foreground wait
instead of inheriting the remaining background deadline. No background balloon
controller or Agent-readiness reclamation gate remains. The full profile budget stays reserved
throughout. Minimum profiles never inflate and skip this balloon recovery.

Zero page counts describe the currently reported state, not a target-generation
acknowledgement: an interrupted Guest inflation batch may update its actual count
after an earlier zero sample. Reporting itself also temporarily isolates free
pages. This policy prevents sustained active inflation; it does not promise
literally invariant `MemFree`/`MemAvailable` at every instant.

An exact successor can take over the still-running sandbox before inflation,
during reclamation or deflation, or before pause commits. The park owner reverses
the target to zero, retires the predecessor assignment and transfers the fenced
resource without pausing it. The successor completes deflation and Guest lifecycle
resume before opening operations; it does not issue a vCPU resume for this running
handoff. A request after pause has started receives the completed parked resource.
Running handoffs remain bound to the exact successor and cannot enter ordinary
idle inventory. Cancelled or rejected transfers retain their full resource lease
through destruction. This policy also applies after a claimed blank completes its
first run; the initial tenant-free blank preparation still skips reclamation.
The handoff acceptance grace remains 1.5 seconds, starting from the later of
predecessor finalization and successor wait initiation so late demand gets an
acceptance window. An already accepted handoff does not expire at that boundary.

Pool sizing, full-profile admission, exact-first reuse and blank-first pressure
eviction are unchanged. Preserving blank memory can increase physical idle
memory usage; the profile budget is not a measurement of resident memory.

## Idle Workspace Reclamation Concurrency

### One-shot CI idle reclamation

`runner service prune-idle --name <service-suffix> --expected-runner-id <uuid>
--expected-heartbeat-generation <generation> --timeout-secs 120` reclaims only
the exact idle inventory owned by that Runner when the request is accepted.
Blank sandboxes, active/reserved sandboxes, admission and later parking remain
unchanged. This is not service drain, a no-idle mode, or host-wide GC.

CI captures the Runner UUID and heartbeat generation at deployment readiness.
`cli-e2e-03-runner-cleanup` waits for BATS and shared Playwright consumers, then
uses that receipt even when failed-test accounts are retained. The command
resolves the service's exact config/live process and uses a private,
generation-scoped local socket. Missing services, old binaries without the
command, generation changes and control failures fail visibly without signals
or a fallback to another process.

The command reports selected, completed and uncertain counts only after the
selected reclamation attempts finish; uncertain destruction fails the command.
Transport/status failures also fail. A client timeout or disconnect does not
cancel admitted destruction. Normal Runner shutdown waits for these tasks.
Workspace promotion and workspace/session-history disk caches are preserved;
the existing reclamation limits below still apply. Later runs may lose exact
hot reuse but retain blank/cache paths. Blank replenishment may use newly freed
capacity under its unchanged policy, so reclaimed budget is not an RSS savings
measurement.

### Reclamation admission

Workspace promotion uses two independent runner-process-local admission gates,
each sized as `(host_cpus / 2).clamp(1, 4)`. Cache clones share the gates.
The existing sidecar export gate covers guest export execution only. Idle
reclamation additionally acquires admission **before unpark** and holds it
through terminal unpark, export, host copy, workspace freeze and immediate
sandbox termination. Waiting reclamation jobs remain parked. Terminal unpark
uses the same physical-deflation readiness boundary as normal reuse, and the
temporary guest sidecar is left for sandbox destruction instead of a
separate guest cleanup command.

After successful termination, cache publication and factory destruction run
without holding idle admission. If termination fails or panics, publication is
abandoned and admission remains held through the factory destruction attempt.
Missing or explicitly abandoned promotion does not acquire this gate. Normal
startup/reuse and active sandbox promotion do not acquire idle reclamation
admission.

This limits simultaneous resumed idle guests, not total sandboxes or team run
concurrency. A bulk drain can take longer and retain parked budget leases while
waiting; capacity-pressure reclamation can consequently take longer too.
Overlapping runner versions have independent limits. Four is an initial policy,
not a measured optimum or a guarantee that large-history export/copy latency
disappears. No operator setting or persistent cache format changes are required.

### Sidecar export resource diagnostics

The existing `workspace image cache session history sidecar export completed`
event includes per-stage resource counters alongside wall-clock timings. The
`helper_read_verify_` and `helper_write_` prefixes each expose:

- `resources_available`: whether both resource snapshots produced valid deltas.
- `user_cpu_us` and `system_cpu_us`: CPU time in microseconds.
- `minor_faults` and `major_faults`: page faults without and with I/O, respectively.
- `input_blocks` and `output_blocks`: Linux `ru_inblock` and `ru_oublock`
  filesystem I/O accounting counters, not bytes or disk latency.
- `voluntary_context_switches` and `involuntary_context_switches`: scheduler
  context-switch counts.

These are deltas for the synchronous exporting thread, not all guest processes
or threads. Read/verify includes decoding, buffering and hashing. Write includes
private export-file creation and writing, but not the subsequent host copy.
Zero is a measured value. If collection fails, a counter decreases, or the
platform is not Linux, affected stage counters are absent and
`resources_available` is false; export success and failure handling are unchanged.

Faults can reflect buffer allocation and cache effects, and block counters do
not describe physical-device service time. Wall time minus CPU time also includes
scheduling and other waits: it is not disk-wait time or proof of a balloon-related
cause. Correlate these fields with the exact artifact and guest/host evidence.

Collection uses three fixed `getrusage(RUSAGE_THREAD)` calls per successful
export, with no per-chunk sampling, second history read, new RPC or run-startup
wait. The bounded numeric summary is private helper output, not persisted cache
metadata. Existing export admission, timeouts and the 5-second warning threshold
remain unchanged.

## Runner Operator Server Configuration

`runner config` requires the control-plane URL and Runner token through the
explicit `--api-url` and `--token` flags or the canonical
`OKOU_API_BACKEND_URL` and `OKOU_RUNNER_TOKEN` environment variables.
`runner start` accepts the same flags and canonical environment variables as
overrides, then falls back to the `server` values in `runner.yaml`.

The API URL must be an absolute HTTP(S) URL without credentials, a query
string, or a fragment. The Runner normalizes the accepted URL before storing or
using it. Clap help and diagnostics identify the supported environment names
without displaying their values, and the token is preserved without trimming
or logging it.

The runner reads host-local overrides from `/etc/vm0-runner/host.env` once
during startup. A missing file is equivalent to an empty file: the runner uses
`runner.yaml` for its concurrency factor and leaves I/O limiters disabled.

Apply file changes through the normal runner drain and restart workflow. A
running process does not reload this file.

## File Format

`host.env` is a runner-specific `KEY=VALUE` file. It is not sourced by a shell.
Blank lines and full-line comments are allowed, and whitespace around keys and
values is ignored:

```text
# Optional host-local concurrency override
OKOU_RUNNER_CONCURRENCY_FACTOR = 1.5
```

Do not use `export`, shell interpolation, quoted numeric values, or inline
comments. The parser accepts only the keys listed below. An unreadable file, a
line without `=`, an unsupported key, or a duplicate key is a configuration
error that prevents the runner from starting.

## Canonical Host-Tuning Contract

The runner accepts only these five host-tuning keys:

| Key                                      | Unit                   | Valid values                               | Behavior                                                                                             |
| ---------------------------------------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `OKOU_RUNNER_CONCURRENCY_FACTOR`         | Dimensionless multiple | Positive finite number                     | Optional; overrides `sandbox.concurrency_factor` from `runner.yaml`. An invalid value fails startup. |
| `OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC` | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_DISK_IOPS`                  | Operations/s           | Integer in `1..=u64::MAX`                  | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_RX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_TX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |

Each key may appear at most once. Retired host-tuning names and every other
unlisted key are unsupported and cannot select or override a value. The four
I/O keys form one all-or-none group.

Bandwidth values may be fractional. After conversion from MiB/s, the byte/s
value must be at least `1`, must fit in a `u64`, and is rounded down to an
integer. Disk IOPS must parse directly as a nonzero `u64`.

The concurrency override is independent of the I/O group, but it changes the
resource budget used to calculate the I/O limits.

## Completed Canonical Cutover and Rollback Floor

Production host configuration completed the canonical cutover with Runner
`0.178.4` (`b1440bfb43d75590ea1d0a43d9b8f0c8340832ef`). All three production
hosts started and passed readiness and health on that release before their old
services drained. Successor promotions confirmed the same canonical files.

Runner `0.178.4` is the rollback floor for hosts using this contract. The
retained rollback targets `0.178.4`, `0.178.6`, and `0.178.7` all read the five
canonical keys. Do not add an earlier rollback target unless its compatibility
with the canonical host file has been established separately.

Normal Runner promotion no longer mutates `host.env`. It installs, starts, and
health-checks the target before draining old services. If target installation,
readiness, or health fails, promotion stops the failed target and leaves the
already-running old services available.

## Configure Host I/O Capacity

The four I/O keys are one atomic configuration. Either omit all four or provide
all four:

```text
# Example sustainable aggregate host capacity; measure values for this host.
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
OKOU_RUNNER_DISK_IOPS=200000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=1250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=1000
```

These values describe sustainable total host capacity, not desired per-sandbox
rates and not short benchmark peaks. Every valid capacity is reduced by the
host reserve and divided among the maximum number of sandboxes the runner can
admit. Supplying per-sandbox targets here would reduce them again and could
throttle every sandbox below the intended rate.

A complete valid I/O configuration applies to every job on the runner. There
is no per-job feature switch.

## How The Runner Derives Limits

At startup, the runner:

1. Multiplies physical CPU and memory by the resolved concurrency factor to
   produce the effective resource budget.
2. Finds the maximum sandbox count that budget can admit across any mixture of
   configured profile CPU and memory shapes. A nonzero `max_concurrent` is an
   additional cap; `0` means there is no explicit job-count cap.
3. Uses that count as the denominator. For an unusually large calculation, it
   may use a conservative safe upper bound instead. The denominator is always
   at least one.
4. Reserves 20% of each configured host I/O capacity, then divides the remaining
   80% by the denominator using integer division.

For each capacity:

```text
usable host capacity = floor(host capacity * 80 / 100)
sandbox limit = floor(usable host capacity / denominator)
```

Bandwidth values are converted from MiB/s to bytes/s before this calculation.
The disk result is an aggregate sandbox-level block budget. Firecracker uses
per-drive limiters, so it divides that block budget evenly across the writable
drives attached to the sandbox. Network receive and transmit limits apply to
the sandbox network interface without another drive split.

If the calculated block budget cannot provide at least one byte/s and one
operation/s to each of two writable drives, or either network direction cannot
provide at least one byte/s, the entire I/O configuration is insufficient and
all I/O limiters are disabled.

### Worked Example

With the example values above and a resolved denominator of `4`, startup logs
show these sandbox-level limits:

| Capacity       | Host input     | Sandbox limit after reserve and division | Structured log field           |
| -------------- | -------------- | ---------------------------------------- | ------------------------------ |
| Disk bandwidth | `2000 MiB/s`   | `400 MiB/s` = `419430400 bytes/s`        | `disk_bandwidth_bytes_per_sec` |
| Disk IOPS      | `200000 ops/s` | `40000 ops/s`                            | `disk_ops_per_sec`             |
| Network RX     | `1250 MiB/s`   | `250 MiB/s` = `262144000 bytes/s`        | `net_rx_bytes_per_sec`         |
| Network TX     | `1000 MiB/s`   | `200 MiB/s` = `209715200 bytes/s`        | `net_tx_bytes_per_sec`         |

If a sandbox has two writable drives, Firecracker further splits the logged
disk budget into `209715200 bytes/s` and `20000 ops/s` for each drive.

## Failure Behavior

Host-file parsing and I/O resolution have different failure boundaries:

| Configuration state                                                       | Runner behavior                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File missing, or none of the four I/O keys present                        | Starts with I/O limiters disabled and logs `I/O limiters disabled`.                                                                              |
| All four I/O fields present and usable                                    | Starts with all jobs limited and logs `I/O limiter capacity configured; applying limiters to all jobs`.                                          |
| I/O fields partial, numerically invalid, or insufficient after division   | Starts, logs `I/O limiter host env config invalid; disabling I/O limiter capacity` with a `reason`, and disables every disk and network limiter. |
| File unreadable, line malformed, key unsupported, or exact key duplicated | Fails startup with a runner configuration error.                                                                                                 |
| `OKOU_RUNNER_CONCURRENCY_FACTOR` present but invalid                      | Fails startup with a runner configuration error naming the key and `host.env`.                                                                   |

The non-fatal I/O warning is all-or-nothing. A valid disk pair does not stay
enabled when the network pair is missing or invalid, and vice versa.

## Verify The Effective Configuration

After applying the file through the normal restart workflow, inspect the runner
startup logs. For a named systemd service, use:

```bash
runner service logs --name <service-suffix> --lines 100
```

First find `resource budget initialized` and verify:

- `concurrency_factor` and `concurrency_factor_source`
- `max_concurrent`
- `effective_vcpu` and `effective_memory_mb`
- `profiles`

Then verify exactly one I/O resolution message:

- `I/O limiters disabled` when no capacity is configured;
- `I/O limiter host env config invalid; disabling I/O limiter capacity` and
  its `reason` when the I/O group is unusable; or
- `I/O limiter capacity configured; applying limiters to all jobs` when the
  group is active.

The configured message includes:

- `denominator`
- `disk_bandwidth_bytes_per_sec`
- `disk_ops_per_sec`
- `net_rx_bytes_per_sec`
- `net_tx_bytes_per_sec`

These are effective sandbox-level limits. The disk fields are logged before
the per-drive split.

## Implementation Sources

- [`crates/runner/src/host_env.rs`](../crates/runner/src/host_env.rs) defines
  the file path, allowed keys, and file parser.
- [`crates/runner/src/runtime_overrides.rs`](../crates/runner/src/runtime_overrides.rs)
  resolves the concurrency-factor override.
- [`crates/runner/src/resource_budget.rs`](../crates/runner/src/resource_budget.rs)
  defines the effective CPU and memory budget.
- [`crates/runner/src/io_limits.rs`](../crates/runner/src/io_limits.rs) validates
  host capacity and derives sandbox-level limits.
- [`crates/runner/src/cmd/start/mod.rs`](../crates/runner/src/cmd/start/mod.rs)
  emits the startup state and effective-limit logs.
- [`crates/sandbox-firecracker/src/config.rs`](../crates/sandbox-firecracker/src/config.rs) splits
  the sandbox block budget across Firecracker drives.
