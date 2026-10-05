# Connector catalog v4 consumption

Issue [#34909](https://github.com/vm0-ai/okou/issues/34909) makes the API consume
the complete v4 catalog published by
[okou-connectors #4634](https://github.com/okou-ai/okou-connectors/pull/4634).
The new API syncs and reads v4 through the existing catalog path. Production
completed the first-v4 bootstrap before the retained-v3 reader was removed under
[#34913](https://github.com/vm0-ai/okou/issues/34913).
Builtin MCP execution supports none/manual authentication and Automatic MCP
authentication, which discovers either an unauthenticated endpoint or OAuth.

## Publication and bootstrap

Publish and validate the complete v4 catalog before deploying this consumer.
It includes the existing HTTP connectors as well as explicit MCP descriptors.
The existing authenticated `GET /api/cron/sync-connector-catalog` reads
`connectors/v4/active.json`, validates the referenced immutable release, and
transactionally accepts its snapshot, compatibility evaluation and projections.
It uses the existing cron bearer secret and normal runtime wakeup behavior.
Permission-bundle change detection compares against the currently serving
accepted v4 snapshot. Unchanged bundles send no wakeup; changed or removed
bundles notify affected custom connectors through the existing runtime sync
path.

The existing release workflow and best-effort post-deployment sync are unchanged.
The shared accepted-catalog reader requires an accepted v4 snapshot. A cold
environment reports the catalog as unavailable until normal sync succeeds; it
does not select a retained v3 snapshot. No environment variable,
serving-generation selector or separate warm-up endpoint is needed. Existing
scheduled syncs keep v4 current. MCP methods do not need to be executable for v4
acceptance: filtered methods are expected.

## Additive hash-addressed preparation (P3)

The existing pointer and accepted-snapshot readers remain the only serving
path; reader migration is separate. Sync now prepares connector skill storages
and exact immutable versions outside the activation transaction, without
changing connector skill HEADs. Other storage HEAD behavior is unchanged.
It then inserts the original connector payloads into
`connector_catalog_entries` under the captured complete `sha256:<64 lowercase hex>`
digest (also used by current, baseline and unchanged comparisons). Bare hex is
only an object-path component, not a second database identity. It ignores identical
insert conflicts, rejects conflicting canonical bytes, and verifies the exact
manifest slug set. Failed preparation leaves the serving snapshot unchanged;
completed immutable work remains reusable on retry.

Sync subcommands receive source/capability/validator values and captured facts,
not reader callbacks, DB handles, accessors or signals in runtime objects.
Pointer conditional downloads and bounded artifact downloads run inside their
owning commands through existing S3 gateways. A shared pure byte validator keeps
the original size, digest, schema and relationship checks; existing reader clients
retain their loader API. Retry attempts re-observe the baseline and pointer.

Stable commands obtain the existing DB gateways internally. The owning sync
command keeps legacy acceptance, new `connector_catalog` hash CAS and Pi
stable-context invalidation in one transaction callback. New helpers build
pure values or SQL conditions; they do not accept a DB/transaction handle.
Cold start inserts the current row explicitly. A lost hash CAS rolls back the
transaction; the same hash does not repeat activation effects. Initializing a
missing additive mirror of the already-serving digest also does not invalidate
Pi or replay wakeups. Only a committed serving-digest switch attempts the
existing best-effort wakeups after commit. Wakeup failure does not undo the
committed catalog, and a same-hash retry is not a delivery replay.

## Scoped immutable readers (P4a first batch)

The selection branches for executable-slug checks, stored builtin connector
lists and Run MCP discovery now read the immutable tables. One statement
captures the supported current schema/hash, raw header, exact slug manifest
and the union of runtime and metadata dependencies. A later read may supply
that plain capture and queries entries at its fixed hash, never current again.
Unknown manifest slugs retain the existing unknown/absent behavior; a missing
current or a missing manifest member fails fast. There is no R2, gzip snapshot,
compatibility-table or runtime-projection fallback on these branches.

Raw JSONB column contracts describe the publisher/sync-owned schema shape;
the reader does not recompile relationships or recompute hashes. It uses the
raw entries returned by the statement directly, without a process-level raw
cache or computed-owned cache writes/eviction. Entry identity remains the
captured `(hash, slug)` pair. Each selection derives code capability filtering
afresh; no derived cache crosses capability or request boundaries. Features,
exact accounts, credential versions and grants remain with their existing
request owners. Metadata-only dependencies do not enter the executable
connector map or runtime firewall selection. Actual manifest-member presence
is checked on every read.

This is not the full reader cutover. Account lifecycle's legacy helper graph,
the transaction-bound runtime-sync reads, Pi stable-context recapture's legacy
source identity, independent chat capture, full-directory/firewall consumers
and permission baselines remain on their existing paths. Subsequent batches
must migrate those contracts without fabricating a legacy identity/validator.
The P2 schema and P3 prepare/activate writer are stacked prerequisites. The
first batch neither drops legacy tables nor introduces an old-API rollback
window or garbage collection. N4/N5 exercise real cron and authenticated MCP
consumer behavior in the sole per-case PGlite suite, including fixed-hash reads,
back-to-old-hash reuse and missing-vs-unknown fail-fast behavior. N1 remains
unimplemented for its later publisher-pointer stage.

### P4a removed-mechanism assertion ledger

| Retired mechanism/expectation                                                                                    | Replacement and retained boundary coverage                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process-level raw-entry cache writes inside computed readers                                                     | Cache removed, not moved behind another helper. Same current/entry statement and captured-hash reads remain; N4 retains old→new→old hash, metadata isolation and capability-change coverage. No new cache framework or SQL-count improvement is claimed.                                                                                                                                                                                                   |
| `connectors-list.test.ts`: migrated stored list becomes empty solely because legacy compatibility is unavailable | The public list must retain the exact pre-invalidation response when immutable current/entries remain intact, including the exact stored account ID, auth method/status and binding metadata. The same case retains all six legacy lifecycle/scope-diff 404/code checks and the unavailable inspect result. N5's missing immutable current/member versus unknown-slug checks remain unchanged. No test case is deleted and no legacy fallback is restored. |

This ledger records source coverage, not a claim that pending or cancelled
native cases have executed successfully.

## Transitional ordinary-test publication containment

The immutable serving pointer is schema-global, unlike the legacy source-owned
rows. Source cleanup does not restore this pointer, and a later shared fixture
setup is not a reset. Whole-file serialization is therefore insufficient when
fixed-catalog readers and generation writers share a file/project.

Fixed readers stay in their original files/projects. Dedicated
`*.catalog-generation.test.ts` files contain only the existing generation
contracts, run serially in group 3 after ordinary readers, the fixed catalog
project (group 1), and bootstrap readers (group 2). The two restricted-manifest
cron suites run in group 4. Each generation contract first publishes its own
prerequisite generation; it does not assume the preceding file's current hash.
Existing cleanup may republish that case's own contract generation for safe
account deletion, but no global snapshot/restore or default-catalog reset is
introduced. Case-internal request concurrency is unchanged. This is transitional
containment while legacy mechanisms remain, not the v5/P6/P7 terminal design.

### Case movement / removed-publication ledger

Each row moves the original registration body without changing its tokens,
assertions, authentication, account/method/version identity or owned cleanup.
The target is the same filename stem plus `.catalog-generation.test.ts`.

| Original file                              | Moved contract(s)                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector-accounts.test.ts`               | Exact-account requested scopes across default changes; removed builtin target absent                                                            |
| `connector-check.test.ts`                  | Stale stored connector absent from accepted catalog                                                                                             |
| `connectors-automatic-security.test.ts`    | Frozen consent rejects changed endpoint with unchanged storage version                                                                          |
| `connectors-automatic.test.ts`             | In-flight callback rejects changed storage contract                                                                                             |
| `connectors-by-slug-get.test.ts`           | Stored runtime method unavailable returns 404/code                                                                                              |
| `connectors-list.test.ts`                  | Unavailable stored runtime method excluded, healthy public catalog facts retained                                                               |
| `connectors-scope-diff.test.ts`            | Unavailable runtime method returns 404/code                                                                                                     |
| `mail.test.ts`                             | Known Gmail storage-version mismatch never refreshes provider                                                                                   |
| `run-lifecycle.bdd.test.ts`                | Exact Automatic none/oauth admission and outside-sandbox injection; none/oauth reconnect retains catalog auth (two parameterized registrations) |
| `webhooks-agent-firewall-auth.bdd.test.ts` | Known storage-version mismatch never calls provider                                                                                             |

Twelve registration blocks (fourteen expanded cases) move; none is deleted or
skipped. Original fixed Automatic siblings, API6 connect/list/status/grant/auth
assertions, API2's strengthened stored-list contract and bootstrap cases remain
before these writers. Native N3's `Promise.all` competition and ordinary cron's
overlap sync/concurrent reads are unchanged.

The pure `connector-accounts.test.ts` 101-account pagination fixture no longer
publishes a catalog per case. It uses the existing shared fixed descriptor while
retaining all 101 API-created accounts, bounded parallel creation/deletion,
pagination cursors, summaries and case-owned account cleanup. No replacement
self-installing fixture, ordinary PGlite/DB adapter or production fallback is
introduced. Native bootstrap, actor membership and five-engine lifecycle guards
are unchanged. Historical execution failures and the absent failure-time hashes
remain historical limitations; source containment and green CI do not prove the
old run's complete causal chain or deployed acceptance.

### Split-file dependency cleanup

The 5536 cohort passed all eight API jobs but failed required API lint with
232 unused-dependency warnings; its business results are not a lint pass.
The follow-up removes unused imports and uninvoked helper/constant/type copies
from nine generation files. Their useful originals remain in the fixed-reader
files, including the 101-account pagination and bounded MCP awareness checks.
No registration, live assertion, actor/context initialization or cleanup hook
is removed. All twelve moved registration bodies remain token-identical;
that receipt is not a substitute for dependency review or new-head execution.
Native, production readers, scheduler barriers and the three main resolutions
are unchanged. Prior scoped lint did not fully cover the new files; its
warning-clean claim is corrected rather than carried forward.

## Identity and failure behavior

The pointer must name `connectors/v4/releases/<catalogVersion>/catalog.json`.
Candidate validation and snapshot writes accept only v4. Persisted snapshot
readers verify the accepted v4 generation's schema, original-byte digest, size
and semantic validity. Existing database keys isolate sync and accepted state by
`(sourceId, schemaVersion)`. Compatibility evaluations additionally bind catalog
version, digest, executable capability digest and validator authority.
Projection sets bind the same catalog identity, and their child rows bind a set
ID and payload digest. No database migration is required.

The persisted-snapshot source salt remains 3. It isolates a historical decoder
size limit and is unrelated to the catalog format version. Old API binaries
continue reading their existing v3 namespace and rows; new APIs never rewrite or
delete those pointers, snapshots or immutable publication objects.

A missing or invalid candidate records a failed attempt and leaves the accepted
v4 state unchanged. Once v4 has been accepted, later failed syncs retain it; an
invalid accepted v4 snapshot fails. The reader never selects v3.

Diagnostics describe the v4 sync target: `schemaVersion`, `state` and `active`
refer to the generation serving through the reader. A cold diagnostic state
means connectors are unavailable until v4 sync succeeds.

## MCP capability boundary

Explicit `mcp` metadata determines the protocol. Consumers never validate or
interpret the `-mcp` naming convention. Every MCP descriptor must declare
`skill: { kind: "none" }`; no skill resources are registered for it. Existing
HTTP connectors retain bundled skill support and exact-version mounting.

The reader validates endpoint, ownership, replacement and none/Automatic auth
metadata. MCP none/none and manual/static methods with no-op revocation are
executable, as are Automatic grant/access pairs. Provider-backed MCP methods
remain filtered until their handlers are installed. These expected filters do not emit warning or
error logs and do not reject an otherwise valid catalog. MCP generated firewalls
participate in named builtin execution, but cannot supply HTTP permission bundles
or permission editors. Existing supported HTTP methods remain usable through v4.

Builtin MCP uses the current CLI without client-version negotiation or requiring
its package URL to match the serving API commit. Its signed builtin account
mapping comes from the final admitted runtime targets; later default changes
cannot substitute another account. MCP credential values and aliases remain
outside the sandbox environment and skill mounts. The proxy resolves the exact
selected account at the network boundary when credentials are needed. Shared
MCP discovery supplies tools and schemas. No-auth builtin and custom MCP skip
credential validity checks and proxy auth resolution, including Automatic builtin and custom
MCP accounts resolved to no authentication.
Credentialed builtin MCP authorization is cached for at most 30 seconds from account
validation, even when the provider credential has no expiry. Deleting an
account removes it from discovery immediately; subsequent proxy requests can
reuse cached authorization until its lease expires, then must validate the
same account again. Lease expiry does not interrupt an in-flight request or
stream. No-auth requests have no account authorization lease. Credentialed HTTP
and custom connector cache behavior is unchanged.

## Runtime change reconciliation

Accepted changes to a connector's runtime-bearing `mcp`, `authMethods` or
`firewall` fields wake affected builtin HTTP and MCP Runs so the Runner resolves
the current endpoint, credentials and firewall policy. Removal and later
restoration use the same wakeup path.

After the current accepted catalog loads successfully, an exact catalog-owned
builtin connector target that the catalog no longer contains resolves as
terminal `absent`. The Runner removes only that connector's managed policy and
credential injection, preserves the Run, sibling targets and target
registration, and schedules no retry. A later restoration wakeup can therefore
resolve the same target as `available` again. Catalog load, transport, parsing
and validation failures are not absence. A catalog-present target whose account,
credential or policy cannot currently resolve remains retryable `unresolved`
and retains its last-known-good runtime state. Local `model-provider:*`
firewalls are not connector runtime targets and remain outside this catalog
absence classification.

Removing a connector from the catalog removes that owner from request matching,
without selecting another connector's credentials at the same destination.
Ordinary outbound traffic remains subject to the normal outbound policy; catalog
removal does not install a route tombstone for the former provider endpoint.

## Automatic authentication

Builtin Automatic authentication uses the catalog's exact method ID and endpoint.
The API owns start and callback routes and shares MCP OAuth discovery, PKCE,
resource indicators, CIMD and DCR protocol handling with custom MCP. Builtin
registrations and account bindings have separate storage ownership. An account
records whether discovery resolved to no authentication or OAuth; access tokens
and optional refresh tokens remain encrypted, outside the Run environment.
OAuth completion receipts identify the actual connected account and attempt.

Deploy the additive builtin OAuth schema migration before the API. OAuth runtime
resolution validates the stored binding and serializes refresh and token rotation.
Automatic connection commits, token resolution and shared DCR client retirement
lock the organization and connector before account rows, including reconnects
across authentication methods. Registration ownership remains specific to the
method and catalog contract. Refresh takes the existing account-owner target lock
before the account row; retirement takes each linked owner's target lock before
their rows so ordinary account deletion and default changes cannot invert that order.
Providers without refresh tokens work until the access token expires. A no-auth
account bypasses credential validity, storage-version and refresh checks. Each Run
receives the same compact builtin firewall reference used by builtin HTTP connectors.
The runner resolves its firewall definition from the accepted catalog without
replacing or overriding its authentication policy from account state. Automatic
discovery records whether the selected account resolved to OAuth or no-auth, but
the catalog remains authoritative because that requirement is fixed for a service.
An OAuth catalog firewall uses `Bearer ${{ secrets.MCP_ACCESS_TOKEN }}`; the API
resolves that proxy-only token outside the sandbox for the exact selected account.
If a no-auth account is paired with an OAuth firewall, resolving the firewall's
required secret fails closed. If an OAuth account is paired with a no-auth firewall,
the proxy sends no credential and the upstream rejects the unauthenticated request.
OAuth auth requests carry the matched catalog endpoint. The API checks it against
the accepted catalog and account binding before returning credentials, including
after waiting for account locks. A stale or missing destination is rejected without
invalidating a newly reconnected account. This check does not depend on successful
runtime-sync notification delivery and does not apply to no-auth accounts.

The existing auth-method discovery switch `plaudConnector` defaults off and
controls only `plaud-mcp / automatic`. It does not gate existing account
callbacks, discovery during Runs, credential resolution or refresh. Other
Automatic MCP connectors do not inherit this switch.

## Rollback and remaining integration

Terminal builtin absence has an explicit reader-first deployment boundary. First
deploy the Runner consumer from [#35542](https://github.com/okou-ai/okou/pull/35542)
to every serving Runner group. The API producer in
[#35598](https://github.com/okou-ai/okou/pull/35598) must remain undeployed until
incompatible Runner processes and their active sandboxes have drained. Per the
maintainer decision on 2026-09-20, rollback to Runner artifacts without that
reader is outside this rollout's supported compatibility boundary; recovery
after activation must use a reader-capable Runner. This ordering replaces
capability headers, Runner version checks and response downgrades; a merged
Runner PR or elapsed time alone is not deployment evidence.

Live Plaud acceptance and same-service replacement remain work under
[#34157](https://github.com/vm0-ai/okou/issues/34157).
No production release, storage pointer change or provider authorization is
performed by this implementation PR itself.

Production diagnostics reported active catalog `2026-09-19.4560` on 2026-09-20
Asia/Shanghai, after the released v4 consumer had completed bootstrap. That
production adoption opened the current-reader cleanup gate. Development and
preview environments must likewise complete normal v4 sync before current APIs
can serve connectors.

Rolling back to an older API restores that binary's retained v3 data path.
Historical v3 pointers, rows, snapshots and immutable objects remain available
for those binaries and are not rewritten or deleted by the current v4-only
reader. Rollback binaries must also retain the execution and credential readers
needed by connections created after v4 adoption; restoring an older binary alone
is not a complete recovery for those connections.

Diagnostics are staff-only behind `OkouDebug` and use the current v4 contract
without an old-API compatibility bridge. There is no serving selector or warm-up
endpoint to retire.

## Producer evidence

The verified first complete publication is source commit
`985039aaa1bfef5bd93952913e8f9fd7ee077a79`, catalog `2026-09-17.4559`, from
[publish run 35209618715](https://github.com/okou-ai/okou-connectors/actions/runs/35209618715).
It contains 4,595 HTTP connectors and Plaud. The full catalog digest is
`sha256:caa97a427cda78f72840a1279da97a607c6d8aea7eb6b5c3277f203de923b987`.
Tests retain seven exact published descriptors with excerpt provenance. The
complete catalog and all 13,705 immutable resource digests are verified separately
without committing the 30 MB catalog to this repository.
