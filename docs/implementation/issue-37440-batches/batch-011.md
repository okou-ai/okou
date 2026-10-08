# Batch 011: private cache and integration fixture paths

Refs #37440. Selection base: `2ee81e6b1f6e597e3fde0c4ac978a6ef2a5a0dba`.
Opening frozen balance: **115 helpers (61 shared /52 local /2 benchmark), 44 HTTP operations /39 paths /131 nested actions**. All 25 open PRs were checked; no active #37440 batch was present. This ten-row selection was recorded before implementation. #37440 stays OPEN; #33778 is superseded, not completed. Historical 1,125 cases remain separate.

## Ten original definitions

| Frozen identity (original line)                                                                                                         | All consumers / scenario value                                              | Disposition and exact loss                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turbo/apps/api/src/signals/routes/cron-refresh-home-task-recommendations.ts::createScopedHomeTaskRecommendationCronRoutesForTest` (42) | H1-H9, C1-C2 via the two cronClient definitions                             | Retire owner-scoped operator cron driver; ordinary GET/touch cannot generate cards. Keep production cron and normal GET/touch behavior.                                                                                                                                        |
| `turbo/apps/api/src/signals/routes/__tests__/home-task-recommendations.test.ts::cronClient` (55)                                        | H1-H9 via refresh/generateRecommendations                                   | Retire. Delete eight cron-dependent scenarios, retain H7 public cold GET/touch/read phase with normal onboarding; lose generated-card, exact refresh/revision/lease/provider-selection guarantees.                                                                             |
| `turbo/apps/api/src/signals/services/__tests__/home-task-recommendations-cache.service.test.ts::cronClient` (54)                        | C1-C2                                                                       | Retire with both manufactured legacy/corrupt cache/active-claim cases and service-import exceptions. No ordinary caller can write these JSONB/claim states.                                                                                                                    |
| `turbo/apps/api/src/test-fixtures/registered-volume-index.ts::alterRegisteredVolumeIndexFixture` (13)                                   | V1-V3 in workflow-volume-index-reuse; V4 in cron-official-workflow-catalog  | Retire. V1 retains normal Workflow create/update/read A-B-A content; remove private storage download, worker kick and corruption phase. Delete V2/V3 (2/3 rows) and V4. Lose exact storage version, index integrity/requeue and rejected catalog-release guarantees.           |
| `turbo/apps/api/src/test-fixtures/workflow-notion.ts::resetNotionWebhookVerification` (15)                                              | N1-N9 through verifyNotionWebhook                                           | Retire global secret DELETE. Explicit existing per-case database isolation precedes all app access, then real Notion verification handshake and signed webhooks. No reset of application rows.                                                                                 |
| `turbo/apps/api/src/signals/routes/__tests__/webhooks-notion.test.ts::verifyNotionWebhook` (344)                                        | N1-N9                                                                       | Public rewrite. One ordinary verification POST per isolated case; retain signed payload validation, debounce/duplicates, page/database pending events and account selection. No assertion or branch removed.                                                                   |
| `turbo/apps/api/src/test-fixtures/ssh-access-owner-lifecycle.ts::countUserSshAccessResourcesFixture` (12)                               | S1 creator deletion preserves shared Access and another member SSH host     | Retire SQL before/after counts; retain normal Access/SSH creation, verified Clerk deletion, surviving member list/read. Lose exact personal config/host/credential physical 1-to-0 counts.                                                                                     |
| `turbo/apps/api/src/test-fixtures/telegram-context-failure.ts::installTelegramContextFailureFixture` (12)                               | T1 split Telegram topic input storage-fault/re-delivery case                | Retire PostgreSQL trigger. Rewrite independent topic attachment/duplicate delivery/completion through ordinary onboarding, signed Telegram link/webhook, public logs and actual Runner claim. Lose forced required-context INSERT failure and rollback/re-admission guarantee. |
| `turbo/apps/api/src/test-fixtures/private-registry-resource.ts::seedPrivateRegistryResourceVersionFixture` (22)                         | R1-R5; R5 via expectArchiveDownload                                         | Retire fabricated production-pinned private versions/HEAD. Manual infrastructure upload has no ordinary existing API for chosen registry anchor IDs; delete unsupported success matrices, keep four independent public rejection cases.                                        |
| `turbo/apps/api/src/signals/routes/__tests__/registry-resources-download.test.ts::expectArchiveDownload` (374)                          | R5 downloads current website template archives; 22 sequential archive calls | Retire nested SQL seeding/download/teardown wrapper. Lose pinned website registry-to-DB mapping and 11 duplicate v2 registry constants; do not count 22 calls as 22 cases.                                                                                                     |

Exactly **six shared and four local helpers**; **nine retirements and one public rewrite**. No HTTP operation is completed. The three home recommendation helpers refer to the same consumers and count only as their three separately inventoried original definitions.

## Per-declaration manifest

Test paths below are relative to `turbo/apps/api/src/signals/`.

| ID / exact original case                                                                                  | Decision / coverage                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 `grounds completed-chat recommendations without active-run or unauthorized Gmail evidence`             | Delete; scoped CRON_SECRET execution supplies the decisive card; lose accepted-intent filtering, prompt-injection instruction and active-run/Gmail exclusion checks.                                                      |
| H2 `preserves the cached revision when a refresh finds unchanged evidence`                                | Delete; forced refresh/time step; lose same-revision/provider call reuse.                                                                                                                                                 |
| H3 `does not reuse another Agent's cached recommendation for an empty Agent`                              | Delete; populated comparison card requires private cron; lose generated-card cross-Agent isolation assertion, not a claim of equivalent cold-state coverage.                                                              |
| H4 `hides a cached recommendation when its destination starts another run`                                | Delete; private cron-created card; lose destination-busy hiding/revision change.                                                                                                                                          |
| H5 `reads Gmail only for an authorized Agent and invalidates its cached card on revocation`               | Delete; private cron is the only generation driver; lose generated Gmail card/chip/permission-revocation behavior. This is valuable intent but no normal complete driver was found; no replacement worker or endpoint.    |
| H6 `fails closed when Gmail detail permission is revoked during collection`                               | Delete; external Gmail delay is legitimate but collection begins only through the private cron; lose mid-collection fail-closed check, not because concurrency itself is forbidden.                                       |
| H7 `renews an open home's cron lease without loading or replacing cards`                                  | Rewrite to normal cold GET -> POST touch204 -> GET; retain independent read/touch behavior. Lose exact 50/65-minute lease selection/scanned count and cron notification check.                                            |
| H8 `asks the Agent to assess a Workflow only after repeated completed requests`                           | Delete; operator generation driver; lose repeated-completion candidate selection, failed/cancelled exclusion and provider decision-before-text ordering.                                                                  |
| H9 `keeps cards on malformed output and retries after the failure cooldown`                               | Delete; private refresh driver; lose cached-card retention, cooldown/recovery and post-membership-revocation cron removal.                                                                                                |
| C1 `resets a pre-purpose cache on GET and regenerates it on the next cron`                                | Delete; direct legacy JSONB seeding and scoped cron; lose migration/reset/regeneration checks.                                                                                                                            |
| C2 `does not overwrite an active claim for an explicitly invalid purpose`                                 | Delete; fabricated invalid purpose and active claim; lose expiry/claim recovery and exact scanner counts.                                                                                                                 |
| V1 `publishes A-B-A with exact canonical content and no ready-index requeue`                              | Rewrite to public Workflow create/update/GET A-B-A canonical content. Private storage download and index-worker assertions are removed along with forced corrupt-hash phase; public content remains useful independently. |
| V2 `canonically prepares a registered %s index without changing the version`                              | Delete one declaration/two rows: missing, other-extractor. Both require index mutation and worker kick.                                                                                                                   |
| V3 `rejects %s instead of silently rebuilding a registered ready version`                                 | Delete one declaration/three rows: corrupt-hash, corrupt-shape, conflicting-key. Lose manufactured integrity errors and unchanged newer HEAD.                                                                             |
| V4 `rejects a corrupted historical ready index without changing the accepted release`                     | Delete; catalog operator ingress plus deliberate historical index corruption. Neighboring catalog suite remains unprocessed.                                                                                              |
| S1 `creator deletion preserves shared Access and another member's SSH host`                               | Rewrite: normal configs/SSH POST, Clerk user.deleted, surviving member lists unchanged. Remove only private personal-row counts; do not authenticate deleted actor.                                                       |
| T1 `rejects a split Telegram topic input whose context cannot be stored and accepts a duplicate delivery` | Rewrite independent topic attachment, duplicate webhook delivery and one completion response. No DB-fault/rollback coverage claimed.                                                                                      |
| R1 `downloads the current presentation template HEAD by resource id`                                      | Delete; invented pinned anchor/HEAD rows. Lose latest-HEAD archive choice.                                                                                                                                                |
| R2 `downloads the presentation archive for the current registry digest`                                   | Delete; manufactured pinned version. Lose response digest/version/size/file-count/TTL and signing-key assertions.                                                                                                         |
| R3 `downloads the pinned $slug image style archive through the route`                                     | Delete one declaration/two rows (vm0-illustration, emboss-deboss); lose pinned archive mapping.                                                                                                                           |
| R4 `downloads the presentation reverse-template guide through the route`                                  | Delete; invented pinned guide version; lose archive mapping/metadata/signing.                                                                                                                                             |
| R5 `downloads current website template archives`                                                          | Delete one declaration, 22 sequential archive calls (11 current and 11 v2), not 22 parameter rows. Lose pinned registry lookup and redundant fixed registry digest assertions.                                            |

