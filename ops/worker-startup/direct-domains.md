# Direct domain Worker experiment

The API remains one workspace package. Four static route tables compose the
`core`, `execution`, `integrations`, and `data` Worker entries. The normal
Node/Vercel factory aggregates the same tables, preserving its single API.
Requests enter their owning Worker directly. No ingress Worker, forwarding
service binding, or separate Slides processor is built.

## Build and local verification

```sh
pnpm --dir turbo/apps/api build:worker
pnpm --dir turbo/apps/api build:worker-domains
pnpm --dir turbo/apps/api test:worker-build
pnpm --dir turbo/apps/api test:worker-domains
```

The domain build emits four bundles and template configurations under
`dist-worker-domains`, with source maps, retained dependency metadata, hashes,
and route counts. Its route manifest is build/test metadata only; the domain
runtime does not import the global table. Build boundary checks reject global
or foreign route tables and unrelated Data contracts.

Native tests send requests directly to each selected domain and compare status,
body, and protocol headers with the aggregate Worker. They cover anonymous auth,
health, redirects, version guards, preview protection, and CORS. A separate real
Sentry SDK fixture verifies manual and escaping exception delivery. Fixtures use
synthetic environment bindings and intercept outbound calls; these checks do
not cover authorized database/provider success paths.

Normal local development continues using the aggregate API. To develop one
Worker with the local database and `.env.local`, explicitly select its domain:

```sh
pnpm --dir turbo/apps/api dev:worker-domains data
```

This opt-in command serves only that domain on port 3001. It is not a deployment
command. Public route ownership, actual Hyperdrive/environment bindings, and
production placement still need deployment validation before rollout.

## Startup work

The Worker build selects the public `module` export condition alongside
`workerd` and `worker`, allowing OpenTelemetry's ESM exports to be tree-shaken.
The Sentry wrapper receives a mutable handler so it can install `fetch`
instrumentation. Keep function names, runtime validation, database constraints,
and SDK behavior enabled; diagnostic pruning is not part of the candidate.

Local `Server::makeWorker()` wall time is distinct from Cloudflare's upload
`startup_time_ms`. Earlier receipts cannot establish this revision's Cloudflare
startup budget. PR #42640 stays draft and skips automatic Worker activation.
