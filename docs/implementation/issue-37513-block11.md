# Issue 37513 — block11 partial implementation handoff

Base: `5b333105e96a80790948ed169ae915a10c89ffbe`.

**This slice is partial. Neither named service file is terminal-complete.**
The feature-switch write/invalidation chain is migrated; the legacy context
adapter and the general Pi publication/storage-demand interfaces remain.
No PR, review, merge, release, workflow or production action is part of this slice.

## Implemented business behavior

- `updateUserFeatureSwitches$` owns a single multi-row `INSERT ON CONFLICT`.
  The conflict branch filters the stored JSONB to registered keys and merges
  `excluded.switches` in PostgreSQL. It never replaces unrelated concurrent
  keys with a pre-read snapshot. Personal and organization rows share the
  existing `(org_id, user_id)` unique key; no schema change is needed.
- `deleteUserFeatureSwitches$` owns the caller-row delete, organization-key
  subtraction and conditional empty-row cleanup. Subtraction and empty-row
  deletion inspect the live database value, not a pre-read value. Organization
  overrides still affect every member; peer personal overrides are untouched.
- Neither feature-switch writer has an explicit transaction or passes a DB
  handle to another function. Invalidation commits independently, as approved
  for low-frequency configuration. Cancellation or failure after a source
  commit does not roll that source commit back. Existing canonical source
  validation remains the recovery path; no retry or fallback is introduced.
- New `invalidateFeatureSwitchPiStableContexts$` accepts only
  `{ orgId, userId? }` and a final `AbortSignal`. It gets `writeDb$` itself,
  advances matching generations with arithmetic, reads stale head identities
  once, and clears them in batches of at most 256. Existing head generation
  conditions prevent clearing a concurrently rebuilt head. The stale-source
  predicate also excludes heads already rebuilt at the current generation.
- This feature-only chain does not enter the legacy invalidation helpers,
  `recapturePiStableContextInput`, row locks, transaction callbacks or external
  services. It leaves heads `missing`; the next canonical demand captures
  current sources and schedules a build. It deliberately does **not** preserve
  the former eager warming of up to 16 captured variants. The canonical-use
  rebuild remains; its behavioral integration verification is still required.
- `userFeatureSwitchOverrides` reads inside its computed; the context factory
  constructs its override node before the context computed runs.
  `loadUserFeatureSwitchContext$` reads `db$` itself and returns definite
  overrides. Direct route/command consumers in this slice use the computed
  or read command instead of supplying their connection.
- Pure scope splitting/row projection stays ordinary TypeScript.
  `ORG_SCOPED_FEATURE_SWITCH_KEYS` is exported for SQL key subtraction; the
  now-unused `withoutOrgScopedFeatureSwitches` helper is removed.

No OAuth, tenant, ownership, permission, billing, money, idempotency or lease
contract is intentionally changed. No new lock, timeout, state atom, retry,
production test hook or coordination column was added.

## Public feature-switch exports

| Export                                            | Shape / status                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `userFeatureSwitchOverrides(orgId, userId)`       | Plain identity factory returning a computed                              |
| `userFeatureSwitchContext(orgId, userId)`         | Closed plain-identity context graph                                      |
| `loadUserFeatureSwitchContext$`                   | Read command; final optional caller signal retained for existing callers |
| `updateUserFeatureSwitches$`                      | Writing command; final required signal                                   |
| `deleteUserFeatureSwitches$`                      | Writing command; final required signal                                   |
| `loadUserFeatureSwitchContext(db, orgId, userId)` | **Remaining legacy DB-handle adapter; not terminal**                     |

The new Pi public export is `invalidateFeatureSwitchPiStableContexts$`.
All prior general Pi exports remain unchanged; the new export must not be
mistaken for a full-file interface migration.

## Exact remaining generation-service DB parameters

Each function below still has its first parameter `db: Db` in
`pi-stable-context-generation.service.ts` (22 parameters in total).

- `invalidateKnownHeads`
- `advanceGeneration`
- `invalidatePiStableContext`
- `lockHeadSet`
- `readCapturedHeadDemands`
- `resetLockedHeadSet`
- `invalidateHeadSet`
- `advanceGenerationSet`
- `invalidatePiStableContextsForUser`
- `invalidatePiStableContextsForOrg`
- `invalidateAllPiStableContexts`
- `invalidatePiStableContextsForCatalogSource`
- `beginPiStableContextPublication`
- `retirePiStableContextStorageDemands`
- `enqueuePiStableContextStorageDemands`
- `refreshPiStableContextStorageDemands`
- `updatePublicationReadiness`
- `retirePiStableContextPublication`
- `completePiStableContextPublication`
- `lockPiStableContextGenerationScopes`
- `lockPiStableContextPublicationKey`
- `lockPiStableContextPublication`

