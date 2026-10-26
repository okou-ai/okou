# API Worker composition experiment

The API can be built as a complete Worker or as six independently bundled
Workers. The domain build is an opt-in experiment; existing Node/Vercel and
production Worker deployment entry points continue to use the complete API.

| Worker       | Responsibility                                             |
| ------------ | ---------------------------------------------------------- |
| Gateway      | Route requests using build-time method/path metadata       |
| Core         | Organization, billing, settings and resource management    |
| Execution    | Chat, runs, agents, workflows and execution callbacks      |
| Integrations | Connector authorization and external platform integrations |
| Data         | Data Router discovery, history and usage callbacks         |
| Processor    | Private presentation-byte preparation                      |

## Dependency boundaries

The four files in `src/signals/route-groups/` are the route membership source.
Each business Worker imports only its group. `src/signals/route.ts` aggregates
those same groups for Node/Vercel and the complete Worker; tests can pass a group
to `setupApp({ context, routes })` or use a smaller existing business route array.
The full aggregate keeps Core before Integrations so the exact Link callback
precedes the parameterized connector callback.

The manifest generator reads these tables and evaluates only contract metadata
at build time. It rejects missing/repeated domains, repeated ownership,
duplicate method/path registrations and unsupported declaration shapes. There
is no second per-route ownership list to update. The gateway imports no handlers
or schemas. Normal Worker bundle validation rejects global/foreign route tables
in domain builds and the unrelated contracts removed from the Data domain.

Route entries own response transforms and request-body policies. The shared
adapter selects and applies only the supplied transforms, after current-response
validation and before serialization. Body policies bound stream reads before
JSON parsing; the owning route supplies the byte limit and error message.
Shared request/response code must not import business contracts or registries.
The complete Desktop compatibility inventory remains a build-time input; the
production route-registration check verifies every listed transform is mounted
on its matching route.

Business Workers preserve the existing middleware, authentication, validation,
request database lifetime, response streaming, telemetry and `waitUntil`
ownership. Initialization belongs to the composition root. Core, Execution and
Integrations still reach the Chat/Run completion dispatcher and retain its
initializer. Data has no such caller; the build checks that a caller is never
retained without its initializer. These first three groups still share execution
dependencies: route partitioning alone does not make their graphs independent.

The existing application factory remains a full-initialization wrapper for Node,
tests and nested MCP compositions. No route is lazily imported on its first
request.

The Processor contains the actual presentation and font algorithms. Business
Worker builds substitute a private `SLIDES_PREPARER` client at the existing
preparation boundary. Node continues calling the algorithm directly. The
`POST /v1/prepare` protocol exchanges file bytes and text styles; authentication,
resource permissions, Google credentials and Drive writes remain in the API.

Shared packages expose small defining modules for operations that need no large
registry: model catalog resolution, frontmatter parsing and request-validation
error formatting. Type-only imports are erased; executable Zod/Drizzle schemas
and registry construction must be evaluated separately when inspecting bundle
graphs. Root-barrel byte counts alone do not measure their transitive cost.

## Local commands

From `turbo/apps/api`:

```sh
pnpm build:worker
pnpm build:worker-domains
pnpm test:worker-domains
```

The domain builder emits six artifacts, source maps, metafiles, a route manifest
and a size/hash summary under `dist-worker-domains/`. Generated Wrangler configs
are templates with no account, production route, real Hyperdrive ID or secrets.
They are not production deployment configurations.

For interactive development:

```sh
pnpm dev:worker-domains
```

This requires the existing API `.env.local` with `ENV=development` and the local
PostgreSQL `DATABASE_URL`. It runs Wrangler locally with all six configurations,
exposes the gateway on port 3001, and watches API/shared-package sources through
one build command. Local Service Bindings connect the Workers. Temporary private
configuration files are removed on shutdown. The existing `pnpm dev` Node flow
remains available during this experiment.

## Verification and rollout

The required `test-api-worker-domains` PR lane builds the complete API reference
and all six domains, then runs native workerd integration checks. Tests use the
real bundles and Service Bindings, and mock only external HTTP boundaries.
They cover public HTTP responses, unauthorized requests, version floors,
preview protection, CORS, redirects and presentation-byte processing. Existing
API route and Worker-lifecycle tests continue in the normal API test lane.

These native tests do not establish authenticated cross-domain database/billing
behavior, deployed Hyperdrive configuration, Google Drive end-to-end behavior,
large-file peak memory or downstream font-fetch cancellation. Those remain
acceptance requirements before traffic migration. The development launcher has
separate configuration checks; its interactive watch/reload cycle also requires
manual verification before replacing the default development command.

Build size is not Cloudflare startup CPU time. Measure the complete reference,
the complete API after dependency cleanup, and each domain using Cloudflare's
`startup_time_ms`; retain CPU-limit rejections alongside successful samples.
Do not combine domain medians into an API cold-start number. Local workerd
timings cannot substitute for this deployment validation.

For a production rollout, publish private dependencies before their callers,
then activate gateway routing only after the entire group passes acceptance.
Retain compatible dependency versions through rollback and request drain. No
production routing or promotion is added by this experiment.
