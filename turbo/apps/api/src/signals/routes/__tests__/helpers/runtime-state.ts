import type {
  TestRuntimeStateActionBody,
  TestRuntimeStateActionResponse,
} from "@okouai/api-contracts/contracts/test-runtime-state";

import type { TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";

import { testRuntimeStateRoutes } from "../../test-runtime-state";

const RUNTIME_STATE_ROUTE = "/api/test/runtime-state";

function requestRuntimeState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testRuntimeStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestRuntimeStateActionBody,
): Promise<TestRuntimeStateActionResponse> {
  const response = await requestRuntimeState(
    context,
    `${RUNTIME_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `runtime state action ${body.action}`);
  return await readJson<TestRuntimeStateActionResponse>(response);
}

export async function readWorkflowAutomationAutonomyFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly autonomyBudget: number;
  readonly enabled: boolean;
  readonly eventConnectorId: string | null;
  readonly lastRunId: string | null;
  readonly officialBlueprintKey: string | null;
  readonly officialResultEmailEnabled: boolean | null;
} | null> {
  const response = await postAction(context, {
    action: "read-workflow-automation-autonomy-state",
    automation_id: automationId,
  });
  if (!("workflow_automation_state" in response)) {
    throw new Error(
      "readWorkflowAutomationAutonomyFixture missing workflow_automation_state",
    );
  }
  const state = response.workflow_automation_state;
  return state
    ? {
        autonomyBudget: state.autonomy_budget,
        enabled: state.enabled,
        eventConnectorId: state.event_connector_id,
        lastRunId: state.last_run_id,
        officialBlueprintKey: state.official_blueprint_key,
        officialResultEmailEnabled: state.official_result_email_enabled,
      }
    : null;
}

export async function setWorkflowAutomationAutonomyBudgetFixture(
  context: TestContext,
  automationId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-workflow-automation-autonomy-budget",
    automation_id: automationId,
    autonomy_budget: autonomyBudget,
  });
}

export async function stageOfficialWorkflowAutomationFixture(
  context: TestContext,
  automationId: string,
  blueprintKey: string,
): Promise<void> {
  await postAction(context, {
    action: "set-official-workflow-automation-admission-state",
    automation_id: automationId,
    blueprint_key: blueprintKey,
    reconciliation_status: "reconciling",
  });
}

export async function clearRunApiStart(
  context: TestContext,
  runId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-run-api-start",
    run_id: runId,
  });
}

export async function clearWorkflowAutomationEventConnectorAsPreviousApi(
  context: TestContext,
  automationId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-workflow-automation-event-connector-as-previous-api",
    automation_id: automationId,
  });
}

export async function setRunnerJobContextProfileAsPreviousApi(
  context: TestContext,
  runId: string,
  profile: string,
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-context-profile-as-previous-api",
    run_id: runId,
    profile,
  });
}

export async function readRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
): Promise<number | null> {
  const response = await postAction(context, {
    action: "read-run-autonomy-budget",
    run_id: runId,
  });
  if (!("autonomy_budget" in response)) {
    throw new Error("readRunAutonomyBudgetFixture missing autonomy_budget");
  }
  return response.autonomy_budget ?? null;
}

export async function setRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-run-autonomy-budget",
    run_id: runId,
    autonomy_budget: autonomyBudget,
  });
}
