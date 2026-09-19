# Connector catalog v4 consumption

Issue [#34909](https://github.com/vm0-ai/okou/issues/34909) makes the API consume
the complete v4 catalog published by
[vm0-connectors #4634](https://github.com/vm0-ai/vm0-connectors/pull/4634).
The new API syncs v4 through the existing catalog path and temporarily reads
retained accepted v3 data until the first v4 snapshot is accepted.
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
accepted snapshot, including retained v3 during first-v4 bootstrap. Unchanged
bundles send no wakeup; changed or removed bundles notify affected custom
connectors through the existing runtime sync path.

The existing release workflow and best-effort post-deployment sync are unchanged.
While a source has no accepted v4 snapshot, the shared accepted-catalog reader
uses its retained accepted v3 snapshot for connector discovery, execution and
firewall permissions. Normal sync accepts v4 and subsequent reads select it
automatically. No environment variable, serving-generation selector or separate
warm-up endpoint is needed. Existing scheduled syncs keep v4 current.

This read bridge protects existing connectors while the first v4 sync is pending
or fails. An installation without any accepted v3 or v4 snapshot still needs a
successful sync before connectors are available. MCP methods do not need to be
executable for v4 acceptance: filtered methods are expected.

## Identity and failure behavior

The pointer must name `connectors/v4/releases/<catalogVersion>/catalog.json`.
Candidate validation and snapshot writes accept only v4. Persisted snapshot
readers verify the stored generation's schema, original-byte digest, size and
semantic validity; v3 bytes are not relabeled or rewritten as v4. The retained
v3 snapshot is evaluated against current executable capabilities. Existing
database keys isolate sync and accepted state by `(sourceId, schemaVersion)`.
Compatibility evaluations additionally bind
catalog version, digest, executable capability digest and validator authority.
Projection sets bind the same catalog identity, and their child rows bind a set
ID and payload digest. No database migration is required.

The persisted-snapshot source salt remains 3. It isolates a historical decoder
size limit and is unrelated to the catalog format version. Old API binaries
continue reading their existing v3 namespace and rows; new APIs never rewrite or
delete those pointers, snapshots or immutable publication objects.

A missing or invalid candidate records a failed attempt and leaves the accepted
state unchanged. Accepted v4 always takes precedence over v3, regardless of
catalog version ordering. Once v4 has been accepted, later failed syncs retain
it; an invalid accepted v4 snapshot fails rather than falling back to v3. The
v3 bridge applies only when no accepted v4 snapshot exists for that source.

Diagnostics describe the v4 sync target: `schemaVersion`, `state` and `active`
refer to v4, not the generation currently serving through the bridge. Diagnostics
can therefore report cold v4 state while retained v3 keeps connectors available.
Inspect sync freshness separately from connector availability.

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
Accepted catalog changes wake affected builtin MCP Runs so the runner resolves the
current endpoint and firewall policy.
Removing a connector from the catalog removes that owner from request matching,
without selecting another connector's credentials at the same destination.
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

Deploying this consumer starts v4 sync with the bounded v3 read bridge described
above. Live Plaud acceptance and same-service replacement
remain work under
[#34157](https://github.com/vm0-ai/okou/issues/34157).
No production release, storage pointer change or provider authorization is
performed by this implementation PR itself.

Before v4-only connections or service replacements exist, rolling back to an
older API restores its retained v3 data path. Once those changes exist, supported
rollback binaries must retain the execution and credential readers needed by
their connections; restoring an older binary alone is not a complete recovery.
Historical immutable v3 objects are retained, not deleted by this transition.

[#34913](https://github.com/vm0-ai/okou/issues/34913) owns removing the v3 read
bridge, its schema support and its tests after every serving source and supported
bootstrap target has an accepted v4 snapshot and the deployment/rollback window
no longer needs v3 reads. Retaining immutable v3 objects and rows for older
binaries is a separate obligation; removing this bridge does not delete them.

Diagnostics are staff-only behind `OkouDebug` and use the current v4 contract
without an old-API compatibility bridge. There is no serving selector or warm-up
endpoint to retire.

## Producer evidence

The verified first complete publication is source commit
`985039aaa1bfef5bd93952913e8f9fd7ee077a79`, catalog `2026-09-17.4559`, from
[publish run 35209618715](https://github.com/vm0-ai/vm0-connectors/actions/runs/35209618715).
It contains 4,595 HTTP connectors and Plaud. The full catalog digest is
`sha256:caa97a427cda78f72840a1279da97a607c6d8aea7eb6b5c3277f203de923b987`.
Tests retain seven exact published descriptors with excerpt provenance. The
complete catalog and all 13,705 immutable resource digests are verified separately
without committing the 30 MB catalog to this repository.
