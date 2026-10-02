# Issue 37513: allowance worker increment

## Ownership and integration boundary

This increment starts from `9900095aaafb9386daeedfea5d51dcfcac9734b5` on
`refactor/api-ccstate-terminal-37513`. It is for the existing Draft PR #37525,
not a separate PR or a terminal-conformance declaration.

The worker does not edit `pick-chat-run.service.ts`, `claim-run-context.ts`, or
`agent-run-execution.service.ts`. Their owners must apply the adaptations below
before integrating this increment. Do not preserve the old handle-taking APIs
as compatibility wrappers.

## Changed chain

- `usage-allowance.service.ts`: remove the narrowed `UsageAllowanceStore` and
  the complete legacy entitlement/window I/O helper chain, including
  `resolveAvailabilityInTransaction`, `activateUsageAllowanceWindowsForRun`,
  `readUsageAllowanceAvailabilitySnapshot`, and the legacy DB-taking availability
  resolver. Remove the now-unconsumed availability graph factory. Preserve the
  parent's `refreshUsageAllowanceAvailability$`, its captured entitlement facts,
  exact-snapshot CAS, and external preparation boundary.
- `usage-allowance-availability.service.ts`: the stable organization availability
  command reads one bounded observation and, only if required, calls external
  preparation followed by the parent's refresh command. Its independent refresh
  transaction is removed.
- `usage-allowance-availability-plan.ts`: share the bounded query and nullable
  window remaining-units calculation. The parent refresh command now reads at
  most two windows rather than materializing every covering legacy window.
- `usage-allowance-policy.ts`: the defining module for active statuses and
  payment-failure cutoff. It breaks the service/query import cycle; consumers
  import it directly, without re-export adapters.
- `usage-allowance-run-availability.service.ts`: one public stable Run command.
  Previously issued windows still back the Run after its current entitlement
  period. New issuance reuses the parent refresh command, then atomically
  publishes both missing kinds with the exact entitlement snapshot and
  tenant-owned Run as SQL gates. The independent Run-availability transaction
  and `issueRunWindow(tx, ...)` helper are removed.
- `usage-allowance-run-plan.ts`: pure plan, predicate, query, and guarded INSERT
  builders. No I/O, accessors, nodes, or DB capabilities are accepted. The parent
  launch command can use these inside its necessary launch transaction.
- `usage-allowance-settlement-plan.ts` and `pi-memory-builtin-quota.service.ts`:
  policy imports only; no settlement or quota redesign.
- `run-admission.service.ts`: replace the node-injected factory and legacy
  allowance callback resolver with stable `checkRunAdmission$` and
  `checkOrgCreditsForRunAdmission$`. Inputs are plain captured catalog/model/
  organization/member facts; all allowance and admission reads are owned by
  commands. The native account-metadata query retains organization/member/type/
  disconnected filtering and the existing pure member-subscription policy.
- Pi Stage 1/Phase 2 admission consumers and `test-usage-settlement.ts`: call the
  new command with plain facts and the owner's final-position signal. Stage 1's
  provider callback dispatches a private command, not a captured DB handle.
  Its finite irreversible-result reconciliation is a separate stable command:
  observed usage and outcome are persisted before propagating cancellation.
- `managed-usage.service.ts` and `social-data.service.ts`: the Social owner reads
  the allowance snapshot through the pure query builder and passes plain facts
  into the existing credit-budget check. The deleted allowance helper no longer
  receives a transaction. External refresh stays outside the existing Social
  owner-row transaction; its pre-existing budget recheck is not expanded.

## Required owner patches

### 1. `claim-run-context.ts`: policy imports

Remove `ACTIVE_ALLOWANCE_STATUSES` and `activeAllowanceCutoff` from its
`usage-allowance.service` import, and add:

```ts
import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
} from "./usage-allowance-policy";
```

