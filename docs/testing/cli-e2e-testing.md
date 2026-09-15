# CLI and Runner E2E Testing

## Scope

Deployed E2E tests exercise the product exactly through supported user-facing
entry points. The current suite covers:

- the packaged canonical `okou` binary through unauthenticated command-boundary
  smoke checks;
- sign-up and sign-in through Clerk's hosted UI;
- onboarding, chat submission, runner dispatch, and the assistant result through
  the deployed web application;
- real Claude BYOK, built-in Codex, and built-in Pi execution, including
  public usage attribution;
- active-run cancellation through the public run and chat-events APIs;
- ordinary and empty chat attachments across continuation, plus runner-mounted
  workflow files and agent instructions;
- connector firewall placeholder and authentication behavior through the
  deployed preview API, runner, sandbox, and proxy.
- raw network protocol, DNS, connector diagnostic, browser classification, and
  opt-in body-capture telemetry through the deployed runner and public run API.

An E2E test must not call `/api/test/*`, mint a test-only API token, write the
database directly, or use an internal fixture endpoint to construct or inspect
state. Create state through the same product UI or supported public API that a
user would use.

If a behavior needs precise database state or an external-service mock, cover it
in an API integration test instead. API tests may mount the narrow fixture routes
they need by passing them explicitly to `setupApp({ routes })` or
`setupAppWithRoutes`. Test routes must never be added to the deployed `ROUTES`
registry.

## Test boundaries

Keep each layer focused:

- CLI smoke checks verify that the shipped package exposes the supported binary
  surface without authenticating.
- Browser E2E verifies third-party Clerk form integration.
- Playwright verifies the deployed product journey, including the real preview
  API and runner fleet.
- API integration tests own deterministic error cases, state matrices, provider
  mocks, and fixture-only setup.
- Crates tests own runner and sandbox behavior that does not require the product
  journey.

## Adding deployed E2E coverage

Playwright product specs import `test` from `e2e/playwright/fixtures.ts`.
Its fixture-managed page drains already-running page route handlers before
Playwright closes the page/context, including after a failed test. Route errors
remain test failures; do not suppress them with `ignoreErrors`. A test that gates
a route must release its gate in `finally` before fixture teardown can drain it.
Callers still own cleanup of manually created pages and context-level routes.

The local fixture integration suite (`cd e2e && pnpm test`) exercises this
lifecycle through the real Playwright runner, Chromium and a loopback HTTP server.
It requires the Chromium headless shell (`pnpm exec playwright install --only-shell
chromium` from `e2e`), but not a deployed preview or Clerk credentials.

Before adding a case, verify that it:

- begins at a supported product entry point;
- creates prerequisites through product behavior;
- asserts user-visible output rather than internal rows or logs;
- uses unique user-visible names when parallel execution can collide;
- leaves cleanup to the product lifecycle or an idempotent public operation;
- does not depend on a route, credential, environment flag, or database table
  that exists only for tests.

When those constraints make a scenario impractical, place the scenario at the
API integration or crates layer rather than introducing a deployed test hook.

## Running runner E2E tests

All `cli-e2e-*` jobs in `.github/workflows/turbo.yml` check out the event's
immutable PR head SHA on `pull_request`, matching the preview API and CLI
artifact. This applies to test discovery, account preparation, bootstrap,
execution, report finalization, and cleanup. Do not use the implicit PR merge
commit or a moving branch name for those checkouts: newer setup code can send
requests that the deployed PR API does not support. Push and merge-group jobs
continue to use `github.sha`, so merge-queue E2E still tests the queued revision.
This rule does not change other jobs' checkout policies, including the App
artifact's explicit merge-candidate build.

The BATS files under `e2e/tests/03-runner` are CI-only and cannot be run from a
local checkout. They depend on temporary Clerk organizations and API tokens,
the pull request's deployed API and app previews, and the preview runner fleet
provisioned by the `cli-e2e-03-runner-*` jobs in `.github/workflows/turbo.yml`.
There is no supported local setup for those credentials and services.

Push runner E2E changes to a branch and use the pull request pipeline to run
and validate this suite. Do not treat a local `./e2e/run.sh` invocation as
validation for `03-runner`; running the script without file arguments also
selects the CI-only runner tests.

## Adding runner BATS tests

Runner BATS files live in `e2e/tests/03-runner`. They share the accounts and
public device-flow tokens prepared by the runner E2E workflow, then create and
clean up their own agents, threads, and connector connections through public
`/api/*` endpoints.

Name runner BATS files `run-tNN-<behavior>.bats`, using the next unused `NN`.
The number is a stable file identifier, not an execution order. Test titles
should describe behavior without repeating the file identifier.

The workflow also prepares dedicated real-Codex and real-Claude identities.
Use the Codex identity for built-in model billing coverage and the Claude
identity for BYOK coverage so provider policy and usage assertions remain
isolated. The shared mock-runner identity starts with `UTC` as its timezone.
Runner BATS must not mutate shared account-level preferences from parallel
shards. Coverage that needs mutable account-level state requires a dedicated
identity or a serialized lane.

The default runner and feature-test accounts use limited-free onboarding. The
dedicated Codex, Claude, and mock-Claude accounts still require Pro for their
paid-model and BYOK policies. Runner preparation completes onboarding through
the public API, creates a public usage-pack checkout, completes hosted Stripe
payment, and verifies the resulting public entitlement before publishing tokens.
Only the dedicated paid-onboarding spec exercises the video onboarding UI.

Clerk resource creation records exact IDs in `E2E_CLERK_RESOURCE_DIR`. Normal
cleanup verifies those IDs' ownership against Clerk and deletes organizations
before users. Runner records travel with their workflow attempt so successful
reruns can clean earlier attempts without listing the whole Clerk instance.
Failed runner shards retain their accounts for reruns. An uncertain organization
creation keeps its owner user for the existing strict-marker stale sweep.
Playwright's setup project owns the feature account; unrelated lanes create no
unused global account. Failed checkouts report HTTP status, request ID, and
Retry-After, and product Playwright lanes retain traces on the first failure.

Use a different organization-scoped connector slug in each file that can run in
parallel. Assert sandbox-visible output and Okou-owned telemetry; do not treat an
external provider's exact response status or body as the test oracle.

For active-run connector refresh cases, coordinate through a run-scoped output
message in the public chat-events API. Network telemetry is uploaded after the
run completes, so use it only as the final ordered policy assertion, not as a
live synchronization point.

Body capture must be enabled on the individual chat run. Do not mutate the
shared runner account's next-run capture preference: runner files execute in
parallel, so user-scoped mutable preferences are not isolated between shards.

The workflow discovers the checked-in BATS files, weighs each file by its test
count, and assigns whole files to at most twelve non-empty shards. New files are
included automatically. Keep setup and teardown self-contained within a file so
the shard planner can move it without introducing cross-file ordering.
