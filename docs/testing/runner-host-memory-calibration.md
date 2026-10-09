# Runner host-memory calibration

P1 of [#38106](https://github.com/okou-ai/okou/issues/38106) adds passive
observation and reusable measurement tools. It does not change admission, reuse,
refill, warming, Guest memory policy or required saving. Numerical controller
bounds and the supported active-profile envelope require reviewed current native
evidence before activation. A software floor is not kernel-reserved RAM or OOM
immunity.

## Permanent signal and ownership

`runner-host::host_memory` reads at most 64 KiB plus one overflow byte from
`/proc/meminfo`. Exactly one unsigned `MemAvailable: <value> kB` is required;
checked multiplication converts KiB to bytes. Zero is valid. Missing, duplicate,
malformed, oversized, failed and overflowing input is Unknown. Monotonic age
starts before I/O, so read completion never renews old bytes. Future/inconsistent
or expired observations cannot return usable availability.

One `runner-supervisor::host_memory::HostMemoryObserver` starts after early
signal registration and before optional warming. It runs independently of
heartbeat, status, pool and transfer locks. Reads are single-flight, overdue ticks
are skipped, and a timed-out read invalidates the cache without queuing another
read behind it. Every ordinary startup/reactor error, cancellation or shutdown
return cancels and joins the observer. Unexpected owner loss aborts its task;
closed producers invalidate cached success.

The routine heartbeat period is reused only for bounded diagnostic scheduling.
The diagnostic cache/age is **not** calibrated permission freshness or a capacity
grant. Every future physical decision must obtain fresh local input at its own
boundary. Logs expose bytes, validity, age, read duration and
`critical_zero`/`unknown`/`uncalibrated` pressure; positive availability does not
imply healthy headroom. Existing inventory and preparation/export/park/Agent
records supply correlation; no per-sandbox host sampler or production residency
registry is introduced. Alloy remains the host observability authority.

`runner-lifecycle::host_memory_policy` validates explicitly supplied current
floor/reserve/watermark/profile-plus-margin arithmetic. It selects no numerical
production defaults and performs no admission or reclamation.

## Owned collector

The Linux collector `.github/scripts/runner-memory-calibrate.py` requires pidfd
support and starts only its own command. Do not attach it to an existing Runner
or supply another owner's VM state. It has bounded duration, sample count,
interval, logs and descendant inventory. Its unique output directory must not
exist and must have no symlink component or replaceable non-sticky parent.
Metadata must contain no credentials,
private prompts or real provider tokens. The fixture receives a minimal system
PATH and private HOME/TMPDIR, not the caller's provider/API environment. Use
absolute compiled tool paths and explicit synthetic inputs; do not rely on
personal credential/config directories.

It retains monotonic and wall-clock host samples, fixture-only generation-pinned
RSS/PSS, bounded raw stdout/stderr and `report.json`. Residency is checked against
process start ticks before and after reading; missing/raced samples are explicit
null residency with an incomplete-sample count, not zero resident bytes. Child
discovery covers all bounded worker threads, including Tokio-spawned VMs. Fixture cancellation, timeout, low headroom, nonzero exit and
cleanup uncertainty remain visible failures. Cancellation first signals only
the driver, giving it its saving/export grace. Descendant signal escalation is
recorded as `cleanup_intervened` and disqualifies fixture success even when all
children are subsequently reaped. Required-data preservation must never be
inferred from forced teardown. It uses pidfds for owned signals, acts as a
subreaper for escaped/adopted descendants and positively waits its children. It
never deletes backing state or reports PID absence as VM relief.

`driver_wait_confirmed` and adopted-child waits prove those particular child
waits. They do **not** prove a Runner's own Firecracker child wait, required data
preservation or kernel-reported physical relief. `native_vm_exit_confirmed` and
`calibrated` remain false in the generic collector. A successful fixture command
is not a complete calibrated native corpus. Log truncation disqualifies any phase
proof relying on the discarded records. Driver-specific VM exit and continuation
receipts must be separately verified.

Example, from a repository checkout (use an approved fixture-only headroom floor,
not the example as controller policy):

```bash
python3 .github/scripts/runner-memory-calibrate.py \
  --output "$OWNED_WORK/new-case" \
  --metadata "$OWNED_WORK/artifacts.json" \
  --minimum-available-mib "$FIXTURE_SAFETY_FLOOR_MIB" \
  --duration-seconds 300 --interval-seconds 0.1 \
  --cleanup-grace-seconds 30 \
  -- "$ABSOLUTE_OWNED_DRIVER" "$OWNED_CASE_INPUT"
```

The driver must create and own its resource generations, never daemonize without
retained ownership, use bounded operations and join every backing/accepted I/O
owner before success. Emit monotonic phase begin/end records from real boundaries,
not guessed duration or a scenario label. Keep the collector's process status,
driver VM exit receipt and native phase/session evidence separate. Do not remove
state when any backing exit or accepted I/O remains uncertain.

## Native environment and artifact preflight

Use only a host authorized for this invocation. Inspect current memory/disk/KVM,
existing workload identities and available tools read-only. On a shared host,
choose an independently owned directory/group/base-dir and conservative bounded
workload; do not stop existing services, change their configuration, adopt VMs,
induce host-wide pressure, clear caches or drain a fleet.

Record source revision and dirty-patch digest, Runner binary SHA-256, Guest and
installed CLI identities, kernel/Firecracker versions and SHA-256, rootfs/snapshot
hashes, exact profile CPU/MiB/disks, fixture generation and input digest, host boot
identity, timestamps, sample/read costs and the relevant baseline. Verify inputs
with the current Runner image validation boundary, not merely a directory name.
Historical samples and other owners' artifact receipts are not current identity
or execution authority. Never borrow a business VM or read its private workspace.

A native reader smoke is available without a VM:

```bash
cargo run --manifest-path crates/Cargo.toml --profile local --locked \
  -p runner-host --example host_memory_observation
```

This prints three current procfs observations. It is signal/environment proof,
not Guest continuation, profile peak or threshold calibration.

## Current-pipeline corpus

Use exact current Runner/Guest artifacts and synthetic provider/API inputs. For
fresh execution, the current `runner benchmark --config <owned-runner.yaml>
--profile vm0/default 'true'` runs a shell exec without model credentials, but
covers neither Agent-ready nor all reuse/terminal paths. Its initial prefetch is
part of the baseline; it is not a cold-start sample unless cache conditions are
recorded. The config, proxy/runtime, VM and output must all belong to the fixture.

For full pipeline cases, generate a new uniquely named Runner config with
`runner config`, synthetic token/API values, `--max-concurrent 1` and the verified
image hashes. Start that config with `runner start --local` in the foreground;
never install or change a service. Use a unique local queue group/chat/session.
The existing `.github/scripts/runner-behavior-agent-ready-benchmark-remote.sh`
shows real Agent-ready/reuse boundaries, but is not itself an ownership-safe
standalone calibration driver: do not invoke it against an existing service.
Local Agent execution requires synthetic/mock provider behavior in the owned
Guest; a fake API URL alone does not prove that no model/provider call occurs.

| Case                         | Required current boundary and evidence                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh                        | Full-profile startup/storage/history/bootstrap through authenticated Agent-ready and accepted preparation completion; include peak and latency.             |
| Parked resume                | Independently owned exact parked generation; resume/preparation/Agent-ready, useful reuse and unchanged session continuation.                               |
| Blank preparation            | Owned blank preparation/fill/park and its optional prefetch; no unrelated blank pool.                                                                       |
| Export                       | Required workspace/session export from owned parked state through positive backing exit, accepted I/O completion and later disk cleanup.                    |
| Terminal private preparation | Current prepare-for-cache path after required readers/host copy, before freeze; preserve framework history and user files, including #38153's behavior.     |
| Prefetch                     | Startup and runtime optional producers separately, with actual paths/envelopes and accepted-I/O joins.                                                      |
| Active growth                | Representative native working sets after readiness; minimum and supported profiles, true tool/compiler outcome, control delivery, continuation and cleanup. |
| Short burst / relief tail    | Sufficiently fine sampling plus actual park/balloon/pause/backing exit/host availability boundaries; no synthetic byte credit or OOM causation claim.       |

The ignored native park regression is an additional narrow boundary:

```bash
OKOU_TEST_PARK_API_SOCKET="$OWNED_SOCKET" \
OKOU_TEST_PARK_FIRECRACKER_PID="$OWNED_GENERATION_PID" \
OKOU_TEST_PARK_SCENARIO=normal \
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p sandbox-firecracker physical_park_reclaims_before_pause_and_hands_off_without_pause \
  -- --ignored --test-threads=1
```

Reset and own each separate VM for `before_inflate`,
`during_inflate` and `during_deflate`; cleanup must remain bounded and positively
wait backing exit. This is not complete controller or active-envelope proof.

## Evidence and completion gates

Report implemented tooling, executed cases, exact artifact/profile match, missing
phases, continuation/exit proof, sample/truncation limits and reviewed numerical
choices separately. Compare an unmodified baseline with current code on the same
owned workload, not a persistent production Off mode. Host-global availability
with concurrent workloads does not establish attribution or reclaimable yield.

A process smoke or small isolated KVM boot can validate setup/collection/teardown;
it is explicitly not a current Guest/Agent profile measurement. P1 does not select
production floors/reserves/watermarks/margins/cadence or authorize activation.
Missing representative native data, supported active envelope, production
inventory, clean cutover and current-only recovery evidence remain parent gates.
P2–P4 and production rollout require their own current approvals.

## Tool verification

```bash
python3 .github/scripts/tests/runner-memory-calibrate-test.py
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host -p runner-lifecycle -p runner-supervisor -- --test-threads=1
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner cmd::start::tests -- --test-threads=1
```

The tests use real files/processes for parsing, generation pinning, bounds,
nonzero/timeout/cancellation and adopted-child waits. Mock/fake time is reserved
for internal freshness/scheduling. Prepare the locked addon environment before
running Runner's complete suite, as described in [Rust testing](rust-testing.md).
