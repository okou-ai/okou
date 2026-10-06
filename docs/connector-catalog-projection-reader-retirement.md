# Slug-first projection-reader retirement

## Design

Named business reads use `connector_catalog` LEFT JOIN
`connector_catalog_entries` on current hash and requested slugs in one statement.
Hash is an internal join key, not a new caller input, persistent field, cache key,
lock or cross-request pin. Readers execute SQL in their existing owner; shared
helpers only build predicates and materialize plain returned rows, never receive
a database handle. Executable-capability filtering is derived from selected
entries. Feature, account, credential-storage, grant and cancellation owners are
unchanged. Already read facts are reused after later awaits.

A slug absent from current's manifest is unknown. A manifest-listed slug with no
stored entry, or missing current, is catalog-unavailable; there is no projection,
full-gzip or R2 substitution. Empty named brief/connect requests still return an
empty list without acquiring catalog authority.

## Eight-site closure

| Site | Reader                                           | Result and ownership                                                                                                       |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| S1   | `listConnectedConnectorBriefs`                   | Named labels/icons/permission indication; no identity.                                                                     |
| S2   | `listConnectorCatalogConnectItems`, slugs branch | Named connect choices; no identity. One-click remains a full-snapshot reader.                                              |
| S3   | `getPublicConnectorCatalogStatus`                | One slug's status; no identity.                                                                                            |
| S4   | `getPublicConnectorCatalogPermissionDetail`      | One slug's permission definition; no identity.                                                                             |
| S5   | `loadConnectorAccountRuntimeSelection`           | Methods/status/storage for summaries, target lists, exact accounts and by-ID selection; no identity.                       |
| S6   | `loadCustomSnapshot`                             | Dependency metadata in the existing repeatable-read read-only transaction; metadata never grants execution.                |
| S7   | `resolveConnectorRuntimeTargetStates`            | Builtin refresh and diagnostic facts reused for exact account/grant resolution; no identity.                               |
| H1   | `loadStableContextSourceSnapshot`                | Matching identity returned from the same owning Pi transaction read, only for the existing persisted canonical comparison. |

H1 remains reachable only through `preparePiStableContext -> registerDemand ->
recapturePiStableContextInput`. A repository non-test reference scan at the base
revision finds no production caller of `preparePiStableContext`. This change does
not activate it, alter generation/authority/canonical comparison/cancellation,
or claim it is an active Run path.

## Physical retirement

- Delete projection identity and requested-row SELECTs, count/completeness and
  replacement rechecks, generation caches, in-flight reuse and full fallback.
- Delete the projection rebuild readiness SELECT and its cron reconciliation
  step/service. Keep actual publication, immutable preparation/current activation,
  compatibility reconciliation, skill registration and existing postcommit work.
- Remove projection-only publisher/preview/test writes and corruption, authority,
  set/count fixtures. Keep table declarations and historical migrations; no DROP.
- Retain canonical immutable payload equality, under `entry-payload`, without
  obsolete projection attestation/digest/row-validation contracts.

Full list/search/one-click, Automatic/DCR direct active checks, Mail/Drive full
snapshots, Runner baseline comparison and immutable bootstrap are not retired.
The bootstrap compatibility-evaluation join remains. This is not a retirement
of active snapshot, sync state or compatibility infrastructure, nor a broad
account/claim/Pi ccstate architecture migration.

## Coverage mapping

- Replace the six projection-read cases with seven public-route cases in the
  existing per-case PGlite lifecycle suite: detail/permissions, unknown slug,
  named onboarding sources/workflows, account summaries/briefs, manifest-missing
  entry and missing current rejection, and subsequent current publication.
  The missing-entry case keeps the full accepted snapshot valid, so a 503 proves
  it cannot substitute that snapshot; surviving/unknown slugs remain distinct.
  The former two public-detail/permission missing-legacy-source cases are replaced
  by missing-current assertions on those same routes and error bodies here.
- Relocate both existing account-generation cases unchanged in behavior into
  that lifecycle engine: exact-account scope review across default/publication
  changes, and removal of a catalog target. No ordinary per-case current publisher
  is added. API account construction/assertions and cleanup remain intact.
- Retire two thread-selection missing/incomplete projection fallback cases;
  the existing selected-account inspect/Run and reauthorization cases remain.
- Retain mixed builtin/custom runtime sync, exact source IDs, permissions,
  network policies, metadata/execution distinction and cancellation assertions.
  Remove projection digest injection and its duplicate fallback round.
- Remove cron assertions/faults only for projection count/rebuild/authority;
  keep acceptance/unchanged/rollback publication and compatibility authority cases.
- The lifecycle suite uses the same async-local external KMS mock as ordinary
  PostgreSQL tests, MSW-controlled HTTP and engine-owned cleanup. Drain work before
  closing PGlite; caller-owned catalog cleanup does not run after engine closure.

## Validation boundary

Scoped static/type/format checks and targeted lifecycle runs are author evidence,
not independent approval or broad CI acceptance. Existing full-snapshot and
catalog-generation suites remain pipeline responsibilities. No cancelled/skipped
case counts as an execution pass. No full local Vitest, local server, provider or
browser experiment, production action, auto-review or merge is part of this PR.
