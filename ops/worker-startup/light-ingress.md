# Archived minimal Worker ingress experiment

This forwarding prototype is retired. Its source and commands below refer to
commit `3bfb17b3`; current builds use four direct domain Worker entries.

The first experiment needs **zero new npm packages and two Worker deployment
units**. Both entry points remain in `turbo/apps/api`: a dependency-free ingress
and the unchanged complete API. The ingress forwards the original Request with
`bindings.API.fetch(request)` and returns the native Response promise. Auth,
validation, billing, routing, and response ownership remain in the API.

This isolates the ingress startup budget. It does **not** reduce the complete
API's initialization, remove its startup-limit risk, or prove a cold request
below 50 ms. Keeping business compute on the existing Vercel API instead would
need only one ingress Worker, but requires a separate HTTP-origin forwarding
experiment, particularly for callback origins and preview protection.

## Build and verification

From the repository root:

```sh
pnpm --dir turbo/apps/api build:worker
node turbo/apps/api/scripts/build-worker-ingress.mjs
node --test turbo/apps/api/scripts/test-worker-ingress.node-test.mjs
```

The builder checks that the ingress retains only its own source module and that
the backend bundle exactly matches the normal complete Worker. It outputs
`dist-worker-ingress/{ingress,api}` and a manifest with bundle hashes, sizes, and
compatibility settings. Wrangler files are templates, not deployment commands;
the API still needs its existing environment and Hyperdrive binding. The npm
package scripts deliberately stay unchanged because the API bundles its own
`package.json`, and changing scripts would alter the control bundle.

Initial artifacts, based on `28b166bd78fc6468d180610c427cdf691f5e288d`:

| Component    | JavaScript bytes | Retained modules | SHA-256                                                            |
| ------------ | ---------------: | ---------------: | ------------------------------------------------------------------ |
| Ingress      |               99 |                1 | `c012fc098229ef54dbf27fa536388cbc9fa7d4406a519d8743bf40521615f5c1` |
| Complete API |       13,271,469 |            3,600 | `a6ddebf00ffad2c5fb7979886b1f1b1162dbb6eb7ce45394f5095b5ef87e0ffd` |

Native workerd tests compare direct and forwarded full API behavior for health,
HEAD, build info, unauthorized requests, login redirects, client version floors,
CORS, and preview protection. A separate native protocol peer checks original
URL/method/credentials, binary streaming before the upload finishes, and multiple
Set-Cookie headers. This does not cover authorized database operations, billing,
real business SSE, WebSockets, or production network behavior. Cancellation has
not been established by the local fixture and is not included in passed coverage.

## Local startup diagnostic

On 2026-10-24, 15 fresh processes per variant in randomized pairs produced:

| Component    | Valid samples | Worker construction wall time, median |                Range |
| ------------ | ------------: | ------------------------------------: | -------------------: |
| Ingress      |         15/15 |                               5.34 ms |         4.51–5.92 ms |
| Complete API |         15/15 |                           1,180.84 ms | 1,067.10–1,410.89 ms |

These are local native `Server::makeWorker()` elapsed times, **not Cloudflare
`startup_time_ms` or request latency**. Each measurement initializes only the
named component; the ingress has no backend binding in this isolated diagnostic
and no application request is issued. Native binding behavior is covered by the
separate tests above. The pinned runtime is workerd 2026-09-03, compatibility date
2026-09-02; the API diagnostic additionally enables `enable_request_signal` and
`nodejs_compat`, while ingress enables neither. Both receive synthetic bindings.
This diagnostic supports measuring the real CF ingress, but cannot establish
the Cloudflare target or predict API upload success.

## Cloudflare measurement plan

Measure 15 ingress uploads and 15 unchanged API uploads, retaining every failure.
The two groups have different responsibilities and bindings; they are not
equivalent complete-API alternatives. Never sum their upload times into an
end-to-end request estimate.

Use a newly owned temporary ingress Worker with a 404 placeholder, an `API`
Service Binding to the existing PR API Worker, and disabled workers.dev and
version preview URLs. Upload ingress candidates as inactive versions. Upload
the complete API control as inactive versions of the existing PR Worker,
inheriting its existing bindings. Make no application requests and activate no
candidate versions. Check active deployments, binding identities, compatibility
settings, and URL states before and after. Delete only the temporary ingress
Worker after matching its creation receipt, name, and creation time, then verify
absence. Existing PR versions stay under the PR's normal cleanup ownership.

No Cloudflare samples from this experiment have been collected yet. Cloudflare
script-write permission must be effective before executing these operations.

## Why not start with six Workers?

The older six-Worker prototype's four business bundles total 29,865,542 bytes.
Core, Execution, and Integrations share 2,062 retained modules contributing about
6.5 MB to each bundle. All four business domains share 1,020 modules. These
artifacts predate workflow schema reuse, so these are dependency-composition
observations, not current-head performance comparisons.

The common graph includes auth, billing/settlement, DB, contracts, and completion
execution. Moving route registrations into separate Workers duplicates much of
this graph. Additional deployment units need measured benefits and explicit
service boundaries; neither route count nor npm package count predicts a 50 ms
startup. Presentation conversion is a possible independent third unit because it
already has a narrow private protocol, but its startup still needs measurement.
