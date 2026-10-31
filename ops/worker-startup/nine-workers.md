# Experimental dependency-isolated API Workers

This experiment materializes the nine-role, source-isolated partition without
changing the serving API, request contracts, or release topology. It is not a
production migration or evidence of adequate Cloudflare startup margin.

## Build and inspect

From the repository root:

```sh
pnpm --dir turbo/apps/api test:worker-build
pnpm --dir turbo/apps/api build:worker
pnpm --dir turbo/apps/api build:worker-roles
pnpm --dir turbo/apps/api build:worker --role runtime
```

The normal command still writes the aggregate `dist-worker/worker.js`. Explicit
role builds write `dist-worker-roles/<role>/worker.js`, source maps, metafiles and
an `audit.json` with the output hash and completion-registration reachability.
Existing deployment commands continue to select only the aggregate artifact.
The nine-role command does not create resources, activate versions or set routes.
A failed selection removes its outputs rather than leaving partially built roles.

`worker-role-manifest.mjs` is the explicit ownership inventory. The static roots
import their original route arrays directly, in aggregate order; they never load
the complete route table and filter it at runtime. AST checks reject unclassified,
stale, duplicate or reordered groups and incorrect initializer wiring. Bundle
checks reject the full aggregator, unbundled non-native packages and missing
completion-event registration when dispatch remains reachable.

## Ownership

At base `1954d564c1774b6dca80ae2251dc8ece1b1186d7`, the 239 aggregate exports
contain 706 unique method/path registrations across 609 path templates:

| Role          | Registrations | Responsibility                                                                       | Completion initializer |
| ------------- | ------------: | ------------------------------------------------------------------------------------ | ---------------------- |
| runtime       |           161 | Run/chat preparation, terminal callbacks, admission and related lifecycle operations | Required               |
| realtime      |           100 | Realtime, connections, device sessions and channel setup/read operations             | Not reachable          |
| control       |            79 | HTTP health/auth/control and independent maintenance capabilities                    | Not reachable          |
| settlement    |            50 | Billing, ledger and settlement-related capabilities                                  | Not reachable          |
| objects       |           150 | Agents, files, storage, hosted resources and object management                       | Not reachable          |
| capabilities  |            98 | Connector execution/authentication, wallet and capability operations                 | Not reachable          |
| delivery      |            12 | Independent outbox and delivery operations                                           | Not reachable          |
| source-events |            52 | External channel/source events and associated admission/renewal                      | Required               |
| mcp           |             4 | MCP endpoint and resource metadata                                                   | Required               |

These labels describe dependency ownership, not strict business-domain isolation.
Shared implementation is statically bundled into each role that needs it. No RPC,
forwarding gateway, new hostname, handler stub, metadata materialization or billing
queue is introduced. The MCP role still includes its real in-process tool handlers.

The shared HTTP primitive accepts a required initializer command. Its compatibility
wrapper installs the original initializer for every existing caller, including
MCP's independently created nested app/Store. Node/Vercel and the aggregate Worker
continue to use that wrapper. The Worker transport factory preserves the existing
request, stream, background-work and database-pool ownership implementation.

## Native routing and operations are not deployed

All methods on the same path have one owner. Cloudflare Routes cannot dispatch by
HTTP method or use arbitrary infix wildcards; complete dynamic-ID subtrees and
specific-prefix precedence still need a verified native routing manifest before
traffic can move. This PR intentionally contains no live routing configuration.

The current source adds `POST /api/integrations/whatsapp/files` and
`POST /api/integrations/phone/reaction` inside existing source-events groups.
The latter requires a new explicit native prefix: the previous research's prefix
inventory would otherwise send it to the default control owner. Do not deploy the
old routing inventory unchanged.

Cron remains on the current HTTP/protected-handler path; no `scheduled` handler
or Cron Trigger is installed. Production migration still requires explicit cron
ownership, real binding configuration, fleet artifact/version identities,
compatibility and drain rules, paired Vercel/fleet release and rollback, and
business/edge acceptance. Existing single-Worker release/rollback code is unchanged.
Local Node development retains its one aggregate entry.

The exact experiment branch `perf/api-nine-worker-split` skips only the auxiliary
API Worker preview deployment. Worker contract/build checks, Vercel preview,
required API checks and App preview retain their existing conditions. Main and
production deployment behavior is unchanged. Inactive Cloudflare benchmarking
requires separate explicit permission and a fresh owned temporary resource.

## Measurement status

Historical research on `da325e69e2e5bc631b6f674d579a7fc6364b80d8` found that the
nine-role baseline did **not** meet its startup-margin budget. In that batch its
runtime member had all-attempt P50/P95 489.5/825 ms and one CPU refusal in 30
attempts. Those numbers do not measure this PR or current main.

Current-role builds and local workerd startup/HTTP probes establish buildability
and limited runtime parity, not Cloudflare startup CPU or authenticated business
acceptance. Fresh Cloudflare measurements must interleave current aggregate and
every current role for at least 30 rounds, retain CPU refusals without replacement,
record exact source/bundle/configuration identities, keep measured versions
inactive, and delete the owned temporary Worker with a subsequent 404 readback.
No fresh Cloudflare startup result is claimed in this PR.
