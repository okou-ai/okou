# Guest file transfer compression

Session history can remain large under the normal retention rules. Compression
here changes only Runner-to-Guest transport, not the history file, its native
format, cache identity, checkpoint pruning or the 64/128 MiB history limits.

## Ownership

The business caller selects `FileCompression::None` or `Zstd` once per file and
passes it through `Sandbox::write_file_with_compression`. The transport honors
that choice for every request, including empty, small and incompressible files.
It does not sample content, apply a size threshold, retry raw after an error, or
store a connection-wide compression mode. Concurrent callers choose independently.

Ordinary `write_file`, private-file and batch APIs keep their existing raw paths.
The first compression consumer is Runner's shared session-history restore writer.
It keeps native-zstd histories and raw histories below 16 MiB uncompressed on the
wire. For larger raw histories it samples eight evenly distributed 64 KiB windows;
each must compress to at most half its original size before it opts into zstd.
Sampling copies at most 512 KiB into an owned worker, checks cancellation between
windows and joins that worker on completion or drop.

The threshold and sample are conservative initial business policy, not a universal
compression-benefit guarantee. Heterogeneous content can pass the sample and still
compress poorly. Encoding can then increase CPU without materially reducing bytes.
Small files and known already-compressed representations do not pay that sampling
or encoding cost. Selection errors propagate instead of fabricating a raw result.

## Protocol and resources

The existing file-operation lane admits one request at a time. Files larger than
15 MiB retain their unique staging sibling and final atomic rename; requests
remain limited to 15 MiB of decoded bytes so other files can make progress between
requests. Single-request writes retain ordinary create/truncate semantics: a
failed write may leave partial bytes, and is never reported as successful.

Each compressed request has these messages:

- BEGIN declares codec tag 1 (zstd), raw byte count and ordinary write metadata.
- DATA carries at most 64 KiB of encoded bytes. Four frame credits bound in-flight
  input; a shared connection reader only uses nonblocking queue admission.
- END explicitly finishes input. The existing file-write result is sent only
  after helper completion and stdin ownership have been resolved.

The encoder uses zstd fast level 1 (compression level -1), a pledged source size
and a checksum, resetting per request. The identity-constrained file helper checks
the zstd frame signature/checksum flag, limits the decoder window to 16 MiB,
requires the exact declared output length and rejects truncation, corruption,
trailing bytes and concatenated frames. Encoded input is bounded to 16 MiB per
request. See the [Zstandard frame specification](https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md).

The host retains the source history and copies at most one 15 MiB request into its
owned encoder. Bounded queues, buffers and codec state add memory; this is not a
constant-total-memory restore. Encoding checks cancellation between 64 KiB inputs.
Dropping its bounded sink releases a blocked producer before joining it. Abandoning
a possibly admitted compressed request closes the connection to stop/reap Guest
work; cancellation before the first frame retains the existing reusable state.
Existing 30-second helper and 60-second request deadlines remain unchanged.

Guest identity, regular-file/no-follow checks, path ownership, operation admission
and quiescing still apply. Admitted DATA/END continuations can finish after new
operations have been fenced. Compression does not create a separate bypass lane.

## Deployment and verification

Runner, guest-init/control server and file helper ship as one artifact. Mixed
versions of those binaries are not supported; no codec negotiation or compatibility
fallback is added. API contracts and persisted representations are unchanged.
Existing raw and native-zstd histories remain readable by old and new Runners.
Restored-byte telemetry continues to count logical file bytes, not wire bytes.

The file client also returns successful per-file payload and Host timing
measurements through the Sandbox compression API. History restores expose these
separately from representation metadata; see
[history transfer measurements](workspace-history-restore-telemetry.md#history-transfer-measurements).
They do not change codec selection or file semantics. Encoder pipeline wall
time includes backpressure and overlaps request time, rather than measuring
isolated encoding CPU.

Tests cover the public client/server/helper path, stream failure and cancellation,
concurrent caller choices, preserved raw/private/batch writes and actual history
restore selection. Isolated synthetic measurements are implementation evidence,
not a claim about production startup p90 or zero CPU regression. Selective
compression was delivered under the closed
[#32931](https://github.com/vm0-ai/okou/issues/32931); follow-up attribution and
the optimization/no-change decision belong to
[#34728](https://github.com/vm0-ai/okou/issues/34728).
