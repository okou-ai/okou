# Batch 017: public provider fixtures and unsupported workflow controls

Refs #37440. Selection recorded before source edits at fresh main
`fd4cd0121254630ec4d96e53853f0b6e93a71829`. Exactly ten frozen identities:
nine helpers (one shared/eight local) and one HTTP operation. Opening balance:
73 helpers (34 shared/39 local/0 benchmark), 26 operations/23 paths/113 original
nested actions. Only actual merge changes this balance.

## Ten identities and complete caller decisions

Paths are relative to `turbo/apps/api/src/`. Original file+symbol identities
remain stable even when an ordinary public fixture keeps its name.

| ID  | Frozen identity                                                                             | Callers and scenario value                                                                                                                                                                        | Disposition, construction and loss                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | `signals/routes/__tests__/seo-backlinks.test.ts::setupBacklinksTest`                        | All declarations in that file: genuine DataForSEO failures, recovery, cancellation and successful-cost billing.                                                                                   | Public rewrite: remove private pricing alias/SQL teardown. Use existing migration1078 DataForSEO1250/1000000 price and actual Stripe invoice/onboarding, then normal SEO and billing requests. Keep response, retry and charge assertions.                                                                                                                                                                         |
| H2  | `signals/routes/__tests__/seo-serp-retry.test.ts::setupSerpTest`                            | All declarations in that file: organic/news engine responses and bounded provider recovery.                                                                                                       | Same public rewrite and unchanged production price; preserve each parameter branch and assertion.                                                                                                                                                                                                                                                                                                                  |
| H3  | `signals/routes/__tests__/seo.test.ts::seedActor`                                           | Paid SEO location/engine/operation mappings, errors, no-results, costs and one forged-capability rejection.                                                                                       | Public rewrite: keep genuine provider/request cases at the default migrated price; remove the fabricated Run token with an empty capability array. Lose that unissuable token403 combination, not ordinary provider/auth failure behavior.                                                                                                                                                                         |
| H4  | `signals/routes/__tests__/seo.test.ts::createUnfundedActor`                                 | Insufficient-credit rejection with no provider request.                                                                                                                                           | Public rewrite: normal onboarding and Stripe subscription activation without payment via existing `createPublicUnfundedProFixture`; public billing shows zero, SEO rejects; genuine Clerk deletion and no deleted-identity readback. Remove pricing alias/teardown.                                                                                                                                                |
| H5  | `signals/routes/__tests__/voice-io-transcribe.test.ts::voiceActor`                          | Only the designated single redaction declaration, testing the real endpoint with provider failures.                                                                                               | Public rewrite: replace arbitrary Pro/10000-credit metadata with the existing normal Stripe paid subscription/onboarding flow; keep diagnostic redaction and HTTP/quota outcomes. Its purpose does not depend on an exact10000 wallet. Neighboring Voice fixtures are unprocessed.                                                                                                                                 |
| H6  | `test-fixtures/org-metadata.ts::setOrgDefaultAgentFixture`                                  | H7 plus `feishu-integration.cases.ts::setupFeishuRunFixture` optional alternate default, used by one DM declaration registered for Feishu and Lark. Privately repoints an existing default Agent. | Retire. Current bootstrap retains an existing valid default; no normal user command selects a replacement default. Delete the constructed Morning Brief post-repoint scenario. Keep the DM declaration through ordinary system-default onboarding and real provider/Runner APIs; lose only alternate-default substitution. Production bootstrap/metadata writes stay.                                              |
| H7  | `signals/routes/__tests__/official-workflows.test.ts::setupBriefWithChangedOrgDefaultAgent` | Only `toggles only the installed brief after the default Agent changes`.                                                                                                                          | Retire with the one declaration. Lose preference binding after a fabricated default-Agent change. The earlier separate alternate-Agent installation/preference test remains; it is not certified as fully public by this batch.                                                                                                                                                                                    |
| H8  | `signals/routes/__tests__/official-workflows.test.ts::installStaleAdmissionScenario`        | Only `reconciles a changed release at admission`. Test publishes custom operator catalogs and changes a Blueprint budget before launch.                                                           | Retire with this declaration: no normal user writer controls the accepted official release. Lose admission-time reconciliation of a privately selected release/budget and its exact additional-Run count. Existing independent launch cases and production admission stay.                                                                                                                                         |
| H9  | `signals/routes/__tests__/official-workflows.test.ts::prepareEmptyInstallation`             | The nested beforeEach and sole `recovers superseded and crashed work while preserving permanent Blueprint identity` declaration.                                                                  | Retire with the group: custom operator catalog, forced expired worker lease, direct state reads and repeated private worker execution form the decisive chain. Lose forced crash/supersession, exact sweep counts and permanent identity through remove/restore/retire/reactivate. Independent installation and restoration cases remain unprocessed. Remove orphan crash action/support without operation credit. |
| A1  | `POST /api/test/workflow-automation-execution/dispatch-callbacks`                           | Only the failed/cancelled parameterized declaration in `chat-events-automations.test.ts`; remaining references are lint source strings and historical documentation.                              | Retire route/contract and forced twice-dispatch phase. Keep normal paid actor, personal Codex OAuth, Workflow create/manual run, real Runner heartbeat/claim, failure or cancellation, duplicate authenticated terminal callback, public event and zero Built-in charge observations. Lose direct redispatch after already-terminal work; no new worker kick.                                                      |