Keep `remainingUnits`, `createUsageAllowanceRefreshObject`, the parent's
`refreshUsageAllowanceAvailability$`, and its existing preparation types from
the service. Do not replace its catalog snapshot ownership or add node bundles.

### 2. `agent-run-execution.service.ts`: admission checks

Remove the `createRunAdmissionObjects` import and import `checkRunAdmission$`.
Delete the `internalInput$`/`input$` parameter-slot graph inside
`createRunAdmissionCheckObjects`. Replace its check graph with this stable
command selection (construct it outside command execution):

```ts
function createRunAdmissionCheckObjects() {
  const checkPlanStatus$ = command(
    async ({ set }, input: RunAdmissionInput, signal: AbortSignal) => {
      const capabilities = await set(
        loadOrgPlanCapabilities$,
        input.orgId,
        signal,
      );
      return capabilities?.status === "active" ? null : insufficientCredits();
    },
  );
  return { checkAdmission$: checkRunAdmission$, checkPlanStatus$ };
}
```

Import `loadOrgPlanCapabilities$` from its defining service as needed. Keep the
existing call sites' captured plain `RunAdmissionInput` and final-position
signal. Each admission phase gets fresh command-owned reads, not a cached
previous phase or a newly constructed graph inside a command.

### 3. Both launch owners: inline allowance activation SQL

Delete imports and calls of `activateUsageAllowanceWindowsForRun`. In the
**owning launch command's SQL-only transaction callback**, after the fenced Run
INSERT succeeds, inline the following SQL sequence. Do not put it in another
`(tx, args)` helper or a timing closure that captures `tx`.

Needed imports:

```ts
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import {
  planRunAllowanceActivation,
  runAllowanceWindowInsertSql,
  runAllowanceWindowsQuery,
  unchangedRunAllowanceEntitlement,
} from "./usage-allowance-run-plan";
import { entitlementQuery } from "./usage-allowance-settlement-plan";
```

`sql` is the existing Drizzle import. `activation` is a plain value:

- Pick owner: `{ orgId: input.args.orgId, runId: persisted.run.id,
runCreatedAt: persisted.run.createdAt, refresh: context.allowanceRefresh }`.
- Prepared-launch owner: `{ orgId: commit.createArgs.orgId, runId: run.id,
runCreatedAt: run.createdAt, refresh: commit.allowanceRefresh }`.

Run this only on the existing Built-in-provider branch, using the already
externally prepared `refresh`. In the snippet, `tx` is local to the owning
command's transaction callback and `signal` belongs to that command:

```ts
const [owned] = await tx.select().from(entitlementQuery(activation.orgId));
signal.throwIfAborted();
const planned = planRunAllowanceActivation(owned, activation, nowDate());
let entitlement = planned.entitlement;
if (planned.update && owned) {
  const [published] = await tx
    .update(orgUsageAllowanceEntitlements)
    .set(planned.update)
    .where(unchangedRunAllowanceEntitlement(owned))
    .returning({
      snapshot: sql`${orgUsageAllowanceEntitlements}::text`.mapWith(
        pgTextDecoder,
      ),
    });
  signal.throwIfAborted();
  if (!published) {
    throw new Error("Run allowance changed during refresh publication");
  }
  if (entitlement) {
    entitlement = { ...entitlement, snapshot: published.snapshot };
  }
}
if (entitlement) {
  await tx.execute(runAllowanceWindowInsertSql(activation, entitlement));
  signal.throwIfAborted();
  const windows = await tx
    .select()
    .from(
      runAllowanceWindowsQuery(
        activation.orgId,
        activation.runCreatedAt,
        entitlement,
      ),
    );
  signal.throwIfAborted();
  if (
    !windows.some((window) => window.kind === "short") ||
    !windows.some((window) => window.kind === "weekly")
  ) {
    throw new Error("Run allowance changed during window publication");
  }
}
```

