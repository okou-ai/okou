# Contributing to Okou

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/okou-ai/okou?quickstart=1)

## Development Setup

Use the repository's [Dev Container](https://containers.dev/) for Node.js, pnpm,
PostgreSQL, and the other development tools. Install Docker (or OrbStack on
macOS) and VS Code's Dev Containers extension, clone the repository, and open
`okou.code-workspace` with **Dev Containers: Open Workspace in Container**.

The supported Node and pnpm versions are declared in
[turbo/package.json](turbo/package.json). Install Git hooks with
`lefthook install` when configuring a new development checkout.

For development outside the container, [.node-version](.node-version) selects
the default Node.js version. Supported releases are Node.js 22.23.4+, 24.22.1+,
and 26.12.1+ within those major versions; older, end-of-life, and prerelease
versions are rejected. `scripts/prepare.sh` checks this before syncing
credentials or changing the local environment. Restart existing development
services after upgrading Node.js so they use the patched runtime.

## Environment

Team members with the required 1Password access can use `scripts/sync-env.sh`.
For manual setup, copy the current templates from the repository root:

```bash
cp turbo/apps/api/.env.local.tpl turbo/apps/api/.env.local
cp turbo/apps/platform/.env.local.tpl turbo/apps/platform/.env.local
```

Replace the required `op://...` placeholders with your development credentials.
The templates describe the service-specific variables; Clerk supplies identity
and R2 supplies object storage. Generate a local `SECRETS_ENCRYPTION_KEY` with
`openssl rand -hex 32`. Do not commit local environment files or credentials.

Use `APP_URL=https://app.vm7.ai:8443` for the local Platform origin. Refer to
[the proxy guide](turbo/packages/proxy/README.md) for HTTPS, certificate tokens,
and public callback tunnel setup. Optional hosted sites use separate R2 hosted
site credentials and the `ZERO_HOST_DOMAIN` / `ZERO_HOST_SCHEME` settings from
the API template.

## Local Development

`scripts/prepare.sh` checks the local environment, syncs credentials, installs
dependencies, applies database migrations, and seeds development data. Use it
when setting up local development or repairing that environment; it is not a
prerequisite for documentation work.

To install dependencies and apply pending migrations separately:

```bash
cd turbo
pnpm install
pnpm -F @okouai/db db:migrate
```

Start the workspace development services from `turbo` with `pnpm dev`. For API
work requiring public callbacks, use `pnpm -F api dev`, which starts the API and
its development tunnel. The proxy routes the local surfaces as follows:

| Surface                       | Local HTTPS URL         | Direct HTTP port |
| ----------------------------- | ----------------------- | ---------------- |
| Platform                      | https://app.vm7.ai:8443 | 3002             |
| API                           | https://api.vm7.ai:8443 | 3001             |
| Marketing (separate checkout) | https://www.vm7.ai:8443 | 3042             |

The bare `vm7.ai:8443` host redirects to Marketing. See the
[Caddy configuration](turbo/packages/proxy/Caddyfile) for routing and the
[Desktop guide](desktop/README.md) for packaged macOS development.

The standalone API (`pnpm -F api dev` / `pnpm -F api start`) stops accepting
connections and cancels application work on `SIGTERM` or `SIGINT`. Requests
arriving on existing connections during shutdown receive 503, including health
checks. It lets cancellation cleanup drain naturally, with a four-second limit
before a nonzero forced exit closes remaining handles. This deadline stays in
effect even after HTTP connections close, and does not keep a drained process
alive. Vercel owns its separate function lifecycle; this policy does not change it.

## Deployed Preview Access

Read the actual App and API URLs from the PR's deployment checks and job output
in [the Turbo workflow](.github/workflows/turbo.yml). Check the deployed source
revision before testing. App previews can use a `workers.dev` origin while their
API uses `vm6.ai`; do not infer one service's URL or cookie scope from the other.

For a protected preview, obtain its automation bypass value from an authorized
team credential source. In the same browser profile used for testing, first
open the **App** URL with these parameters, substituting and URL-encoding the
secret locally:

```text
https://<app-preview-host>/<route>?x-vercel-protection-bypass=<BYPASS_SECRET>&x-vercel-set-bypass-cookie=true
```

Preserve the intended route and existing query parameters. If a query already
exists, add parameters with `&`; keep them before any URL fragment. Establish
bypass separately on each protected API or auth origin that the browser visits.
One host's cookie does not establish another host's access.

The [App bypass capture](turbo/apps/platform/src/lib/preview-bypass-cookie.ts)
reads the App's query or cookie and forwards the value to its matching preview
API. Visiting only an API bypass URL does not supply that App-side value. The
App capture lasts one hour; repeat the App entry when it expires. Avoid global
request headers: they can send the bypass to third-party hosts such as Clerk.
Keep secret-bearing URLs, cookies and authorization headers out of commits,
screenshots, PR comments and shared logs.

After signing in with the development Clerk instance, inspect an actual App API
request, such as `/api/feature-switches`, in the browser network panel. Verify
the bypass header is present without sharing its value, and check the actual
response. Clerk login, a successful top-level API visit, and an OPTIONS 204 do
not establish that the App's GET has access.

- `403` with `Preview automation bypass required`: the preview credential is
  missing or incorrect. Re-establish App-side access with the current value.
- `401` after bypass succeeds: inspect the separate Clerk authentication state.
- `Failed to fetch`: inspect the real response and CORS error before diagnosing
  connectivity. Older API builds can return the preview-access 403 before CORS,
  hiding its JSON from browser code even though OPTIONS succeeds. An allowed
  App origin should receive its exact `Access-Control-Allow-Origin` and
  `Access-Control-Allow-Credentials: true` on the actual response.

## Verification and Pull Requests

1. Branch from current `main`, implement a focused change, and inspect its diff.
2. Select checks for the changed files and consumers using
   [project verification](CLAUDE.md#development-and-verification).
3. For tests, use the matching [testing guide](docs/testing.md). Prefer package
   scope, such as `pnpm -F @okouai/app exec vitest run <test-file>` from `turbo`.
   Run only one Vitest process at a time. Do not make full-repository build or
   test runs the default for an isolated change.
4. Documentation changes need formatting, valid references, and any specialized
   consumers. Run broader checks only when the changed scope requires them.
5. Commit using [commitlint.config.mjs](commitlint.config.mjs), push the branch,
   and open a PR. Report local checks separately from CI and deployment state.
   Required protected checks must pass before merge.

For schema changes, use [database migrations](turbo/packages/db/MIGRATIONS.md)
and [database development](.claude/skills/database-development/SKILL.md). Do not
run production migrations as part of local setup.
