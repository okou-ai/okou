# Pi resource version indexes

The API precomputes mount-independent discovery data for immutable Storage
versions. Each `(storage_version_id, extractor_version)` identifies a durable
projection. Deleting a Storage version cascades to its indexes. Full snapshots
retain their existing seven-day cleanup; version indexes have no time-based
expiry while their source version exists.

Instruction, workflow, custom connector skill, and official skill publishers
prepare indexes synchronously before publishing their resource reference. Generic
Storage and connector catalog commits enqueue durable work in their publication
transaction. Known-empty initial versions publish an empty projection directly.
An asynchronous publication can still be pending when its first run starts.

The indexed files retain archive entry order and path presence. Only context and
ignore text and skill frontmatter are stored; other bodies stay in Storage.
Ignored invalid UTF-8/frontmatter is recorded without failing publication.
Mounting still controls whether it is selected, and selected invalid data fails
discovery. A shared composer preserves directory overlays, filename remapping,
ignore rules, context precedence, and skill-name precedence.

On a full-snapshot miss, launch batch-loads ready indexes for the captured Storage
versions. Missing/pending indexes use exact-version archive discovery, then
persist the result. A missing version does not invalidate ready sibling indexes.
Memory is attached using the launch's already-frozen recall selection. The launch
digest and Runner/Pi snapshot formats are unchanged; full-cache keys have a
private extractor-generation namespace.

Archive limits remain 32 MiB compressed and 64 MiB expanded; the final snapshot
limit remains 2 MiB. A version index is bounded to 16 MiB and 100,000 regular file
entries. A projection outside that bound is `unindexable`, retaining the normal
archive path rather than rejecting an otherwise valid Storage upload. Invalid
archives likewise remain subject to the existing discovery errors. Ready index
shape, canonical projection hash, Storage identity, and captured archive size
are validated; corruption is not treated as an ordinary cache miss.

The cron worker claims bounded batches with `FOR UPDATE SKIP LOCKED`, five-minute
leases, and capped exponential retry delay for object-store failures. Publication
or on-demand completion clears ownership; a stale worker cannot overwrite that
result. Generic Storage and server-side volume archive repairs that change the
committed compressed size reset the projection and lease in the same transaction,
including repairs whose later HEAD publication is interrupted. An older captured
read cannot overwrite work for that repaired source. Archive I/O occurs outside database locks. There is no process-local
fire-and-forget queue.

## Rollout and rollback

Generate the additive migration with Drizzle and apply it before API promotion.
The previous API remains legal against the new schema. During the supported
mixed-API/rollback interval, old writers may create versions without index rows;
indexed readers use the same exact-version archive path for those versions.
The removal gate for this historical-miss case is issue #33619: complete retained
version backfill and exclude index-unaware APIs from serving/rollback targets.
Asynchronous pending and bounded-unindexable cases remain legitimate states.

Use the [numbered backfill](../turbo/packages/db/scripts/migrations/015-pi-resource-version-indexes/README.md)
to preview and enqueue bounded batches. A rollback selects the previous API
artifact without reverting the additive schema. No Runner/CLI protocol change,
source rewrite, or memory epoch migration is needed. Keep extractor 1 available
while a supported API uses it; a future extractor generation must explicitly
plan backfill and retirement of older generations.

## Acceptance

Production `pi_resource_snapshot_prepare` operations in the existing sandbox
operation dataset report full-cache lookup, index lookup, archive download/decode,
and composition durations, archive counts/bytes, and total resource time with the
run ID. Miss counts distinguish pending, running, unindexable, and legacy-missing
indexes. Download duration is summed across concurrent archive reads; it is not
itself critical-path wall time. OpenTelemetry `pi.resource_index.prepare` and
`pi.resource_index.materialize` spans report writer preparation duration, work
outcome, and queue-to-ready lag. Worker HTTP results distinguish ready,
unindexable, retried, and stale work. Do not infer readiness from enqueue success.

Compare cold full-cache reads with all version indexes ready, one missing/new
version, a memory-only change, and an immediate post-publication launch. Complete
ready coverage must issue no resource archive GETs or tar/gzip work. Measure
write latency and backlog as well as launch latency. Provider time and session
commit time are separate from this resource optimization; the motivating 1.09 s
trace interval is not an established latency distribution.
