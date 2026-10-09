# Batch 018 — public authentication, memory writes, and removal of private controls

Refs #37440. Pre-implementation selection recorded against main
`a2189418b48f7dab6b8d5b9237f7d4c6bfd20d4e` on 2026-10-09.
Sole implementation owner: thread `c05f2453-3345-4525-9aa8-85c3ba036d2b`;
branch `fix/37440-batch18`. Dispatch receipt:
`issue-37440-dispatch:9e55b659-76a7-4132-a16a-28ddd3629edd`.

Opening balance: 64 helpers (33 shared, 31 local, 0 benchmark), 25 HTTP
operations / 22 paths / 111 original nested actions. Batch 017 is already
accounted once. This document confers no credit before an actual protected
merge. Current ledger: [page 009](https://github.com/okou-ai/okou/issues/37440#issuecomment-6072258707).

## Ten original identities and caller decisions

Paths below are relative to `turbo/apps/api/src/`, except HTTP identities.
The frozen baseline remains unchanged. Factories and their returned methods
are one identity; aliases, cases, actions and orphan support count zero.

| #   | Original identity                                                              | Disposition and complete caller scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `signals/routes/__tests__/web-search.test.ts::fundActor`                       | Retire. Its two Clerk transport/recovery parameterized callers use the existing onboarding, Stripe subscription/invoice callbacks, public billing observation and organization-deletion callback lifecycle. Remove its orphan `setActorCredits` writer.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | `signals/routes/__tests__/web-search.test.ts::setupConfiguredWebSearchPricing` | Retire. All local callers use the existing fixed development Perplexity request price (5 credits), without an alias or per-case SQL setup/cleanup. Preserve provider conversion, bounds, cancellation, concurrency, billing and error branches. Delete the synthetic mid-response SQL price deletion fault case; it does not represent a user/provider transition.                                                                                                                                                                                                                                                                                                                |
| 3   | `signals/routes/__tests__/helpers/api-bdd-run-reads.ts::createRunReadsApi`     | Public rewrite. Its private `requestListAgentRuns` method has one scenario in `run-reads.bdd.test.ts`; replace it with existing GET `/api/logs`, preserving real onboarding/subscription, agent creation, chat admission, Runner claims/completions, owner isolation and queue release. All other returned methods already call normal routes and remain unchanged. Do not count or certify parent `createRunsApi` or `listAgentRunsFixture`, which have other consumers.                                                                                                                                                                                                         |
| 4   | `test-fixtures/storage.ts::readStorageIdentityFixture`                         | Retire. Callers are `commitMemoryVersion`, `readStorageS3PrefixFixture`, and the single `storage-write-phase2-reconciliation.service.test.ts` case. Real Runner mount identity replaces the memory read. Delete the service case's fabricated Phase 2 job/revision matrix and direct SQL teardown, plus its obsolete import exceptions; production reconciliation remains.                                                                                                                                                                                                                                                                                                        |
| 5   | `test-fixtures/storage.ts::readStorageS3PrefixFixture`                         | Retire. Memory obtains the exact upload key from Runner prepare. Delete only the system-cache suite's private owned-system/primary-org precedence scenario (custom system rows, forced HEAD deletion and direct prefix inspection); retain adjacent cache scenarios without certifying them.                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `signals/routes/__tests__/helpers/memory.ts::commitMemoryVersion`              | Public rewrite. Three callers: the Pi activity checkpoint case and two Pi memory recall cases. Use actual claimed Run mount ID, issued sandbox credential, POST `/api/webhooks/agent/storages/prepare` and `/commit`, SHA-matching content/manifest bytes at authorized object keys, then public completion/continuation/cancellation. No arbitrary Storage fixture or DB identity read. The selected activity carrier uses personal Codex OAuth and existing Luna catalog pricing instead of a private Built-in key/price setup.                                                                                                                                                 |
| 7   | GET `/api/test/auth-probe`                                                     | Retire route/contract. `hooks-ops.bdd.test.ts` keeps public health and uses GET `/api/auth/me`; `user-config.bdd.test.ts` keeps session/PAT identity, missing/malformed/forged credentials, membership cache and PAT expiry through the same normal route. Replace positive fabricated sandbox/agent credentials in the selected probe case with a real Runner claim. Internal AuthContext role/token-type serialization and arbitrary capability opt-in are not public contracts. Adjacent user-config fake-token branches remain separately inventoried.                                                                                                                        |
| 8   | POST `/api/cli/auth/test-enable-connector`                                     | Retire. All callers are the six `CLI-TEST: test-enable-connector` cases via `api-bdd-auth-device`; delete endpoint-specific fixture validation, implicit privatization, email lookup and preview-bypass tests with the handler, contract and client methods. Existing normal user connector enablement and ownership tests remain; the other three CLI test operations are not completed.                                                                                                                                                                                                                                                                                         |
| 9   | POST `/api/test/memory-summary-projection-state/action`                        | Retire all six actions. Callers: `helpers/memory.ts::seedReadyMemorySummaryProjection` in two Pi memory cases, and the five declarations in `memory-summary-projection.test.ts`. Preserve independently public Runner memory publication and continuation/flag-off writeback phases. Remove exact forced-ready, forced-due, internal projection reads, parser/worker status, backfill and retry-counter assertions. No replacement cron/private worker kick. Production projection workers, parsing, locks and constraints remain.                                                                                                                                                |
| 10  | POST `/api/test/user-config-state/action`                                      | Retire all three actions and `helpers/user-config-state.ts`. `run-lifecycle.bdd.cases.ts`: delete the obsolete plain secret/variable precedence matrix; keep enabled-but-unconnected connector rejection and built-in/custom URL isolation without obsolete plaintext-row setup. `connectors.bdd.test.ts` and three external-code scenarios keep normal connect/list/bindings/delete observations, removing SQL secret-name/encryption assertions. `cron-connector-catalog.test.ts` retains its existing catalog scenarios without the redundant private secret reader; remaining catalog/credential-storage/CLI-fixture chains are explicitly unprocessed, not certified public. |

## Value and coverage boundaries fixed before implementation

- Web Search's successful requests, exact normal five-credit settlement, provider
  failures, output size/control-character handling, request cancellation and
  concurrent requests are meaningful behavior. The artificial deletion of the
  pricing row between admission and settlement is removed. An unrelated forged
  capability token case is not a substitute for a real Run.
- Log listing retains normal status/agent/since filters, owner isolation, run
  detail and queue capacity/cancellation/completion. The removed service's
  active-only default, comma-status grammar, `until` parameter and exact service
  error strings are not claimed equivalent to the existing logs API.
- Memory publication, H2 atomic completion/idempotency, frozen history,
  continuation, failure and cancellation remain valuable. Exact asynchronous
  projection materialization is not made user-drivable solely for these tests.
  Removing worker instrumentation loses the 11 malformed-source rows, two
  forced-retry rows, forced backfill, full-source token accounting and injected
  ready-recall timing. Preserve public stages independently; do not delete the
  large H2 scenario because one memory writer was private. The deleted projection
  matrix's asserted outcomes were worker counters, internal parser status and
  stored materialization rows, not the delivered Run recall contract. Without a
  normal externally driven materialization step, keeping publication alone for
  each malformed archive would not prove those guarantees. Keep the useful
  public publication/deduplication stage once, and disclose the removed safety
  coverage rather than claiming the parser behavior is unimportant or repaired.
- Plain `zero secret`/`zero variable` writers were retired in #25011. Existing
  production readers remain. Removal of fixture-only precedence rows loses
  legacy persisted-row precedence and plaintext-token impersonation coverage;
  normal connector credentials and public non-disclosure remain.

## Final case census and exact retained stages

The affected declarations are 52 before / 38 after; their parameter-expanded
executions are 70 before / 45 after. This is **14 removed declarations / 25
removed executions**, with 38 retained declarations / 45 executions rewritten
or having private sub-observations removed. Renames are retained cases, not
new case credit. Unchanged neighboring cases are not in these totals.

| Scenario/file           | Retained affected declarations / executions | Removed declarations / executions | Precise boundary                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Search              | 18 / 25                                     | 1 / 1                             | Retain 3 recovery rows, 2 bounded-failure rows, 5 malformed-provider rows and 15 individual behaviors. Remove mid-response deletion of the SQL pricing alias only.                                                                                                                                                                                  |
| Pi activity             | 1 / 1                                       | 0 / 0                             | Retain large H2 sequence, atomic completion, late/idempotent writes, failure, cancellation, native incompatibility and two-token thread totals. Carrier changes from fixed Auto/OpenRouter to normal personal Codex Luna OAuth, so this case no longer proves fixed Auto/OpenRouter routing.                                                        |
| Pi memory               | 2 / 2                                       | 0 / 0                             | Retain public publication, native continuation, current memory mount and flag-off writeback. Remove injected ready-summary text, forced materialization timing and ready-on/off contrast.                                                                                                                                                           |
| Memory projection       | 1 / 1                                       | 4 / 15                            | Retain actual Runner publication and normal prepare deduplication. Lose gzip-recompression equivalence, 11 malformed-source rows, 2 forced retry rows, backfill and over-prompt-budget materialization assertions.                                                                                                                                  |
| CLI connector fixture   | 0 / 0                                       | 6 / 6                             | Remove the six endpoint-control self-tests: production hiding, schema rejection, default-agent privatization guard, fixture enable, foreign actor and preview bypass. Ordinary connector APIs remain.                                                                                                                                               |
| Legacy user config      | 2 / 2                                       | 1 / 1                             | Retain enabled-but-unconnected connector omission and connector/custom-URL isolation. Lose legacy org/user/request plaintext precedence and secret-name impersonation.                                                                                                                                                                              |
| Connector account flows | 6 / 6                                       | 0 / 0                             | Manual connector + AWS + two Nintendo + two catalog cases keep remaining assertions. Remove private secret names/encryption/deletion-row observations. Catalog/CLI fixture setup remains private and is not certified.                                                                                                                              |
| Public identity/health  | 7 / 7                                       | 0 / 0                             | Keep session/PAT identity, 30s/120s/125s membership-cache phases, 91-day PAT expiry, malformed/forged rejection and public health. Real claim supplies both sandbox and agent credentials in one case (two loop branches, not two test cases). Lose AuthContext role/token-type/run-id/capability serialization and fabricated opt-in combinations. |
| Run listing             | 1 / 1                                       | 0 / 0                             | Existing logs API preserves status/agentId/since/owner filters and all remaining detail/queue/cancel/complete assertions. Two invalid-query loop branches remain. Logs includes completed runs by default; it does not implement the old service's active-only default, agent-name filter, comma-status or until window.                            |
| System storage cache    | 0 / 0                                       | 1 / 1                             | Remove only the manufactured owned-system vs primary-org precedence/HEAD fallback case; other cache matrices remain unresolved.                                                                                                                                                                                                                     |
| Phase 2 service fixture | 0 / 0                                       | 1 / 1                             | Remove direct job/revision writes and internal transaction reconciliation assertion. Production reconciliation remains.                                                                                                                                                                                                                             |

S3 remains an external dependency mock, not an actual HTTP PUT. The rewritten
memory helper supplies SHA-matching archive/manifest bytes only at keys returned
by real prepare authorization. Actual claim-issued storage identity and
credentials drive both prepare and commit. Unique actors share PostgreSQL;
there is no per-case database claim or replacement business-row teardown.

## Production and collateral changes (zero extra quota)

Remove the four selected test operations, their contracts/client methods and
orphan support. The auth probe was registered only inside its test helper.
Remove the sole Phase 2 service test and its two obsolete lint import entries.
Remove both orphan projection read commands (`readMemorySummaryProjection$`
and `readMemorySummaryProjectionObservation$`); the production batched read and
`memorySummaryProjectionReadResult` validator remain. Remove the scoped worker
selector, whose only non-undefined caller was the removed test route. Production
cron still passes the same current time and uses the unchanged batch sizes
(backfill 8 / work 4), leases, locks, parsing, retry policy and writes. No billing,
constraints, migrations, normal user-route behavior, CI workflows or dependencies
are changed.

## Validation and final accounting

No local Vitest/dev server. Static AST census only; runtime validation belongs to
PR CI. Scoped ESLint/Oxlint and all three API test type-check shards passed.
Foundation/admission/core/routes declaration checks and workspace Knip also passed.
Knip retains its pre-existing configuration hints, with no unused-code errors. The earlier routes-only check detected an accidentally removed adjacent
connector-output-target helper, restored before commit; a later routes-only check
saw a stale pre-refresh worker declaration. Neither is a runtime CI pass or flake.
Independent current-HEAD review, required PR CI and protected queue remain pending.
Identity delta if merged: six helpers (four
retirements, two public rewrites; four shared/two local), four HTTP operations /
four paths / nine original nested actions. No deduction before MERGED.
Expected resulting balance: **58 helpers (29 shared / 29 local / 0 benchmark),
21 HTTP operations / 18 paths / 102 original actions**. Cumulative 180 original
identities = 155 helpers (138 retired / 17 public rewrites) + 25 operations.

Storage's other test fixture actions, limited-free fabricated Run tokens,
System cache, other Run/Pi/memory/pricing/usage/connector/export chains,
service/import exceptions, unread construction/performance/cancellation and
Image default-pricing failures remain unresolved. No whole-module or
whole-repository completion claim. #37440 remains OPEN.
