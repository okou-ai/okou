# Connector catalog v4 reader preparation

Issue [#34909](https://github.com/vm0-ai/okou/issues/34909) prepares the API to
consume the generated catalog from
[vm0-connectors #4634](https://github.com/vm0-ai/vm0-connectors/pull/4634).
The default serving generation remains **3**. Reader support does not enable
built-in MCP execution or Automatic OAuth.

## Selection and warm-up

`CONNECTOR_CATALOG_SERVING_GENERATION` accepts `3` or `4` and defaults to `3`.
An invalid configured value fails environment validation. Normal catalog reads,
sync, diagnostics, compatibility reconciliation and runtime projection reads
use that explicitly selected generation. They never retry another generation.

The existing authenticated `GET /api/cron/sync-connector-catalog` syncs the
selected serving generation. The new authenticated
`GET /api/cron/warm-connector-catalog-v4` always validates and warms generation 4. Both require the existing cron bearer secret. The warm-up endpoint is not
scheduled by this change and is not called by ordinary catalog reads. Calling
it does not change serving configuration or publish runtime permission-bundle
wakeups. It returns `409 CONFLICT` once v4 is already serving; use normal sync
then, so a live catalog change still publishes the required wakeups. Warm-up
can register existing HTTP bundled skill versions, but MCP entries
must declare `skill: { kind: "none" }` and register no skill.

Warm-up performs the complete candidate validation and uses normal transactional
acceptance and reconciliation to write v4 snapshot, compatibility and projection rows. Its
response identifies `schemaVersion: 4`, the accepted version/digest, rejected
candidate, last attempt, and filtered methods. New APIs also identify the
generation in ordinary diagnostics; this additive field can be absent on older
API responses.

## Identity and failure behavior

Each generation has its own `connectors/vN/active.json` and strict decoder.
A v4 pointer cannot select a v3 object, and a v4 payload cannot pass a v3
decoder. Schema selection also applies to persisted and attested snapshot reads.
Original v3 bytes and historical objects are never rewritten.

Existing database keys already isolate sync and accepted state by
`(sourceId, schemaVersion)`. Compatibility evaluations additionally bind the
catalog version, digest, executable capability digest and validator authority.
Projection sets bind the same catalog identity; their rows bind a set ID and
payload digest. Reads and cleanup remain generation-scoped. No schema migration
is required. The persisted-snapshot source salt stays at generation 3: that salt
isolates a historical decoder-size limit and is unrelated to catalog v3/v4.

A missing or invalid candidate records a failed attempt and retains only that
generation's last accepted snapshot. A cold generation remains unavailable.
Selecting v4 with missing or rejected v4 data never serves an accepted v3
snapshot as a substitute. Use the response's attempt and stale state to assess
freshness; an available retained snapshot alone does not prove currentness.

Explicit `mcp` metadata determines the protocol. Slug suffixes are never checked
or interpreted by consumers. The reader validates MCP endpoints, ownership,
replacement and auth metadata, but support for a declaration is distinct from
permission to execute it. Until the execution/OAuth slices land, all MCP methods
are filtered with `unsupported-protocol`, and none/Automatic methods also lack
executable grant/access providers. Runtime materialization independently refuses
those methods. Existing HTTP methods retain their prior behavior.

## Activation, rollback and bridge removal

This preparation PR changes neither storage pointers nor deployed configuration.
Before an explicitly authorized v4 activation:

1. Deploy generation-aware readers across serving and supported rollback APIs.
2. Warm the actual complete v4 publication and inspect its generation, digest,
   acceptance and capability results.
3. Complete the execution, Automatic OAuth and same-service replacement slices
   tracked by [#34157](https://github.com/vm0-ai/okou/issues/34157), and verify the
   required methods are executable before making them available to users.
4. Change the serving selector only as a separately authorized activation step.

Before v4 connections exist, explicitly restoring the selector to `3` restores
the independently retained v3 serving state. After v4 connections are created,
rollback must preserve the execution and credential readers required by those
connections; a blind selector or API rollback is not a complete recovery plan.

The dual reader is a bounded compatibility bridge for currently served v3 data
and rolling APIs. [#34913](https://github.com/vm0-ai/okou/issues/34913) owns its
removal after v4 activation, accepted v4 snapshots/projections, required execution
and auth capability, and removal of v3-only serving and supported rollback APIs.
That cleanup removes the v3 selector/reader, temporary warm-up surface and
tolerance for diagnostics without a generation field together; it must not
delete immutable historical publication bytes implicitly.

## Producer evidence

The verified first complete publication is source commit
`985039aaa1bfef5bd93952913e8f9fd7ee077a79`, catalog `2026-09-17.4559`, from
[publish run 35209618715](https://github.com/vm0-ai/vm0-connectors/actions/runs/35209618715).
It contains 4,595 HTTP connectors and Plaud. The full catalog digest is
`sha256:caa97a427cda78f72840a1279da97a607c6d8aea7eb6b5c3277f203de923b987`.
Tests retain a small, explicitly filtered descriptor fixture with provenance;
the full downloaded catalog and all 13,705 immutable resource digests are checked
separately without committing the 30 MB catalog to this repository.