Keep existing timing action names using ordinary start/end facts around this
SQL sequence. Keep the actual fenced launch write, R1 billing attribution,
producer binding, and session publication in their owning command. A Run-ID
existence predicate is **not** a replacement for the parent's lease/fence.
Do not move Stripe preparation into the transaction, or convert a snapshot
conflict into credit fallback. The launch owners still decide whether their
remaining transaction is necessary; this increment neither removes nor proves
conformance of those transactions.

## Invariants and cost boundary

- Identity remains `(entitlement_id, kind, starts_at)`. `ON CONFLICT DO NOTHING`
  never updates `consumed_units` or grants a second balance for the same identity.
  Distinct concurrently admitted Run anchors may still create overlapping windows,
  as already accepted; canonical reads order start descending and UUID ascending.
- Both newly missing kinds are inserted in one statement. Publication requires
  the exact entitlement text snapshot and Run ID/organization/created-at match.
  A conflict is followed by one bounded canonical read, not another issuance
  attempt. A surviving Run with an incomplete result fails explicitly.
- Window issuance is an observation-backed initialization, not a money reservation.
  No usage allocation, credit deduction, financial receipt, R1 attribution,
  fencing, or entitlement-preparation logic is removed.
- Existing issued windows remain usable by a Run after entitlement expiry.
  Entitlement deletion cascades its windows; Run deletion nulls the attribution
  FK. A deletion race during insertion is handled through natural FK enforcement,
  not new locks or retry state. A cancellation after publication can leave valid
  issued windows; they grant no duplicate charge/credit and retain their normal
  expiry and existing cleanup lifecycle.
- The bounded query uses two LATERAL probes with `LIMIT 1`, against the existing
  organization/kind/start and entitlement/kind/start indexes. The INSERT has only
  two candidate kinds and conditional existence probes. Generated SQL and bound
  timestamps were inspected. No production EXPLAIN, buffer/cost measurement, or
  concurrent database execution was performed; bounded output is not proof of
  production planner performance.

## Verification and honest residuals

- No local Vitest, development server, new hook, row assertion, suppression,
  timeout increase, lock, or retry was added/run.
- Affected TypeScript Prettier and ESLint pass. API-cwd ordinary Oxlint passes.
  Affected-file API-cwd type-aware Oxlint passes with `GOMAXPROCS=1`.
  Whole-source type-aware Oxlint was terminated with exit 137; it is not a pass.
- `TSC_CHECKERS=1 pnpm check-types` was attempted. Dependency/public declarations
  and project-boundary checks pass. Gateways/core cannot pass until the reserved
  files adopt the interfaces above: five unresolved imports generate nine
  diagnostics, including downstream status/void inference. No diagnostic remains
  in this worker's changed files. Standalone routes, bootstrap, both test type
  programs, bootstrap wiring, and chat-event acceptance type stages pass; these
  partial successes do not mean the aggregate or integrated branch passes.
- API-workspace Knip reports the baseline unused `loadedMemberModelRouteContext`
  and `loadOrgModelPolicyFacts` exports. Both have only their definitions at the
  exact base SHA; no new unused export is intended in this increment.
- An uncommitted, synthetic-config SQL construction check serialized the guarded
  INSERT and both bounded read queries, checked Date binding encoding and plain
  entitlement time bounds, and passed all three statements through PostgreSQL's
  parser. This is not database behavior or concurrency acceptance.
- Existing public route coverage remains in `usage-allowance.test.ts`,
  `usage-settlement`/billing route tests, Social data tests, and Pi memory boundary
  tests. No tests were removed. CI and realistic database execution remain for
  the parent after integration.
- The existing credit-only DB-taking helpers in `run-admission.service.ts`,
  `managed-usage.service.ts`, Social admission, and Pi processing remain outside
  this allowance-interface migration. They are not relabeled as terminal.
  The two reserved launch callers still contain their old handle-taking calls
  until their owners apply these patches. This report is not a lexical-alias
  claim that the entire billing/launch architecture has converged.