Remaining internal handle chains:

1. General invalidation/publication -> `advanceGeneration` or
   `advanceGenerationSet` -> `invalidateKnownHeads` / `invalidateHeadSet` ->
   `lockHeadSet`, `readCapturedHeadDemands`, `resetLockedHeadSet` ->
   `recapturePiStableContextInput` in the separate recapture service.
2. Storage demand enqueue/refresh -> captured generation/head reads and writes;
   instruction/storage publication still passes its owning transaction into
   these exported helpers.
3. Complete/retire publication -> `updatePublicationReadiness`, with keyed
   generation/token fencing and multiple pending publication keys.
4. Catalog-source invalidation -> `lockPiStableContextGenerationScopes` ->
   `advanceGenerationSet` -> legacy head invalidation.

Direct production caller families still needing migration:

- Routes: `workflows.ts`, `agents.ts`, `agent-instructions.ts`.
- Services: `official-workflow-installation`, `workflow-update`,
  `workflow-delete`, `feishu-custom-connector`, `custom-connector`,
  `storage-write`, `user-connectors`, `chat-thread-connector-selection`,
  `agent-instructions-storage`, `user-permission-grants`,
  `connector-catalog-sync`, `cron-sync-skills`,
  `connector-catalog-runtime-reconciliation` (all `.service.ts`).
- Existing internal tests and `src/test-fixtures/pi-stable-context.ts` also
  consume the legacy surface. Those internal assertions were not expanded.

## Remaining transaction and atomic invariant

- `feature-switches.service.ts`: **zero** explicit transactions.
- New feature-only invalidation command: **zero** explicit transactions.
- `pi-stable-context-generation.service.ts`: one existing explicit
  `db.transaction` in `beginPiStableContextPublication`. It advances a scope to
  pending, invalidates existing heads and writes the exact keyed publication
  token/generation as one reservation. It still passes `tx` to
  `advanceGeneration`, so it is **not** an approved terminal owning command.
  General callers also pass their existing source-write transactions into the
  other helpers. These invariants need caller-level restructuring, not merely
  wrapping the helpers in separately committing commands.

## Remaining feature-context legacy callers

The adapter retains `db: Pick<ReadonlyDb, "select">`. The following 25 call
sites remain under `src/signals/services/`; these services' unrelated DB and
transaction lifecycles were not silently rewritten:

| File                                                                | Call-site lines in this slice |
| ------------------------------------------------------------------- | ----------------------------- |
| `pi-memory-stage1-schedule.service.ts`                              | 118, 377, 469, 610            |
| `pi-memory-phase2-credential.service.ts`                            | 375, 485, 531                 |
| `github-oauth.service.ts`                                           | 840                           |
| `social-data.service.ts`                                            | 146                           |
| `mcp-chat-discovery.service.ts`                                     | 481                           |
| `connector-runtime-sync.service.ts`                                 | 281                           |
| `pi-memory-stage1-credential.service.ts`                            | 603                           |
| `discord-config.ts`                                                 | 45                            |
| `pi-memory-stage1-worker.service.ts`                                | 787                           |
| `pi-memory-stage1-candidate.service.ts`                             | 359                           |
| `stripe-invoice-paid-workflow-automation-feature-switch.service.ts` | 19                            |
| `agent-webhook-firewall-auth.service.ts`                            | 4550, 5403                    |
| `internal-slack-chat-run-callback.service.ts`                       | 221, 388                      |
| `runner-vnc-authority.service.ts`                                   | 109                           |
| `model-policy.service.ts`                                           | 1045                          |
| `feishu-config.ts`                                                  | 164                           |
| `canonical-slack-thread-status.service.ts`                          | 264, 306                      |

## Verification boundary

Added public feature-switch API cases cover concurrent unrelated personal keys,
unknown-key filtering plus same-key replacement, and deletion isolation across
organization members. They use public endpoints for setup and assertions, no
DB rows, service mocks, delays, retries or test hooks.

Local static checks cover affected Prettier, ESLint, Oxlint (including affected
production type-aware lint), API dependency/gateway/core/routes and test type
checks, and workspace Knip. Behavioral tests and deployed Pi rebuild acceptance
are left to parent PR CI; no local Vitest or dev server was run. The work is
mergeable as an implementation increment, **not** evidence that issue 37513 or
either named service file reached its terminal shape.
