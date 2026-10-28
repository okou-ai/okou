# CLI and Runner E2E Testing

## Scope

Deployed E2E tests exercise the product exactly through supported user-facing
entry points. The current suite covers:

- the packaged canonical `okou` binary through unauthenticated command-boundary
  smoke checks;
- sign-up and sign-in through Clerk's hosted UI;
- onboarding, chat submission, runner dispatch, and the assistant result through
  the deployed web application;
- real Auto/OpenRouter Pi execution and personal-subscription harnesses,
  including public usage attribution;
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

Cover deterministic error cases and external-service mocks in API integration
tests. Those tests must still construct and observe scenarios through production
APIs, genuine provider webhooks, or authenticated Runner protocols. Do not add
private fixture routes or fixture-only setup to create otherwise unreachable
state. Follow the [API testing boundary](../api/api-testing.md#external-behavior-boundary).

## Test boundaries

Keep each layer focused:

- CLI smoke checks verify that the shipped package exposes the supported binary
  surface without authenticating.
- Browser E2E verifies third-party Clerk form integration.
- Playwright verifies the deployed product journey, including the real preview
  API and runner fleet.
- API integration tests own deterministic error cases, publicly reachable state
  matrices, and external-provider mocks.
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
The focused runner sign-in and Clerk bootstrap fixture files also accept
`E2E_CHROMIUM_EXECUTABLE_PATH` for an installed Chromium executable. Such a local
run verifies that browser version; the PR pipeline still verifies the locked
Playwright headless shell.

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
captured `github.sha`. On `pull_request`, this is the immutable synthetic merge
commit, matching the preview API, private CLI input, App, and Runner rather
than the isolated PR head. This applies to test discovery, account/shard
preparation, bootstrap, execution, report finalization, and cleanup. All setup
and test code must match the deployed components so it does not send requests
that their API cannot support. Never resolve a newer mutable merge ref or a
moving branch during the run. Push and merge-group jobs use their captured
event revision as well, so merge-queue E2E tests the queued source.

Build source is separate from Actions producer/run identity. Image waiters
retain PR-head `LOOKUP_SHA` for run lookup; branch/PR environment association
and namespace ownership do not become merge-SHA identities.

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

The workflow uses three fresh user/organization identities:

- Mock native (`runner-mock-claude`) hosts the behavioral cases and personal
  Claude regressions.
- Ordinary real Auto (`runner-real-codex`) hosts steering, product-default smoke,
  and continuation. Each case owns its agents, threads, and runs.
- Real Auto billing (`runner-real-codex-built-in`) hosts only billing. Usage
  settlement processes pending events across an organization, so other cases
  must not share this identity.

Platform identities use `runner-auto-bootstrap.bash`, verify the read-only
`/api/run-models` response (Auto is the first entry, with `model: "auto"`) and
select Auto by saving a `null` model preference. Their real/mock runtime flags
remain isolated. The mock identity verifies these fresh defaults before
installing personal subscriptions. It also hosts a personal Codex
subscription: shell-driven BATS select it with
`runner_e2e_use_mock_codex_profile`, while personal Claude coverage uses that
identity's Claude subscription. Mock-only helpers reject a missing profile
rather than silently selecting a real model. Synthetic subscription credentials
are provisioned only after the preview runtime has been pinned to mock mode.
The Auto smoke, steering, billing and continuation cases exercise the fixed
OpenRouter preset; personal native-harness cases keep their subscription choices.
The shared mock-runner identity starts with `UTC` as its timezone.
Runner BATS must not write conflicting shared account-level preferences from
parallel shards. Explicit chat model selection also persists the member default;
the ordinary real cases all select or inherit Auto. Coverage that requires a
different default or other conflicting account-level state needs a dedicated
identity or a serialized lane. Historical Runner role markers remain recognized
by cleanup so retained attempts can still be removed.

Real platform model calls in `e2e/tests` must use Auto, which the API receives as
`model: null` (pass `auto` as the `runner_chat_send` model argument);
`e2e/scripts/runner-model-selection.test.ts` enforces that boundary in CI before runner
account preparation. Run it locally with
`cd e2e && pnpm exec tsx --test scripts/runner-model-selection.test.ts`, independently of
the Playwright fixture suite. Personal subscription choices remain available in
the isolated mocked native-harness profiles.

Every retained Runner identity uses Pro to preserve billing and
personal-subscription test prerequisites. Runner preparation creates fresh Clerk
users and admin organizations, signs in, completes onboarding through
the public API, creates a public usage-pack checkout, completes hosted Stripe
payment, and verifies the resulting public entitlement before publishing tokens.
Platform Vitest covers the video onboarding UI and checkout return flow.
The deployed Playwright suite covers one chat send-and-reply happy path.

Clerk's configured Creator Role determines the role granted by `created_by`,
as defined by its
[organization settings contract](https://github.com/clerk/openapi-specs/blob/a91bd1815277a236107ef325be6e138db32762cb/bapi/2026-05-12.yml).
Account preparation must establish the required admin role; the provider's
[roles documentation](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions)
confirms that Creator Role is configurable. When preparation relies on that
configured role, read current organization settings within preparation and fail
before creating identities when settings are unavailable, organizations are
disabled, or Creator Role is invalid. Do not cache settings across batches or
treat an earlier observation as a permanent guarantee. A preparation-scoped
read does not provide atomic isolation from administrator changes to Creator
Roles or Role Sets during provisioning. Account preparation does not change
those instance settings.

Clerk resource creation records exact IDs in `E2E_CLERK_RESOURCE_DIR`. Normal
cleanup verifies those IDs' ownership against Clerk and deletes organizations
before users. Runner records travel with their workflow attempt so successful
reruns can clean earlier attempts without listing the whole Clerk instance.
Failed runner shards retain their accounts for reruns. An uncertain organization
creation keeps its owner user for the existing strict-marker stale sweep.

PR closure does not start a separate Clerk directory scan. Normal finalizers
clean their recorded resources immediately; runner preparation failures use
their current generation's records and preserve the original setup error if
cleanup also fails. Unknown organization creation outcomes retain the owner
instead of starting a generation-wide scan. Cancelled jobs and lost or expired
records are recovered by the existing serialized half-hour Clerk sweep.

The sweep selects CI resources older than two hours and staging-browser
resources older than eight hours. With a healthy provider and an inventory that
fits the budget, recovery happens on the first successful pass after that age
threshold, normally within another 30 minutes plus execution time. GitHub
scheduling delays and provider outages can extend that interval. Records alone
never prove ownership: recorded cleanup verifies current Clerk resources, and
the sweep retains its strict markers, staging membership checks, and
organization-before-user deletion order.

Each cleanup invocation allows at most 500 actual HTTP attempts, including
retries, over five minutes. Attempts are spaced by at least 500 ms, and each
request and its response body have a ten-second deadline within that total
budget. A 429 is not automatically retried. The scheduled job has a ten-minute
outer timeout including dependency installation. Pacing is per invocation,
roughly 20 attempts per ten seconds; it does not reserve the development
instance's shared quota. Recorded finalizers and other CI can still contend.

Inventory and ownership selection must finish before deletion starts. Budget
exhaustion fails the invocation; it never reports an incomplete scan as clean.
If deletion is interrupted, remaining resources are reconsidered on the next
sweep and unresolved organization owners stay retained. If inventory alone grows
beyond the budget, no resources are deleted: investigate the failed workflow and
directory growth, then explicitly adjust capacity or design resumable discovery. Repeated passes
do not guarantee progress past that capacity limit. Do not delete skipped
organizations or introduce blind retries to work around it.

The single Playwright chat smoke owns its account; no unused global account is
created. Failed checkouts report HTTP status, request ID, and Retry-After for
runner account preparation, and the chat smoke retains a trace on failure.

Runner credential sign-in failures upload `runner-e2e-sign-in-diagnostics` for
one day, separately from payment diagnostics and credentials. This upload is
best-effort: upload failure does not change the original test result; credential
generation and token upload still must succeed. Each account's
JSON report records document milestones, the first 64 requests (origin/path,
resource type, status, elapsed timings and finished/failed/pending outcome),
omitted-record counts, and best-effort page/Clerk readiness. Status and response
timing are present only once the browser reports them; their absence is not
proof that the server sent nothing. Pending script requests can explain a
missing `DOMContentLoaded` milestone.
The additional Chromium CDP `network` section retains the first 64 request hops
independently, including separate redirect responses with the same CDP request
ID. It aggregates `dataEvents`, `decodedDataBytes`, `encodedDataBytes`, and
`firstDataMs`/`lastDataMs` without collecting body content. Response metadata
includes protocol, DNS/connection/TLS/send/header timing, cache/service-worker
flags, and strictly validated `cfRay` values when available. Timing fields are
milliseconds relative to the request's CDP timing baseline; -1 means that phase
is unavailable. Terminal events distinguish `finished`, `failed`, and
`redirected` from `pending`. `totalEncodedBytes` comes only from loadingFinished
and can include headers; it is not the sum of encoded data-event lengths.
An interrupted session is marked, and unavailable setup is reported explicitly.
Setup and session disposal each have a one-second deadline. Observation freezes
before failure capture and intentional detachment, so cleanup cannot become a
network failure in the report. Browser buffering and cached responses affect
byte events: zero observed data does not prove that the server sent nothing.
These client-side observations can locate a stalled transfer or script but
cannot alone distinguish a Worker stall from a remote edge/transport failure.
Page-state capture has its own one-second deadline and can be unavailable.
The bounded `network.responseHeaders` list separately retains the first 64 CDP
`responseReceivedExtraInfo` events as request ID, status and elapsed time, with
`omittedResponseHeaders` for overflow. Chromium can expose these before its
ordinary response event for an unfinished script. No raw headers are retained.
Redirects reuse IDs, so these events are not assigned a guessed redirect hop.
The preview-only Worker entry adds `x-okou-preview-build-sha` to eligible
same-origin `/sign-in` HTML navigation responses. Its value comes from the
unique canonical source-SHA meta declaration in the immutable bundled shell,
not the expected artifact or request. Default and production entries omit it.
The wrapper annotates the existing Response without consuming its body.

Runner preparation carries the resolved artifact SHA as
`OKOU_EXPECTED_APP_BUILD_SHA`; failure reports retain its valid/missing/invalid
classification separately from each eligible CDP document hop's observation.
`requestId` plus `redirectHop` identify the hop. Observations are
valid/missing/invalid/unavailable; comparisons are match/mismatch/not-comparable
with a reason. Duplicate, combined or malformed marker values are rejected
without retaining raw values. CDP can normalize headers before observation, so
this cannot prove the absence of duplicate fields on the wire. External and
ineligible hops are not compared. Missing markers do not distinguish an older
Worker from an omitted or invalid bundled declaration.

This source SHA is not an asset-byte digest or unique upload identity. Even a
match and `loadingFinished` do not prove DOMContentLoaded, native streaming
behavior or the cause of a historical failure. Retain this bounded preview
contract; changing or removing it requires review of its producer and observer.

These reports exclude URL queries/fragments/userinfo, headers other than the
validated cf-ray and preview-build identifiers, cookies, payloads,
raw console/error text, screenshots and raw traces. Healthy sign-in writes no
report. Runner credential preparation opts into initial-navigation recovery:
if a main-frame GET document or same-origin application JS/CSS under
`/okou-app/assets/` remains pending without browser-observed transfer progress
for five seconds, it may replace that navigation up to twice. New response
headers and positive body-data events reset that request's idle interval;
receiving headers alone does not exempt an unfinished body. A progressing
transfer can take longer than five seconds without being restarted.
Navigation waits, evidence capture and
replacement share the original 30-second navigation budget. A local blank
document stops the old load before navigating to the sign-in URL again.
Completed transfers, explicit HTTP/network failures, and page closure/crash do
not trigger recovery. This policy describes browser-observed inactivity;
buffering can hide wire progress, so it does not prove server inactivity or
whether a transport connection opened. Activity includes early CDP headers;
matching redacted URLs/redirect IDs use their latest progress and any terminal
failure conservatively. Unavailable, interrupted or truncated observation
disables retries; the ordinary bounded navigation still must succeed.

Before each replacement, an attempt-labelled `.navigation-N.json` report saves
a bounded snapshot of the stalled state before intentional cancellation.
Observation continues during capture: if navigation completes or the transfer
resumes progress in the meantime, keep the original load. Recovered attempts retain
these reports even if sign-in then succeeds; a final failure also keeps the
normal per-account report. Each report includes `navigationAttempt`. Diagnostic
failure preserves the original sign-in error or recovery decision. The retry
boundary ends before any email/OTP submission: onboarding, Stripe checkout and
token issuance are never replayed. Other shared sign-in consumers retain their
existing navigation behavior. This recovery does not increase authentication or
CI deadlines, nor establish or fix an underlying provider/network outage.

Use a different organization-scoped connector slug in each file that can run in
parallel. Assert sandbox-visible output and Okou-owned telemetry; do not treat an
external provider's exact response status or body as the test oracle.

For active-run connector refresh cases, coordinate through a run-scoped output
message in the public chat-events API. Network telemetry is uploaded after the
run completes, so use it only as the final ordered policy assertion, not as a
live synchronization point.

Business-outcome assertions must not require `GET /api/runs/:id/context`.
That debugging snapshot is best-effort telemetry in Axiom, and Run completion
does not guarantee that it is queryable. Verify model/provider identity through
the owned Run's persisted `source` and actual behavior through sandbox output
and continuation. Native Runner API integration tests verify exact launch
configuration and preset selection for initial and continued Runs. Settled
usage belongs in billing coverage after that test's public reconciliation:
preview deployments have no production usage cron, and completion does not
guarantee accounting has finalized. External account identity metadata may be
unknown for opaque mock subscription tokens; it is not a model-route oracle.
For exact connector account selection, run `okou connector check --json` inside
the active Run and assert its admitted account ID; keep outbound-request and
authentication assertions where network telemetry is itself the tested contract.
Missing or wrong route/account/output evidence must still fail the outcome test;
missing or wrong settled usage must fail the billing test.
Context reads used solely to diagnose an already-failed probe remain single-shot
and do not become successful-path prerequisites. Do not replay Runs or mutations,
skip assertions, or increase test deadlines to accommodate optional snapshots.

Body capture must be enabled on the individual chat run. Do not mutate the
shared runner account's next-run capture preference: runner files execute in
parallel, so user-scoped mutable preferences are not isolated between shards.

The workflow discovers the checked-in BATS files, weighs each file by its test
count, and assigns whole files to at most twelve non-empty shards. New files are
included automatically. Keep setup and teardown self-contained within a file so
the shard planner can move it without introducing cross-file ordering.

Transport probes must preserve the production authentication and TLS
boundaries. Use the credential kind the endpoint admits, the returned target
verbatim, and certificate validation for deployed acceptance. Controlled local
peers validate the probe; they do not prove public trust or real sandbox traffic.
Public cleanup must remain available after the connection being tested is lost.
