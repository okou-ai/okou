# Home history restore telemetry

The writable home image and session-history restoration have distinct authority.
A home-image cache hit is not exact VM reuse and does not, by itself, authorize a
history skip. Join observations with the existing `run_id`; do not place paths,
framework session IDs, history hashes, bodies, prompts, credentials or environment
values in telemetry labels.

## Verified retained history

The fixed `/home/user/.vm0/home-cache/session-history-proof.json` contains only
bounded versioned identity/source/hash/size facts and the publication generation,
not a history body or a private runtime tree. Committed image metadata binds its
canonical digest to the same immutable image generation. A lease supplies a
candidate binding, never history authority.

After applying current captured storage, instructions, skills, memory, account,
model, auth, permissions and proxy configuration, the Guest verifies the binding,
current request and the actual supported source the CLI will consume. Live raw or
zstd bytes are checked with existing digest, size, ambiguity, containment and
no-follow rules, including at consumption. VM provenance, metadata presence and
scheduler affinity are not substitutes for this verification.

Only successful source/live-byte verification can produce the prepared
`home_cache` source. Missing, stale, corrupt, wrong-generation, wrong-framework,
wrong-session, changed-source or unsupported/out-of-home evidence uses the
existing authoritative remote restoration path. Cancellation drains owned work;
it is not a successful cache miss. Replacing a prepared image invalidates the
candidate before pristine retry. A legitimate exact-resource verification outside
home is not a home-image hit.

There is no home-cache-specific history-body export, host slot, copy-back or local
sidecar materializer. A verified retained skip performs no duplicate body transfer:
do not invent transfer bytes, write requests or transport time for it. Preserve
separate cache outcome diagnostics for no key, lock contention, invalid metadata,
disk pressure, miss, preparation fallback and hit.

## History transfer measurements

`session_history_transfer` measures a complete actual restore attempt, including
framework validation and requested-session Codex cleanup before replacement,
independent of VM provenance. Its duration overlaps `session_restore`; do not add
those intervals. `downloaded` identifies the remote-reference materializer's
result, including ordinary download caches, not proof that HTTP was used.
`inline` identifies captured inline history. A home verification miss followed by
remote restoration is not a successful home-cache transfer.

Successful actual writes may include:

| Field                                    | Meaning                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `session_history_wire_codec`             | Caller-selected `none` or `zstd`, independent of stored representation           |
| `session_history_codec_decision`         | `native_zstd`, `below_threshold` or `above_threshold` (including exactly 16 MiB) |
| `session_history_selection_ms`           | Host wall duration of representation/size selection                              |
| `session_history_transfer_bytes`         | Logical Guest file payload length before optional wire compression               |
| `session_history_restore_representation` | Logical payload `raw` or `codex_zstd`                                            |
| `session_history_wire_bytes`             | Completed DATA payload bytes, excluding framing/control/replies                  |
| `session_history_write_requests`         | Completed file requests, including an empty-file request                         |
| `session_history_file_gate_wait_ms`      | Sum of Host shared file-operation gate waits                                     |
| `session_history_requests_ms`            | Sum of sequential request envelopes after admission through terminal validation  |
| `session_history_encoder_pipeline_ms`    | Overlapping Host encoder pipeline wall time, not encoding CPU time               |
| `session_history_publication_ms`         | Final chunked-file rename duration; zero for one-request writes                  |

Request envelopes include source copying, admission, encoding, transport, Guest
helper startup and decode/write/terminal-response wait. They do not isolate Guest
disk I/O. Encoder time overlaps the envelope; raw requests have zero encoder
pipeline duration. Independent rounding can lose fractions. Do not derive a
Guest-only residual or add independent percentile values.

Wire measurements exist only after the whole file and required publication
succeed. Failure may have transferred bytes but omits successful fields. The mock
backend has no wire transport and omits wire/count/stage fields. Missing values
on any backend or version are unknown, not zero. Reference histories retain the
128 MiB logical ceiling and existing per-request limits; this does not introduce
a new inline-history ceiling. General CPU/download/cache/cancellation ownership
remains unchanged.

## Terminal publication and reader compatibility

Last history/identity/log readers finish before proof capture and terminal
namespace/auth cleanup. The Guest then freezes home; the Runner must successfully
terminate the sandbox before publishing the generation-owned image. The image,
metadata staging and affected directories are synchronized before the atomic
metadata commit exposes the image/fingerprint/taint/proof tuple. A failed cleanup,
freeze, stop or uncertain commit rejects optional publication without changing an
already completed Run. A frozen sandbox cannot return to idle/handoff. Cleanup
proves namespace absence, not forensic erasure of deleted ext4 blocks.

Deploy compatible schema/API and strict telemetry/webhook readers before
activating writers, together with paired Guest/Runner artifacts. Follow
[deployment compatibility](../deployment-compatibility.md) for independently
deployed readers, captured callbacks and inventory observation ownership.
Invalid or unavailable evidence still uses generic scheduling and normal
authoritative execution. Merge and CI are not activation or deployment receipts.

Remove executing protocol and SQL dependencies before physical schema
contraction. Deploy that column-independent application first, then drain the
preceding SQL and rollback targets before a later release drops retired columns.
See [deployment compatibility](../deployment-compatibility.md) for the shared
reader-first, generated-SQL, deployment-drain and rollback requirements. This
guide does not authorize rollout, floor activation, SQL execution or cache purge.

Compare containing artifact/API cohorts, source, framework, size, representation,
outcome and missing-field coverage. Removing duplicate body I/O is not a measured
startup speedup; controlled native resume/append/finalization evidence and live
post-deployment measurements remain separate requirements.
