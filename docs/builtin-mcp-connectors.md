# Builtin MCP connectors

Builtin MCP uses the existing builtin account, Agent grant, thread selection,
and firewall mechanisms. An HTTP API offering and an MCP offering are separate
catalog slugs, even when they belong to the same service. Their accounts,
defaults, grants, and thread overrides are independent.
Runtime credential aliases must also have a single connector owner. Catalog
validation rejects cross-connector alias reuse so the run's alias maps cannot
substitute a sibling's credentials; methods within one connector may share aliases.

## Catalog and authentication

An optional `mcp` object declares `transport: streamable-http` and a fixed,
canonical public HTTPS `endpoint`. Metadata, not the slug suffix, determines
protocol. The producer owns the bidirectional `-mcp` naming constraint; custom
connector names do not inherit that rule.

The generated firewall has exactly one public-destination API at that endpoint,
no per-API permissions, and an allow policy within its endpoint scope. Existing
public-address checks and redirect restrictions still apply. MCP tool access is
independent of the HTTP sibling's restrictions.

- `grant.kind: none` uses empty storage and empty static access. It still
  requires a connected account and an Agent grant; missing credentials never
  become anonymous access.
- Manual grants use the existing storage fields and static header/query auth
  templates. The proxy resolves credentials for the exact admitted account and
  injects them outside the sandbox. MCP credential environment bindings are not
  exported into the guest.
- Generic `automatic` grant/access declarations reserve matching access/refresh
  token storage bindings and API callback ownership. This foundation parses
  them but explicitly reports an unsupported generic strategy. It does not
  implement OAuth discovery, token acquisition, refresh, or reauthorization.

An absent `mcp` field stays absent through artifact decoding and projection;
existing HTTP artifact bytes and digests do not acquire defaults.

## Discovery and run authority

Catalog list, status, and discovery accept `protocol=http|mcp|all`. Omission
means HTTP. Combined consumers request `all`; protocol filtering precedes
ranking, limits, connected merging, and category counts. Public MCP items emit
`protocol: mcp`; HTTP items omit it. A missing tag always means HTTP, including
responses from an older API.

Run tokens carry an optional `builtinMcpSourceIds` slug-to-account map derived
from the prepared, admitted builtin firewalls. Missing maps admit nothing.
Discovery checks the owned run/session, accepted catalog, and exact account;
it never substitutes a current default, sibling, or other user's account.
Unavailable references do not grant access, while operational failures retain
their error semantics. Manual accounts with unavailable required credentials
are reported as disconnected, not as no-auth connectors.

`okou mcp list`, `list-tools`, and `call` share one builtin/custom descriptor.
Builtin descriptors use the slug; custom descriptors retain their real UUID.
Ambiguous names require `builtin:<slug>` or `custom:<uuid>`. The private proxy
intent selects only an admitted firewall owner and is stripped before upstream.
Existing response/tool/page limits, cancellation, cleanup, and no automatic
tool-call replay are unchanged.

Canonical reauthorization uses
`POST /api/mcp-connectors/oauth2/reauthorize` with a typed builtin/custom target.
The foundation rejects every builtin request as unavailable without starting
OAuth. Custom requests retain their exact signed account selection.

## Deployment gates

The dedicated `builtinConnectorMcp` switch defaults to false and gates discovery,
new connections, and run admission independently of custom MCP. Turning it on
does not add an MCP binding to an older run. No production catalog publication
or switch enablement is part of this foundation.

Before publication or enablement:

1. Deploy compatible strict catalog readers everywhere that consumes the
   compiled catalog or its persisted runtime projections. Publishing new fields
   before that reader deployment can reject the whole catalog, including HTTP.
2. Verify the canonical commit-addressed CLI package selected by execution
   contexts, including queued and in-flight runs. A current developer CLI or
   runner binary alone does not establish readiness. The non-GA custom MCP
   descriptor and reauthorization route move to the canonical contract here;
   do not activate that flow with contexts pinned to the previous contract.
3. Deploy the App before enabling the builtin MCP switch. Old App collection
   requests remain HTTP-only; new App views never interpret missing metadata as
   MCP. Default HTTP collection compatibility remains required independently
   of the MCP rollout.
4. Implement and verify S2 authentication/lifecycle before publishing an
   Automatic offering. S3 owns producer naming validation and the separate
   ClickUp MCP bundle. Record deployment/package evidence in those delivery
   issues before activation.

See [deployment compatibility](./deployment-compatibility.md) for independent
client and execution-context lifetimes. No schema migration or new runner
transport is required. Local none/manual fixtures verify the foundation, not
live ClickUp acceptance.

Delivery: [S1 #33982](https://github.com/vm0-ai/vm0/issues/33982),
[S2 #33983](https://github.com/vm0-ai/vm0/issues/33983),
[S3 vm0-connectors#4538](https://github.com/vm0-ai/vm0-connectors/issues/4538),
under [parent #33968](https://github.com/vm0-ai/vm0/issues/33968).