H1-H9: `routes/__tests__/home-task-recommendations.test.ts`. C1-C2: `services/__tests__/home-task-recommendations-cache.service.test.ts`. V1-V3: `routes/__tests__/workflow-volume-index-reuse.test.ts`; V4: `routes/__tests__/cron-official-workflow-catalog.test.ts`. S1: `routes/__tests__/cloudflare-access-lifecycle.test.ts`. T1: `routes/__tests__/integrations-telegram-post.test.ts`. R1-R5: `routes/__tests__/registry-resources-download.test.ts`.

N1-N9 in `routes/__tests__/webhooks-notion.test.ts` all retain their existing assertions:

- `acknowledges unsupported and schema-invalid signed events`
- `rejects invalid JSON and invalid signatures`
- `enqueues and debounces page content updated events for a page scope`
- `enqueues page content updated events for a database scope`
- `suppresses content updated events while child page creation is pending`
- `suppresses content updated events while database item creation is pending`
- `verifies, signs, de-duplicates, and refreshes pending child page events`
- `enqueues and refreshes pending database item events`
- `inherits explicit Notion account selection in new automations`

## Construction and observation evidence

- Home recommendations GET reads/touches demand; POST touch renews demand. Neither calls generation. The deployed `CRON_SECRET` route is operator-only; test `onlyScope` is selected by a route factory. Remove only test scoping; real production generation, ownership, locks and accounting stay intact.
- Workflow content is created through normal `workflowsCollectionContract.create`, updated/read through `workflowsDetailContract`; S3 stores only bytes these routes upload. `downloadStorage` actually calls storage-fixture/action, so it cannot remain in the retained V1.
- Notion's reset rationale assumes shared persistent state. `setupApp({ isolatePg: true })` is already supported isolation infrastructure, but it is opt-in (not automatic). Initialize it before every case's first application/DB access, then POST the provider verification token normally. Snapshot/bootstrap creates no Notion verification secret. No application-state seed/reset is introduced. Workflow setup uses normal Stripe invoice webhook/onboarding, provider credentials, Agent and Workflow endpoints; OAuth mocks are external Notion state.
- SSH membership setup is a Clerk mock, not a business DB writer. Creator erasure is verified provider ingress; the surviving member can still list their own host and shared config. Exact erased-owner row counts are intentionally lost.
- Telegram's selected case must avoid shared `bootstrapLimitedFreeOnboarding`/fabricated Run token and private `runForPrompt`/listAgentRuns. Use direct normal onboarding status/completion, signed official-bot link, genuine ingress, public logs, actual heartbeat/claim token, normal attachment preview and completion.
- Private registry success fixtures choose production-pinned version IDs and synthetic storage owners/HEAD; normal version writers cannot choose those IDs. Four independent public wrong-type/digest/allowlist rejection cases stay intact. Production registry publishing/download behavior stays unchanged.

