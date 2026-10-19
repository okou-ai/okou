# Owned charged-memory window qualification

`charged_windows_probe.py` qualifies a narrow Linux memory-controller acquisition
component before it is used in further native measurement. It executes a fixed
disposable Python workload, not a Guest or a complete native scenario. A passing
result always retains full relevant residency, native execution, cold-input and
production-protection claims as false. Existing P1 and native reports keep their
original interpretation.

## Scope and counter custody

`ChargeWindows` creates a new `okou-charge-<invocation>` subtree under an explicit
canonical cgroup-v2 parent. The supplied parent must already enable memory;
the tool never changes that parent's controllers or counters. Each one-use named
window owns a different ancestor cgroup and retains its original `memory.peak`
FD through reset and final read. The last new leaf holds only newly launched work
and its inherited descendants. Window operations and cleanup belong to the
creating process and thread; duplicate starts, reads after end and changed
directory/file/FD identities fail.

Independent FDs on the same cgroup do not guarantee independent overlapping
peaks: a reset can discard another FD's retained peak on relevant kernels. The
qualification therefore resets an inner counter while an outer window retains
an earlier allocation peak, then joins a transient child between observations.
The inner peak must retain that transient allocation after the child is gone.

An exec helper enters the new leaf before the actual workload exec. Its Python
bootstrap and the collector, source copying, log persistence and replay stay
outside the charged subtree. Charges allocated there before entry do not become
workload charges merely by moving the helper. New ancestor accounting metadata
and descendant charges are included according to the kernel's hierarchical
accounting. These measurements are **cgroup charges**, not total physical
residency, process RSS/PSS, file-page residency or a quantity to add to
MemAvailable. Shared/prewarmed pages charged elsewhere remain outside scope.

Every reset/read has original monotonic start/end clocks, and begin records the
reset completion. The capture retains the kernel release, architecture,
acquisition UID and original boot/parent identity. The charged peak spans a kernel reset inside that acquisition
interval through the final read inside its interval. It is not an atomic native
phase bracket or an unqualified physical upper bound. Observation costs are
reported explicitly; fsync/log costs outside those spans remain in total elapsed
time. Wall/monotonic clocks have a bounded consistency check, not a cross-host
clock conversion.

## Execute and replay

Use Linux cgroup v2 with writable delegation, `memory.peak` reset support,
pidfds and subreaper support. The root mount needs root; an appropriately
delegated domain parent may be used without root. The memory controller must
already be enabled for that parent's children. The root has no `cgroup.type`
file and is handled as the v2 root domain. No KVM/NBD is required by this tool.

From the repository root, use a new absolute directory whose parent exists:

```sh
sudo python3 -B crates/runner/tests/guarded_idle_native/charged_windows_probe.py \
  --output "$CHARGE_PROOF_DIR" --cgroup-parent /sys/fs/cgroup

sudo python3 -B crates/runner/tests/guarded_idle_native/charged_windows_report.py \
  "$CHARGE_PROOF_DIR" --invocation "$CHARGE_INVOCATION" \
  --source-sha256 "$CHARGE_SOURCE_SHA256"
```

Preserve the returned invocation and source-bundle SHA-256 separately at capture
time; supply those trusted values to independent replay. Keep the entire output
directory: original producer/module/worker/reader sources, `capture.json`, raw
`events.jsonl`, `worker.stderr` and the 64 MiB `retained.bin`. Replay verifies
original bytes and reconstructs counter/window/worker/positive-wait/cleanup
ordering. Original remote device/inode identities are compared across original
records, not against a downloaded copy's new inode. Source hashes establish
consistency/custody, not attestation against a hostile host. Run the retained
reader for an old bundle; current source must not reinterpret unsupported formats.
Before executing archived Python, verify a separately trusted archive digest or
independently compute the source-bundle digest with trusted tooling. The source
digest is SHA-256 of the sorted, compact JSON mapping the four runtime filenames
to their SHA-256 file digests. An archived reader must already be trusted before
it can validate other files; the trusted repository reader can instead verify a
bundle in its supported format.

The workload touches/releases 32 MiB, joins a 16 MiB transient child and writes
and syncs a 64 MiB owned file. After positive driver wait, its file charge must
still be observed. It is not a cold-input test and performs no cache reset,
pressure injection, existing-workload manipulation or global tracing. Bounds
are fixed: 8 GiB host availability floor, 256 MiB owned memory limit, 60 seconds
acquisition, 16 records and 4 KiB per worker response. Individual worker replies
are limited to 10 seconds; failure cleanup has separate bounded waits. There are
at most the fixed worker and its single transient child. Hash/replay buffers
are bounded but outside the charged subtree.

Exit 0 means this fixed qualification and strict replay passed. Any missing,
malformed, contradictory or incomplete record, lost peak, changed source/identity,
failed headroom/deadline, worker error or intervened cleanup returns nonzero.
Failures preserve original capture/error/cleanup records and never print a
successful qualification. Cleanup signals only the still-owned driver's pidfd,
positively waits it and adopted descendants, and removes only verified empty
owned groups. A populated/replaced group is retained with an explicit error;
inspect that original failure before any further action. Output directories
are exclusive and never overwritten. Output preparation failures before capture
creation also return nonzero and can leave a partial new directory.

## Ordinary regression checks

```sh
python3 -m unittest discover -s crates/runner/tests/guarded_idle_native \
  -p 'charged_windows_test.py'
```

These synthetic original-file/CLI/lifecycle refusals run in ordinary CI without
root or native infrastructure. They are not live kernel qualification. Actual
qualification is explicitly opt-in with the command above; native phase/file/
kernel/NBD/shared completeness, cold lineage and matching-source fresh/snapshot
overlaps require their own acquisition and acceptance.
