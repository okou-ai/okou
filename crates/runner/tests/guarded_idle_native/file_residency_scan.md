# Complete original-file range observations

`FileResidency.scan(maximum_bytes, maximum_duration_ns, emit)` covers a fixed
original file's byte range through sequential nonfaulting extent observations.
It retains the existing original-FD, owner/native-thread generation, filesystem
credential and per-point cleanup contract in [file_residency.md](file_residency.md).
The existing single-extent API and qualification/report v1 keep their meaning.

Each extent is at most 64 MiB and starts on a page boundary; the last extent
includes the exact partial tail. The caller supplies byte and duration budgets,
within hard ceilings of 32 GiB and 30 seconds. The pass freezes original
device/inode/UID/length/link count/mtime/ctime and checks that metadata and
authority across acquisitions. An empty file has zero extents, without a
physical-memory claim. No original payload is read or faulted by the observer.
File mtime/ctime are signed Unix timestamps; pre-epoch values stay valid and
remain separate from nonnegative monotonic clocks, durations and byte counts.

The synchronous `emit(point)` sink must retain each completed point before
returning. Sink IO, metadata checks, queries and mapping release contribute to
the measured pass duration. Sink errors, mutation, budget exhaustion or release
failure propagate without a completion result; already emitted points remain
diagnostics. The duration is an acceptance budget checked between operations
and on completion. It cannot interrupt a blocked kernel call or sink. Callers
must retain ownership rather than infer completion from an external timeout.

`resident_payload_bytes_observed_sum` is a sum of temporally distinct extent
observations. Cache residency can change between and during these calls even
when file metadata is stable. This is neither a simultaneous whole-file total
nor an interval maximum. Do not add it to charges, RSS/PSS or MemAvailable.
All seven broader native/Guest/cold/interval/envelope/physical/protection claims
remain false. Complete native categories, genuine phase arming, cold lineage,
overlaps, matching Host/Guest/images and supplied envelopes remain separate.

## Inherited-FD command

The caller opens and retains its original, records the expected device/inode
and full immutable payload digest, and passes that FD explicitly (for example
with Python `subprocess.run(..., pass_fds=(original_fd,))`). It remains borrowed;
the observer owns and retires only its duplicate and per-point mappings.
Rename, pathname replacement or unlink before the pass does not replace that
original. Changes within the pass refuse completion.

Run the actual committed source from a verified private source directory:

```sh
python3 -B crates/runner/tests/guarded_idle_native/file_residency_scan.py \
  "$NEW_PRIVATE_OUTPUT" --fd "$INHERITED_ORIGINAL_FD" \
  --device "$ORIGINAL_DEVICE" --inode "$ORIGINAL_INODE" \
  --invocation "$TRUSTED_INVOCATION" --source-sha256 "$TRUSTED_SOURCE_SHA256" \
  --original-sha256 "$ORIGINAL_PAYLOAD_SHA256" \
  --maximum-bytes "$MAXIMUM_ORIGINAL_BYTES" \
  --maximum-duration-ns "$MAXIMUM_ACQUISITION_NS"
```

All arguments are required. The output must be a new directory under a canonical
parent; the command never opens a payload pathname or hashes its data during
acquisition. Its source digest is SHA256 of the compact sorted JSON mapping of
the four `SOURCES` filenames to their actual byte SHA256 values. Source copying
and command setup are outside the pass span and inside the capture's clocks;
they are not omitted from the original tool record.

`events.jsonl` preserves the completed prefix, including each raw low-bit vector,
metadata/authority/observer and acquisition clocks/cost. `capture.json` retains
source hashes, declared original identity/payload digest/budgets, whole-pass
summary or error, host/clocks and positive duplicate/writer cleanup. Failure is
nonzero, even if some points or a valid file remain. Success prints the capture
SHA256 as a separate receipt. Save that receipt through the trusted execution
channel; a self-reported hash inside untrusted input is not its authority.

## Complete-original replay

After positively waiting for the producer, retain the same original FD and
unchanged generation through complete archival. Copy its complete bytes to
`original.bin` in the evidence directory, checking identity/metadata across
copying and the full declared payload hash. Do not reopen a replaced pathname.
Copying/replay can warm file caches and must not be credited to the earlier
observations or a subsequent cold case.

Run the separately trusted reader with the expected values and capture seal
from the original producer receipt:

```sh
python3 -B crates/runner/tests/guarded_idle_native/file_residency_scan_report.py \
  "$ORIGINAL_EVIDENCE" --invocation "$TRUSTED_INVOCATION" \
  --source-sha256 "$TRUSTED_SOURCE_SHA256" \
  --capture-sha256 "$TRUSTED_CAPTURE_SHA256" \
  --device "$ORIGINAL_DEVICE" --inode "$ORIGINAL_INODE" \
  --maximum-bytes "$MAXIMUM_ORIGINAL_BYTES" \
  --maximum-duration-ns "$MAXIMUM_ACQUISITION_NS"
```

The reader checks bounded regular/no-follow source, records and complete payload
files; the external seal, source and full payload digests; exact original and
observer identity/authority/metadata; gap-free ordered coverage and partial tail;
vectors/recomputed counts; clocks/costs/budgets; positive cleanup and false broader
claims. Duplicate/nonfinite JSON, extra fields, partial/misattributed records and
CLI failures refuse success. The payload is hashed in bounded chunks. Downloaded
file inodes are different: the expected identity binds the recorded original,
while local replay checks its own file's stability and complete bytes.

This replays bytes and record consistency; it does not recreate or authenticate
past kernel state independently of the trusted original execution/custody
receipts. Verify archived source bytes before executing any archived program.

## Focused regression command

```sh
python3 -B -m unittest discover \
  -s crates/runner/tests/guarded_idle_native -p 'file_residency_scan_test.py'
```

The suite uses real sparse files larger than one extent, inherited descriptors,
the public CLI and complete originals. It covers unlinked custody, whole-range
completion, actual mutation/output/budget failure and strict original replay.
Qualification can pin only small new owned endpoint pages when a stable positive
residency assertion is needed; no existing/shared input eviction, global cache
operation, induced host pressure, production service or Guest run is involved.