## Caller and coverage scope

- SEO fixtures are file-local, not exported; nested location loops expand two
  operation variants and parameterized declarations must be counted separately
  from executions. `seedSeoPricing`, its row constant and pricing-resolution
  plumbing become orphan support, worth zero additional items.
- Voice's helper has one direct caller and no returned private closure. Its
  neighboring funded/free fixtures, cleanup and tests are not certified by the
  selected redaction rewrite.
- Official workflow helpers are local; H9 is captured by nested beforeEach and
  `prepared`, both removed with its sole group. H6 also has the Feishu factory option described below.
  Preserve other metadata fixture exports, catalog reader/worker actions,
  service workers, locks, accounting, constraints, migrations and normal routes.
- The deleted default-change case's independent initial install/toggle behavior
  already has distinct neighboring declarations; it is not reintroduced as a
  duplicate. The custom release/crash cases have no independently public setup
  for their decisive official Blueprint transitions.
- Remove the crash-only helper, route command, branch and contract variant when
  the last caller disappears. The admission case also leaves the private
  `readOfficialWorkflowRunStateFixture` reader and its runtime-state action
  without consumers; remove that reader/branch/response schema, plus the local
  `listAdmissionRuns` and `completeSuccessfulRun` support. These are two nested
  actions from still-existing operations and zero additional identity items. Retired-operation lint fixtures must be
  updated or removed without weakening the generic remaining rule.
- Source snapshots of the previous unread attempt show a real5000ms timeout
  and expired-fixture ownership problem. Those four identities remain
  unprocessed; their valuable100/101/128-thread cases are not deleted or
  reduced. Desktop process-global cache isolation, unsupported tool pricing,
  Storage/Run/Pi/memory/projection/usage/connector/export and service exceptions
  also remain outside this batch.

## Validation and accounting

Implementation and case/parameter reconciliation are complete. Exact-HEAD review,
required CI and protected merge receipts will be recorded in the issue ledger.
No local Vitest or dev server. No new delay, retry, deadline increase, assertion
relaxation, production behavior change or dependency-policy change is planned.
Prior source/merge failures remain in the ledger. #37440 stays OPEN; #33778 is
superseded, not completed. Historical1125 cases and #37918 stay separate.

## Pre-PR caller correction

