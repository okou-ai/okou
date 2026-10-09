import { randomUUID } from "node:crypto";

import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
  type TestRuntimeStateActionResponse,
} from "@okouai/api-contracts/contracts/test-runtime-state";
import { onTestFinished } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";

import { testRuntimeStateRoutes } from "../../test-runtime-state";

const RUNTIME_STATE_ROUTE = "/api/test/runtime-state";

function requestRuntimeState(
  context: TestContext,
  path: string,
  init?: RequestInit,
  usagePricingResolution?: UsagePricingResolution,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testRuntimeStateRoutes,
    usagePricingResolution,
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
  usagePricingResolution?: UsagePricingResolution,
): Promise<TestRuntimeStateActionResponse> {
  const response = await requestRuntimeState(
    context,
    `${RUNTIME_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    usagePricingResolution,
  );
  await expectOk(response, `runtime state action ${body.action}`);
  return await readJson<TestRuntimeStateActionResponse>(response);
}

export async function reconcileSocialKitDownloadsForTest(
  context: TestContext,
  downloadIds: readonly string[],
  usagePricingResolution: UsagePricingResolution,
): Promise<number> {
  const response = await postAction(
    context,
    {
      action: "reconcile-socialkit-downloads",
      download_ids: [...downloadIds],
    },
    usagePricingResolution,
  );
  if (response.processed === undefined) {
    throw new Error("SocialKit reconciliation fixture returned no count");
  }
  return response.processed;
}

interface BuiltInModelKeyFixture {
  readonly selectedModel: string;
  release(): Promise<void>;
}

function registerBuiltInModelKeyCleanup(
  context: TestContext,
  fixtureId: string,
  registerCleanup: (cleanup: () => Promise<void>) => void = onTestFinished,
): () => Promise<void> {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    await postAction(context, {
      action: "delete-built-in-model-key",
      fixture_id: fixtureId,
    });
    released = true;
  };
  registerCleanup(release);
  return release;
}

function builtInModelKeyFixture(
  context: TestContext,
  fixtureId: string,
  selectedModel: string,
): BuiltInModelKeyFixture {
  return {
    selectedModel,
    release: registerBuiltInModelKeyCleanup(context, fixtureId),
  };
}

export async function seedBuiltInDefaultModelKey(
  context: TestContext,
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<BuiltInModelKeyFixture> {
  const fixtureId = randomUUID();
  // An operation owner can register before the write and join it before release.
  // Default callers keep their existing post-setup onTestFinished registration.
  const release = registerCleanup
    ? registerBuiltInModelKeyCleanup(context, fixtureId, registerCleanup)
    : undefined;
  const response = await postAction(context, {
    action: "seed-built-in-default-model-key",
    fixture_id: fixtureId,
  });
  if (!response.selected_model) {
    throw new Error("seedBuiltInDefaultModelKey missing selected_model");
  }
  return release
    ? { selectedModel: response.selected_model, release }
    : builtInModelKeyFixture(context, fixtureId, response.selected_model);
}

export async function seedBuiltInModelKey(
  context: TestContext,
  selectedModel: string,
  registerCleanup?: (cleanup: () => Promise<void>) => void,
  options: { readonly isolatePg?: boolean } = {},
): Promise<BuiltInModelKeyFixture> {
  const fixtureId = randomUUID();
  const release = registerCleanup
    ? registerBuiltInModelKeyCleanup(context, fixtureId, registerCleanup)
    : undefined;
  const app = await setupApp({
    context,
    routes: testRuntimeStateRoutes,
    isolatePg: options.isolatePg,
  });
  const { body: response } = await accept(
    app(testRuntimeStateContract).action({
      body: {
        action: "seed-built-in-model-key",
        fixture_id: fixtureId,
        selected_model: selectedModel,
      },
    }),
    [200],
  );
  if (!response.selected_model) {
    throw new Error("seedBuiltInModelKey missing selected_model");
  }
  return release
    ? { selectedModel: response.selected_model, release }
    : builtInModelKeyFixture(context, fixtureId, response.selected_model);
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

/**
 * Launch snapshots are intentionally writer-only in Stage 2, so persistence
 * cannot be observed through a production API. Keep this test-only exception
 * bounded to snapshot, historical-NULL, and no-row retry assertions.
 */
export async function readRunLaunchSnapshotFixture(
  context: TestContext,
  runId: string,
): Promise<NonNullable<TestRuntimeStateActionResponse["run_launch_snapshot"]>> {
  const response = await postAction(context, {
    action: "read-run-launch-snapshot",
    run_id: runId,
  });
  if (!response.run_launch_snapshot) {
    throw new Error("readRunLaunchSnapshotFixture missing run_launch_snapshot");
  }
  return response.run_launch_snapshot;
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

export async function readLatestWorkflowAutomationRunFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly runId: string;
  readonly autonomyBudget: number;
} | null> {
  const response = await postAction(context, {
    action: "read-latest-workflow-automation-run",
    automation_id: automationId,
  });
  if (!("workflow_automation_run" in response)) {
    throw new Error(
      "readLatestWorkflowAutomationRunFixture missing workflow_automation_run",
    );
  }
  const run = response.workflow_automation_run;
  return run
    ? { runId: run.run_id, autonomyBudget: run.autonomy_budget }
    : null;
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

export async function setRunnerJobPiContextAsVersionedWriter(
  context: TestContext,
  runId: string,
  piModelConfig: Readonly<Record<string, unknown>>,
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-pi-context-as-versioned-writer",
    run_id: runId,
    pi_model_config: piModelConfig,
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
