# Original-file residency observations

`file_residency.py` retains a duplicated caller-owned regular-file descriptor
matching an explicit device/inode. `FileResidency.observe(offset, length)` maps
only that original extent read-only/shared and queries Linux `mincore` without
touching its payload. Offsets are page-aligned; each nonempty extent is inside
the current file size and at most 64 MiB. Before/after metadata and matching
effective/filesystem UID checks refuse mutation, foreign authority and descriptor
substitution. The creating process and thread own observations and cleanup;
credentials come from the calling native task's `thread-self/status`, since
filesystem UIDs can differ between threads in one process.
Retained thread-object identity prevents a recycled numeric thread ID from
transferring that authority after the creating thread exits.
The native TID and procfs task start generation are also checked, since Python
can cache the same dummy thread object across different native C threads.
The effective UID must differ from the kernel's `overflowuid`, recorded with
each authority snapshot: unmapped inode owners can otherwise share that reported
number with a mapped namespace user. This ambiguous UID is unsupported even for
a truly owned file; matching numbers cannot establish original-file authority.

The original descriptor survives pathname replacement, rename, unlink and growth
between observations. The caller retains its own descriptor independently.
Every successful observation records the original metadata, low-bit page vector,
resident **payload coverage** in the selected extent, observer generation,
monotonic acquisition spans/cost and positive mapping release. A failed query
produces an error, never a guessed zero. Failed unmap retains the original mapping
for cleanup; an uncertain descriptor close is never repeated against a possibly
reused descriptor. Callers must not mutate the component's private descriptors
or change credentials concurrently.

These are bounded point observations. Pages may change even before mincore
returns. Payload-byte coverage is not physical allocation, RSS/PSS, cgroup charge
or MemAvailable, and must not be added to those metrics. No whole-file/interval
maximum, complete relevant native residency, cold-input proof, calibrated
envelope, physical relief or production protection follows. Existing P1,
charged-window and native report formats/interpretations remain unchanged.

## Qualify and replay

Use 64-bit Linux with readable procfs (including `thread-self/stat`,
`thread-self/status` and `sys/kernel/overflowuid`), mincore and permission to lock
at most 64 KiB of new private file pages. The qualification supports page sizes
up to 16 KiB.
It creates only a new canonical output directory and small disposable owned files.
It neither requires KVM/root/cgroup delegation nor changes existing workloads,
cache policy or host pressure. Supply a new absolute output path:

```sh
python3 -B crates/runner/tests/guarded_idle_native/file_residency_probe.py \
  --output "$FILE_RESIDENCY_PROOF"
```

The fixed warm-file qualification observes an offset/partial page, pathname
replacement, unlink and growth on one original descriptor. A separate small
owned mapping is locked during each positive observation and positively released
afterward. The acquisition module itself never faults the observed payload.
There are four observations within a 30-second qualification bound. Failed
authority, mapping/query/release, original-byte, clock or cleanup checks persist
an error in `capture.json` and return nonzero. Existing outputs are never replaced.

Retain the entire output: three actual runtime/reader sources, `capture.json`,
raw `events.jsonl`, complete `original.bin` and the different `image.bin`
replacement. Preserve the returned invocation and source digest separately as
trusted inputs. The source digest hashes the sorted compact JSON map of the three
source filenames to their SHA-256 digests. Replay with trusted repository code:

```sh
python3 -B crates/runner/tests/guarded_idle_native/file_residency_report.py \
  "$FILE_RESIDENCY_PROOF" --invocation "$FILE_RESIDENCY_INVOCATION" \
  --source-sha256 "$FILE_RESIDENCY_SOURCE_SHA256"
```

The reader checks bounded original files, source and payload hashes, original
identities/authority, extents/vectors, observer/clock/lifetime/growth/order,
cleanup and explicit false completeness claims. It compares recorded original
remote identities, not a downloaded copy's new inode. Source/archive consistency
is not attestation against a hostile host, and replay validates original records
rather than recreating past kernel residency. Before executing archived code,
verify its source/archive digest with independently trusted tooling.

## Ordinary checks and remaining native gates

```sh
python3 -B -m unittest discover -s crates/runner/tests/guarded_idle_native \
  -p 'file_residency_test.py'
```

Ordinary Linux CI runs real-file lifecycle, external syscall failure, strict
original-record refusal and real CLI tests. Target-host qualification remains
source-bound component evidence. Complete process/backing/file/cache/kernel/NBD/
shared/outside-charge scope, genuine native phase/overlap windows, cold lineage,
interval coverage, matching Host/Guest/images and conservative supplied envelopes
retain their independent native acceptance gates.

The UID-alias regression uses a disposable user namespace in a joined subprocess;
only that fixture is explicitly skipped when the kernel denies namespace creation
or its UID mapping.
The per-thread filesystem-UID regression uses a joined disposable root subprocess
and is explicitly skipped without root; it changes only that subprocess worker's
credentials and restores them before owned-resource cleanup.
Security CI also runs that focused regression with sudo on its disposable Ubuntu
runner, so its ordinary unprivileged skip does not omit credential coverage.
Acquisition and reader refusal never fall back to guessed ownership or residency.