The initial selection incorrectly called H7 the only H6 consumer. Full symbol
checking also found `setupFeishuRunFixture({ useAlternateInstallationDefault: true })`
inside `builds Feishu DM context and canonical response metadata`, registered
for Feishu and Lark. Keep this valuable declaration and both executions. Use
`useSystemDefaultIdentity: true` to enter ordinary onboarding (avoiding the
shared bootstrap's fabricated Runner token), keep the existing default Agent,
and remove the orphan alternate-default option. Existing public logs/source
reads, OAuth/signed encrypted ingress, real Runner claim, checkpoint/events,
provider reply metadata and installation DELETE remain. Supply the actual
history bytes at the S3 key authorized by checkpoint prepare; do not add a
magic hash/body entry. Lose only the artificial replacement-default identity.
The parent Feishu factory and unrelated private branches earn no credit.
This correction is recorded before the Feishu edit and preserves the initial
ledger selection as historical evidence.

## Exact case and parameter reconciliation

- Four whole declarations / four executions are removed: the forged SEO token
  rejection and the three Official scenarios named in H7–H9. No parameter row
  is removed from a retained declaration.
- The selected retained surface has 28 source declarations / 48 executions:
  SEO 25 / 43, Voice redaction 1 / 1, Automation terminal 1 / 2, and the
  Feishu/Lark DM declaration 1 / 2. No new declaration is added.
- In `seo.test.ts`, the two-operation `describe.each` registers its three nested
  declarations twice. Thus its 14 source declarations register 17 declarations
  and execute 26 cases (previously 15 / 18 / 27). Supported locations contribute
  six executions, unsupported locations five and provider rejection two.
- Official's full source file changes 40 → 37 declarations and 44 → 41
  executions. Neighboring retained cases do not count as newly public.

The following retained declarations all keep their original response and
charge/error/cancellation assertions. Parameterized source declarations count
once; the last column reports actual expanded executions.

| File                              | Retained declaration                                                                  | Executions  |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------- |
| `seo.test.ts`                     | `resolves $location to the supported location code`                                   | 6           |
| `seo.test.ts`                     | `rejects unsupported location %s before the provider without charging or alerting`    | 5           |
| `seo.test.ts`                     | `surfaces a provider rejection of a validated location without retrying or charging`  | 2           |
| `seo.test.ts`                     | `rejects insufficient credits before calling the provider`                            | 1           |
| `seo.test.ts`                     | `does not charge DataForSEO authorization failures`                                   | 1           |
| `seo.test.ts`                     | `reports an unverified DataForSEO account without charging credits`                   | 1           |
| `seo.test.ts`                     | `returns $engine no-search-results at cost $cost without retrying`                    | 2           |
| `seo.test.ts`                     | `does not hide $failure behind a no-search-results task`                              | 2           |
| `seo.test.ts`                     | `does not treat no-search-results as success outside SERP`                            | 1           |
| `seo.test.ts`                     | `retries a zero-cost empty task response once and charges only the successful result` | 1           |
| `seo.test.ts`                     | `returns an explicit error when DataForSEO repeats an empty task response`            | 1           |
| `seo.test.ts`                     | `returns DataForSEO task parameter errors as bad requests`                            | 1           |
| `seo.test.ts`                     | `maps DataForSEO operations and bills the reported cost with a 25% markup`            | 1           |
| `seo.test.ts`                     | `routes supported DataForSEO search engines to their live endpoints`                  | 1           |
| `seo-backlinks.test.ts`           | `recovers from HTTP 504 with an Ok envelope and charges only the successful result`   | 1           |
| `seo-backlinks.test.ts`           | `stops after two HTTP 500 responses without charging credits`                         | 1           |
| `seo-backlinks.test.ts`           | `does not retry $failure`                                                             | 4           |
| `seo-backlinks.test.ts`           | `shares the two-attempt budget with empty task responses (empty first: $firstEmpty)`  | 2           |
| `seo-backlinks.test.ts`           | `retries HTTP 500 without a JSON body`                                                | 1           |
| `seo-backlinks.test.ts`           | `cancels an in-flight retry without charging credits`                                 | 1           |
| `seo-backlinks.test.ts`           | `keeps HTTP failure handling for SERP without retrying it`                            | 1           |
| `seo-serp-retry.test.ts`          | `recovers from a $engine 40101 task and charges only the successful result`           | 2           |
| `seo-serp-retry.test.ts`          | `stops after two 40101 tasks with recoverable guidance and no charge`                 | 1           |
| `seo-serp-retry.test.ts`          | `shares the two-attempt budget when $firstResponse is returned first`                 | 2           |
| `seo-serp-retry.test.ts`          | `does not retry 40101 when the provider marks the task envelope as failed`            | 1           |
| `voice-io-transcribe.test.ts`     | `retains bounded failure evidence without private content or duplicate reports`       | 1           |
| `chat-events-automations.test.ts` | `settles a user-owned automation $status once without Built-in charges`               | 2           |
| `feishu-integration.cases.ts`     | `builds Feishu DM context and canonical response metadata`                            | 2 platforms |

## Shared Feishu completion support (zero quota)

`completeRunSession` now captures the S3 key from the genuine checkpoint prepare
request using the actual Runner claim token and supplies the exact SHA-matching
history bytes only at that key through the external S3 transport mock. This
models the authorized Runner upload; it does not exercise a live HTTP PUT or
certify all setup/observation/cleanup branches in the parent factory. Presign
behavior is restored after prepare; preexisting S3 behavior remains for other
keys. No hash magic-list entry, private row writer or token signer is added.
The change affects 15 direct call sites, including the following unchanged
consumers. Two direct calls belong to the same fork declaration.

| Caller of `completeRunSession`                                             | Direct call sites |
| -------------------------------------------------------------------------- | ----------------- |
| `startFeishuDmSession`                                                     | 1                 |
| `uses Okou for Feishu asynchronous delivery`                               | 1                 |
| `runs a rich post with imported and native images in %s`                   | 1                 |
| `builds Feishu DM context and canonical response metadata`                 | 1                 |
| `resumes queued Feishu group tasks through the canonical session`          | 1                 |
| `runs mention-only group requests with thread history and dedupe`          | 1                 |
| `attributes mentioned group replies to the triggering user`                | 1                 |
| `resumes Feishu DM sessions across messages`                               | 1                 |
| `keeps quoted Feishu DM input on the main session and replies in a thread` | 1                 |
| `forks Feishu DM threads without replacing the main session`               | 2                 |
| `resumes Feishu DM thread sessions and keeps control replies in-thread`    | 1                 |
| `terminalizes and delivers a queued Feishu admission failure exactly once` | 1                 |
| `persists a queued Feishu admission failure when delivery fails`           | 1                 |
| `resumes mentioned group tasks in the same thread session`                 | 1                 |

The `startFeishuDmSession` helper reaches the same completion support from:

- `retains platform run history when a model change starts a fresh session`.
- `resumes Feishu DM sessions across messages`.
- `switches the main Feishu DM thread without changing the member default`.
- `keeps quoted Feishu DM input on the main session and replies in a thread`.

All consumer declarations and their original assertions remain. Other consumers'
legacy bootstrap, token or fixture branches remain unprocessed and gain no credit.

## Production, accounting and verification boundaries

- Nine helpers: one shared / eight local; four retirements and five public
  rewrites. One HTTP operation retires. Its path disappears; two nested action
  removals (`simulate-reconciliation-worker-crash` and
  `read-official-workflow-run-state`) are zero-quota orphan cleanup.
- Only after actual merge: remaining 64 helpers (33 shared / 31 local / zero
  benchmark), 25 operations / 22 paths / 111 original nested actions.
  Cumulative 170 original identities = 149 helpers (134 retired / 15 publicly
  rewritten) + 21 operations. Historical 1,125 cases and #37918 are separate.
- Production callback dispatch, official reconciliation/admission workers,
  bootstrap default selection, locks, billing, constraints, migrations and
  ordinary routes remain unchanged. Only test-only route/contract branches and
  proven orphan support retire. No `.github/workflows`, dependency, benchmark,
  timing, retry-budget or assertion-relaxation change.
- Per-case unique actors use the shared PostgreSQL backend; this is not a claim
  of isolated databases. No replacement business-row cleanup is added. Provider
  mocks remain explicit external boundaries, not live-provider acceptance tests.
- Local API type checks passed before the additional orphan cleanup. Scoped
  ESLint first rejected `try/finally`; normal promise cleanup resolved it. Oxlint
  and Knip found orphan local support and the private reader; remove the entire
  unused chain rather than suppress warnings. Preserve those failed checks in
  the ledger. Final checks passed after cleanup: API check-types (including its
  boundary guard and chat-event acceptance types), API Oxlint, scoped type-aware
  lint and ESLint, contracts/eslint-rules type checks and lint, workspace Knip
  and diff whitespace validation. No local Vitest or dev server is run; final
  behavior is verified by PR CI.
- Unread 100/101/128-thread construction/cancellation/performance, default image
  pricing, Storage prepare/commit/list/download, limited-free fabricated-token
  bootstrap, System cache, other Run/Pi/memory/projection/usage/pricing/connector/
  export and service-import exceptions remain. Full inventory retirement alone
  will not establish consolidated issue or whole-repository completion.