## Scope and verification

The six shared/four local original identities were selected before source edits; no credit until merge. Org-default/Feishu candidates were inspected but not selected because the retained call chain needs broader proof; no quota. Pi, generic barriers, System cache's 11-action API, other storage-fixture consumers, usage pricing and the previously withdrawn image/unread groups remain unprocessed. No whole-suite compliance claim.

Declaration accounting: **18 whole declarations /22 expanded executions deleted; 13 declarations rewritten** (nine Notion consumers, H7/V1/S1/T1). V2/V3/R3 carry 2+3+2 deleted parameter rows; no surviving parameter table is shortened. R5's 22 iterations are disclosed separately.

Only GitHub-confirmed merge permits the conditional balance **105 helpers (55 shared /48 local /2 benchmark), HTTP unchanged at44 operations /39 paths /131 actions**. Phase would become110 original objects:108 helpers (102 retired/six public rewrites)+two HTTP operations.

No local Vitest/dev server. Static checks, independent current-HEAD review, source CI and protected merge evidence will be recorded in the PR/ledger.

## Zero-quota support cleanup and production impact

Remove the orphan home cache service-test file and both lint/import exception
entries with their obsolete #36466 rationale; these do not add item credit.
The Notion isolation hook also applies to the two account-lifecycle declarations
that never called verification; their behavior/assertions are unchanged.

Production-source edits are limited to removing the test-only route factory and
its now-unneeded `HomeTaskScope` type export and optional `onlyScope` selector from `refreshDueHomeTaskRecommendations$`.
The sole production caller previously passed `undefined`; it still checks the
same cron secret and executes the same due/active/unleased selection, order,
limit, ownership checks, transactions and provider work with its original final
AbortSignal. No real production behavior, registry data, constraint, migration,
release or deployment is changed. No HTTP operation is retired by this change.

Static validation passed: Prettier, git diff check, scoped ordinary/type-aware
Oxlint and ESLint, API aggregate types (including all three test projects and
chat-event acceptance types), Knip (only existing configuration hints), style
policy and file-size checks. AST comparison confirms the declaration totals
above. No local Vitest/dev server was run.
