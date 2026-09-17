# Connector catalog v4 consumption

Issue [#34909](https://github.com/vm0-ai/okou/issues/34909) makes the API consume
the complete v4 catalog published by
[vm0-connectors #4634](https://github.com/vm0-ai/vm0-connectors/pull/4634).
The new API reads only v4 through the existing catalog sync and read paths.
Catalog support does not enable built-in MCP execution or Automatic OAuth.

## Publication and bootstrap

Publish and validate the complete v4 catalog before deploying this consumer.
It includes the existing HTTP connectors as well as explicit MCP descriptors.
The existing authenticated `GET /api/cron/sync-connector-catalog` reads
`connectors/v4/active.json`, validates the referenced immutable release, and
transactionally accepts its snapshot, compatibility evaluation and projections.
It uses the existing cron bearer secret and normal runtime wakeup behavior.

There is one catalog reader and one sync endpoint. No serving-generation
configuration or separate warm-up endpoint is needed. Existing scheduled syncs
keep v4 current after bootstrap.

Production deployment stages the new API without moving the serving domain,
then calls the normal sync endpoint on that exact deployment. Promotion requires
`schemaVersion: 4`, a non-null accepted snapshot and current compatibility
evaluation (`filtering.stale: false`). A valid retained v4 snapshot is sufficient
when the latest candidate is unavailable or rejected; a cold catalog is not.
A failed request, malformed response or missing accepted state blocks promotion.
This does not require MCP methods to be executable: filtered methods are expected.

## Identity and failure behavior

The pointer must name `connectors/v4/releases/<catalogVersion>/catalog.json`.
Candidate and persisted snapshot readers verify v4 schema, original-byte digest,
size and semantic validity. Existing database keys isolate sync and accepted
state by `(sourceId, schemaVersion)`. Compatibility evaluations additionally bind
catalog version, digest, executable capability digest and validator authority.
Projection sets bind the same catalog identity, and their child rows bind a set
ID and payload digest. No database migration is required.

The persisted-snapshot source salt remains 3. It isolates a historical decoder
size limit and is unrelated to the catalog format version. Old API binaries
continue reading their existing v3 namespace and rows; new APIs never rewrite or
delete those pointers, snapshots or immutable publication objects.

A missing or invalid candidate records a failed attempt and retains the last
accepted v4 snapshot. A cold v4 catalog is unavailable until normal sync accepts
a valid publication. There is no read fallback to v3. Inspect attempt and stale
state separately from availability when assessing freshness.

## MCP capability boundary

Explicit `mcp` metadata determines the protocol. Consumers never validate or
interpret the `-mcp` naming convention. Every MCP descriptor must declare
`skill: { kind: "none" }`; no skill resources are registered for it. Existing
HTTP connectors retain bundled skill support and exact-version mounting.

The reader validates endpoint, ownership, replacement and none/Automatic auth
metadata. All MCP methods remain filtered with `unsupported-protocol` until the
execution/auth slices land; unsupported generic auth also appears in capability
diagnostics. These expected filters do not emit warning or error logs and do not
reject an otherwise valid catalog. Runtime materialization and HTTP firewall
permission-bundle lookup independently exclude MCP. Existing supported HTTP
methods remain usable through v4.

## Rollback and remaining integration

Deploying this consumer selects v4 directly. Enabling MCP execution, Automatic
OAuth and same-service replacement remains work under
[#34157](https://github.com/vm0-ai/okou/issues/34157).
No production release, storage pointer change or provider authorization is
performed by this implementation PR itself.

Before v4-only connections or service replacements exist, rolling back to an
older API restores its retained v3 data path. Once those changes exist, supported
rollback binaries must retain the execution and credential readers needed by
their connections; restoring an older binary alone is not a complete recovery.
Historical immutable v3 objects are retained, not deleted by this transition.

The new diagnostics contract accepts an omitted generation field from older
serving/rollback APIs. [#34913](https://github.com/vm0-ai/okou/issues/34913) owns
removing that client compatibility after the old APIs leave the supported window,
along with any separately introduced client bridges. There is no dual catalog
reader, serving selector or warm-up endpoint to retire.

## Producer evidence

The verified first complete publication is source commit
`985039aaa1bfef5bd93952913e8f9fd7ee077a79`, catalog `2026-09-17.4559`, from
[publish run 35209618715](https://github.com/vm0-ai/vm0-connectors/actions/runs/35209618715).
It contains 4,595 HTTP connectors and Plaud. The full catalog digest is
`sha256:caa97a427cda78f72840a1279da97a607c6d8aea7eb6b5c3277f203de923b987`.
Tests retain seven exact published descriptors with excerpt provenance. The
complete catalog and all 13,705 immutable resource digests are verified separately
without committing the 30 MB catalog to this repository.
