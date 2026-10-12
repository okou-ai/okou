# Owned-command memory collector

[`runner-memory-calibrate.py`](runner-memory-calibrate.py) launches a disposable
Linux test command and records host availability and its owned descendants'
RSS/PSS. It is a measurement utility, not production Runner admission, a sandbox,
or an automatic policy-calibration algorithm.

## Requirements

- Linux Python with `os.pidfd_open` and `signal.pidfd_send_signal`, default
  `SIGCHLD` handling, and no pre-existing children in the collector process.
- A bounded workload whose processes, VMs, paths and input data belong to the
  test. Never attach to an existing Runner or borrow a business VM/workspace.
- A new output directory under parents owned by root or the collector's effective
  user. Symlink components and group/other-writable non-sticky parents are refused;
  existing output directories are not reused.
- An explicitly chosen test-only minimum host availability. This stop condition
  does not reserve RAM or provide an admission/OOM guarantee.
- Metadata as a JSON object containing only non-secret artifact/profile/scenario
  information. Do not include credentials, private prompts or provider tokens.

The command receives a minimal system PATH and private HOME/TMPDIR, not the
caller's API/provider environment. Use absolute executable paths and synthetic
inputs. This environment is not a filesystem or network sandbox.

## Invocation

From the repository root, with a separately prepared, owned test driver:

```bash
python3 .github/scripts/runner-memory-calibrate.py \
  --output "$OWNED_WORK/new-case" \
  --metadata "$OWNED_WORK/artifacts.json" \
  --minimum-available-mib "$FIXTURE_SAFETY_FLOOR_MIB" \
  --duration-seconds 300 --interval-seconds 0.1 \
  --cleanup-grace-seconds 30 \
  -- "$ABSOLUTE_OWNED_DRIVER" "$OWNED_CASE_INPUT"
```

Defaults are 300 seconds of collection, a 0.1-second interval, a 30-second cleanup
phase grace, and 1 MiB retained per stdout/stderr log. Cleanup can add elapsed time
beyond the collection deadline. Supported bounds are duration up to 600 seconds,
interval 0.05–5 seconds, grace 0.1–120 seconds, at most 256 captured process
identities, 12,000 samples, and 16 MiB retained per log. Duration and interval must
also satisfy the combined sample-count bound. Limit violations fail the fixture;
they do not authorize dropping captured ownership or claiming relief.

## Outputs and completion

- `samples.jsonl`: monotonic/wall timestamps, host `MemAvailable`, read/age costs,
  and PID/start-generation-bound RSS/PSS. Missing or raced residency is null, not
  zero resident bytes.
- `stdout.log` and `stderr.log`: byte-bounded raw command output. `logs_truncated`
  reports discarded records; truncated logs cannot prove a phase they omit.
- `report.json`: metadata, driver exit/wait status, adopted-child waits, remaining
  children, pressure/timeout/error flags, and cleanup intervention/uncertainty.

Exit status is zero only for a successful command with confirmed cleanup and no
pressure stop, timeout, error or descendant cleanup intervention. Unsupported
preflight conditions fail before launching a command. Other failures can retain
partial output or uncertain owned resources; inspect the report rather than
assuming every process exited.

The driver must preserve required data, join its own backing and accepted-I/O
owners, and exit only after its work is settled. On cancellation, timeout or low
headroom the collector first gives the driver its saving/exit grace. Remaining
owned descendants may receive TERM and then KILL, fenced by ancestry, process
generation and pidfds. Forced teardown cannot prove preservation. Do not remove
backing state while exit or accepted I/O remains uncertain. Do not alter existing
services, induce host-wide pressure, clear host caches or drain a fleet.

Generic reports always keep `calibrated: false` and
`native_vm_exit_confirmed: false`. Driver/adopted-child waits, RSS/PSS and global
availability do not establish a Runner's own VM-exit receipt, session continuation,
actual physical relief or safe production thresholds. Verify those separately
for the real workload and artifacts.

## Collector regression tests

```bash
python3 .github/scripts/tests/runner-memory-calibrate-test.py
```

These tests validate the collector using disposable files/processes and controlled
external kernel facts. They do not execute a complete Runner/Guest/profile corpus.
