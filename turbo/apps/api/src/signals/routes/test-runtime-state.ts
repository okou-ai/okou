import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
} from "@okouai/api-contracts/contracts/test-runtime-state";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runnerWssTickets } from "@okouai/db/schema/runner-wss-ticket";
import { command } from "ccstate";

import { workflowAutomations } from "@okouai/db/schema/workflow";
import { eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { writeRunMetadata$ } from "../services/agent-run-metadata-write.service";
import { saveRunSummary$ } from "../services/run-summary.service";
import { resolveRunnerWssTarget$ } from "../services/runner-wss-target.service";

import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

// Test-only support actions for generic infrastructure fixtures.

const actionBody$ = bodyResultOf(testRuntimeStateContract.action);
type RunSummaryFixtureAction = Extract<
  TestRuntimeStateActionBody,
  { action: "save-run-summary" }
>;

function isRunSummaryFixtureAction(
  body: TestRuntimeStateActionBody,
): body is RunSummaryFixtureAction {
  return body.action === "save-run-summary";
}

const runSummaryFixtureActionResponse$ = command(
  async ({ set }, body: RunSummaryFixtureAction, signal: AbortSignal) => {
    await set(
      saveRunSummary$,
      {
        runId: body.run_id,
        triggerSource: body.trigger_source,
        prompt: body.prompt,
        resultText: body.result_text,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const runMetadataFixtureAction$ = command(
  async (
    { set },
    body: Extract<
      TestRuntimeStateActionBody,
      { action: "clear-run-api-start" | "set-run-autonomy-budget" }
    >,
    signal: AbortSignal,
  ) => {
    const rows = await set(
      writeRunMetadata$,
      {
        patch:
          body.action === "clear-run-api-start"
            ? { apiStartedAt: null }
            : { autonomyBudget: body.autonomy_budget },
        where: eq(agentRuns.id, body.run_id),
      },
      signal,
    );
    if (rows.length === 0) {
      throw new Error(
        body.action === "clear-run-api-start"
          ? "Expected an agent run timing row"
          : "Expected the autonomy-budget run fixture",
      );
    }
    return { status: 200 as const, body: { ok: true as const } };
  },
);

type AutonomyBudgetFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "read-run-autonomy-budget"
      | "set-workflow-automation-autonomy-budget"
      | "read-workflow-automation-autonomy-state";
  }
>;

function isAutonomyBudgetFixtureAction(
  body: TestRuntimeStateActionBody,
): body is AutonomyBudgetFixtureAction {
  return [
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
  ].includes(body.action);
}

async function autonomyBudgetFixtureActionResponse(
  db: Db,
  body: AutonomyBudgetFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-run-autonomy-budget": {
      const [run] = await db
        .select({ autonomyBudget: agentRuns.autonomyBudget })
        .from(agentRuns)
        .where(eq(agentRuns.id, body.run_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          autonomy_budget: run?.autonomyBudget ?? null,
        },
      };
    }
    case "set-workflow-automation-autonomy-budget": {
      const [automation] = await db
        .update(workflowAutomations)
        .set({ autonomyBudget: body.autonomy_budget })
        .where(eq(workflowAutomations.id, body.automation_id))
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        throw new Error("Expected the autonomy-budget automation fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-workflow-automation-autonomy-state": {
      const [automation] = await db
        .select({
          autonomyBudget: workflowAutomations.autonomyBudget,
          enabled: workflowAutomations.enabled,
          eventConnectorId: workflowAutomations.eventConnectorId,
          lastRunId: workflowAutomations.lastRunId,
          officialBlueprintKey: workflowAutomations.officialBlueprintKey,
          officialResultEmailEnabled:
            workflowAutomations.officialResultEmailEnabled,
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, body.automation_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          workflow_automation_state: automation
            ? {
                autonomy_budget: automation.autonomyBudget,
                enabled: automation.enabled,
                event_connector_id: automation.eventConnectorId,
                last_run_id: automation.lastRunId,
                official_blueprint_key: automation.officialBlueprintKey,
                official_result_email_enabled:
                  automation.officialResultEmailEnabled,
              }
            : null,
        },
      };
    }
  }
}

type PreviousApiRunnerJobContextProfileAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-runner-job-context-profile-as-previous-api" }
>;

type PreviousApiWorkflowAutomationEventConnectorAction = Extract<
  TestRuntimeStateActionBody,
  { action: "clear-workflow-automation-event-connector-as-previous-api" }
>;

async function setRunnerJobContextProfileAsPreviousApi(
  db: Db,
  body: PreviousApiRunnerJobContextProfileAction,
  signal: AbortSignal,
) {
  // The previous API stored the routing profile in both the dedicated queue
  // column and execution-context JSON. The current reader must strip the
  // internal routing field before publishing the claim.
  const [updated] = await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{experimentalProfile}',
        to_jsonb(${body.profile}::text),
        true
      )`,
    })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a runner job for previous API profile update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function clearWorkflowAutomationEventConnectorAsPreviousApi(
  db: Db,
  body: PreviousApiWorkflowAutomationEventConnectorAction,
  signal: AbortSignal,
) {
  // The previous API did not populate the additive Gmail account projection.
  // No current production endpoint can reproduce that mixed-version row.
  const [updated] = await db
    .update(workflowAutomations)
    .set({ eventConnectorId: null })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a Workflow Automation for previous API update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}
type CompatibilityFixtureAction =
  | AutonomyBudgetFixtureAction
  | PreviousApiRunnerJobContextProfileAction
  | PreviousApiWorkflowAutomationEventConnectorAction;

function isCompatibilityFixtureAction(
  body: TestRuntimeStateActionBody,
): body is CompatibilityFixtureAction {
  return [
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
    "set-runner-job-context-profile-as-previous-api",
    "clear-workflow-automation-event-connector-as-previous-api",
  ].includes(body.action);
}

async function compatibilityFixtureActionResponse(
  db: Db,
  body: CompatibilityFixtureAction,
  signal: AbortSignal,
) {
  if (isAutonomyBudgetFixtureAction(body)) {
    return await autonomyBudgetFixtureActionResponse(db, body, signal);
  }
  switch (body.action) {
    case "set-runner-job-context-profile-as-previous-api": {
      return await setRunnerJobContextProfileAsPreviousApi(db, body, signal);
    }
    case "clear-workflow-automation-event-connector-as-previous-api": {
      return await clearWorkflowAutomationEventConnectorAsPreviousApi(
        db,
        body,
        signal,
      );
    }
  }
}
type SetOfficialWorkflowAutomationAdmissionStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-official-workflow-automation-admission-state" }
>;

async function setOfficialWorkflowAutomationAdmissionStateActionResponse(
  db: Db,
  body: SetOfficialWorkflowAutomationAdmissionStateAction,
  signal: AbortSignal,
) {
  const updated = await db
    .update(workflowAutomations)
    .set({
      ...(body.blueprint_key === undefined
        ? {}
        : {
            officialBlueprintKey: body.blueprint_key,
            officialAppliedFingerprint:
              body.applied_fingerprint ?? "0".repeat(64),
            officialParameterBindings: [],
            officialIntendedEnabled: true,
            officialResultEmailEnabled: false,
          }),
      officialReconciliationStatus: body.reconciliation_status,
      ...(body.applied_fingerprint
        ? { officialAppliedFingerprint: body.applied_fingerprint }
        : {}),
    })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Official Workflow Automation is unavailable");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

const specializedRuntimeFixtureAction$ = command(
  async ({ set }, body: TestRuntimeStateActionBody, signal: AbortSignal) => {
    const db = set(writeDb$);
    if (body.action === "set-official-workflow-automation-admission-state") {
      return await setOfficialWorkflowAutomationAdmissionStateActionResponse(
        db,
        body,
        signal,
      );
    }
    if (body.action === "resolve-runner-wss-target") {
      const target = await set(
        resolveRunnerWssTarget$,
        {
          runId: body.run_id,
          owner: { userId: body.user_id, orgId: body.org_id },
          now: body.now ? new Date(body.now) : nowDate(),
          purpose: "issue",
        },
        signal,
      );
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          wss_target: target
            ? { ...target, observedAt: target.observedAt.toISOString() }
            : null,
        },
      };
    }
    if (body.action === "expire-runner-wss-tickets") {
      await db
        .update(runnerWssTickets)
        .set({
          expiresAt: sql`timezone('UTC', clock_timestamp()) - interval '1 second'`,
        })
        .where(eq(runnerWssTickets.runId, body.run_id));
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    return null;
  },
);

const postRuntimeStateAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    if (
      body.action === "clear-run-api-start" ||
      body.action === "set-run-autonomy-budget"
    ) {
      return await set(runMetadataFixtureAction$, body, signal);
    }
    const db = set(writeDb$);
    if (isRunSummaryFixtureAction(body)) {
      return await set(runSummaryFixtureActionResponse$, body, signal);
    }
    if (isCompatibilityFixtureAction(body)) {
      return await compatibilityFixtureActionResponse(db, body, signal);
    }
    const specializedFixture = await set(
      specializedRuntimeFixtureAction$,
      body,
      signal,
    );
    if (specializedFixture) {
      return specializedFixture;
    }
    throw new Error("Unsupported runtime fixture action");
  },
);

export const testRuntimeStateRoutes: readonly RouteEntry[] = [
  {
    route: testRuntimeStateContract.action,
    handler: postRuntimeStateAction$,
  },
];
